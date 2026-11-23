// Gives the README's demo stack a real map, the way an admin does it: Admin →
// App settings → "Maps on this server" → choose a country → wait for it to
// build. Not a test. Only for the throwaway stack, which must run the real
// maps container (scripts/stack.sh up shots --with ...,maps-full
// --build-extras; never without --build-extras, see tools-readme-seed.mjs).
//
//   cd e2e && node readme-shots/choose-map.mjs              # New Zealand
//   node readme-shots/choose-map.mjs liechtenstein          # another one
//
// New Zealand is about a 1.2 GB download, 12 to 15 minutes and 4.7 GB of free
// disk while it builds; taking the stack down deletes it. Run again and it
// just waits for (or confirms) the map that's already chosen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.README_BASE_URL ?? "http://localhost:8093";
const AUTH = process.env.README_AUTH ?? path.resolve(here, "../../.stacks/shots/readme/auth.json");
const REGION = process.argv[2] ?? "new-zealand";
const claire = JSON.parse(fs.readFileSync(AUTH, "utf8")).users.claire;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: "promptly_refresh", value: claire.refresh_token, domain: new URL(BASE).hostname, path: "/api/auth", expires: Date.now() / 1000 + 86400, httpOnly: true, secure: false, sameSite: "Strict" }]);
await context.route("**/version.json*", (r) => r.abort());
const page = await context.newPage();
try {
  await page.goto(`${BASE}/admin?tab=settings`);
  const card = page.getByTestId("maps-regions-card");
  await card.waitFor({ timeout: 60_000 });
  await card.scrollIntoViewIfNeeded();
  const row = card.getByTestId(`maps-region-row-${REGION}`);
  if (await row.count()) {
    console.log(`${REGION}: already chosen (${await row.getAttribute("data-state")})`);
  } else {
    await card.getByTestId("maps-regions-add").click();
    await card.getByTestId("map-region-search").fill(REGION.replace(/-/g, " "));
    await card.getByTestId(`map-region-${REGION}`).click();
    const estimate = card.getByTestId("map-region-estimate");
    await estimate.getByText("Disk space").waitFor({ timeout: 60_000 });
    console.log((await estimate.innerText()).replace(/\s*\n\s*/g, " | "));
    const go = card.getByTestId("maps-regions-confirm");
    if (await go.isDisabled()) throw new Error(`${REGION} doesn't fit on this machine's disk`);
    await go.click();
    await row.waitFor({ timeout: 60_000 });
    console.log(`${REGION}: chosen, building`);
  }
  // The card refreshes itself while a map builds.
  const started = Date.now();
  let last = "";
  for (;;) {
    const state = await row.getAttribute("data-state");
    if (state === "installed") break;
    if (await card.getByText("The map build stopped").count()) throw new Error("the map build stopped: see the maps container's log");
    if (Date.now() - started > 60 * 60_000) throw new Error("still building after an hour");
    const progress = card.getByTestId("maps-regions-progress");
    const now = (await progress.count()) ? (await progress.innerText()).split("\n")[0] : String(state);
    if (now !== last) console.log(`  ${Math.round((Date.now() - started) / 60_000)} min: ${now}`);
    last = now;
    await page.waitForTimeout(10_000);
  }
  console.log(`${REGION}: ready after ${Math.round((Date.now() - started) / 60_000)} min`);
} finally {
  await browser.close();
}
