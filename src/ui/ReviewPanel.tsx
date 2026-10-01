import { useEffect, useRef, useState } from "react";
import type { Comment, Decision, RepoState, ReviewState } from "../model.ts";
import { api, copyText } from "./api.ts";
import { stripPrefix } from "./stack.ts";

const DECISIONS: { d: Decision; label: string }[] = [
  { d: "comment", label: "Comment" },
  { d: "request_changes", label: "Request changes" },
  { d: "approve", label: "Approve" },
];

export function ReviewPanel({
  repo,
  prefix,
  review,
  submittedMarkdown,
  onSubmitted,
  onReview,
  onOpen,
  onClose,
}: {
  repo: RepoState;
  prefix: string;
  review: ReviewState;
  submittedMarkdown: string | null;
  onSubmitted(markdown: string): void;
  onReview(r: ReviewState): void;
  onOpen(c: Comment): void;
  onClose(): void;
}) {
  const [summary, setSummary] = useState(review.summary);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const s = pending.current;
    pending.current = null;
    if (s !== null) onReview(await api.setSummary(s));
  };
  useEffect(() => () => void flush().catch(() => {}), []);

  const onSummary = (v: string) => {
    setSummary(v);
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush().catch((e) => setStatus({ kind: "err", text: e.message })), 500);
  };

  const submit = async (d: Decision) => {
    setBusy(true);
    setStatus(null);
    try {
      await flush();
      const res = await api.submit(d, summary);
      onSubmitted(res.markdown);
      if (res.delivered) setStatus({ kind: "ok", text: "Sent to the agent." });
      else if (await copyText(res.markdown)) setStatus({ kind: "ok", text: "No agent waiting. Copied; the next turndiff review also gets it." });
      else setStatus({ kind: "err", text: "No agent was waiting and the clipboard is unavailable. Use Copy submitted." });
      const next = await api.review();
      setSummary(next.summary);
      onReview(next);
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await flush();
      const markdown = hasDraft || submittedMarkdown === null ? (await api.feedback("comment")).markdown : submittedMarkdown;
      setStatus((await copyText(markdown)) ? { kind: "ok", text: "Feedback copied." } : { kind: "err", text: "Clipboard unavailable." });
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    }
  };

  const outdated = new Set(review.outdated);
  const hasDraft = review.comments.length > 0 || summary.length > 0;
  const order = repo.branches.map((b) => b.name);
  const groups = new Map<string | null, Comment[]>();
  for (const c of review.comments) groups.set(c.origin.branch, [...(groups.get(c.origin.branch) ?? []), c]);
  const keys = [...groups.keys()].sort((a, b) => rank(order, a) - rank(order, b));

  return (
    <div className="drawer" role="dialog" aria-label="Review">
      <header className="drawer-head">
        <span className="drawer-title">Review</span>
        <span className="dim">
          {review.comments.length} comment{review.comments.length === 1 ? "" : "s"}
          {keys.length > 1 ? ` on ${keys.length} branches` : ""}
        </span>
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={() => void copy()} title="Copy the feedback as markdown">
          {hasDraft || submittedMarkdown === null ? "Copy" : "Copy submitted"}
        </button>
        <button className="btn icon" onClick={onClose} aria-label="Close review">
          ×
        </button>
      </header>
      <div className="drawer-body">
        {keys.length === 0 && <div className="drawer-empty">No comments yet. Select lines in the gutter to comment.</div>}
        {keys.map((k) => (
          <div key={k ?? "(none)"} className="rgroup">
            <div className="rgroup-title" title={k ?? undefined}>
              {k ? stripPrefix(k, prefix) : "detached"}
            </div>
            {groups.get(k)!.map((c) => (
              <button key={c.id} className="ritem" onClick={() => onOpen(c)}>
                <div className="ritem-head">
                  <span className="rloc">
                    {c.anchor.path}:{c.anchor.start}
                    {c.anchor.end !== c.anchor.start ? `–${c.anchor.end}` : ""}
                  </span>
                  {c.anchor.side === "old" && <span className="tag">old</span>}
                  {outdated.has(c.id) && <span className="tag warn">outdated</span>}
                  {c.origin.working && <span className="tag">uncommitted</span>}
                </div>
                {c.snippet.length > 0 && (
                  <pre className="rsnippet">
                    {c.snippet.slice(0, 3).join("\n")}
                    {c.snippet.length > 3 ? "\n…" : ""}
                  </pre>
                )}
                <div className="rbody">{c.body}</div>
              </button>
            ))}
          </div>
        ))}
      </div>
      <footer className="drawer-foot">
        <textarea
          className="summary"
          placeholder="Summary for the agent (optional)"
          value={summary}
          rows={4}
          disabled={busy}
          onChange={(e) => onSummary(e.target.value)}
        />
        {status ? (
          <div className={`status-line ${status.kind}`}>{status.text}</div>
        ) : (
          <div className="status-line agent-line">
            {repo.agentWaiting ? <span className="waiting" /> : null}
            {repo.agentWaiting ? "An agent is waiting. Submitting wakes it with this review." : "No agent is waiting. Submitting copies the feedback, and the next turndiff review picks it up."}
          </div>
        )}
        <div className="decisions">
          {DECISIONS.map(({ d, label }) => (
            <button
              key={d}
              className={`btn${d === (review.comments.length ? "request_changes" : "approve") ? " primary" : ""}`}
              disabled={busy}
              onClick={() => void submit(d)}
            >
              {label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

const rank = (order: string[], b: string | null) => (b === null ? order.length : Math.max(0, order.indexOf(b)));
