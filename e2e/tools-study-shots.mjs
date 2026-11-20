// Screenshots of the Study app for a look-over, in docs/study-shots/.
// Not a test. Needs a stack with the fake model up and a run's sign-ins:
//
//   E2E_BASE_URL=http://localhost:8096 E2E_AUTH_DIR=../.stacks/study/e2e-auth \
//   STUDY_REDIS=PromptlyStudy-Redis node tools-study-shots.mjs
//
// (STUDY_REDIS: the stack's Redis container; the send counters are cleared
// between passes, since four lessons in a row is more than chat's limit.)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8096";
const AUTH = process.env.E2E_AUTH_DIR ?? path.join(here, ".auth");
const OUT = path.resolve(here, "../docs/study-shots");
const RIGHT = "The moon's gravity pulls the sea towards it";
const PAIRS = { Flood: "The water rising", Ebb: "The water falling", "Spring tide": "The biggest range", "Neap tide": "The smallest range" };
fs.mkdirSync(OUT, { recursive: true });

function clearLimits() {
  if (!process.env.STUDY_REDIS) return;
  try {
    execFileSync("docker", ["exec", process.env.STUDY_REDIS, "sh", "-c", 'redis-cli --scan --pattern "*user_messages*" | xargs -r redis-cli del'], { stdio: "ignore" });
  } catch {
    /* only slower */
  }
}

