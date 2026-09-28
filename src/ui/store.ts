import type { DiffResponse, ReviewState, Scope, StateResponse, Submission } from "../shared.ts";
import { scopeKey } from "../shared.ts";
import { emptyReview } from "./reviewState.ts";

export function scopeQuery(scope: Scope): URLSearchParams {
  const q = new URLSearchParams({ kind: scope.kind });
  if (scope.kind === "turn") {
    q.set("session", scope.sessionId);
    q.set("from", String(scope.from));
    q.set("to", String(scope.to));
  } else {
    q.set("name", scope.name);
    if (scope.worktree) q.set("worktree", "1");
  }
  return q;
}
async function checked(r: Response): Promise<Response> {
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${r.status}). Please retry.`);
  }
  return r;
}
export async function fetchState(): Promise<StateResponse> {
  return (await checked(await fetch("/api/state"))).json();
}
export async function fetchDiff(scope: Scope, ignoreWhitespace: boolean, signal?: AbortSignal): Promise<DiffResponse> {
  const q = scopeQuery(scope);
  if (ignoreWhitespace) q.set("ws", "1");
  return (await checked(await fetch(`/api/diff?${q}`, { signal }))).json();
}
export async function fetchFile(oid: string, path: string): Promise<string | null> {
  const r = await checked(await fetch(`/api/file?oid=${encodeURIComponent(oid)}&path=${encodeURIComponent(path)}`));
  return (await r.json()).contents;
}
export async function submitReview(sub: Submission): Promise<void> {
  await checked(await fetch("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }));
}
export async function cancelReview(): Promise<void> {
  await checked(await fetch("/api/cancel", { method: "POST" }));
}
export function readPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`turndiff:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`turndiff:${key}`, value);
  } catch {
    /* Preferences are optional. */
  }
}
const backupKey = (repo: string, scope: Scope) => `turndiff:review:${repo}:${scopeKey(scope)}`;
export function backupReview(repo: string, scope: Scope, review: ReviewState): void {
  try {
    localStorage.setItem(backupKey(repo, scope), JSON.stringify(review));
  } catch {
    /* Server remains authoritative. */
  }
}
export async function loadReview(repo: string, scope: Scope): Promise<ReviewState> {
  const server: ReviewState | null = await (await checked(await fetch(`/api/review?${scopeQuery(scope)}`))).json();
  let local: ReviewState | null = null;
  try {
    local = JSON.parse(localStorage.getItem(backupKey(repo, scope)) ?? "null");
    // One-time recovery of drafts from the previous browser-only format.
    if (!server && !local) {
      const old = (what: string) => localStorage.getItem(`turndiff:${what}:${repo}:${scopeKey(scope)}`);
      local = {
        ...emptyReview(),
        comments: JSON.parse(old("comments") ?? "[]"),
        viewed: JSON.parse(old("viewed") ?? "[]"),
        summary: old("summary") ?? "",
      };
    }
  } catch {
    /* A corrupt local backup must not hide server data. */
  }
  return local && (!server || local.updatedAt > server.updatedAt) ? local : (server ?? emptyReview());
}
export async function saveReview(scope: Scope, review: ReviewState, keepalive = false): Promise<void> {
  await checked(
    await fetch(`/api/review?${scopeQuery(scope)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(review),
      keepalive,
    }),
  );
}
export function scopeToHash(scope: Scope): string {
  return scope.kind === "turn"
    ? `#turn/${encodeURIComponent(scope.sessionId)}/${scope.from}/${scope.to}`
    : `#branch/${encodeURIComponent(scope.name)}/${scope.worktree ? "wt" : "tip"}`;
}
export function scopeFromHash(hash: string): Scope | null {
  try {
    const p = hash.replace(/^#/, "").split("/");
    if (p[0] === "turn" && p.length === 4) {
      const from = Number(p[2]),
        to = Number(p[3]);
      if (p[1] && Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from)
        return { kind: "turn", sessionId: decodeURIComponent(p[1]), from, to };
    }
    if (p[0] === "branch" && p[1] && (p[2] === "wt" || p[2] === "tip"))
      return { kind: "branch", name: decodeURIComponent(p[1]), worktree: p[2] === "wt" };
  } catch {
    /* Invalid links fall back to the initial selection. */
  }
  return null;
}

export async function fetchSnapshot(diff: DiffResponse, signal: AbortSignal): Promise<DiffResponse> {
  const q = new URLSearchParams({ base: diff.baseOid, head: diff.headOid, ws: "1" });
  const filtered = await (await checked(await fetch(`/api/patch?${q}`, { signal }))).json();
  return { ...diff, ...filtered };
}
