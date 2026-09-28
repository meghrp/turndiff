// A scratch repo with a git-spice stack main <- feat-a <- feat-b <- feat-c and
// two recorded agent turns. Turn 1 commits on feat-b, switches to feat-a and
// commits there, pulls a new main, restacks everything, and ends on feat-b
// with uncommitted work. Turn 2 creates feat-d on top of feat-c and returns to
// feat-b. Shared by the tests and `bun scripts/scenario.ts`.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git/exec.ts";
import { recordHook } from "./git/snapshots.ts";

export const SESSION = "sess-1";

const STACK: [name: string, base: string, pr: number | null][] = [
  ["feat-a", "main", null],
  ["feat-b", "feat-a", 42],
  ["feat-c", "feat-b", null],
];

export interface Scenario {
  root: string;
  /** The single commit the agent made on feat-a during the turn, after restack. */
  featACommit: string;
}

export async function buildScenario(dir?: string): Promise<Scenario> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), "turndiff-scenario-")));
  const run = (...args: string[]) => git(root, args);
  const put = (path: string, text: string) => writeFile(join(root, path), text);

  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "dev@example.invalid");
  await run("config", "user.name", "Dev");
  await put("a.txt", "line1\nline2\nline3\n");
  await put("b.txt", "base\n");
  await run("add", "-A");
  await run("commit", "-qm", "c1");
  await run("checkout", "-qb", "feat-a");
  await put("feat_a.py", "a1\na2\n");
  await run("add", "-A");
  await run("commit", "-qm", "feat-a: add feat_a.py");
  await run("checkout", "-qb", "feat-b");
  await put("feat_b.py", "def f():\n    return 1\n");
  await run("add", "-A");
  await run("commit", "-qm", "feat-b: add f");
  await run("checkout", "-qb", "feat-c");
  await put("feat_c.py", "C = 1\n");
  await run("add", "-A");
  await run("commit", "-qm", "feat-c: add C");
  await run("checkout", "-q", "feat-b");
  await writeSpice(root, STACK);
  await put("notes.md", "scratch notes, untracked before the turn\n");

  await recordHook({ sessionId: SESSION, event: "UserPromptSubmit", cwd: root, prompt: "add g to feat-b, a3 to feat-a, then restack" });
  await put("feat_b.py", "def f():\n    return 1\n\ndef g():\n    return 2\n");
  await run("commit", "-qam", "feat-b: add g");
  await run("checkout", "-q", "feat-a");
  await put("feat_a.py", "a1\na2\na3\n");
  await run("commit", "-qam", "feat-a: add a3");
  await run("checkout", "-q", "main");
  await put("a.txt", "line1\nline2\nline3\nline4 from upstream\n");
  await put("upstream.txt", "pulled from origin\n");
  await run("add", "a.txt", "upstream.txt");
  await run("commit", "-qm", "main: upstream work");
  for (const [branch, onto] of [["feat-a", "main"], ["feat-b", "feat-a"], ["feat-c", "feat-b"]] as const) {
    await run("checkout", "-q", branch);
    await run("rebase", "-q", onto);
  }
  await run("checkout", "-q", "feat-b");
  await put("feat_b.py", "def f():\n    return 1\n\ndef g():\n    return 2\n\ndef h():\n    return 3\n");
  await recordHook({ sessionId: SESSION, event: "Stop", cwd: root });

  await recordHook({ sessionId: SESSION, event: "UserPromptSubmit", cwd: root, prompt: "start feat-d on top of the stack" });
  await run("checkout", "-q", "-b", "feat-d", "feat-c");
  await put("feat_d.py", "D = 4\n");
  await run("add", "feat_d.py");
  await run("commit", "-qm", "feat-d: add D");
  await writeSpice(root, [...STACK, ["feat-d", "feat-c", null]]);
  await run("checkout", "-q", "feat-b");
  await recordHook({ sessionId: SESSION, event: "Stop", cwd: root });

  return { root, featACommit: await run("rev-parse", "feat-a") };
}

/** git-spice's metadata ref: a tree with `repo` and `branches/<name>` JSON blobs. */
async function writeSpice(root: string, branches: [name: string, base: string, pr: number | null][]): Promise<void> {
  const blob = (data: unknown) => git(root, ["hash-object", "-w", "--stdin"], { stdin: JSON.stringify(data) });
  const entries: string[] = [];
  for (const [name, base, pr] of branches) {
    const hash = await git(root, ["rev-parse", base]);
    const change = pr ? { github: { pr: { number: pr }, comment: { url: `https://github.com/acme/app/pull/${pr}#issuecomment-1` } } } : undefined;
    entries.push(`100644 blob ${await blob({ base: { name: base, hash }, change })}\t${name}`);
  }
  const branchTree = await git(root, ["mktree"], { stdin: entries.join("\n") + "\n" });
  const repo = await blob({ trunk: "main", remote: "origin" });
  const rootTree = await git(root, ["mktree"], { stdin: `100644 blob ${repo}\trepo\n040000 tree ${branchTree}\tbranches\n` });
  await git(root, ["update-ref", "refs/spice/data", await git(root, ["commit-tree", rootTree, "-m", "spice"])]);
}
