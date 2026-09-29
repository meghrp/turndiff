import type { FileDiffMetadata } from "@pierre/diffs";
import type { Anchor, Annotation, Guide, Section, Side, View } from "../model.ts";
import { firstChangedLine, lineInHunks } from "./lines.ts";
import type { FileEntry } from "./FileCard.tsx";

export const EVERYTHING_ELSE = "Everything else";

/** An author's note as the UI shows it: the annotation plus who wrote its guide. */
export type Note = Annotation & { author: string | null };

/** Guide cards and guided order apply where a section is a branch's whole diff. */
export const showsGuides = (view: View) => view.target.kind === "branch" || view.target.kind === "stack";

export function guideFor(view: View, section: Section, guides: Map<string, Guide>): Guide | null {
  return showsGuides(view) && section.branch ? (guides.get(section.branch) ?? null) : null;
}

/**
 * The files of a view in reading order. With `guided`, a section whose branch
 * has a guide lists the guide's files section by section, then the rest under
 * "Everything else"; `group` marks the first entry of each group.
 */
export function viewEntries(view: View, guides: Map<string, Guide>, guided: boolean): FileEntry[] {
  return view.sections.flatMap((section) => {
    const plain: FileEntry[] = section.files.map((file) => ({ key: `${section.id}\0${file.path}`, section, file, group: null }));
    const guide = guided ? guideFor(view, section, guides) : null;
    if (!guide) return plain;
    const rest = new Map(plain.map((e) => [e.file.path, e]));
    const out: FileEntry[] = [];
    const take = (entries: FileEntry[], title: string, overview: string | null) =>
      entries.forEach((e, i) => {
        rest.delete(e.file.path);
        out.push({ ...e, group: i === 0 ? { title, overview } : null });
      });
    for (const s of guide.sections) take(s.files.flatMap((f) => rest.get(f.path) ?? []), s.title, s.overview);
    take([...rest.values()], EVERYTHING_ELSE, null);
    return out;
  });
}

export const guideNotes = (guides: Guide[]): Note[] => guides.flatMap((g) => g.annotations.map((a) => ({ ...a, author: g.author })));

/**
 * The line pierre renders a note below, so the note sits just above the first
 * changed line of its range. 0 pins it to the top of the file.
 */
export function noteLine(fd: FileDiffMetadata, a: Anchor): number {
  const above = (firstChangedLine(fd, a.side, a.start, a.end) ?? a.start) - 1;
  if (above >= 1 && lineInHunks(fd, a.side, above)) return above;
  if (a.start === 1) return 0;
  return lineInHunks(fd, a.side, a.end) ? a.end : 0;
}

export interface HunkStart {
  /** Index of the hunk in its file. */
  index: number;
  /** The hunk's first changed line. */
  side: Side;
  line: number;
  /** Diff rows above that line in unified layout, counting from the file's first hunk. */
  rowsBefore: number;
}

/** Each `@@` hunk of a unified patch, by its first changed line. */
export function patchHunks(patch: string): HunkStart[] {
  const out: HunkStart[] = [];
  let oldN = 0;
  let newN = 0;
  let rows = 0;
  let pending = false;
  for (const l of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      oldN = Number(m[1]);
      newN = Number(m[2]);
      pending = true;
      continue;
    }
    if (out.length === 0 && !pending) continue;
    const c = l[0];
    if (c === " ") {
      oldN++;
      newN++;
    } else if (c === "-" || c === "+") {
      if (pending) out.push({ index: out.length, side: c === "-" ? "old" : "new", line: c === "-" ? oldN : newN, rowsBefore: rows });
      pending = false;
      if (c === "-") oldN++;
      else newN++;
    } else continue;
    rows++;
  }
  return out;
}
