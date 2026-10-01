// Local review server for one worktree. Serves the UI and the API in
// src/model.ts, keeps the review, and hands submissions to a waiting
// `turndiff review` through a long-poll.

import { basename } from "node:path";
import { ensureUiBuilt, serveAsset } from "./assets.ts";
import { gitRaw, type RepoPaths } from "../git/exec.ts";
import { snapshotWorktree } from "../git/diff.ts";
import { loadStack, repoVersion, type Stack } from "../git/stack.ts";
import { captureSnapshot, listSessions, summarize } from "../git/snapshots.ts";
import { resolveView, TargetError } from "../git/views.ts";
import { guidesVersion, readGuides } from "../git/guides.ts";
import { formatFeedback } from "../feedback.ts";
import { outdatedComments, ReviewStore, type ReviewDraft } from "./store.ts";
import { hashToTarget, type Comment, type Decision, type RepoState, type SubmitResponse, type WaitResponse } from "../model.ts";

export interface RunningServer {
  id: string;
  url: string;
  port: number;
  stop(): void;
}

const WAIT_MS = 25_000;
/** How long a submission nobody was waiting for stays available to the next `turndiff review`. */
const PENDING_MS = 10 * 60_000;
const IDLE_EXIT_MS = 8 * 3600_000;
const DECISIONS: readonly Decision[] = ["approve", "request_changes", "comment"];

