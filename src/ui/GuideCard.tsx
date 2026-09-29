import { memo, useState } from "react";
import type { Guide, GuideFile } from "../model.ts";
import { EVERYTHING_ELSE } from "./guides.ts";
import { sideKey, splitPath } from "./lines.ts";
import { Markdown } from "./markdown.tsx";
import { ago } from "./names.tsx";
import { Chevron, fileViewedKey, StatusLetter, type FileEntry } from "./FileCard.tsx";

export interface GuideControls {
  collapsed: boolean;
  toggleCollapsed(): void;
  guided: boolean;
  toggleGuided(): void;
  notes: boolean;
  toggleNotes(): void;
}

/** The author's walkthrough of one branch, at the top of its section. */
export const GuideCard = memo(function GuideCard({
  guide,
  entries,
  viewed,
  controls,
  onFile,
}: {
  guide: Guide;
  /** The section's files. */
  entries: FileEntry[];
  viewed: Set<string>;
  controls: GuideControls;
  onFile(e: FileEntry): void;
}) {
  const byPath = new Map(entries.map((e) => [e.file.path, e]));
  const placed = new Set(guide.sections.flatMap((s) => s.files.map((f) => f.path)));
  const rest = entries.filter((e) => !placed.has(e.file.path));
  const diffed = new Set(entries.flatMap((e) => [e.file.newBlob && sideKey("new", e.file.path, e.file.newBlob), e.file.oldBlob && sideKey("old", e.file.oldPath ?? e.file.path, e.file.oldBlob)]));
  const staleNotes = guide.annotations.filter((a) => !diffed.has(sideKey(a.anchor.side, a.anchor.path, a.anchor.blob))).length;
  const { collapsed } = controls;
  return (
    <div className={`guide${collapsed ? " collapsed" : ""}`} data-guide={guide.branch}>
      <div className="guide-head">
        <button className="chev" aria-label={collapsed ? "Expand guide" : "Collapse guide"} aria-expanded={!collapsed} onClick={controls.toggleCollapsed}>
          <Chevron open={!collapsed} />
        </button>
        <span className="guide-label">Guide</span>
        <span className="dim" title={new Date(guide.writtenAt).toLocaleString()}>
          {guide.author ? `${guide.author} · ` : ""}
          {ago(guide.writtenAt)}
        </span>
        <span className="grow" />
        <button className={`toggle${controls.guided ? " on" : ""}`} aria-pressed={controls.guided} onClick={controls.toggleGuided} title="Files in the guide's order, or in tree order  g">
          guide order
        </button>
        <button className={`toggle${controls.notes ? " on" : ""}`} aria-pressed={controls.notes} onClick={controls.toggleNotes} title="Show the author's notes in the diff  a">
          notes
        </button>
      </div>
      {!collapsed && (
        <div className="guide-body">
          <Markdown className="guide-intent" text={guide.intent} />
          {guide.sections.map((s, i) => (
            <Group key={i} title={s.title} files={s.files.map((f) => ({ f, e: byPath.get(f.path) }))} viewed={viewed} onFile={onFile}>
              <Markdown className="guide-overview" text={s.overview} />
            </Group>
          ))}
          {rest.length > 0 && <Group title={EVERYTHING_ELSE} files={rest.map((e) => ({ f: null, e }))} viewed={viewed} onFile={onFile} />}
          {staleNotes > 0 && (
            <div className="guide-stale">
              {staleNotes === 1 ? "1 note is" : `${staleNotes} notes are`} on code that has changed since
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** File rows a group shows before "Show N more files", so a large guide does not push the diff far down. */
const GROUP_ROWS = 8;

function Group({
  title,
  files,
  viewed,
  onFile,
  children,
}: {
  title: string;
  files: { f: GuideFile | null; e: FileEntry | undefined }[];
  viewed: Set<string>;
  onFile(e: FileEntry): void;
  children?: React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all || files.length <= GROUP_ROWS + 2 ? files : files.slice(0, GROUP_ROWS);
  const present = files.flatMap(({ e }) => (e ? [e] : []));
  const done = present.filter((e) => viewed.has(fileViewedKey(e))).length;
  return (
    <div className="guide-group">
      <div className="guide-group-head">
        <span className="guide-group-title">{title}</span>
        <span className="grow" />
        <span className="dim">
          {done}/{present.length} viewed
        </span>
      </div>
      {children}
      <div className="guide-files">
        {shown.map(({ f, e }) => {
          const path = f?.path ?? e!.file.path;
          const [dir, name] = splitPath(path);
          const changed = f && e && f.blob !== e.file.newBlob;
          return (
            <div
              key={path}
              className={`guide-file${e ? "" : " gone"}${e && viewed.has(fileViewedKey(e)) ? " is-viewed" : ""}`}
              role={e ? "button" : undefined}
              tabIndex={e ? 0 : undefined}
              title={e ? `Go to ${path}` : `${path} is not in this diff`}
              onClick={() => e && onFile(e)}
              onKeyDown={(ev) => {
                if (e && (ev.key === "Enter" || ev.key === " ")) {
                  ev.preventDefault();
                  onFile(e);
                }
              }}
            >
              <span className="guide-path">
                {e && <StatusLetter status={e.file.status} />}
                <span className="dim">{dir}</span>
                {name}
              </span>
              <span className="guide-summary">
                {f && <Markdown inline text={f.summary} />}
                {changed && (
                  <span className="tag" title="The file's content differs from what the guide describes">
                    changed since
                  </span>
                )}
                {!e && <span className="tag">not in this diff</span>}
              </span>
            </div>
          );
        })}
      </div>
      {shown.length < files.length && (
        <button className="link guide-more" onClick={() => setAll(true)}>
          Show {files.length - shown.length} more files
        </button>
      )}
    </div>
  );
}
