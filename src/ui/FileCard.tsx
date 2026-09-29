import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import { viewedKey, type Anchor, type Comment, type FileChange, type Section } from "../model.ts";
import { api } from "./api.ts";
import { anchorKey, lineInHunks, lineTexts, splitPath, toPierreSide, toSide } from "./lines.ts";
import { drafts, THEMES, type ThemeName } from "./prefs.ts";
import { noteLine, type Note } from "./guides.ts";
import { Markdown } from "./markdown.tsx";

export interface FileEntry {
  key: string;
  section: Section;
  file: FileChange;
  /** Title of the guide group this entry opens in guided order. */
  group: string | null;
}

export const fileViewedKey = (e: FileEntry) => viewedKey(e.file.path, e.file.newBlob ?? e.file.oldBlob ?? "");

export interface ComposerState {
  entryKey: string;
  anchor: Anchor;
  snippet: string[];
  editing: Comment | null;
}

export interface CardActions {
  toggleViewed(entry: FileEntry): void;
  toggleCollapsed(entry: FileEntry): void;
  openComposer(c: ComposerState): void;
  closeComposer(): void;
  save(c: ComposerState, body: string): Promise<void>;
  remove(c: Comment): Promise<void>;
}

export interface DisplayPrefs {
  diffStyle: "unified" | "split";
  theme: ThemeName;
  wrap: boolean;
}

type Meta = { kind: "comment"; comment: Comment } | { kind: "note"; note: Note } | { kind: "composer" };

const LARGE_DIFF_LINES = 1500;
const STATUS_LETTER = { added: "A", deleted: "D", modified: "M", renamed: "R" } as const;

export const StatusLetter = ({ status }: { status: FileChange["status"] }) => (
  <span className={`status s-${status}`} title={status}>
    {STATUS_LETTER[status]}
  </span>
);

export const Counts = ({ add, del }: { add: number; del: number }) => (
  <span className="counts">
    {add > 0 && <span className="add">+{add}</span>}
    {del > 0 && <span className="del">−{del}</span>}
  </span>
);

function parse(f: FileChange): FileDiffMetadata | null {
  if (f.binary || !f.patch) return null;
  const fd = parsePatchFiles(f.patch, `${f.oldBlob}:${f.newBlob}`)[0]?.files[0];
  return fd && fd.hunks.length > 0 ? fd : null;
}

