import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoPaths, type RepoPaths } from "./git/exec.ts";
import { diffTrees, snapshotWorktree } from "./git/diff.ts";
import { captureSnapshot, compareSnapshots, loadSnapshot, promptLabel } from "./git/snapshots.ts";
import { loadStack, repoVersion, type Stack } from "./git/stack.ts";
import { resolveView } from "./git/views.ts";
import { buildScenario, SESSION, type Scenario } from "./scenario.ts";
import { ReviewStore } from "./server/store.ts";
import { formatFeedback } from "./feedback.ts";
import type { Comment, FileChange, Section, Target, View } from "./model.ts";

let sc: Scenario;
let paths: RepoPaths;
let stack: Stack;
let version: string;

beforeAll(async () => {
  sc = await buildScenario();
  paths = await repoPaths(sc.root);
  const v = await repoVersion(paths);
  version = v.version;
  stack = await loadStack(paths, v.status);
});

afterAll(async () => {
  await rm(sc.root, { recursive: true, force: true });
});

const view = (target: Target): Promise<View> =>
  resolveView({ paths, stack, version, worktree: () => snapshotWorktree(paths), lastReview: null, ignoreWhitespace: false }, target);
const paths_ = (s: Section) => s.files.map((f) => f.path).sort();
const added = (f: FileChange) => f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
const removed = (f: FileChange) => f.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));

describe("stack", () => {
  test("lists trunk then branches parent-first, with each branch's own commits", () => {
    expect(stack.branches.map((b) => [b.name, b.parent])).toEqual([
      ["main", null],
      ["feat-a", "main"],
      ["feat-b", "feat-a"],
      ["feat-c", "feat-b"],
      ["feat-d", "feat-c"],
    ]);
    const featB = stack.branches.find((b) => b.name === "feat-b")!;
    expect(featB.commits.map((c) => [c.subject, c.branch])).toEqual([
      ["feat-b: add g", "feat-b"],
      ["feat-b: add f", "feat-b"],
    ]);
    expect(featB.pr?.number).toBe(42);
    expect(featB.current).toBe(true);
    expect(stack.branches.every((b) => !b.behind)).toBe(true);
    expect(stack.worktree).toMatchObject({ branch: "feat-b", changed: 2 });
  });
});

describe("views", () => {
  test("a branch view holds only that branch's changes against its parent", async () => {
    const v = await view({ kind: "branch", branch: "feat-b", working: false });
    expect(v.sections).toHaveLength(1);
    expect(paths_(v.sections[0]!)).toEqual(["feat_b.py"]);
    const f = v.sections[0]!.files[0]!;
    expect(f.status).toBe("added");
    expect(f.oldBlob).toBeNull();
    expect(f.newBlob).toBe(await git(sc.root, ["rev-parse", "feat-b:feat_b.py"]));
    expect(added(f)).toContain("+def g():");
    expect(added(f)).not.toContain("+def h():");
  });

  test("the checked-out branch can include uncommitted changes", async () => {
    const v = await view({ kind: "branch", branch: "feat-b", working: true });
    expect(v.sections[0]!.includesWorking).toBe(true);
    expect(paths_(v.sections[0]!)).toEqual(["feat_b.py", "notes.md"]);
    expect(added(v.sections[0]!.files[0]!)).toContain("+def h():");
  });

  test("a commit view is labeled with the branch that owns the commit", async () => {
    const v = await view({ kind: "commits", from: sc.featACommit, to: sc.featACommit });
    const s = v.sections[0]!;
    expect(s.branch).toBe("feat-a");
    expect(s.commits.map((c) => [c.subject, c.branch])).toEqual([["feat-a: add a3", "feat-a"]]);
    expect(paths_(s)).toEqual(["feat_a.py"]);
    expect(added(s.files[0]!)).toEqual(["+a3"]);
  });

  test("a commit range can span branches of one chain", async () => {
    const featA = stack.branches.find((b) => b.name === "feat-a")!;
    const featB = stack.branches.find((b) => b.name === "feat-b")!;
    const v = await view({ kind: "commits", from: featA.commits.at(-1)!.oid, to: featB.tip });
    const s = v.sections[0]!;
    expect(s.branch).toBe("feat-b");
    expect(s.commits.map((c) => c.branch)).toEqual(["feat-b", "feat-b", "feat-a", "feat-a"]);
    expect(paths_(s)).toEqual(["feat_a.py", "feat_b.py"]);
  });

  test("a range whose ends are not in one chain is refused", async () => {
    const featA = stack.branches.find((b) => b.name === "feat-a")!;
    const main = stack.branches.find((b) => b.name === "main")!;
    await expect(view({ kind: "commits", from: featA.tip, to: main.commits[1]!.oid })).rejects.toThrow("not an ancestor");
  });

  test("the working view is uncommitted changes against HEAD", async () => {
    const v = await view({ kind: "working" });
    expect(paths_(v.sections[0]!)).toEqual(["feat_b.py", "notes.md"]);
    expect(v.sections[0]!.branch).toBe("feat-b");
  });

  test("the stack view has one section per changed branch, parents first", async () => {
    const v = await view({ kind: "stack" });
    expect(v.sections.map((s) => [s.branch, paths_(s)])).toEqual([
      ["feat-a", ["feat_a.py"]],
      ["feat-b", ["feat_b.py", "notes.md"]],
      ["feat-c", ["feat_c.py"]],
      ["feat-d", ["feat_d.py"]],
    ]);
  });
});