export async function startServer(opts: { paths: RepoPaths; port: number }): Promise<RunningServer> {
  const { paths } = opts;
  const id = crypto.randomUUID();
  // Built on the first page request so the API is up at once.
  let ui: Promise<string> | null = null;
  const store = await ReviewStore.open(paths);

  let cached: { version: string; stack: Stack } | null = null;
  let snapshot: { version: string; oid: Promise<string> } | null = null;
  const current = async () => {
    const { version, status } = await repoVersion(paths);
    if (cached?.version !== version) cached = { version, stack: await loadStack(paths, status) };
    return cached;
  };
  const worktreeFor = (version: string) => {
    if (snapshot?.version !== version) {
      const oid = snapshotWorktree(paths);
      oid.catch(() => (snapshot = null));
      snapshot = { version, oid };
    }
    return snapshot.oid;
  };

  // One `turndiff review` waits at a time. A newer one retires the older, so a
  // submission wakes exactly one agent, and the one that asked last. Waiter ids
  // lead with the CLI's start time, so the order survives a server restart.
  let waiter: { id: string; resolve(r: WaitResult): void } | null = null;
  let newest: { id: string; startedAt: number } | null = null;
  // A submission no waiter has taken yet. The CLI re-polls every WAIT_MS and the
  // agent re-runs `turndiff review` after a timeout; either gap must not lose it.
  let pending: (WaitResponse & { atMs: number }) | null = null;
  let lastWaitAt = 0;
  const agentAttached = () => waiter !== null || Date.now() - lastWaitAt < 3000;
  let lastUiAt = 0;
  let lastRequestAt = Date.now();
  let focus: RepoState["focus"] = null;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, e instanceof TargetError || e instanceof BadRequest ? 400 : 500);
  };
  const reviewState = async () => store.state((await current()).stack);

  async function repoState(): Promise<RepoState> {
    const { version, stack } = await current();
    const sessions = (await listSessions(paths)).filter((s) => s.root === paths.root).map(summarize);
    return {
      name: basename(paths.root),
      trunk: stack.trunk,
      branches: stack.branches,
      worktree: stack.worktree,
      sessions,
      lastReviewAt: store.lastReview?.at ?? null,
      agentWaiting: agentAttached(),
      focus,
      version,
      guidesVersion: guidesVersion(paths),
    };
  }

  async function feedback(decision: Decision, draft: ReviewDraft = store.draft()) {
    const { stack } = await current();
    return formatFeedback({
      decision,
      summary: draft.summary,
      comments: draft.comments,
      outdated: await outdatedComments(paths, stack, draft.comments),
      branchOrder: stack.branches.map((b) => b.name),
      prs: new Map(stack.branches.flatMap((b) => (b.pr ? [[b.name, b.pr.number] as const] : []))),
      usesSpice: stack.spice,
    });
  }

  async function submit(decision: Decision, summary?: string): Promise<SubmitResponse> {
    const saved = await store.submit({ decision, summary }, async (draft) => {
      const markdown = await feedback(decision, draft);
      const snap = await captureSnapshot(paths, `review-${crypto.randomUUID()}`);
      return { markdown, snapshot: snap.id };
    });
    const { markdown } = saved;
    const delivered = agentAttached();
    const submission = { decision, ...saved };
    if (waiter) {
      waiter.resolve(submission);
      waiter = null;
    } else pending = { ...submission, atMs: Date.now() };
    return { markdown, delivered };
  }

  async function wait(id: string, signal: AbortSignal): Promise<Response> {
    const startedAt = Number(id.split("-")[0]);
    if (newest && id !== newest.id) {
      if (startedAt < newest.startedAt) return json({ error: "a newer turndiff review is waiting" }, 409);
      waiter?.resolve("superseded");
    }
    newest = { id, startedAt };
    // The same CLI re-polling after its own request was cut off.
    waiter?.resolve(null);
    lastWaitAt = Date.now();
    if (pending && Date.now() - pending.atMs < PENDING_MS) {
      const { atMs: _, ...submission } = pending;
      pending = null;
      return json(submission);
    }
    let resolveWait!: (r: WaitResult) => void;
    const result = new Promise<WaitResult>((r) => (resolveWait = r));
    const mine = { id, resolve: resolveWait };
    waiter = mine;
    const timer = setTimeout(() => resolveWait(null), WAIT_MS);
    // A CLI that died mid-poll must not take the next submission with it; it goes to `pending` instead.
    const gone = () => {
      if (waiter === mine) waiter = null;
      resolveWait(null);
    };
    signal.addEventListener("abort", gone);
    const r = await result;
    clearTimeout(timer);
    signal.removeEventListener("abort", gone);
    if (waiter === mine) waiter = null;
    lastWaitAt = Date.now();
    if (r === "superseded") return json({ error: "a newer turndiff review is waiting" }, 409);
    return r ? json(r) : new Response(null, { status: 204 });
  }

  const route = <T>(handler: (req: Bun.BunRequest<T & string>) => Promise<Response>) => async (req: Bun.BunRequest<T & string>) => {
    lastRequestAt = Date.now();
    if (!sameOrigin(req, server.port!)) return json({ error: "cross-origin request refused" }, 403);
    try {
      return await handler(req);
    } catch (e) {
      return fail(e);
    }
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    development: false,
    idleTimeout: 120,
    routes: {
      "/api/state": route(async () => {
        lastUiAt = Date.now();
        return json(await repoState());
      }),
      "/api/presence": route(async () => json({ uiSeenAt: lastUiAt, id, pid: process.pid, root: paths.root })),
      "/api/view": route(async (req) => {
        const url = new URL(req.url);
        const target = hashToTarget(url.searchParams.get("t") ?? "");
        if (!target) throw new BadRequest("unknown target");
        const { version, stack } = await current();
        const view = await resolveView(
          { paths, stack, version, worktree: () => worktreeFor(version), lastReview: store.lastReview?.snapshot ?? null, ignoreWhitespace: url.searchParams.get("ws") === "1" },
          target,
        );
        return json(view);
      }),
      "/api/blob/:oid": route(async (req) => {
        const { oid } = req.params as { oid: string };
        if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new BadRequest("bad oid");
        const r = await gitRaw(paths.root, ["cat-file", "blob", oid]);
        if (r.code !== 0) return json({ error: `unknown blob ${oid}` }, 404);
        return new Response(r.stdout, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "max-age=31536000, immutable" } });
      }),
      "/api/review": route(async () => json(await reviewState())),
      "/api/guides": route(async () => json(await readGuides(paths))),
      "/api/comments/:id": {
        PUT: route(async (req) => {
          const comment = parseComment(await req.json(), (req.params as { id: string }).id);
          await store.upsertComment(comment);
          return json(await reviewState());
        }),
        DELETE: route(async (req) => {
          await store.deleteComment((req.params as { id: string }).id);
          return json(await reviewState());
        }),
      },
      "/api/viewed": {
        PUT: route(async (req) => {
          const body = object(await req.json());
          if (typeof body.key !== "string" || typeof body.viewed !== "boolean") throw new BadRequest("expected { key, viewed }");
          await store.setViewed(body.key, body.viewed);
          return json(await reviewState());
        }),
      },
      "/api/summary": {
        PUT: route(async (req) => {
          const body = object(await req.json());
          if (typeof body.summary !== "string") throw new BadRequest("expected { summary }");
          await store.setSummary(body.summary);
          return json(await reviewState());
        }),
      },
      "/api/feedback": route(async (req) => json({ markdown: await feedback(parseDecision(new URL(req.url).searchParams.get("decision") ?? "comment")) })),
      "/api/submit": {
        POST: route(async (req) => {
          const body = object(await req.json());
          return json(await submit(parseDecision(body.decision), typeof body.summary === "string" ? body.summary : undefined));
        }),
      },
      "/api/focus": {
        POST: route(async (req) => {
          const body = object(await req.json());
          if (typeof body.hash !== "string" || !hashToTarget(body.hash)) throw new BadRequest("expected { hash } of a target");
          focus = { hash: body.hash, at: Date.now() };
          return json({ ok: true });
        }),
      },
      "/api/wait": route(async (req) => {
        const id = new URL(req.url).searchParams.get("waiter");
        if (!id || !/^\d+-[\w-]+$/.test(id)) throw new BadRequest("expected ?waiter=<start ms>-<random>");
        return wait(id, req.signal);
      }),
    },
    async fetch(req) {
      lastRequestAt = Date.now();
      ui ??= ensureUiBuilt({ log: (m) => process.stderr.write(`turndiff: ${m}\n`) });
      try {
        return serveAsset(await ui, new URL(req.url).pathname) ?? new Response("not found", { status: 404 });
      } catch (e) {
        ui = null;
        return new Response(`turndiff UI build failed:\n${(e as Error).message}`, { status: 500 });
      }
    },
    error(err) {
      return fail(err);
    },
  });

  const idle = setInterval(() => {
    if (Date.now() - lastRequestAt > IDLE_EXIT_MS) process.kill(process.pid, "SIGTERM");
  }, 60_000);
  idle.unref();

  return { id, url: `http://127.0.0.1:${server.port}`, port: server.port!, stop: () => { clearInterval(idle); server.stop(true); } };
}

