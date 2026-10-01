import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoPaths } from "./exec.ts";
import { diffTrees, EMPTY_TREE, snapshotWorktree } from "./diff.ts";
import { readSpice } from "./spice.ts";

async function withRepo(run: (root: string) => Promise<void>, format = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "turndiff-git-test-"));
  try {
    await git(root, ["init", "-q", "-b", "main", `--object-format=${format}`]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const commit = async (root: string) => {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
};

test("subdirectory and linked-worktree invocations resolve the same shared Git directory", () =>
  withRepo(async (root) => {
    await mkdir(join(root, "nested"));
    await Bun.write(join(root, "x.txt"), "base\n");
    await commit(root);
    const paths = await repoPaths(root);
    expect(await repoPaths(join(root, "nested"))).toEqual(paths);
    const linked = join(root, "linked");
    await git(root, ["worktree", "add", "-qb", "topic", linked]);
    await mkdir(join(linked, "nested"));
    const linkedPaths = await repoPaths(linked);
    expect(linkedPaths.commonDir).toBe(paths.commonDir);
    expect(linkedPaths.gitDir).not.toBe(paths.gitDir);
    expect(await repoPaths(join(linked, "nested"))).toEqual(linkedPaths);
  }));

test("UTF-8 git-spice metadata preserves every branch and its parent", () =>
  withRepo(async (root) => {
    await mkdir(join(root, "branches"));
    await Bun.write(join(root, "repo"), JSON.stringify({ trunk: "main" }));
    await Bun.write(
      join(root, "branches", "a"),
      JSON.stringify({
        base: { name: "main" },
        change: { github: { pr: { number: 7 }, comment: { url: `https://example.invalid/${"é日本".repeat(100)}#comment` } } },
      }),
    );
    await Bun.write(join(root, "branches", "b"), JSON.stringify({ base: { name: "a" } }));
    await git(root, ["add", "-A"]);
    await git(root, ["update-ref", "refs/spice/data", await git(root, ["write-tree"])]);
    const spice = await readSpice(root);
    expect([...spice!.branches].map(([name, b]) => [name, b.base])).toEqual([
      ["a", "main"],
      ["b", "a"],
    ]);
    expect(spice!.branches.get("a")!.prNumber).toBe(7);
  }));

test("tab-containing filenames keep their own changed-line counts", () =>
  withRepo(async (root) => {
    const path = "tab\tfile.txt";
    await Bun.write(join(root, path), "before\n");
    const base = await commit(root);
    await Bun.write(join(root, path), "after\n");
    const files = await diffTrees(root, base, await commit(root));
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([[path, 1, 1]]);
  }));

test("file-to-symlink changes retain both sides of the patch", () =>
  withRepo(async (root) => {
    await Bun.write(join(root, "type.txt"), "regular\n");
    const base = await commit(root);
    await rm(join(root, "type.txt"));
    await symlink("target", join(root, "type.txt"));
    const [file] = await diffTrees(root, base, await commit(root));
    expect(file!.patch).toContain("-regular");
    expect(file!.patch).toContain("+target");
    expect(file!.patch).toContain("120000");
  }));

test("unborn SHA-256 repositories can review uncommitted files", () =>
  withRepo(async (root) => {
    await Bun.write(join(root, "first.txt"), "first\n");
    const paths = await repoPaths(root);
    const files = await diffTrees(root, EMPTY_TREE, await snapshotWorktree(paths));
    expect(files.map((f) => [f.path, f.additions])).toEqual([["first.txt", 1]]);
    expect(files[0]!.patch).toContain("+first");
  }, "sha256"));
