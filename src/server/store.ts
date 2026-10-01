// One review per worktree: every comment across every branch and view, the
// summary, and viewed marks. The server process is the only writer, so the
// in-memory copy is authoritative and each change is persisted atomically.

import { existsSync, lstatSync, readlinkSync } from "node:fs";
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

export type ReviewDraft = Pick<ReviewState, "comments" | "summary">;

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
    const data = this.data;
    const outdated = await outdatedComments(this.paths, stack, data.comments);
    return { comments: data.comments, summary: data.summary, viewed: data.viewed, outdated: [...outdated] };
  }

  draft(): ReviewDraft {
    return structuredClone({ comments: this.data.comments, summary: this.data.summary });
  }

  upsertComment(comment: Comment): Promise<void> {
    const saved = structuredClone(comment);
    return this.enqueue(() => this.persist({ ...this.data, comments: [...this.data.comments.filter((c) => c.id !== saved.id), saved] }));
  }

  deleteComment(id: string): Promise<void> {
    return this.enqueue(() => this.persist({ ...this.data, comments: this.data.comments.filter((c) => c.id !== id) }));
  }

  setViewed(key: string, viewed: boolean): Promise<void> {
    return this.enqueue(() => {
      const rest = this.data.viewed.filter((k) => k !== key);
      return this.persist({ ...this.data, viewed: viewed ? [...rest, key] : rest });
    });
  }

  setSummary(summary: string): Promise<void> {
    return this.enqueue(() => this.persist({ ...this.data, summary }));
  }

  /** Prepare and archive one draft atomically with respect to all review mutations. Later edits form the next review. */
  submit(
    request: { decision: Decision; summary?: string },
    prepare: (draft: ReviewDraft) => Promise<{ markdown: string; snapshot: string }>,
  ): Promise<{ markdown: string; submittedAt: string }> {
    return this.enqueue(async () => {
      if (request.summary !== undefined) await this.persist({ ...this.data, summary: request.summary });
      const draft = this.draft();
      const entry = await prepare(structuredClone(draft));
      const at = new Date().toISOString();
      const dir = join(this.paths.gitDir, "turndiff", "history");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${at.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ at, decision: request.decision, ...entry, ...draft }, null, 2));
      await rename(tmp, file);
      await this.persist({ ...this.data, comments: [], summary: "", lastReview: { at, snapshot: entry.snapshot } });
      return { markdown: entry.markdown, submittedAt: at };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  private async persist(next: Stored): Promise<void> {
    const file = reviewFile(this.paths);
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, file);
    this.data = next;
  }
}

function fileKind(path: string): "file" | "symlink" | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : null;
  } catch {
    return null;
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
  for (const branch of new Set(live.map((c) => c.origin.branch!))) {
    const comments = live.filter((c) => c.origin.branch === branch);
    const out = await git(paths.root, ["ls-tree", "-r", "-z", tips.get(branch)!, "--", ...new Set(comments.map((c) => c.anchor.path))]);
    const blobs = new Map(out.split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]!] as const;
    }));
    for (const c of comments) if (blobs.get(c.anchor.path) === c.anchor.blob) found.add(c.id);
  }
  const onDisk = live.filter((c) => !found.has(c.id) && c.origin.branch === stack.worktree.branch);
  const files = onDisk.filter((c) => fileKind(join(paths.root, c.anchor.path)) === "file");
  if (files.length > 0) {
    const out = await git(paths.root, ["hash-object", "--", ...files.map((c) => c.anchor.path)]);
    out.split("\n").forEach((oid, i) => oid === files[i]!.anchor.blob && found.add(files[i]!.id));
  }
  for (const c of onDisk.filter((c) => fileKind(join(paths.root, c.anchor.path)) === "symlink")) {
    const oid = await git(paths.root, ["hash-object", "--stdin"], { stdin: readlinkSync(join(paths.root, c.anchor.path)) });
    if (oid === c.anchor.blob) found.add(c.id);
  }
  return new Set(live.filter((c) => !found.has(c.id)).map((c) => c.id));
}
