// One detached review server per worktree. State identifies the server over
// HTTP before its PID may be reused or signalled.

import { Database, SQLiteError } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoPaths } from "../git/exec.ts";

export interface DaemonState {
  id: string;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  /** Newest mtime under turndiff's src/ when the server started. */
  code: number;
}

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const stateFile = (paths: RepoPaths) => join(paths.gitDir, "turndiff", "server.json");
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
  try {
    const s: unknown = JSON.parse(await readFile(stateFile(paths), "utf8"));
    if (!object(s) || typeof s.pid !== "number" || !Number.isSafeInteger(s.pid) || s.pid <= 0 ||
      typeof s.port !== "number" || !Number.isInteger(s.port) || s.port <= 0 || s.port > 65535 ||
      typeof s.id !== "string" || s.id.length === 0 || s.url !== `http://127.0.0.1:${s.port}` ||
      typeof s.startedAt !== "string" || typeof s.code !== "number" || !Number.isFinite(s.code) || !alive(s.pid)) return null;
    const res = await fetch(`${s.url}/api/presence`, { signal: AbortSignal.timeout(1000), redirect: "error" });
    const identity: unknown = await res.json();
    if (res.ok && object(identity) && identity.id === s.id && identity.pid === s.pid && identity.root === paths.root) {
      return { id: s.id, pid: s.pid, port: s.port, url: s.url, startedAt: s.startedAt, code: s.code };
    }
  } catch {
    /* Missing, stale, or unreadable state is not a verified server. */
  }
  // Validation may have raced a replacement. Never delete state read before an await.
  return null;
}

export async function writeState(paths: RepoPaths, s: DaemonState): Promise<void> {
  await mkdir(dirname(stateFile(paths)), { recursive: true });
  const tmp = `${stateFile(paths)}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(s));
  await rename(tmp, stateFile(paths));
}

export class ServerAlreadyRunningError extends Error {
  constructor() {
    super("a review server already owns this worktree");
  }
}

/** Hold ownership before opening the review store, until this server exits. */
export async function withServerLease<T>(paths: RepoPaths, operation: () => Promise<T>): Promise<T> {
  const file = join(paths.gitDir, "turndiff", "server-lock.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    try { db.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") throw new ServerAlreadyRunningError();
      throw error;
    }
    return await operation();
  } finally {
    db.close();
  }
}

export async function stopDaemon(paths: RepoPaths): Promise<boolean> {
  return withDaemonLock(paths, () => stopOwnedDaemon(paths));
}

async function stopOwnedDaemon(paths: RepoPaths): Promise<boolean> {
  const s = await readState(paths);
  if (!s) return false;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {
    /* Already gone after verification. */
  }
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(50);
  if (alive(s.pid)) throw new Error("review server did not stop; refusing to start a second server");
  return true;
}

/** The running server for this worktree, started (or restarted on new code) as needed. */
export async function ensureDaemon(paths: RepoPaths, port: number): Promise<{ state: DaemonState; fresh: boolean }> {
  return withDaemonLock(paths, () => startOrReuse(paths, port));
}

async function startOrReuse(paths: RepoPaths, port: number): Promise<{ state: DaemonState; fresh: boolean }> {
  const running = await readState(paths);
  if (running && running.code >= codeStamp()) return { state: running, fresh: false };
  if (running) await stopOwnedDaemon(paths);
  const args = [join(SRC, "cli.ts"), "serve", "--port", String(running?.port ?? port)];
  const child = spawn(process.execPath, args, { cwd: paths.root, detached: true, stdio: "ignore", env: process.env });
  let spawnError: Error | null = null;
  child.on("error", (error) => { spawnError = error; });
  child.unref();
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = await readState(paths);
      if (s && (s.pid === child.pid || child.exitCode === 75)) return { state: s, fresh: s.pid === child.pid };
      if (spawnError) throw spawnError;
      if ((child.exitCode !== null && child.exitCode !== 75) || child.signalCode !== null) throw new Error(`review server exited early (code ${child.exitCode}); run \`turndiff serve\` to see why`);
      await Bun.sleep(100);
    }
    throw new Error("review server did not start within 60s");
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(50);
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }
}

async function withDaemonLock<T>(paths: RepoPaths, operation: () => Promise<T>): Promise<T> {
  const file = join(paths.gitDir, "turndiff", "daemon-lock.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + 65_000;
    while (true) {
      try {
        // SQLite releases this cross-process lock even if the command crashes.
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline) throw new Error("another turndiff command is still starting or stopping this worktree's server");
        await Bun.sleep(50);
      }
    }
    return await operation();
  } finally {
    db.close();
  }
}