class BadRequest extends Error {}

type WaitResult = WaitResponse | "superseded" | null;

/**
 * Only this server's own page and the CLI may call the API. The Host check
 * stops DNS rebinding; the Origin check stops other sites' pages from
 * submitting or deleting comments with a simple cross-origin POST.
 */
function sameOrigin(req: Request, port: number): boolean {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.get("host") ?? "")) return false;
  const origin = req.headers.get("origin");
  return origin === null || allowed.some((h) => origin === `http://${h}`);
}

function parseDecision(raw: unknown): Decision {
  if (typeof raw === "string" && (DECISIONS as readonly string[]).includes(raw)) return raw as Decision;
  throw new BadRequest(`decision must be one of ${DECISIONS.join(", ")}`);
}

function parseComment(raw: unknown, id: string): Comment {
  const c = object(raw);
  const a = object(c.anchor);
  const origin = object(c.origin);
  const ok =
    c.id === id &&
    typeof c.body === "string" &&
    typeof a.path === "string" &&
    a.path.length > 0 &&
    !/[\n\0]/.test(a.path) &&
    (a.side === "old" || a.side === "new") &&
    typeof a.start === "number" && Number.isSafeInteger(a.start) && a.start >= 1 &&
    typeof a.end === "number" && Number.isSafeInteger(a.end) && a.end >= a.start &&
    typeof a.blob === "string" && /^[0-9a-f]{40,64}$/.test(a.blob) &&
    Array.isArray(c.snippet) &&
    c.snippet.every((line: unknown) => typeof line === "string") &&
    (origin.branch === null || typeof origin.branch === "string") &&
    typeof origin.head === "string" &&
    typeof origin.working === "boolean" &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string";
  if (!ok) throw new BadRequest("malformed comment");
  const target = object(origin.target);
  const kind = target.kind;
  const validTarget =
    kind === "working" || kind === "stack" || kind === "since-review" ||
    (kind === "branch" && typeof target.branch === "string" && typeof target.working === "boolean") ||
    (kind === "commits" && typeof target.from === "string" && typeof target.to === "string" && /^[0-9a-f]{4,64}$/.test(target.from) && /^[0-9a-f]{4,64}$/.test(target.to)) ||
    (kind === "turns" && typeof target.session === "string" && typeof target.from === "number" && Number.isSafeInteger(target.from) && target.from >= 1 && typeof target.to === "number" && Number.isSafeInteger(target.to) && target.to >= target.from);
  if (!validTarget) throw new BadRequest("malformed comment target");
  return raw as Comment;
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadRequest("expected a JSON object");
  return raw as Record<string, unknown>;
}
