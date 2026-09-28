// Stack snapshots and what changed between two of them, branch by branch.
//
// A snapshot records every stack branch tip plus a worktree snapshot of the
// checked-out branch. Agent turns are pairs of snapshots taken by the
// UserPromptSubmit and Stop hooks; a submitted review takes one too. Comparing
// two snapshots diffs each branch against its own earlier self, so an agent
// that switches branches mid-turn never shows up as one branch undoing another,
// and a restack replays the old tip onto the new base before diffing.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, gitOrNull, gitRaw, repoPaths, type RepoPaths } from "./exec.ts";
import { diffTrees, snapshotWorktree, treeOf } from "./diff.ts";
import { loadStack, logCommits, type Stack } from "./stack.ts";
import type { Oid, Section, SessionSummary } from "../model.ts";

export interface Snapshot {
  id: string;
  at: string;
  /** Tips of the trunk and every stack branch. */
  heads: Record<string, Oid>;
  checkout: { branch: string | null; head: Oid | null; worktree: Oid };
}

interface TurnRecord {
  n: number;
  prompt: string | null;
  /** Snapshot ids. `pre` is null only for a turn whose start was never captured. */
  pre: string | null;
  post: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface SessionRecord {
  id: string;
  /** Worktree root the session ran in; each review server lists only its own. */
  root: string;
  createdAt: string;
  updatedAt: string;
  turns: TurnRecord[];
}

const dataDir = (paths: RepoPaths) => join(paths.commonDir, "turndiff", "v1");
const snapshotFile = (paths: RepoPaths, id: string) => join(dataDir(paths), "snapshots", `${id}.json`);
const sessionFile = (paths: RepoPaths, id: string) => join(dataDir(paths), "sessions", `${sanitize(id)}.json`);
const snapshotRef = (id: string) => `refs/turndiff/v1/${id}`;

export function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/** A snapshot of `stack` with `worktree` as the checked-out branch's content. `captureSnapshot` persists one. */
export function snapshotOf(stack: Stack, worktree: Oid, id: string): Snapshot {
  return {
    id,
    at: new Date().toISOString(),
    heads: Object.fromEntries(stack.branches.map((b) => [b.name, b.tip])),
    checkout: { branch: stack.worktree.branch, head: stack.worktree.head, worktree },
  };
}

export async function captureSnapshot(paths: RepoPaths, id: string): Promise<Snapshot> {
  const safe = sanitize(id);
  const [worktree, stack] = await Promise.all([snapshotWorktree(paths, `turndiff snapshot ${safe}`), loadStack(paths, [])]);
  const snap = snapshotOf(stack, worktree, safe);
  // The ref keeps the worktree snapshot and its HEAD reachable across gc.
  await git(paths.root, ["update-ref", snapshotRef(safe), worktree]);
  await writeJson(snapshotFile(paths, safe), snap);
  return snap;
}

export async function loadSnapshot(paths: RepoPaths, id: string): Promise<Snapshot | null> {
  const file = snapshotFile(paths, sanitize(id));
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Snapshot;
}

/**
 * Per-branch changes from `a` to `b`, parents first, in `stack` order.
 * Branches that did not change, or only moved onto a new base, are left out.
 */
export async function compareSnapshots(
  paths: RepoPaths,
  a: Snapshot,
  b: Snapshot,
  stack: Stack,
  opts: { ignoreWhitespace?: boolean } = {},
): Promise<{ sections: Section[]; notes: string[] }> {
  const cwd = paths.root;
  const notes: string[] = [];
  const tipIn = (s: Snapshot, name: string): Oid | null => (s.checkout.branch === name ? s.checkout.worktree : (s.heads[name] ?? null));
  const snapshotCommits = new Set([a.checkout.worktree, b.checkout.worktree]);
  if (a.checkout.branch === null || b.checkout.branch === null) notes.push("HEAD was detached at one end; uncommitted changes on a detached HEAD are not shown.");

  const sections: Section[] = [];
  for (const branch of stack.branches) {
    const name = branch.name;
    const tipA = tipIn(a, name);
    const tipB = tipIn(b, name);
    if (!tipB || tipA === tipB) continue;
    // The trunk has no parent to separate its own work from; only its uncommitted changes count, measured from its own commits.
    const parentA = branch.parent === null ? tipA && a.heads[name] : (a.heads[branch.parent] ?? null);
    const parentB = branch.parent === null ? b.heads[name] : (b.heads[branch.parent] ?? stack.branches.find((x) => x.name === branch.parent)?.tip);
    if (!parentB) continue;
    const baseB = (await gitOrNull(cwd, ["merge-base", tipB, parentB])) ?? parentB;
    let base = baseB;
    let replay: Section["replay"] = null;
    if (tipA) {
      if ((await treeOf(cwd, tipA)) === (await treeOf(cwd, tipB))) continue;
      const baseA = parentA ? await gitOrNull(cwd, ["merge-base", tipA, parentA]) : null;
      base = tipA;
      if (baseA && baseA !== baseB) {
        const r = await gitRaw(cwd, ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${baseA}`, baseB, tipA]);
        const tree = r.stdout.split("\n")[0]?.trim();
        if (tree && /^[0-9a-f]{40,64}$/.test(tree)) {
          base = tree;
          replay = { conflicts: r.code === 1 };
          if (r.code === 1) notes.push(`${name}: replaying the earlier version onto its new base hit conflicts; conflict markers show in the diff.`);
        }
      }
    }
    const files = await diffTrees(cwd, base, tipB, opts);
    if (files.length === 0) continue;
    const range = tipA ? ["--cherry-pick", "--right-only", "--no-merges", `${tipA}...${tipB}`, `^${baseB}`] : [`${baseB}..${tipB}`];
    const commits = branch.parent === null ? [] : (await logCommits(cwd, range, name)).filter((c) => !snapshotCommits.has(c.oid));
    const working = b.checkout.branch === name && (await treeOf(cwd, b.checkout.worktree)) !== (b.checkout.head ? await treeOf(cwd, b.checkout.head) : null);
    sections.push({
      id: `compare:${name}`,
      branch: name,
      title: tipA ? name : `${name} (new branch)`,
      base,
      head: tipB,
      commits,
      includesWorking: working,
      replay,
      files,
    });
  }
  return { sections, notes };
}

export async function loadSession(paths: RepoPaths, id: string): Promise<SessionRecord | null> {
  const file = sessionFile(paths, id);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as SessionRecord;
}

async function saveSession(paths: RepoPaths, session: SessionRecord): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await writeJson(sessionFile(paths, session.id), session);
}

export async function listSessions(paths: RepoPaths): Promise<SessionRecord[]> {
  const dir = join(dataDir(paths), "sessions");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as SessionRecord));
  return all.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

export function summarize(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    updatedAt: session.updatedAt,
    turns: session.turns.map((t) => ({ n: t.n, prompt: t.prompt, startedAt: t.startedAt, endedAt: t.endedAt })),
  };
}

/** Snapshot ids bounding turns from..to; `post` is null while the last turn is running. */
export function turnRange(session: SessionRecord, from: number, to: number): { pre: string | null; post: string | null } {
  const first = session.turns.find((t) => t.n === from);
  const last = session.turns.find((t) => t.n === to);
  if (!first || !last) throw new Error(`turns ${from}-${to} not found in session ${session.id}`);
  return { pre: first.pre, post: last.post };
}

export async function deleteSession(paths: RepoPaths, session: SessionRecord): Promise<void> {
  for (const t of session.turns) {
    for (const id of [t.pre, t.post]) {
      if (!id) continue;
      await gitOrNull(paths.root, ["update-ref", "-d", snapshotRef(id)]);
      await rm(snapshotFile(paths, id), { force: true });
    }
  }
  await rm(sessionFile(paths, session.id), { force: true });
}

export interface HookInput {
  sessionId: string;
  event: string;
  cwd: string;
  prompt?: string;
}

/**
 * UserPromptSubmit opens a turn with a `pre` snapshot and, if the previous turn
 * never saw its Stop (interrupted), closes it with the same snapshot. Stop
 * captures `post`.
 */
export async function recordHook(input: HookInput): Promise<string> {
  const paths = await repoPaths(input.cwd);
  const now = new Date().toISOString();
  const session = (await loadSession(paths, input.sessionId)) ?? { id: input.sessionId, root: paths.root, createdAt: now, updatedAt: now, turns: [] };
  const last = session.turns.at(-1);
  const n = (last?.n ?? 0) + 1;
  const sid = sanitize(input.sessionId);

  if (input.event === "UserPromptSubmit") {
    const pre = await captureSnapshot(paths, `${sid}-${n}-pre`);
    if (last && last.post === null) {
      last.post = pre.id;
      last.endedAt = now;
    }
    session.turns.push({ n, prompt: input.prompt?.slice(0, 500) ?? null, pre: pre.id, post: null, startedAt: now, endedAt: null });
    await saveSession(paths, session);
    return `turn ${n}: captured pre`;
  }
  if (input.event === "Stop") {
    const open = last && last.post === null ? last : null;
    const turn = open ?? { n, prompt: null, pre: last?.post ?? null, post: null, startedAt: now, endedAt: null };
    if (!open) session.turns.push(turn);
    turn.post = (await captureSnapshot(paths, `${sid}-${turn.n}-post`)).id;
    turn.endedAt = now;
    await saveSession(paths, session);
    return `turn ${turn.n}: captured post`;
  }
  return `ignored ${input.event}`;
}
