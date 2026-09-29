import { forwardRef, Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtualizer } from "@pierre/diffs/react";
import { targetToHash, type Comment, type FileChange, type Guide, type ReviewState, type Section, type View } from "../model.ts";
import { Dimmed } from "./names.tsx";
import { anchoredTo, indexAnchored } from "./lines.ts";
import { guideFor, patchHunks, type HunkStart, type Note } from "./guides.ts";
import { GuideCard, type GuideControls } from "./GuideCard.tsx";
import { Counts, FileCard, fileViewedKey, type CardActions, type ComposerState, type DisplayPrefs, type FileEntry } from "./FileCard.tsx";

export interface DiffPaneHandle {
  scrollToFile(key: string): void;
  /** Scrolls to the first card showing this comment; false when none does. */
  scrollToComment(c: Comment): boolean;
  /** Scrolls the next (1) or previous (-1) hunk of an expanded file, in view order, near the top. */
  stepHunk(dir: 1 | -1): void;
}

const SECTION_HEAD = 30;
const CARD_HEAD = 34;
/** Rows of context left visible above a hunk that `[`/`]` scrolls to. */
const HUNK_LEAD = 3;
const LINE_PX = 19;

export const DiffPane = forwardRef<
  DiffPaneHandle,
  {
    view: View;
    entries: FileEntry[];
    review: ReviewState;
    viewed: Set<string>;
    guides: Map<string, Guide>;
    notes: Map<string, Note[]> | null;
    guideControls: GuideControls;
    prefs: DisplayPrefs;
    prefix: string;
    toolbar: ReactNode;
    busy: boolean;
    onActive(key: string | null): void;
    actions: Omit<CardActions, "toggleCollapsed" | "openComposer" | "closeComposer">;
  }
