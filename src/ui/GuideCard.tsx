import { memo, useState, type ReactNode } from "react";
import type { Guide, GuideFile } from "../model.ts";
import { EVERYTHING_ELSE } from "./guides.ts";
import { sideKey, splitPath } from "./lines.ts";
import { Markdown } from "./markdown.tsx";
import { ago } from "./names.tsx";
import { usePref } from "./prefs.ts";
import { Chevron, fileViewedKey, StatusLetter, type FileEntry } from "./FileCard.tsx";

export interface GuideControls {
  collapsed: boolean;
  toggleCollapsed(): void;
  guided: boolean;
  toggleGuided(): void;
  notes: boolean;
  toggleNotes(): void;
}

interface GroupData {
  title: string;
  overview: string | null;
  files: { f: GuideFile | null; e: FileEntry | undefined }[];
}

/**
 * The author's walkthrough of one branch, at the top of its section: intent,
 * then one row per guide section. A row jumps to its group in the diff and
 * expands to the section's overview and files.
 */
export const GuideCard = memo(function GuideCard({
  guide,
  entries,
  viewed,
  controls,
  onFile,
}: {
  guide: Guide;
  entries: FileEntry[];
  viewed: Set<string>;
  controls: GuideControls;
  onFile(e: FileEntry): void;
}) {
  const [open, setOpen] = usePref<string[]>(`guideOpen:${guide.branch}`, []);
  const byPath = new Map(entries.map((e) => [e.file.path, e]));
  const placed = new Set(guide.sections.flatMap((s) => s.files.map((f) => f.path)));
  const rest = entries.filter((e) => !placed.has(e.file.path));
  const groups: GroupData[] = [
    ...guide.sections.map((s) => ({ title: s.title, overview: s.overview, files: s.files.map((f) => ({ f, e: byPath.get(f.path) })) })),
    ...(rest.length > 0 ? [{ title: EVERYTHING_ELSE, overview: null, files: rest.map((e) => ({ f: null, e })) }] : []),
  ];
  const diffed = new Set(entries.flatMap((e) => [e.file.newBlob && sideKey("new", e.file.path, e.file.newBlob), e.file.oldBlob && sideKey("old", e.file.oldPath ?? e.file.path, e.file.oldBlob)]));
  const staleNotes = guide.annotations.filter((a) => !diffed.has(sideKey(a.anchor.side, a.anchor.path, a.anchor.blob))).length;
  const { collapsed } = controls;
  const toggle = (title: string) => setOpen((o) => (o.includes(title) ? o.filter((t) => t !== title) : [...o, title]));
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
          <div className="guide-groups">
            {groups.map((g) => (
              <Group key={g.title} group={g} open={open.includes(g.title)} onToggle={() => toggle(g.title)} viewed={viewed} onFile={onFile}>
                {g.overview && <Markdown className="guide-overview" text={g.overview} />}
              </Group>
            ))}
          </div>
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

/** File rows an expanded group shows before "Show N more files". */
const GROUP_ROWS = 8;

function Group({
  group,
  open,
  onToggle,
  viewed,
  onFile,
  children,
}: {
  group: GroupData;
  open: boolean;
  onToggle(): void;
  viewed: Set<string>;
  onFile(e: FileEntry): void;
  children?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const { files } = group;
  const shown = all || files.length <= GROUP_ROWS + 2 ? files : files.slice(0, GROUP_ROWS);
  const present = files.flatMap(({ e }) => (e ? [e] : []));
  const done = present.filter((e) => viewed.has(fileViewedKey(e))).length;
  const changed = files.filter(({ f, e }) => f && e && f.blob !== e.file.newBlob).length;
  const jump = () => present[0] && onFile(present[0]);
  return (
    <div className={`guide-group${open ? " open" : ""}`}>
      <div
        className="guide-group-row"
        role="button"
        tabIndex={0}
        title={present[0] ? `Go to ${group.title}` : undefined}
        onClick={jump}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            jump();
          }
        }}
      >
        <button
          className="chev"
          aria-label={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
          aria-expanded={open}
          onClick={(ev) => {
            ev.stopPropagation();
            onToggle();
          }}
        >
          <Chevron open={open} />
        </button>
        <span className="guide-group-title">{group.title}</span>
        <span className="guide-count">
          {present.length} file{present.length === 1 ? "" : "s"}
        </span>
        <span className="guide-count">
          {done}/{present.length} viewed
        </span>
        {changed > 0 && (
          <span className="tag" title="Files whose content differs from what the guide describes">
            {changed} changed since
          </span>
        )}
      </div>
      {open && (
        <div className="guide-group-body">
          {children}
          <div className="guide-files">
            {shown.map(({ f, e }) => (
              <FileRow key={f?.path ?? e!.file.path} f={f} e={e} viewed={!!e && viewed.has(fileViewedKey(e))} onFile={onFile} />
            ))}
          </div>
          {shown.length < files.length && (
            <button className="link guide-more" onClick={() => setAll(true)}>
              Show {files.length - shown.length} more files
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ f, e, viewed, onFile }: { f: GuideFile | null; e: FileEntry | undefined; viewed: boolean; onFile(e: FileEntry): void }) {
  const path = f?.path ?? e!.file.path;
  const [dir, name] = splitPath(path);
  const changed = f && e && f.blob !== e.file.newBlob;
  return (
    <div
      className={`guide-file${e ? "" : " gone"}${viewed ? " is-viewed" : ""}`}
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
}
