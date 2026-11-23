// The README's screenshots, in docs/screenshots/. Not a test. Needs the
// demo stack and its data (see the top of tools-readme-seed.mjs):
//
//   cd e2e && node tools-readme-shots.mjs            # all of them
//   node tools-readme-shots.mjs today chat-dark      # just some
//   node tools-readme-shots.mjs banner               # the banner (no stack needed)
//
// README_BASE_URL / README_AUTH as in the seed. README_OUT writes somewhere
// else (a look-over before replacing the real ones); README_SCALE=1 is
// quicker for that.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.README_BASE_URL ?? "http://localhost:8093";
const AUTH = process.env.README_AUTH ?? path.resolve(here, "../.stacks/shots/readme/auth.json");
const OUT = process.env.README_OUT ?? path.resolve(here, "../docs/screenshots");
const SCALE = Number(process.env.README_SCALE ?? 2);
const users = fs.existsSync(AUTH) ? JSON.parse(fs.readFileSync(AUTH, "utf8")).users : {}; // none needed for the banner
const VAULT = "wattle creek lemon slice 12!"; // the demo vault's master password (throwaway stack only)
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

// name → { path, who?, viewport?, theme?, ready(page), before(page) }
const SHOTS = {
  today: { path: "/today", ready: (p) => p.getByText("Parent-teacher interviews").first().waitFor() },
  chat: { path: "/chat", before: openChat },
  "chat-dark": { path: "/chat", theme: "dark", before: openChat },
  files: { path: "/files", ready: (p) => p.getByText("Tasmania itinerary").first().waitFor() },
  document: { path: "/files", before: async (p) => { await openFile(p, "Tasmania itinerary"); await p.getByRole("button", { name: /Comments/ }).first().click(); await p.getByText("Could we swap this").first().waitFor(); } },
  sheet: { path: "/files", before: async (p) => { await openFile(p, "Household budget"); await p.mouse.click(300, 407); } }, // a cell picked, as when someone is working in it
  calendar: { path: "/calendar", ready: (p) => p.getByText("Max: dentist").first().waitFor() },
  notes: { path: "/notes", ready: (p) => p.getByText("Tasmania in January").first().waitFor() },
  tasks: { path: "/app/open/tasks", ready: (p) => p.getByText("Sign Ellie's camp forms").first().waitFor() },
  mail: { path: "/mail", before: (p) => p.getByText("Christmas lunch").first().click(), ready: (p) => p.getByText("Uncle Rob is bringing the prawns").first().waitFor() },
  rooms: { path: "/rooms", before: openSpace, ready: (p) => p.getByText("He has a type").first().waitFor() },
  photos: { path: "/photos", ready: (p) => p.waitForTimeout(3000) },
  "photos-album": { path: "/photos/albums", before: async (p) => { await p.getByText("Tasmania 2025").first().click(); await p.waitForURL(/albums\/.+/); }, ready: (p) => p.waitForTimeout(2500) },
  porch: { path: "/porch", ready: (p) => p.getByText("Ferry to Tasmania is booked").first().waitFor() },
  study: { path: "/study", before: async (p) => { await openCourse(p); await p.waitForTimeout(1500); await p.mouse.move(780, 400); await p.mouse.wheel(0, -4000); } },
  passwords: { path: "/passwords", profile: "vault-profile", before: vault },
  mealplan: { path: "/app/open/mealplan", ready: (p) => p.getByText("Chickpea and spinach curry").first().waitFor() },
  budget: { path: "/app/open/budget", ready: (p) => p.getByText(/Groceries/).first().waitFor() },
  apps: { path: "/apps/store" },
  "phone-today": { path: "/today", viewport: PHONE, ready: (p) => p.getByText("Parent-teacher interviews").first().waitFor() },
  "phone-rooms": { path: "/rooms", viewport: PHONE, before: async (p) => { await p.getByText("Spaces", { exact: true }).click(); await p.getByText("Hartley HQ").first().click(); await p.getByText("general", { exact: true }).first().click(); await p.getByText("He has a type").first().waitFor(); } },
  "phone-photos": { path: "/photos", viewport: PHONE, ready: (p) => p.waitForTimeout(3000) },
};

