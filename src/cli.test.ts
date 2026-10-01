import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git/exec.ts";

const cli = join(import.meta.dir, "cli.ts");

test("review timeout bounds the real long poll and rejects invalid durations", async () => {
  const root = await mkdtemp(join(tmpdir(), "turndiff-cli-test-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  try {
    await git(root, ["init", "-qb", "main"]);
    const start = Date.now();
    const result = await run("review", "--no-open", "--timeout", "0.1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Still waiting");
    expect(Date.now() - start).toBeLessThan(3000);
    for (const value of ["garbage", "-1", "Infinity"]) {
      const invalid = await run("review", "--no-open", "--timeout", value);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("--timeout expects");
    }
  } finally {
    await run("stop");
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
