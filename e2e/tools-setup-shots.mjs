// Walks the first-run setup wizard on a FRESH stack (no admin yet) and saves
// a screenshot of every step into docs/setup-shots/. Not a test in the
// suite (the suite's stack already has its admin), but it fails loudly if a
// step isn't where it should be, so it doubles as a check of the flow.
//
//   scripts/stack.sh up setup --with calls,maps-full,voice --build-extras
//   cd e2e && E2E_BASE_URL=http://localhost:8094 SETUP_BACKEND=PromptlySetup-Backend \
//     SETUP_PASS=desktop node tools-setup-shots.mjs
//   scripts/stack.sh down setup --keep-images && scripts/stack.sh up setup --with calls,maps-full,voice --build-extras
//   ... SETUP_PASS=phone node tools-setup-shots.mjs
//
// The Maps step needs the real maps container: maps-full, and ALWAYS with
// --build-extras (without it the stack reuses the main app's older maps
// image, which may start downloading Australia by itself). With the stub
// ("maps") or no maps the wizard leaves the step out and this says so.
// The desktop pass really chooses a map (SETUP_MAP, default new-zealand:
// about 400 MB, 12 minutes, 4.5 GB of disk while it builds); taking the
// stack down afterwards deletes it. SETUP_MAP=none skips with "Not now".
//
// desktop:  "Set everything up now", every step (a real map chosen), a reload
//           in the middle (resume), then the new chat it ends on, Today's card,
//           Admin → Setup and one step reopened.
// phone:    "Just look around" first, then a step from the summary; "Not
//           now" on the Maps step.
// notready: "Just look around" and straight in; an AI service is connected
//           afterwards, so the built-in Promptly model shows as not ready
//           in the chat's model list until its model is chosen.
//
// No real AI service is used: once the "nothing connected" screens are shot,
// a provider with a made-up catalogue is put straight into the stack's
// database (SETUP_BACKEND, the stack's backend container), which is what
// the wizard sees when an API key was set in .env.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8094";
const BACKEND = process.env.SETUP_BACKEND ?? "PromptlySetup-Backend";
const PASS = process.env.SETUP_PASS ?? "desktop";
const OUT = path.resolve(here, "../docs/setup-shots");
// The map the desktop pass downloads; "none" for "Not now".
const MAP = process.env.SETUP_MAP ?? (PASS === "desktop" ? "new-zealand" : "none");
fs.mkdirSync(OUT, { recursive: true });

const SEED = `
import asyncio
import app.db_models  # noqa: F401 (every table, so foreign keys resolve)
from app.database import SessionLocal
from app.models_config.models import ModelProvider

MODELS = [
    ("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", True, False),
    ("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", True, False),
    ("anthropic/claude-3.7-sonnet", "Claude 3.7 Sonnet", True, False),
    ("google/gemini-2.5-pro", "Gemini 2.5 Pro", True, False),
    ("google/gemini-2.5-flash", "Gemini 2.5 Flash", True, False),
    ("google/gemini-2.5-flash-image", "Gemini 2.5 Flash Image", True, True),
    ("openai/gpt-5", "GPT-5", True, False),
    ("openai/gpt-5-mini", "GPT-5 Mini", True, False),
    ("openai/text-embedding-3-small", "Text Embedding 3 Small", False, False),
]

async def main():
    async with SessionLocal() as db:
        db.add(ModelProvider(name="OpenRouter", type="openrouter", enabled=True, models=[
            {"id": i, "display_name": n, "supports_vision": v, "supports_image_output": g} for i, n, v, g in MODELS
        ]))
        await db.commit()

asyncio.run(main())
`;

function seedProvider() {
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: SEED, stdio: ["pipe", "inherit", "inherit"] });
}

const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, notready: { width: 1280, height: 800 } };
const viewport = sizes[PASS];
if (!viewport) throw new Error(`SETUP_PASS must be desktop or phone, not ${PASS}`);

