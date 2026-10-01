#!/usr/bin/env bun
// turndiff: review git-spice stacks, commits and agent turns in the browser,
// and hand the comments back to the agent.

import { readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { install } from "./install.ts";
import { currentBranch, git, gitOrNull, repoPaths, type RepoPaths } from "./git/exec.ts";
import { checkGuide, removeGuide, writeGuide } from "./git/guides.ts";
import { deleteSession, listSessions, recordHook } from "./git/snapshots.ts";
import { startServer } from "./server/index.ts";
import { codeStamp, ensureDaemon, readState, ServerAlreadyRunningError, stopDaemon, withServerLease, writeState } from "./server/daemon.ts";
import { targetToHash, type Target, type WaitResponse } from "./model.ts";

const HELP = `turndiff: review stacked branches, commits and agent turns, send comments back to the agent

Usage:
  turndiff [open] [target]      Open the review UI for this worktree (starts the server if needed).
  turndiff review [target]      Open it, wait for the reviewer to submit, print the feedback markdown.
                                Agents run it in the background; a newer review replaces an older waiting one.
                                A bare branch name works as a target: turndiff review feat-a
  turndiff guide [<file>|-]     Store the author's review guide for a branch (JSON from the file or stdin).
                                --branch <name> (default: checked out), --remove to drop it. See turndiff guide --help.
  turndiff stop                 Stop this worktree's review server.
  turndiff hook                 Claude Code hook entrypoint (hook JSON on stdin).
  turndiff install [--skill-only]  Register the hooks in ~/.claude/settings.json and link the skill.
  turndiff clean [--keep <n> | --all]  Drop recorded agent sessions (default keeps the newest 5) and any v0 data.

Target (default: the checked-out branch against its parent):
  --branch [name]    A branch against its parent, like a PR.
  --commit <rev>     One commit.
  --range <a>..<b>   Commits after <a> up to <b>.
  --working          Uncommitted changes.
  --stack            Every branch of the current stack.
  --turn [n]         What agent turn n changed (default: the latest). --turns <a>-<b> for several.
  --session <id>     Session for --turn (default: the latest in this worktree).
  --since-review     What changed since the last submitted review.

Options:
  --timeout <sec>    review: stop waiting after this long (default 0, wait until submitted). The server keeps running.
  --open / --no-open Force or suppress opening the browser.
  --port <n>         Port for a newly started server (default: random).
`;

const GUIDE_HELP = `turndiff guide: store the author's review guide for a branch

Usage:
  turndiff guide [<file>|-] [--branch <name>]   Read the guide JSON from <file> or stdin and store it.
  turndiff guide --remove [--branch <name>]     Drop the branch's guide.

The branch defaults to the checked-out one; its diff includes uncommitted changes.
Writing again replaces the branch's guide. In a stack, write one guide per branch.
The guide is checked against the branch diff; every problem is listed and nothing is stored.

Input:
  {
    "author": "claude-opus-4",                  optional: who wrote it
    "intent": "Why the branch exists, 1-2 sentences.",
    "sections": [
      {
        "title": "Concept, not a filename",
        "overview": "2-6 sentences: what changed, why, implications, risk.",
        "files": [{ "path": "src/x.ts", "summary": "What this file's change does, 1-2 sentences." }]
      }
    ],
    "annotations": [                             optional: notes beside the code
      {
        "path": "src/x.ts",
        "lines": [12, 18],                       1-based, inclusive
        "side": "new",                           optional: "new" (default, the file at the tip or on disk)
                                                 or "old" (the file at the branch base, for removed code)
        "summary": "What this code does, 1-2 sentences.",
        "rationale": "Why it is written this way."   optional, shown on demand
      }
    ]
  }
  All text is markdown. Paths are new paths as the diff shows them.

Writing rules:
  - 2 to 6 sections. Titles name concepts, never files.
  - Order: the heart of the change first, its consequences next, glue last.
  - Place every changed file exactly once. Unplaced files are listed under "Everything else".
  - Annotate only what a reviewer would not see from the code itself. The rationale says why, not what.
  - Be honest about risk and uncertainty: say what you did not test and what you are unsure of.
`;

/** Flags that never take a value, so a bare word after them is a branch name. */
const SWITCHES = new Set(["open", "no-open", "working", "stack", "since-review", "all", "skill-only", "help", "remove"]);

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
  /** A bare word after the command, read as a branch name (for `guide`, the input file). */
  branch: string | null;
}

