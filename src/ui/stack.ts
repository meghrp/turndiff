import { targetToHash, type Branch, type Commit, type Oid, type RepoState, type Target } from "../model.ts";

export const sameTarget = (a: Target, b: Target) => targetToHash(a) === targetToHash(b);

export function defaultTarget(s: RepoState): Target {
  const cur = s.branches.find((b) => b.current);
  const dirty = s.worktree.changed > 0;
  if (cur?.parent) return { kind: "branch", branch: cur.name, working: dirty };
  if (dirty) return { kind: "working" };
  return { kind: "stack" };
}

export interface TreeRow {
  branch: Branch;
  depth: number;
}

/** git-spice `ls` orientation: children above parents, trunk last. */
export function treeRows(s: RepoState): TreeRow[] {
  const depth = new Map<string, number>();
  for (const b of s.branches) depth.set(b.name, b.parent ? (depth.get(b.parent) ?? 0) + 1 : 0);
  return [...s.branches].reverse().map((branch) => ({ branch, depth: depth.get(branch.name) ?? 0 }));
}

/** Commit positions along ancestry chains, so ranges can be ordered and bounded. */
export class CommitIndex {
  private byOid = new Map<Oid, { commit: Commit; branch: Branch; index: number }>();
  private branches = new Map<string, Branch>();
  private depth = new Map<string, number>();

  constructor(s: RepoState) {
    for (const b of s.branches) {
      this.branches.set(b.name, b);
      this.depth.set(b.name, b.parent ? (this.depth.get(b.parent) ?? 0) + 1 : 0);
      b.commits.forEach((commit, index) => {
        if (!this.byOid.has(commit.oid)) this.byOid.set(commit.oid, { commit, branch: b, index });
      });
    }
  }

  find(oid: Oid) {
    for (const [k, v] of this.byOid) if (k === oid || k.startsWith(oid)) return v;
    return undefined;
  }

  /** True when `a` is `b` or one of its ancestors in the stack. */
  private ancestorOrSelf(a: string, b: string): boolean {
    for (let cur: string | null = b; cur; cur = this.branches.get(cur)?.parent ?? null) if (cur === a) return true;
    return false;
  }

  /** Sort key along a chain: deeper branches are newer; within a branch, lower index is newer. */
  private order(oid: Oid): [number, number] | null {
    const e = this.find(oid);
    return e ? [this.depth.get(e.branch.name) ?? 0, -e.index] : null;
  }

  private cmp(a: Oid, b: Oid): number {
    const x = this.order(a)!, y = this.order(b)!;
    return x[0] - y[0] || x[1] - y[1];
  }

  /** from..to (oldest first) when both commits sit on one ancestry chain, else null. */
  range(a: Oid, b: Oid): Target | null {
    const A = this.find(a), B = this.find(b);
    if (!A || !B) return null;
    const chained = this.ancestorOrSelf(A.branch.name, B.branch.name) || this.ancestorOrSelf(B.branch.name, A.branch.name);
    if (!chained) return null;
    const [from, to] = this.cmp(A.commit.oid, B.commit.oid) <= 0 ? [A, B] : [B, A];
    return { kind: "commits", from: from.commit.oid, to: to.commit.oid };
  }

  contains(t: Extract<Target, { kind: "commits" }>, oid: Oid): boolean {
    const c = this.find(oid), from = this.find(t.from), to = this.find(t.to);
    if (!c || !from || !to) return false;
    if (!this.ancestorOrSelf(c.branch.name, to.branch.name) || !this.ancestorOrSelf(from.branch.name, c.branch.name)) return false;
    return this.cmp(from.commit.oid, c.commit.oid) <= 0 && this.cmp(c.commit.oid, to.commit.oid) <= 0;
  }
}
