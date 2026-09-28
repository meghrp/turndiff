#!/usr/bin/env bun
// turndiff: review agent turns and stacked branches, send comments back.

import { readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { currentBranch, git, gitOrNull, repoPaths } from "./git/exec.ts";
import { deleteSession, handleHook, listSessions, loadSession, snapshotWorktree, type Session } from "./git/checkpoints.ts";
import { readSpice, resolveParent, stackFor, trunkComparisonRef } from "./git/spice.ts";
import { branchDiff, turnDiff } from "./git/diff.ts";
import { startServer } from "./server/index.ts";
import { readState, spawnDaemon, stopDaemon, waitForResult, writeResult, writeState, type DaemonResult } from "./server/daemon.ts";
import { formatFeedback } from "./feedback.ts";
import type { Scope } from "./shared.ts";

const HELP = `turndiff — review agent turns and git-spice stacks, send feedback back to the agent

Usage:
  turndiff review [scope] [options]   Open the review UI, wait for the reviewer to submit, print feedback.
                                      The server runs detached; re-run to keep waiting or reattach.
  turndiff stop                       Stop a running review server.
  turndiff diff <scope> [--ws]        Print the unified patch for a scope.
  turndiff turns [--session <id>]     List captured turns for a session (default: latest).
  turndiff sessions                   List sessions with checkpoints in this repo.
  turndiff stack                      Show the git-spice stack for the current branch.
  turndiff hook                       Claude Code hook entrypoint (reads the hook JSON on stdin).
  turndiff install [--skill-only]     Register hooks in ~/.claude/settings.json and install the review skill.
  turndiff clean [--all | --session <id> | --keep <n>]   Remove checkpoint refs and session metadata.

Scope (review/diff):
  --turn <n>                Diff of turn n (pre → post). Default for review: latest turn.
  --from <n> --to <m>       Cumulative diff across turns n..m.
  --session <id>            Session to read turns from (default: most recently updated).
  --branch [name]           Branch-only diff against its git-spice parent (default: current branch).
  --worktree                Include uncommitted changes in a branch diff.

Review options:
  --port <n>                Fixed port (default: random).
  --no-open                 Do not open the browser when starting a server.
  --open                    Open the browser even when reattaching.
  --restart                 Stop any running review server first.
  --json                    Print the submission as JSON instead of markdown.
  --out <file>              Also write the feedback to a file.
  --timeout <seconds>       Stop waiting after this long (default 540, 0 = forever). Server keeps running.
`;

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else flags.set(key, true);
    } else rest.push(a);
  }
  return { cmd, flags, rest };
}

function flagStr(flags: Map<string, string | true>, key: string): string | null {
  const v = flags.get(key);
  return typeof v === "string" ? v : null;
}

async function latestSession(paths: Awaited<ReturnType<typeof repoPaths>>, id: string | null): Promise<Session | null> {
  if (id) return loadSession(paths, id);
  const all = await listSessions(paths);
  return all[0] ?? null;
}

async function resolveScope(args: Args, cwd: string): Promise<Scope | null> {
  const paths = await repoPaths(cwd);
  const { flags } = args;
  if (flags.has("branch")) {
    const name = flagStr(flags, "branch") ?? (await currentBranch(cwd));
    if (!name) throw new Error("detached HEAD: pass --branch <name>");
    return { kind: "branch", name, worktree: flags.has("worktree") };
  }
  if (flags.has("turn") || flags.has("to") || flags.has("from")) {
    const session = await latestSession(paths, flagStr(flags, "session"));
    if (!session) throw new Error("no sessions with checkpoints in this repo (are the hooks installed?)");
    const to = Number(flagStr(flags, "to") ?? flagStr(flags, "turn") ?? session.turns.at(-1)?.turn ?? 1);
    const from = Number(flagStr(flags, "from") ?? to);
    return { kind: "turn", sessionId: session.id, from, to };
  }
  return null;
}

async function defaultReviewScope(cwd: string): Promise<Scope | null> {
  const paths = await repoPaths(cwd);
  const session = (await listSessions(paths))[0];
  const last = session?.turns.at(-1);
  if (session && last) return { kind: "turn", sessionId: session.id, from: last.turn, to: last.turn };
  const branch = await currentBranch(cwd);
  return branch ? { kind: "branch", name: branch, worktree: true } : null;
}

async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener; URL is printed anyway */
  }
}

/** Internal: the detached review server. Spawned by `review`, exits after the reviewer submits. */
async function cmdServe(args: Args, cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const port = Number(flagStr(args.flags, "port") ?? 0);
  const preselectRaw = flagStr(args.flags, "preselect");
  const preselect = preselectRaw ? (JSON.parse(preselectRaw) as Scope) : null;
  const server = await startServer({ paths, port, preselect });
  await writeState(paths, { pid: process.pid, port: server.port, url: server.url, startedAt: new Date().toISOString(), preselect });
  const shutdown = async (result: DaemonResult) => {
    await writeResult(paths, result);
    setTimeout(() => {
      server.stop();
      process.exit(0);
    }, 300);
  };
  process.on("SIGTERM", () => void shutdown({ kind: "cancelled" }));
  // Idle guard: nobody reviews for a day, free the port.
  setTimeout(() => void shutdown({ kind: "cancelled" }), 24 * 3600 * 1000).unref();
  const outcome = await server.result;
  await shutdown(outcome ? { kind: "submitted", submission: outcome } : { kind: "cancelled" });
  return 0;
}

