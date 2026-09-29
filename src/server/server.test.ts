import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { git, repoPaths } from "../git/exec.ts";
import { buildScenario, SESSION, type Scenario } from "../scenario.ts";
import { startServer, type RunningServer } from "./index.ts";
import { targetToHash, type Comment, type RepoState, type ReviewState, type SubmitResponse, type View, type WaitResponse } from "../model.ts";

let sc: Scenario;
let server: RunningServer;
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${server.url}${path}`, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

beforeAll(async () => {
  sc = await buildScenario();
  server = await startServer({ paths: await repoPaths(sc.root), port: 0 });
});

afterAll(async () => {
  server.stop();
  await rm(sc.root, { recursive: true, force: true });
});

test("state, views and the review round trip over HTTP", async () => {
  const state = await api<RepoState>("/api/state");
  expect(state.branches.map((b) => b.name)).toEqual(["main", "feat-a", "feat-b", "feat-c", "feat-d"]);
  expect(state.sessions.map((s) => [s.id, s.turns.length])).toEqual([[SESSION, 2]]);

  const turn = await api<View>(`/api/view?t=${encodeURIComponent(targetToHash({ kind: "turns", session: SESSION, from: 1, to: 1 }))}`);
  expect(turn.sections.map((s) => s.branch)).toEqual(["feat-a", "feat-b"]);
  expect(turn.version).toBe(state.version);

  const bad = await fetch(`${server.url}/api/view?t=branch%2Fnope`);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("not a branch");

  const file = turn.sections[0]!.files[0]!;
  const blob = await (await fetch(`${server.url}/api/blob/${file.newBlob}`)).text();
  expect(blob).toBe("a1\na2\na3\n");

  const comment: Comment = {
    id: "k1",
    body: "why a3?",
    anchor: { path: file.path, side: "new", start: 3, end: 3, blob: file.newBlob! },
    snippet: ["a3"],
    origin: { branch: "feat-a", head: turn.sections[0]!.head, working: false, target: turn.target },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const afterPut = await api<ReviewState>("/api/comments/k1", { method: "PUT", body: JSON.stringify(comment) });
  expect(afterPut.comments.map((c) => c.id)).toEqual(["k1"]);
  expect(afterPut.outdated).toEqual([]);
  expect((await fetch(`${server.url}/api/comments/k2`, { method: "PUT", body: JSON.stringify(comment) })).status).toBe(400);

  const waiting = api<WaitResponse>("/api/wait?waiter=1-test");
  await Bun.sleep(100);
  expect((await api<RepoState>("/api/state")).agentWaiting).toBe(true);
  const submitted = await api<SubmitResponse>("/api/submit", { method: "POST", body: JSON.stringify({ decision: "request_changes", summary: "one nit" }) });
  expect(submitted.delivered).toBe(true);
  const received = await waiting;
  expect(received.markdown).toBe(submitted.markdown);
  expect(received.markdown).toContain("## Branch `feat-a`");
  expect(received.markdown).toContain("why a3?");
  expect(received.markdown).toContain("one nit");

  const fresh = await api<ReviewState>("/api/review");
  expect(fresh.comments).toEqual([]);
  expect((await api<RepoState>("/api/state")).lastReviewAt).not.toBeNull();

  // Nothing changed since the review, then one uncommitted edit on feat-b.
  const hash = encodeURIComponent(targetToHash({ kind: "since-review" }));
  expect((await api<View>(`/api/view?t=${hash}`)).sections).toEqual([]);
  await Bun.write(`${sc.root}/feat_b.py`, (await Bun.file(`${sc.root}/feat_b.py`).text()) + "\n# reviewed\n");
  const since2 = await api<View>(`/api/view?t=${hash}`);
  expect(since2.sections.map((s) => [s.branch, s.files.map((f) => f.path)])).toEqual([["feat-b", ["feat_b.py"]]]);
  expect(await git(sc.root, ["status", "--porcelain"])).toContain("feat_b.py");
});

test("other sites' pages cannot call the API", async () => {
  const res = await fetch(`${server.url}/api/submit`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ decision: "approve", summary: "" }) });
  expect(res.status).toBe(403);
  const own = await fetch(`${server.url}/api/review`, { headers: { origin: server.url } });
  expect(own.status).toBe(200);
});

test("a review submitted while no agent waits reaches the next turndiff review once", async () => {
  // Let the previous test's poll age out so no agent counts as attached.
  await Bun.sleep(3100);
  expect((await api<RepoState>("/api/state")).agentWaiting).toBe(false);
  const submitted = await api<SubmitResponse>("/api/submit", { method: "POST", body: JSON.stringify({ decision: "approve", summary: "later" }) });
  expect(submitted.delivered).toBe(false);
  const started = Date.now();
  const received = await api<WaitResponse>("/api/wait?waiter=1-test");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(received.markdown).toBe(submitted.markdown);
  expect(received.decision).toBe("approve");
});

test("a newer turndiff review takes over, so a submission wakes one agent", async () => {
  const older = fetch(`${server.url}/api/wait?waiter=2-older`);
  await Bun.sleep(100);
  const newer = api<WaitResponse>("/api/wait?waiter=3-newer");
  expect((await older).status).toBe(409);
  expect((await fetch(`${server.url}/api/wait?waiter=2-older`)).status).toBe(409);
  const submitted = await api<SubmitResponse>("/api/submit", { method: "POST", body: JSON.stringify({ decision: "comment", summary: "once" }) });
  expect(submitted.delivered).toBe(true);
  expect((await newer).markdown).toBe(submitted.markdown);
});

test("a turndiff review that dies mid-wait leaves the next submission for its successor", async () => {
  const abort = new AbortController();
  const dying = fetch(`${server.url}/api/wait?waiter=4-dying`, { signal: abort.signal }).catch(() => null);
  await Bun.sleep(100);
  abort.abort();
  await dying;
  await Bun.sleep(3100);
  expect((await api<RepoState>("/api/state")).agentWaiting).toBe(false);
  const submitted = await api<SubmitResponse>("/api/submit", { method: "POST", body: JSON.stringify({ decision: "comment", summary: "after a crash" }) });
  expect(submitted.delivered).toBe(false);
  expect((await api<WaitResponse>("/api/wait?waiter=5-next")).markdown).toBe(submitted.markdown);
});

test("after a server restart an older turndiff review cannot take over from a newer one", async () => {
  const restarted = await startServer({ paths: await repoPaths(sc.root), port: 0 });
  try {
    const newer = fetch(`${restarted.url}/api/wait?waiter=7-newer`).then((r) => r.json() as Promise<WaitResponse>);
    await Bun.sleep(100);
    expect((await fetch(`${restarted.url}/api/wait?waiter=6-older-reconnecting`)).status).toBe(409);
    const submit = await fetch(`${restarted.url}/api/submit`, { method: "POST", body: JSON.stringify({ decision: "comment", summary: "restart order" }) });
    expect((await newer).markdown).toBe(((await submit.json()) as SubmitResponse).markdown);
  } finally {
    restarted.stop();
  }
});
