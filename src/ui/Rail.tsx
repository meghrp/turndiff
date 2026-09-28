import { forwardRef, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { Branch, Commit, RepoState, SessionSummary, Target } from "../model.ts";
import { CommitIndex, sameTarget, treeRows } from "./stack.ts";
import { splitPath } from "./lines.ts";
import { Chevron, CommentGlyph, Counts, StatusLetter, type FileEntry } from "./FileCard.tsx";

interface Props {
  repo: RepoState;
  target: Target | null;
  onSelect(t: Target): void;
  entries: FileEntry[];
  sections: number;
  activeKey: string | null;
  isViewed(e: FileEntry): boolean;
  commentCount(e: FileEntry): number;
  onFile(e: FileEntry): void;
  onToggleViewed(e: FileEntry): void;
  width: number;
}

export const Rail = forwardRef<HTMLInputElement, Props>(function Rail(p, filterRef) {
  const { repo } = p;
  const current = repo.branches.find((b) => b.current);
  return (
    <aside className="rail" style={{ width: p.width }}>
      <header className="rail-head">
        <span className="repo">{repo.name}</span>
        <span className="dim">{repo.worktree.branch ?? "detached"}</span>
        <span className="grow" />
        {repo.agentWaiting && <span className="waiting" title="An agent is waiting for your review" />}
      </header>
      <div className="rail-nav">
        <StackTree {...p} current={current} />
        {(repo.sessions.length > 0 || repo.lastReviewAt) && <Agent repo={repo} target={p.target} onSelect={p.onSelect} />}
      </div>
      <Files {...p} ref={filterRef} />
    </aside>
  );
});

function Row({
  active,
  depth = 0,
  onClick,
  children,
  className = "",
  title,
}: {
  active: boolean;
  depth?: number;
  onClick(e: MouseEvent): void;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`row ${className}${active ? " active" : ""}`}
      style={{ paddingLeft: 10 + Math.min(depth, 8) * 12 }}
      title={title}
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e as unknown as MouseEvent);
        }
      }}
    >
      {children}
    </div>
  );
}

