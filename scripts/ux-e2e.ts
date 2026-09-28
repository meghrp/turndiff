// Isolated browser regression suite. No user repository or review is modified.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { repoPaths, git } from "../src/git/exec.ts";

const root = await mkdtemp(join(tmpdir(), "turndiff-ux-"));
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const scope = { kind: "branch" as const, name: "feature", worktree: true };
try {
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "UX test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "a.ts"), "export const value = 1;\n");
  await writeFile(join(root, "b.ts"), "export const other = 1;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
  await git(root, ["checkout", "-qb", "feature"]);
  await writeFile(join(root, "a.ts"), "export const value = 2;\n");
  await writeFile(join(root, "b.ts"), "export const other = 2;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "feature fixture"]);
  const paths = await repoPaths(root);
  server = await startServer({ paths, port: 0, preselect: scope });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      await page.screenshot({ path: "/tmp/turndiff-ux-failure.png" });
      console.log("PAGE ERRORS", errors);
      console.log("PAGE", await page.locator("body").innerText());
      throw e;
    }
  };
  const send = () => page.getByRole("button", { name: /^Send feedback/ });
  const ready = async () => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Send feedback") && !b.disabled),
    );
  };
  await page.goto(server.url);
  await ready();
  await check("keyboard file navigation and filters", async () => {
    await page.getByRole("searchbox", { name: "Search files" }).fill("a.ts");
    assert.equal(await page.locator(".file-jump").count(), 1);
    await page.locator(".file-jump").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".file-jump").getAttribute("aria-current"), "location");
    await page.getByRole("searchbox", { name: "Search files" }).fill("");
    await page.getByRole("checkbox", { name: "Mark a.ts viewed", exact: true }).check();
    await page.getByRole("checkbox", { name: "Unviewed only" }).check();
    assert.equal(await page.locator(".file-jump").count(), 1);
    await page.getByRole("button", { name: "Next unviewed" }).click();
    assert.match(await page.locator('.file-jump[aria-current="location"]').innerText(), /b.ts/);
    await page.getByRole("checkbox", { name: "Unviewed only" }).uncheck();
  });
  await check("unfinished draft survives whitespace toggle and page reload", async () => {
    await page.getByRole("checkbox", { name: "Mark a.ts viewed", exact: true }).uncheck();
    await page.locator('.file-jump[title="a.ts"]').click();
    const gutter = page.locator('[data-column-number][data-line-type="change-addition"]').first();
    await gutter.click();
    const input = page.getByRole("textbox", { name: /^Comment on/ });
    await input.fill("Please explain this change.");
    await page.getByRole("button", { name: "Ignore whitespace", exact: true }).click();
    await ready();
    assert.equal(await input.inputValue(), "Please explain this change.");
    await page.waitForFunction(() => document.querySelector(".review-status")?.textContent?.includes("Saved to repository"));
    await page.reload();
    await ready();
    await page.locator(".draft-list button").click();
    assert.equal(await input.inputValue(), "Please explain this change.");
  });
  await check("failed autosave retains text and supports retry", async () => {
    await page.route("**/api/review?*", async (route) => {
      if (route.request().method() === "PUT")
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Save unavailable" }) });
      else await route.continue();
    });
    const input = page.getByRole("textbox", { name: /^Comment on/ });
    await input.fill("Retain this draft while offline.");
    await page.getByText(/Draft could not be saved/).waitFor();
    assert.equal(await input.inputValue(), "Retain this draft while offline.");
    await page.unroute("**/api/review?*");
    await page.getByRole("button", { name: "Retry save" }).click();
    await page.waitForFunction(() => document.querySelector(".review-status")?.textContent?.includes("Saved to repository"));
    await input.fill("Please explain this change.");
    await page.waitForFunction(() => document.querySelector(".review-status")?.textContent?.includes("Saved to repository"));
  });
  await check("draft survives restart onto a different port", async () => {
    const oldPort = server!.port;
    server!.stop();
    server = await startServer({ paths, port: 0, preselect: scope });
    assert.notEqual(server.port, oldPort);
    await page.goto(server.url);
    await ready();
    await page.locator(".draft-list button").click();
    assert.equal(await page.getByRole("textbox", { name: /^Comment on/ }).inputValue(), "Please explain this change.");
  });
  await check("unsaved drafts require explicit inclusion and dialog is keyboard accessible", async () => {
    await send().click();
    await page.getByRole("dialog", { name: "Include unfinished comments?" }).waitFor();
    await page.getByRole("button", { name: "Include drafts" }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback to the agent" });
    await dialog.waitFor();
    await page.getByRole("radio", { name: /Comment Feedback/ }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("radio", { name: /Approve/ }).isChecked(), true);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true);
    }
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.equal(await send().evaluate((e) => e === document.activeElement), true);
  });
  await check("new code does not silently change comments or viewed files", async () => {
    await page.getByRole("checkbox", { name: "Mark a.ts viewed", exact: true }).check();
    await writeFile(join(root, "a.ts"), "// inserted line\nexport const value = 3;\n");
    // Refresh after the server's two-second worktree snapshot cache expires.
    await page.waitForTimeout(2100);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Load new changes" }).waitFor();
    assert.equal(await send().isDisabled(), true);
    assert.equal(await page.getByRole("checkbox", { name: "Mark a.ts viewed", exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "Load new changes" }).click();
    await page.locator(".outdated-comment").waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Mark a.ts viewed", exact: true }).isChecked(), false);
    assert.equal(await send().isDisabled(), true);
    await page.getByRole("checkbox", { name: "Keep original context" }).check();
    await ready();
  });
  await check("send failure retains feedback and permits retry without duplicate requests", async () => {
    let requests = 0;
    await page.route("**/api/submit", async (route) => {
      requests++;
      await new Promise((r) => setTimeout(r, 150));
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
    });
    await send().click();
    await page.getByRole("textbox", { name: "Overall notes (optional)", exact: true }).fill("Review summary");
    await page.getByRole("button", { name: "Send comments", exact: true }).click();
    await page.getByText(/Temporary failure/).waitFor();
    assert.equal(requests, 1);
    assert.equal(await page.getByRole("textbox", { name: "Overall notes (optional)", exact: true }).inputValue(), "Review summary");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.unroute("**/api/submit");
  });
  await check("browser Back restores selected scope and delayed replies cannot overwrite it", async () => {
    await page.route("**/api/diff?*", async (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.has("worktree")) await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.getByRole("checkbox", { name: "Include uncommitted changes" }).uncheck();
    await page.waitForURL(/\/tip$/);
    await page.goBack();
    await ready();
    assert.equal(await page.getByRole("checkbox", { name: "Include uncommitted changes" }).isChecked(), true);
    await page.waitForTimeout(800);
    assert.match(await page.locator(".topbar .label").innerText(), /with uncommitted/);
    await page.unroute("**/api/diff?*");
  });
  await check("cancellation failure does not claim success or lose comments", async () => {
    await page.route("**/api/cancel", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Cancel unavailable" }) }),
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText(/Could not cancel/).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Review cancelled" }).count(), 0);
    await page.unroute("**/api/cancel");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await ready();
  });
  await check("sidebar resizing works with the keyboard", async () => {
    const handle = page.getByRole("separator", { name: "Resize files sidebar" });
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), before + 16);
  });
  await check("narrow view keeps code and controls available", async () => {
    await page.screenshot({ path: "/tmp/turndiff-ux-desktop.png" });
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")]
        .filter((b) => b.textContent === "Turns / stack" || b.textContent === "Files")
        .every((b) => b.getAttribute("aria-expanded") === "false"),
    );
    assert.equal(await page.getByRole("button", { name: "Turns / stack" }).getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("button", { name: "Files", exact: true }).getAttribute("aria-expanded"), "false");
    assert.ok((await page.locator(".codeview").evaluate((e) => e.getBoundingClientRect().width)) > 500);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    assert.equal(await page.getByRole("searchbox", { name: "Search files" }).isVisible(), true);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.screenshot({ path: "/tmp/turndiff-ux-narrow.png" });
  });
  await check("successful submission preserves original comment context and clears persisted review", async () => {
    await send().click();
    await page.getByRole("button", { name: "Send comments", exact: true }).click();
    await page.getByRole("heading", { name: "Feedback saved for the agent" }).waitFor();
    const result = await server!.result;
    assert.equal(result?.summary, "Review summary");
    assert.equal(result?.comments.length, 1);
    assert.equal(result?.comments[0]?.outdated, true);
    assert.deepEqual(result?.comments[0]?.snippet, ["export const value = 2;"]);
    const saved = await fetch(`${server!.url}/api/review?kind=branch&name=feature&worktree=1`).then((r) => r.json());
    assert.equal(saved.comments.length, 0);
    assert.equal(saved.drafts.length, 0);
  });
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  await rm(root, { recursive: true, force: true });
}
