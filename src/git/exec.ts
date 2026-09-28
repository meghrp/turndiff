// Thin wrapper around `git`. Every call is explicit about cwd so hooks fired
// from any subdirectory of a worktree still hit the right repo.

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function gitRaw(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...opts.env, GIT_OPTIONAL_LOCKS: "0" },
    stdin: opts.stdin === undefined ? "ignore" : new Response(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** Run git and return trimmed stdout. Throws on non-zero exit. */
export async function git(cwd: string, args: string[], opts?: { env?: Record<string, string>; stdin?: string }): Promise<string> {
  const r = await gitRaw(cwd, args, opts);
  if (r.code !== 0) throw new GitError(args, r.code, r.stderr);
  return r.stdout.replace(/\n$/, "");
}

/** Run git, return null instead of throwing when it exits non-zero. */
export async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  const r = await gitRaw(cwd, args);
  return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
}

export interface RepoPaths {
  /** Worktree root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Common git dir shared across worktrees; refs and turndiff state live here. */
  commonDir: string;
  /** This worktree's git dir (holds its own index). */
  gitDir: string;
}

export async function repoPaths(cwd: string): Promise<RepoPaths> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"]);
  const [root, commonDirRaw, gitDir] = out.split("\n");
  const commonDir = commonDirRaw!.startsWith("/") ? commonDirRaw! : `${root}/${commonDirRaw}`;
  return { root: root!, commonDir, gitDir: gitDir! };
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const b = await gitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return b && b.length > 0 ? b : null;
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  return gitOrNull(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  return gitOrNull(cwd, ["merge-base", a, b]);
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await gitOrNull(cwd, ["rev-parse", "--verify", "-q", ref])) !== null;
}
