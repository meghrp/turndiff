import { expect, test } from "bun:test";
import { draftKey, emptyReview, reconcileReview } from "./reviewState.ts";
import type { DiffResponse, ReviewComment } from "../shared.ts";
const patch = (name: string, hash: string) =>
  `diff --git a/${name} b/${name}\nindex aaaaaaa..${hash} 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;
const diff = (a: string): DiffResponse => ({
  scope: { kind: "branch", name: "feature", worktree: true },
  baseOid: "base",
  headOid: "head",
  label: "feature",
  replay: null,
  files: [],
  patch: patch("a.ts", a) + patch("b.ts", "bbbbbbb"),
});
const comment: ReviewComment = {
  id: "1",
  file: "a.ts",
  side: "additions",
  lineStart: 1,
  lineEnd: 1,
  body: "Check this",
  snippet: ["original code"],
  createdAt: "now",
};
test("changed files reopen and comments retain original context; unchanged files stay viewed", () => {
  const initial = reconcileReview(emptyReview(), diff("ccccccc"));
  const next = reconcileReview(
    { ...initial, viewed: ["a.ts", "b.ts"], comments: [comment], drafts: [{ ...comment, body: "unfinished" }] },
    diff("ddddddd"),
  );
  expect(next.viewed).toEqual(["b.ts"]);
  expect(next.comments[0]).toMatchObject({ outdated: true, contextConfirmed: false, snippet: ["original code"] });
  expect(next.drafts[0]?.body).toBe("unfinished");
  expect(next.drafts[0]?.outdated).toBe(true);
});
test("new commit IDs with identical content do not invalidate review progress", () => {
  const initial = reconcileReview(emptyReview(), diff("ccccccc"));
  const next = reconcileReview({ ...initial, viewed: ["a.ts"], comments: [comment] }, { ...diff("ccccccc"), headOid: "another-commit" });
  expect(next.viewed).toEqual(["a.ts"]);
  expect(next.comments[0]?.outdated).toBeUndefined();
});
test("removed files do not inflate progress and their comments remain recoverable", () => {
  const initial = reconcileReview(emptyReview(), diff("ccccccc"));
  const next = reconcileReview(
    { ...initial, viewed: ["a.ts"], comments: [comment] },
    { ...diff("ccccccc"), patch: patch("b.ts", "bbbbbbb") },
  );
  expect(next.viewed).toEqual([]);
  expect(next.comments[0]?.outdated).toBe(true);
});
test("drafts are isolated by file, side, range and edited comment", () => {
  expect(draftKey(comment)).not.toBe(draftKey({ ...comment, side: "deletions" }));
  expect(draftKey(comment)).not.toBe(draftKey({ ...comment, editingId: "1" }));
});
