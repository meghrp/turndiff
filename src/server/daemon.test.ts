import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoPaths, type RepoPaths } from "../git/exec.ts";
import { codeStamp, ensureDaemon, readState, stopDaemon, writeState, type DaemonState } from "./daemon.ts";

const daemonModule = join(import.meta.dir, "daemon.ts");

async function withRepo(run: (paths: RepoPaths) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "turndiff-daemon-test-"));
  try {
    await git(root, ["init", "-qb", "main"]);
    await run(await repoPaths(root));
  } finally {
    await stopDaemon(await repoPaths(root));
    await rm(root, { recursive: true, force: true });
  }
}

function state(port: number, pid: number, id = crypto.randomUUID()): DaemonState {
  return { id, port, pid, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString(), code: codeStamp() };
}

function launchCommand(paths: RepoPaths) {
  return Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { ensureDaemon } from ${JSON.stringify(daemonModule)};
    console.log(JSON.stringify(await ensureDaemon(${JSON.stringify(paths)}, 0)));
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}

async function commandResult(child: ReturnType<typeof launchCommand>) {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`launcher failed (${code}): ${stderr}`);
  return JSON.parse(stdout) as { state: DaemonState; fresh: boolean };
}

test("stale metadata never signals an unrelated live PID", () =>
  withRepo(async (paths) => {
    const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const impostor = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ id: "different-server", pid: sleeper.pid, root: paths.root }),
    });
    try {
      await writeState(paths, state(impostor.port!, sleeper.pid));
      expect(await readState(paths)).toBeNull();
      expect(await stopDaemon(paths)).toBe(false);
      expect(sleeper.exitCode).toBeNull();
      process.kill(sleeper.pid, 0);
      await Bun.write(
        join(paths.gitDir, "turndiff", "server.json"),
        JSON.stringify({ pid: sleeper.pid, port: impostor.port, url: `http://127.0.0.1:${impostor.port}` }),
      );
      expect(await stopDaemon(paths)).toBe(false);
      process.kill(sleeper.pid, 0);
    } finally {
      impostor.stop(true);
      sleeper.kill();
      await sleeper.exited;
    }
  }));

test("validation of stale state cannot delete a newer server record", () =>
  withRepo(async (paths) => {
    let requested!: () => void;
    let release!: () => void;
    const request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        requested();
        await wait;
        return Response.json({ id: "different-server" });
      },
    });
    try {
      await writeState(paths, state(server.port!, process.pid));
      const reading = readState(paths);
      await request;
      const newer = state(server.port!, process.pid);
      await writeState(paths, newer);
      release();
      expect(await reading).toBeNull();
      expect(JSON.parse(await readFile(join(paths.gitDir, "turndiff", "server.json"), "utf8"))).toEqual(newer);
    } finally {
      release();
      server.stop(true);
    }
  }));

test(
  "concurrent CLI processes start one daemon and preserve both commands' edits",
  () =>
    withRepo(async (paths) => {
      const children = [launchCommand(paths), launchCommand(paths)];
      try {
        const results = await Promise.all(children.map(commandResult));
        expect(results[0]!.state.pid).toBe(results[1]!.state.pid);
        expect(results[0]!.state.id).toBe(results[1]!.state.id);
        expect(results.map((r) => r.fresh).sort()).toEqual([false, true]);
        const url = results[0]!.state.url;
        for (let i = 0; i < results.length; i++) {
          expect(
            (
              await fetch(`${results[i]!.state.url}/api/viewed`, {
                method: "PUT",
                body: JSON.stringify({ key: `from-command-${i}`, viewed: true }),
              })
            ).ok,
          ).toBe(true);
        }
        const review = (await (await fetch(`${url}/api/review`)).json()) as { viewed: string[] };
        expect(review.viewed).toEqual(["from-command-0", "from-command-1"]);
        expect(await stopDaemon(paths)).toBe(true);
        expect(await readState(paths)).toBeNull();
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
        await Promise.all(children.map((child) => child.exited));
      }
    }),
  15_000,
);

