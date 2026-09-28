// The review server runs as a detached daemon so it outlives the agent's shell
// tool (Claude Code kills a Bash call after 10 minutes). `turndiff review`
// starts or reattaches to it, then waits for result.json.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoPaths } from "../git/exec.ts";
import type { Scope, Submission } from "../shared.ts";

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  preselect: Scope | null;
}

export type DaemonResult = { kind: "submitted"; submission: Submission } | { kind: "cancelled" };

export function reviewDir(paths: RepoPaths): string {
  return join(paths.commonDir, "turndiff", "review");
}

const stateFile = (paths: RepoPaths) => join(reviewDir(paths), "state.json");
const resultFile = (paths: RepoPaths) => join(reviewDir(paths), "result.json");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readState(paths: RepoPaths): Promise<DaemonState | null> {
  const f = stateFile(paths);
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(await readFile(f, "utf8")) as DaemonState;
    if (!alive(s.pid)) {
      await rm(f, { force: true });
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export async function writeState(paths: RepoPaths, s: DaemonState): Promise<void> {
  await mkdir(reviewDir(paths), { recursive: true });
  await writeFile(stateFile(paths), JSON.stringify(s));
}

export async function writeResult(paths: RepoPaths, r: DaemonResult): Promise<void> {
  await mkdir(reviewDir(paths), { recursive: true });
  const f = resultFile(paths);
  await writeFile(`${f}.tmp`, JSON.stringify(r));
  await Bun.write(f, Bun.file(`${f}.tmp`));
  await rm(`${f}.tmp`, { force: true });
  await rm(stateFile(paths), { force: true });
}

export async function takeResult(paths: RepoPaths): Promise<DaemonResult | null> {
  const f = resultFile(paths);
  if (!existsSync(f)) return null;
  const r = JSON.parse(await readFile(f, "utf8")) as DaemonResult;
  await rm(f, { force: true });
  return r;
}

export async function stopDaemon(paths: RepoPaths): Promise<boolean> {
  const s = await readState(paths);
  if (!s) return false;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await rm(stateFile(paths), { force: true });
  return true;
}

/** Spawn `turndiff serve` detached and wait until it has written its state. */
export async function spawnDaemon(paths: RepoPaths, opts: { port: number; preselect: Scope | null }): Promise<DaemonState> {
  await rm(resultFile(paths), { force: true });
  const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "cli.ts");
  const args = [cli, "serve", "--port", String(opts.port)];
  if (opts.preselect) args.push("--preselect", JSON.stringify(opts.preselect));
  const child = spawn(process.execPath, args, { cwd: paths.root, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await readState(paths);
    if (s) return s;
    if (child.exitCode !== null) throw new Error(`review server exited early (code ${child.exitCode})`);
    await Bun.sleep(100);
  }
  throw new Error("review server did not start within 30s");
}

/** Poll for a result until `timeoutMs` (0 = forever). */
export async function waitForResult(paths: RepoPaths, timeoutMs: number): Promise<DaemonResult | "timeout" | "gone"> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    const r = await takeResult(paths);
    if (r) return r;
    if (!(await readState(paths))) {
      // Daemon died without writing a result (killed, crashed).
      const late = await takeResult(paths);
      return late ?? "gone";
    }
    await Bun.sleep(400);
  }
  return "timeout";
}
