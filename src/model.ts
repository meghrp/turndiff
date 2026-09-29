// Types shared by the CLI, the review server and the browser UI.
//
// The repo is read as a stack of branches (git-spice metadata when present).
// A Target names what the reviewer is looking at; the server resolves it into
// a View made of Sections, each one diff owned by one branch. Comments and
// viewed marks key on blob ids, so they belong to file content rather than to
// whichever view they were written in.

export type Oid = string;

export interface Commit {
  oid: Oid;
  short: string;
  subject: string;
  author: string;
  /** ISO 8601 author date. */
  date: string;
  /** Stack branch whose own range contains this commit; null for trunk history. */
  branch: string | null;
}

export interface Branch {
  name: string;
  /** Branch this one is diffed against; null for the trunk. */
  parent: string | null;
  tip: Oid;
  /** merge-base(parent, tip). The branch's own commits are base..tip. Null for the trunk. */
  base: Oid | null;
  /** Newest first. For the trunk: its recent history. */
  commits: Commit[];
  pr: { number: number; url: string | null } | null;
  /** Checked out in the worktree this server runs in. */
  current: boolean;
  /** The parent has moved past `base`; the branch needs a restack. */
  behind: boolean;
}

export interface Worktree {
  root: string;
  branch: string | null;
  head: Oid | null;
  /** Paths with uncommitted changes, tracked or untracked. */
  changed: number;
}

export interface TurnSummary {
  n: number;
  prompt: string | null;
  startedAt: string;
  /** Null while the turn is still running. */
  endedAt: string | null;
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  turns: TurnSummary[];
}

export interface RepoState {
  name: string;
  trunk: string;
  /** Trunk first, then a depth-first walk, so every parent precedes its children. */
  branches: Branch[];
  worktree: Worktree;
  /** Agent sessions with recorded turns, most recently updated first. */
  sessions: SessionSummary[];
  /** When the last review was submitted; enables the "since-review" target. */
  lastReviewAt: string | null;
  /** True while a `turndiff review` CLI is waiting for feedback. */
  agentWaiting: boolean;
  /**
   * A target the CLI asked the open tab to show (targetToHash form). Navigate
   * when `at` is newer than both page load and the last focus handled.
   */
  focus: { hash: string; at: number } | null;
  /** Changes whenever refs or the worktree change. The UI compares it to offer a reload. */
  version: string;
}

export type Target =
  /** PR view: merge-base(parent, tip)..tip. `working` adds uncommitted changes when the branch is checked out. */
  | { kind: "branch"; branch: string; working: boolean }
  /** Commits `from`..`to` inclusive, diffed from from's first parent. from === to is a single commit. */
  | { kind: "commits"; from: Oid; to: Oid }
  /** Uncommitted changes against HEAD. */
  | { kind: "working" }
  /** One section per branch of the current stack, bottom-up. */
  | { kind: "stack" }
  /** What agent turns from..to changed, compared branch by branch. */
  | { kind: "turns"; session: string; from: number; to: number }
  /** What changed, branch by branch, since the last submitted review. */
  | { kind: "since-review" };

export interface View {
  target: Target;
  title: string;
  sections: Section[];
  /** Things the reviewer should know: replay conflicts, detached HEAD, expired snapshots. */
  notes: string[];
  /** RepoState.version this view was computed from. */
  version: string;
}

