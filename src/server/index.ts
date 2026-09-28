// Local review server. Serves the UI, answers diff queries, and resolves a
// promise when the reviewer submits so the CLI can print feedback and exit.

import { ensureUiBuilt, serveAsset } from "./assets.ts";
import { currentBranch, gitOrNull, type RepoPaths } from "../git/exec.ts";
import { listSessions, loadSession, snapshotWorktree, type Checkpoint, type Session } from "../git/checkpoints.ts";
import { readSpice, resolveParent, stackFor, trunkComparisonRef } from "../git/spice.ts";
import { branchDiff, diffRange, fileAt, turnDiff, type DiffResult } from "../git/diff.ts";
import type { DiffResponse, ReviewState, Scope, StateResponse, Submission } from "../shared.ts";
import { readReview, writeReview } from "./reviews.ts";
import { basename } from "node:path";

export interface ServerOptions {
  paths: RepoPaths;
  port: number;
  preselect: Scope | null;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Resolves with the submission, or null when the reviewer cancels. */
  result: Promise<Submission | null>;
  stop(): void;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const outDir = await ensureUiBuilt({ log: (m) => process.stderr.write("turndiff: " + m + "\n") });
  const { paths } = opts;
  const cwd = paths.root;
  const startedAt = new Date().toISOString();
  let resolveResult: (s: Submission | null) => void = () => {};
  const result = new Promise<Submission | null>((r) => (resolveResult = r));
  // Cache worktree snapshots per request burst so the file tree and diff share one.
  let worktreeSnapshot: { at: number; commit: string } | null = null;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const bad = (msg: string, status = 400) => json({ error: msg }, status);

  async function worktreeHead(): Promise<string> {
    if (worktreeSnapshot && Date.now() - worktreeSnapshot.at < 2000) return worktreeSnapshot.commit;
    const snap = await snapshotWorktree(paths, "turndiff worktree snapshot");
    worktreeSnapshot = { at: Date.now(), commit: snap.commit };
    return snap.commit;
  }

  async function state(): Promise<StateResponse> {
    const [branch, head, sessions, spice] = await Promise.all([
      currentBranch(cwd),
      gitOrNull(cwd, ["rev-parse", "--short", "HEAD"]),
      listSessions(paths),
      readSpice(cwd),
    ]);
    const stack = await stackFor(cwd, branch, spice);
    return { repo: { root: cwd, name: basename(cwd), branch, head }, sessions, stack, preselect: opts.preselect, startedAt };
  }

  async function resolveTurnScope(
    session: Session,
    from: number,
    to: number,
  ): Promise<{ from: Checkpoint; to: Checkpoint; label: string }> {
    const fromTurn = session.turns.find((t) => t.turn === from);
    const toTurn = session.turns.find((t) => t.turn === to);
    if (!fromTurn || !toTurn) throw new Error(`turn ${from} or ${to} not found in session ${session.id}`);
    // A turn without its own `pre` (hooks installed mid-turn) starts where the previous turn ended.
    const fromCp = fromTurn.pre ?? session.turns.filter((t) => t.turn < from && t.post).at(-1)?.post ?? null;
    let toCp = toTurn.post;
    let live = false;
    if (!toCp) {
      // Turn still running: compare against the worktree right now.
      const commit = await worktreeHead();
      const branch = await currentBranch(cwd);
      toCp = {
        kind: "post",
        ref: "(worktree)",
        commit,
        head: null,
        branch,
        parent: fromCp?.parent ?? null,
        parentMergeBase: null,
        createdAt: new Date().toISOString(),
      };
      if (branch) {
        const p = (await resolveParent(cwd, branch)) ?? (await trunkComparisonRef(cwd, branch));
        if (p) toCp.parent = p;
      }
      live = true;
    }
    if (!fromCp) throw new Error(`turn ${from} has no starting checkpoint`);
    const label = from === to ? `Turn ${to}${live ? " (in progress)" : ""}` : `Turns ${from}–${to}${live ? " (in progress)" : ""}`;
    return { from: fromCp, to: toCp, label };
  }

