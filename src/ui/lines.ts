import type { FileDiffMetadata } from "@pierre/diffs";
import type { Anchor, FileChange, Oid, Side } from "../model.ts";

export const sideKey = (side: Side, path: string, blob: Oid) => `${side}\0${path}\0${blob}`;

/** Comments or notes by the file content they are anchored to. */
export function indexAnchored<T extends { anchor: Anchor }>(items: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const c of items) {
    const k = sideKey(c.anchor.side, c.anchor.path, c.anchor.blob);
    index.set(k, [...(index.get(k) ?? []), c]);
  }
  return index;
}

/** What `index` holds for either side of `f` as diffed here. */
export function anchoredTo<T>(index: Map<string, T[]>, f: FileChange): T[] {
  const out: T[] = [];
  if (f.newBlob) out.push(...(index.get(sideKey("new", f.path, f.newBlob)) ?? []));
  if (f.oldBlob) out.push(...(index.get(sideKey("old", f.oldPath ?? f.path, f.oldBlob)) ?? []));
  return out;
}

export const anchorKey = (a: Anchor) => `${a.side}:${a.path}:${a.blob}:${a.start}-${a.end}`;

export const toSide = (s: "additions" | "deletions" | undefined): Side => (s === "deletions" ? "old" : "new");
export const toPierreSide = (s: Side) => (s === "old" ? ("deletions" as const) : ("additions" as const));

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

/** The first added (new side) or removed (old side) line in start..end, or null when the range changes nothing. */
export function firstChangedLine(fd: FileDiffMetadata, side: Side, start: number, end: number): number | null {
  for (const h of fd.hunks) {
    let n = side === "new" ? h.additionStart : h.deletionStart;
    for (const c of h.hunkContent) {
      if (c.type === "context") {
        n += c.lines;
        continue;
      }
      const count = side === "new" ? c.additions : c.deletions;
      if (n + count > start && n <= end) return Math.max(n, start);
      n += count;
    }
  }
  return null;
}

export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}