export const FileCard = memo(function FileCard({
  entry,
  comments,
  notes,
  summary,
  viewed,
  collapsed,
  composer,
  prefs,
  stickyTop,
  actions,
  cardRef,
}: {
  entry: FileEntry;
  comments: Comment[];
  /** Author notes to show; empty while notes are hidden. */
  notes: Note[];
  /** The guide's summary of this file. */
  summary: string | null;
  viewed: boolean;
  collapsed: boolean;
  composer: ComposerState | null;
  prefs: DisplayPrefs;
  stickyTop: number;
  actions: CardActions;
  cardRef: (key: string, el: HTMLElement | null) => void;
}) {
  const { file } = entry;
  const near = useNearViewport();
  const fd = useMemo(() => (near.seen ? parse(file) : null), [near.seen, file]);
  const [dir, name] = splitPath(file.path);
  const [large, setLarge] = useState(file.additions + file.deletions > LARGE_DIFF_LINES);
  const [drag, setDrag] = useState<SelectedLineRange | null>(null);

  const openFromRange = (r: SelectedLineRange) => {
    if (!fd) return;
    const mixed = r.endSide !== undefined && r.endSide !== r.side;
    const side = toSide(r.endSide ?? r.side);
    const start = mixed ? r.end : Math.min(r.start, r.end);
    const end = Math.max(r.start, r.end);
    const blob = side === "new" ? file.newBlob : file.oldBlob;
    if (!blob) return;
    const path = side === "old" ? (file.oldPath ?? file.path) : file.path;
    actions.openComposer({
      entryKey: entry.key,
      anchor: { path, side, start, end, blob },
      snippet: lineTexts(fd, side, start, end),
      editing: null,
    });
  };
  const openRef = useRef(openFromRange);
  openRef.current = openFromRange;

  const options = useMemo<FileDiffOptions<Meta, undefined>>(
    () => ({
      theme: THEMES[prefs.theme].shiki,
      themeType: "dark",
      diffStyle: prefs.diffStyle,
      overflow: prefs.wrap ? "wrap" : "scroll",
      hunkSeparators: "line-info",
      disableFileHeader: true,
      lineDiffType: "word-alt",
      enableLineSelection: true,
      lineHoverHighlight: "number",
      onLineSelectionChange: (r) => setDrag(r),
      onLineSelectionEnd: (r) => {
        setDrag(null);
        if (r) openRef.current(r);
      },
      async loadDiffFiles() {
        const [oldC, newC] = await Promise.all([file.oldBlob ? api.blob(file.oldBlob) : "", file.newBlob ? api.blob(file.newBlob) : ""]);
        return {
          oldFile: { name: file.oldPath ?? file.path, contents: oldC, cacheKey: file.oldBlob ?? undefined },
          newFile: { name: file.path, contents: newC, cacheKey: file.newBlob ?? undefined },
        };
      },
    }),
    [prefs.diffStyle, prefs.wrap, prefs.theme, file],
  );

  const annotations = useMemo<DiffLineAnnotation<Meta>[]>(() => {
    if (!fd) return [];
    const out: DiffLineAnnotation<Meta>[] = comments
      .filter((c) => c.id !== composer?.editing?.id)
      .map((c) => ({
        side: toPierreSide(c.anchor.side),
        // Lines outside the hunks do not render; pin those comments to the top of the file.
        lineNumber: lineInHunks(fd, c.anchor.side, c.anchor.end) ? c.anchor.end : 0,
        metadata: { kind: "comment", comment: c },
      }));
    for (const n of notes) out.push({ side: toPierreSide(n.anchor.side), lineNumber: noteLine(fd, n.anchor), metadata: { kind: "note", note: n } });
    if (composer) out.push({ side: toPierreSide(composer.anchor.side), lineNumber: composer.anchor.end, metadata: { kind: "composer" } });
    return out;
  }, [fd, comments, notes, composer]);

  const selected: SelectedLineRange | null =
    drag ?? (composer ? { start: composer.anchor.start, end: composer.anchor.end, side: toPierreSide(composer.anchor.side) } : null);

  const renderAnnotation = (a: DiffLineAnnotation<Meta>) => {
    const m = a.metadata;
    if (m.kind === "composer" && composer) return <Composer state={composer} actions={actions} />;
    if (m.kind === "comment")
      return (
        <CommentCard
          comment={m.comment}
          pinned={a.lineNumber === 0}
          onEdit={() =>
            actions.openComposer({ entryKey: entry.key, anchor: m.comment.anchor, snippet: m.comment.snippet, editing: m.comment })
          }
          onDelete={() => actions.remove(m.comment)}
        />
      );
    if (m.kind === "note")
      return (
        <NoteCard
          note={m.note}
          pinned={a.lineNumber === 0}
          onReply={() => {
            const { anchor } = m.note;
            actions.openComposer({ entryKey: entry.key, anchor, snippet: fd ? lineTexts(fd, anchor.side, anchor.start, anchor.end) : [], editing: null });
          }}
        />
      );
    return null;
  };

  const body = () => {
    if (collapsed) return null;
    if (file.binary) return <div className="card-note">Binary file</div>;
    if (!near.seen) return <div style={{ height: estimateHeight(file) }} />;
    if (!fd) return <div className="card-note">{file.status === "renamed" ? "Renamed without content changes" : "No content changes"}</div>;
    if (large)
      return (
        <div className="card-note">
          Large diff, {file.additions + file.deletions} changed lines.{" "}
          <button className="link" onClick={() => setLarge(false)}>
            Show it
          </button>
        </div>
      );
    return (
      <FileDiff<Meta>
        fileDiff={fd}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selected}
        renderAnnotation={renderAnnotation}
      />
    );
  };

  return (
    <section
      className={`card${collapsed ? " collapsed" : ""}`}
      data-file={entry.key}
      ref={(el) => {
        cardRef(entry.key, el);
        near.ref(el);
      }}
    >
      <header className="card-head" style={{ top: stickyTop }}>
        <button
          className="chev"
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          aria-expanded={!collapsed}
          onClick={() => actions.toggleCollapsed(entry)}
        >
          <Chevron open={!collapsed} />
        </button>
        <StatusLetter status={file.status} />
        <span className="path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && <span className="dim">{file.oldPath} → </span>}
          <span className="dim">{dir}</span>
          {name}
        </span>
        <span className="grow" />
        {comments.length > 0 && (
          <span className="ccount" title={`${comments.length} comment${comments.length === 1 ? "" : "s"}`}>
            <CommentGlyph />
            {comments.length}
          </span>
        )}
        <Counts add={file.additions} del={file.deletions} />
        <label className={`viewed${viewed ? " on" : ""}`}>
          <input type="checkbox" checked={viewed} onChange={() => actions.toggleViewed(entry)} />
          Viewed
        </label>
      </header>
      {summary && !collapsed && near.seen && <Markdown className="card-summary" text={summary} />}
      {body()}
    </section>
  );
});