  async function diffFor(scope: Scope, ignoreWhitespace: boolean): Promise<DiffResponse> {
    if (scope.kind === "turn") {
      const session = await loadSession(paths, scope.sessionId);
      if (!session) throw new Error(`unknown session ${scope.sessionId}`);
      const { from, to, label } = await resolveTurnScope(session, scope.from, scope.to);
      const d = await turnDiff(cwd, from, to, { ignoreWhitespace });
      return { ...d, scope, label };
    }
    const parent = (await resolveParent(cwd, scope.name)) ?? (await trunkComparisonRef(cwd, scope.name));
    if (!parent) throw new Error(`no parent branch for ${scope.name}`);
    let d: DiffResult;
    if (scope.worktree) {
      if ((await currentBranch(cwd)) !== scope.name)
        throw new Error(`Switch back to ${scope.name} or turn off Include uncommitted changes to review this branch.`);
      const head = await worktreeHead();
      d = await branchDiff(cwd, scope.name, parent, { head, ignoreWhitespace });
    } else {
      d = await branchDiff(cwd, scope.name, parent, { ignoreWhitespace });
    }
    return { ...d, scope, label: `${scope.name} ← ${parent}${scope.worktree ? " (with uncommitted)" : ""}` };
  }

  function parseScope(url: URL): Scope {
    const kind = url.searchParams.get("kind");
    if (kind === "turn") {
      const sessionId = url.searchParams.get("session") ?? "";
      const to = Number(url.searchParams.get("to"));
      const from = Number(url.searchParams.get("from") ?? to);
      if (!sessionId || !Number.isFinite(to)) throw new Error("turn scope needs session and to");
      return { kind: "turn", sessionId, from, to };
    }
    if (kind === "branch") {
      const name = url.searchParams.get("name");
      if (!name) throw new Error("branch scope needs name");
      return { kind: "branch", name, worktree: url.searchParams.get("worktree") === "1" };
    }
    throw new Error(`unknown scope kind ${kind}`);
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    development: false,
    routes: {
      "/api/review": {
        GET: async (req) => json(await readReview(paths, parseScope(new URL(req.url)))),
        PUT: async (req) => {
          const scope = parseScope(new URL(req.url));
          const body = (await req.json()) as ReviewState;
          if (
            !body ||
            !Array.isArray(body.comments) ||
            !Array.isArray(body.drafts) ||
            !Array.isArray(body.viewed) ||
            typeof body.summary !== "string" ||
            !body.files ||
            !Number.isFinite(body.updatedAt)
          )
            return bad("Invalid review draft");
          await writeReview(paths, scope, body);
          return json({ ok: true });
        },
      },
      "/api/state": async () => json(await state()),
      "/api/diff": async (req) => {
        try {
          const url = new URL(req.url);
          const scope = parseScope(url);
          return json(await diffFor(scope, url.searchParams.get("ws") === "1"));
        } catch (e) {
          return bad((e as Error).message);
        }
      },
      "/api/patch": async (req) => {
        const url = new URL(req.url);
        const base = url.searchParams.get("base") ?? "",
          head = url.searchParams.get("head") ?? "";
        if (![base, head].every((oid) => /^[0-9a-f]{40,64}$/.test(oid))) return bad("Invalid revision");
        return json(await diffRange(cwd, base, head, url.searchParams.get("ws") === "1"));
      },
      "/api/file": async (req) => {
        const url = new URL(req.url);
        const oid = url.searchParams.get("oid");
        const path = url.searchParams.get("path");
        if (!oid || !path || !/^[0-9a-f]{7,64}$/.test(oid)) return bad("oid and path required");
        const contents = await fileAt(cwd, oid, path);
        return json({ contents });
      },
      "/api/submit": {
        POST: async (req) => {
          const body = (await req.json()) as Submission;
          if (!body || !body.scope || !Array.isArray(body.comments)) return bad("malformed submission");
          const previous = await readReview(paths, body.scope);
          await writeReview(paths, body.scope, {
            comments: [],
            drafts: [],
            viewed: [],
            summary: "",
            files: {},
            updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
          });
          queueMicrotask(() => resolveResult(body));
          return json({ ok: true });
        },
      },
      "/api/cancel": {
        POST: async () => {
          queueMicrotask(() => resolveResult(null));
          return json({ ok: true });
        },
      },
    },
    fetch(req) {
      return serveAsset(outDir, new URL(req.url).pathname) ?? new Response("not found", { status: 404 });
    },
    error(err) {
      return json({ error: err.message }, 500);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    result,
    stop: () => server.stop(true),
  };
}
