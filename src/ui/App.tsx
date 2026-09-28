import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from "@pierre/diffs/react";
import {
  scopeKey,
  type Decision,
  type DiffResponse,
  type ReviewComment,
  type ReviewDraft,
  type Scope,
  type StateResponse,
} from "../shared.ts";
import {
  cancelReview,
  fetchDiff,
  fetchFile,
  fetchSnapshot,
  fetchState,
  readPreference,
  savePreference,
  scopeFromHash,
  scopeToHash,
  submitReview,
} from "./store.ts";
import { indexPatch } from "./patchLines.ts";
import { draftKey, reconcileReview } from "./reviewState.ts";
import { useReview } from "./useReview.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { FileList } from "./components/FileList.tsx";
import { Composer, Thread } from "./components/Comments.tsx";
import { Modal, SubmitDialog } from "./components/SubmitDialog.tsx";

type Meta = { id: string };
const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;
const revision = (d: DiffResponse) => `${d.baseOid}..${d.headOid}`;

export function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [scope, setScope] = useState<Scope | null>(() => scopeFromHash(location.hash));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchState();
        if (!active) return;
        setState(next);
        setError(null);
        setScope((s) => {
          if (s) return s;
          const initial = next.preselect ?? defaultScope(next);
          if (initial) history.replaceState(null, "", scopeToHash(initial));
          return initial;
        });
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, 4000);
    const navigate = () => {
      const next = scopeFromHash(location.hash);
      setScope((cur) => (cur && next && scopeKey(cur) === scopeKey(next) ? cur : next));
    };
    window.addEventListener("popstate", navigate);
    window.addEventListener("hashchange", navigate);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("hashchange", navigate);
    };
  }, []);
  const select = (next: Scope) => {
    if (scope && scopeKey(scope) === scopeKey(next)) return;
    history.pushState(null, "", scopeToHash(next));
    setScope(next);
  };
  if (!state)
    return (
      <div className="nothing" role="status">
        {error ?? "Loading repository…"}
        {error && (
          <button className="btn" onClick={() => location.reload()}>
            Retry
          </button>
        )}
      </div>
    );
  if (!scope)
    return (
      <div className="nothing">
        <h2>Nothing to review yet</h2>
        <Sidebar sessions={state.sessions} stack={state.stack} scope={null} currentBranch={state.repo.branch} onSelect={select} />
      </div>
    );
  return <Workspace key={scopeKey(scope)} state={state} scope={scope} onSelect={select} connectionError={error} />;
}

