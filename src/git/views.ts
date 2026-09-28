// Resolve a Target into a View: one Section per branch-owned diff.

import { gitOrNull, type RepoPaths } from "./exec.ts";
import { diffTrees, EMPTY_TREE } from "./diff.ts";
import { branchOfCommit, currentStack, logCommits, type Stack } from "./stack.ts";
import { compareSnapshots, loadSession, loadSnapshot, snapshotOf, turnRange, type Snapshot } from "./snapshots.ts";
import type { Branch, Section, Target, View } from "../model.ts";

export interface ViewContext {
  paths: RepoPaths;
  stack: Stack;
  version: string;
  /** Worktree snapshot commit for the current version, cached by the caller. */
  worktree(): Promise<string>;
  /** Snapshot id of the last submitted review. */
  lastReview: string | null;
  ignoreWhitespace: boolean;
}

export class TargetError extends Error {}

export async function resolveView(ctx: ViewContext, target: Target): Promise<View> {
  const { sections, notes, title } = await resolve(ctx, target);
  return { target, title, sections, notes, version: ctx.version };
}

async function resolve(ctx: ViewContext, target: Target): Promise<{ title: string; sections: Section[]; notes: string[] }> {
  const { stack } = ctx;
  switch (target.kind) {
    case "branch": {
      const branch = stack.branches.find((b) => b.name === target.branch);
      if (!branch) throw new TargetError(`${target.branch} is not a branch of this stack`);
      if (branch.parent === null) throw new TargetError(`${branch.name} is the trunk; pick a commit or the uncommitted changes instead`);
      const section = await branchSection(ctx, branch, target.working);
      return { title: section.title, sections: [section], notes: [] };
    }
    case "stack": {
      const sections = await Promise.all(currentStack(stack).map((b) => branchSection(ctx, b, true)));
      return { title: "Entire stack", sections: sections.filter((s) => s.files.length > 0), notes: [] };
    }
    case "working": {
      const head = stack.worktree.head;
      const worktree = await ctx.worktree();
      const files = await diffTrees(ctx.paths.root, head ?? EMPTY_TREE, worktree, ctx);
      const where = stack.worktree.branch ?? "detached HEAD";
      return {
        title: `Uncommitted changes on ${where}`,
        sections: [{ id: "working", branch: stack.worktree.branch, title: `Uncommitted · ${where}`, base: head ?? EMPTY_TREE, head: worktree, commits: [], includesWorking: true, replay: null, files }],
        notes: [],
      };
    }
    case "commits":
      return commitsView(ctx, target.from, target.to);
    case "turns": {
      const session = await loadSession(ctx.paths, target.session);
      if (!session) throw new TargetError(`unknown session ${target.session}`);
      const { pre, post } = turnRange(session, target.from, target.to);
      const a = pre ? await loadSnapshot(ctx.paths, pre) : null;
      if (!a) throw new TargetError(`turn ${target.from} has no starting snapshot`);
      const b = post ? await loadSnapshot(ctx.paths, post) : await live(ctx);
      if (!b) throw new TargetError(`the snapshot ending turn ${target.to} is missing`);
      const running = post === null ? " (running)" : "";
      const title = target.from === target.to ? `Turn ${target.to}${running}` : `Turns ${target.from}–${target.to}${running}`;
      return { title, ...(await compareSnapshots(ctx.paths, a, b, stack, ctx)) };
    }
    case "since-review": {
      const a = ctx.lastReview ? await loadSnapshot(ctx.paths, ctx.lastReview) : null;
      if (!a) throw new TargetError("no review has been submitted in this worktree yet");
      return { title: "Since last review", ...(await compareSnapshots(ctx.paths, a, await live(ctx), stack, ctx)) };
    }
  }
}

async function live(ctx: ViewContext): Promise<Snapshot> {
  return snapshotOf(ctx.stack, await ctx.worktree(), "live");
}

async function branchSection(ctx: ViewContext, branch: Branch, withWorking: boolean): Promise<Section> {
  const working = withWorking && branch.current && ctx.stack.worktree.changed > 0;
  const head = working ? await ctx.worktree() : branch.tip;
  const base = branch.base!;
  return {
    id: `branch:${branch.name}`,
    branch: branch.name,
    title: `${branch.name} ← ${branch.parent}`,
    base,
    head,
    commits: branch.commits,
    includesWorking: working,
    replay: null,
    files: await diffTrees(ctx.paths.root, base, head, ctx),
  };
}

async function commitsView(ctx: ViewContext, fromRev: string, toRev: string): Promise<{ title: string; sections: Section[]; notes: string[] }> {
  const cwd = ctx.paths.root;
  const [from, to] = await Promise.all([fromRev, toRev].map((r) => gitOrNull(cwd, ["rev-parse", "-q", "--verify", `${r}^{commit}`])));
  if (!from || !to) throw new TargetError(`unknown commit ${from ? toRev : fromRev}`);
  if ((await gitOrNull(cwd, ["merge-base", "--is-ancestor", from, to])) === null) throw new TargetError(`${fromRev.slice(0, 10)} is not an ancestor of ${toRev.slice(0, 10)}`);
  const base = (await gitOrNull(cwd, ["rev-parse", "-q", "--verify", `${from}^1`])) ?? EMPTY_TREE;
  const branch = branchOfCommit(ctx.stack.branches, to);
  const commits = await logCommits(cwd, base === EMPTY_TREE ? [to] : [`${base}..${to}`], null);
  for (const c of commits) c.branch = branchOfCommit(ctx.stack.branches, c.oid);
  const tip = commits[0]!;
  const title = from === to ? `${tip.short} ${tip.subject}` : `${commits.at(-1)!.short}..${tip.short} · ${commits.length} commits`;
  return {
    title,
    sections: [{ id: `commits:${from}..${to}`, branch, title, base, head: to, commits, includesWorking: false, replay: null, files: await diffTrees(cwd, base, to, ctx) }],
    notes: [],
  };
}