>(function DiffPane({ view, entries, review, viewed, guides, notes, guideControls, prefs, prefix, toolbar, busy, onActive, actions }, ref) {
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [collapseOverride, setCollapseOverride] = useState<Map<string, boolean>>(new Map());
  const cards = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLElement | null>(null);
  const multi = view.sections.length > 1;
  const stickyTop = multi ? SECTION_HEAD : 0;

  const shownTarget = useRef<string | null>(null);
  useEffect(() => {
    setComposer(null);
    setCollapseOverride(new Map());
    // A new target starts at the top; reloading the same target keeps the reviewer's place.
    const t = targetToHash(view.target);
    if (shownTarget.current !== t && scroller.current) scroller.current.scrollTop = 0;
    shownTarget.current = t;
  }, [view]);

  const index = useMemo(() => indexAnchored(review.comments), [review.comments]);
  const bySection = useMemo(() => {
    const m = new Map<string, FileEntry[]>();
    for (const e of entries) m.set(e.section.id, [...(m.get(e.section.id) ?? []), e]);
    return m;
  }, [entries]);
  const perEntry = useStableAnchored(entries, index);
  const perEntryNotes = useStableAnchored(entries, notes ?? NO_NOTES);
  const summaries = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of view.sections) {
      const g = guideFor(view, s, guides);
      for (const f of g?.sections.flatMap((x) => x.files) ?? []) m.set(`${s.id}\0${f.path}`, f.summary);
    }
    return m;
  }, [view, guides]);
  const isCollapsed = (e: FileEntry) => collapseOverride.get(e.key) ?? viewed.has(fileViewedKey(e));

  const viewedNow = useRef(viewed);
  viewedNow.current = viewed;
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

  const hunkNav = useRef<{ mark: HTMLElement | null; seek: number }>({ mark: null, seek: 0 });

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
            // Cards above keep measuring after the first paint; re-aim until the position settles.
            let settle = 0;
            const aim = () => {
              const top = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - s.clientHeight / 3;
              if (Math.abs(s.scrollTop - Math.max(0, top)) > 4) s.scrollTo({ top: Math.max(0, top) });
              if (settle++ < 8) setTimeout(aim, 80);
            };
            aim();
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
      stepHunk(dir) {
        const s = scroller.current;
        if (!s) return;
        // A hunk is placed with its first changed row at `lead`, below the sticky headers; the one there now is the current hunk.
        const lead = s.getBoundingClientRect().top + stickyTop + CARD_HEAD + HUNK_LEAD * LINE_PX;
        const list = entries.flatMap((entry) => {
          const card = cards.current.get(entry.key);
          return card && !isCollapsed(entry) ? hunksOf(entry.file).map((h) => ({ entry, card, h })) : [];
        });
        const ys = list.map(({ card, h }) => hunkY(card, h));
        const at = dir === 1 ? ys.findIndex((y) => y > lead + 2) : ys.findLastIndex((y) => y < lead - 2);
        const next = list[at];
        if (!next) return;
        const seek = ++hunkNav.current.seek;
        hunkNav.current.mark?.remove();
        hunkNav.current.mark = null;
        let tries = 0;
        // Rows far from the viewport are not rendered yet: scroll to an estimate, then re-aim at the real row.
        let last = -1;
        const aim = () => {
          if (seek !== hunkNav.current.seek) return;
          const row = hunkRow(next.card, next.h);
          const y = row ? row.getBoundingClientRect().top : hunkY(next.card, next.h);
          // Settled: on target, or pinned against the top or bottom of the scroll range.
          if (row && (Math.abs(y - lead) <= 2 || s.scrollTop === last)) return void (hunkNav.current.mark = markHunk(next.card, row));
          last = s.scrollTop;
          s.scrollTo({ top: Math.max(0, s.scrollTop + y - lead) });
          if (tries++ < 12) requestAnimationFrame(() => setTimeout(aim, 40));
        };
        aim();
      },
    }),
    [entries, perEntry, stickyTop, collapseOverride, viewed],
  );

  const onGuideFile = useCallback(
    (e: FileEntry) => {
      const el = cards.current.get(e.key);
      if (el) scrollTop(el);
      onActive(e.key);
    },
    [onActive, stickyTop],
  );

  let body: ReactNode;
  if (entries.length === 0) {
    body = <Empty view={view} />;
  } else {
    body = view.sections.map((s) => {
      if (s.files.length === 0 && !multi) return null;
      const sectionEntries = bySection.get(s.id) ?? [];
      const guide = guideFor(view, s, guides);
      return (
        <div className="section" key={s.id}>
          {multi && <SectionHead section={s} prefix={prefix} />}
          {multi && s.files.length === 0 && <div className="card-note section-empty">No changes in this branch.</div>}
          {guide && <GuideCard guide={guide} entries={sectionEntries} viewed={viewed} controls={guideControls} onFile={onGuideFile} />}
          {sectionEntries.map((e) => (
            <Fragment key={e.key}>
              {e.group && <div className="group-head">{e.group}</div>}
              <FileCard
                entry={e}
                comments={perEntry.get(e.key) ?? NONE}
                notes={perEntryNotes.get(e.key) ?? NO_NOTE}
                summary={summaries.get(e.key) ?? null}
                viewed={viewed.has(fileViewedKey(e))}
                collapsed={isCollapsed(e)}
                composer={composer?.entryKey === e.key ? composer : null}
                prefs={prefs}
                stickyTop={stickyTop}
                actions={cardActions}
                cardRef={cardRef}
              />
            </Fragment>
          ))}
        </div>
      );
    });
  }

  const singleReplay = !multi ? view.sections[0]?.replay : null;
  return (
    <main className={`pane${busy ? " busy" : ""}`}>
      {toolbar}
      <Virtualizer className="scroller" contentClassName="scroll-content" style={{ ["--section-head" as string]: `${SECTION_HEAD}px` }}>
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
const NO_NOTE: Note[] = [];
const NO_NOTES = new Map<string, Note[]>();

const ROW_TYPE = { new: "change-addition", old: "change-deletion" } as const;

const hunkCache = new WeakMap<FileChange, HunkStart[]>();
function hunksOf(f: FileChange): HunkStart[] {
  let h = hunkCache.get(f);
  if (!h) hunkCache.set(f, (h = f.binary ? [] : patchHunks(f.patch)));
  return h;
}

/** The rendered row of a hunk's first changed line, inside the diff's shadow root; null until it renders. */
function hunkRow(card: HTMLElement, h: HunkStart): HTMLElement | null {
  const root = card.querySelector("diffs-container")?.shadowRoot;
  return root?.querySelector<HTMLElement>(`[data-line-type="${ROW_TYPE[h.side]}"][data-line="${h.line}"]`) ?? null;
}

/** Viewport y of a hunk's first changed line: exact once rendered, else estimated from the card and the patch. */
function hunkY(card: HTMLElement, h: HunkStart): number {
  const row = hunkRow(card, h);
  if (row) return row.getBoundingClientRect().top;
  const head = card.querySelector<HTMLElement>(".card-head")?.offsetHeight ?? 34;
  return card.getBoundingClientRect().top + head + h.rowsBefore * LINE_PX + h.index * 32;
}

/** A short-lived accent bar beside the hunk's first block of changed rows. */
function markHunk(card: HTMLElement, row: HTMLElement): HTMLElement {
  let height = 0;
  for (let r: Element | null = row; r?.getAttribute("data-line-type")?.startsWith("change"); r = r.nextElementSibling) height += r.getBoundingClientRect().height;
  const mark = document.createElement("div");
  mark.className = "hunk-mark";
  mark.style.top = `${row.getBoundingClientRect().top - card.getBoundingClientRect().top}px`;
  mark.style.height = `${height}px`;
  card.appendChild(mark);
  mark.addEventListener("animationend", () => mark.remove());
  return mark;
}

/** Grabs the Virtualizer's scroll element, which the component does not expose. */
function ScrollerRef({ target }: { target: React.MutableRefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    target.current = ref.current?.closest<HTMLElement>(".scroller") ?? null;
  });
  return <span ref={ref} hidden />;
}

