// Walks the first-run setup wizard on a FRESH stack (no admin yet) and saves
// a screenshot of every step into docs/setup-shots/. Not a test in the
// suite (the suite's stack already has its admin), but it fails loudly if a
// step isn't where it should be, so it doubles as a check of the flow.
//
//   scripts/stack.sh up setup --with calls,maps,voice
//   cd e2e && E2E_BASE_URL=http://localhost:8094 SETUP_BACKEND=PromptlySetup-Backend \
//     SETUP_PASS=desktop node tools-setup-shots.mjs
//   scripts/stack.sh down setup --keep-images && scripts/stack.sh up setup --with calls,maps,voice --no-build
//   ... SETUP_PASS=phone node tools-setup-shots.mjs
//
// desktop:  "Set everything up now", every step, a reload in the middle
//           (resume), then Today's card, Admin → Setup and one step reopened.
// phone:    "Just look around" first, then a step from the summary.
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
const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: PASS === "phone", isMobile: PASS === "phone" });
await context.route("**/version.json*", (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

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
  await page.waitForURL(/\/today$/, { timeout: 30_000 });
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

// ---- At home and away (no Maps step: this branch has no regions API) ----
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
console.log("   summary:", JSON.stringify(got));
const want = { provider: "done", models: "done", search_model: "todo", address: "done", email: "todo", mfa: "todo" };
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`summary rows: wanted ${JSON.stringify(want)}`);
await page.getByTestId("setup-finish").click();

// ---- In the app: the card on Today, Admin → Setup, one step reopened ----
await page.waitForURL(/\/today$/, { timeout: 30_000 });
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

// ---- The Maps step, with a stand-in for the regions API (not on this branch) ----
const regions = [
  { id: "australia", name: "Australia", group: "Oceania", build_gb: 15, disk_gb: 7, build_minutes: 60 },
  { id: "new-zealand", name: "New Zealand", group: "Oceania", build_gb: 4, disk_gb: 2, build_minutes: 20 },
  { id: "united-kingdom", name: "United Kingdom", group: "Europe", build_gb: 22, disk_gb: 11, build_minutes: 120 },
];
let chosen = [];
await page.route("**/api/maps/regions", (r) => r.fulfill({ json: { regions } }));
await page.route("**/api/maps/regions/state", (r) => r.fulfill({ json: { chosen, state: chosen.length ? "building" : "none", step: chosen.length ? "downloading" : null } }));
await page.route("**/api/maps/regions/choose", (r) => {
  chosen = [r.request().postDataJSON().region_id];
  return r.fulfill({ json: { chosen, state: "building", step: "downloading" } });
});
await page.goto(`${BASE}/setup?step=maps`);
await at("maps");
await page.getByTestId("maps-step").waitFor();
await shot("maps-standin");
await page.getByLabel("Country").selectOption("australia");
await page.getByTestId("maps-step-estimate").waitFor();
await page.getByRole("button", { name: "Download Australia" }).click();
await shot("maps-standin-confirm");
await page.getByRole("button", { name: "Yes, start the download" }).click();
await page.getByTestId("maps-step-chosen").waitFor();
await shot("maps-standin-building");

await browser.close();
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log(`done: ${n} screenshots in ${OUT}`);
