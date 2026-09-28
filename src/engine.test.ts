import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { git, repoPaths, type RepoPaths } from "./git/exec.ts";
import { snapshotWorktree } from "./git/diff.ts";
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
    await store.upsertComment(comment("c2", "feat-b", "feat_b.py", featB, 4));
    await store.upsertComment(comment("c1", "feat-a", "feat_a.py", featA, 3));

    const reopened = await ReviewStore.open(paths);
    const state = await reopened.state(stack);
    expect(state.comments.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    // feat-b is checked out and feat_b.py has uncommitted edits, so its committed-content comment is stale.
    expect(state.outdated).toEqual(["c2"]);

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
