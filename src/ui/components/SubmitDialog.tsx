import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Decision, ReviewComment } from "../../shared.ts";

export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      const target =
        previous?.isConnected && !previous.closest("dialog") ? previous : document.querySelector<HTMLElement>("[data-review-submit]");
      target?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")].filter(
          (el) => !el.matches(":disabled, [tabindex='-1'], input[type='radio']:not(:checked)") && el.getClientRects().length > 0,
        );
        e.preventDefault();
        if (!controls.length) {
          e.currentTarget.focus();
          return;
        }
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next =
          current < 0 ? (e.shiftKey ? controls.length - 1 : 0) : (current + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) {
          const r = ref.current.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
        }
      }}
    >
      <header id="dialog-title">{title}</header>
      {children}
    </dialog>
  );
}
const OPTIONS: Array<{ value: Decision; title: string; desc: string; action: string }> = [
  { value: "request_changes", title: "Request changes", desc: "Ask the agent to address feedback", action: "Send change request" },
  { value: "comment", title: "Comment", desc: "Feedback without a verdict", action: "Send comments" },
  { value: "approve", title: "Approve", desc: "This review looks good", action: "Send approval" },
];
export function SubmitDialog({
  comments,
  summary,
  onSummary,
  onSubmit,
  onClose,
  onEdit,
  busy,
  error,
  blocked,
}: {
  comments: ReviewComment[];
  summary: string;
  onSummary: (s: string) => void;
  onSubmit: (d: Decision) => void;
  onClose: () => void;
  onEdit: (c: ReviewComment) => void;
  busy: boolean;
  error: string | null;
  blocked: string | null;
}) {
  const [decision, setDecision] = useState<Decision>("comment");
  return (
    <Modal title="Send feedback to the agent" onClose={onClose} busy={busy}>
      <div className="content">
        <fieldset className="decisions" disabled={busy}>
          <legend>Review decision</legend>
          {OPTIONS.map((o) => (
            <label key={o.value} className={decision === o.value ? "on" : ""}>
              <input type="radio" name="decision" value={o.value} checked={decision === o.value} onChange={() => setDecision(o.value)} />
              <b>{o.title}</b>
              <span>{o.desc}</span>
            </label>
          ))}
        </fieldset>
        <label htmlFor="review-summary">Overall notes (optional)</label>
        <textarea
          id="review-summary"
          placeholder="Overall notes (optional). Anything not tied to a line."
          value={summary}
          disabled={busy}
          onChange={(e) => onSummary(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!busy && !blocked) onSubmit(decision);
            }
          }}
        />
        {comments.length > 0 && (
          <div className="summary-list" aria-label="Comments to send">
            {comments.map((c) => (
              <button key={c.id} disabled={busy} onClick={() => onEdit(c)}>
                <span className="loc">
                  {c.file}:{c.lineStart}
                  {c.lineEnd !== c.lineStart ? `–${c.lineEnd}` : ""}
                  {c.side === "deletions" ? " (removed)" : ""}
                </span>
                <span className="txt">{c.body}</span>
                <span>Edit comment</span>
              </button>
            ))}
          </div>
        )}
        {blocked && <p role="status">{blocked}</p>}
        {error && (
          <p role="alert" className="error-text">
            {error} Your feedback is retained. Try sending again.
          </p>
        )}
      </div>
      <footer>
        <button className="btn" disabled={busy} onClick={onClose}>
          Back
        </button>
        <button className="btn primary" disabled={busy || !!blocked} onClick={() => onSubmit(decision)}>
          {busy ? "Sending…" : OPTIONS.find((o) => o.value === decision)!.action}
        </button>
      </footer>
    </Modal>
  );
}
