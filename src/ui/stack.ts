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
    const x = this.order(a)!;
    const y = this.order(b)!;
    return x[0] - y[0] || x[1] - y[1];
  }

  /** from..to (oldest first) when both commits sit on one ancestry chain, else null. */
  range(a: Oid, b: Oid): Target | null {
    const A = this.find(a);
    const B = this.find(b);
    if (!A || !B) return null;
    const chained = this.ancestorOrSelf(A.branch.name, B.branch.name) || this.ancestorOrSelf(B.branch.name, A.branch.name);
    if (!chained) return null;
    const [from, to] = this.cmp(A.commit.oid, B.commit.oid) <= 0 ? [A, B] : [B, A];
    return { kind: "commits", from: from.commit.oid, to: to.commit.oid };
  }

  contains(t: Extract<Target, { kind: "commits" }>, oid: Oid): boolean {
    const c = this.find(oid);
    const from = this.find(t.from);
    const to = this.find(t.to);
    if (!c || !from || !to) return false;
    if (!this.ancestorOrSelf(c.branch.name, to.branch.name) || !this.ancestorOrSelf(from.branch.name, c.branch.name)) return false;
    return this.cmp(from.commit.oid, c.commit.oid) <= 0 && this.cmp(c.commit.oid, to.commit.oid) <= 0;
  }
}

/** A `team/` style prefix every non-trunk branch shares, or "". */
export function sharedPrefix(s: RepoState): string {
  const names = s.branches.filter((b) => b.parent).map((b) => b.name);
  if (names.length < 2) return "";
  let p = names[0]!;
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, p.lastIndexOf("/") + 1);
}

export const stripPrefix = (name: string, prefix: string) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);

/** Branches the stack view covers; mirrors currentStack in src/git/stack.ts. */
export function currentStack(s: RepoState): Set<string> {
  const byName = new Map(s.branches.map((b) => [b.name, b]));
  const nonTrunk = s.branches.filter((b) => b.parent !== null);
  const current = s.branches.find((b) => b.current);
  if (!current || current.parent === null) return new Set(nonTrunk.map((b) => b.name));
  let root = current;
  while (root.parent !== null && root.parent !== s.trunk) root = byName.get(root.parent)!;
  const inStack = (b: Branch): boolean =>
    b.name === root.name || (b.parent !== null && b.parent !== s.trunk && inStack(byName.get(b.parent)!));
  return new Set(nonTrunk.filter(inStack).map((b) => b.name));
}

export type TreeItem =
  | { kind: "branch"; branch: Branch; depth: number }
  | { kind: "working"; depth: number }
  | { kind: "commit"; commit: Commit; depth: number };

/** Connector columns per rail row, like `gs ls`: a child's elbow runs down to its parent's glyph. */
export interface Guides {
  through: number[];
  elbow: number | null;
  stub: number | null;
}

export function treeGuides(items: TreeItem[]): Guides[] {
  const guides: Guides[] = items.map(() => ({ through: [], elbow: null, stub: null }));
  const at = new Map<string, number>();
  items.forEach((it, i) => it.kind === "branch" && at.set(it.branch.name, i));
  items.forEach((it, i) => {
    if (it.kind !== "branch" || !it.branch.parent) return;
    const j = at.get(it.branch.parent);
    if (j === undefined || j <= i) return;
    const col = items[j]!.depth;
    guides[i]!.elbow = col;
    for (let k = i + 1; k < j; k++) if (!guides[k]!.through.includes(col)) guides[k]!.through.push(col);
    guides[j]!.stub = col;
  });
  return guides;
}