function parseArgs(argv: string[]): Args {
  const first = argv[0] && !argv[0].startsWith("--") ? argv[0] : "open";
  const tail = first === argv[0] ? argv.slice(1) : argv;
  const flags = new Map<string, string | true>();
  let branch: string | null = null;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (!a.startsWith("--")) {
      branch ??= a;
      continue;
    }
    const next = tail[i + 1];
    if (next !== undefined && !next.startsWith("--") && !SWITCHES.has(a.slice(2))) {
      flags.set(a.slice(2), next);
      i++;
    } else flags.set(a.slice(2), true);
  }
  return { cmd: first, flags, branch };
}

const str = (args: Args, key: string) => {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : null;
};

function numberArg(args: Args, key: string, fallback: number, integer = true): number {
  const raw = str(args, key);
  const value = Number(raw ?? fallback);
  if ((args.flags.has(key) && raw === null) || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`--${key} expects a non-negative ${integer ? "integer" : "number of seconds"}`);
  }
  return value;
}

async function commitOid(cwd: string, rev: string): Promise<string> {
  const oid = await gitOrNull(cwd, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]);
  if (!oid) throw new Error(`unknown revision ${rev}`);
  return oid;
}

async function parseTarget(args: Args, paths: RepoPaths): Promise<Target | null> {
  const cwd = paths.root;
  const f = args.flags;
  if (f.has("branch") || args.branch) {
    const current = await gitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const name = str(args, "branch") ?? args.branch ?? current;
    if (!name) throw new Error("detached HEAD: pass --branch <name>");
    return { kind: "branch", branch: name, working: name === current };
  }
  if (str(args, "commit")) {
    const oid = await commitOid(cwd, str(args, "commit")!);
    return { kind: "commits", from: oid, to: oid };
  }
  if (str(args, "range")) {
    const [a, b] = str(args, "range")!.split("..");
    if (!a || !b) throw new Error("--range expects <a>..<b>");
    const first = (await git(cwd, ["rev-list", "--reverse", `${a}..${b}`])).split("\n")[0];
    if (!first) throw new Error(`no commits in ${a}..${b}`);
    return { kind: "commits", from: first, to: await commitOid(cwd, b) };
  }
  if (f.has("working")) return { kind: "working" };
  if (f.has("stack")) return { kind: "stack" };
  if (f.has("since-review")) return { kind: "since-review" };
  if (f.has("turn") || f.has("turns")) {
    const sessions = (await listSessions(paths)).filter((s) => s.root === paths.root);
    const session = str(args, "session") ? sessions.find((s) => s.id === str(args, "session")) : sessions[0];
    if (!session || session.turns.length === 0) throw new Error("no recorded agent turns in this worktree (run `turndiff install`)");
    const [a, b] = (str(args, "turns") ?? str(args, "turn") ?? String(session.turns.at(-1)!.n)).split("-");
    return { kind: "turns", session: session.id, from: Number(a), to: Number(b ?? a) };
  }
  return null;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener; the URL is printed */
  }
}

/** Start or reuse the server, point the open tab (or a new one) at the target. */
async function present(args: Args, paths: RepoPaths): Promise<string> {
  const target = await parseTarget(args, paths);
  const port = numberArg(args, "port", 0);
  if (port > 65535) throw new Error("--port must be between 0 and 65535");
  const { state, fresh } = await ensureDaemon(paths, port);
  const hash = target ? targetToHash(target) : null;
  const url = `${state.url}/${hash ? `#${hash}` : ""}`;
  const { uiSeenAt } = (await (await fetch(`${state.url}/api/presence`)).json()) as { uiSeenAt: number };
  const tabOpen = Date.now() - uiSeenAt < 10_000;
  if (hash && tabOpen) await fetch(`${state.url}/api/focus`, { method: "POST", body: JSON.stringify({ hash }) });
  const open = args.flags.has("open") || (!args.flags.has("no-open") && (fresh || !tabOpen));
  if (open) openBrowser(url);
  process.stderr.write(`turndiff: ${url}${tabOpen && !open ? " (review tab already open)" : ""}\n`);
  return state.url;
}

