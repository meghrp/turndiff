import { forwardRef, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Branch, Commit, RepoState, SessionSummary, Target } from "../model.ts";
import { CommitIndex, currentStack, sameTarget, sharedPrefix, stripPrefix, treeGuides, treeRows, type Guides, type TreeItem } from "./stack.ts";
import { splitPath } from "./lines.ts";
import { ago } from "./names.tsx";
import { Chevron, CommentGlyph, Counts, NoteGlyph, StatusLetter, type FileEntry } from "./FileCard.tsx";

interface Props {
  repo: RepoState;
  target: Target | null;
  onSelect(t: Target): void;
  entries: FileEntry[];
  sections: number;
  activeKey: string | null;
  isViewed(e: FileEntry): boolean;
  commentCount(e: FileEntry): number;
  noteCount(e: FileEntry): number;
  onFile(e: FileEntry): void;
  onToggleViewed(e: FileEntry): void;
  width: number;
}

export const Rail = forwardRef<HTMLInputElement, Props>(function Rail(p, filterRef) {
  const { repo } = p;
  const current = repo.branches.find((b) => b.current);
  const prefix = sharedPrefix(repo);
  return (
    <aside className="rail" style={{ width: p.width }}>
      <header className="rail-head">
        <span className="repo">{repo.name}</span>
        <span className="dim head-branch" title={repo.worktree.branch ?? undefined}>
          {repo.worktree.branch ? stripPrefix(repo.worktree.branch, prefix) : "detached"}
        </span>
        <span className="grow" />
        {repo.agentWaiting && <span className="waiting" title="An agent is waiting for your review" />}
      </header>
      <div className="rail-nav">
        <StackTree {...p} current={current} prefix={prefix} />
        {(repo.sessions.length > 0 || repo.lastReviewAt) && <Agent repo={repo} target={p.target} onSelect={p.onSelect} />}
      </div>
      <Files {...p} prefix={prefix} ref={filterRef} />
    </aside>
  );
});

const INDENT = 10;
const COL = 14;
const colX = (c: number) => INDENT + c * COL + 6;

function Row({
  active,
  indent = INDENT,
  guides,
  onClick,
  children,
  className = "",
  title,
}: {
  active: boolean;
  indent?: number;
  guides?: Guides;
  onClick(e: { shiftKey: boolean }): void;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`row ${className}${active ? " active" : ""}`}
      style={{ paddingLeft: indent }}
      title={title}
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e);
        }
      }}
    >
      {guides && <TreeLines g={guides} />}
      {children}
    </div>
  );
}

function TreeLines({ g }: { g: Guides }) {
  return (
    <>
      {g.through.map((c) => (
        <i key={`t${c}`} className="tl tl-v" style={{ left: colX(c) }} />
      ))}
      {g.elbow !== null && (
        <>
          <i className="tl tl-down" style={{ left: colX(g.elbow) }} />
          <i className="tl tl-h" style={{ left: colX(g.elbow), width: COL - 6 }} />
        </>
      )}
      {g.stub !== null && <i className="tl tl-up" style={{ left: colX(g.stub) }} />}
    </>
  );
}

