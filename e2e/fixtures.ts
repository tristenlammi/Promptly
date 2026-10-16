// Test fixtures: a signed-in page per test user, each in its own browser
// context (the app wipes local state when a different user signs in on
// the same storage, so users must never share one).
import { type Browser, type BrowserContext, type Locator, type Page, test as base, expect } from "@playwright/test";

import { readRun, type RunInfo, storageStateFile } from "./lib/stack";

export const run: RunInfo = readRun();

async function signedIn(browser: Browser, user: keyof RunInfo["users"]): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: storageStateFile(user) });
  // A newer build than the one under test shows an "updated — Reload"
  // banner over the composer; the suite always tests what's deployed.
  await context.route("**/version.json*", (r) => r.abort());
  return context;
}

/** Wait until the signed-in shell has rendered. */
export async function ready(page: Page): Promise<void> {
  await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible({ timeout: 20_000 });
}

/** A per-run suffix so names never collide with earlier runs' leftovers. */
export const stamp = `${Date.now().toString(36)}`;

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

export const test = base.extend<{ alice: Page; bob: Page; dana: Page }>({
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