const browser = await chromium.launch();
// A browser in New Zealand, so the map picker offers New Zealand first.
const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: PASS === "phone", isMobile: PASS === "phone", timezoneId: "Pacific/Auckland", locale: "en-NZ" });
await context.route("**/version.json*", (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// The signed-in admin's token, for a question straight to the API.
const bearer = async () => `Bearer ${await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST", credentials: "include" })).json()).access_token)}`;

let n = 0;
const shot = async (name) => {
  n += 1;
  await page.waitForTimeout(350);
  const file = path.join(OUT, `${PASS}-${String(n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("  ", path.basename(file));
};
const wizard = page.getByTestId("setup-wizard");
const at = async (step) => {
  await wizard.and(page.locator(`[data-step="${step}"]`)).waitFor({ timeout: 20_000 });
};

const status = await (await fetch(`${BASE}/api/auth/setup-status`)).json();
if (!status.requires_setup) throw new Error(`${BASE} already has an admin: the wizard only runs on a fresh stack (stack.sh down, then up)`);

// ---- The account ----
await page.goto(`${BASE}/`);
await at("account");
await shot("account");
await page.getByLabel("Email").fill("sam@example.com");
await page.getByLabel("Username").fill("sam");
await page.getByLabel("Password", { exact: true }).fill("Garden-Path-4471!");
await page.getByLabel("Confirm password").fill("Garden-Path-4471!");
await page.getByRole("button", { name: "Continue" }).click();

// ---- Two ways in ----
await at("path");
await shot("path");

const picker = page.locator('button[aria-haspopup="listbox"]').first();

if (PASS === "notready") {
  await page.getByTestId("setup-path-look").click();
  await at("summary");
  await page.getByTestId("setup-checklist").waitFor();
  await page.getByTestId("setup-finish").click();
  // Setup ends on a new chat.
  await page.waitForURL(/\/chat$/, { timeout: 30_000 });
  // An AI service is connected later, outside the wizard.
  seedProvider();
  await page.goto(`${BASE}/chat`);
  await picker.waitFor({ timeout: 30_000 });
  await picker.click();
  const row = page.locator('[role="option"][data-needs-setup="true"]');
  await row.waitFor();
  if (!/Promptly/.test(await row.innerText()) || !/Not ready/.test(await row.innerText())) throw new Error("Promptly isn't listed as not ready");
  await shot("picker-promptly-not-ready");
  // For an admin the row goes straight to choosing its model.
  await row.click();
  await at("models");
  await page.getByTestId("models-step").waitFor();
  await page.getByLabel("The model behind Promptly").waitFor();
  await shot("choose-model-behind-promptly");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/admin\?tab=setup/);
  await page.getByTestId("setup-row-models").and(page.locator('[data-status="done"]')).waitFor();
  await page.goto(`${BASE}/chat`);
  await picker.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /Promptly/.test(((b) => `${b?.textContent ?? ""} ${b?.getAttribute("aria-label") ?? ""}`)(document.querySelector('button[aria-haspopup="listbox"]'))), null, { timeout: 20_000 });
  await picker.click();
  await page.locator('[role="option"]').first().waitFor();
  if (await page.locator('[role="option"][data-needs-setup="true"]').count()) throw new Error("Promptly still says not ready");
  await shot("chat-starts-on-promptly");
  await page.goto(`${BASE}/admin?tab=models`);
  await page.waitForTimeout(1500);
  await browser.close();
  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log(`done: ${n} screenshots in ${OUT}`);
  process.exit(0);
}

if (PASS === "phone") {
  // Just look around: straight to the summary, nothing else asked.
  await page.getByTestId("setup-path-look").click();
  await at("summary");
  await page.getByTestId("setup-checklist").waitFor();
  await shot("look-summary");
  // A step straight from the summary, and the rest of the steps after it.
  await page.getByRole("button", { name: /Connect one: Connect an AI service/ }).click();
} else {
  await page.getByTestId("setup-path-full").click();
}

// ---- AI service: none yet, and what skipping means ----
await at("provider");
await page.getByText("OpenRouter").first().waitFor();
await shot("provider");
await page.getByRole("button", { name: "Skip for now" }).click();
await shot("provider-skipped");
await page.getByRole("button", { name: "Continue without one" }).click();
await at("models");
await page.getByTestId("models-step-empty").waitFor();
await shot("models-nothing-connected");

// ---- A provider appears (as if its key had been in .env) ----
seedProvider();
await page.getByRole("button", { name: "Connect an AI service" }).click();
await at("provider");
await page.getByText(/Connected — 8 chat models available/).waitFor();
await shot("provider-connected");
await page.getByRole("button", { name: "Continue" }).click();

// ---- Default models, suggested ----
await at("models");
await page.getByTestId("models-step").waitFor();
await page.getByLabel("The model behind Promptly").waitFor();
const picked = async (role) => page.locator(`#setup-model-${role} option:checked`).innerText();
const picks = { chat: await picked("chat"), quick: await picked("quick"), voice: await picked("voice"), see: await picked("see"), draw: await picked("draw") };
console.log("   suggested:", JSON.stringify(picks));
if (!/Claude Sonnet 4\.5/.test(picks.chat) || !/Haiku 4\.5/.test(picks.quick) || !/Flash Image/.test(picks.draw)) {
  throw new Error("the suggestions aren't the expected ones");
}
await shot("models");
await page.getByRole("button", { name: "Use these" }).click();

// ---- The reading model: OpenRouter can do it with the key it has ----
await at("search");
await page.getByText("The reading model").waitFor();
await page.getByRole("button", { name: /Through OpenRouter/ }).waitFor();
await page.waitForTimeout(1500);
await shot("search");
await page.getByRole("button", { name: /Set up later/ }).click();
await shot("search-later");
await page.getByRole("button", { name: "Continue" }).click();

// ---- Maps: nothing downloads until a country is chosen ----
await wizard.and(page.locator('[data-step="maps"], [data-step="outside"]')).waitFor({ timeout: 20_000 });
const mapsStep = (await wizard.getAttribute("data-step")) === "maps";
let mapChosen = false;
if (!mapsStep) {
  console.log("   no Maps step: this stack has no real maps service (bring it up --with maps-full --build-extras)");
} else {
  await page.getByTestId("maps-step").waitFor();
  await page.getByTestId("map-region-picker").waitFor();
  // The browser's own country is offered first.
  const yours = page.getByTestId("map-region-yours");
  await yours.waitFor({ timeout: 30_000 });
  if ((await yours.getAttribute("data-region")) !== "new-zealand") throw new Error("the picker didn't offer New Zealand first");
  await shot("maps");
  const before = await (await page.request.get(`${BASE}/api/maps/regions`, { headers: { Authorization: await bearer() } })).json();
  if (before.chosen || before.building || before.regions.length) throw new Error("something was chosen or downloading before anyone chose a map");
  if (MAP === "none") {
    await page.getByTestId("maps-step-skip").click();
  } else {
    await page.getByTestId("map-region-search").fill(MAP.replace(/-/g, " "));
    await page.getByTestId(`map-region-${MAP}`).click();
    await page.getByTestId("map-region-estimate").getByText("Disk space").waitFor({ timeout: 30_000 });
    await page.getByTestId("map-region-addresses").waitFor();
    await shot("maps-chosen");
    const go = page.getByTestId("maps-step-download");
    if (await go.isDisabled()) throw new Error(`${MAP} doesn't fit on this machine's disk: free some space or set SETUP_MAP=none`);
    await go.click();
    mapChosen = true;
  }
}

await at("outside");
await page.getByTestId("outside-step").waitFor();
await shot("outside");
// A reload in the middle comes back to the same step.
await page.reload();
await at("outside");
await page.getByTestId("outside-step").waitFor();
await page.getByLabel("Web address").fill("https://promptly.example.org");
await page.getByRole("button", { name: "Save address and continue" }).waitFor();
await shot("outside-address-typed");
await page.getByRole("button", { name: "Save address and continue" }).click();

// ---- Email, second step ----
await at("email");
await shot("email");
await page.getByRole("button", { name: "Skip for now" }).click();
await at("mfa");
await shot("mfa");
await page.getByRole("button", { name: "Skip for now" }).click();

// ---- The end ----
await at("summary");
await page.getByTestId("setup-checklist").waitFor();
await shot("summary");
const row = async (id) => page.getByTestId(`setup-row-${id}`).getAttribute("data-status");
const got = { provider: await row("provider"), models: await row("models"), search_model: await row("search_model"), address: await row("address"), email: await row("email"), mfa: await row("mfa") };
if (mapsStep) {
  const maps = await row("maps");
  console.log("   maps row:", maps, "-", await page.getByTestId("setup-row-maps").innerText());
  // Chosen: building by itself (or already done, for a tiny map). Not chosen: still to do.
  if (mapChosen ? !["working", "done"].includes(maps) : maps !== "todo") throw new Error(`the Maps row says ${maps}`);
}
console.log("   summary:", JSON.stringify(got));
const want = { provider: "done", models: "done", search_model: "todo", address: "done", email: "todo", mfa: "todo" };
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`summary rows: wanted ${JSON.stringify(want)}`);
await page.getByTestId("setup-finish").click();

// ---- In the app: a new chat first, then the card on Today, Admin → Setup, one step reopened ----
await page.waitForURL(/\/chat$/, { timeout: 30_000 });
await page.getByPlaceholder(/^Message /).waitFor({ timeout: 30_000 });
await page.waitForFunction(() => /Promptly/.test(((b) => `${b?.textContent ?? ""} ${b?.getAttribute("aria-label") ?? ""}`)(document.querySelector('button[aria-haspopup="listbox"]'))), null, { timeout: 30_000 });
await shot("lands-on-chat");
await page.goto(`${BASE}/today`);
await page.getByTestId("today-setup-card").waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
await shot("today-card");
// A new chat starts on Promptly, by name.
await page.goto(`${BASE}/chat`);
await page.waitForFunction(() => /Promptly/.test(((b) => `${b?.textContent ?? ""} ${b?.getAttribute("aria-label") ?? ""}`)(document.querySelector('button[aria-haspopup="listbox"]'))), null, { timeout: 30_000 });
await picker.click();
await page.locator('[role="option"]').first().waitFor();
await shot("chat-starts-on-promptly");
await page.goto(`${BASE}/admin?tab=setup`);
await page.getByTestId("setup-panel").waitFor({ timeout: 30_000 });
await shot("admin-setup");
await page.getByRole("link", { name: /Change: Choose the models/ }).click();
await at("models");
await page.getByTestId("models-step").waitFor();
await shot("one-step-models");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForURL(/\/admin\?tab=setup/);
await page.goto(`${BASE}/setup?step=outside`);
await at("outside");
await page.getByTestId("outside-step").waitFor();
await shot("one-step-outside");

// ---- The Maps step by itself: what's chosen, and adding another ----
if (mapsStep) {
  await page.goto(`${BASE}/setup?step=maps`);
  await at("maps");
  await page.getByTestId("maps-step").waitFor();
  await page.getByTestId("map-region-picker").waitFor();
  if (mapChosen) await page.getByTestId("maps-step-chosen").waitFor();
  await page.waitForTimeout(800);
  await shot(mapChosen ? "one-step-maps-building" : "one-step-maps");
  await page.goto(`${BASE}/admin?tab=settings`);
  const card = page.getByTestId("maps-regions-card");
  await card.waitFor({ timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await shot("admin-maps-card");
}

await browser.close();
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log(`done: ${n} screenshots in ${OUT}`);
