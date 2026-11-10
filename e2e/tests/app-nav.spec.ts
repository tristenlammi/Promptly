// Every app opened from inside Promptly keeps Promptly's navigation; only an
// app running as its own installed app goes bare (lib/appLaunch.ts).
//
// "Installed" is simulated: the window reports display-mode standalone (as
// both the installed Promptly window and an installed app's window do), and
// an app's own launch opens its manifest's start_url (``?source=pwa``).
import { execFileSync } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { BACKEND, BASE_URL, storageStateFile } from "../lib/stack";
import { expect, ready, run, stamp, test } from "../fixtures";

const PHONE = { width: 375, height: 812 };

const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (!/display-mode:\\s*standalone/.test(q)) return real(q);
    return { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
  };
})();`;

/** Alice in a new window: a browser tab, or an installed app's window. */
async function aliceWindow(browser: Browser, opts: { installed?: boolean; phone?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    storageState: storageStateFile("alice"),
    ...(opts.phone ? { viewport: PHONE, isMobile: true, hasTouch: true } : {}),
  });
  await ctx.route("**/version.json*", (r) => r.abort());
  if (opts.installed) await ctx.addInitScript(STANDALONE);
  return { ctx, page: await ctx.newPage() };
}

/** Promptly's own sidebar (AppLayout) is on the page. */
async function expectPromptlySidebar(page: Page) {
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible({ timeout: 20_000 });
}

async function expectNoPromptlySidebar(page: Page) {
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toHaveCount(0);
}

/** The vault page's own drawing of Promptly's navigation: the page links. */
const vaultRail = (page: Page) => page.getByRole("navigation", { name: "Promptly" });
/** …and the whole sidebar around them (chats, account). */
const vaultSidebar = (page: Page) => page.getByRole("complementary", { name: "Promptly" });

/** The signed-in page's bearer token, from its own next API call. */
async function bearer(page: Page, go: () => Promise<unknown>): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await go();
  return (await seen).headers()["authorization"];
}

/** A user with no vault yet, signed in by a minted refresh cookie (the
 *  vault's setup has to run for its phone header to show). */
function freshUser(): { refresh: string } {
  const script = `
import asyncio, json, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_refresh_token, hash_password
from app.database import SessionLocal

async def main():
    async with SessionLocal() as db:
        s = uuid.uuid4().hex[:10]
        u = User(email=f"appnav-{s}@example.com", username=f"appnav{s}", password_hash=hash_password("E2e-" + secrets.token_urlsafe(16) + "!9"), role="user")
        db.add(u)
        await db.flush()
        out = {"refresh": create_refresh_token(u.id, token_version=u.token_version)}
        await db.commit()
    print("APPNAV " + json.dumps(out))

asyncio.run(main())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: script, encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("APPNAV "));
  if (!line) throw new Error(out);
  return JSON.parse(line.slice("APPNAV ".length));
}

async function freshWindow(browser: Browser, opts: { phone?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const { refresh } = freshUser();
  const host = new URL(BASE_URL).hostname;
  const ctx = await browser.newContext({
    storageState: {
      cookies: [{ name: "promptly_refresh", value: refresh, domain: host, path: "/api/auth", expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: false, sameSite: "Strict" }],
      origins: [],
    },
    ...(opts.phone ? { viewport: PHONE, isMobile: true, hasTouch: true } : {}),
  });
  return { ctx, page: await ctx.newPage() };
}

const MASTER = "correct horse battery staple 7!";

async function makeVault(page: Page) {
  await page.goto("/passwords");
  await page.getByText("I understand").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByLabel("Type it again").fill(MASTER);
  await page.getByRole("button", { name: "Create vault" }).click();
  const key = page.getByTestId("secret-key");
  await expect(key).toBeVisible({ timeout: 60_000 });
  const secret = (await key.textContent())!.trim();
  await page.getByText("I've saved my recovery kit").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Last group of your Secret Key").fill(secret.slice(secret.lastIndexOf("-") + 1));
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Open my vault" }).click();
  await expect(page.getByRole("heading", { name: "All items" })).toBeVisible({ timeout: 30_000 });
}

/** WCAG A/AA problems, less the avatar's initials: the
 *  sidebar footer uses everyone's avatar colour (UserAvatar's palette, white
 *  initials, some under 4.5:1), beside the name written out in full. */
async function axe(page: Page, what: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.html.includes("data-avatar")) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${n.html.slice(0, 120)} ${n.any.map((c) => c.message).join("; ")}`).join(" | ")}`);
}