async function cmdOpen(args: Args, paths: RepoPaths): Promise<number> {
  await present(args, paths);
  return 0;
}

async function cmdReview(args: Args, paths: RepoPaths): Promise<number> {
  const timeoutMs = numberArg(args, "timeout", 0, false) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("--timeout expects a non-negative number of seconds");
  let base = await present(args, paths);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const waiter = `${Date.now()}-${crypto.randomUUID()}`;
  process.stderr.write("turndiff: waiting for the reviewer to submit\n");
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/wait?waiter=${waiter}`, Number.isFinite(deadline) ? { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))) } : undefined);
    } catch {
      if (Date.now() >= deadline) break;
      // New turndiff code or a `turndiff` from another shell restarts the server; follow it.
      const next = await reconnect(paths, deadline);
      if (Date.now() >= deadline) break;
      if (!next) {
        process.stderr.write("turndiff: the review server stopped before feedback was submitted\n");
        return 2;
      }
      base = next;
      continue;
    }
    if (res.status === 200) {
      process.stdout.write(((await res.json()) as WaitResponse).markdown);
      return 0;
    }
    if (res.status === 409) {
      process.stdout.write("Superseded: a newer `turndiff review` is waiting for this review. Nothing to do here.\n");
      return 0;
    }
    if (res.status !== 204) await Bun.sleep(1000);
  }
  process.stdout.write(`Still waiting for the reviewer at ${base}.\nThe review server keeps running. Run \`turndiff review\` again to keep waiting.\n`);
  return 0;
}

/** The URL of this worktree's server once it is answering again, or null after ~15s. */
async function reconnect(paths: RepoPaths, deadline: number): Promise<string | null> {
  for (let i = 0; i < 30 && Date.now() < deadline; i++) {
    await Bun.sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    const s = await readState(paths);
    if (s && (await fetch(`${s.url}/api/presence`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(deadline - Date.now())))) }).then((r) => r.ok, () => false))) return s.url;
  }
  return null;
}

