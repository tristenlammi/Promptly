// Test fixtures: a signed-in page per test user, each in its own browser
// context (the app wipes local state when a different user signs in on
// the same storage, so users must never share one).
import { type Browser, type BrowserContext, type Locator, type Page, test as base, expect } from "@playwright/test";

import { readRun, type RunInfo, storageStateFile } from "./lib/stack";

export const run: RunInfo = readRun();

/** The backend allows 900 API requests a minute from one address
 *  (RATE_LIMIT_DEFAULT), and the whole suite is one address: an app load
 *  alone is ~25. When the signed-in pages' last minute is near that, the
 *  next test waits — a 429 mid-test signs a page out or fails an upload.
 *  (Calls through ``page.request`` aren't counted, hence the margin.) */
const API_PER_MINUTE = 600;
const apiCalls: number[] = [];

async function pace(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (apiCalls.length && apiCalls[0] < now - 60_000) apiCalls.shift();
    if (apiCalls.length < API_PER_MINUTE) return;
    await new Promise((r) => setTimeout(r, apiCalls[0] + 60_000 - now + 100));
  }
}

async function signedIn(browser: Browser, user: keyof RunInfo["users"]): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: storageStateFile(user) });
  // A newer build than the one under test shows an "updated — Reload"
  // banner over the composer; the suite always tests what's deployed.
  await context.route("**/version.json*", (r) => r.abort());
  context.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/") && !r.url().includes("/api/m/")) apiCalls.push(Date.now());
  });
  return context;
}

/** Wait until the signed-in shell has rendered. */
export async function ready(page: Page): Promise<void> {
  await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible({ timeout: 20_000 });
}

/** A per-run suffix so names never collide with earlier runs' leftovers. */
export const stamp = `${Date.now().toString(36)}`;

/** The Photos folder — the photo library is only what's inside it (and its
 *  subfolders). With ``name``, a new folder of that name inside it, so a
 *  test's uploads stay together (uploads straight into Photos itself are
 *  sorted into YYYY/MM by date taken). Returns the folder's id. */
export async function photosFolder(page: Page, auth: string, name?: string): Promise<string> {
  const headers = { Authorization: auth };
  const root = (await (await page.request.get("/api/photos/settings", { headers })).json()).folder.id as string;
  if (!name) return root;
  const r = await page.request.post("/api/files/folders", { headers, data: { name, parent_id: root, scope: "mine" } });
  expect(r.ok()).toBe(true);
  return (await r.json()).id as string;
}

/** Drive lists are virtualised (WP-7.6): a row far down a long list isn't
 *  in the page until it's scrolled to. Scroll the list until the item
 *  called ``name`` is rendered (a no-op when it already is). */
export async function showRow(page: Page, name: string | Locator): Promise<void> {
  // Only the list's own rows (the rail's folder tree has the same names).
  const target =
    typeof name === "string"
      ? page.locator("[data-drive-item]").filter({ has: page.getByText(name, { exact: true }) })
      : name;
  await page.locator("[data-drive-item]").first().waitFor();
  for (let i = 0; i < 80 && (await target.count()) === 0; i++) {
    const moved = await page.evaluate(() => {
      let el = document.querySelector("[data-drive-item]")?.parentElement ?? null;
      while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollBy(0, el.clientHeight * 0.7);
      return el.scrollTop !== before;
    });
    if (!moved) return;
    await page.waitForTimeout(100);
  }
}

export const test = base.extend<{ alice: Page; bob: Page; dana: Page; pace: void }>({
  pace: [
    async ({}, use) => {
      await pace();
      await use();
    },
    // Its own timeout: a wait here mustn't eat into the test's.
    { auto: true, timeout: 90_000 },
  ],
  alice: async ({ browser }, use) => {
    const context = await signedIn(browser, "alice");
    await use(await context.newPage());
    await context.close();
  },
  bob: async ({ browser }, use) => {
    const context = await signedIn(browser, "bob");
    await use(await context.newPage());
    await context.close();
  },
  /** An administrator. */
  dana: async ({ browser }, use) => {
    const context = await signedIn(browser, "dana");
    await use(await context.newPage());
    await context.close();
  },
});

export { expect };
