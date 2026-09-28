import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtualizer } from "@pierre/diffs/react";
import { viewedKey, type Comment, type ReviewState, type Section, type View } from "../model.ts";
import { commentsFor, indexComments } from "./lines.ts";
import { Counts, FileCard, type CardActions, type ComposerState, type DisplayPrefs, type FileEntry } from "./FileCard.tsx";

export interface DiffPaneHandle {
  scrollToFile(key: string): void;
  /** Scrolls to the first card showing this comment; false when none does. */
  scrollToComment(c: Comment): boolean;
}

export const fileViewedKey = (e: FileEntry) => viewedKey(e.file.path, e.file.newBlob ?? e.file.oldBlob ?? "");

export function viewEntries(view: View): FileEntry[] {
  return view.sections.flatMap((section) => section.files.map((file) => ({ key: `${section.id}\0${file.path}`, section, file })));
}

const SECTION_HEAD = 30;

export const DiffPane = forwardRef<
  DiffPaneHandle,
  {
    view: View;
    entries: FileEntry[];
    review: ReviewState;
    viewed: Set<string>;
    prefs: DisplayPrefs;
    toolbar: ReactNode;
    busy: boolean;
    onActive(key: string | null): void;
    actions: Omit<CardActions, "toggleCollapsed" | "openComposer" | "closeComposer">;
  }
>(function DiffPane({ view, entries, review, viewed, prefs, toolbar, busy, onActive, actions }, ref) {
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [collapseOverride, setCollapseOverride] = useState<Map<string, boolean>>(new Map());
  const cards = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLElement | null>(null);
  const multi = view.sections.length > 1;
  const stickyTop = multi ? SECTION_HEAD : 0;

  useEffect(() => {
    setComposer(null);
    setCollapseOverride(new Map());
  }, [view]);

  const index = useMemo(() => indexComments(review.comments), [review.comments]);
  const bySection = useMemo(() => {
    const m = new Map<string, FileEntry[]>();
    for (const e of entries) m.set(e.section.id, [...(m.get(e.section.id) ?? []), e]);
    return m;
  }, [entries]);
  const perEntry = useStableComments(entries, index);
  const isCollapsed = (e: FileEntry) => collapseOverride.get(e.key) ?? viewed.has(fileViewedKey(e));

  const outer = useRef(actions);
  outer.current = actions;
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const cardActions = useMemo<CardActions>(
    () => ({
      toggleViewed: (e) => {
        setCollapseOverride((m) => {
          const next = new Map(m);
          next.delete(e.key);
          return next;
        });
        outer.current.toggleViewed(e);
      },
      toggleCollapsed: (e) =>
        setCollapseOverride((m) => {
          const next = new Map(m);
          const cur = m.get(e.key) ?? viewedNow.current.has(fileViewedKey(e));
          next.set(e.key, !cur);
          return next;
        }),
      openComposer: setComposer,
      closeComposer: () => setComposer(null),
      save: async (c, body) => {
        await outer.current.save(c, body);
        setComposer((cur) => (cur === c ? null : cur));
      },
      remove: (c) => outer.current.remove(c),
    }),
    [],
  );
  const viewedNow = useRef(viewed);
  viewedNow.current = viewed;

  const cardRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) cards.current.set(key, el);
    else cards.current.delete(key);
  }, []);

  const scrollTop = (el: HTMLElement) => {
    const s = scroller.current;
    if (!s) return;
    const top = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - stickyTop;
    s.scrollTo({ top: Math.max(0, top) });
  };

  // Tracks the file whose card crosses the top edge, for j/k/v and the rail highlight.
  const activeRef = useRef<string | null>(null);
  const track = useCallback(() => {
    const s = scroller.current;
    if (!s) return;
    const edge = s.getBoundingClientRect().top + stickyTop + 8;
    let active: string | null = entries[0]?.key ?? null;
    for (const e of entries) {
      const el = cards.current.get(e.key);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= edge) active = e.key;
      else break;
    }
    if (active !== activeRef.current) {
      activeRef.current = active;
      onActive(active);
    }
  }, [entries, stickyTop, onActive]);

  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    let frame = 0;
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(track);
    };
    s.addEventListener("scroll", on, { passive: true });
    track();
    return () => {
      s.removeEventListener("scroll", on);
      cancelAnimationFrame(frame);
    };
  }, [track]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToFile(key) {
        const el = cards.current.get(key);
        if (el) scrollTop(el);
      },
      scrollToComment(c) {
        const entry = entries.find((e) => (perEntry.get(e.key) ?? []).some((x) => x.id === c.id));
        if (!entry) return false;
        setCollapseOverride((m) => new Map(m).set(entry.key, false));
        // The card must expand and its lines render before the comment has a position.
        let tries = 0;
        const seek = () => {
          const card = cards.current.get(entry.key);
          const el = card?.querySelector<HTMLElement>(`[data-comment="${CSS.escape(c.id)}"]`);
          if (el) {
            const s = scroller.current!;
            const top = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - s.clientHeight / 3;
            s.scrollTo({ top: Math.max(0, top) });
            el.classList.add("flash");
            setTimeout(() => el.classList.remove("flash"), 1200);
          } else if (tries++ < 20) {
            if (card && tries === 1) scrollTop(card);
            requestAnimationFrame(() => setTimeout(seek, 30));
          }
        };
        requestAnimationFrame(seek);
        return true;
      },
    }),
    [entries, perEntry, stickyTop],
  );

  let body: ReactNode;
  if (entries.length === 0) {
    body = <Empty view={view} />;
  } else {
    body = view.sections.map((s) =>
      s.files.length === 0 && !multi ? null : (
        <div className="section" key={s.id}>
          {multi && <SectionHead section={s} />}
          {multi && s.files.length === 0 && <div className="card-note section-empty">No changes in this branch.</div>}
          {(bySection.get(s.id) ?? []).map((e) => {
            return (
              <FileCard
                key={e.key}
                entry={e}
                comments={perEntry.get(e.key) ?? NONE}
                viewed={viewed.has(fileViewedKey(e))}
                collapsed={isCollapsed(e)}
                composer={composer?.entryKey === e.key ? composer : null}
                prefs={prefs}
                stickyTop={stickyTop}
                actions={cardActions}
                cardRef={cardRef}
              />
            );
          })}
        </div>
      ),
    );
  }

  const singleReplay = !multi ? view.sections[0]?.replay : null;
  return (
    <main className={`pane${busy ? " busy" : ""}`}>
      {toolbar}
      <Virtualizer
        className="scroller"
        contentClassName="scroll-content"
        style={{ ["--section-head" as string]: `${SECTION_HEAD}px` }}
      >
        <ScrollerRef target={scroller} />
        {(view.notes.length > 0 || singleReplay) && (
          <div className="notes">
            {singleReplay && <Replay replay={singleReplay} />}
            {view.notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
        {body}
        <div className="scroll-end" />
      </Virtualizer>
    </main>
  );
});

const NONE: Comment[] = [];

/** Grabs the Virtualizer's scroll element, which the component does not expose. */
function ScrollerRef({ target }: { target: React.MutableRefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    target.current = ref.current?.closest<HTMLElement>(".scroller") ?? null;
  });
  return <span ref={ref} hidden />;
}

