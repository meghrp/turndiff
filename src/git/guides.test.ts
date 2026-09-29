import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, repoPaths, type RepoPaths } from "./exec.ts";
import { checkGuide, guidesVersion, readGuides, removeGuide, writeGuide } from "./guides.ts";
import { buildScenario, type Scenario } from "../scenario.ts";
import type { Guide, GuideInput } from "../model.ts";

let sc: Scenario;
let paths: RepoPaths;

beforeAll(async () => {
  sc = await buildScenario();
  paths = await repoPaths(sc.root);
  // feat-b is checked out. Editing feat_a.py makes it a modified file of feat-b's
  // working diff (with an old side), and makes the disk differ from feat-a's tip.
  await writeFile(join(sc.root, "feat_a.py"), "a1\nA2\na3\na4\n");
});

afterAll(async () => {
  await rm(sc.root, { recursive: true, force: true });
});

const rev = (spec: string) => git(sc.root, ["rev-parse", spec]);
const section = (title: string, ...paths: string[]) => ({ title, overview: `${title} overview`, files: paths.map((path) => ({ path, summary: `${path} summary` })) });

async function ok(branch: string, input: GuideInput): Promise<{ guide: Guide; warnings: string[] }> {
  const r = await checkGuide(paths, branch, input);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return { guide: r.guide, warnings: r.warnings };
}

describe("blobs", () => {
  test("the checked-out branch's new side is the file on disk, its old side the branch base", async () => {
    const { guide, warnings } = await ok("feat-b", {
      author: "claude",
      intent: "Add h.",
      sections: [section("Functions", "feat_b.py", "feat_a.py"), section("Scratch", "notes.md")],
      annotations: [
        { path: "feat_b.py", lines: [7, 8], summary: "h only exists on disk" },
        { path: "feat_a.py", side: "old", lines: [2, 2], summary: "the old a2", rationale: "renamed to A2" },
      ],
    });
    expect(warnings).toEqual([]);
    const diskFeatB = await git(sc.root, ["hash-object", "feat_b.py"]);
    expect(diskFeatB).not.toBe(await rev("feat-b:feat_b.py"));
    expect(guide.sections[0]!.files.map((f) => [f.path, f.blob])).toEqual([
      ["feat_b.py", diskFeatB],
      ["feat_a.py", await git(sc.root, ["hash-object", "feat_a.py"])],
    ]);
    expect(guide.sections[1]!.files[0]!.blob).toBe(await git(sc.root, ["hash-object", "notes.md"]));
    expect(guide.annotations.map((a) => a.anchor)).toEqual([
      { path: "feat_b.py", side: "new", start: 7, end: 8, blob: diskFeatB },
      { path: "feat_a.py", side: "old", start: 2, end: 2, blob: await rev("feat-a:feat_a.py") },
    ]);
    expect(guide.annotations[1]!.rationale).toBe("renamed to A2");
    expect(guide.head).toBe(await rev("feat-b"));
    expect(guide.author).toBe("claude");
  });

  test("a branch that is not checked out uses its tip, even when the disk has other content", async () => {
    const { guide } = await ok("feat-a", {
      intent: "Add a3.",
      sections: [section("List", "feat_a.py")],
      annotations: [{ path: "feat_a.py", lines: [3, 3], summary: "a3" }],
    });
    const tip = await rev("feat-a:feat_a.py");
    expect(guide.sections[0]!.files[0]!.blob).toBe(tip);
    expect(guide.annotations[0]!.anchor.blob).toBe(tip);
    expect(guide.author).toBeNull();
  });
});

