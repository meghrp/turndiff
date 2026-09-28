import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashToTarget, targetToHash, type Comment, type RepoState, type ReviewState, type Target, type View } from "../model.ts";
import { api } from "./api.ts";
import { usePref } from "./prefs.ts";
import { defaultTarget, sameTarget } from "./stack.ts";
import { commentsFor, indexComments } from "./lines.ts";
import { DiffPane, fileViewedKey, viewEntries, type DiffPaneHandle } from "./DiffPane.tsx";
import { Rail } from "./Rail.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { Counts, type ComposerState, type FileEntry } from "./FileCard.tsx";

const POLL_MS = 4000;
const NARROW = 900;
const LOADED_AT = Date.now();

// RepoState.focus is landing in model.ts on rebuild/engine; typed here until the rebase.
type Focus = { hash: string; at: number } | null;
type Repo = RepoState & { focus?: Focus };

const EMPTY_REVIEW: ReviewState = { comments: [], summary: "", viewed: [], outdated: [] };

export function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(() => hashToTarget(location.hash));
  const [view, setView] = useState<View | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<ReviewState>(EMPTY_REVIEW);
  const [panel, setPanel] = useState<"review" | "help" | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = usePref<"unified" | "split">("diffStyle", "unified");
  const [wrap, setWrap] = usePref("wrap", false);
  const [ws, setWs] = usePref("ignoreWhitespace", false);
  const [railWidth, setRailWidth] = usePref("railWidth", 300);
  const [railOpen, setRailOpen] = useState(() => innerWidth >= NARROW);
  const pane = useRef<DiffPaneHandle>(null);
  const filter = useRef<HTMLInputElement>(null);
  const lastFocus = useRef(LOADED_AT);
  const pendingComment = useRef<Comment | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const next = (await api.state()) as Repo;
      setRepoError(null);
      setRepo((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
      const f = next.focus;
      if (f && f.at > lastFocus.current) {
        lastFocus.current = f.at;
        if (location.hash.slice(1) !== f.hash) location.hash = f.hash;
      }
      return next;
    } catch (e) {
      setRepoError((e as Error).message);
      return null;
    }
  }, []);

  const refreshReview = useCallback(() => api.review().then(setReview).catch(() => {}), []);

  useEffect(() => {
    void refreshState();
    void refreshReview();
    const id = setInterval(() => document.visibilityState === "visible" && void refreshState(), POLL_MS);
    const onFocus = () => {
      void refreshState();
      void refreshReview();
    };
    const onHash = () => setTarget((cur) => {
      const next = hashToTarget(location.hash);
      return cur && next && sameTarget(cur, next) ? cur : next;
    });
    const onResize = () => innerWidth < NARROW && setRailOpen(false);
    addEventListener("focus", onFocus);
    addEventListener("hashchange", onHash);
    addEventListener("resize", onResize);
    return () => {
      clearInterval(id);
      removeEventListener("focus", onFocus);
      removeEventListener("hashchange", onHash);
      removeEventListener("resize", onResize);
    };
  }, [refreshState, refreshReview]);

  useEffect(() => {
    if (repo && !target) {
      const t = defaultTarget(repo);
      history.replaceState(null, "", `#${targetToHash(t)}`);
      setTarget(t);
    }
  }, [repo, target]);

  const select = useCallback((t: Target) => {
    location.hash = targetToHash(t);
  }, []);

  const request = useRef(0);
  const loadView = useCallback(async (t: Target, ignoreWs: boolean) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const v = await api.view(t, ignoreWs);
      if (id !== request.current) return;
      setView(v);
      setViewError(null);
    } catch (e) {
      if (id === request.current) setViewError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  const targetHash = target ? targetToHash(target) : null;
  useEffect(() => {
    if (target) void loadView(target, ws);
  }, [targetHash, ws]);

  const reload = useCallback(() => {
    if (target) void loadView(target, ws);
    void refreshState();
    void refreshReview();
  }, [target, ws, loadView, refreshState, refreshReview]);

  useEffect(() => {
    const c = pendingComment.current;
    if (c && view && !loading) {
      pendingComment.current = null;
      pane.current?.scrollToComment(c);
    }
  }, [view, loading]);

  const entries = useMemo(() => (view ? viewEntries(view) : []), [view]);
  const viewed = useMemo(() => new Set(review.viewed), [review.viewed]);
  const commentIndex = useMemo(() => indexComments(review.comments), [review.comments]);

  useEffect(() => {
    document.title = repo ? `${view?.title ?? repo.name} · turndiff` : "turndiff";
  }, [repo, view]);

  const reviewRef = useRef(review);
  reviewRef.current = review;
  const toggleViewed = useCallback(async (e: FileEntry) => {
    const key = fileViewedKey(e);
    const now = !reviewRef.current.viewed.includes(key);
    setReview((r) => ({ ...r, viewed: now ? [...r.viewed, key] : r.viewed.filter((k) => k !== key) }));
    try {
      setReview(await api.setViewed(key, now));
    } catch {
      void refreshReview();
    }
  }, [refreshReview]);

  const targetRef = useRef(target);
  targetRef.current = target;
  const actions = useMemo(
    () => ({
      toggleViewed,
      save: async (c: ComposerState, body: string) => {
        const entry = entries.find((e) => e.key === c.entryKey);
        const now = new Date().toISOString();
        const comment: Comment = c.editing
          ? { ...c.editing, body, updatedAt: now }
          : {
              id: crypto.randomUUID(),
              body,
              anchor: c.anchor,
              snippet: c.snippet,
              origin: {
                branch: entry?.section.branch ?? null,
                head: entry?.section.head ?? "",
                working: entry?.section.includesWorking ?? false,
                target: targetRef.current!,
              },
              createdAt: now,
              updatedAt: now,
            };
        setReview(await api.putComment(comment));
      },
      remove: async (c: Comment) => setReview(await api.deleteComment(c.id)),
    }),
    [entries, toggleViewed],
  );

  const openComment = useCallback(
    (c: Comment) => {
      if (innerWidth < 1200) setPanel(null);
      if (target && sameTarget(target, c.origin.target) && !loading) pane.current?.scrollToComment(c);
      else {
        pendingComment.current = c;
        select(c.origin.target);
      }
    },
    [target, loading, select],
  );

  const scrollToFile = useCallback((e: FileEntry) => {
    setActiveKey(e.key);
    pane.current?.scrollToFile(e.key);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.closest("textarea, select, [contenteditable], input:not([type=checkbox])")) return;
      const at = entries.findIndex((x) => x.key === activeKey);
      const handlers: Record<string, () => void> = {
        j: () => entries[at + 1] && scrollToFile(entries[at + 1]!),
        k: () => entries[Math.max(0, at - 1)] && scrollToFile(entries[Math.max(0, at - 1)]!),
        v: () => entries[at] && void toggleViewed(entries[at]!),
        u: () => setDiffStyle((s) => (s === "unified" ? "split" : "unified")),
        r: reload,
        "/": () => {
          setRailOpen(true);
          requestAnimationFrame(() => filter.current?.focus());
        },
        b: () => setRailOpen((o) => !o),
        c: () => setPanel((p) => (p === "review" ? null : "review")),
        "?": () => setPanel((p) => (p === "help" ? null : "help")),
        Escape: () => setPanel(null),
      };
      const h = handlers[e.key];
      if (h) {
        e.preventDefault();
        // A clicked row or button would otherwise show a focus ring once a key is pressed.
        if (el !== document.body) el.blur();
        h();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [entries, activeKey, scrollToFile, toggleViewed, reload, setDiffStyle]);

  if (!repo) {
    return (
      <div className="boot">
        {repoError ? (
          <>
            <div className="empty-title">Cannot reach the turndiff server</div>
            <div className="dim">{repoError}</div>
            <button className="btn" onClick={() => void refreshState()}>
              Retry
            </button>
          </>
        ) : (
          <div className="dim">Loading repository…</div>
        )}
      </div>
    );
  }

  const stale = !!view && repo.version !== view.version;
  // Commit views name the branch each commit belongs to.
  const onBranches =
    view?.target.kind === "commits" ? [...new Set(view.sections.map((s) => s.branch ?? repo.trunk))].join(", ") : null;
  const commits = new Set(view?.sections.flatMap((s) => s.commits.map((c) => c.oid)) ?? []).size;
  const working = !!view?.sections.some((s) => s.includesWorking);
  const add = entries.reduce((n, e) => n + e.file.additions, 0);
  const del = entries.reduce((n, e) => n + e.file.deletions, 0);
  const toolbar = (
    <div className="toolbar">
      <button className={`btn icon rail-toggle${railOpen ? " on" : ""}`} onClick={() => setRailOpen((o) => !o)} aria-label="Toggle sidebar (b)" title="Sidebar  b">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" />
          <path d="M5 2.5v9" stroke="currentColor" />
        </svg>
      </button>
      <span className="title" title={view?.title}>
        {view?.title ?? (target ? targetToHash(target) : "")}
        {onBranches && <span className="dim"> · on {onBranches}</span>}
      </span>
      {view && (
        <span className="meta">
          {(commits > 0 || working) && (
            <span className="m-text">
              {commits > 0 && `${commits} commit${commits === 1 ? "" : "s"}`}
              {working && `${commits > 0 ? " + " : ""}uncommitted`}
            </span>
          )}
          <span className="m-text">
            {entries.length} file{entries.length === 1 ? "" : "s"}
          </span>
          <Counts add={add} del={del} />
        </span>
      )}
      <span className="grow" />
      {stale && (
        <button className="pill" onClick={reload} title="Reload the view (r)">
          new changes · r
        </button>
      )}
      {repoError && <span className="offline" title={repoError}>offline</span>}
      <div className="seg" role="group" aria-label="Diff layout">
        <button className={diffStyle === "unified" ? "on" : ""} aria-pressed={diffStyle === "unified"} onClick={() => setDiffStyle("unified")}>
          unified
        </button>
        <button className={diffStyle === "split" ? "on" : ""} aria-pressed={diffStyle === "split"} onClick={() => setDiffStyle("split")}>
          split
        </button>
      </div>
      <button className={`toggle${wrap ? " on" : ""}`} aria-pressed={wrap} onClick={() => setWrap((w) => !w)} title="Wrap long lines">
        wrap
      </button>
      <button className={`toggle${ws ? " on" : ""}`} aria-pressed={ws} onClick={() => setWs((w) => !w)} title="Ignore whitespace changes">
        ws
      </button>
      <button className={`btn review-btn${panel === "review" ? " on" : ""}`} onClick={() => setPanel((p) => (p === "review" ? null : "review"))} title="Review  c">
        Review
        {review.comments.length > 0 && <span className="badge">{review.comments.length}</span>}
      </button>
    </div>
  );

  return (
    <div className="app">
      {railOpen && (
        <>
          <Rail
            ref={filter}
            repo={repo}
            target={target}
            onSelect={select}
            entries={entries}
            sections={view?.sections.length ?? 0}
            activeKey={activeKey}
            isViewed={(e) => viewed.has(fileViewedKey(e))}
            commentCount={(e) => commentsFor(commentIndex, e.file).length}
            onFile={scrollToFile}
            onToggleViewed={(e) => void toggleViewed(e)}
            width={railWidth}
          />
          <ResizeHandle value={railWidth} onChange={setRailWidth} />
        </>
      )}
      {view && !viewError ? (
        <DiffPane
          ref={pane}
          view={view}
          entries={entries}
          review={review}
          viewed={viewed}
          prefs={{ diffStyle, wrap }}
          toolbar={toolbar}
          busy={loading}
          onActive={setActiveKey}
          actions={actions}
        />
      ) : (
        <main className="pane">
          {toolbar}
          <div className="empty">
            {viewError ? (
              <>
                <div className="empty-title">Could not load this view</div>
                <div className="dim">{viewError}</div>
                <button className="btn" onClick={reload}>
                  Retry
                </button>
              </>
            ) : (
              <div className="dim">Loading…</div>
            )}
          </div>
        </main>
      )}
      {panel === "review" && (
        <ReviewPanel repo={repo} review={review} onReview={setReview} onOpen={openComment} onClose={() => setPanel(null)} />
      )}
      {panel === "help" && <Help onClose={() => setPanel(null)} />}
    </div>
  );
}

const KEYS: [string, string][] = [
  ["j / k", "next / previous file"],
  ["v", "toggle viewed"],
  ["u", "unified / split"],
  ["r", "reload the view"],
  ["/", "filter files"],
  ["b", "toggle sidebar"],
  ["c", "review panel"],
  ["⌘↵", "save comment"],
  ["esc", "close"],
  ["?", "this list"],
];

function Help({ onClose }: { onClose(): void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        {KEYS.map(([k, d]) => (
          <div key={k} className="help-row">
            <kbd>{k}</kbd>
            <span>{d}</span>
          </div>
        ))}
        <div className="help-row dim">Click or drag line numbers to comment. Shift-click commits or turns for a range.</div>
      </div>
    </div>
  );
}

function ResizeHandle({ value, onChange }: { value: number; onChange(n: number): void }) {
  const start = useRef({ x: 0, w: value });
  const clamp = (n: number) => Math.max(220, Math.min(560, n));
  return (
    <div
      className="resize"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      tabIndex={-1}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(clamp(start.current.w + e.clientX - start.current.x));
      }}
      onDoubleClick={() => onChange(300)}
    />
  );
}
