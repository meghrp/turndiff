#!/usr/bin/env bun
// turndiff: review git-spice stacks, commits and agent turns in the browser,
// and hand the comments back to the agent.

import { readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { git, gitOrNull, repoPaths, type RepoPaths } from "./git/exec.ts";
import { deleteSession, listSessions, recordHook } from "./git/snapshots.ts";
import { startServer } from "./server/index.ts";
import { clearState, codeStamp, ensureDaemon, stopDaemon, writeState } from "./server/daemon.ts";
import { targetToHash, type Target, type WaitResponse } from "./model.ts";

const HELP = `turndiff: review stacked branches, commits and agent turns, send comments back to the agent

Usage:
  turndiff [open] [target]      Open the review UI for this worktree (starts the server if needed).
  turndiff review [target]      Open it, wait for the reviewer to submit, print the feedback markdown.
  turndiff stop                 Stop this worktree's review server.
  turndiff hook                 Claude Code hook entrypoint (hook JSON on stdin).
  turndiff install [--skill-only]  Register the hooks in ~/.claude/settings.json and link the skill.
  turndiff clean [--keep <n> | --all]  Drop recorded agent sessions (default keeps the newest 5).

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
  --timeout <sec>    review: stop waiting after this long (default 540, 0 = forever). The server keeps running.
  --open / --no-open Force or suppress opening the browser.
  --port <n>         Port for a newly started server (default: random).
`;

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const first = argv[0] && !argv[0].startsWith("--") ? argv[0] : "open";
  const tail = first === argv[0] ? argv.slice(1) : argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (!a.startsWith("--")) continue;
    const next = tail[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(a.slice(2), next);
      i++;
    } else flags.set(a.slice(2), true);
  }
  return { cmd: first, flags };
}

const str = (args: Args, key: string) => {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : null;
};

async function commitOid(cwd: string, rev: string): Promise<string> {
  const oid = await gitOrNull(cwd, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]);
  if (!oid) throw new Error(`unknown revision ${rev}`);
  return oid;
}

async function parseTarget(args: Args, paths: RepoPaths): Promise<Target | null> {
  const cwd = paths.root;
  const f = args.flags;
  if (f.has("branch")) {
    const current = await gitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const name = str(args, "branch") ?? current;
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
  const { state, fresh } = await ensureDaemon(paths, Number(str(args, "port") ?? 0));
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
  const base = await present(args, paths);
  const since = Date.now();
  // Stay under Claude Code's 10-minute Bash ceiling so the agent gets a clean "still waiting".
  const timeoutMs = Number(str(args, "timeout") ?? 540) * 1000;
  const deadline = timeoutMs > 0 ? since + timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/wait?since=${since}`);
    } catch {
      process.stderr.write("turndiff: the review server stopped before feedback was submitted\n");
      return 2;
    }
    if (res.status === 200) {
      process.stdout.write(((await res.json()) as WaitResponse).markdown);
      return 0;
    }
  }
  process.stdout.write(`Still waiting for the reviewer at ${base}.\nThe review server keeps running. Run \`turndiff review\` again to keep waiting.\n`);
  return 0;
}

/** Internal: the foreground server that `ensureDaemon` spawns detached. */
async function cmdServe(args: Args, paths: RepoPaths): Promise<number> {
  const code = codeStamp();
  const server = await startServer({ paths, port: Number(str(args, "port") ?? 0) });
  await writeState(paths, { pid: process.pid, port: server.port, url: server.url, startedAt: new Date().toISOString(), code });
  const shutdown = async () => {
    await clearState(paths, process.pid);
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.stderr.write(`turndiff: serving ${paths.root} at ${server.url}\n`);
  await new Promise(() => {});
  return 0;
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
  const sessions = await listSessions(paths);
  const targets = args.flags.has("all") ? sessions : sessions.slice(Number(str(args, "keep") ?? 5));
  for (const s of targets) {
    await deleteSession(paths, s);
    process.stdout.write(`removed session ${s.id} (${s.turns.length} turns)\n`);
  }
  if (args.flags.has("all")) {
    // v0 left whole-worktree checkpoints and per-scope drafts behind.
    const legacy = ((await gitOrNull(paths.root, ["for-each-ref", "--format=%(refname)", "refs/turndiff/"])) ?? "").split("\n").filter((r) => r && !r.startsWith("refs/turndiff/v1/"));
    for (const ref of legacy) await git(paths.root, ["update-ref", "-d", ref]);
    for (const dir of ["sessions", "drafts", "review"]) await rm(join(paths.commonDir, "turndiff", dir), { recursive: true, force: true });
    if (legacy.length > 0) process.stdout.write(`removed ${legacy.length} v0 checkpoint refs\n`);
  }
  if (targets.length === 0) process.stdout.write("no sessions to remove\n");
  return 0;
}

async function cmdInstall(args: Args): Promise<number> {
  const home = homedir();
  const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const skillsDir = join(home, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const skillLink = join(skillsDir, "turndiff-review");
  await rm(skillLink, { recursive: true, force: true });
  await symlink(join(repoDir, "skills", "turndiff-review"), skillLink);
  process.stdout.write(`skill: ${skillLink} -> ${join(repoDir, "skills", "turndiff-review")}\n`);
  if (args.flags.has("skill-only")) return 0;

  const settingsPath = join(home, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? (JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  // Absolute paths: hook shells do not always share the interactive PATH.
  const command = `${process.execPath} ${join(repoDir, "src", "cli.ts")} hook`;
  let changed = false;
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const list = hooks[event] ?? [];
    if (!list.some((g) => g.hooks?.some((h) => h.command === command))) {
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
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help" || args.flags.has("help") || args.cmd === "-h") {
    process.stdout.write(HELP);
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
