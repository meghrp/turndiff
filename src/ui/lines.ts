import type { FileDiffMetadata } from "@pierre/diffs";
import type { Anchor, Comment, FileChange, Oid, Side } from "../model.ts";

// Comments key on (side, path, blob): a comment shows wherever that exact
// content is diffed on that side, whichever view it was written in.
const sideKey = (side: Side, path: string, blob: Oid) => `${side}\0${path}\0${blob}`;

export function indexComments(comments: Comment[]): Map<string, Comment[]> {
  const index = new Map<string, Comment[]>();
  for (const c of comments) {
    const k = sideKey(c.anchor.side, c.anchor.path, c.anchor.blob);
    index.set(k, [...(index.get(k) ?? []), c]);
  }
  return index;
}

export function commentsFor(index: Map<string, Comment[]>, f: FileChange): Comment[] {
  const out: Comment[] = [];
  if (f.newBlob) out.push(...(index.get(sideKey("new", f.path, f.newBlob)) ?? []));
  if (f.oldBlob) out.push(...(index.get(sideKey("old", f.oldPath ?? f.path, f.oldBlob)) ?? []));
  return out;
}

export const anchorKey = (a: Anchor) => `${a.side}:${a.path}:${a.blob}:${a.start}-${a.end}`;

export const toSide = (s: "additions" | "deletions" | undefined): Side => (s === "deletions" ? "old" : "new");
export const toPierreSide = (s: Side) => (s === "old" ? ("deletions" as const) : ("additions" as const));

/** Line number -> text for one side of a parsed (possibly partial) diff. */
function sideLines(fd: FileDiffMetadata, side: Side): Map<number, string> {
  const src = side === "new" ? fd.additionLines : fd.deletionLines;
  const out = new Map<number, string>();
  if (!fd.isPartial) {
    src.forEach((t, i) => out.set(i + 1, t));
    return out;
  }
  for (const h of fd.hunks) {
    let n = side === "new" ? h.additionStart : h.deletionStart;
    for (const c of h.hunkContent) {
      const count = c.type === "context" ? c.lines : side === "new" ? c.additions : c.deletions;
      const start = side === "new" ? c.additionLineIndex : c.deletionLineIndex;
      for (let i = 0; i < count; i++) out.set(n++, src[start + i] ?? "");
    }
  }
  return out;
}

export function lineTexts(fd: FileDiffMetadata, side: Side, start: number, end: number): string[] {
  const lines = sideLines(fd, side);
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push((lines.get(n) ?? "").replace(/\r?\n$/, ""));
  return out;
}

/** Whether line `n` of `side` falls inside a hunk, i.e. renders without expanding context. */
export function lineInHunks(fd: FileDiffMetadata, side: Side, n: number): boolean {
  return fd.hunks.some((h) => {
    const start = side === "new" ? h.additionStart : h.deletionStart;
    const count = side === "new" ? h.additionCount : h.deletionCount;
    return n >= start && n < start + count;
  });
}

export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}