describe("turn comparison", () => {
  test("a turn that switches branches and restacks shows only each branch's new work", async () => {
    const v = await view({ kind: "turns", session: SESSION, from: 1, to: 1 });
    expect(v.title).toBe("Turn 1");
    expect(v.sections.map((s) => [s.branch, paths_(s)])).toEqual([
      ["feat-a", ["feat_a.py"]],
      ["feat-b", ["feat_b.py"]],
    ]);
    const [a, b] = v.sections as [Section, Section];
    expect(added(a.files[0]!)).toEqual(["+a3"]);
    expect(removed(a.files[0]!)).toEqual([]);
    expect(added(b.files[0]!)).toEqual(["+", "+def g():", "+    return 2", "+", "+def h():", "+    return 3"]);
    expect(removed(b.files[0]!)).toEqual([]);
    expect(a.replay).toEqual({ conflicts: false });
    expect(b.includesWorking).toBe(true);
    expect(a.commits.map((c) => c.subject)).toEqual(["feat-a: add a3"]);
    expect(b.commits.map((c) => c.subject)).toEqual(["feat-b: add g"]);
  });

  test("a branch created during a turn shows its whole diff against its parent", async () => {
    const v = await view({ kind: "turns", session: SESSION, from: 2, to: 2 });
    expect(v.sections.map((s) => [s.title, paths_(s)])).toEqual([["feat-d (new branch)", ["feat_d.py"]]]);
    expect(v.sections[0]!.commits.map((c) => c.subject)).toEqual(["feat-d: add D"]);
  });

  test("a turn range covers every branch touched across the turns", async () => {
    const v = await view({ kind: "turns", session: SESSION, from: 1, to: 2 });
    expect(v.title).toBe("Turns 1–2");
    expect(v.sections.map((s) => s.branch)).toEqual(["feat-a", "feat-b", "feat-d"]);
  });
});