function StackTree({ repo, target, onSelect, current }: Props & { current: Branch | undefined }) {
  const rows = useMemo(() => treeRows(repo), [repo]);
  const index = useMemo(() => new CommitIndex(repo), [repo]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(current && current.parent ? [current.name] : []));
  const [anchor, setAnchor] = useState<string | null>(null);
  const dirty = repo.worktree.changed;
  const is = (t: Target) => !!target && sameTarget(t, target);

  const pickCommit = (e: MouseEvent, c: Commit) => {
    if (e.shiftKey && anchor) {
      const r = index.range(anchor, c.oid);
      if (r) return onSelect(r);
    }
    setAnchor(c.oid);
    onSelect({ kind: "commits", from: c.oid, to: c.oid });
  };
  const inRange = (c: Commit) => target?.kind === "commits" && index.contains(target, c.oid);
  const workingRow = (depth: number) => (
    <Row active={is({ kind: "working" })} depth={depth} className="sub" onClick={() => onSelect({ kind: "working" })}>
      <span className="mark-working" />
      <span>uncommitted</span>
      <span className="dim">
        · {dirty} file{dirty === 1 ? "" : "s"}
      </span>
    </Row>
  );

  return (
    <div className="group">
      <div className="group-title">Stack</div>
      <Row active={is({ kind: "stack" })} onClick={() => onSelect({ kind: "stack" })}>
        <span className="glyph">≡</span>
        <span>entire stack</span>
        <span className="dim">· {repo.branches.filter((b) => b.parent).length} branches</span>
      </Row>
      {!current && dirty > 0 && workingRow(0)}
      {rows.map(({ branch: b, depth }) => {
        const trunk = !b.parent;
        const expanded = open.has(b.name);
        const t: Target = { kind: "branch", branch: b.name, working: b.current && dirty > 0 };
        return (
          <div key={b.name}>
            <Row
              active={target?.kind === "branch" && target.branch === b.name}
              depth={depth}
              className="branch"
              title={b.behind ? `${b.name} needs a restack onto ${b.parent}` : b.name}
              onClick={() => onSelect(t)}
            >
              <button
                className="chev"
                aria-label={expanded ? "Hide commits" : "Show commits"}
                aria-expanded={expanded}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(b.name)) n.delete(b.name);
                    else n.add(b.name);
                    return n;
                  });
                }}
              >
                <Chevron open={expanded} />
              </button>
              <span className={`glyph${b.current ? " current" : ""}`}>{b.current ? "■" : "□"}</span>
              <span className={`bname${b.current ? " current" : ""}`}>{b.name}</span>
              {b.pr && <span className="dim">#{b.pr.number}</span>}
              {b.behind && <span className="behind">restack</span>}
              <span className="grow" />
              {!trunk && <span className="dim num">{b.commits.length}</span>}
            </Row>
            {b.current && dirty > 0 && workingRow(depth + 1)}
            {expanded &&
              b.commits.map((c) => (
                <Row
                  key={c.oid}
                  active={inRange(c)}
                  depth={depth + 1}
                  className="sub commit"
                  title={`${c.short} ${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString()}\nshift-click to select a range`}
                  onClick={(e) => pickCommit(e, c)}
                >
                  <span className="sha">{c.short}</span>
                  <span className="subject">{c.subject}</span>
                </Row>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function Agent({ repo, target, onSelect }: { repo: RepoState; target: Target | null; onSelect(t: Target): void }) {
  const [sessionId, setSessionId] = useState(repo.sessions[0]?.id ?? null);
  const session: SessionSummary | undefined = repo.sessions.find((s) => s.id === sessionId) ?? repo.sessions[0];
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => {
    if (target?.kind === "turns" && target.session !== sessionId) setSessionId(target.session);
  }, [target]);
  const turns = session ? [...session.turns].reverse() : [];
  const pick = (e: MouseEvent, n: number) => {
    if (!session) return;
    if (e.shiftKey && anchor !== null) {
      return onSelect({ kind: "turns", session: session.id, from: Math.min(anchor, n), to: Math.max(anchor, n) });
    }
    setAnchor(n);
    onSelect({ kind: "turns", session: session.id, from: n, to: n });
  };
  const inRange = (n: number) =>
    target?.kind === "turns" && target.session === session?.id && n >= target.from && n <= target.to;
  return (
    <div className="group">
      <div className="group-title">
        Agent
        {repo.sessions.length > 1 && (
          <select className="session-pick" value={session?.id} onChange={(e) => setSessionId(e.target.value)}>
            {repo.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.slice(0, 8)} · {s.turns.length} turns
              </option>
            ))}
          </select>
        )}
      </div>
      {repo.lastReviewAt && (
        <Row active={target?.kind === "since-review"} onClick={() => onSelect({ kind: "since-review" })} title={`Last review ${new Date(repo.lastReviewAt).toLocaleString()}`}>
          <span className="glyph">◷</span>
          <span>since last review</span>
          <span className="dim">· {ago(repo.lastReviewAt)}</span>
        </Row>
      )}
      {turns.map((t) => (
        <Row key={t.n} active={inRange(t.n)} onClick={(e) => pick(e, t.n)} className="turn" title={`${t.prompt ?? "(no prompt)"}\nshift-click to select a range`}>
          <span className="num turn-n">{t.n}</span>
          <span className="subject">{t.prompt ?? <i className="dim">no prompt</i>}</span>
          {!t.endedAt && <span className="running" title="Still running" />}
        </Row>
      ))}
    </div>
  );
}

const Files = forwardRef<HTMLInputElement, Props>(function Files(
  { entries, sections, activeKey, isViewed, commentCount, onFile, onToggleViewed },
  ref,
) {
  const [q, setQ] = useState("");
  const shown = q ? entries.filter((e) => e.file.path.toLowerCase().includes(q.toLowerCase())) : entries;
  const viewedCount = entries.filter(isViewed).length;
  let lastSection: string | null = null;
  return (
    <div className="files">
      <div className="group-title">
        Files
        <span className="dim">
          {viewedCount}/{entries.length} viewed
        </span>
      </div>
      <input
        ref={ref}
        className="filter"
        placeholder="Filter files  /"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQ("");
            e.currentTarget.blur();
          }
          if (e.key === "Enter" && shown[0]) {
            onFile(shown[0]);
            e.currentTarget.blur();
          }
        }}
      />
      <div className="file-list">
        {shown.map((e) => {
          const [dir, name] = splitPath(e.file.path);
          const head = sections > 1 && e.section.id !== lastSection ? e.section.branch ?? e.section.title : null;
          lastSection = e.section.id;
          const n = commentCount(e);
          const viewed = isViewed(e);
          return (
            <div key={e.key}>
              {head && <div className="file-group">{head}</div>}
              <div
                className={`row file${e.key === activeKey ? " active" : ""}${viewed ? " is-viewed" : ""}`}
                role="button"
                tabIndex={0}
                title={e.file.path}
                onClick={() => onFile(e)}
              >
                <StatusLetter status={e.file.status} />
                <span className="fname">
                  {name}
                  {dir && <span className="dim"> {dir.replace(/\/$/, "")}</span>}
                </span>
                <span className="grow" />
                {n > 0 && (
                  <span className="ccount">
                    <CommentGlyph />
                    {n}
                  </span>
                )}
                <Counts add={e.file.additions} del={e.file.deletions} />
                <button
                  className={`check${viewed ? " on" : ""}`}
                  aria-label={viewed ? "Mark not viewed" : "Mark viewed"}
                  aria-pressed={viewed}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onToggleViewed(e);
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                    <path d="M2 5.2 4.2 7.4 8 2.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
        {entries.length > 0 && shown.length === 0 && <div className="rail-empty">No files match “{q}”</div>}
      </div>
    </div>
  );
});

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