function Workspace({
  state,
  scope,
  onSelect,
  connectionError,
}: {
  state: StateResponse;
  scope: Scope;
  onSelect: (s: Scope) => void;
  connectionError: string | null;
}) {
  const saved = useReview(state.repo.root, scope);
  const { review, change } = saved;
  const [full, setFull] = useState<DiffResponse | null>(null);
  const fullRef = useRef(full);
  fullRef.current = full;
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [pending, setPending] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">(() =>
    readPreference("style", "unified") === "split" ? "split" : "unified",
  );
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const draft = review.drafts.find((d) => draftKey(d) === activeDraft) ?? null;
  const [dialog, setDialog] = useState<"submit" | "drafts" | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState<"sent" | "cancelled" | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(() => matchMedia("(min-width: 1100px)").matches);
  const [filebar, setFilebar] = useState(() => matchMedia("(min-width: 800px)").matches);
  const [widths, setWidths] = useState([272, 264]);
  const viewRef = useRef<CodeViewHandle<Meta, undefined>>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const accept = useCallback(
    (next: DiffResponse) => {
      change((old) => reconcileReview(old, next));
      fullRef.current = next;
      setFull(next);
      setPending(null);
    },
    [change],
  );
  const load = useCallback(async () => {
    const id = ++request.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setChecking(true);
    setError(null);
    try {
      const next = await fetchDiff(scope, false, abort.signal);
      if (id !== request.current || abort.signal.aborted) return;
      if (scopeKey(next.scope) !== scopeKey(scope)) throw new Error("The server returned a different review. Reload to retry.");
      if (!fullRef.current) accept(next);
      else if (next.patch !== fullRef.current.patch) setPending(next);
      else {
        setPending(null);
        if (next.label !== fullRef.current.label) {
          fullRef.current = next;
          setFull(next);
        }
      }
    } catch (e) {
      if (id === request.current && !abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (id === request.current && !abort.signal.aborted) {
        setChecking(false);
        if (!fullRef.current) setLoading(false);
      }
    }
  }, [scope, accept]);
  useEffect(() => {
    if (!saved.ready) return;
    void load();
    // Poll even after a live turn completes, so its final snapshot is not missed.
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !busyRef.current) void load();
    }, 5000);
    return () => {
      ++request.current;
      controller.current?.abort();
      clearInterval(id);
    };
  }, [saved.ready, load]);
  useEffect(() => {
    if (!full) return;
    const abort = new AbortController();
    setLoading(true);
    if (!ignoreWs) {
      setDiff(full);
      setLoading(false);
      return () => abort.abort();
    }
    fetchSnapshot(full, abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) {
          setDiff(next);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setLoading(false);
          setDiff(null);
        }
      });
    return () => abort.abort();
  }, [full, ignoreWs]);
  useEffect(() => {
    const narrow = matchMedia("(max-width: 1099px)");
    const small = matchMedia("(max-width: 799px)");
    const collapse = () => {
      if (narrow.matches) setSidebar(false);
      if (small.matches) setFilebar(false);
    };
    narrow.addEventListener("change", collapse);
    small.addEventListener("change", collapse);
    return () => {
      narrow.removeEventListener("change", collapse);
      small.removeEventListener("change", collapse);
    };
  }, []);
  const viewed = useMemo(() => new Set(review.viewed), [review.viewed]);
  const parsed = useMemo(
    () => (diff ? parsePatchFiles(diff.patch, `${scopeKey(scope)}:${revision(diff)}:${ignoreWs}`).flatMap((p) => p.files) : []),
    [diff, scope, ignoreWs],
  );
  const index = useMemo(() => (full ? indexPatch(full.patch) : null), [full]);
  const items = useMemo<CodeViewItem<Meta>[]>(
    () =>
      parsed.map((f) => ({
        id: f.name,
        type: "diff",
        fileDiff: f,
        annotations: review.comments
          .filter((c) => c.file === f.name && !c.outdated)
          .map((c) => ({ side: c.side, lineNumber: c.lineEnd, metadata: { id: c.id } })),
        version: review.updatedAt,
        collapsed: viewed.has(f.name),
      })),
    [parsed, review.comments, review.updatedAt, viewed],
  );
  const options = useMemo<CodeViewReactOptions<Meta, undefined>>(
    () => ({
      theme: THEME,
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      stickyHeaders: true,
      hunkSeparators: "line-info",
      enableLineSelection: true,
      lineHoverHighlight: "number",
      layout: { paddingTop: 12, paddingBottom: 100, gap: 14 },
      async loadDiffFiles(file: FileDiffMetadata) {
        const [oldC, newC] = await Promise.all([fetchFile(diff!.baseOid, file.prevName ?? file.name), fetchFile(diff!.headOid, file.name)]);
        return {
          oldFile: oldC === null ? null : { name: file.prevName ?? file.name, contents: oldC, cacheKey: `${diff!.baseOid}:${file.name}` },
          newFile: { name: file.name, contents: newC ?? "", cacheKey: `${diff!.headOid}:${file.name}` },
        };
      },
    }),
    [diffStyle, wrap, diff?.baseOid, diff?.headOid],
  );
  const onSelection = useCallback(
    (sel: { id: string; range: { start: number; end: number; side?: "additions" | "deletions" } } | null) => {
      if (!sel || !full || loading) return;
      const d: ReviewDraft = {
        file: sel.id,
        side: sel.range.side ?? "additions",
        lineStart: Math.min(sel.range.start, sel.range.end),
        lineEnd: Math.max(sel.range.start, sel.range.end),
        body: "",
        snippet: [],
        revision: revision(full),
      };
      for (let line = d.lineStart; line <= d.lineEnd; line++) {
        const text = index?.get(d.file, d.side, line);
        if (text !== undefined) d.snippet.push(text);
      }
      const key = draftKey(d);
      change((old) =>
        old.drafts.some((x) => draftKey(x) === key)
          ? old
          : { ...old, drafts: [...old.drafts.filter((x) => x.body.trim() || x.editingId), d] },
      );
      setActiveDraft(key);
    },
    [full, index, change, loading],
  );
  const addDrafts = (drafts: ReviewDraft[]) => {
    change((old) => {
      let comments = [...old.comments];
      for (const d of drafts) {
        if (!d.body.trim()) continue;
        const existing = d.editingId && comments.find((c) => c.id === d.editingId);
        if (existing) comments = comments.map((c) => (c.id === existing.id ? { ...c, body: d.body } : c));
        else comments.push({ ...d, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
      }
      const keys = new Set(drafts.map(draftKey));
      return { ...old, comments, drafts: old.drafts.filter((d) => !keys.has(draftKey(d))) };
    });
    setActiveDraft(null);
    viewRef.current?.clearSelectedLines();
  };
  const jump = (path: string) => {
    setActiveFile(path);
    // A selected file should open even if it was marked viewed.
    if (viewed.has(path)) change((old) => ({ ...old, viewed: old.viewed.filter((p) => p !== path) }));
    viewRef.current?.scrollTo({
      type: "item",
      id: path,
      align: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    if (matchMedia("(max-width: 799px)").matches) setFilebar(false);
  };
  const edit = (c: ReviewComment) => {
    const d: ReviewDraft = {
      file: c.file,
      side: c.side,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      editingId: c.id,
      body: c.body,
      snippet: c.snippet,
      outdated: c.outdated,
      revision: c.revision,
    };
    change((old) => (old.drafts.some((x) => x.editingId === c.id) ? old : { ...old, drafts: [...old.drafts, d] }));
    setDialog(null);
    setActiveDraft(draftKey(d));
    if (parsed.some((f) => f.name === c.file)) jump(c.file);
  };
  const renderAnnotation = useCallback(
    (a: DiffLineAnnotation<Meta> | { metadata?: Meta }) => {
      const c = review.comments.find((c) => c.id === a.metadata?.id);
      if (!c) return null;
      return (
        <Thread
          key={c.id}
          comment={c}
          onEdit={() => edit(c)}
          onDelete={() =>
            change((old) => ({
              ...old,
              comments: old.comments.filter((x) => x.id !== c.id),
              drafts: old.drafts.filter((d) => d.editingId !== c.id),
            }))
          }
        />
      );
    },
    [review.comments, change, parsed, viewed],
  );
  const unresolved = review.comments.filter((c) => c.outdated && !c.contextConfirmed);
  const readyToSend =
    !!diff &&
    !!full &&
    scopeKey(diff.scope) === scopeKey(scope) &&
    revision(diff) === revision(full) &&
    !loading &&
    !pending &&
    !error &&
    saved.ready;
  const openSend = () => {
    setSendError(null);
    setDialog(review.drafts.some((d) => d.body.trim()) ? "drafts" : "submit");
  };
  const submit = async (decision: Decision) => {
    if (busyRef.current || !readyToSend || unresolved.length || !diff || review.drafts.some((d) => d.body.trim())) return;
    busyRef.current = true;
    setBusy(true);
    setSendError(null);
    try {
      await saved.flush();
      // Check again at send time: polling is only a convenience, never the guard.
      const latest = await fetchDiff(scope, false);
      if (latest.patch !== full!.patch) {
        setPending(latest);
        setDialog(null);
        return;
      }
      await submitReview({
        decision,
        summary: review.summary,
        comments: review.comments,
        scope: diff.scope,
        label: diff.label,
        baseOid: diff.baseOid,
        headOid: diff.headOid,
      });
      saved.finish();
      setDialog(null);
      setDone("sent");
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await saved.flush();
      await cancelReview();
      setDone("cancelled");
    } catch (e) {
      setError(`Could not cancel: ${(e as Error).message}. Retry Cancel.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        !["TEXTAREA", "INPUT"].includes((e.target as HTMLElement)?.tagName) &&
        !dialog &&
        readyToSend
      ) {
        e.preventDefault();
        openSend();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  if (done)
    return (
      <div className="done">
        <h1>{done === "sent" ? "Feedback saved for the agent" : "Review cancelled"}</h1>
        <p>
          {done === "sent"
            ? "You can close this tab. The waiting CLI can collect your feedback."
            : "Your drafts are saved. Reopen the review to continue later."}
        </p>
      </div>
    );
  const files = diff?.files ?? [];
  const counts = new Map<string, number>();
  for (const c of review.comments) counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
  const selectScope = async (s: Scope) => {
    try {
      await saved.flush();
      onSelect(s);
    } catch {
      /* Keep the current review visible until it is saved. */
    }
  };
  return (
    <div
      className={`app ${sidebar ? "" : "hide-sidebar"} ${filebar ? "" : "hide-filebar"}`}
      style={{ "--sidebar-width": `${widths[0]}px`, "--filebar-width": `${widths[1]}px` } as CSSProperties}
    >
      <header className="topbar">
        <span className="brand">turndiff</span>
        <span className="repo">
          <b>{state.repo.name}</b> · {state.repo.branch}
        </span>
        <span className="spacer" />
        <span className="label" title={full?.label}>
          {full?.label}
        </span>
        <button className="btn" aria-expanded={sidebar} aria-controls="scope-panel" onClick={() => setSidebar((v) => !v)}>
          Turns / stack
        </button>
        <button className="btn" aria-expanded={filebar} aria-controls="file-panel" onClick={() => setFilebar((v) => !v)}>
          Files
        </button>
        <span className="seg">
          <button
            aria-pressed={diffStyle === "unified"}
            className={diffStyle === "unified" ? "on" : ""}
            onClick={() => {
              setDiffStyle("unified");
              savePreference("style", "unified");
            }}
          >
            Unified
          </button>
          <button
            aria-pressed={diffStyle === "split"}
            className={diffStyle === "split" ? "on" : ""}
            onClick={() => {
              setDiffStyle("split");
              savePreference("style", "split");
            }}
          >
            Split
          </button>
        </span>
        <span className="seg">
          <button aria-pressed={ignoreWs} className={ignoreWs ? "on" : ""} onClick={() => setIgnoreWs((v) => !v)}>
            Ignore whitespace
          </button>
          <button aria-pressed={wrap} className={wrap ? "on" : ""} onClick={() => setWrap((v) => !v)}>
            Wrap
          </button>
        </span>
        <button className="btn" disabled={checking || busy || !saved.ready} onClick={() => void load()}>
          Refresh
        </button>
        <button className="btn danger" disabled={busy || !saved.ready} onClick={() => void cancel()}>
          Cancel
        </button>
        <button data-review-submit className="btn primary" disabled={!readyToSend || busy || unresolved.length > 0} onClick={openSend}>
          Send feedback{review.comments.length ? ` (${review.comments.length})` : ""}
        </button>
      </header>
      <div id="scope-panel" className="scope-panel">
        <Sidebar
          sessions={state.sessions}
          stack={state.stack}
          scope={scope}
          currentBranch={state.repo.branch}
          onSelect={(s) => void selectScope(s)}
        />
        <ResizeHandle label="Resize turns sidebar" value={widths[0]!} onChange={(v) => setWidths([v, widths[1]!])} />
      </div>
      <div id="file-panel" className="file-panel">
        <FileList
          files={files}
          active={activeFile}
          viewed={viewed}
          commentCounts={counts}
          onJump={jump}
          onToggleViewed={(path) =>
            change((old) => ({ ...old, viewed: old.viewed.includes(path) ? old.viewed.filter((p) => p !== path) : [...old.viewed, path] }))
          }
        />
        <ResizeHandle label="Resize files sidebar" value={widths[1]!} onChange={(v) => setWidths([widths[0]!, v])} />
      </div>
      <main className="main" aria-busy={loading}>
        <div className="review-status">
          <span role="status">{saved.status}</span>
          <span>Click a line number or drag a range to comment.</span>
        </div>
        {(error || connectionError) && (
          <div className="banner error" role="alert">
            {error ?? `Connection lost: ${connectionError}`}
            <button className="btn" onClick={() => void load()} disabled={checking}>
              Retry
            </button>
          </div>
        )}
        {saved.error && (
          <div className="banner error" role="alert">
            {saved.error}
            <button
              className="btn"
              onClick={() => {
                if (!saved.ready) location.reload();
                else void saved.retry().catch(() => {});
              }}
            >
              Retry save
            </button>
          </div>
        )}
        {pending && (
          <div className="banner" role="status">
            <b>New changes available.</b> Your current review is unchanged.
            <button className="btn" onClick={() => accept(pending)} disabled={busy}>
              Load new changes
            </button>
          </div>
        )}
        {full?.replay && (
          <div className="banner">
            <b>Restack detected.</b> Upstream changes are excluded.
            {full.replay.conflicts && <strong>Replay conflicts: check conflict markers carefully.</strong>}
          </div>
        )}
        {scope.kind === "branch" && (scope.worktree || state.repo.branch === scope.name) && (
          <div className="banner">
            <label>
              <input
                type="checkbox"
                checked={scope.worktree}
                onChange={(e) => void selectScope({ ...scope, worktree: e.target.checked })}
              />{" "}
              Include uncommitted changes
            </label>
          </div>
        )}
        {review.comments.some((c) => c.outdated) && (
          <details className="review-tray" open={unresolved.length > 0}>
            <summary>Comments on changed code ({review.comments.filter((c) => c.outdated).length})</summary>
            <p>These comments retain their original code and line numbers. Check each before sending.</p>
            {review.comments
              .filter((c) => c.outdated)
              .map((c) => (
                <div className="outdated-comment" key={c.id}>
                  <b>
                    {c.file}:{c.lineStart}
                  </b>
                  <pre>{c.snippet.join("\n")}</pre>
                  <p>{c.body}</p>
                  <button className="btn" onClick={() => edit(c)}>
                    Edit
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      change((old) => ({
                        ...old,
                        comments: old.comments.filter((x) => x.id !== c.id),
                        drafts: old.drafts.filter((d) => d.editingId !== c.id),
                      }))
                    }
                  >
                    Delete
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!c.contextConfirmed}
                      onChange={(e) =>
                        change((old) => ({
                          ...old,
                          comments: old.comments.map((x) => (x.id === c.id ? { ...x, contextConfirmed: e.target.checked } : x)),
                        }))
                      }
                    />{" "}
                    Keep original context
                  </label>
                </div>
              ))}
          </details>
        )}
        {review.drafts.some((d) => d.body.trim()) && (
          <div className="draft-list" aria-label="Saved drafts">
            Saved drafts:{" "}
            {review.drafts
              .filter((d) => d.body.trim())
              .map((d) => (
                <button className="btn" key={draftKey(d)} onClick={() => setActiveDraft(draftKey(d))}>
                  {d.file}:{d.lineStart}
                </button>
              ))}
          </div>
        )}
        {loading && (
          <div className="loading" role="status">
            Computing diff…
          </div>
        )}
        {!loading && diff && !files.length && (
          <div className="nothing">
            <h2>No changes{ignoreWs ? " with whitespace ignored" : ""}</h2>
            {ignoreWs && (
              <button className="btn" onClick={() => setIgnoreWs(false)}>
                Show whitespace changes
              </button>
            )}
          </div>
        )}
        {diff && files.length > 0 && (
          <div className="codeview" style={{ visibility: loading ? "hidden" : "visible" }}>
            <CodeView<Meta, undefined>
              ref={viewRef}
              items={items}
              options={options}
              style={{ position: "absolute", inset: 0, overflow: "auto" }}
              onSelectedLinesChange={onSelection}
              renderAnnotation={renderAnnotation}
              renderHeaderMetadata={(item) => (
                <label className="mono" onPointerDown={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={viewed.has(item.id)}
                    onChange={() =>
                      change((old) => ({
                        ...old,
                        viewed: old.viewed.includes(item.id) ? old.viewed.filter((p) => p !== item.id) : [...old.viewed, item.id],
                      }))
                    }
                  />{" "}
                  viewed
                </label>
              )}
            />
          </div>
        )}
        {draft && (
          <div className="composer-dock">
            <Composer
              key={draftKey(draft)}
              target={draft}
              onChange={(body) =>
                change((old) => ({ ...old, drafts: old.drafts.map((d) => (draftKey(d) === activeDraft ? { ...d, body } : d)) }))
              }
              onSave={() => addDrafts([draft])}
              onCancel={() => setActiveDraft(null)}
            />
          </div>
        )}
      </main>
      {dialog === "drafts" && (
        <Modal title="Include unfinished comments?" onClose={() => setDialog(null)}>
          <div className="content">
            <p>
              You have {review.drafts.filter((d) => d.body.trim()).length} unfinished comment(s). Include them in your feedback or discard
              them explicitly.
            </p>
          </div>
          <footer>
            <button className="btn" onClick={() => setDialog(null)}>
              Keep editing
            </button>
            <button
              className="btn danger"
              onClick={() => {
                change((old) => ({ ...old, drafts: [] }));
                setActiveDraft(null);
                setDialog("submit");
              }}
            >
              Discard drafts
            </button>
            <button
              className="btn primary"
              onClick={() => {
                const outdated = review.drafts.some((d) => d.outdated && d.body.trim());
                addDrafts(review.drafts);
                setDialog(outdated ? null : "submit");
              }}
            >
              Include drafts
            </button>
          </footer>
        </Modal>
      )}
      {dialog === "submit" && (
        <SubmitDialog
          comments={review.comments}
          summary={review.summary}
          onSummary={(summary) => change((old) => ({ ...old, summary }))}
          onSubmit={(d) => void submit(d)}
          onClose={() => setDialog(null)}
          onEdit={edit}
          busy={busy}
          error={sendError}
          blocked={
            !readyToSend
              ? "The review changed or is still loading. Go back to check it before sending."
              : unresolved.length
                ? "Check comments on changed code before sending."
                : null
          }
        />
      )}
    </div>
  );
}
function ResizeHandle({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const start = useRef({ x: 0, width: value });
  const clamp = (n: number) => Math.max(200, Math.min(440, n));
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={200}
      aria-valuemax={440}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(clamp(value + (e.key === "ArrowLeft" ? -16 : 16)));
        }
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, width: value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(clamp(start.current.width + e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}
function defaultScope(s: StateResponse): Scope | null {
  const session = s.sessions[0],
    last = session?.turns.at(-1);
  if (session && last) return { kind: "turn", sessionId: session.id, from: last.turn, to: last.turn };
  const cur = s.stack.find((e) => e.isCurrent && !e.isTrunk);
  return cur ? { kind: "branch", name: cur.name, worktree: true } : null;
}