/** Per-entry comment arrays that keep their identity while unchanged, so memoized cards skip re-rendering. */
function useStableComments(entries: FileEntry[], index: Map<string, Comment[]>): Map<string, Comment[]> {
  const prev = useRef(new Map<string, Comment[]>());
  return useMemo(() => {
    const next = new Map<string, Comment[]>();
    for (const e of entries) {
      const cs = commentsFor(index, e.file);
      const old = prev.current.get(e.key);
      const same = old && old.length === cs.length && old.every((c, i) => c === cs[i]);
      next.set(e.key, same ? old : cs);
    }
    prev.current = next;
    return next;
  }, [entries, index]);
}

function SectionHead({ section: s }: { section: Section }) {
  const add = s.files.reduce((n, f) => n + f.additions, 0);
  const del = s.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="section-head">
      {s.branch && s.title.startsWith(s.branch) ? (
        <span>
          <span className="branch-name">{s.branch}</span>
          <span className="dim">{s.title.slice(s.branch.length)}</span>
        </span>
      ) : (
        <span>
          <span className="branch-name">{s.branch ?? "detached"}</span>
          {s.title !== s.branch && <span className="dim"> {s.title}</span>}
        </span>
      )}
      <span className="dim" title={s.commits.map((c) => `${c.short} ${c.subject}`).join("\n")}>
        {s.commits.length} commit{s.commits.length === 1 ? "" : "s"}
        {s.includesWorking ? " + uncommitted" : ""}
      </span>
      {s.replay && <Replay replay={s.replay} />}
      <span className="grow" />
      <span className="dim">
        {s.files.length} file{s.files.length === 1 ? "" : "s"}
      </span>
      <Counts add={add} del={del} />
    </div>
  );
}

const Replay = ({ replay }: { replay: { conflicts: boolean } }) => (
  <span className={`replay${replay.conflicts ? " conflict" : ""}`} title="The old side was replayed onto the moved parent to hide restack noise.">
    {replay.conflicts ? "replayed with conflicts" : "replayed onto parent"}
  </span>
);

function Empty({ view }: { view: View }) {
  const t = view.target;
  const hint =
    t.kind === "branch"
      ? "This branch has no changes against its parent."
      : t.kind === "working"
        ? "The worktree is clean."
        : t.kind === "since-review"
          ? "Nothing changed since the last review."
          : "This selection has no file changes.";
  return (
    <div className="empty">
      <div className="empty-title">No changes</div>
      <div className="dim">{hint}</div>
    </div>
  );
}
