import {
  targetToHash,
  type Comment,
  type Decision,
  type RepoState,
  type ReviewState,
  type SubmitResponse,
  type Target,
  type View,
} from "../model.ts";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json === undefined ? init?.headers : { "content-type": "application/json" },
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text || `${res.status} ${res.statusText}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  state: () => call<RepoState>("/api/state"),
  view: (t: Target, ws: boolean, signal?: AbortSignal) =>
    call<View>(`/api/view?t=${encodeURIComponent(targetToHash(t))}${ws ? "&ws=1" : ""}`, { signal }),
  blob: async (oid: string) => {
    const res = await fetch(`/api/blob/${oid}`);
    if (!res.ok) throw new Error(`blob ${oid.slice(0, 7)}: ${res.status}`);
    return res.text();
  },
  review: () => call<ReviewState>("/api/review"),
  putComment: (c: Comment) => call<ReviewState>(`/api/comments/${encodeURIComponent(c.id)}`, { method: "PUT", json: c }),
  deleteComment: (id: string) => call<ReviewState>(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setViewed: (key: string, viewed: boolean) => call<ReviewState>("/api/viewed", { method: "PUT", json: { key, viewed } }),
  setSummary: (summary: string) => call<ReviewState>("/api/summary", { method: "PUT", json: { summary } }),
  feedback: (decision: Decision) => call<{ markdown: string }>(`/api/feedback?decision=${decision}`),
  submit: (decision: Decision, summary: string) =>
    call<SubmitResponse>("/api/submit", { method: "POST", json: { decision, summary } }),
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and focus; fall back to the legacy path.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
