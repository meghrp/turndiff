import { useEffect, useRef } from "react";
import type { ReviewComment, ReviewDraft } from "../../shared.ts";
export type DraftTarget = ReviewDraft;

export function Composer({
  target,
  onChange,
  onSave,
  onCancel,
}: {
  target: ReviewDraft;
  onChange: (body: string) => void;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="thread" onPointerDown={(e) => e.stopPropagation()}>
      <div className="head">
        <span className="loc">
          {target.file}:{target.lineStart}
          {target.lineEnd !== target.lineStart ? `–${target.lineEnd}` : ""}
        </span>
        {target.side === "deletions" && <span>removed lines</span>}
      </div>
      {target.outdated && <p role="status">Code changed since this draft was written. Its original context will be preserved.</p>}
      <textarea
        ref={ref}
        aria-label={`Comment on ${target.file}:${target.lineStart}`}
        value={target.body}
        placeholder="Leave a comment for the agent…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (target.body.trim()) onSave(target.body);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="actions">
        <span className="hint">Draft autosaves · Ctrl/⌘↵ to add</span>
        <button className="btn" onClick={onCancel}>
          Close draft
        </button>
        <button className="btn primary" disabled={!target.body.trim()} onClick={() => onSave(target.body)}>
          {target.editingId ? "Update" : "Add comment"}
        </button>
      </div>
    </div>
  );
}
export function Thread({ comment, onEdit, onDelete }: { comment: ReviewComment; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="thread" onPointerDown={(e) => e.stopPropagation()}>
      <div className="head">
        <span className="loc">
          {comment.file}:{comment.lineStart}
          {comment.lineEnd !== comment.lineStart ? `–${comment.lineEnd}` : ""}
        </span>
        {comment.side === "deletions" && <span>removed lines</span>}
        <span className="spacer" />
        <button onClick={onEdit}>Edit</button>
        <button onClick={onDelete}>Delete</button>
      </div>
      <div className="body">{comment.body}</div>
    </div>
  );
}