/** Per-entry comment or note arrays that keep their identity while unchanged, so memoized cards skip re-rendering. */
function useStableAnchored<T>(entries: FileEntry[], index: Map<string, T[]>): Map<string, T[]> {
  const prev = useRef(new Map<string, T[]>());
  return useMemo(() => {
    const next = new Map<string, T[]>();
    for (const e of entries) {
      const cs = anchoredTo(index, e.file);
      const old = prev.current.get(e.key);
      const same = old && old.length === cs.length && old.every((c, i) => c === cs[i]);
      next.set(e.key, same ? old : cs);
    }
    prev.current = next;
    return next;
  }, [entries, index]);
}

function SectionHead({ section: s, prefix }: { section: Section; prefix: string }) {
  const add = s.files.reduce((n, f) => n + f.additions, 0);
  const del = s.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="section-head">
      {s.branch && s.title.startsWith(s.branch) ? (
        <span>
          <span className="branch-name">
            <Dimmed text={s.branch} prefix={prefix} />
          </span>
          <span className="dim">
            <Dimmed text={s.title.slice(s.branch.length)} prefix={prefix} />
          </span>
        </span>
      ) : (
        <span>
          <span className="branch-name">
            <Dimmed text={s.branch ?? "detached"} prefix={prefix} />
          </span>
          {s.title !== s.branch && (
            <span className="dim">
              {" "}
              <Dimmed text={s.title} prefix={prefix} />
            </span>
          )}
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
  <span
    className={`replay${replay.conflicts ? " conflict" : ""}`}
    title="The old side was replayed onto the moved parent to hide restack noise."
  >
    {replay.conflicts ? "restacked, conflicts" : "restacked"}
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
