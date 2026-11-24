// Screenshots of the Mail list for a look-over, in docs/mail-list-shots/.
// Not a test. Needs a PRIVATE stack (never the main app), a run's sign-ins,
// and the made-up mailbox:
//
//   scripts/stack.sh up mail-list --e2e && scripts/stack.sh e2e mail-list tests/mail-layout.spec.ts
//   docker exec -i PromptlyMailList-Backend python - < e2e/seed/mail_demo.py
//   E2E_BASE_URL=http://localhost:8093 E2E_AUTH_DIR=../.stacks/mail-list/e2e-auth node tools-mail-shots.mjs
//
// The list and the emails come from the stack's own API. Only two things are
// stood in for: the mailbox's "can't reach the server" state (its server is
// made up) and an attachment's bytes (there's no mailbox to fetch them from).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8093";
const AUTH = process.env.E2E_AUTH_DIR ?? path.join(here, ".auth");
const OUT = path.resolve(here, "../docs/mail-list-shots");
fs.mkdirSync(OUT, { recursive: true });

async function picture(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent('<body style="margin:0;height:100vh;background:linear-gradient(160deg,#8fb7d9,#e8d9b0 60%,#7da36a);display:flex;align-items:end;justify-content:center"><div style="font:600 28px system-ui;color:#fff;padding:24px;text-shadow:0 1px 6px #0006">A made-up photo</div></body>');
  const png = await page.screenshot();
  await page.close();
  return png;
}

async function pass(browser, png, { theme, viewport, tag = "" }) {
  const context = await browser.newContext({ storageState: path.join(AUTH, "alice.json"), viewport, deviceScaleFactor: 1.5, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  await context.route("**/version.json*", (r) => r.abort());
  await context.addInitScript((t) => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 })), theme);
  await context.route("**/api/mail/overview", async (r) => {
    const got = await r.fetch();
    const body = await got.json();
    for (const a of body.accounts ?? []) Object.assign(a, { status: "ok", status_detail: "", last_sync_at: new Date().toISOString() });
    await r.fulfill({ response: got, json: body });
  });
  await context.route("**/api/mail/messages/*/attachments/*", (r) => r.fulfill({ contentType: "image/jpeg", body: png }));
  const page = await context.newPage();
  const shot = async (what) => {
    await page.waitForTimeout(600); // entrance animations
    await page.screenshot({ path: path.join(OUT, `${what}${tag}-${theme}.png`) });
    console.log("shot", `${what}${tag}-${theme}`);
  };
  const asked = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(`${BASE}/mail`);
  const headers = { Authorization: (await asked).headers()["authorization"] };
  const layout = async (which) => {
    const r = await page.request.put(`${BASE}/api/mail/settings/layout`, { headers, data: { layout: which } });
    if (!r.ok()) throw new Error(`layout: ${r.status()} ${await r.text()}`);
    await page.goto(`${BASE}/mail`);
    await page.locator("[data-mail-row]").first().waitFor({ timeout: 30_000 });
  };
  const row = (subject) => page.locator("[data-mail-row]").filter({ hasText: subject }).first();

  if (viewport.width < 600) {
    await layout("full");
    await shot("phone-list");
    await layout("split");
    await context.close();
    return;
  }

  await layout("split");
  await shot("split-list");
  await row("Year 4 camp").getByRole("button").first().click();
  await page.getByRole("heading", { name: /Year 4 camp/ }).waitFor();
  await shot("split-open");
  await row("Photos from Sunday").hover();
  await shot("split-hover");

  await page.getByRole("navigation", { name: "Mail folders" }).getByRole("button", { name: /mailboxes|example\.com/ }).first().click();
  await page.getByRole("menuitem", { name: "Mail settings" }).click();
  await page.getByRole("radiogroup", { name: "Layout" }).waitFor();
  await shot("settings-layout");
  await page.keyboard.press("Escape");

  await layout("full");
  await shot("full-list");
  await row("Budget for the trip").hover();
  await shot("full-hover");
  await page.locator("[data-mail-list-scroll]").evaluate((el) => { el.scrollTop = 520; });
  await shot("full-scrolled");
  await page.locator("[data-mail-list-scroll]").evaluate((el) => { el.scrollTop = 0; });
  await row("Year 4 camp").getByRole("button").first().click();
  await page.getByRole("region", { name: "Open conversation" }).getByRole("heading", { name: /Year 4 camp/ }).waitFor();
  await shot("full-open");
  await page.keyboard.press("Escape");
  await page.mouse.move(700, 5);
  await shot("full-closed");
  await row("Photos from Sunday").getByRole("button", { name: /^Open attachment IMG_2042/ }).click();
  await page.getByRole("dialog", { name: "IMG_2042.jpg" }).locator("img").waitFor();
  await shot("chip-viewer");
  await page.keyboard.press("Escape");
  // Picked with Ctrl, as in a file list.
  await row("Quote for the kitchen").getByRole("button").first().click({ modifiers: ["Control"] });
  await row("Budget for the trip").getByRole("button").first().click({ modifiers: ["Control"] });
  await shot("full-selected");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Search your mail" }).fill("photos");
  await page.waitForTimeout(1200);
  await shot("full-search");
  await layout("split");
  await context.close();
}

const browser = await chromium.launch();
const png = await picture(browser);
// MAIL_COMPARE=strip|covered: only the open email in the full list, 1440 wide, light
// and dark, as compare-<name>-<theme>.png, to set two builds side by side.
if (process.env.MAIL_COMPARE) {
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ storageState: path.join(AUTH, "alice.json"), viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    await context.route("**/version.json*", (r) => r.abort());
    await context.addInitScript((t) => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 })), theme);
    await context.route("**/api/mail/overview", async (r) => {
      const got = await r.fetch();
      const body = await got.json();
      for (const a of body.accounts ?? []) Object.assign(a, { status: "ok", status_detail: "" });
      await r.fulfill({ response: got, json: body });
    });
    const page = await context.newPage();
    const asked = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
    await page.goto(`${BASE}/mail`);
    const headers = { Authorization: (await asked).headers()["authorization"] };
    await page.request.put(`${BASE}/api/mail/settings/layout`, { headers, data: { layout: "full" } });
    await page.goto(`${BASE}/mail`);
    await page.locator("[data-mail-row]").filter({ hasText: "Year 4 camp" }).first().getByRole("button").first().click();
    await page.getByRole("region", { name: "Open conversation" }).getByRole("heading", { name: /Year 4 camp/ }).waitFor();
    await page.mouse.move(900, 700);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `compare-${process.env.MAIL_COMPARE}-${theme}.png`) });
    console.log("shot", `compare-${process.env.MAIL_COMPARE}-${theme}`);
    await page.request.put(`${BASE}/api/mail/settings/layout`, { headers, data: { layout: "split" } });
    await context.close();
  }
  await browser.close();
  process.exit(0);
}
for (const theme of ["light", "dark"]) await pass(browser, png, { theme, viewport: { width: 1440, height: 900 } });
await pass(browser, png, { theme: "light", viewport: { width: 1100, height: 760 }, tag: "-narrow" });
await pass(browser, png, { theme: "light", viewport: { width: 390, height: 800 }, tag: "" });
await browser.close();
