// End-to-end: build the scenario repo, serve it in-process, and drive the real
// UI in Chrome through branch, commit and turn views, comments on two branches,
// a reload, the review panel, and a submit that a waiting CLI receives.
// Usage: bun run e2e [screenshot dir, default /tmp/turndiff-shots]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildScenario } from "../src/scenario.ts";
import { startServer } from "../src/server/index.ts";
import { repoPaths } from "../src/git/exec.ts";
import type { WaitResponse } from "../src/model.ts";

const shots = process.argv[2] ?? "/tmp/turndiff-shots";
await mkdir(shots, { recursive: true });

function assert(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok  ${what}`);
}

const { root } = await buildScenario();
const server = await startServer({ paths: await repoPaths(root), port: 0 });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const shot = (name: string) => page.screenshot({ path: `${shots}/e2e-${name}.png` });
  const title = () => page.locator(".toolbar .title").innerText();

  await page.goto(server.url);
  await page.locator(".card").first().waitFor();
  assert((await page.evaluate(() => location.hash)) === "#branch/feat-b+working", "defaults to the current branch with uncommitted changes");

  await selectBranch(page, "feat-a");
  assert((await title()).startsWith("feat-a"), "branch view of feat-a");
  await comment(page, "feat_a.py", 2, "feat-a: name this list");
  await shot("feat-a-comment");

  await selectBranch(page, "feat-b");
  assert((await title()).startsWith("feat-b"), "branch view of feat-b");
  await comment(page, "feat_b.py", 4, "feat-b: g needs a docstring");

  await page.locator(".row.branch", { hasText: "feat-a" }).locator(".chev").click();
  await page.locator(".row.commit", { hasText: "feat-a: add a3" }).click();
  await waitTitle(page, "feat-a: add a3");
  const commitTitle = await title();
  assert(commitTitle.includes("feat-a: add a3") && commitTitle.includes("on feat-a"), `single-commit view says it is on feat-a (${commitTitle})`);
  await shot("commit");

  await page.locator(".row.turn", { hasText: "add g to feat-b" }).click();
  await waitTitle(page, "Turn 1");
  assert((await page.evaluate(() => location.hash)) === "#turns/sess-1/1-1", "turn row navigates to #turns/sess-1/1-1");
  const sections = await page.locator(".section-head .branch-name").allInnerTexts();
  assert(JSON.stringify(sections) === JSON.stringify(["feat-a", "feat-b"]), `turn 1 has sections feat-a and feat-b (${sections})`);
  const removals = await page.locator('[data-line-type="change-deletion"]').count();
  assert(removals === 0, "turn 1 shows no removal lines from the other branch");
  await shot("turn");

  await selectBranch(page, "feat-b");
  const files = page.locator(".files .row.file");
  assert((await files.count()) === 2, "feat-b with uncommitted changes lists two files");
  await page.keyboard.press("j");
  await page.waitForFunction(() => document.querySelector(".files .row.file.active")?.textContent?.includes("notes.md"));
  assert(true, "j moves to the next file");
  await page.keyboard.press("k");
  await page.waitForFunction(() => document.querySelector(".files .row.file.active")?.textContent?.includes("feat_b.py"));
  assert(true, "k moves back");
  await page.keyboard.press("v");
  const firstCard = page.locator(".card").first();
  await page.waitForFunction(() => document.querySelector(".card")?.classList.contains("collapsed"));
  assert(true, "v marks the current file viewed and collapses its card");
  await page.keyboard.press("u");
  assert((await page.locator(".seg button.on").innerText()) === "split", "u switches to split");
  await page.keyboard.press("u");

  await page.reload();
  await page.locator(".card").first().waitFor();
  assert(await firstCard.evaluate((el) => el.classList.contains("collapsed")), "viewed survives a reload");
  await firstCard.locator(".viewed input").click();
  await page.waitForFunction(() => !document.querySelector(".card")?.classList.contains("collapsed"));
  assert(true, "unchecking Viewed expands the card");

  await writeFile(join(root, "feat_b.py"), "def f():\n    return 10\n");
  await page.locator(".pill").waitFor({ timeout: 15_000 });
  assert(true, "a worktree change shows the new-changes pill without replacing the view");
  await page.keyboard.press("r");
  await page.locator(".pill").waitFor({ state: "detached" });
  await page.locator(".card", { hasText: "return 10" }).waitFor();
  assert(true, "r reloads the view with the change");

  await fetch(`${server.url}/api/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hash: "stack" }) });
  await page.waitForFunction(() => location.hash === "#stack", undefined, { timeout: 15_000 });
  assert(true, "a CLI focus request navigates the open tab");
  await page.goBack();
  await page.waitForFunction(() => location.hash.startsWith("#branch/feat-b"));
  assert(true, "Back returns to the view before the focus");

  await page.keyboard.press("c");
  const drawer = page.locator(".drawer");
  await drawer.waitFor();
  const groupOf = (body: string) =>
    drawer.locator(".rgroup", { has: page.locator(".rbody", { hasText: body }) }).locator(".rgroup-title").innerText();
  assert((await groupOf("feat-a: name this list")) === "feat-a", "after reload, the feat-a comment is listed under feat-a");
  assert((await groupOf("feat-b: g needs a docstring")) === "feat-b", "after reload, the feat-b comment is listed under feat-b");
  await shot("review-panel");

  const waiting = fetch(`${server.url}/api/wait?since=${Date.now()}`).then((r) => r.json() as Promise<WaitResponse>);
  await page.waitForFunction(async () => (await (await fetch("/api/state")).json()).agentWaiting === true);
  await drawer.locator(".summary").fill("Two small things.");
  await drawer.getByRole("button", { name: "Request changes" }).click();
  const received = await waiting;
  assert(received.decision === "request_changes", "the waiting CLI receives the decision");
  assert(
    received.markdown.includes("feat-a: name this list") && received.markdown.includes("feat-b: g needs a docstring"),
    "the submitted markdown contains both comments",
  );
  await drawer.locator(".status-line.ok").waitFor();
  assert((await drawer.locator(".status-line").innerText()).includes("Sent"), "the panel confirms delivery");
  await shot("submitted");

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log(`\nall passed · screenshots in ${shots}`);
} finally {
  await browser.close();
  server.stop();
}

async function selectBranch(page: Page, name: string) {
  await page.locator(".row.branch", { has: page.locator(".bname", { hasText: new RegExp(`^${name}$`) }) }).click();
  await waitTitle(page, `${name} ←`, true);
}

/** Waits until the loaded view's title contains `text`, so assertions never read the previous view. */
async function waitTitle(page: Page, text: string, prefix = false) {
  await page.waitForFunction(
    ([t, p]) => {
      const title = document.querySelector(".toolbar .title")?.textContent ?? "";
      return !document.querySelector(".pane.busy") && (p ? title.startsWith(t) : title.includes(t));
    },
    [text, prefix] as const,
  );
  await page.locator(".card").first().waitFor();
}

async function comment(page: Page, file: string, line: number, body: string) {
  const card = page.locator(".card", { has: page.locator(".card-head .path", { hasText: file }) });
  await card.locator(`[data-column-number="${line}"]`).first().click();
  const box = card.locator(".composer textarea");
  await box.waitFor();
  await box.fill(body);
  await box.press("ControlOrMeta+Enter");
  await card.locator(".comment-body", { hasText: body }).waitFor();
  assert(true, `comment saved on ${file}:${line}`);
}