test(
  "a crashed lock owner releases a waiting command without deleting lock files",
  () =>
    withRepo(async (paths) => {
      const dir = join(paths.gitDir, "turndiff");
      await mkdir(dir, { recursive: true });
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(join(dir, "daemon-lock.sqlite"))});
    db.exec("BEGIN IMMEDIATE");
    await Bun.write(${JSON.stringify(join(dir, "locked"))}, "ready");
    setInterval(() => {}, 1000);
  `,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      try {
        const deadline = Date.now() + 3000;
        while (!(await Bun.file(join(dir, "locked")).exists())) {
          if (Date.now() > deadline || owner.exitCode !== null) throw new Error("lock owner failed to start");
          await Bun.sleep(10);
        }
        let finished = false;
        const starting = ensureDaemon(paths, 0).then((result) => {
          finished = true;
          return result;
        });
        await Bun.sleep(200);
        expect(finished).toBe(false);
        owner.kill("SIGKILL");
        await owner.exited;
        const result = await starting;
        expect(result.fresh).toBe(true);
        expect((await readState(paths))?.id).toBe(result.state.id);
        expect(await stopDaemon(paths)).toBe(true);
      } finally {
        if (owner.exitCode === null) owner.kill("SIGKILL");
        await owner.exited;
      }
    }),
  15_000,
);

test(
  "failed child startup releases the launch lock for a corrected retry",
  () =>
    withRepo(async (paths) => {
      const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
      try {
        await expect(ensureDaemon(paths, occupied.port!)).rejects.toThrow("review server exited early");
        expect(await readState(paths)).toBeNull();
        expect((await ensureDaemon(paths, 0)).fresh).toBe(true);
        expect(await stopDaemon(paths)).toBe(true);
      } finally {
        occupied.stop(true);
      }
    }),
  15_000,
);

const cli = join(import.meta.dir, "..", "cli.ts");

async function until<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test(
  "a second direct serve command cannot open the same review store",
  () =>
    withRepo(async (paths) => {
      const first = Bun.spawn([process.execPath, cli, "serve"], { cwd: paths.root, stdout: "ignore", stderr: "pipe" });
      let second: typeof first | null = null;
      try {
        const original = await until(() => readState(paths), "the first foreground server");
        expect(
          (await fetch(`${original.url}/api/summary`, { method: "PUT", body: JSON.stringify({ summary: "keep my review" }) })).ok,
        ).toBe(true);
        second = Bun.spawn([process.execPath, cli, "serve"], { cwd: paths.root, stdout: "ignore", stderr: "pipe" });
        const timeout = setTimeout(() => second?.kill("SIGKILL"), 3000);
        try {
          expect(await second.exited).toBe(75);
        } finally {
          clearTimeout(timeout);
        }
        expect(await new Response(second.stderr).text()).toContain("a review server already owns this worktree");
        expect((await readState(paths))?.id).toBe(original.id);
        const review = (await (await fetch(`${original.url}/api/review`)).json()) as { summary: string };
        expect(review.summary).toBe("keep my review");
        first.kill("SIGKILL");
        await first.exited;
        const replacement = await ensureDaemon(paths, 0);
        expect(replacement.fresh).toBe(true);
        expect(replacement.state.id).not.toBe(original.id);
        const recovered = (await (await fetch(`${replacement.state.url}/api/review`)).json()) as { summary: string };
        expect(recovered.summary).toBe("keep my review");
      } finally {
        for (const child of [first, second]) {
          if (!child) continue;
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
      }
    }),
  15_000,
);

test(
  "a launcher killed before state publication leaves one server for its successor",
  () =>
    withRepo(async (paths) => {
      const dir = join(paths.gitDir, "turndiff");
      await mkdir(dir, { recursive: true });
      const bootFile = join(dir, "boot.json");
      const publishFile = join(dir, "publish");
      const script = join(dir, "boot.ts");
      // Pause a real server between taking its lifetime lease and publishing its state.
      await Bun.write(
        script,
        `
    import { withServerLease, writeState, codeStamp } from ${JSON.stringify(daemonModule)};
    import { startServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    const paths = ${JSON.stringify(paths)};
    await withServerLease(paths, async () => {
      const server = await startServer({ paths, port: 0 });
      const state = { id: server.id, pid: process.pid, port: server.port, url: server.url, startedAt: new Date().toISOString(), code: codeStamp() };
      process.on("SIGTERM", () => { server.stop(); process.exit(0); });
      await Bun.write(${JSON.stringify(bootFile)}, JSON.stringify(state));
      while (!await Bun.file(${JSON.stringify(publishFile)}).exists()) await Bun.sleep(10);
      await writeState(paths, state);
      await new Promise(() => {});
    });
  `,
      );
      const launcher = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
    import { Database } from "bun:sqlite";
    import { spawn } from "node:child_process";
    const db = new Database(${JSON.stringify(join(dir, "daemon-lock.sqlite"))});
    db.exec("BEGIN IMMEDIATE");
    const child = spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: "ignore" });
    child.unref();
    setInterval(() => {}, 1000);
  `,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      let boot: DaemonState | null = null;
      let successor: ReturnType<typeof launchCommand> | null = null;
      try {
        boot = await until(async () => {
          try {
            return JSON.parse(await readFile(bootFile, "utf8")) as DaemonState;
          } catch {
            return null;
          }
        }, "the unpublished server");
        expect(await readState(paths)).toBeNull();
        launcher.kill("SIGKILL");
        await launcher.exited;
        successor = launchCommand(paths);
        await Bun.sleep(250);
        expect(successor.exitCode).toBeNull();
        expect(await readState(paths)).toBeNull();
        await Bun.write(publishFile, "publish");
        const reused = await commandResult(successor);
        expect(reused.state.id).toBe(boot.id);
        expect(reused.state.pid).toBe(boot.pid);
        expect(reused.fresh).toBe(false);
        expect((await readState(paths))?.id).toBe(boot.id);
      } finally {
        if (launcher.exitCode === null) launcher.kill("SIGKILL");
        await launcher.exited;
        if (successor?.exitCode === null) successor.kill();
        if (successor) await successor.exited;
        if (boot) {
          try {
            process.kill(boot.pid, "SIGTERM");
          } catch {
            /* Already stopped. */
          }
          await until(async () => {
            try {
              process.kill(boot!.pid, 0);
              return null;
            } catch {
              return true;
            }
          }, "the disposable server to stop");
        }
      }
    }),
  15_000,
);

test(
  "failed state publication releases the server lease for a corrected retry",
  () =>
    withRepo(async (paths) => {
      const file = join(paths.gitDir, "turndiff", "server.json");
      await mkdir(file, { recursive: true });
      await expect(ensureDaemon(paths, 0)).rejects.toThrow("review server exited early");
      expect(await readState(paths)).toBeNull();
      await rm(file, { recursive: true });
      const result = await ensureDaemon(paths, 0);
      expect(result.fresh).toBe(true);
      expect((await readState(paths))?.id).toBe(result.state.id);
      expect(await stopDaemon(paths)).toBe(true);
    }),
  15_000,
);
