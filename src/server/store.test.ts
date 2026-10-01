import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoPaths, type RepoPaths } from "../git/exec.ts";
import { snapshotWorktree } from "../git/diff.ts";
import { loadStack } from "../git/stack.ts";
import type { Comment } from "../model.ts";
import { outdatedComments, ReviewStore } from "./store.ts";

async function withStore(run: (store: ReviewStore, paths: RepoPaths) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "turndiff-store-test-"));
  try {
    await git(root, ["init", "-qb", "main"]);
    const paths = await repoPaths(root);
    await run(await ReviewStore.open(paths), paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const comment = (id: string, body: string): Comment => ({
  id,
  body,
  anchor: { path: "x", side: "new", start: 1, end: 1, blob: "1".repeat(40) },
  snippet: ["x"],
  origin: { branch: "topic", head: "2".repeat(40), working: false, target: { kind: "working" } },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

test("comment freshness handles literal quotes, newlines, and symlink contents", () =>
  withStore(async (_store, paths) => {
    await Bun.write(join(paths.root, "base"), "base\n");
    await git(paths.root, ["add", "base"]);
    await git(paths.root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]);
    const names = ['"quoted".txt', "line\nbreak.txt", "link"];
    await Bun.write(join(paths.root, names[0]!), "quoted\n");
    await Bun.write(join(paths.root, names[1]!), "newline\n");
    await symlink("missing-target", join(paths.root, "link"));
    const snap = await snapshotWorktree(paths);
    const stack = await loadStack(paths, []);
    const comments = await Promise.all(
      names.map(async (path) => {
        const c = comment(path, "fresh");
        c.origin.branch = "main";
        c.anchor.path = path;
        c.anchor.blob = await git(paths.root, ["rev-parse", `${snap}:${path}`]);
        return c;
      }),
    );
    expect(await outdatedComments(paths, stack, comments)).toEqual(new Set());
    await rm(join(paths.root, "link"));
    await symlink("changed-target", join(paths.root, "link"));
    await Bun.write(join(paths.root, names[1]!), "changed\n");
    expect(await outdatedComments(paths, stack, comments)).toEqual(new Set([names[1]!, "link"]));
  }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function archives(paths: RepoPaths) {
  const dir = join(paths.gitDir, "turndiff", "history");
  return Promise.all(
    (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as { comments: Comment[]; summary: string; markdown: string }),
  );
}

test("a failed disk save preserves committed memory and later saves recover", () =>
  withStore(async (store, paths) => {
    await store.setSummary("saved");
    const obstruction = join(paths.gitDir, "turndiff", `review.json.${process.pid}.tmp`);
    await mkdir(obstruction);
    await expect(store.setSummary("failed")).rejects.toThrow();
    expect(store.summary).toBe("saved");
    await rm(obstruction, { recursive: true });
    await store.setSummary("retried");
    expect((await ReviewStore.open(paths)).summary).toBe("retried");
  }));

test("edits arriving during submission survive in the next review and history matches the sent draft", () =>
  withStore(async (store, paths) => {
    await store.upsertComment(comment("edit", "before edit"));
    await store.upsertComment(comment("delete", "before delete"));
    await store.setViewed("viewed-file", true);
    const started = deferred();
    const finish = deferred();
    const submitting = store.submit({ decision: "comment", summary: "submitted summary" }, async (draft) => {
      started.resolve();
      await finish.promise;
      const markdown = `${draft.summary}\n${draft.comments.map((c) => c.body).join("\n")}`;
      draft.comments[0]!.body = "callback mutation";
      return { markdown, snapshot: "snapshot-1" };
    });
    await started.promise;
    const changes = [
      store.upsertComment(comment("late", "late comment")),
      store.upsertComment(comment("edit", "after edit")),
      store.deleteComment("delete"),
      store.upsertComment(comment("delete", "recreated")),
      store.setSummary("next summary"),
    ];
    finish.resolve();
    const submitted = await submitting;
    await Promise.all(changes);
    expect(submitted.markdown).toBe("submitted summary\nbefore edit\nbefore delete");
    const [history] = await archives(paths);
    expect(history!.comments.map((c) => c.body)).toEqual(["before edit", "before delete"]);
    expect(history!.markdown).toBe(submitted.markdown);
    const reopened = await ReviewStore.open(paths);
    expect(reopened.comments.map((c) => c.body)).toEqual(["late comment", "after edit", "recreated"]);
    expect(reopened.summary).toBe("next summary");
    expect(JSON.parse(await readFile(join(paths.gitDir, "turndiff", "review.json"), "utf8")).viewed).toEqual(["viewed-file"]);
  }));

test("failed preparation retains submitted summary and queued writes still succeed", () =>
  withStore(async (store, paths) => {
    await store.upsertComment(comment("one", "kept"));
    await expect(
      store.submit({ decision: "comment", summary: "keep this too" }, async () => {
        throw new Error("snapshot failed");
      }),
    ).rejects.toThrow("snapshot failed");
    expect(store.lastReview).toBeNull();
    expect((await ReviewStore.open(paths)).summary).toBe("keep this too");
    await store.upsertComment(comment("two", "after failure"));
    expect(store.comments.map((c) => c.body)).toEqual(["kept", "after failure"]);
  }));

test("failed clearing keeps the draft and last-review checkpoint until a successful retry", () =>
  withStore(async (store, paths) => {
    await store.upsertComment(comment("one", "kept"));
    const obstruction = join(paths.gitDir, "turndiff", `review.json.${process.pid}.tmp`);
    await expect(
      store.submit({ decision: "comment" }, async () => {
        await mkdir(obstruction);
        return { markdown: "kept", snapshot: "failed-snapshot" };
      }),
    ).rejects.toThrow();
    expect(store.comments.map((c) => c.body)).toEqual(["kept"]);
    expect(store.lastReview).toBeNull();
    expect((await ReviewStore.open(paths)).comments.map((c) => c.body)).toEqual(["kept"]);
    await rm(obstruction, { recursive: true });
    await store.submit({ decision: "comment" }, async () => ({ markdown: "kept", snapshot: "retry-snapshot" }));
    expect((await ReviewStore.open(paths)).comments).toEqual([]);
    expect(store.lastReview!.snapshot).toBe("retry-snapshot");
  }));

test("queued submissions use the summary committed before their own turn", () =>
  withStore(async (store, paths) => {
    const submissions = [1, 2].map((n) => {
      const saved = store.setSummary(`summary-${n}`);
      const sent = store.submit({ decision: "comment" }, async (draft) => ({ markdown: draft.summary, snapshot: `snapshot-${n}` }));
      return Promise.all([saved, sent]).then(([, result]) => result.markdown);
    });
    expect(await Promise.all(submissions)).toEqual(["summary-1", "summary-2"]);
    expect((await archives(paths)).map((a) => a.summary)).toEqual(["summary-1", "summary-2"]);
  }));