test.describe("app navigation", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Passwords opened from Promptly shows Promptly's full sidebar and links back", async ({ alice: page }) => {
    const auth = await bearer(page, () => page.goto("/chat"));
    await ready(page);
    const title = `Vault nav chat ${stamp}`;
    const made = await page.request.post("/api/chat/conversations", { headers: { Authorization: auth }, data: { title } });
    expect(made.ok()).toBe(true);
    const chatId = (await made.json()).id as string;

    // The way Promptly opens it: a full page load into the vault's own document.
    await page.goto("/passwords");
    const side = vaultSidebar(page);
    await expect(side).toBeVisible({ timeout: 30_000 });
    // Expanded, as wide as the main sidebar.
    expect(Math.round((await side.boundingBox())!.width)).toBe(288);
    await expect(side.getByText("Promptly", { exact: true })).toBeVisible();
    await expect(side.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(side.getByRole("link", { name: "New chat", exact: true })).toHaveAttribute("href", "/chat");
    await expect(side.getByRole("link", { name: "Search", exact: true })).toHaveAttribute("href", "/chat?search=1");
    const rail = vaultRail(page);
    for (const [name, href] of [
      ["Today", "/today"],
      ["Places", "/places"],
      ["Workspaces", "/workspaces"],
      ["Files", "/files"],
      ["Apps", "/apps"],
    ])
      await expect(rail.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
    // The main sidebar's line icons, no coloured app pictures.
    await expect(rail.locator("img")).toHaveCount(0);

    // New chat's other kinds, as the main sidebar's caret offers them.
    await side.getByRole("button", { name: "More chat types" }).click();
    await expect(side.getByRole("menuitem", { name: /Temporary chat/ })).toHaveAttribute("href", "/chat?temporary=ephemeral");
    await expect(side.getByRole("menuitem", { name: /Temporary \(1 hour\)/ })).toHaveAttribute("href", "/chat?temporary=one_hour");
    await page.keyboard.press("Escape");
    await expect(side.getByRole("menuitem", { name: /Temporary chat/ })).toHaveCount(0);

    // Chats, grouped by day as the main sidebar groups them.
    const chat = side.getByRole("link", { name: title, exact: true });
    await expect(chat).toHaveAttribute("href", `/chat/${chatId}`);
    await expect(side.getByText("Today", { exact: true }).last()).toBeVisible();
    await expect(side.getByText("Older", { exact: true })).toBeVisible(); // the seed's old chats
    await expect(side.getByRole("button", { name: "Load older chats" })).toBeVisible();
    // Folders, closed until opened, with their own chats.
    const folder = side.getByRole("button", { name: /^E2E old folder 1/ });
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folder.click();
    await expect(side.getByRole("link", { name: "E2E filed chat", exact: true })).toBeVisible();

    // You, and the account menu.
    const account = side.getByRole("button", { name: "Account menu" });
    await expect(account).toContainText(run.users.alice.username);
    await account.click();
    const menu = side.getByRole("menu", { name: "Account" });
    await expect(menu.getByRole("menuitem", { name: "Account", exact: true })).toHaveAttribute("href", "/account");
    await expect(menu.getByRole("menuitem", { name: "Archived chats" })).toHaveAttribute("href", "/archive");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // A chat opens in Promptly.
    await chat.click();
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await ready(page);

    // Search opens Promptly's search.
    await page.goto("/passwords");
    await vaultSidebar(page).getByRole("link", { name: "Search", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Search conversations" })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/chat$/);

    // New folder opens Promptly's new-folder box.
    await page.goto("/passwords");
    await vaultSidebar(page).getByRole("link", { name: "New folder", exact: true }).first().click(); // the heading's button
    const newFolder = page.getByRole("dialog", { name: "New folder" });
    await expect(newFolder).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/chat$/);
    await newFolder.getByRole("button", { name: "Cancel" }).click();
    await expect(newFolder).toHaveCount(0);

    // And the pages are links into Promptly.
    await page.goto("/passwords");
    await vaultRail(page).getByRole("link", { name: "Files", exact: true }).click();
    await expect(page).toHaveURL(/\/files$/);
    await ready(page);
  });

  test("the vault's Promptly sidebar collapses, and remembers it like the main one", async ({ browser }) => {
    const { ctx, page } = await freshWindow(browser);
    await page.goto("/passwords");
    const side = vaultSidebar(page);
    await expect(side).toBeVisible({ timeout: 30_000 });
    await expect(side.getByText("No personal chats yet. Start a new chat or open a workspace.")).toBeVisible();
    await side.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(side.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    expect(Math.round((await side.boundingBox())!.width)).toBe(56);
    await expect(vaultRail(page).getByRole("link", { name: "Files", exact: true })).toBeVisible();
    await expect(side.getByRole("link", { name: "New chat", exact: true })).toBeVisible();
    await page.waitForTimeout(1000); // the setting saves

    // Remembered here…
    await page.reload();
    await expect(vaultSidebar(page).getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 30_000 });
    // …and it's the main sidebar's own setting.
    await page.goto("/files");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 20_000 });
    // A new person's first visit asks which apps they want.
    const welcome = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Pick your apps" }) });
    await welcome.getByRole("button", { name: "Close", exact: true }).click();
    await expect(welcome).toHaveCount(0);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await page.waitForTimeout(1000);
    await page.goto("/passwords");
    await expect(vaultSidebar(page).getByRole("button", { name: "Collapse sidebar" })).toBeVisible({ timeout: 30_000 });
    await ctx.close();
  });

  test("…in the installed Promptly window too, and not as the installed Passwords app", async ({ browser }) => {
    // The installed Promptly window: launched at "/", then Passwords opened in it.
    const main = await aliceWindow(browser, { installed: true });
    await main.page.goto("/");
    await ready(main.page);
    await main.page.goto("/passwords");
    await expect(vaultRail(main.page)).toBeVisible({ timeout: 30_000 });
    await main.ctx.close();

    // The installed Passwords app: its start_url, then a reload in that window.
    const own = await aliceWindow(browser, { installed: true });
    await own.page.goto("/passwords/?source=pwa");
    await expect(own.page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
    await own.page.waitForTimeout(1500);
    await expect(vaultRail(own.page)).toHaveCount(0);
    await expect(own.page.getByRole("button", { name: "Open navigation menu" })).toHaveCount(0);
    await own.page.goto("/passwords/");
    await own.page.waitForTimeout(1500);
    await expect(vaultRail(own.page)).toHaveCount(0);
    // Leaving its scope for a Promptly page brings Promptly's navigation.
    await own.page.goto("/files");
    await expectPromptlySidebar(own.page);
    await own.ctx.close();

    // A copied start URL in a browser tab is still a tab.
    const tab = await aliceWindow(browser);
    await tab.page.goto("/passwords/?source=pwa");
    await expect(vaultRail(tab.page)).toBeVisible({ timeout: 30_000 });
    await tab.ctx.close();
  });

  for (const app of [
    { path: "/rooms", start: "/rooms/?source=pwa", seen: /Rooms|Messages/ },
    { path: "/mail", start: "/mail/?source=pwa", seen: /mail/i },
    { path: "/calendar", start: "/calendar/?source=pwa", seen: /Calendar|Today/ },
    { path: "/photos/", start: "/photos/?source=pwa", seen: /Photos/ },
  ]) {
    test(`${app.path} keeps Promptly's navigation inside Promptly, and not as its own installed app`, async ({ browser }) => {
      const tab = await aliceWindow(browser);
      await tab.page.goto(app.path);
      await expectPromptlySidebar(tab.page);
      await tab.ctx.close();

      // The installed Promptly window, opened at the app's address (as a
      // notification or a link does) — still Promptly.
      const main = await aliceWindow(browser, { installed: true });
      await main.page.goto("/chat");
      await ready(main.page);
      await main.page.goto(app.path);
      await expectPromptlySidebar(main.page);
      await main.ctx.close();

      const own = await aliceWindow(browser, { installed: true });
      await own.page.goto(app.start);
      await expect(own.page.getByText(app.seen).first()).toBeVisible({ timeout: 30_000 });
      await expectNoPromptlySidebar(own.page);
      await own.ctx.close();
    });
  }

  test("phone: Rooms, Mail and Maps open Promptly's menu; their installed apps don't have it", async ({ browser }) => {
    const phone = await aliceWindow(browser, { phone: true, installed: true });
    for (const path of ["/rooms", "/mail", "/maps"]) {
      await phone.page.goto(path);
      const button = phone.page.getByRole("button", { name: "Open navigation menu" });
      await expect(button).toBeVisible({ timeout: 30_000 });
      await button.click();
      const drawer = phone.page.getByRole("dialog", { name: "Navigation menu" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "New chat", exact: true }).first()).toBeVisible();
      await drawer.getByRole("link", { name: "Files", exact: true }).click();
      await expect(phone.page).toHaveURL(/\/files$/);
    }
    await phone.ctx.close();

    for (const start of ["/rooms/?source=pwa", "/mail/?source=pwa"]) {
      const own = await aliceWindow(browser, { phone: true, installed: true });
      await own.page.goto(start);
      await expect(own.page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
      await expectNoPromptlySidebar(own.page);
      await own.ctx.close();
    }
  });

  test("the vault's Promptly navigation on a phone and a big screen, with no accessibility problems", async ({ browser }) => {
    const { ctx, page } = await freshWindow(browser, { phone: true });
    await makeVault(page);
    // The vault's own phone header: Promptly's menu button beside the vault's menu.
    const header = page.locator("header").filter({ has: page.getByRole("button", { name: "Menu", exact: true }) });
    const open = header.getByRole("button", { name: "Open navigation menu" });
    await expect(open).toBeVisible();
    await expect(vaultSidebar(page)).toBeHidden(); // no squeezed sidebar on a phone
    const bad: string[] = [...(await axe(page, "phone"))];
    await open.click();
    // The main app's phone menu: the whole sidebar in a drawer.
    const drawer = page.getByRole("dialog", { name: "Navigation menu" });
    await expect(drawer).toBeVisible();
    for (const name of ["New chat", "Search", "Today", "Workspaces", "Files", "Apps"]) await expect(drawer.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(drawer.getByText("No personal chats yet. Start a new chat or open a workspace.")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Account menu" })).toBeVisible();
    bad.push(...(await axe(page, "phone, menu open")));
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden(); // slid away, and inert
    // Its close button closes it too, as the main app's does.
    await open.click();
    await drawer.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(drawer).toBeHidden(); // slid away, and inert

    // Lock still works, and the menu stays on the unlock screen.
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(page.getByLabel("Master password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();

    // A big screen: Promptly's sidebar, expanded, then the vault's own sidebar, in light and dark.
    await page.setViewportSize({ width: 1366, height: 860 });
    await page.getByLabel("Master password").fill(MASTER);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    const vaultNav = page.getByRole("navigation", { name: "Passwords" });
    await expect(vaultNav).toBeVisible({ timeout: 30_000 });
    const side = vaultSidebar(page);
    await expect(side).toBeVisible();
    await expect(side.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    expect((await side.boundingBox())!.x + 288).toBeLessThanOrEqual(Math.ceil((await vaultNav.boundingBox())!.x));
    await side.getByRole("button", { name: "Account menu" }).click();
    bad.push(...(await axe(page, "desktop, account menu open")));
    await page.keyboard.press("Escape");
    bad.push(...(await axe(page, "desktop")));
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(800); // let the buttons' colour transitions finish
    bad.push(...(await axe(page, "desktop, dark")));
    expect(bad).toEqual([]);
    await ctx.close();
  });
});