async function pass(browser, { name, user, viewport, theme, placement }) {
  clearLimits();
  const context = await browser.newContext({ storageState: path.join(AUTH, `${user}.json`), viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  await context.route("**/version.json*", (r) => r.abort());
  await context.addInitScript((t) => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 })), theme);
  const page = await context.newPage();
  const seen = new Set();
  const shot = async (what) => {
    await page.waitForTimeout(700); // let the entrance animations finish
    await page.screenshot({ path: path.join(OUT, `${name}-${what}.png`) });
    console.log("shot", `${name}-${what}`);
  };
  const once = async (what) => {
    if (seen.has(what)) return;
    seen.add(what);
    await shot(what);
  };

  await page.goto(`${BASE}/study`);
  await page.getByRole("heading", { name: "Study", exact: true }).waitFor({ timeout: 30_000 });
  await shot("01-home");

  await page.goto(`${BASE}/study/new`);
  await page.getByRole("textbox", { name: "What do you want to learn?" }).fill("How tides work");
  await page.getByRole("textbox", { name: /Why\?/ }).fill("I sail, and want to plan around the tides");
  await page.getByRole("radio", { name: /The big picture/ }).click();
  await page.getByRole("switch").uncheck();
  await shot("02-new-subject");
  await page.getByTestId("study-build").click();
  await page.getByTestId("study-building").waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, `${name}-03-building.png`) }).catch(() => undefined);
  await page.getByTestId("study-placement-offer").waitFor({ timeout: 90_000 });
  await shot("04-course-ready");

  const pending = page.locator('[data-testid="study-step"][data-status="pending"]');
  if (placement) {
    await page.getByRole("button", { name: /Quick check/ }).click();
    for (let i = 0; i < 8; i++) {
      await page.getByTestId("study-check").or(page.getByTestId("study-placement-done")).first().waitFor({ timeout: 30_000 });
      if (await page.getByTestId("study-placement-done").isVisible()) break;
      const id = await pending.getAttribute("data-step");
      await once("05-quick-check-question");
      // Right once, then not: some known, the rest to learn.
      await pending.getByRole("radio", { name: i === 0 ? new RegExp(RIGHT) : /The wind piles/ }).click();
      await page.getByTestId("study-check").click();
      await page.locator(`[data-step="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
    }
    await shot("06-quick-check-done");
    await page.getByRole("button", { name: "See your map" }).click();
  } else {
    await page.getByRole("button", { name: /I'm new to this/ }).click();
  }
  await page.getByTestId("study-map").waitFor({ timeout: 30_000 });
  await shot("07-map");
  await page.getByTestId("study-stop").nth(1).click();
  await page.getByTestId("study-concept-sheet").waitFor();
  await shot("08-concept");
  await page.keyboard.press("Escape");

  await page.getByTestId("study-continue-course").click();
  let asked = false;
  for (let i = 0; i < 40; i++) {
    await pending.or(page.getByTestId("study-lesson-done")).first().waitFor({ timeout: 40_000 });
    if (await page.getByTestId("study-lesson-done").isVisible()) break;
    const id = await pending.getAttribute("data-step");
    const kind = await pending.getAttribute("data-kind");
    const check = page.getByTestId("study-check");
    if (kind === "explain") {
      const diagram = await pending.locator("figure").getAttribute("data-testid").catch(() => null);
      await once(`10-explain-${diagram ?? "plain"}`);
      await check.click();
      await page.locator(`[data-step="${id}"]`).waitFor({ state: "detached", timeout: 40_000 });
      continue;
    }
    if (kind === "teach_student") {
      await once(`11-${kind}-a`);
      await page.getByRole("textbox", { name: /Your explanation for/ }).fill("No Sam, it's the other way round: the moon pulls the sea towards it.");
      await page.getByRole("button", { name: /Send to/ }).click();
      await page.getByText(/gets it now/).waitFor({ timeout: 30_000 });
    } else if (kind === "explain_back" || kind === "scenario") {
      await once(`11-${kind}-a`);
      await page.getByRole("textbox", { name: "Your answer" }).fill("The moon's gravity pulls the sea towards it, hardest on the near side, so the water heaps up there. Six hours on it will be low water.");
    } else if (kind === "order_steps") {
      await once(`11-${kind}-a`);
      // One drag by the handle, then the arrows for the rest.
      const rows = page.locator("ol > li").filter({ has: page.getByRole("button", { name: /^Move / }) });
      const first = await rows.first().boundingBox();
      const last = await rows.last().boundingBox();
      if (first && last && viewport.width >= 600) {
        await page.mouse.move(first.x + 18, first.y + first.height / 2);
        await page.mouse.down();
        await page.mouse.move(first.x + 18, last.y + last.height / 2, { steps: 8 });
        await page.mouse.up();
      }
      for (let n = 0; n < 20; n++) {
        const texts = await rows.locator(".study-md").allInnerTexts();
        const at = texts.findIndex((t, j) => j < texts.length - 1 && t.trim() > texts[j + 1].trim());
        if (at === -1) break;
        await page.getByRole("button", { name: /^Move .* down$/ }).nth(at).click();
      }
    } else if (kind === "match_pairs") {
      await once(`11-${kind}-a`);
      for (const [left, right] of Object.entries(PAIRS)) {
        await page.getByRole("button", { name: left, exact: true }).click();
        await page.getByRole("group", { name: "Goes with" }).getByRole("button", { name: right, exact: true }).click();
      }
    } else if (kind === "spot_error") {
      await once(`11-${kind}-a`);
      await page.getByRole("radio", { name: /So the sea pushes the moon away and heaps up/ }).click();
    } else {
      await once(`11-${kind}-a`);
      const groups = pending.getByRole("radiogroup");
      for (let g = 0, n = await groups.count(); g < n; g++) await groups.nth(g).getByRole("radio", { name: new RegExp(RIGHT) }).click();
    }
    await page.getByRole("radio", { name: "Think so" }).click().catch(() => undefined);
    await check.click();
    await page.getByTestId("study-feedback").waitFor({ timeout: 40_000 });
    await page.getByTestId("study-feedback").scrollIntoViewIfNeeded();
    await once(`11-${kind}-b`);
    if (await page.locator('[data-change="mastered"]').count()) await once("12-learned");
    if (!asked) {
      asked = true;
      await page.getByRole("button", { name: /^Ask/ }).first().click();
      await page.getByRole("button", { name: "Compare it to something" }).click();
      await page.getByText(/magnet under a tablecloth/).waitFor({ timeout: 30_000 });
      await shot("13-ask-the-teacher");
      if (viewport.width < 1024) await page.keyboard.press("Escape");
      else await page.getByRole("complementary", { name: "Ask the teacher" }).getByRole("button", { name: "Close" }).click();
    }
    await page.getByTestId("study-continue").click();
    await page.locator(`[data-step="${id}"]`).waitFor({ state: "detached", timeout: 40_000 });
  }
  await page.getByTestId("study-lesson-done").waitFor({ timeout: 40_000 });
  await shot("14-lesson-done");
  await page.getByTestId("study-lesson-done").getByRole("button", { name: "Back to the map" }).click();
  await page.getByTestId("study-map").waitFor();
  await page.waitForTimeout(1200);
  await shot("15-map-after");
  await page.goto(`${BASE}/today`);
  await page.getByRole("heading", { name: "Study" }).first().scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => undefined);
  await shot("16-today");
  await context.close();
}

const browser = await chromium.launch();
const only = process.argv.slice(2);
const passes = [
  { name: "desktop-dark", user: "alice", viewport: { width: 1280, height: 800 }, theme: "dark", placement: true },
  { name: "phone-light", user: "bob", viewport: { width: 390, height: 844 }, theme: "light", placement: false },
  { name: "desktop-light", user: "alice", viewport: { width: 1280, height: 800 }, theme: "light", placement: false },
  { name: "phone-dark", user: "bob", viewport: { width: 390, height: 844 }, theme: "dark", placement: true },
];
let failed = 0;
for (const p of passes) {
  if (only.length && !only.includes(p.name)) continue;
  try {
    await pass(browser, p);
  } catch (e) {
    failed += 1;
    console.error(`${p.name} stopped: ${String(e).split("\n")[0]}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