export interface Section {
  /** Unique within a view. */
  id: string;
  /** Branch that owns these changes; null when nothing does (detached HEAD). */
  branch: string | null;
  title: string;
  /** Tree-ish of the old side. */
  base: Oid;
  /** Tree-ish of the new side; a worktree snapshot commit when uncommitted changes are included. */
  head: Oid;
  /** Real commits in the range, newest first. Never includes worktree snapshots. */
  commits: Commit[];
  includesWorking: boolean;
  /** Set when the old side was replayed onto a moved parent to hide restack noise. */
  replay: { conflicts: boolean } | null;
  files: FileChange[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Null on the absent side. Comments and viewed marks key on these. */
  oldBlob: Oid | null;
  newBlob: Oid | null;
  /** This file's unified diff, git format with a full-index header. Empty for binary files. */
  patch: string;
}

export type Side = "old" | "new";

export interface Anchor {
  /** Path on `side`: oldPath for the old side of a rename. */
  path: string;
  side: Side;
  /** 1-based, inclusive, in the numbering of `side`. */
  start: number;
  end: number;
  /** Blob of `path` on `side`. The comment renders wherever this exact blob is diffed on that side. */
  blob: Oid;
}

export interface Comment {
  id: string;
  body: string;
  anchor: Anchor;
  /** The commented lines as they read on `anchor.side`. */
  snippet: string[];
  /** Where the comment was written. Feedback groups by `branch`. */
  origin: {
    branch: string | null;
    /** Section head: a commit, or a worktree snapshot when `working`. */
    head: Oid;
    working: boolean;
    target: Target;
  };
  createdAt: string;
  updatedAt: string;
}

export type Decision = "approve" | "request_changes" | "comment";

export interface ReviewState {
  comments: Comment[];
  summary: string;
  /** viewedKey() values. A file stays viewed until its content changes. */
  viewed: string[];
  /** Ids of comments whose anchored content no longer exists at the tip of their branch. */
  outdated: string[];
}

export interface SubmitRequest {
  decision: Decision;
  summary: string;
}

export interface SubmitResponse {
  markdown: string;
  /**
   * False when no agent was waiting; the UI then copies the markdown. The next
   * `turndiff review` within 10 minutes still receives it.
   */
  delivered: boolean;
}

export interface WaitResponse {
  decision: Decision;
  markdown: string;
  submittedAt: string;
}

// HTTP API, all JSON unless noted. Errors are { error: string } with a 4xx/5xx status.
//
//   GET    /api/state                       RepoState
//   GET    /api/view?t=<targetToHash>&ws=1  View (ws=1 ignores whitespace)
//   GET    /api/blob/<oid>                  text/plain file contents, for expanding context
//   GET    /api/review                      ReviewState
//   PUT    /api/comments/<id>               body Comment, upsert -> ReviewState
//   DELETE /api/comments/<id>               -> ReviewState
//   PUT    /api/viewed                      body { key, viewed: boolean } -> ReviewState
//   PUT    /api/summary                     body { summary } -> ReviewState
//   GET    /api/feedback?decision=<d>       { markdown } preview of what submit would send
//   POST   /api/submit                      body SubmitRequest -> SubmitResponse
//   GET    /api/wait?waiter=<id>            WaitResponse, or 204 after ~25s (CLI long-poll). Each submission is
//                                           delivered once; one made while no CLI was polling waits up to 10 min.
//                                           409 once a CLI with another id has started waiting.
//   POST   /api/focus                       body { hash } (CLI only) -> sets RepoState.focus

export function viewedKey(path: string, blob: Oid): string {
  return `${path}\0${blob}`;
}

// Targets travel in the URL hash so a view is linkable and Back/Forward work:
//   #branch/<name>  #branch/<name>+working  #commits/<from>..<to>  #working
//   #stack  #turns/<session>/<from>-<to>  #since-review

export function targetToHash(t: Target): string {
  switch (t.kind) {
    case "branch":
      return `branch/${encodeURIComponent(t.branch)}${t.working ? "+working" : ""}`;
    case "commits":
      return `commits/${t.from}..${t.to}`;
    case "working":
      return "working";
    case "stack":
      return "stack";
    case "turns":
      return `turns/${encodeURIComponent(t.session)}/${t.from}-${t.to}`;
    case "since-review":
      return "since-review";
  }
}

export function hashToTarget(hash: string): Target | null {
  const h = hash.replace(/^#/, "");
  if (h === "working" || h === "stack" || h === "since-review") return { kind: h };
  let m = /^branch\/(.+?)(\+working)?$/.exec(h);
  if (m) return { kind: "branch", branch: decodeURIComponent(m[1]!), working: m[2] !== undefined };
  m = /^commits\/([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})$/.exec(h);
  if (m) return { kind: "commits", from: m[1]!, to: m[2]! };
  m = /^turns\/([^/]+)\/(\d+)-(\d+)$/.exec(h);
  if (m) return { kind: "turns", session: decodeURIComponent(m[1]!), from: Number(m[2]), to: Number(m[3]) };
  return null;
}