describe("validation", () => {
  test("reports every error at once", async () => {
    const r = await checkGuide(paths, "feat-b", {
      intent: "",
      extra: 1,
      sections: [
        section("One", "feat_b.py", "nope.py"),
        { title: "Two", overview: "o", files: [{ path: "feat_b.py", summary: "again" }, { path: "notes.md" }] },
      ],
      annotations: [
        { path: "missing.py", lines: [1, 1], summary: "s" },
        { path: "feat_b.py", lines: [8, 9], summary: "past the end" },
        { path: "notes.md", side: "old", lines: [1, 1], summary: "added file" },
        { path: "feat_b.py", lines: [3, 2], summary: "backwards" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors).toEqual([
      "extra: unknown field (expected author, intent, sections, annotations)",
      "intent: expected a non-empty string",
      "sections[1].files[1].summary: expected a non-empty string",
      "annotations[3].lines: expected [start, end], 1-based with start <= end",
      "sections[0].files[1]: nope.py is not changed on feat-b",
      'sections[1].files[0]: feat_b.py is already placed in sections[0] ("One")',
      "annotations[0]: missing.py is not changed on feat-b",
      'annotations[2]: notes.md has no old side on feat-b (it is added); use side "new"',
      "annotations[1]: lines 8-9 are outside feat_b.py, which has 8 lines on the new side",
    ]);
  });

  test("the trunk and unknown branches are refused", async () => {
    const input = { intent: "x", sections: [section("S", "a.txt")] };
    expect(await checkGuide(paths, "main", input)).toEqual({ ok: false, errors: ["main is the trunk, which has no parent to diff against; pass --branch with a stack branch"] });
    expect(await checkGuide(paths, "nope", input)).toEqual({ ok: false, errors: ["nope is not a branch of this stack"] });
  });

  test("files no section places are a warning, not an error", async () => {
    const r = await checkGuide(paths, "feat-b", { intent: "x", sections: [section("S", "feat_b.py")] });
    expect(r.ok && r.warnings).toEqual(['2 changed files are in no section and will be listed under "Everything else": feat_a.py, notes.md']);
  });
});

describe("anchors come from the branch diff", () => {
  let other: Scenario;
  let otherPaths: RepoPaths;
  beforeAll(async () => {
    other = await buildScenario();
    otherPaths = await repoPaths(other.root);
    // On feat-b's worktree: rename feat_a.py (a1 a2 a3 at the base) with an edit, and add a symlink.
    await rm(join(other.root, "feat_a.py"));
    await writeFile(join(other.root, "renamed.py"), "a1\na2\na3\na4\n");
    await writeFile(join(other.root, "target.txt"), "t1\nt2\nt3\n");
    await symlink("target.txt", join(other.root, "link.txt"));
  });
  afterAll(() => rm(other.root, { recursive: true, force: true }));

  const note = (path: string, side: "old" | "new", lines: [number, number]) => ({ path, side, lines, summary: "s" });
  const check = (annotations: ReturnType<typeof note>[]) => checkGuide(otherPaths, "feat-b", { intent: "x", sections: [section("S", "feat_b.py")], annotations });

  test("an old-side note on a renamed file takes the new or the old path and anchors at the old path", async () => {
    const r = await check([note("renamed.py", "old", [2, 2]), note("feat_a.py", "old", [3, 3]), note("renamed.py", "new", [4, 4])]);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const base = await git(other.root, ["rev-parse", "feat-a:feat_a.py"]);
    expect(r.guide.annotations.map((a) => a.anchor)).toEqual([
      { path: "feat_a.py", side: "old", start: 2, end: 2, blob: base },
      { path: "feat_a.py", side: "old", start: 3, end: 3, blob: base },
      { path: "renamed.py", side: "new", start: 4, end: 4, blob: await git(other.root, ["hash-object", "renamed.py"]) },
    ]);
  });

  test("a note on a symlink anchors to the link's own blob and counts the link's lines", async () => {
    const linkBlob = await git(other.root, ["hash-object", "--stdin"], { stdin: "target.txt" });
    const r = await check([note("link.txt", "new", [1, 1])]);
    expect(r.ok && r.guide.annotations[0]!.anchor.blob).toBe(linkBlob);
    expect(await check([note("link.txt", "new", [1, 3])])).toEqual({ ok: false, errors: ["annotations[0]: lines 1-3 are outside link.txt, which has 1 line on the new side"] });
  });
});

describe("storage", () => {
  test("writing again replaces the branch's guide, and guidesVersion follows every change", async () => {
    expect(guidesVersion(paths)).toBe("");
    expect(await readGuides(paths)).toEqual([]);
    const first = (await ok("feat-c", { intent: "first", sections: [section("S", "feat_c.py")] })).guide;
    await writeGuide(paths, first);
    const v1 = guidesVersion(paths);
    expect(v1).not.toBe("");
    const second = (await ok("feat-c", { intent: "second", sections: [section("S", "feat_c.py")] })).guide;
    await writeGuide(paths, second);
    const v2 = guidesVersion(paths);
    expect(v2).not.toBe(v1);
    await writeGuide(paths, (await ok("feat-a", { intent: "a", sections: [section("S", "feat_a.py")] })).guide);
    expect((await readGuides(paths)).map((g) => [g.branch, g.intent])).toEqual([
      ["feat-a", "a"],
      ["feat-c", "second"],
    ]);
    expect(guidesVersion(paths)).not.toBe(v2);
    expect(await removeGuide(paths, "feat-c")).toBe(true);
    expect(await removeGuide(paths, "feat-c")).toBe(false);
    expect((await readGuides(paths)).map((g) => g.branch)).toEqual(["feat-a"]);
    expect(await removeGuide(paths, "feat-a")).toBe(true);
    expect(guidesVersion(paths)).toBe("");
  });

  test("branch names with slashes get their own file", async () => {
    await git(sc.root, ["branch", "team/x", "feat-a"]);
    const guide: Guide = { branch: "team/x", author: null, writtenAt: "2026-01-01T00:00:00Z", head: await rev("team/x"), intent: "i", sections: [], annotations: [] };
    await writeGuide(paths, guide);
    expect(await readGuides(paths)).toEqual([guide]);
    expect(await removeGuide(paths, "team/x")).toBe(true);
  });
});

describe("turndiff guide", () => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const run = async (args: string[], stdin?: string) => {
    const proc = Bun.spawn(["bun", cli, "guide", ...args], { cwd: sc.root, stdin: stdin === undefined ? "ignore" : new Response(stdin), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };

  test("stores a guide from stdin for the checked-out branch and prints one summary line, then warnings", async () => {
    const input = { intent: "x", sections: [section("S", "feat_b.py")], annotations: [{ path: "feat_b.py", lines: [1, 2], summary: "f" }] };
    const r = await run([], JSON.stringify(input));
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'guide for feat-b: 1 section, 1 of 3 files placed, 1 annotation\nwarning: 2 changed files are in no section and will be listed under "Everything else": feat_a.py, notes.md\n',
    );
    expect((await readGuides(paths)).map((g) => g.branch)).toEqual(["feat-b"]);
  });

  test("reads a file for another branch, and --remove drops the guide", async () => {
    const file = join(sc.root, "..", `guide-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({ intent: "x", sections: [section("S", "feat_c.py")] }));
    const r = await run([file, "--branch", "feat-c"]);
    expect([r.code, r.out]).toEqual([0, "guide for feat-c: 1 section, 1 of 1 file placed, 0 annotations\n"]);
    await rm(file);
    expect((await run(["--remove", "--branch", "feat-c"])).out).toBe("removed the guide for feat-c\n");
    expect((await readGuides(paths)).map((g) => g.branch)).toEqual(["feat-b"]);
  });

  test("exits 1 listing every error and stores nothing", async () => {
    const before = guidesVersion(paths);
    const r = await run([], JSON.stringify({ intent: "x", sections: [section("S", "nope.py")], annotations: [{ path: "feat_b.py", lines: [99, 99], summary: "s" }] }));
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "turndiff guide: 2 problems, nothing stored:\n  sections[0].files[0]: nope.py is not changed on feat-b\n  annotations[0]: lines 99-99 are outside feat_b.py, which has 8 lines on the new side\n",
    );
    expect(guidesVersion(paths)).toBe(before);
    expect((await run([], "{not json")).err).toStartWith("turndiff guide: the input is not valid JSON");
  });

  test("--help prints the input format", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"annotations"');
    expect(r.out).toContain("2 to 6 sections");
  });
});
