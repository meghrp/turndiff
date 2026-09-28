// Drive the review UI in a real Chrome against a running `turndiff review`:
// select a line, leave a comment, submit. Usage: bun scripts/e2e.ts <url> [dark]
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:4765";
const dark = process.argv[3] === "dark";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? "dark" : "light" });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("console:", m.type(), m.text().slice(0, 300));
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForSelector("text=feat_b.py", { timeout: 20000 });
// Diff rows live inside shadow DOM; Playwright pierces it with CSS selectors.
await page.waitForTimeout(1500);
const numbers = page.locator("[data-column-number], [data-line]");
console.log("rendered line nodes:", await numbers.count());
await page.screenshot({ path: `/tmp/turndiff-e2e-1${dark ? "-dark" : ""}.png` });

// Click the line number of the `def g():` addition in feat_b.py (new-side line 4).
const target = page.locator("text=def g():").first();
await target.waitFor();
const box = await target.boundingBox();
if (!box) throw new Error("no box for target line");
// Line number column sits left of the code; click near the left edge of the row.
await page.mouse.click(box.x - 120 > 0 ? Math.max(560, box.x - 200) : 560, box.y + box.height / 2);
await page.waitForTimeout(400);
const composer = page.locator("textarea[placeholder^='Leave a comment']");
if ((await composer.count()) === 0) {
  // Fallback: try clicking on gutter cells found by attribute.
  const gutter = page.locator("[data-column-number]").nth(8);
  await gutter.click();
}
await composer.waitFor({ timeout: 5000 });
await composer.fill("Name this `two()`; also add a docstring.");
await page.screenshot({ path: `/tmp/turndiff-e2e-2${dark ? "-dark" : ""}.png` });
await page.keyboard.press("Meta+Enter");
await page.waitForSelector("text=Name this", { timeout: 5000 });
console.log("comment saved");
await page.screenshot({ path: `/tmp/turndiff-e2e-3${dark ? "-dark" : ""}.png` });

await page.click("text=Send feedback");
await page.waitForSelector("text=Send feedback to the agent");
await page.fill("textarea[placeholder^='Overall notes']", "Solid turn. One naming nit.");
await page.screenshot({ path: `/tmp/turndiff-e2e-4${dark ? "-dark" : ""}.png` });
await page.click(".dialog footer button.primary");
await page.waitForSelector("text=Feedback saved for the agent");
await page.screenshot({ path: `/tmp/turndiff-e2e-5${dark ? "-dark" : ""}.png` });
console.log("submitted");
await browser.close();
