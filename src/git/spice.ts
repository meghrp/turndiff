// git-spice stores stack metadata in a bare ref, `refs/spice/data`, as a tree of
// JSON blobs: `repo` (trunk + remote) and `branches/<name>` (base, upstream,
// change request). Reading it directly means no dependency on the `gs`/`gis`
// binary and no worktree side effects.

import { git, gitOrNull, mergeBase, revParse } from "./exec.ts";

const DATA_REF = "refs/spice/data";

export interface SpiceBranch {
  name: string;
  base: string;
  baseHash: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface SpiceRepo {
  trunk: string;
  remote: string | null;
  branches: Map<string, SpiceBranch>;
}

interface BranchBlob {
  base?: { name?: string; hash?: string };
  change?: { github?: { pr?: { number?: number }; comment?: { url?: string } }; gitlab?: { mr?: { number?: number } } };
}

export async function readSpice(cwd: string): Promise<SpiceRepo | null> {
  const repoBlob = await gitOrNull(cwd, ["show", `${DATA_REF}:repo`]);
  if (repoBlob === null) return null;
  let trunk = "main";
  let remote: string | null = null;
  try {
    const parsed = JSON.parse(repoBlob) as { trunk?: string; remote?: string };
    trunk = parsed.trunk ?? trunk;
    remote = parsed.remote ?? null;
  } catch {
    /* malformed repo blob; keep defaults */
  }
  const listing = (await gitOrNull(cwd, ["ls-tree", "-r", "--name-only", DATA_REF, "branches/"])) ?? "";
  const names = listing.split("\n").filter((l) => l.startsWith("branches/")).map((l) => l.slice("branches/".length));
  const branches = new Map<string, SpiceBranch>();
  // One `git cat-file --batch` round trip instead of N `git show` calls.
  if (names.length > 0) {
    const batchInput = names.map((n) => `${DATA_REF}:branches/${n}`).join("\n") + "\n";
    const out = await git(cwd, ["cat-file", "--batch"], { stdin: batchInput });
    let cursor = 0;
    for (const name of names) {
      const headerEnd = out.indexOf("\n", cursor);
      if (headerEnd === -1) break;
      const header = out.slice(cursor, headerEnd);
      cursor = headerEnd + 1;
      if (header.endsWith(" missing")) continue;
      const size = Number(header.split(" ")[2]);
      const body = out.slice(cursor, cursor + size);
      cursor += size + 1;
      try {
        const blob = JSON.parse(body) as BranchBlob;
        const prUrl = derivePrUrl(blob);
        branches.set(name, {
          name,
          base: blob.base?.name ?? trunk,
          baseHash: blob.base?.hash ?? null,
          prNumber: blob.change?.github?.pr?.number ?? blob.change?.gitlab?.mr?.number ?? null,
          prUrl,
        });
      } catch {
        /* skip malformed branch blob */
      }
    }
  }
  return { trunk, remote, branches };
}

function derivePrUrl(blob: BranchBlob): string | null {
  const commentUrl = blob.change?.github?.comment?.url;
  const number = blob.change?.github?.pr?.number;
  if (!commentUrl || !number) return null;
  const idx = commentUrl.indexOf("#");
  return idx === -1 ? commentUrl : commentUrl.slice(0, idx);
}

/**
 * The branch this one should be diffed against. Priority: git-spice base,
 * `gh stack`'s `branch.<name>.gh-merge-base`, then the remote's default branch.
 */
export async function resolveParent(cwd: string, branch: string, spice?: SpiceRepo | null): Promise<string | null> {
  const s = spice === undefined ? await readSpice(cwd) : spice;
  const entry = s?.branches.get(branch);
  if (entry && entry.base !== branch) return entry.base;
  const configured = await gitOrNull(cwd, ["config", "--get", `branch.${branch}.gh-merge-base`]);
  if (configured && configured !== branch) return configured;
  const def = await defaultBranch(cwd, s?.remote ?? "origin");
  if (def && def !== branch) return def;
  if (s?.trunk && s.trunk !== branch) return s.trunk;
  return null;
}

/** Ref to use for the trunk itself: its upstream, so a pulled-but-not-yet-merged main still diffs sanely. */
export async function trunkComparisonRef(cwd: string, branch: string): Promise<string | null> {
  const upstream = await gitOrNull(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  return upstream && upstream.length > 0 ? upstream : null;
}

export async function defaultBranch(cwd: string, remote: string): Promise<string | null> {
  const head = await gitOrNull(cwd, ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace(`refs/remotes/${remote}/`, "");
  for (const candidate of ["main", "master"]) {
    if (await revParse(cwd, candidate)) return candidate;
  }
  return null;
}

export interface StackEntry {
  name: string;
  base: string;
  depth: number;
  isCurrent: boolean;
  isTrunk: boolean;
  prNumber: number | null;
  prUrl: string | null;
  /** Commits on this branch and not its base. */
  ahead: number;
  head: string | null;
}

/**
 * Every branch in the stack containing `branch`: the chain down to trunk plus
 * every branch stacked on top of anything in that chain. Ordered trunk first.
 */
export async function stackFor(cwd: string, branch: string | null, spice: SpiceRepo | null): Promise<StackEntry[]> {
  if (!spice) {
    if (!branch) return [];
    const parent = await resolveParent(cwd, branch, null);
    if (!parent) return [];
    const head = await revParse(cwd, branch);
    return [
      { name: parent, base: parent, depth: 0, isCurrent: false, isTrunk: true, prNumber: null, prUrl: null, ahead: 0, head: await revParse(cwd, parent) },
      { name: branch, base: parent, depth: 1, isCurrent: true, isTrunk: false, prNumber: null, prUrl: null, ahead: await aheadCount(cwd, parent, branch), head },
    ];
  }
  const children = new Map<string, string[]>();
  for (const b of spice.branches.values()) {
    const list = children.get(b.base) ?? [];
    list.push(b.name);
    children.set(b.base, list);
  }
  // Walk down to the root of this chain.
  let root = branch && spice.branches.has(branch) ? branch : null;
  const chain: string[] = [];
  const seen = new Set<string>();
  while (root && spice.branches.has(root) && !seen.has(root)) {
    seen.add(root);
    chain.unshift(root);
    root = spice.branches.get(root)!.base;
  }
  const trunk = root ?? spice.trunk;
  // Everything reachable upward from the lowest branch in the chain shares this stack.
  const entries: StackEntry[] = [];
  const trunkHead = await revParse(cwd, trunk);
  entries.push({ name: trunk, base: trunk, depth: 0, isCurrent: branch === trunk, isTrunk: true, prNumber: null, prUrl: null, ahead: 0, head: trunkHead });
  const start = chain[0] ?? null;
  const roots = start ? [start] : (children.get(trunk) ?? []);
  const visit = async (name: string, depth: number) => {
    const b = spice.branches.get(name);
    if (!b || entries.some((e) => e.name === name)) return;
    entries.push({
      name,
      base: b.base,
      depth,
      isCurrent: name === branch,
      isTrunk: false,
      prNumber: b.prNumber,
      prUrl: b.prUrl,
      ahead: await aheadCount(cwd, b.base, name),
      head: await revParse(cwd, name),
    });
    for (const child of children.get(name) ?? []) await visit(child, depth + 1);
  };
  for (const r of roots) await visit(r, 1);
  return entries;
}

async function aheadCount(cwd: string, base: string, branch: string): Promise<number> {
  const mb = await mergeBase(cwd, base, branch);
  if (!mb) return 0;
  const n = await gitOrNull(cwd, ["rev-list", "--count", `${mb}..${branch}`]);
  return n ? Number(n) : 0;
}