function StackTree({ repo, target, onSelect, current, prefix }: Props & { current: Branch | undefined; prefix: string }) {
  const index = useMemo(() => new CommitIndex(repo), [repo]);
  const inStack = useMemo(() => currentStack(repo), [repo]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(current && current.parent ? [current.name] : []));
  const [anchor, setAnchor] = useState<string | null>(null);
  const dirty = repo.worktree.changed;
  const is = (t: Target) => !!target && sameTarget(t, target);

  const items = useMemo(() => {
    const out: TreeItem[] = [];
    for (const { branch, depth: raw } of treeRows(repo)) {
      const depth = Math.min(raw, 8);
      out.push({ kind: "branch", branch, depth });
      if (branch.current && dirty > 0) out.push({ kind: "working", depth });
      if (open.has(branch.name)) for (const commit of branch.commits) out.push({ kind: "commit", commit, depth });
    }
    return out;
  }, [repo, open, dirty]);
  const guides = useMemo(() => treeGuides(items), [items]);
  const ownerOf = (i: number) => {
    for (let k = i; k >= 0; k--) {
      const it = items[k]!;
      if (it.kind === "branch") return it.branch;
    }
    return null;
  };

  const pickCommit = (e: { shiftKey: boolean }, c: Commit) => {
    if (e.shiftKey && anchor) {
      const r = index.range(anchor, c.oid);
      if (r) return onSelect(r);
    }
    setAnchor(c.oid);
    onSelect({ kind: "commits", from: c.oid, to: c.oid });
  };
  const inRange = (c: Commit) => target?.kind === "commits" && index.contains(target, c.oid);
  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const workingRow = (key: string, indent: number, g?: Guides) => (
    <Row key={key} active={is({ kind: "working" })} indent={indent} guides={g} className="sub" onClick={() => onSelect({ kind: "working" })}>
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
        <span className="dim">
          · {inStack.size} branch{inStack.size === 1 ? "" : "es"}
        </span>
      </Row>
      {!current && dirty > 0 && workingRow("working", INDENT)}
      {items.map((it, i) => {
        const g = guides[i];
        const subIndent = INDENT + it.depth * COL + 18;
        if (it.kind === "working") return workingRow("working", subIndent, g);
        if (it.kind === "commit") {
          const c = it.commit;
          const owner = ownerOf(i);
          return (
            <Row
              key={c.oid}
              active={inRange(c)}
              indent={subIndent}
              guides={g}
              className={`sub commit${owner?.parent && !inStack.has(owner.name) ? " off" : ""}`}
              title={`${c.short} ${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString()}\nshift-click to select a range`}
              onClick={(e) => pickCommit(e, c)}
            >
              <span className="sha">{c.short}</span>
              <span className="subject">{c.subject}</span>
            </Row>
          );
        }
        const b = it.branch;
        const trunk = !b.parent;
        const expanded = open.has(b.name);
        const t: Target = { kind: "branch", branch: b.name, working: b.current && dirty > 0 };
        return (
          <Row
            key={b.name}
            active={target?.kind === "branch" && target.branch === b.name}
            indent={INDENT + it.depth * COL}
            guides={g}
            className={`branch${!trunk && !inStack.has(b.name) ? " off" : ""}`}
            title={[b.name, b.pr && `#${b.pr.number}`, b.behind && `needs a restack onto ${b.parent}`].filter(Boolean).join("\n")}
            onClick={() => onSelect(t)}
          >
            <span className={`glyph${b.current ? " current" : ""}`}>{b.current ? "■" : "□"}</span>
            <span className={`bname${b.current ? " current" : ""}`}>{stripPrefix(b.name, prefix)}</span>
            {b.pr && <span className="dim pr">#{b.pr.number}</span>}
            {b.behind && <span className="behind">restack</span>}
            <span className="grow" />
            {!trunk && <span className="dim num">{b.commits.length}</span>}
            <button
              className="chev"
              aria-label={expanded ? "Hide commits" : "Show commits"}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle(b.name);
              }}
            >
              <Chevron open={expanded} />
            </button>
          </Row>
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
  const pick = (e: { shiftKey: boolean }, n: number) => {
    if (!session) return;
    if (e.shiftKey && anchor !== null) {
      return onSelect({ kind: "turns", session: session.id, from: Math.min(anchor, n), to: Math.max(anchor, n) });
    }
    setAnchor(n);
    onSelect({ kind: "turns", session: session.id, from: n, to: n });
  };
  const inRange = (n: number) => target?.kind === "turns" && target.session === session?.id && n >= target.from && n <= target.to;
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
        <Row
          active={target?.kind === "since-review"}
          onClick={() => onSelect({ kind: "since-review" })}
          title={`Last review ${new Date(repo.lastReviewAt).toLocaleString()}`}
        >
          <span className="glyph">◷</span>
          <span>since last review</span>
          <span className="dim">· {ago(repo.lastReviewAt)}</span>
        </Row>
      )}
      {turns.map((t) => (
        <Row
          key={t.n}
          active={inRange(t.n)}
          onClick={(e) => pick(e, t.n)}
          className="turn"
          title={`${t.prompt ?? "(no prompt)"}\nshift-click to select a range`}
        >
          <span className="num turn-n">{t.n}</span>
          <span className="subject">{t.prompt ?? <i className="dim">no prompt</i>}</span>
          {!t.endedAt && <span className="running" title="Still running" />}
        </Row>
      ))}
    </div>
  );
}

const Files = forwardRef<HTMLInputElement, Props & { prefix: string }>(function Files(
  { entries, sections, activeKey, isViewed, commentCount, noteCount, onFile, onToggleViewed, prefix },
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
          const head = sections > 1 && e.section.id !== lastSection ? (e.section.branch ?? e.section.title) : null;
          lastSection = e.section.id;
          const n = commentCount(e);
          const notes = noteCount(e);
          const viewed = isViewed(e);
          return (
            <div key={e.key}>
              {head && (
                <div className="file-group" title={head}>
                  {stripPrefix(head, prefix)}
                </div>
              )}
              {e.group && !q && (
                <div className="file-subgroup" title={e.group}>
                  {e.group}
                </div>
              )}
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
                {notes > 0 && (
                  <span className="ncount" title={`${notes} author note${notes === 1 ? "" : "s"}`}>
                    <NoteGlyph />
                    {notes}
                  </span>
                )}
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
