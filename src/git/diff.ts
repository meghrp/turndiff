// Diff producers. Both return a unified patch plus per-file stats so the UI can
// render with @pierre/diffs and the CLI can print numbers.

import { git, gitOrNull, gitRaw, mergeBase, revParse } from "./exec.ts";
import type { Checkpoint } from "./checkpoints.ts";

export interface FileStat {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffResult {
  patch: string;
  files: FileStat[];
  /** Tree-ish the patch's "old" side was taken from. */
  baseOid: string;
  /** Tree-ish the patch's "new" side was taken from. */
  headOid: string;
  /** Set when the old side was replayed onto a new base to hide rebase noise. */
  replay: { from: string; oldBase: string; newBase: string; conflicts: boolean } | null;
}

const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--full-index", "-U3"];

export async function diffRange(cwd: string, base: string, head: string, ignoreWhitespace: boolean): Promise<Pick<DiffResult, "patch" | "files">> {
  const ws = ignoreWhitespace ? ["--ignore-all-space", "--ignore-blank-lines"] : [];
  const [patch, numstat] = await Promise.all([
    git(cwd, ["diff", ...DIFF_ARGS, ...ws, base, head]),
    git(cwd, ["diff", "--numstat", "-z", "--find-renames", ...ws, base, head]),
  ]);
  return { patch, files: parseNumstat(numstat) };
}

/** `git diff --numstat -z` parser: handles renames, which emit two NUL-separated paths. */
export function parseNumstat(raw: string): FileStat[] {
  const files: FileStat[] = [];
  const parts = raw.split("\0");
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i]!;
    if (rec.length === 0) {
      i += 1;
      continue;
    }
    const [add, del, inlinePath] = rec.split("\t");
    const binary = add === "-";
    if (inlinePath !== undefined && inlinePath.length > 0) {
      files.push({ path: inlinePath, oldPath: null, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary });
      i += 1;
    } else {
      // Rename: "<add>\t<del>\t\0<old>\0<new>\0"
      const oldPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      files.push({ path: newPath, oldPath, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary });
      i += 3;
    }
  }
  return files;
}

/**
 * Diff between two checkpoints of the same session, hiding upstream commits that
 * a rebase/restack pulled in during the turn.
 *
 * If merge-base(from, parent) != merge-base(to, parent), the branch was rebased.
 * `git merge-tree --write-tree --merge-base=B0 B1 from` replays the pre-turn
 * work on the new base without touching the worktree; diffing that tree against
 * `to` leaves only what changed during the turn.
 */
export async function turnDiff(
  cwd: string,
  from: Checkpoint,
  to: Checkpoint,
  opts: { ignoreWhitespace?: boolean } = {},
): Promise<DiffResult> {
  const parent = to.parent ?? from.parent;
  let base = from.commit;
  let replay: DiffResult["replay"] = null;
  if (parent && (await revParse(cwd, parent))) {
    const [b0, b1] = await Promise.all([mergeBase(cwd, from.commit, parent), mergeBase(cwd, to.commit, parent)]);
    if (b0 && b1 && b0 !== b1) {
      const r = await gitRaw(cwd, ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${b0}`, b1, from.commit]);
      const tree = r.stdout.split("\n")[0]?.trim();
      if (tree && /^[0-9a-f]{40,64}$/.test(tree)) {
        base = tree;
        replay = { from: from.commit, oldBase: b0, newBase: b1, conflicts: r.code === 1 };
      }
    }
  }
  const { patch, files } = await diffRange(cwd, base, to.commit, opts.ignoreWhitespace ?? false);
  return { patch, files, baseOid: base, headOid: to.commit, replay };
}

/**
 * Changes on `branch` alone: merge-base(parent, head)..head. `head` defaults to
 * the branch tip; pass a worktree snapshot commit to include uncommitted work.
 */
export async function branchDiff(
  cwd: string,
  branch: string,
  parent: string,
  opts: { head?: string; ignoreWhitespace?: boolean } = {},
): Promise<DiffResult> {
  const head = opts.head ?? (await revParse(cwd, branch));
  if (!head) throw new Error(`cannot resolve ${branch}`);
  const mb = (await mergeBase(cwd, parent, head)) ?? parent;
  const { patch, files } = await diffRange(cwd, mb, head, opts.ignoreWhitespace ?? false);
  return { patch, files, baseOid: mb, headOid: head, replay: null };
}

/** File contents at a tree-ish, or null when absent (added/deleted side). */
export async function fileAt(cwd: string, oid: string, path: string): Promise<string | null> {
  return gitOrNull(cwd, ["show", `${oid}:${path}`]);
}
