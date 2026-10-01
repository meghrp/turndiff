import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { renderMarkdown } from "./markdown.tsx";
import { noteLine, patchHunks, viewEntries } from "./guides.ts";
import type { Anchor, FileChange, Guide, Section, View } from "../model.ts";

describe("markdown", () => {
  test("renders markdown but never raw HTML", () => {
    expect(renderMarkdown("Uses **bold** and `code`.")).toBe("<p>Uses <strong>bold</strong> and <code>code</code>.</p>\n");
    const html = renderMarkdown('<script>fetch("/api/submit")</script>\n\nhi <img src=x onerror="alert(1)"> there');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;script&#62;");
  });

  test("links open in a new tab, and only http(s) and mailto links are links", () => {
    expect(renderMarkdown("[docs](https://example.com/a?b=1)", true)).toBe('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(renderMarkdown("[x](javascript:alert(1))", true)).toBe("x");
    expect(renderMarkdown("![alt](https://example.com/p.png)", true)).toBe("alt");
  });
});

const patch = (body: string) => `diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n${body}`;
const fd = (body: string) => parsePatchFiles(patch(body), "k")[0]!.files[0]!;
const anchor = (start: number, end: number, side: Anchor["side"] = "new"): Anchor => ({ path: "f", side, start, end, blob: "b" });

// Line 3 becomes two lines (new 3-4) and line 10 is removed.
const TWO_HUNKS = "@@ -1,6 +1,7 @@\n 1\n 2\n-3\n+3a\n+3b\n 4\n 5\n 6\n@@ -7,6 +8,5 @@\n 7\n 8\n 9\n-10\n 11\n 12\n";

describe("notes", () => {
  test("a note sits just above the first changed line of its range", () => {
    const f = fd(TWO_HUNKS);
    expect(noteLine(f, anchor(2, 4))).toBe(2);
    expect(noteLine(f, anchor(4, 4))).toBe(3);
    expect(noteLine(f, anchor(10, 11, "old"))).toBe(9);
  });

  test("falls back to the top at line 1, then below the range end, then the top", () => {
    const f = fd("@@ -1,2 +1,3 @@\n+0\n 1\n 2\n");
    expect(noteLine(f, anchor(1, 2))).toBe(0);
    expect(noteLine(fd(TWO_HUNKS), anchor(2, 2, "old"))).toBe(1);
    const far = fd("@@ -20,3 +20,4 @@\n 20\n+21\n 22\n 23\n");
    expect(noteLine(far, anchor(5, 21))).toBe(20);
    expect(noteLine(far, anchor(5, 8))).toBe(0);
    expect(noteLine(far, anchor(19, 20))).toBe(20);
  });
});

test("patchHunks finds each hunk's first changed line and the rows above it", () => {
  expect(patchHunks(patch(TWO_HUNKS))).toEqual([
    { index: 0, side: "old", line: 3, rowsBefore: 2 },
    { index: 1, side: "old", line: 10, rowsBefore: 11 },
  ]);
  expect(patchHunks(patch("@@ -0,0 +1,2 @@\n+a\n+b\n"))).toEqual([{ index: 0, side: "new", line: 1, rowsBefore: 0 }]);
});

test("guided order follows the guide's sections, then everything else, in branch and stack views only", () => {
  const file = (path: string) => ({ path, oldPath: null, status: "added", additions: 1, deletions: 0, binary: false, oldBlob: null, newBlob: "b", patch: "" }) as FileChange;
  const section: Section = { id: "branch:x", branch: "x", title: "x", base: "a", head: "b", commits: [], includesWorking: false, replay: null, files: ["a", "b", "c", "d"].map(file) };
  const guide: Guide = {
    branch: "x",
    author: null,
    writtenAt: "",
    head: "b",
    intent: "",
    sections: [
      { title: "Core", overview: "", files: [{ path: "c", summary: "", blob: "b" }, { path: "gone", summary: "", blob: "b" }] },
      { title: "Glue", overview: "", files: [{ path: "a", summary: "", blob: "b" }] },
    ],
    annotations: [],
  };
  const view = (kind: "branch" | "commits"): View => ({
    target: kind === "branch" ? { kind, branch: "x", working: false } : { kind, from: "a", to: "b" },
    title: "",
    sections: [section],
    notes: [],
    version: "",
  });
  const order = (v: View, guided: boolean) => viewEntries(v, new Map([["x", guide]]), guided).map((e) => [e.file.path, e.group?.title ?? null]);
  expect(order(view("branch"), true)).toEqual([
    ["c", "Core"],
    ["a", "Glue"],
    ["b", "Everything else"],
    ["d", null],
  ]);
  expect(order(view("branch"), false)).toEqual(["a", "b", "c", "d"].map((p) => [p, null]));
  expect(order(view("commits"), true)).toEqual(["a", "b", "c", "d"].map((p) => [p, null]));
});

test("type-change patches show both the removed file and the new symlink content", async () => {
  const { parseFileDiff } = await import("./FileCard.tsx");
  const file: FileChange = {
    path: "link", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false,
    oldBlob: "1".repeat(40), newBlob: "2".repeat(40), oldMode: "100644", newMode: "120000",
    patch: `diff --git a/link b/link\ndeleted file mode 100644\nindex ${"1".repeat(40)}..${"0".repeat(40)}\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-regular\ndiff --git a/link b/link\nnew file mode 120000\nindex ${"0".repeat(40)}..${"2".repeat(40)}\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n`,
  };
  const diff = parseFileDiff(file)!;
  expect(diff.deletionLines).toEqual(["regular\n"]);
  expect(diff.additionLines).toEqual(["target"]);
  expect(diff.hunks.map((h) => [h.deletionCount, h.additionCount])).toEqual([[1, 1]]);
});
