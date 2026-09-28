// One review per worktree: every comment across every branch and view, the
// summary, and viewed marks. The server process is the only writer, so the
// in-memory copy is authoritative and each change is persisted atomically.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, type RepoPaths } from "../git/exec.ts";
import type { Stack } from "../git/stack.ts";
import type { Comment, Decision, ReviewState } from "../model.ts";

interface Stored {
  comments: Comment[];
  summary: string;
  viewed: string[];
  lastReview: { at: string; snapshot: string } | null;
}

export class ReviewStore {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly paths: RepoPaths,
    private data: Stored,
  ) {}

  static async open(paths: RepoPaths): Promise<ReviewStore> {
    const file = reviewFile(paths);
    const empty: Stored = { comments: [], summary: "", viewed: [], lastReview: null };
    const data = existsSync(file) ? { ...empty, ...(JSON.parse(await readFile(file, "utf8")) as Partial<Stored>) } : empty;
    return new ReviewStore(paths, data);
  }

  get comments(): readonly Comment[] {
    return this.data.comments;
  }

  get summary(): string {
    return this.data.summary;
  }

  get lastReview(): Stored["lastReview"] {
    return this.data.lastReview;
  }

  async state(stack: Stack): Promise<ReviewState> {
    const outdated = await outdatedComments(this.paths, stack, this.data.comments);
    return { comments: this.data.comments, summary: this.data.summary, viewed: this.data.viewed, outdated: [...outdated] };
  }

  upsertComment(comment: Comment): Promise<void> {
    const rest = this.data.comments.filter((c) => c.id !== comment.id);
    this.data = { ...this.data, comments: [...rest, comment] };
    return this.persist();
  }

  deleteComment(id: string): Promise<void> {
    this.data = { ...this.data, comments: this.data.comments.filter((c) => c.id !== id) };
    return this.persist();
  }

  setViewed(key: string, viewed: boolean): Promise<void> {
    const rest = this.data.viewed.filter((k) => k !== key);
    this.data = { ...this.data, viewed: viewed ? [...rest, key] : rest };
    return this.persist();
  }

  setSummary(summary: string): Promise<void> {
    this.data = { ...this.data, summary };
    return this.persist();
  }

  /** Archive the submitted review and start a fresh one. Viewed marks stay: they follow content. */
  async submitted(entry: { decision: Decision; markdown: string; snapshot: string }): Promise<void> {
    const at = new Date().toISOString();
    const dir = join(this.paths.gitDir, "turndiff", "history");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ at, ...entry, comments: this.data.comments, summary: this.data.summary }, null, 2));
    this.data = { ...this.data, comments: [], summary: "", lastReview: { at, snapshot: entry.snapshot } };
    return this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writes = this.writes.then(async () => {
      const file = reviewFile(this.paths);
      await mkdir(join(file, ".."), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, file);
    });
    return this.writes;
  }
}

function reviewFile(paths: RepoPaths): string {
  return join(paths.gitDir, "turndiff", "review.json");
}

/**
 * Comments whose new-side content is gone from their branch: neither at its tip
 * nor, for the checked-out branch, on disk. Old-side anchors point at removed
 * code and never go stale.
 */
export async function outdatedComments(paths: RepoPaths, stack: Stack, comments: readonly Comment[]): Promise<Set<string>> {
  const tips = new Map(stack.branches.map((b) => [b.name, b.tip]));
  const live = comments.filter((c) => c.anchor.side === "new" && c.origin.branch !== null && tips.has(c.origin.branch));
  const found = new Set<string>();
  if (live.length > 0) {
    const out = await git(paths.root, ["cat-file", "--batch-check=%(objectname)"], { stdin: live.map((c) => `${tips.get(c.origin.branch!)}:${c.anchor.path}`).join("\n") + "\n" });
    out.split("\n").forEach((line, i) => line === live[i]!.anchor.blob && found.add(live[i]!.id));
  }
  const onDisk = live.filter((c) => !found.has(c.id) && c.origin.branch === stack.worktree.branch && existsSync(join(paths.root, c.anchor.path)));
  if (onDisk.length > 0) {
    const out = await git(paths.root, ["hash-object", "--stdin-paths"], { stdin: onDisk.map((c) => c.anchor.path).join("\n") + "\n" });
    out.split("\n").forEach((oid, i) => oid === onDisk[i]!.anchor.blob && found.add(onDisk[i]!.id));
  }
  return new Set(live.filter((c) => !found.has(c.id)).map((c) => c.id));
}