describe("without git-spice", () => {
  test("the checked-out branch is diffed against the default branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "turndiff-plain-"));
    try {
      const run = (...args: string[]) => git(root, args);
      await run("init", "-q", "-b", "main");
      await run("config", "user.email", "dev@example.invalid");
      await run("config", "user.name", "Dev");
      await Bun.write(join(root, "x.txt"), "1\n");
      await run("add", "-A");
      await run("commit", "-qm", "base");
      await run("checkout", "-qb", "topic");
      await Bun.write(join(root, "x.txt"), "1\n2\n");
      await run("commit", "-qam", "topic work");
      const p = await repoPaths(root);
      const s = await loadStack(p, []);
      expect(s.spice).toBe(false);
      expect(s.branches.map((b) => [b.name, b.parent, b.commits.length])).toEqual([
        ["main", null, 1],
        ["topic", "main", 1],
      ]);
      const v = await resolveView({ paths: p, stack: s, version: "", worktree: () => snapshotWorktree(p), lastReview: null, ignoreWhitespace: false }, { kind: "branch", branch: "topic", working: false });
      expect(added(v.sections[0]!.files[0]!)).toEqual(["+2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review", () => {
  const comment = (id: string, branch: string, path: string, blob: string, line: number): Comment => ({
    id,
    body: `note ${id}`,
    anchor: { path, side: "new", start: line, end: line, blob },
    snippet: ["x"],
    origin: { branch, head: "0".repeat(40), working: false, target: { kind: "branch", branch, working: false } },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  test("comments from every branch persist and reach one feedback, grouped in stack order", async () => {
    const store = await ReviewStore.open(paths);
    const featA = await git(sc.root, ["rev-parse", "feat-a:feat_a.py"]);
    const featB = await git(sc.root, ["rev-parse", "feat-b:feat_b.py"]);
    const onDisk = await git(sc.root, ["hash-object", "feat_b.py"]);
    const replaced = await git(sc.root, ["rev-parse", "feat-b~1:feat_b.py"]);
    await store.upsertComment(comment("c2", "feat-b", "feat_b.py", featB, 4));
    await store.upsertComment(comment("c1", "feat-a", "feat_a.py", featA, 3));
    await store.upsertComment(comment("c3", "feat-b", "feat_b.py", onDisk, 7));
    await store.upsertComment(comment("c4", "feat-b", "feat_b.py", replaced, 1));

    const reopened = await ReviewStore.open(paths);
    const state = await reopened.state(stack);
    expect(state.comments.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
    // c2 matches feat-b's tip and c3 its uncommitted file; c4's content exists in neither.
    expect(state.outdated).toEqual(["c4"]);

    const md = formatFeedback({
      decision: "request_changes",
      summary: "",
      comments: state.comments,
      outdated: new Set(state.outdated),
      branchOrder: stack.branches.map((b) => b.name),
      prs: new Map([["feat-b", 42]]),
      usesSpice: true,
    });
    expect(md.indexOf("## Branch `feat-a`")).toBeGreaterThan(0);
    expect(md.indexOf("## Branch `feat-a`")).toBeLessThan(md.indexOf("## Branch `feat-b` (#42)"));
    expect(md).toContain("### `feat_a.py:3`");
    expect(md).toContain("note c1");
    expect(md).toContain("note c2");
    expect(md).toContain("git-spice upstack restack");
  });
});

describe("comparison edge cases", () => {
  // A plain repo with feat-x and feat-y on main and feat-b on feat-x, all tracked by git-spice.
  async function repo(): Promise<{ root: string; paths: RepoPaths; run: (...a: string[]) => Promise<string>; put: (p: string, t: string) => Promise<number> }> {
    const root = await mkdtemp(join(tmpdir(), "turndiff-edge-"));
    const run = (...args: string[]) => git(root, args);
    const put = (p: string, t: string) => Bun.write(join(root, p), t);
    await run("init", "-q", "-b", "main");
    await run("config", "user.email", "dev@example.invalid");
    await run("config", "user.name", "Dev");
    await put("a.txt", "1\n");
    await run("add", "-A");
    await run("commit", "-qm", "base");
    return { root, paths: await repoPaths(root), run, put };
  }
  const compare = async (paths: RepoPaths, a: string, b: string) => {
    const s = await loadStack(paths, []);
    return compareSnapshots(paths, (await loadSnapshot(paths, a))!, (await loadSnapshot(paths, b))!, s);
  };

  test("checking out another branch with uncommitted work carried along changes nothing", async () => {
    const { root, paths, run, put } = await repo();
    try {
      await run("branch", "feat-a");
      await run("checkout", "-qb", "feat-b");
      await put("a.txt", "1\nwip\n");
      await put("notes.md", "scratch\n");
      await captureSnapshot(paths, "before");
      await run("checkout", "-q", "feat-a");
      await captureSnapshot(paths, "after");
      expect((await compare(paths, "before", "after")).sections).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("committing uncommitted work on one branch and switching to a clean one changes nothing", async () => {
    const { root, paths, run, put } = await repo();
    try {
      await run("branch", "feat-a");
      await run("checkout", "-qb", "feat-b");
      await put("a.txt", "1\nwip\n");
      await captureSnapshot(paths, "before");
      await run("commit", "-qam", "commit the wip");
      await run("checkout", "-q", "feat-a");
      await captureSnapshot(paths, "after");
      expect((await compare(paths, "before", "after")).sections).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("moving a branch onto another parent is not a change to the branch", async () => {
    const { root, paths, run, put } = await repo();
    try {
      await run("checkout", "-qb", "feat-x");
      await put("fx.py", "x\n");
      await run("add", "-A");
      await run("commit", "-qm", "x");
      await run("checkout", "-qb", "feat-b");
      await put("fb.py", "b\n");
      await run("add", "-A");
      await run("commit", "-qm", "b");
      await run("checkout", "-qb", "feat-y", "main");
      await put("fy.py", "y\n");
      await run("add", "-A");
      await run("commit", "-qm", "y");
      await writeSpiceFor(root, [["feat-x", "main"], ["feat-y", "main"], ["feat-b", "feat-x"]]);
      await captureSnapshot(paths, "before");
      await run("rebase", "-q", "--onto", "feat-y", "feat-x", "feat-b");
      await writeSpiceFor(root, [["feat-x", "main"], ["feat-y", "main"], ["feat-b", "feat-y"]]);
      await captureSnapshot(paths, "after");
      expect((await compare(paths, "before", "after")).sections).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commits on a trunk with no upstream are the trunk's own work", async () => {
    const { root, paths, run, put } = await repo();
    try {
      await captureSnapshot(paths, "before");
      await put("a.txt", "1\n2\n");
      await run("commit", "-qam", "agent work on main");
      await captureSnapshot(paths, "after");
      const { sections } = await compare(paths, "before", "after");
      expect(sections.map((s) => [s.branch, s.commits.map((c) => c.subject)])).toEqual([["main", ["agent work on main"]]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignoring whitespace never gives one file another file's patch", async () => {
    const { root, paths, run, put } = await repo();
    try {
      await put("b.txt", "b\n");
      await run("add", "-A");
      await run("commit", "-qm", "b");
      const before = await git(root, ["rev-parse", "HEAD"]);
      await put("a.txt", "1   \n");
      await put("b.txt", "b\nreal change\n");
      await run("commit", "-qam", "ws and real");
      const files = await diffTrees(root, before, "HEAD", { ignoreWhitespace: true });
      expect(files.map((f) => [f.path, f.patch.includes("diff --git a/" + f.path + " ")])).toEqual([
        ["a.txt", false],
        ["b.txt", true],
      ]);
      expect(files[0]!.patch).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeSpiceFor(root: string, branches: [name: string, base: string][]): Promise<void> {
  const blob = (data: unknown) => git(root, ["hash-object", "-w", "--stdin"], { stdin: JSON.stringify(data) });
  const entries = await Promise.all(branches.map(async ([name, base]) => `100644 blob ${await blob({ base: { name: base } })}\t${name}`));
  const tree = await git(root, ["mktree"], { stdin: entries.join("\n") + "\n" });
  const rootTree = await git(root, ["mktree"], { stdin: `100644 blob ${await blob({ trunk: "main" })}\trepo\n040000 tree ${tree}\tbranches\n` });
  await git(root, ["update-ref", "refs/spice/data", await git(root, ["commit-tree", rootTree, "-m", "spice"])]);
}

test("harness events get readable turn labels instead of their markup", () => {
  expect(promptLabel('<task-notification>\n<task-id>x</task-id>\n<summary>Agent "Build UI" finished</summary>\n</task-notification>')).toBe('(background) Agent "Build UI" finished');
  expect(promptLabel('<agent-message from="ui-builder">\n[Subagent hand-back] ...')).toBe("(message from ui-builder)");
  expect(promptLabel("  add g to feat-b  ")).toBe("add g to feat-b");
});
