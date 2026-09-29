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
  assert(
    (await page.evaluate(() => location.hash)) === "#branch/feat-b+working",
    "defaults to the current branch with uncommitted changes",
  );

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
  assert(
    commitTitle.includes("feat-a: add a3") && commitTitle.includes("on feat-a"),
    `single-commit view says it is on feat-a (${commitTitle})`,
  );
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

  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const ayuBg = await bodyBg();
  await page.keyboard.press("t");
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "github-dark" && (await bodyBg()) === "rgb(13, 17, 23)", "t switches to GitHub Dark colors");
  const fonts = await page.evaluate(() => ({
    chrome: getComputedStyle(document.querySelector(".toolbar")!).fontFamily,
    code: getComputedStyle(document.querySelector(".card")!).getPropertyValue("--diffs-font-family"),
  }));
  assert(fonts.chrome.startsWith("system-ui") && fonts.code.includes("Geist Mono"), `chrome uses the system font, code uses Geist Mono (${fonts.chrome.split(",")[0]} / ${fonts.code.trim().split(",")[0]})`);

  await page.reload();
  await page.locator(".card").first().waitFor();
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "github-dark", "the theme survives a reload");
  await page.keyboard.press("t");
  assert((await bodyBg()) === ayuBg, "t switches back to Ayu Dark");
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

  await fetch(`${server.url}/api/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash: "stack" }),
  });
  await page.waitForFunction(() => location.hash === "#stack", undefined, { timeout: 15_000 });
  assert(true, "a CLI focus request navigates the open tab");
  await page.goBack();
  await page.waitForFunction(() => location.hash.startsWith("#branch/feat-b"));
  assert(true, "Back returns to the view before the focus");

  await page.keyboard.press("c");
  const drawer = page.locator(".drawer");
  await drawer.waitFor();
  const groupOf = (body: string) =>
    drawer
      .locator(".rgroup", { has: page.locator(".rbody", { hasText: body }) })
      .locator(".rgroup-title")
      .innerText();
  assert((await groupOf("feat-a: name this list")) === "feat-a", "after reload, the feat-a comment is listed under feat-a");
  assert((await groupOf("feat-b: g needs a docstring")) === "feat-b", "after reload, the feat-b comment is listed under feat-b");
  await shot("review-panel");

  await drawer.locator(".ritem", { hasText: "feat-a: name this list" }).click();
  await page.waitForFunction(() => location.hash === "#branch/feat-a");
  const target = page.locator(".comment", { hasText: "feat-a: name this list" });
  await target.waitFor();
  await page.waitForTimeout(800);
  const box = (await target.boundingBox())!;
  assert(box.y > 38 && box.y + box.height < 900, "clicking a comment in the panel opens its view and scrolls it into sight");

  const waiting = fetch(`${server.url}/api/wait?waiter=1-e2e`).then((r) => r.json() as Promise<WaitResponse>);
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

  await page.keyboard.press("Escape");
  await writeFile(join(root, "feat_b.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n\ndef h():\n    return 3\n");
  const guideInput = {
    author: "claude",
    intent: "Give feat-b **three** functions.",
    sections: [
      { title: "Scratch notes", overview: "Where the agent keeps notes. <img src=x onerror=alert(1)>", files: [{ path: "notes.md", summary: "Untracked scratch notes." }] },
      { title: "New functions", overview: "`g` and `h` return constants for now.", files: [{ path: "feat_b.py", summary: "Adds `g` and `h`." }] },
    ],
    annotations: [{ path: "feat_b.py", lines: [4, 5], summary: "`g` returns 2.", rationale: "A placeholder until the real rule lands." }],
  };
  const cli = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "guide"], { cwd: root, stdin: new Response(JSON.stringify(guideInput)), stdout: "pipe", stderr: "pipe" });
  const cliOut = await new Response(cli.stdout).text();
  assert((await cli.exited) === 0 && cliOut === "guide for feat-b: 2 sections, 2 of 2 files placed, 1 annotation\n", `turndiff guide stores the guide (${cliOut.trim()})`);

  await selectBranch(page, "feat-b");
  const guideCard = page.locator(".guide");
  await guideCard.waitFor({ timeout: 15_000 });
  assert(true, "the open tab picks up the new guide from guidesVersion");
  const guideText = await guideCard.innerText();
  assert(
    guideText.includes("claude") && guideText.includes("Give feat-b three functions.") && guideText.includes("1 file") && guideText.includes("0/1 viewed"),
    "the guide card shows author, intent, and a file and viewed count per section",
  );
  assert(!guideText.includes("Adds g and h.") && !guideText.includes("return constants"), "sections start collapsed: no overviews or file rows in the card");
  assert((await guideCard.locator("strong").innerText()) === "three" && (await page.locator(".guide img, .group-head img").count()) === 0, "guide markdown renders, raw HTML does not");
  assert(
    JSON.stringify(await guideCard.locator(".guide-group-title").allInnerTexts()) === JSON.stringify(["Scratch notes", "New functions"]),
    "the guide card lists its sections in order",
  );

  const railOrder = () => page.locator(".files .row.file .fname").evaluateAll((els) => els.map((e) => e.firstChild?.textContent));
  const paneOrder = () => page.locator(".card .card-head .path").evaluateAll((els) => els.map((e) => e.textContent));
  const guided = JSON.stringify(["notes.md", "feat_b.py"]);
  assert(JSON.stringify(await railOrder()) === guided && JSON.stringify(await paneOrder()) === guided, "rail and pane follow the guide's order");
  assert(JSON.stringify(await page.locator(".group-head .group-head-title").allInnerTexts()) === JSON.stringify(["Scratch notes", "New functions"]), `the pane heads each guide group (${await page.locator(".group-head").allInnerTexts()})`);
  assert((await page.locator(".group-head .group-head-overview").nth(1).innerText()) === "g and h return constants for now.", "each group header carries its section's overview");
  assert((await page.locator(".card", { hasText: "feat_b.py" }).locator(".card-summary").innerText()) === "Adds g and h.", "the file card shows its guide summary");

  const scrollerY = () => page.locator(".scroller").evaluate((s) => s.getBoundingClientRect().top);
  await guideCard.locator(".guide-group-row", { hasText: "Scratch notes" }).click();
  await page.waitForTimeout(200);
  const headTop = (await page.locator(".group-head").first().evaluate((h) => h.getBoundingClientRect().top)) - (await scrollerY());
  assert(Math.abs(headTop) < 4, `clicking a section row scrolls to its group in the diff (${Math.round(headTop)}px)`);
  await page.locator(".scroller").evaluate((s) => s.scrollTo({ top: 0 }));
  await guideCard.getByRole("button", { name: "Expand New functions", exact: true }).click();
  const expanded = guideCard.locator(".guide-group.open");
  assert((await expanded.innerText()).includes("g and h return constants for now.") && (await expanded.innerText()).includes("Adds g and h."), "expanding a section shows its overview and file rows with summaries");
  await guideCard.locator(".guide-file", { hasText: "feat_b.py" }).click();
  await page.waitForFunction(() => document.querySelector(".files .row.file.active")?.textContent?.includes("feat_b.py"));
  const bTop = await page.locator(".card", { hasText: "feat_b.py" }).evaluate((c) => {
    const s = document.querySelector(".scroller")!;
    return { top: c.getBoundingClientRect().top - s.getBoundingClientRect().top, scrollTop: s.scrollTop, max: s.scrollHeight - s.clientHeight };
  });
  assert(bTop.top >= -4 && bTop.top < 120, `clicking a guide file row scrolls to its file (${JSON.stringify(bTop)})`);
  await page.locator(".scroller").evaluate((s) => s.scrollTo({ top: 0 }));
  await page.keyboard.press("g");
  await page.waitForFunction(() => document.querySelector(".card .card-head .path")?.textContent === "feat_b.py");
  assert((await page.locator(".group-head").count()) === 0, "g switches to tree order");
  await page.keyboard.press("g");
  await page.waitForFunction(() => document.querySelector(".card .card-head .path")?.textContent === "notes.md");

  const bCard = page.locator(".card", { has: page.locator(".card-head .path", { hasText: "feat_b.py" }) });
  const note = bCard.locator(".note");
  await note.waitFor();
  const lineTop = (n: number) =>
    bCard.evaluate(
      (card, n) => card.querySelector("diffs-container")!.shadowRoot!.querySelector(`[data-line-type="change-addition"][data-line="${n}"]`)!.getBoundingClientRect(),
      n,
    );
  const noteBox = (await note.boundingBox())!;
  const [l3, l4] = [await lineTop(3), await lineTop(4)];
  assert(noteBox.y >= l3.bottom - 1 && noteBox.y + noteBox.height <= l4.top + 1, "the note renders just above its first changed line");
  assert((await note.innerText()).includes("claude note") && !(await note.innerText()).includes("placeholder"), "the note shows author and summary, not the rationale");
  await note.getByRole("button", { name: "Why" }).click();
  assert((await note.innerText()).includes("A placeholder until the real rule lands."), "Why reveals the rationale");
  assert((await page.locator(".files .row.file", { hasText: "feat_b.py" }).locator(".ncount").innerText()) === "1", "the rail counts the file's notes");
  await shot("guide");

  await page.keyboard.press("a");
  await note.waitFor({ state: "detached" });
  assert((await page.locator(".ncount").count()) === 0, "a hides the notes and their counts");
  await page.keyboard.press("a");
  await note.waitFor();

  const markedFile = async () => {
    await page.locator(".hunk-mark").waitFor({ state: "attached" });
    return page.locator(".hunk-mark").evaluate((m) => m.closest(".card")!.querySelector(".card-head .path")!.textContent);
  };
  await page.keyboard.press("]");
  assert((await markedFile()) === "notes.md", "] marks the first hunk in guide order");
  await page.keyboard.press("]");
  assert((await markedFile()) === "feat_b.py", "] moves to the next file's hunk");
  const scrollerTop = await page.locator(".scroller").evaluate((s) => s.getBoundingClientRect().top);
  const hunkAt = (await lineTop(1)).top - scrollerTop;
  assert(hunkAt > 0 && hunkAt < 150, `] scrolls the hunk near the top (${Math.round(hunkAt)}px)`);
  await page.keyboard.press("[");
  assert((await markedFile()) === "notes.md", "[ moves back");

  await note.getByRole("button", { name: "Reply" }).click();
  const reply = bCard.locator(".composer textarea");
  await reply.waitFor();
  assert((await reply.getAttribute("placeholder")) === "Comment on lines 4–5", "Reply opens the composer on the note's lines");
  await reply.fill("why not 3?");
  await reply.press("ControlOrMeta+Enter");
  await bCard.locator(".comment-body", { hasText: "why not 3?" }).waitFor();
  assert(true, "a reply saves as a reviewer comment");

  await guideCard.locator(".guide-head .chev").click();
  await page.reload();
  await page.locator(".guide").waitFor();
  assert(JSON.stringify(await paneOrder()) === guided && (await page.locator(".note").count()) === 1, "the guide, its order and its notes survive a reload");
  assert((await page.locator(".guide-body").count()) === 0, "the collapsed guide stays collapsed");
  await page.locator(".guide-head .chev").click();
  assert(JSON.stringify(await page.locator(".guide-group.open .guide-group-title").allInnerTexts()) === JSON.stringify(["New functions"]), "an expanded section stays expanded");

  await writeFile(join(root, "feat_b.py"), "def f():\n    return 1\n\ndef g():\n    return 20\n");
  await page.locator(".pill").waitFor({ timeout: 15_000 });
  await page.keyboard.press("r");
  await page.locator(".guide-group-row .tag", { hasText: "1 changed since" }).waitFor();
  assert((await page.locator(".guide-stale").innerText()) === "1 note is on code that has changed since", "the guide flags changed files and notes on changed code");
  assert((await page.locator(".note").count()) === 0, "a note on changed code no longer renders in the diff");
  await shot("guide-stale");

  const long = Array.from({ length: 70 }, (_, i) => `long ${i + 1}${[10, 30, 50].includes(i + 1) ? " changed" : ""}`).join("\n") + "\n";
  await writeFile(join(root, "long.txt"), long);
  await writeFile(join(root, "extra.txt"), "one extra file\n");
  const threeSections = {
    ...guideInput,
    sections: [
      ...guideInput.sections,
      { title: "Extras", overview: "A file the other sections do not need, kept apart so it is easy to **drop**.", files: [{ path: "extra.txt", summary: "One line of filler." }] },
    ],
    annotations: [{ path: "long.txt", lines: [5, 5], summary: "Line 5 is unchanged context." }],
  };
  const replaced = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "guide"], { cwd: root, stdin: new Response(JSON.stringify(threeSections)), stdout: "pipe", stderr: "ignore" });
  const replacedOut = await new Response(replaced.stdout).text();
  assert(
    (await replaced.exited) === 0 &&
      replacedOut === 'guide for feat-b: 3 sections, 3 of 4 files placed, 1 annotation\nwarning: 1 changed file is in no section and will be listed under "Everything else": long.txt\n',
    `a second turndiff guide replaces the first and warns about the unplaced file (${replacedOut.trim()})`,
  );
  await page.locator(".pill").waitFor({ timeout: 15_000 });
  await page.keyboard.press("r");
  const longCard = page.locator(".card", { has: page.locator(".card-head .path", { hasText: "long.txt" }) });
  const pinned = longCard.locator(".note");
  await pinned.waitFor({ timeout: 15_000 });
  const rows = () => guideCard.locator(".guide-group-row").evaluateAll((els) => els.map((e) => e.textContent));
  assert(JSON.stringify(await rows()) === JSON.stringify(["Scratch notes1 file0/1 viewed", "New functions1 file0/1 viewed", "Extras1 file0/1 viewed", "Everything else1 file0/1 viewed"]), `the unplaced file gets an "Everything else" row (${await rows()})`);
  const countX = await guideCard.locator(".guide-group-row").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll(".guide-count")].map((c) => Math.round(c.getBoundingClientRect().left)).join(",")));
  assert(new Set(countX).size === 1, `section rows line up their counts whatever the title length (${countX.join(" | ")})`);
  const heads = await page.locator(".group-head .group-head-title").allInnerTexts();
  assert(JSON.stringify(heads) === JSON.stringify(["Scratch notes", "New functions", "Extras", "Everything else"]) && JSON.stringify(await paneOrder()) === JSON.stringify(["notes.md", "feat_b.py", "extra.txt", "long.txt"]), "the unplaced file comes last, under an Everything else header");
  assert((await page.locator(".files .file-subgroup").last().innerText()) === "Everything else", "the rail groups it under Everything else too");
  await page.locator(".scroller").evaluate((s) => s.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  await shot("guide-3-ayu");
  await page.keyboard.press("t");
  await page.waitForTimeout(300);
  await shot("guide-3-github");
  await page.keyboard.press("t");
  assert((await pinned.innerText()).includes("line 5"), "a note on an unrendered line is pinned to the top of its file");
  await pinned.getByRole("button", { name: "Reply" }).click();
  const pinnedReply = longCard.locator(".composer textarea");
  await pinnedReply.waitFor({ state: "visible", timeout: 3000 });
  assert((await pinnedReply.getAttribute("placeholder")) === "Comment on line 5", "Reply to a pinned note opens a visible composer on the note's line");
  await pinnedReply.press("Escape");

  const onBg = await page.locator(".guide-head .toggle.on").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(onBg !== "rgba(0, 0, 0, 0)", `an "on" toggle has the soft accent tint (${onBg})`);

  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.locator(".scroller").evaluate((s) => s.scrollTo({ top: 0 }));
  const steps: string[] = [];
  for (const key of ["]", "]", "]", "]", "]", "]", "["]) {
    await page.keyboard.press(key);
    await page.locator(".hunk-mark").waitFor({ state: "attached" });
    steps.push(await page.locator(".hunk-mark").evaluate((m) => `${m.closest(".card")!.querySelector(".card-head .path")!.textContent} ${(m as HTMLElement).dataset.hunk}`));
    if (steps.length === 4) {
      const band = await page.locator(".hunk-mark").evaluate((m) => ({ bg: getComputedStyle(m).backgroundColor, width: m.getBoundingClientRect().width, card: m.closest(".card")!.getBoundingClientRect().width }));
      assert(band.bg !== "rgba(0, 0, 0, 0)" && Math.abs(band.width - band.card) < 4, `the current hunk gets an accent band across the card (${band.bg})`);
      await shot("hunk-band");
    }
  }
  assert(
    JSON.stringify(steps.slice(3)) === JSON.stringify(["long.txt old:10", "long.txt old:30", "long.txt old:50", "long.txt old:30"]),
    `] reaches every hunk of the last file even when it cannot scroll further, and [ steps back (${steps.join(", ")})`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // In tree order no group header sits above a file, so its card top stays below the tracker's edge.
  await page.keyboard.press("g");
  await page.waitForFunction(() => document.querySelector(".card .card-head .path")?.textContent === "extra.txt");
  await page.locator(".scroller").evaluate((s) => s.scrollTo({ top: 0 }));
  await page.locator(".files .row.file", { hasText: "extra.txt" }).click();
  await page.keyboard.press("]");
  await page.locator(".hunk-mark").waitFor({ state: "attached" });
  await page.waitForTimeout(300);
  const marked = await page.locator(".hunk-mark").evaluate((m) => m.closest(".card")!.querySelector(".card-head .path")!.textContent);
  const selected = await page.locator(".files .row.file.active .fname").evaluate((el) => el.firstChild?.textContent);
  assert(marked === "feat_b.py" && selected === "feat_b.py", `] into the next file selects that file in the rail (${marked} / ${selected})`);
  await page.keyboard.press("g");

  await page.locator(".row", { hasText: "entire stack" }).click();
  await waitTitle(page, "Entire stack");
  const railActive = async () => {
    // Let the scroll tracker run after the jump.
    await page.waitForTimeout(400);
    return page.locator(".files .row.file.active .fname").evaluate((el) => el.firstChild?.textContent);
  };
  await page.locator(".files .row.file", { hasText: "feat_d.py" }).click();
  const clamped = await page.locator(".scroller").evaluate((s) => s.scrollTop >= s.scrollHeight - s.clientHeight - 1);
  assert(clamped && (await railActive()) === "feat_d.py", "a jump to the last file keeps it selected in the rail while the scroller is clamped");
  await page.keyboard.press("k");
  assert((await railActive()) === "feat_c.py", "k selects the previous file");
  await page.keyboard.press("j");
  assert((await railActive()) === "feat_d.py", "j onto the last file keeps it selected");

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
