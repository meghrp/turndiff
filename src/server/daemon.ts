// The review server runs detached, one per worktree, so it outlives the
// agent's shell tool (Claude Code kills a Bash call after 10 minutes) and keeps
// the reviewer's tab alive between reviews. The CLI finds it through a state
// file and restarts it when turndiff's own source has changed since it started.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoPaths } from "../git/exec.ts";

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  /** Newest mtime under turndiff's src/ when the server started. */
  code: number;
}

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const stateFile = (paths: RepoPaths) => join(paths.gitDir, "turndiff", "server.json");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function codeStamp(dir = SRC): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? codeStamp(p) : statSync(p).mtimeMs);
  }
  return newest;
}

export async function readState(paths: RepoPaths): Promise<DaemonState | null> {
  const f = stateFile(paths);
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(await readFile(f, "utf8")) as DaemonState;
    if (alive(s.pid)) return s;
  } catch {
    /* unreadable state: treat as no server */
  }
  await rm(f, { force: true });
  return null;
}

export async function writeState(paths: RepoPaths, s: DaemonState): Promise<void> {
  await mkdir(dirname(stateFile(paths)), { recursive: true });
  await writeFile(stateFile(paths), JSON.stringify(s));
}

export async function clearState(paths: RepoPaths, pid: number): Promise<void> {
  const s = await readState(paths);
  if (!s || s.pid === pid) await rm(stateFile(paths), { force: true });
}

export async function stopDaemon(paths: RepoPaths): Promise<boolean> {
  const s = await readState(paths);
  if (!s) return false;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(50);
  await rm(stateFile(paths), { force: true });
  return true;
}

/** The running server for this worktree, started (or restarted on new code) as needed. */
export async function ensureDaemon(paths: RepoPaths, port: number): Promise<{ state: DaemonState; fresh: boolean }> {
  const running = await readState(paths);
  if (running && running.code >= codeStamp()) return { state: running, fresh: false };
  // A restart keeps the port so an open review tab reconnects on its own.
  if (running) await stopDaemon(paths);
  const args = [join(SRC, "cli.ts"), "serve", "--port", String(running?.port ?? port)];
  const child = spawn(process.execPath, args, { cwd: paths.root, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = await readState(paths);
    if (s && s.pid === child.pid) return { state: s, fresh: true };
    if (child.exitCode !== null) throw new Error(`review server exited early (code ${child.exitCode}); run \`turndiff serve\` to see why`);
    await Bun.sleep(100);
  }
  throw new Error("review server did not start within 60s");
}
