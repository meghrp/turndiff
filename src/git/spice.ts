// git-spice stores stack metadata in a bare ref, `refs/spice/data`, as a tree of
// JSON blobs: `repo` (trunk + remote) and `branches/<name>` (base, upstream,
// change request). Reading it directly means no dependency on the `gs`/`gis`
// binary and no worktree side effects.

import { git, gitOrNull, revParse } from "./exec.ts";

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
  const listing = (await gitOrNull(cwd, ["ls-tree", "-r", "--name-only", "-z", DATA_REF, "branches/"])) ?? "";
  const names = listing.split("\0").filter((l) => l.startsWith("branches/")).map((l) => l.slice("branches/".length));
  const branches = new Map<string, SpiceBranch>();
  // One `git cat-file --batch` round trip instead of N `git show` calls.
  if (names.length > 0) {
    const batchInput = names.map((n) => `${DATA_REF}:branches/${n}`).join("\n") + "\n";
    const out = Buffer.from(await git(cwd, ["cat-file", "--batch"], { stdin: batchInput }));
    let cursor = 0;
    for (const name of names) {
      const headerEnd = out.indexOf(10, cursor);
      if (headerEnd === -1) break;
      const header = out.subarray(cursor, headerEnd).toString("utf8");
      cursor = headerEnd + 1;
      if (header.endsWith(" missing")) continue;
      const size = Number(header.split(" ")[2]);
      const body = out.subarray(cursor, cursor + size).toString("utf8");
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

export async function defaultBranch(cwd: string, remote: string): Promise<string | null> {
  const head = await gitOrNull(cwd, ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace(`refs/remotes/${remote}/`, "");
  for (const candidate of ["main", "master"]) {
    if (await revParse(cwd, candidate)) return candidate;
  }
  return null;
}
