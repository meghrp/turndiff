// Turn checkpoints: a commit object per (session, turn, pre|post) capturing the
// whole worktree (tracked + untracked, honoring .gitignore), parented on HEAD so
// merge-base against the parent branch keeps working after a restack.
//
// Refs live under refs/turndiff/<session>/<turn>/<kind>. Session metadata lives
// as JSON under <git-common-dir>/turndiff/sessions/ so worktrees share it.

import { mkdir, readdir, readFile, rm, unlink, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentBranch, git, gitOrNull, mergeBase, repoPaths, type RepoPaths } from "./exec.ts";
import { resolveParent, readSpice, trunkComparisonRef } from "./spice.ts";

export type CheckpointKind = "pre" | "post";

export interface Checkpoint {
  kind: CheckpointKind;
  ref: string;
  commit: string;
  head: string | null;
  branch: string | null;
  /** Parent branch resolved at capture time (git-spice base / default branch). */
  parent: string | null;
  /** merge-base(commit, parent) at capture time; lets the UI show that a restack happened. */
  parentMergeBase: string | null;
  createdAt: string;
}

export interface Turn {
  turn: number;
  prompt: string | null;
  pre: Checkpoint | null;
  post: Checkpoint | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Session {
  id: string;
  /** Harness that produced it, e.g. "claude-code". */
  source: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}

const REF_PREFIX = "refs/turndiff";

export function sessionsDir(paths: RepoPaths): string {
  return join(paths.commonDir, "turndiff", "sessions");
}

export async function loadSession(paths: RepoPaths, id: string): Promise<Session | null> {
  const file = join(sessionsDir(paths), `${sanitize(id)}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Session;
}

export async function saveSession(paths: RepoPaths, session: Session): Promise<void> {
  const dir = sessionsDir(paths);
  await mkdir(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  const file = join(dir, `${sanitize(session.id)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2));
  await Bun.write(file, Bun.file(tmp));
  await unlink(tmp).catch(() => {});
}

export async function listSessions(paths: RepoPaths): Promise<Session[]> {
  const dir = sessionsDir(paths);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const sessions = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as Session));
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function deleteSession(paths: RepoPaths, id: string): Promise<void> {
  const refs = (await gitOrNull(paths.root, ["for-each-ref", "--format=%(refname)", `${REF_PREFIX}/${sanitize(id)}/`])) ?? "";
  for (const ref of refs.split("\n").filter(Boolean)) await git(paths.root, ["update-ref", "-d", ref]);
  await rm(join(sessionsDir(paths), `${sanitize(id)}.json`), { force: true });
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Snapshot the worktree into a commit without touching the real index or HEAD.
 * Copies the index so `git add -A` sees the same stage state, adds everything
 * (respecting .gitignore), writes a tree, and commits it on top of HEAD.
 */
export async function snapshotWorktree(paths: RepoPaths, message: string): Promise<{ commit: string; head: string | null; tree: string }> {
  const tmpIndex = join(tmpdir(), `turndiff-index-${process.pid}-${Date.now()}`);
  const realIndex = join(paths.gitDir, "index");
  try {
    if (existsSync(realIndex)) await copyFile(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(paths.root, ["add", "-A", "--ignore-errors", "--", "."], { env });
    const tree = await git(paths.root, ["write-tree"], { env });
    const head = await gitOrNull(paths.root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const args = ["commit-tree", tree, "-m", message];
    if (head) args.push("-p", head);
    const commit = await git(paths.root, args, {
      env: {
        GIT_AUTHOR_NAME: "turndiff",
        GIT_AUTHOR_EMAIL: "turndiff@localhost",
        GIT_COMMITTER_NAME: "turndiff",
        GIT_COMMITTER_EMAIL: "turndiff@localhost",
      },
    });
    return { commit, head, tree };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

export async function captureCheckpoint(paths: RepoPaths, sessionId: string, turn: number, kind: CheckpointKind): Promise<Checkpoint> {
  const ref = `${REF_PREFIX}/${sanitize(sessionId)}/${turn}/${kind}`;
  const { commit, head } = await snapshotWorktree(paths, `turndiff ${kind} turn ${turn} (${sessionId})`);
  await git(paths.root, ["update-ref", ref, commit]);
  const branch = await currentBranch(paths.root);
  const spice = await readSpice(paths.root);
  let parent: string | null = null;
  if (branch) {
    parent = await resolveParent(paths.root, branch, spice);
    if (parent === null || parent === branch) parent = await trunkComparisonRef(paths.root, branch);
  }
  const parentMergeBase = parent ? await mergeBase(paths.root, commit, parent) : null;
  return { kind, ref, commit, head, branch, parent, parentMergeBase, createdAt: new Date().toISOString() };
}

export interface HookInput {
  sessionId: string;
  event: "UserPromptSubmit" | "Stop" | string;
  cwd: string;
  prompt?: string;
  source?: string;
}

/**
 * Drive checkpoints from harness hook events. UserPromptSubmit opens a turn and
 * captures `pre`; Stop captures `post`. A new prompt arriving while the previous
 * turn is still open (agent interrupted) closes it with the same snapshot.
 */
export async function handleHook(input: HookInput): Promise<{ session: Session; turn: Turn | null; action: string }> {
  const paths = await repoPaths(input.cwd);
  const now = new Date().toISOString();
  let session = await loadSession(paths, input.sessionId);
  if (!session) {
    session = { id: input.sessionId, source: input.source ?? "claude-code", cwd: paths.root, createdAt: now, updatedAt: now, turns: [] };
  }
  const last = session.turns.at(-1) ?? null;

  if (input.event === "UserPromptSubmit") {
    const turnNumber = (last?.turn ?? 0) + 1;
    const pre = await captureCheckpoint(paths, input.sessionId, turnNumber, "pre");
    if (last && last.post === null) {
      last.post = { ...pre, kind: "post", ref: `${REF_PREFIX}/${sanitize(input.sessionId)}/${last.turn}/post` };
      await git(paths.root, ["update-ref", last.post.ref, pre.commit]);
      last.endedAt = now;
    }
    const turn: Turn = { turn: turnNumber, prompt: input.prompt?.slice(0, 500) ?? null, pre, post: null, startedAt: now, endedAt: null };
    session.turns.push(turn);
    await saveSession(paths, session);
    return { session, turn, action: `captured pre for turn ${turnNumber}` };
  }

  if (input.event === "Stop") {
    let turn = last;
    if (!turn || turn.post !== null) {
      // Stop without a matching prompt (e.g. hooks installed mid-session). Open a turn with no pre.
      turn = { turn: (last?.turn ?? 0) + 1, prompt: null, pre: null, post: null, startedAt: now, endedAt: null };
      session.turns.push(turn);
    }
    turn.post = await captureCheckpoint(paths, input.sessionId, turn.turn, "post");
    turn.endedAt = now;
    await saveSession(paths, session);
    return { session, turn, action: `captured post for turn ${turn.turn}` };
  }

  return { session, turn: null, action: `ignored ${input.event}` };
}
