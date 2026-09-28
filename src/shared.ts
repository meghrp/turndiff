// Types shared by the server and the browser UI.

import type { Session } from "./git/checkpoints.ts";
import type { StackEntry } from "./git/spice.ts";
import type { DiffResult } from "./git/diff.ts";

export type Scope = { kind: "turn"; sessionId: string; from: number; to: number } | { kind: "branch"; name: string; worktree: boolean };

export interface StateResponse {
  repo: { root: string; name: string; branch: string | null; head: string | null };
  sessions: Session[];
  stack: StackEntry[];
  preselect: Scope | null;
  startedAt: string;
}

export type DiffResponse = DiffResult & { scope: Scope; label: string };

export type CommentSide = "additions" | "deletions";

export interface ReviewComment {
  id: string;
  file: string;
  side: CommentSide;
  lineStart: number;
  lineEnd: number;
  body: string;
  /** The commented lines, for context in the agent-facing output. */
  snippet: string[];
  createdAt: string;
  outdated?: boolean;
  contextConfirmed?: boolean;
  revision?: string;
}

export type Decision = "approve" | "request_changes" | "comment";

export interface Submission {
  decision: Decision;
  summary: string;
  comments: ReviewComment[];
  scope: Scope;
  label: string;
  baseOid: string;
  headOid: string;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === "turn"
    ? `turn:${scope.sessionId}:${scope.from}-${scope.to}`
    : `branch:${scope.name}:${scope.worktree ? "wt" : "tip"}`;
}

export interface ReviewDraft {
  file: string;
  side: CommentSide;
  lineStart: number;
  lineEnd: number;
  editingId?: string;
  body: string;
  snippet: string[];
  outdated?: boolean;
  contextConfirmed?: boolean;
  revision?: string;
}

export interface ReviewState {
  comments: ReviewComment[];
  drafts: ReviewDraft[];
  viewed: string[];
  summary: string;
  /** Content identities, independent of whitespace display preferences. */
  files: Record<string, string>;
  updatedAt: number;
}