async function cmdReview(args: Args, cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  if (args.flags.has("restart")) await stopDaemon(paths);
  let state = await readState(paths);
  let fresh = false;
  if (!state) {
    const preselect = (await resolveScope(args, cwd)) ?? (await defaultReviewScope(cwd));
    const port = Number(flagStr(args.flags, "port") ?? 0);
    state = await spawnDaemon(paths, { port, preselect });
    fresh = true;
  }
  process.stderr.write(`turndiff review: ${state.url}${fresh ? "" : " (reattached to running review)"}\n`);
  if (fresh ? !args.flags.has("no-open") : args.flags.has("open")) await openBrowser(state.url);

  // Default stays under Claude Code's 10-minute Bash ceiling so the agent gets a
  // clean "still waiting" message instead of a killed tool call.
  const timeoutSec = Number(flagStr(args.flags, "timeout") ?? 540);
  const outcome = await waitForResult(paths, timeoutSec * 1000);

  if (outcome === "timeout") {
    process.stdout.write(
      `Still waiting for the reviewer at ${state.url}.\nThe review server keeps running. Run \`turndiff review\` again to keep waiting for the feedback.\n`,
    );
    return 0;
  }
  if (outcome === "gone") {
    process.stderr.write("turndiff review: the review server stopped without a result\n");
    return 2;
  }
  if (outcome.kind === "cancelled") {
    process.stdout.write("Review cancelled by the reviewer. No feedback.\n");
    return 0;
  }
  const text = args.flags.has("json") ? JSON.stringify(outcome.submission, null, 2) : formatFeedback(outcome.submission);
  const outFile = flagStr(args.flags, "out");
  if (outFile) await writeFile(outFile, text + "\n");
  process.stdout.write(text + "\n");
  return 0;
}

async function cmdStop(cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const stopped = await stopDaemon(paths);
  process.stdout.write(stopped ? "review server stopped\n" : "no review server running\n");
  return 0;
}

async function cmdDiff(args: Args, cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const scope = await resolveScope(args, cwd);
  if (!scope) throw new Error("diff needs --turn/--from/--to or --branch");
  const ws = args.flags.has("ws");
  if (scope.kind === "branch") {
    const parent = (await resolveParent(cwd, scope.name)) ?? (await trunkComparisonRef(cwd, scope.name));
    if (!parent) throw new Error(`no parent for ${scope.name}`);
    const head = scope.worktree ? (await snapshotWorktree(paths, "turndiff diff")).commit : undefined;
    const d = await branchDiff(cwd, scope.name, parent, { head, ignoreWhitespace: ws });
    process.stdout.write(d.patch + (d.patch.endsWith("\n") || d.patch.length === 0 ? "" : "\n"));
    return 0;
  }
  const session = await loadSession(paths, scope.sessionId);
  if (!session) throw new Error(`unknown session ${scope.sessionId}`);
  const fromTurn = session.turns.find((t) => t.turn === scope.from);
  const toTurn = session.turns.find((t) => t.turn === scope.to);
  const from = fromTurn?.pre ?? session.turns.filter((t) => t.turn < scope.from && t.post).at(-1)?.post;
  const to = toTurn?.post;
  if (!from || !to) throw new Error(`turn range ${scope.from}..${scope.to} incomplete (turn still running?)`);
  const d = await turnDiff(cwd, from, to, { ignoreWhitespace: ws });
  if (d.replay) process.stderr.write(`replayed pre-turn state onto new base ${d.replay.newBase.slice(0, 10)}${d.replay.conflicts ? " (conflicts)" : ""}\n`);
  process.stdout.write(d.patch + (d.patch.endsWith("\n") || d.patch.length === 0 ? "" : "\n"));
  return 0;
}

async function cmdTurns(args: Args, cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const session = await latestSession(paths, flagStr(args.flags, "session"));
  if (!session) {
    process.stdout.write("no sessions\n");
    return 0;
  }
  process.stdout.write(`session ${session.id} (${session.source}) — ${session.turns.length} turns\n`);
  for (const t of session.turns) {
    const state = t.post ? "done" : "running";
    const prompt = t.prompt ? t.prompt.replace(/\s+/g, " ").slice(0, 80) : "(no prompt)";
    const rebased = t.pre && t.post && t.pre.parentMergeBase && t.post.parentMergeBase && t.pre.parentMergeBase !== t.post.parentMergeBase ? " [rebased]" : "";
    process.stdout.write(`  ${String(t.turn).padStart(3)}  ${state.padEnd(7)} ${t.startedAt.slice(0, 19)}  ${t.post?.branch ?? t.pre?.branch ?? "-"}${rebased}  ${prompt}\n`);
  }
  return 0;
}

