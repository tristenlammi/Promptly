// Porch and Notes follow the app-navigation rule (app-nav.spec.ts): opened
// from inside Promptly they keep Promptly's navigation; only their own
// installed app goes bare (lib/appLaunch.ts: isOwnAppWindow).
//
// "Installed" is simulated as in app-nav.spec.ts: the window reports
// display-mode standalone, and an app's own launch opens its manifest's
// start_url (``?source=pwa``).
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { storageStateFile } from "../lib/stack";
import { expect, ready, test } from "../fixtures";

const PHONE = { width: 375, height: 812 };

const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (!/display-mode:\\s*standalone/.test(q)) return real(q);
    return { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
  };
})();`;

async function aliceWindow(browser: Browser, opts: { installed?: boolean; phone?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    storageState: storageStateFile("alice"),
    ...(opts.phone ? { viewport: PHONE, isMobile: true, hasTouch: true } : {}),
  });
  await ctx.route("**/version.json*", (r) => r.abort());
  if (opts.installed) await ctx.addInitScript(STANDALONE);
  return { ctx, page: await ctx.newPage() };
}

async function expectPromptlySidebar(page: Page) {
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible({ timeout: 20_000 });
}

async function expectNoPromptlyNav(page: Page) {
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toHaveCount(0);
  await expect(page.getByText("Back to Promptly")).toHaveCount(0);
}

/** Promptly's menu opens its drawer, and the drawer goes elsewhere. Porch's
 *  pages carry Promptly's menu button; Notes' own menu has "All of Promptly". */
async function menuGoesToFiles(page: Page, app: "porch" | "notes") {
  if (app === "notes") {
    const notesMenu = page.getByRole("button", { name: "Notes menu" }).first();
    await expect(notesMenu).toBeVisible({ timeout: 30_000 });
    await notesMenu.click();
    await page.getByRole("button", { name: "All of Promptly" }).click();
  } else {
    const button = page.getByRole("button", { name: "Open navigation menu" }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
  }
  const drawer = page.getByRole("dialog", { name: "Navigation menu" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
  await drawer.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
}

test.describe("app navigation: Porch and Notes", () => {
  test.describe.configure({ timeout: 180_000 });

  for (const app of [
    { key: "porch" as const, path: "/porch/", start: "/porch/?source=pwa", seen: /Feed|Porch/ },
    { key: "notes" as const, path: "/notes", start: "/notes/?source=pwa", seen: /Notes|Take a note/ },
  ]) {
    test(`${app.path} keeps Promptly's navigation on a big screen, and not as its own installed app`, async ({ browser }) => {
      const tab = await aliceWindow(browser);
      await tab.page.goto(app.path);
      await expectPromptlySidebar(tab.page);
      await tab.ctx.close();

      // The installed Promptly window, opened at the app's address.
      const main = await aliceWindow(browser, { installed: true });
      await main.page.goto("/chat");
      await ready(main.page);
      await main.page.goto(app.path);
      await expectPromptlySidebar(main.page);
      await main.ctx.close();

      const own = await aliceWindow(browser, { installed: true });
      await own.page.goto(app.start);
      await expect(own.page.getByText(app.seen).first()).toBeVisible({ timeout: 30_000 });
      await expectNoPromptlyNav(own.page);
      await own.ctx.close();
    });

    test(`phone: ${app.path} opens Promptly's menu; its installed app doesn't have it`, async ({ browser }) => {
      // A phone browser tab, and the installed Promptly window on a phone.
      for (const installed of [false, true]) {
        const phone = await aliceWindow(browser, { phone: true, installed });
        if (installed) {
          await phone.page.goto("/chat");
          await ready(phone.page);
        }
        await phone.page.goto(app.path);
        await menuGoesToFiles(phone.page, app.key);
        await phone.ctx.close();
      }

      const own = await aliceWindow(browser, { phone: true, installed: true });
      await own.page.goto(app.start);
      await expect(own.page.getByText(app.seen).first()).toBeVisible({ timeout: 30_000 });
      await expectNoPromptlyNav(own.page);
      if (app.key === "notes") {
        // The installed Notes app's own menu has no way into the rest of Promptly.
        await own.page.getByRole("button", { name: "Notes menu" }).first().click();
        await expect(own.page.getByRole("navigation", { name: "Notes" })).toBeVisible();
        await expect(own.page.getByRole("button", { name: "All of Promptly" })).toHaveCount(0);
      }
      await own.ctx.close();
    });
  }

  test("phone: every top-level Porch page has Promptly's menu, and no Back to Promptly link", async ({ browser }) => {
    const { ctx, page } = await aliceWindow(browser, { phone: true });
    await page.goto("/porch/");
    const bar = page.getByRole("navigation", { name: "Porch" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    for (const [label, heading] of [["Groups", "Groups"], ["Activity", "Activity"], ["Profile", "Your profile"]]) {
      await bar.getByRole("link", { name: label }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    }
    await expect(page.getByText("Back to Promptly")).toHaveCount(0);
    await ctx.close();
  });
});
