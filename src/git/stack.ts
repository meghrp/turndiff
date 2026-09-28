// The repo as a stack: trunk plus every git-spice tracked branch (or, without
// git-spice, the checked-out branch against the default branch), each with its
// own commits, parents before children.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { git, gitOrNull, type RepoPaths } from "./exec.ts";
import { defaultBranch, readSpice, resolveParent, type SpiceRepo } from "./spice.ts";
import type { Branch, Commit, Oid, Worktree } from "../model.ts";

const MAX_BRANCH_COMMITS = 300;
const TRUNK_HISTORY = 30;
const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";

export interface Stack {
  trunk: string;
  branches: Branch[];
  worktree: Worktree;
  /** Whether git-spice metadata drives the parents. */
  spice: boolean;
}

/** Cheap fingerprint of everything a Stack or View depends on: refs, HEAD, and uncommitted files. */
export async function repoVersion(paths: RepoPaths): Promise<{ version: string; status: string[] }> {
  const [refs, head, status] = await Promise.all([
    git(paths.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/spice"]),
    gitOrNull(paths.root, ["rev-parse", "-q", "--verify", "HEAD"]),
    git(paths.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
  ]);
  const changed = status.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
  const hash = createHash("sha1").update(refs).update(head ?? "").update(status);
  // Status alone misses a second edit to an already-modified file.
  for (const p of changed) {
    try {
      const st = statSync(join(paths.root, p));
      hash.update(`${p}\0${st.mtimeMs}\0${st.size}`);
    } catch {
      hash.update(`${p}\0gone`);
    }
  }
  return { version: hash.digest("hex").slice(0, 16), status: changed };
}

export async function loadStack(paths: RepoPaths, changed: string[]): Promise<Stack> {
  const cwd = paths.root;
  const [spice, current, head, tips] = await Promise.all([
    readSpice(cwd),
    gitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitOrNull(cwd, ["rev-parse", "-q", "--verify", "HEAD"]),
    branchTips(cwd),
  ]);
  const trunk = spice?.trunk ?? (await defaultBranch(cwd, "origin")) ?? current ?? "main";
  const parents = await parentMap(cwd, spice, current, trunk, tips);

  const children = new Map<string, string[]>();
  for (const [name, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), name]);
  const order: string[] = [];
  const visit = (name: string) => {
    if (order.includes(name)) return;
    order.push(name);
    for (const child of (children.get(name) ?? []).sort()) visit(child);
  };
  if (tips.has(trunk)) visit(trunk);

  const branches = await Promise.all(
    order.map(async (name): Promise<Branch> => {
      const tip = tips.get(name)!;
      const parent = name === trunk ? null : parents.get(name)!;
      const spiceEntry = spice?.branches.get(name);
      const pr = spiceEntry?.prNumber ? { number: spiceEntry.prNumber, url: spiceEntry.prUrl } : null;
      if (parent === null) {
        return { name, parent, tip, base: null, commits: await logCommits(cwd, [`-n${TRUNK_HISTORY}`, tip], null), pr, current: name === current, behind: false };
      }
      const parentTip = tips.get(parent)!;
      const base = (await gitOrNull(cwd, ["merge-base", parentTip, tip])) ?? parentTip;
      const commits = await logCommits(cwd, [`-n${MAX_BRANCH_COMMITS}`, `${base}..${tip}`], name);
      return { name, parent, tip, base, commits, pr, current: name === current, behind: base !== parentTip };
    }),
  );
  return { trunk, branches, worktree: { root: cwd, branch: current, head, changed: changed.length }, spice: spice !== null };
}

async function branchTips(cwd: string): Promise<Map<string, Oid>> {
  const out = await git(cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  return new Map(out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, Oid]));
}

/** Child -> parent for every non-trunk branch in the stack. A parent that no longer exists falls back to the trunk. */
async function parentMap(cwd: string, spice: SpiceRepo | null, current: string | null, trunk: string, tips: Map<string, Oid>): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  const exists = (b: string) => tips.has(b);
  for (const b of spice?.branches.values() ?? []) {
    if (b.name !== trunk && exists(b.name)) parents.set(b.name, exists(b.base) && b.base !== b.name ? b.base : trunk);
  }
  if (current && current !== trunk && !parents.has(current) && exists(current)) {
    const p = await resolveParent(cwd, current, spice);
    parents.set(current, p && exists(p) ? p : trunk);
  }
  // Drop cycles and chains that never reach the trunk.
  for (const name of [...parents.keys()]) {
    const seen = new Set<string>();
    let at: string | undefined = name;
    while (at && at !== trunk && !seen.has(at)) {
      seen.add(at);
      at = parents.get(at);
    }
    if (at !== trunk) parents.set(name, trunk);
  }
  return parents;
}

export async function logCommits(cwd: string, args: string[], branch: string | null): Promise<Commit[]> {
  const out = await gitOrNull(cwd, ["log", "--no-show-signature", LOG_FORMAT, ...args]);
  if (!out) return [];
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [oid, short, author, date, subject] = r.split("\x1f") as [string, string, string, string, string];
      return { oid, short, author, date, subject, branch };
    });
}

/** The stack branch whose own range holds `oid`, or null for trunk history and unknown commits. */
export function branchOfCommit(branches: Branch[], oid: Oid): string | null {
  return branches.find((b) => b.parent !== null && b.commits.some((c) => c.oid === oid))?.name ?? null;
}

/**
 * Branches of the stack the checked-out branch belongs to: its ancestors down
 * to the trunk and everything stacked on top of them. Every non-trunk branch
 * when the trunk or an untracked branch is checked out. Parents first.
 */
export function currentStack(stack: Stack): Branch[] {
  const byName = new Map(stack.branches.map((b) => [b.name, b]));
  const current = stack.worktree.branch ? byName.get(stack.worktree.branch) : undefined;
  const nonTrunk = stack.branches.filter((b) => b.parent !== null);
  if (!current || current.parent === null) return nonTrunk;
  let root = current;
  while (root.parent !== null && root.parent !== stack.trunk) root = byName.get(root.parent)!;
  const inStack = (b: Branch): boolean => b.name === root.name || (b.parent !== null && b.parent !== stack.trunk && inStack(byName.get(b.parent)!));
  return nonTrunk.filter(inStack);
}