/** Internal: the foreground server that `ensureDaemon` spawns detached. */
async function cmdServe(args: Args, paths: RepoPaths): Promise<number> {
  try {
    return await withServerLease(paths, async () => {
      const code = codeStamp();
      const port = numberArg(args, "port", 0);
      if (port > 65535) throw new Error("--port must be at most 65535");
      const server = await startServer({ paths, port });
      try {
        await writeState(paths, { id: server.id, pid: process.pid, port: server.port, url: server.url, startedAt: new Date().toISOString(), code });
        const shutdown = () => {
          server.stop();
          process.exit(0);
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        process.stderr.write(`turndiff: serving ${paths.root} at ${server.url}\n`);
        await new Promise(() => {});
        return 0;
      } finally {
        server.stop();
      }
    });
  } catch (e) {
    if (!(e instanceof ServerAlreadyRunningError)) throw e;
    process.stderr.write(`turndiff: ${e.message}\n`);
    return 75;
  }
}

async function cmdStop(paths: RepoPaths): Promise<number> {
  process.stdout.write((await stopDaemon(paths)) ? "review server stopped\n" : "no review server running\n");
  return 0;
}

async function cmdHook(): Promise<number> {
  // Never break the agent's turn: report problems on stderr and exit 0.
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
    const sessionId = String(payload.session_id ?? "");
    const event = String(payload.hook_event_name ?? "");
    const cwd = String(payload.cwd ?? process.cwd());
    if (!sessionId || (event !== "UserPromptSubmit" && event !== "Stop")) return 0;
    if ((await gitOrNull(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return 0;
    const action = await recordHook({ sessionId, event, cwd, prompt: typeof payload.prompt === "string" ? payload.prompt : undefined });
    if (process.env.TURNDIFF_DEBUG) process.stderr.write(`turndiff: ${action}\n`);
  } catch (e) {
    process.stderr.write(`turndiff hook: ${(e as Error).message}\n`);
  }
  return 0;
}

async function cmdClean(args: Args, paths: RepoPaths): Promise<number> {
  const keep = numberArg(args, "keep", 5);
  const sessions = await listSessions(paths);
  const targets = args.flags.has("all") ? sessions : sessions.slice(keep);
  for (const s of targets) {
    await deleteSession(paths, s);
    process.stdout.write(`removed session ${s.id} (${s.turns.length} turns)\n`);
  }
  // v0's whole-worktree checkpoints and per-scope drafts mean nothing to this version.
  const legacy = ((await gitOrNull(paths.root, ["for-each-ref", "--format=%(refname)", "refs/turndiff/"])) ?? "").split("\n").filter((r) => r && !r.startsWith("refs/turndiff/v1/"));
  if (legacy.length > 0) await git(paths.root, ["update-ref", "--stdin"], { stdin: legacy.map((r) => `delete ${r}\n`).join("") });
  for (const dir of ["sessions", "drafts", "review"]) await rm(join(paths.commonDir, "turndiff", dir), { recursive: true, force: true });
  if (legacy.length > 0) process.stdout.write(`removed ${legacy.length} v0 checkpoint refs and v0 drafts\n`);
  if (targets.length === 0 && legacy.length === 0) process.stdout.write("nothing to remove\n");
  return 0;
}

async function cmdGuide(args: Args, paths: RepoPaths): Promise<number> {
  const branch = str(args, "branch") ?? (await currentBranch(paths.root));
  if (!branch) throw new Error("detached HEAD: pass --branch <name>");
  if (args.flags.has("remove")) {
    process.stdout.write((await removeGuide(paths, branch)) ? `removed the guide for ${branch}\n` : `no guide for ${branch}\n`);
    return 0;
  }
  const file = args.branch ?? "-";
  if (file === "-" && process.stdin.isTTY) throw new Error("pipe the guide JSON on stdin or pass a file (turndiff guide --help)");
  const text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`turndiff guide: the input is not valid JSON: ${(e as Error).message}\n`);
    return 1;
  }
  const r = await checkGuide(paths, branch, raw);
  if (!r.ok) {
    const n = r.errors.length;
    process.stderr.write(`turndiff guide: ${n} problem${n === 1 ? "" : "s"}, nothing stored:\n${r.errors.map((e) => `  ${e}\n`).join("")}`);
    return 1;
  }
  const g = r.guide;
  await writeGuide(paths, g);
  const placed = g.sections.reduce((n, s) => n + s.files.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  process.stdout.write(
    `guide for ${branch}: ${plural(g.sections.length, "section")}, ${placed} of ${plural(r.changedFiles, "file")} placed, ${plural(g.annotations.length, "annotation")}\n` +
      r.warnings.map((w) => `warning: ${w}\n`).join(""),
  );
  return 0;
}

async function cmdInstall(args: Args): Promise<number> {
  const messages = await install({
    homeDir: homedir(),
    repoDir: dirname(dirname(fileURLToPath(import.meta.url))),
    bunPath: process.execPath,
    skillOnly: args.flags.has("skill-only"),
  });
  process.stdout.write(messages.join("\n") + "\n");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help" || args.flags.has("help") || args.cmd === "-h") {
    process.stdout.write(args.cmd === "guide" ? GUIDE_HELP : HELP);
    return 0;
  }
  if (args.cmd === "hook") return cmdHook();
  if (args.cmd === "install") return cmdInstall(args);
  const paths = await repoPaths(process.cwd());
  switch (args.cmd) {
    case "open":
      return cmdOpen(args, paths);
    case "review":
      return cmdReview(args, paths);
    case "serve":
      return cmdServe(args, paths);
    case "stop":
      return cmdStop(paths);
    case "clean":
      return cmdClean(args, paths);
    case "guide":
      return cmdGuide(args, paths);
    default:
      process.stderr.write(`unknown command: ${args.cmd}\n\n${HELP}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`turndiff: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
