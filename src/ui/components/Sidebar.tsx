import type { Session, Turn } from "../../git/checkpoints.ts";
import type { StackEntry } from "../../git/spice.ts";
import type { Scope } from "../../shared.ts";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function turnRebased(t: Turn): boolean {
  return Boolean(t.pre?.parentMergeBase && t.post?.parentMergeBase && t.pre.parentMergeBase !== t.post.parentMergeBase);
}

export function Sidebar({
  sessions,
  stack,
  scope,
  currentBranch,
  onSelect,
}: {
  sessions: Session[];
  stack: StackEntry[];
  scope: Scope | null;
  currentBranch: string | null;
  onSelect: (s: Scope) => void;
}) {
  const activeSessionId = scope?.kind === "turn" ? scope.sessionId : (sessions[0]?.id ?? null);
  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const turns = session ? [...session.turns].reverse() : [];

  return (
    <aside className="sidebar" aria-label="Review scope">
      <div className="section">
        <h3>
          Agent turns
          {session && <span className="sub">{session.turns.length} turns</span>}
        </h3>
        {sessions.length === 0 && (
          <div className="empty">
            No checkpoints yet. Run <code>turndiff install</code> and start a new Claude Code session.
          </div>
        )}
        {sessions.length > 1 && session && (
          <div className="session-head">
            <select
              aria-label="Agent session"
              value={session.id}
              onChange={(e) => {
                const s = sessions.find((x) => x.id === e.target.value);
                const last = s?.turns.at(-1);
                if (s && last) onSelect({ kind: "turn", sessionId: s.id, from: last.turn, to: last.turn });
              }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 8)} · {s.turns.length} turns · {timeAgo(s.updatedAt)}
                </option>
              ))}
            </select>
          </div>
        )}
        {session && sessions.length === 1 && (
          <div className="session-head">
            session <code>{session.id.slice(0, 12)}</code>
          </div>
        )}
        {session && <div className="range-hint">Click a turn · shift-click to review a range</div>}
        {turns.map((t) => {
          const on = scope?.kind === "turn" && scope.sessionId === session!.id && t.turn >= scope.from && t.turn <= scope.to;
          const live = !t.post;
          return (
            <button
              key={t.turn}
              className={`item ${on ? "on" : ""}`}
              aria-pressed={on}
              onClick={(e) => {
                if (e.shiftKey && scope?.kind === "turn" && scope.sessionId === session!.id) {
                  onSelect({ kind: "turn", sessionId: session!.id, from: Math.min(scope.from, t.turn), to: Math.max(scope.to, t.turn) });
                } else onSelect({ kind: "turn", sessionId: session!.id, from: t.turn, to: t.turn });
              }}
            >
              <div className="row">
                <span className="title">Turn {t.turn}</span>
                {live && <span className="tag live">live</span>}
                {turnRebased(t) && (
                  <span className="tag rebase" title="Base moved during this turn; upstream changes are hidden from the diff">
                    restacked
                  </span>
                )}
                <span className="meta">{timeAgo(t.startedAt)}</span>
              </div>
              <div className="prompt">{t.prompt ? t.prompt.replace(/\s+/g, " ") : <i>no prompt recorded</i>}</div>
            </button>
          );
        })}
      </div>

      <div className="section">
        <h3>
          Stack
          {currentBranch && <span className="sub">on {currentBranch}</span>}
        </h3>
        {stack.length === 0 && <div className="empty">No git-spice stack here.</div>}
        {stack.map((e) => {
          const on = scope?.kind === "branch" && scope.name === e.name;
          const worktree = on && scope.kind === "branch" ? scope.worktree : e.isCurrent;
          return (
            <div className="stack-entry" key={e.name}>
              <button
                aria-pressed={on}
                className={`item ${on ? "on" : ""}`}
                onClick={() => onSelect({ kind: "branch", name: e.name, worktree: e.isCurrent && worktree })}
                disabled={e.isTrunk}
              >
                <div className="row">
                  <span className="tree">{e.depth === 0 ? "◆" : `${"  ".repeat(e.depth - 1)}└`}</span>
                  <span className="title" title={e.name}>
                    {e.name}
                  </span>
                  {e.isCurrent && <span className="tag">HEAD</span>}
                  {!e.isTrunk && (
                    <span className="meta">
                      {e.ahead} commit{e.ahead === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </button>
              {e.prNumber && e.prUrl && (
                <a className="meta" href={e.prUrl} target="_blank" rel="noreferrer" aria-label={`Open pull request ${e.prNumber}`}>
                  #{e.prNumber}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
