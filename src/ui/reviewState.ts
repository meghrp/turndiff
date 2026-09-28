import { parsePatchFiles } from "@pierre/diffs";
import type { DiffResponse, ReviewDraft, ReviewState } from "../shared.ts";

export const emptyReview = (): ReviewState => ({ comments: [], drafts: [], viewed: [], summary: "", files: {}, updatedAt: 0 });
export function draftKey(d: Pick<ReviewDraft, "file" | "side" | "lineStart" | "lineEnd" | "editingId">): string {
  return JSON.stringify([d.file, d.side, d.lineStart, d.lineEnd, d.editingId ?? null]);
}
export function fileIdentities(diff: DiffResponse): Record<string, string> {
  return Object.fromEntries(
    parsePatchFiles(diff.patch)
      .flatMap((p) => p.files)
      .map((f) => [f.name, JSON.stringify([f.prevName, f.prevObjectId, f.newObjectId, f.mode, f.prevMode, f.type])]),
  );
}
export function reconcileReview(review: ReviewState, diff: DiffResponse): ReviewState {
  const files = fileIdentities(diff);
  const changed = (path: string) => review.files[path] !== files[path] || !files[path];
  return {
    ...review,
    files,
    viewed: review.viewed.filter((path) => !changed(path)),
    comments: review.comments.map((c) => (changed(c.file) ? { ...c, outdated: true, contextConfirmed: false } : c)),
    drafts: review.drafts.map((d) => (changed(d.file) ? { ...d, outdated: true, contextConfirmed: false } : d)),
  };
}
