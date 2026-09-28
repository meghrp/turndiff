import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReview, writeReview } from "./reviews.ts";
import { emptyReview } from "../ui/reviewState.ts";

test("repository drafts survive a new reader, reject late saves and isolate worktrees/scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "turndiff-review-test-"));
  const paths = { root, commonDir: root, gitDir: root };
  const scope = { kind: "branch" as const, name: "feature", worktree: true };
  try {
    await Promise.all([
      writeReview(paths, scope, { ...emptyReview(), summary: "newer text", updatedAt: 20 }),
      writeReview(paths, scope, { ...emptyReview(), summary: "old late request", updatedAt: 10 }),
    ]);
    expect((await readReview({ ...paths }, scope))?.summary).toBe("newer text");
    expect(await readReview(paths, { ...scope, worktree: false })).toBeNull();
    expect(await readReview({ ...paths, root: `${root}/other-worktree` }, scope)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
