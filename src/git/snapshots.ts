// Stack snapshots and what changed between two of them, branch by branch.
//
// A snapshot records every stack branch tip and parent plus a commit of the
// worktree. Agent turns are pairs of snapshots taken by the UserPromptSubmit
// and Stop hooks; a submitted review takes one too. Comparing two snapshots
// diffs each branch against its own earlier self, so an agent that switches
// branches mid-turn never shows up as one branch undoing another, and a
// restack or re-parent replays the old tip onto the new base before diffing.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, gitOrNull, gitRaw, repoPaths, type RepoPaths } from "./exec.ts";
import { diffTrees, EMPTY_TREE, snapshotWorktree, treeOf, TURNDIFF_IDENT } from "./diff.ts";
import { loadStack, logCommits, type Stack } from "./stack.ts";
import type { Oid, Section, SessionSummary } from "../model.ts";

export interface Snapshot {
  id: string;
  at: string;
  /** Committed tips of the trunk and every stack branch. */
  heads: Record<string, Oid>;
  /** Each stack branch's parent at the time, so a later re-parent is not mistaken for new work. */
  parents: Record<string, string>;
  /** Tip of the trunk's upstream: trunk commits reachable from it were pulled, not made here. */
  upstream: Oid | null;
  /** `worktree` is a commit of every tracked and untracked file, parented on `head`. */
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

/** A snapshot of `stack` with `worktree` as the worktree's content. `captureSnapshot` persists one. */
export function snapshotOf(stack: Stack, worktree: Oid, id: string): Snapshot {
  return {
    id,
    at: new Date().toISOString(),
    heads: Object.fromEntries(stack.branches.map((b) => [b.name, b.tip])),
    parents: Object.fromEntries(stack.branches.flatMap((b) => (b.parent === null ? [] : [[b.name, b.parent]]))),
    upstream: stack.upstream,
    checkout: { branch: stack.worktree.branch, head: stack.worktree.head, worktree },
  };
}

export async function captureSnapshot(paths: RepoPaths, id: string): Promise<Snapshot> {
  const safe = sanitize(id);
  const [worktree, stack] = await Promise.all([snapshotWorktree(paths, `turndiff snapshot ${safe}`), loadStack(paths, [])]);
  const snap = snapshotOf(stack, worktree, safe);
  // One ref to a commit whose parents are every recorded tip keeps them all
  // alive after branches are rewritten and their old commits leave the reflog.
  const keep = [...new Set([worktree, ...Object.values(snap.heads), ...(snap.upstream ? [snap.upstream] : [])])];
  const keeper = await git(paths.root, ["commit-tree", EMPTY_TREE, ...keep.flatMap((oid) => ["-p", oid]), "-m", `turndiff snapshot ${safe}`], { env: TURNDIFF_IDENT });
  await git(paths.root, ["update-ref", snapshotRef(safe), keeper]);
  await writeJson(snapshotFile(paths, safe), snap);
  return snap;
}

export async function loadSnapshot(paths: RepoPaths, id: string): Promise<Snapshot | null> {
  const file = snapshotFile(paths, sanitize(id));
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Snapshot;
}

/** One end of a branch comparison: the content to diff, and the commit whose history places it. */
interface End {
  content: Oid;
  commit: Oid;
}

/**
 * Per-branch changes from `a` to `b`, parents first. Branches that did not
 * change, or only moved onto a new base, are left out.
 *
 * Uncommitted work belongs to the worktree, not to a branch. It counts as the
 * checked-out branch's content at each end, except when the checkout moved and
 * the work came along: then it left the old branch and was already there when
 * the new branch was checked out.
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
  const trunk = stack.trunk;
  const liveParent = new Map(stack.branches.map((br) => [br.name, br.parent]));
  const parentTip = (s: Snapshot, name: string): Oid | null => {
    if (name === trunk) return s.upstream ?? null;
    const parent = s.parents?.[name] ?? liveParent.get(name);
    return parent ? (s.heads[parent] ?? null) : null;
  };
  const missing = await missingObjects(cwd, [a, b].flatMap((s) => [...Object.values(s.heads), s.checkout.worktree, ...(s.upstream ? [s.upstream] : [])]));
  if (a.checkout.branch === null || b.checkout.branch === null) notes.push("HEAD was detached at one end; uncommitted changes on a detached HEAD are not shown.");

  const moved = a.checkout.branch !== b.checkout.branch;
  const carried = moved && a.checkout.head !== null && (await contains(cwd, a.checkout.head, b.checkout.worktree, a.checkout.worktree));

  const endA = async (name: string): Promise<End | null> => {
    const tip = a.heads[name];
    if (name === a.checkout.branch) return carried ? { content: tip!, commit: tip! } : { content: a.checkout.worktree, commit: a.checkout.worktree };
    if (!tip) return null;
    if (carried && name === b.checkout.branch) {
      const merged = await mergeTree(cwd, a.checkout.head!, tip, a.checkout.worktree);
      return { content: merged?.tree ?? tip, commit: tip };
    }
    return { content: tip, commit: tip };
  };
  const endB = (name: string): End | null => {
    if (name === b.checkout.branch) return { content: b.checkout.worktree, commit: b.checkout.worktree };
    const tip = b.heads[name];
    return tip ? { content: tip, commit: tip } : null;
  };

  const order = [...stack.branches.map((br) => br.name), ...Object.keys(b.heads).filter((n) => !liveParent.has(n))];
  const sections: Section[] = [];
  for (const name of order) {
    const eb = endB(name);
    if (!eb) continue;
    const ea = await endA(name);
    if (ea?.content === eb.content) continue;
    if ([ea?.commit, eb.commit].some((oid) => oid && missing.has(oid))) {
      notes.push(`${name}: a recorded snapshot of this branch is no longer in the repository, so it is left out.`);
      continue;
    }
    const pb = parentTip(b, name);
    const baseB = pb ? await gitOrNull(cwd, ["merge-base", eb.commit, pb]) : null;
    let base: Oid;
    let replay: Section["replay"] = null;
    if (!ea) {
      if (!baseB) continue;
      base = baseB;
      if (carried && name === b.checkout.branch) base = (await mergeTree(cwd, a.checkout.head!, baseB, a.checkout.worktree))?.tree ?? baseB;
    } else {
      if ((await treeOf(cwd, ea.content)) === (await treeOf(cwd, eb.content))) continue;
      const pa = parentTip(a, name);
      const baseA = pa ? await gitOrNull(cwd, ["merge-base", ea.commit, pa]) : null;
      base = ea.content;
      if (baseA && baseB && baseA !== baseB) {
        const merged = await mergeTree(cwd, baseA, baseB, ea.content);
        if (merged) {
          base = merged.tree;
          replay = { conflicts: merged.conflicts };
          if (merged.conflicts) notes.push(`${name}: replaying the earlier version onto its new base hit conflicts; conflict markers show in the diff.`);
        }
      }
    }
    const files = await diffTrees(cwd, base, eb.content, opts);
    if (files.length === 0) continue;
    const range = ea ? ["--cherry-pick", "--right-only", "--no-merges", `${ea.commit}...${eb.commit}`, ...(baseB ? [`^${baseB}`] : [])] : [`${baseB}..${eb.commit}`];
    const snapshotCommits = new Set([a.checkout.worktree, b.checkout.worktree]);
    const commits = (await logCommits(cwd, range, name)).filter((c) => !snapshotCommits.has(c.oid));
    const working = name === b.checkout.branch && (await treeOf(cwd, b.checkout.worktree)) !== (b.checkout.head ? await treeOf(cwd, b.checkout.head) : null);
    sections.push({ id: `compare:${name}`, branch: name, title: ea ? name : `${name} (new branch)`, base, head: eb.content, commits, includesWorking: working, replay, files });
  }
  const gone = Object.keys(a.heads).filter((n) => n !== trunk && !b.heads[n]);
  if (gone.length > 0) notes.push(`No longer in the stack at the end (deleted, renamed or untracked): ${gone.join(", ")}.`);
  return { sections, notes };
}

/** Three-way merge of trees or commits without touching the worktree. Null when git cannot produce a tree. */
async function mergeTree(cwd: string, base: Oid, ours: Oid, theirs: Oid): Promise<{ tree: Oid; conflicts: boolean } | null> {
  const r = await gitRaw(cwd, ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${base}`, ours, theirs]);
  const tree = r.stdout.split("\n")[0]?.trim();
  return tree && /^[0-9a-f]{40,64}$/.test(tree) && r.code <= 1 ? { tree, conflicts: r.code === 1 } : null;
}

/** Whether `ours` already holds every change `theirs` made on top of `base`. */
async function contains(cwd: string, base: Oid, ours: Oid, theirs: Oid): Promise<boolean> {
  const merged = await mergeTree(cwd, base, ours, theirs);
  return merged !== null && !merged.conflicts && merged.tree === (await treeOf(cwd, ours));
}

async function missingObjects(cwd: string, oids: Oid[]): Promise<Set<Oid>> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Set();
  const out = await git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { stdin: unique.join("\n") + "\n" });
  return new Set(out.split("\n").filter((l) => l.endsWith(" missing")).map((l) => l.split(" ")[0]!));
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