/**
 * Mounting a FileDiff costs a few milliseconds even off screen, which adds up
 * to seconds on views with hundreds of files. Cards mount their diff once they
 * come within a screen or two of the viewport, and stay mounted.
 */
function useNearViewport() {
  const [seen, setSeen] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!el || seen) return;
      const root = el.closest(".scroller");
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setSeen(true);
            observer.current?.disconnect();
          }
        },
        { root, rootMargin: "1500px 0px" },
      );
      observer.current.observe(el);
    },
    [seen],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return { seen, ref };
}

const LINE_PX = 19;
function estimateHeight(f: FileChange): number {
  let lines = 0;
  let hunks = 0;
  for (const l of f.patch.split("\n")) {
    if (l.startsWith("@@")) hunks++;
    else if (hunks && (l[0] === " " || l[0] === "+" || l[0] === "-")) lines++;
  }
  return lines * LINE_PX + hunks * 32 + 8;
}

function Composer({ state, actions }: { state: ComposerState; actions: CardActions }) {
  const key = state.editing ? `edit:${state.editing.id}` : anchorKey(state.anchor);
  const [body, setBody] = useState(() => drafts.get(key) ?? state.editing?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);
  const change = (v: string) => {
    setBody(v);
    drafts.set(key, v === state.editing?.body ? "" : v);
  };
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.save(state, body.trim());
      drafts.clear(key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const { anchor } = state;
  return (
    <div className="composer" onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={body}
        rows={3}
        placeholder={`Comment on ${anchor.side === "old" ? "removed " : ""}line${anchor.start === anchor.end ? ` ${anchor.end}` : `s ${anchor.start}–${anchor.end}`}`}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            actions.closeComposer();
          }
        }}
      />
      <div className="composer-foot">
        {error ? <span className="err">{error}</span> : <span className="hint">⌘↵ save · esc close · drafts are kept</span>}
        <span className="grow" />
        <button className="btn" onClick={() => actions.closeComposer()}>
          Cancel
        </button>
        <button className="btn primary" disabled={!body.trim() || busy} onClick={() => void save()}>
          {state.editing ? "Update" : "Comment"}
        </button>
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  pinned,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  pinned: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const { anchor } = comment;
  return (
    <div className="comment" data-comment={comment.id} onPointerDown={(e) => e.stopPropagation()}>
      <div className="comment-body">
        {pinned && (
          <span className="dim">
            {anchor.side === "old" ? "old " : ""}line {anchor.start}
            {anchor.end !== anchor.start ? `–${anchor.end}` : ""} ·{" "}
          </span>
        )}
        {comment.body}
      </div>
      <div className="comment-actions">
        <button className="link" onClick={onEdit}>
          Edit
        </button>
        <button className={`link${confirm ? " danger" : ""}`} onClick={() => (confirm ? void onDelete() : setConfirm(true))}>
          {confirm ? "Delete?" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function NoteCard({ note, pinned, onReply }: { note: Note; pinned: boolean; onReply: () => void }) {
  const [why, setWhy] = useState(false);
  const { anchor } = note;
  return (
    <div className="note" data-note={note.id} onPointerDown={(e) => e.stopPropagation()}>
      <div className="note-head">
        <NoteGlyph />
        <span>{note.author ?? "author"} note</span>
        {pinned && (
          <span className="dim">
            {anchor.side === "old" ? "old " : ""}line {anchor.start}
            {anchor.end !== anchor.start ? `–${anchor.end}` : ""}
          </span>
        )}
        <span className="grow" />
        {note.rationale && (
          <button className={`link${why ? " on" : ""}`} aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            Why
          </button>
        )}
        <button className="link" onClick={onReply}>
          Reply
        </button>
      </div>
      <Markdown className="note-body" text={note.summary} />
      {why && note.rationale && <Markdown className="note-why" text={note.rationale} />}
    </div>
  );
}

export const NoteGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <path d="M2.5 1.5h5l2 2v7h-7z M4.5 5.5h3 M4.5 7.5h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);

export const Chevron = ({ open }: { open: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" className={`chevron${open ? " open" : ""}`} aria-hidden>
    <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export const CommentGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <path d="M2 2.5h8v5.5H5.5L3 10V8H2z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);