async function openChat(page) {
  await page.getByText("Weeknight dinners for this week").first().click();
  await page.getByText("Shopping list").first().waitFor();
  await page.waitForTimeout(800);
  await page.getByText("Can you plan weeknight dinners").first().scrollIntoViewIfNeeded();
  await page.mouse.move(700, 400);
}

async function openSpace(page) {
  await page.getByRole("button", { name: /Hartley HQ/ }).first().click();
  await page.getByText("general", { exact: true }).first().click();
}

async function openFile(page, name) {
  await page.getByText(name, { exact: true }).first().dblclick();
  await page.waitForURL(/\/files\/(doc|sheet)\//, { timeout: 20_000 });
  await page.waitForTimeout(3500); // the editor connects, then lays out
}

async function openCourse(page) {
  await page.getByText("How home solar power works").first().click();
  await page.getByTestId("study-map").waitFor({ timeout: 30_000 });
}

async function vault(page) {
  const master = page.getByLabel("Master password");
  await master.waitFor({ timeout: 30_000 });
  await master.fill(VAULT);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("navigation", { name: "Passwords" }).waitFor({ timeout: 30_000 });
  await page.getByText("Southern Ridge Energy").first().click();
  await page.waitForTimeout(800);
}

async function take(browser, name) {
  const spec = SHOTS[name];
  if (!spec) throw new Error(`no shot called ${name}`);
  const viewport = spec.viewport ?? DESKTOP;
  const phone = viewport.width < 600;
  const host = new URL(BASE).hostname;
  const cookie = { name: "promptly_refresh", value: users[spec.who ?? "claire"].refresh_token, domain: host, path: "/api/auth", expires: Date.now() / 1000 + 86400, httpOnly: true, secure: false, sameSite: "Strict" };
  const options = {
    viewport, deviceScaleFactor: SCALE, hasTouch: phone, isMobile: phone, locale: "en-AU", timezoneId: "Australia/Sydney",
    colorScheme: spec.theme ?? "light",
    serviceWorkers: spec.profile ? "allow" : "block",
  };
  // The vault opens only in the browser profile that made it (the seed keeps it).
  const context = spec.profile
    ? await chromium.launchPersistentContext(path.join(path.dirname(AUTH), spec.profile), options)
    : await browser.newContext(options);
  await context.addCookies([cookie]);
  await context.route("**/version.json*", (r) => r.abort()); // no "updated, reload" banner
  // The demo stack runs without the photo-understanding service, so its
  // progress card would sit at 40% for ever. A real install finishes.
  await context.route("**/api/photos/understanding*", (r) => r.fulfill({ json: { complete: true, stages: [] } }));
  await context.addInitScript((t) => {
    localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 }));
    localStorage.setItem("promptly.today.install-nudge.dismissed", "1");
  }, spec.theme ?? "light");
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(`${BASE}${spec.path}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    if (spec.before) await spec.before(page);
    if (spec.ready) await spec.ready(page);
    await page.waitForTimeout(1200); // entrance animations, thumbnails
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("shot", name);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, `${name}.FAILED.png`) }).catch(() => undefined);
    console.error(`shot ${name} FAILED: ${String(err.message).split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

// The banner at the top of the README: a page of its own (readme-shots/
// banner.html), not the app, so it needs no stack. Only when asked for.
async function banner(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 300 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(here, "readme-shots", "banner.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, "readme-banner.png") });
  await page.close();
  console.log("shot banner");
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
const browser = await chromium.launch();
for (const name of wanted) await (name === "banner" ? banner(browser) : take(browser, name));
await browser.close();
