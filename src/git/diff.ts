// Tree-to-tree diffs as FileChange lists, and worktree snapshots so uncommitted
// changes can be diffed like any other tree.

import { copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, gitOrNull, type RepoPaths } from "./exec.ts";
import type { FileChange, FileStatus, Oid } from "../model.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const TURNDIFF_IDENT = {
  GIT_AUTHOR_NAME: "turndiff",
  GIT_AUTHOR_EMAIL: "turndiff@localhost",
  GIT_COMMITTER_NAME: "turndiff",
  GIT_COMMITTER_EMAIL: "turndiff@localhost",
};
const ZERO_OID = /^0+$/;
const RENAMES = ["--find-renames"];

export async function diffTrees(cwd: string, base: Oid, head: Oid, opts: { ignoreWhitespace?: boolean } = {}): Promise<FileChange[]> {
  const ws = opts.ignoreWhitespace ? ["--ignore-all-space", "--ignore-blank-lines"] : [];
  const [raw, numstat, patch] = await Promise.all([
    git(cwd, ["diff", "--raw", "-z", "--no-abbrev", ...RENAMES, base, head]),
    git(cwd, ["diff", "--numstat", "-z", ...RENAMES, ...ws, base, head]),
    git(cwd, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "-U3", ...RENAMES, ...ws, base, head]),
  ]);
  const counts = new Map(parseNumstat(numstat).map((n) => [n.path, n]));
  const chunks = chunksByBlobs(patch);
  return parseRaw(raw).map((entry) => {
    const count = counts.get(entry.path);
    const binary = count?.binary ?? false;
    const chunk = chunks.get(`${entry.oldBlob ?? "0"}..${entry.newBlob ?? "0"}`)?.shift() ?? "";
    return {
      ...entry,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary,
      patch: binary ? "" : chunk,
    };
  });
}

type RawEntry = Pick<FileChange, "path" | "oldPath" | "status" | "oldBlob" | "newBlob">;

/** `git diff --raw -z`: ":<mode> <mode> <old> <new> <status>\0<path>\0[<new path>\0]". */
export function parseRaw(raw: string): RawEntry[] {
  const parts = raw.split("\0");
  const out: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i]!;
    if (!meta.startsWith(":")) continue;
    const [, , oldOid, newOid, code] = meta.slice(1).split(" ");
    const letter = code![0]!;
    const oldBlob = ZERO_OID.test(oldOid!) ? null : oldOid!;
    const newBlob = ZERO_OID.test(newOid!) ? null : newOid!;
    if (letter === "R" || letter === "C") {
      const from = parts[++i]!;
      const to = parts[++i]!;
      out.push({ path: to, oldPath: from, status: letter === "R" ? "renamed" : "added", oldBlob: letter === "R" ? oldBlob : null, newBlob });
      continue;
    }
    const path = parts[++i]!;
    const status: FileStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    out.push({ path, oldPath: null, status, oldBlob, newBlob });
  }
  return out;
}

interface Numstat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `git diff --numstat -z`; renames emit "<add>\t<del>\t\0<old>\0<new>\0". */
export function parseNumstat(raw: string): Numstat[] {
  const parts = raw.split("\0");
  const out: Numstat[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (rec.length === 0) continue;
    const [add, del, inlinePath] = rec.split("\t");
    const binary = add === "-";
    let path = inlinePath ?? "";
    if (path.length === 0) {
      i += 2;
      path = parts[i] ?? "";
    }
    out.push({ path, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary });
  }
  return out;
}

/**
 * Per-file chunks of a full-index patch, queued under their "index <old>..<new>"
 * blobs in patch order, which is also --raw order. Files without an index line
 * (pure renames, mode-only changes) and files a whitespace-ignoring diff left
 * out get no chunk.
 */
function chunksByBlobs(patch: string): Map<string, string[]> {
  const byBlobs = new Map<string, string[]>();
  if (patch.length === 0) return byBlobs;
  for (const raw of patch.split(/^(?=diff --git )/m)) {
    const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(raw);
    if (!m) continue;
    const key = `${ZERO_OID.test(m[1]!) ? "0" : m[1]}..${ZERO_OID.test(m[2]!) ? "0" : m[2]}`;
    byBlobs.set(key, [...(byBlobs.get(key) ?? []), raw.endsWith("\n") ? raw : raw + "\n"]);
  }
  return byBlobs;
}

/**
 * Snapshot the worktree into a commit parented on HEAD without touching the
 * real index, HEAD or any branch. Tracked and untracked files, honoring
 * .gitignore. The blobs land in the object store, so they can be served later.
 */
export async function snapshotWorktree(paths: RepoPaths, message = "turndiff worktree snapshot"): Promise<Oid> {
  const tmpIndex = join(tmpdir(), `turndiff-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const realIndex = join(paths.gitDir, "index");
  try {
    if (existsSync(realIndex)) await copyFile(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(paths.root, ["add", "-A", "--ignore-errors", "--", "."], { env });
    const tree = await git(paths.root, ["write-tree"], { env });
    const head = await gitOrNull(paths.root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const args = ["commit-tree", tree, "-m", message];
    if (head) args.push("-p", head);
    return await git(paths.root, args, { env: TURNDIFF_IDENT });
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

export async function treeOf(cwd: string, rev: Oid): Promise<Oid | null> {
  return gitOrNull(cwd, ["rev-parse", "--verify", "-q", `${rev}^{tree}`]);
}
