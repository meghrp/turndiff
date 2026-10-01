import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "./install.ts";

async function fixture(run: (opts: Parameters<typeof install>[0]) => Promise<void>) {
  const homeDir = await mkdtemp(join(tmpdir(), "turndiff-install-"));
  try {
    const repoDir = join(homeDir, "package with ' quotes");
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(join(repoDir, "skills", "turndiff-review"), { recursive: true });
    await Bun.write(join(repoDir, "src", "cli.ts"), "console.log(process.argv[2]);\n");
    const bunPath = join(homeDir, "bun with ' quotes");
    await symlink(process.execPath, bunPath);
    await run({ homeDir, repoDir, bunPath, skillOnly: false });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("install preserves existing settings, quotes executable paths, and is idempotent", () =>
  fixture(async (opts) => {
    const settingsPath = join(opts.homeDir, ".claude", "settings.json");
    await mkdir(join(opts.homeDir, ".claude"));
    const previous = JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] },
    });
    await Bun.write(settingsPath, previous);
    await install(opts);
    const installed = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(installed);
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo existing");
    const proc = Bun.spawn(["/bin/sh", "-c", settings.hooks.UserPromptSubmit[0].hooks[0].command], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("hook\n");
    expect(await proc.exited).toBe(0);
    expect(await readFile(`${settingsPath}.turndiff.bak`, "utf8")).toBe(previous);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${settingsPath}.turndiff.bak`)).mode & 0o777).toBe(0o600);
    await install(opts);
    expect(await readFile(settingsPath, "utf8")).toBe(installed);
    expect(await readlink(join(opts.homeDir, ".claude", "skills", "turndiff-review"))).toBe(
      join(opts.repoDir, "skills", "turndiff-review"),
    );
  }));

test("install refuses to delete an existing skill directory or change settings", () =>
  fixture(async (opts) => {
    const skill = join(opts.homeDir, ".claude", "skills", "turndiff-review");
    await mkdir(skill, { recursive: true });
    await Bun.write(join(skill, "keep.txt"), "user work");
    const settingsPath = join(opts.homeDir, ".claude", "settings.json");
    await Bun.write(settingsPath, "{}");
    await expect(install(opts)).rejects.toThrow("not a symlink");
    expect(await readFile(join(skill, "keep.txt"), "utf8")).toBe("user work");
    expect(await readFile(settingsPath, "utf8")).toBe("{}");
  }));

test("malformed settings are left untouched while skill-only installation stays independent", () =>
  fixture(async (opts) => {
    await mkdir(join(opts.homeDir, ".claude"));
    const path = join(opts.homeDir, ".claude", "settings.json");
    await Bun.write(path, '{"hooks":{"Stop":123}}');
    await expect(install(opts)).rejects.toThrow("must be an array");
    expect(await readFile(path, "utf8")).toBe('{"hooks":{"Stop":123}}');
    await install({ ...opts, skillOnly: true });
    expect(await readFile(path, "utf8")).toBe('{"hooks":{"Stop":123}}');
  }));