async function cmdSessions(cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const sessions = await listSessions(paths);
  if (sessions.length === 0) process.stdout.write("no sessions\n");
  for (const s of sessions) process.stdout.write(`${s.id}  ${s.source}  turns=${s.turns.length}  updated=${s.updatedAt.slice(0, 19)}\n`);
  return 0;
}

async function cmdStack(cwd: string): Promise<number> {
  const branch = await currentBranch(cwd);
  const stack = await stackFor(cwd, branch, await readSpice(cwd));
  if (stack.length === 0) {
    process.stdout.write("no git-spice stack for this branch\n");
    return 0;
  }
  for (const e of stack) {
    const marker = e.isCurrent ? "*" : " ";
    const pr = e.prNumber ? `  #${e.prNumber}` : "";
    process.stdout.write(`${marker} ${"  ".repeat(e.depth)}${e.name}${e.isTrunk ? "" : ` (+${e.ahead} on ${e.base})`}${pr}\n`);
  }
  return 0;
}

async function cmdHook(): Promise<number> {
  // Never break the agent's turn: swallow everything, report on stderr.
  try {
    const raw = await Bun.stdin.text();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const sessionId = String(payload.session_id ?? "");
    const event = String(payload.hook_event_name ?? "");
    const cwd = String(payload.cwd ?? process.cwd());
    if (!sessionId || !event) return 0;
    if (event !== "UserPromptSubmit" && event !== "Stop") return 0;
    if ((await gitOrNull(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return 0;
    const r = await handleHook({ sessionId, event, cwd, prompt: typeof payload.prompt === "string" ? payload.prompt : undefined, source: "claude-code" });
    if (process.env.TURNDIFF_DEBUG) process.stderr.write(`turndiff: ${r.action}\n`);
  } catch (e) {
    process.stderr.write(`turndiff hook: ${(e as Error).message}\n`);
  }
  return 0;
}

async function cmdClean(args: Args, cwd: string): Promise<number> {
  const paths = await repoPaths(cwd);
  const sessions = await listSessions(paths);
  let targets: Session[] = [];
  if (args.flags.has("all")) targets = sessions;
  else if (flagStr(args.flags, "session")) targets = sessions.filter((s) => s.id === flagStr(args.flags, "session"));
  else {
    const keep = Number(flagStr(args.flags, "keep") ?? 5);
    targets = sessions.slice(keep);
  }
  for (const s of targets) {
    await deleteSession(paths, s.id);
    process.stdout.write(`removed session ${s.id} (${s.turns.length} turns)\n`);
  }
  if (targets.length === 0) process.stdout.write("nothing to clean\n");
  return 0;
}

async function cmdInstall(args: Args): Promise<number> {
  const home = homedir();
  const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
  // Skill: symlink so edits in the repo show up immediately.
  const skillsDir = join(home, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const skillLink = join(skillsDir, "turndiff-review");
  if (existsSync(skillLink)) await rm(skillLink, { recursive: true, force: true });
  await symlink(join(repoDir, "skills", "turndiff-review"), skillLink);
  process.stdout.write(`skill: ${skillLink} -> ${join(repoDir, "skills", "turndiff-review")}\n`);
  if (args.flags.has("skill-only")) return 0;

  const settingsPath = join(home, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? (JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  // Absolute path: hook shells do not always share the interactive PATH.
  const command = `${process.execPath} ${join(repoDir, "src", "cli.ts")} hook`;
  let changed = false;
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const list = hooks[event] ?? [];
    const present = list.some((g) => g.hooks?.some((h) => h.command === command));
    if (!present) {
      list.push({ hooks: [{ type: "command", command, timeout: 60 }] });
      hooks[event] = list;
      changed = true;
    }
  }
  if (changed) {
    if (existsSync(settingsPath)) await writeFile(`${settingsPath}.turndiff.bak`, await readFile(settingsPath));
    settings.hooks = hooks;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    process.stdout.write(`hooks: added UserPromptSubmit + Stop to ${settingsPath} (backup at .turndiff.bak)\n`);
  } else process.stdout.write(`hooks: already present in ${settingsPath}\n`);
  process.stdout.write("Restart Claude Code sessions for hooks to take effect.\n");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  switch (args.cmd) {
    case "review":
      return cmdReview(args, cwd);
    case "serve":
      return cmdServe(args, cwd);
    case "stop":
      return cmdStop(cwd);
    case "diff":
      return cmdDiff(args, cwd);
    case "turns":
      return cmdTurns(args, cwd);
    case "sessions":
      return cmdSessions(cwd);
    case "stack":
      return cmdStack(cwd);
    case "hook":
      return cmdHook();
    case "clean":
      return cmdClean(args, cwd);
    case "install":
      return cmdInstall(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
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
