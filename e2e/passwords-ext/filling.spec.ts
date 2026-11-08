// Finishing the extension: fill on load, auto-lock, on-click mode, reprompt and fill-only
// codes, generated sign-ups, flows across pages, clipboard clearing, route changes,
// save offers with no submit event, the signed rules pack, multi-frame filling, Hello.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type Page, test } from "@playwright/test";

import { onboard as onboardWeb, signedIn } from "../passwords-tests/helpers";
import { addItem, BASE, bg, connect, launch, lockExt, makeUsers, MASTER, menuFrame, popupFor, readClipboard, type Rig, siteA, startSite, tabIdOf, testHook, unlockExt, writeClipboard } from "./lib";

test.describe.configure({ mode: "serial", timeout: 240_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, "..", "..", "passwords", "extension");

let rig: Rig;
let site: { close: () => void };
let owner: ReturnType<typeof makeUsers>[number];

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  [owner] = makeUsers(["fin"]);
  await connect(rig, owner);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** A press only counts once the menu or bar has been showing for half a second. */
const LOOK_MS = 800;

type ItemOut = { id: string; title: string; username?: string; password?: string; pendingPassword?: string; tags: string[]; urls: { url: string }[]; history: number };

const items = () => testHook<ItemOut[]>(rig, "items");
const itemNamed = async (title: string) => (await items()).find((i) => i.title === title)!;
const patch = (id: string, change: Record<string, unknown>) => testHook(rig, "patchItem", { id, patch: change });
const forHost = async (host: string) => (await items()).filter((i) => i.urls.some((u) => u.url.includes(host)));

async function saved(fields: { title: string; url: string; username: string; password: string }) {
  await addItem(rig, fields);
  return itemNamed(fields.title);
}

async function openMenu(page: Page, selector: string) {
  await page.click(selector);
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  await page.waitForTimeout(LOOK_MS);
  return f;
}

const saveFrame = (page: Page) => page.frames().find((f) => f.url().includes("/save.html"));

async function vaultPage(route = ""): Promise<Page> {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/vault.html${route}`);
  await expect(p.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  return p;
}

async function setSettings(change: { lockMinutes?: number; clipboardSeconds?: number; lockOnSleep?: boolean }) {
  const v = await vaultPage("#/settings");
  if (change.lockMinutes !== undefined) await v.getByLabel("Lock this browser's vault").selectOption(String(change.lockMinutes));
  if (change.clipboardSeconds !== undefined) await v.locator('input[type=number][min="5"]').fill(String(change.clipboardSeconds));
  if (change.lockOnSleep !== undefined) await v.getByRole("checkbox", { name: "Also lock when the computer sleeps" }).setChecked(change.lockOnSleep);
  await v.waitForTimeout(400);
  await v.close();
}

// ---- Fill on load (plan 6.6) ------------------------------------------------------------

test("fill on load: never for a base-domain match, a frame, or more than one match", async () => {
  // A base-domain match, opted in. The popup offers it, so the match itself is real.
  const base = await saved({ title: "Base", url: "http://base.localhost:8112", username: "ana", password: "Base-Pw-1" });
  await patch(base.id, { autofillOnLoad: true });
  await rig.ctx.newPage().then(async (page) => {
    await page.goto("http://sub.base.localhost:8112/login.html");
    const pop = await popupFor(rig, page);
    await expect(pop.getByRole("button", { name: "Fill Base" })).toBeVisible();
    await pop.close();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).__state().pass)).toBe("");
    await page.close();
  });

  // The exact host of the same item does fill, so the setting's really on.
  const exact = await rig.ctx.newPage();
  await exact.goto("http://base.localhost:8112/login.html");
  await expect.poll(() => exact.evaluate(() => (window as any).__state().pass), { timeout: 10_000 }).toBe("Base-Pw-1");
  await exact.close();

  // Exact host, opted in, but in a frame of another page.
  const frame = await rig.ctx.newPage();
  await frame.goto(`http://top.localhost:8112/frames.html?src=${encodeURIComponent("http://base.localhost:8112/login.html")}`);
  await frame.waitForTimeout(1500);
  const inner = frame.frames().find((f) => f !== frame.mainFrame() && f.url().includes("base.localhost"))!;
  expect(await inner.evaluate(() => (document.getElementById("pass") as HTMLInputElement).value)).toBe("");
  await frame.close();

  // A second login for the host means someone has to choose.
  await saved({ title: "Base two", url: "http://base.localhost:8112", username: "bob", password: "Base-Pw-2" });
  const two = await rig.ctx.newPage();
  await two.goto("http://base.localhost:8112/login.html");
  await two.waitForTimeout(1500);
  expect(await two.evaluate(() => (window as any).__state().pass)).toBe("");
  await two.close();
});

// ---- Auto-lock ---------------------------------------------------------------------------

test("auto-lock: the Settings screen's minutes set the alarm, and using the vault page extends it", async () => {
  await setSettings({ lockMinutes: 30 });
  const alarm = () => bg<number>(rig, `return (await chrome.alarms.get("autolock"))?.scheduledTime ?? 0;`);
  const v = await vaultPage();
  await v.mouse.move(50, 50);
  await v.mouse.move(60, 60);
  const inMinutes = async () => ((await alarm()) - Date.now()) / 60_000;
  await expect.poll(inMinutes, { timeout: 15_000 }).toBeGreaterThan(29);
  const first = await alarm();
  // The page tells the background at most every 20 seconds.
  await v.waitForTimeout(21_000);
  await v.bringToFront();
  await v.mouse.move(70, 70);
  await v.mouse.move(80, 80);
  await expect.poll(alarm, { timeout: 15_000 }).toBeGreaterThan(first + 15_000);
  await v.close();
  await setSettings({ lockMinutes: 15 });
});

test("auto-lock: when the alarm fires, the background and an open vault page both lock", async () => {
  const v = await vaultPage();
  await bg(rig, `await chrome.alarms.create("autolock", { delayInMinutes: 0.02 });`);
  await expect(v.getByText("Your vault is locked")).toBeVisible({ timeout: 30_000 });
  expect(await bg<boolean>(rig, `return !!(await chrome.storage.session.get("unlock")).unlock;`)).toBe(false);
  await v.close();
  await unlockExt(rig);
});

test("lock on sleep: honours the setting, for the idle event and for a long gap between alarms", async () => {
  const unlocked = () => bg<boolean>(rig, `return (await chrome.runtime.sendMessage({ t: "state" })).r.unlocked;`);
  await setSettings({ lockOnSleep: false });
  await testHook(rig, "idle", { state: "locked" });
  expect(await unlocked()).toBe(true);
  await testHook(rig, "sleepGap", { ms: 10 * 60 * 1000 });
  expect(await unlocked()).toBe(true);

  await setSettings({ lockOnSleep: true });
  // A short gap isn't sleep, whatever the setting.
  await testHook(rig, "sleepGap", { ms: 60 * 1000 });
  expect(await unlocked()).toBe(true);
  await testHook(rig, "idle", { state: "idle" });
  expect(await unlocked()).toBe(true);
  await testHook(rig, "idle", { state: "locked" });
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
  await testHook(rig, "sleepGap", { ms: 10 * 60 * 1000 });
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
});

test("locking from the popup takes an open vault page with it", async () => {
  const v = await vaultPage();
  await lockExt(rig);
  await expect(v.getByText("Your vault is locked")).toBeVisible({ timeout: 15_000 });
  await v.close();
  await unlockExt(rig);
});

// ---- On-click mode ---------------------------------------------------------------------

test("the on-click box tells the truth: unticking asks for the permission, and a no keeps it ticked", async () => {
  const scripts = () => bg<string[]>(rig, `return (await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id).sort();`);
  const v = await vaultPage("#/settings");
  const box = v.getByTestId("settings").getByRole("checkbox", { name: "Only fill when I click the toolbar button" });
  await box.click();
  await expect(box).toBeChecked();
  await expect.poll(scripts).toEqual([]);

  // Filling still works from the toolbar button, which puts the script in place first.
  await saved({ title: "On click", url: "http://onclick.localhost:8111", username: "oc@example.com", password: "On-Click-1" });
  const target = await rig.ctx.newPage();
  await target.goto("http://onclick.localhost:8111/login.html");
  await target.waitForTimeout(300);
  await target.click("#user");
  await target.waitForTimeout(300);
  expect(menuFrame(target), "no inline menu without standing access").toBeUndefined();
  const pop = await popupFor(rig, target);
  await pop.getByRole("button", { name: "Fill On click" }).click();
  await expect.poll(() => target.evaluate(() => (window as any).__state().pass)).toBe("On-Click-1");
  await pop.close().catch(() => undefined);
  await target.close();
  await v.bringToFront();

  // The person says no to the browser's prompt.
  await v.evaluate(() => {
    (chrome.permissions as any).__real = chrome.permissions.request;
    chrome.permissions.request = (async () => false) as never;
  });
  await box.click();
  await expect(v.getByTestId("settings").getByText("filling stays on click")).toBeVisible();
  await expect(box).toBeChecked();
  expect(await scripts()).toEqual([]);

  // And then yes.
  await v.evaluate(() => {
    chrome.permissions.request = (chrome.permissions as any).__real;
  });
  await box.click();
  await expect(box).not.toBeChecked();
  await expect.poll(scripts).toEqual(["promptly-fields", "promptly-passkey"]);
  await v.close();
});

// ---- Reprompt and fill-only ------------------------------------------------------------

test("a reprompt item shows no 2FA code until the master password's been given again", async () => {
  const it = await saved({ title: "Guarded", url: "http://guarded.localhost:8111", username: "g", password: "Guarded-1" });
  await patch(it.id, { reprompt: true, totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
  const page = await rig.ctx.newPage();
  await page.goto("http://guarded.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill Guarded" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Copy 2FA code for Guarded" })).toHaveCount(0);

  // Asking the background directly gets nothing either, from any page.
  const direct = await pop.evaluate(async (id) => chrome.runtime.sendMessage({ t: "totp", id }), it.id);
  expect(direct.r).toBeNull();

  await pop.getByRole("button", { name: "Show 2FA code for Guarded" }).click();
  await pop.getByLabel("Master password again").fill("not the password");
  await pop.getByRole("button", { name: "Continue" }).click();
  await expect(pop.getByText("That isn't your master password.")).toBeVisible({ timeout: 30_000 });
  await expect(pop.getByRole("button", { name: "Copy 2FA code for Guarded" })).toHaveCount(0);
  await pop.getByLabel("Master password again").fill(MASTER);
  await pop.getByRole("button", { name: "Continue" }).click();
  await expect(pop.getByRole("button", { name: "Copy 2FA code for Guarded" })).toBeVisible({ timeout: 30_000 });
  await pop.close();
  await page.close();
});

test("a fill-only member gets a filled box, and no code on screen or on the clipboard", async () => {
  // Someone else's shared vault, in a browser of their own, across real users.
  const browser = await chromium.launch({ channel: process.env.PW_EXT_CHANNEL ?? "chrome", headless: true });
  try {
    const [alice] = makeUsers(["finowner"]);
    const ctx = await signedIn(browser, alice, { baseURL: BASE });
    const a = await ctx.newPage();
    await onboardWeb(a);
    await a.getByRole("navigation", { name: "Passwords" }).getByText("Shared vaults").click();
    await a.getByRole("button", { name: "New vault" }).click();
    await a.getByLabel("Name").fill("Family");
    await a.getByRole("button", { name: "Make vault" }).click();
    const card = a.getByTestId("shared-vault").filter({ hasText: "Family" });
    await expect(card).toBeVisible();
    await card.getByTestId("add-person").selectOption({ label: owner.username });
    await card.locator("label", { hasText: "They can" }).locator("select").selectOption({ label: "Can fill only (can't reveal)" });
    await card.getByRole("button", { name: "Invite" }).click();
    await card.getByTestId("member-row").filter({ hasText: owner.username }).getByRole("button", { name: "Safety words" }).click();
    await a.getByRole("button", { name: "They match" }).click();

    await a.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
    await a.getByRole("button", { name: "New", exact: true }).click();
    await a.getByRole("menuitem", { name: "Login" }).click();
    await a.getByLabel("Name", { exact: true }).fill("Shared login");
    await a.getByLabel("Username or email").fill("house@example.com");
    await a.getByLabel("Password", { exact: true }).fill("Sh4red-Pass!");
    await a.locator('input[aria-label="Website 1"]').fill("http://shared.localhost:8111");
    await a.getByLabel("2FA secret or otpauth link").fill("JBSWY3DPEHPK3PXP");
    await a.locator("label", { hasText: "Vault" }).locator("select").selectOption({ label: "Family" });
    await a.getByRole("button", { name: "Save" }).click();
    await expect(a.getByRole("article", { name: "Shared login" })).toBeVisible();

    // The member accepts, on the web, and the extension picks it up.
    const web = await rig.ctx.newPage();
    await web.goto(`${BASE}/passwords`);
    await web.getByLabel("Master password").fill(MASTER);
    await web.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(web.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 60_000 });
    await web.getByRole("navigation", { name: "Passwords" }).getByText("Shared vaults").click();
    await web.getByTestId("invitation").getByRole("button", { name: "Accept" }).click();
    await expect(web.getByTestId("shared-vault").filter({ hasText: "Family" })).toBeVisible();
    await web.close();

    await expect
      .poll(async () => {
        await bg(rig, `await chrome.runtime.sendMessage({ t: "sync" });`);
        return (await items()).some((i) => i.title === "Shared login");
      }, { timeout: 60_000, intervals: [2000] })
      .toBe(true);
    const it = await itemNamed("Shared login");

    await writeClipboard(rig, "sentinel");
    const page = await rig.ctx.newPage();
    await page.goto("http://shared.localhost:8111/login.html");
    const pop = await popupFor(rig, page);
    await expect(pop.getByRole("button", { name: "Fill Shared login" })).toBeVisible();
    await expect(pop.getByRole("button", { name: /2FA code for Shared login/ })).toHaveCount(0);
    expect((await pop.evaluate(async (id) => chrome.runtime.sendMessage({ t: "totp", id }), it.id)).r).toBeNull();
    await pop.getByRole("button", { name: "Fill Shared login" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("Sh4red-Pass!");
    await pop.close().catch(() => undefined);

    // Past sign-in with no code box: an owner would get the code copied. This member doesn't.
    await page.click("#go");
    await page.waitForURL(/welcome/);
    await page.waitForTimeout(2500);
    expect(await readClipboard(rig)).toBe("sentinel");
    await page.close();
    await ctx.close();
  } finally {
    await browser.close();
  }
});

// ---- Generated passwords ----------------------------------------------------------------

test("a generated sign-up is one login: the save offer finishes it, and the tag goes", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://signup.localhost:8111/signup.html");
  const f = await openMenu(page, "#p1");
  await f.getByRole("button", { name: "Generate a password" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().p1), { timeout: 10_000 }).not.toBe("");
  const state = await page.evaluate(() => (window as any).__state());
  expect(state.p1).toBe(state.p2);
  let mine = await forHost("signup.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].password).toBe(state.p1);
  expect(mine[0].tags).toContain("unconfirmed sign-up");
  expect(mine[0].username).toBeUndefined();

  await page.fill("#email", "new-person@example.com");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  const save = saveFrame(page)!;
  await expect(save.getByText("new-person@example.com")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await forHost("signup.localhost"))[0].username).toBe("new-person@example.com");
  mine = await forHost("signup.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].tags).not.toContain("unconfirmed sign-up");
  expect(mine[0].password).toBe(state.p1);
  // The bar takes itself away, and leaves nothing over the page.
  await expect.poll(() => !!saveFrame(page)).toBe(false);
  await page.close();
});

test("a failed sign-up keeps the password, isn't offered, and trying again reuses the same login", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://failsignup.localhost:8111/signup-fail.html");
  let f = await openMenu(page, "#p1");
  await f.getByRole("button", { name: "Generate a password" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().p1), { timeout: 10_000 }).not.toBe("");
  const first = await page.evaluate(() => (window as any).__state().p1);
  await page.fill("#email", "typo@example.com");
  await page.click("#go");
  await page.waitForTimeout(2600);
  expect(saveFrame(page)).toBeUndefined();
  let mine = await forHost("failsignup.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].password).toBe(first);
  expect(mine[0].tags).toContain("unconfirmed sign-up");

  await page.click("h1");
  f = await openMenu(page, "#p2");
  await f.getByRole("button", { name: "Generate a password" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().p2), { timeout: 10_000 }).not.toBe(first);
  mine = await forHost("failsignup.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].password).not.toBe(first);
  expect(mine[0].history).toBe(1);
  await page.close();
});

test("on a change form, a generated password waits on the existing login, and an update commits it", async () => {
  const before = await saved({ title: "Changing", url: "http://change.localhost:8111", username: "ana", password: "Old-Pass-1!" });
  const page = await rig.ctx.newPage();
  await page.goto("http://change.localhost:8111/change-ok.html");
  const f = await openMenu(page, "#next");
  await f.getByRole("button", { name: "Generate a password" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().next), { timeout: 10_000 }).not.toBe("");
  const s = await page.evaluate(() => (window as any).__state());
  expect(s.next).toBe(s.again);

  // Still the old password until the site says yes, and no second login.
  let mine = await forHost("change.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].id).toBe(before.id);
  expect(mine[0].password).toBe("Old-Pass-1!");
  expect(mine[0].pendingPassword).toBe(s.next);

  await page.fill("#current", "Old-Pass-1!");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  const save = saveFrame(page)!;
  await expect(save.getByText("Update your password for change.localhost?")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await save.getByRole("button", { name: "Update" }).click();
  await expect.poll(async () => (await forHost("change.localhost"))[0].password).toBe(s.next);
  mine = await forHost("change.localhost");
  expect(mine).toHaveLength(1);
  expect(mine[0].pendingPassword).toBeUndefined();
  expect(mine[0].history).toBe(1);
  await page.close();
});

test("on a change form with several logins, the menu asks which account the new password is for", async () => {
  const a = await saved({ title: "First account", url: "http://two.localhost:8111", username: "first@example.com", password: "First-1" });
  const b = await saved({ title: "Second account", url: "http://two.localhost:8111", username: "second@example.com", password: "Second-1" });
  const page = await rig.ctx.newPage();
  await page.goto("http://two.localhost:8111/change-ok.html");
  const f = await openMenu(page, "#next");
  await f.getByRole("button", { name: /New password for second@example.com/ }).click();
  await expect.poll(async () => (await items()).find((i) => i.id === b.id)!.pendingPassword).toBeTruthy();
  expect((await items()).find((i) => i.id === a.id)!.pendingPassword).toBeUndefined();
  await page.close();
});

// ---- Flow across pages (plan 6.3) ----------------------------------------------------------

test("the 2FA code isn't copied at the email step, or when the next page has a box for it", async () => {
  const it = await saved({ title: "Steps", url: "http://steps.localhost:8111", username: "s@example.com", password: "Steps-Pw-1" });
  await patch(it.id, { totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
  await writeClipboard(rig, "sentinel");
  const page = await rig.ctx.newPage();
  await page.goto("http://steps.localhost:8111/multistep.html");
  const fill = async () => {
    const pop = await popupFor(rig, page);
    await pop.getByRole("button", { name: "Fill Steps" }).click();
    await pop.close().catch(() => undefined);
  };
  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().user)).toBe("s@example.com");
  await page.click("#next");
  await page.waitForSelector("#pass");
  await page.waitForTimeout(1800);
  expect(await readClipboard(rig)).toBe("sentinel");

  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("Steps-Pw-1");
  await page.click("#next2");
  await page.waitForSelector("#code");
  await page.waitForTimeout(1800);
  expect(await readClipboard(rig)).toBe("sentinel");

  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().code)).toMatch(/^\d{6}$/);
  await page.close();
});

test("the 2FA code is copied once the next page has no box, with a notice, and clears", async () => {
  await setSettings({ clipboardSeconds: 5 });
  const it = await saved({ title: "Copier", url: "http://copier.localhost:8111", username: "c@example.com", password: "Copier-Pw-1" });
  await patch(it.id, { totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
  await writeClipboard(rig, "sentinel");
  const page = await rig.ctx.newPage();
  await page.goto("http://copier.localhost:8111/login.html");
  const f = await openMenu(page, "#user");
  await f.getByRole("button", { name: "Fill Copier" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("Copier-Pw-1");
  await page.waitForTimeout(1800);
  expect(await readClipboard(rig)).toBe("sentinel");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => readClipboard(rig), { timeout: 15_000, intervals: [500] }).toMatch(/^\d{6}$/);
  await expect.poll(async () => (await testHook<{ notices: string[] }>(rig, "log")).notices.at(-1)).toContain("2FA code copied");
  // Cleared on time.
  await expect.poll(() => readClipboard(rig), { timeout: 15_000, intervals: [1000] }).toBe("");
  await page.close();
  await setSettings({ clipboardSeconds: 30 });
});

test("a failed login that comes back with the form copies nothing", async () => {
  const it = await saved({ title: "Refused", url: "http://refused.localhost:8111", username: "r@example.com", password: "Refused-Pw-1" });
  await patch(it.id, { totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
  await writeClipboard(rig, "sentinel");
  const page = await rig.ctx.newPage();
  await page.goto("http://refused.localhost:8111/reload-fail.html");
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Refused" }).click();
  await expect.poll(() => page.evaluate(() => (document.getElementById("pass") as HTMLInputElement).value)).toBe("Refused-Pw-1");
  await pop.close().catch(() => undefined);
  await page.click("#go");
  await page.waitForURL(/tried/);
  await page.waitForTimeout(2200);
  expect(await readClipboard(rig)).toBe("sentinel");
  await page.close();
});

test("picking another item doesn't bring the first back, and the popup puts the flow's item first", async () => {
  await saved({ title: "Alpha pick", url: "http://flow.localhost:8111", username: "a", password: "Alpha-1" });
  const beta = await saved({ title: "Zeta pick", url: "http://flow.localhost:8111", username: "z", password: "Zeta-1" });
  const page = await rig.ctx.newPage();
  await page.goto("http://flow.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Alpha pick" }).click();
  await pop.close().catch(() => undefined);
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("Alpha-1");
  await page.bringToFront();
  const f = await openMenu(page, "#user");
  await f.getByRole("button", { name: "Fill Zeta pick" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("Zeta-1");
  const tabId = await tabIdOf(rig, page);
  const flow = await bg<{ itemId: string }>(rig, `return (await chrome.storage.session.get("flows")).flows[arg];`, String(tabId));
  expect(flow.itemId).toBe(beta.id);
  const again = await popupFor(rig, page);
  const rows = again.getByRole("button", { name: /^Fill / });
  await expect(rows.first()).toHaveAttribute("aria-label", "Fill Zeta pick");
  await again.close();
  await page.close();
});

// ---- New devices (plan 3.4) ----------------------------------------------------------------

test("a new device's request reaches the badge and the top of the popup on the sync alarm", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://nomatch.localhost:8111/login.html");
  const made = await fetch(`${BASE}/api/passwords/device-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.access}` },
    body: JSON.stringify({ name: "A new phone", platform: "android", device_pub: Buffer.from(crypto.randomBytes(32)).toString("base64url") }),
  });
  expect(made.status).toBe(201);
  const tabId = await tabIdOf(rig, page);
  // The real alarm fires once a minute. Nothing here pokes it.
  await expect
    .poll(() => bg<string>(rig, `return chrome.action.getBadgeText({ tabId: arg });`, tabId), { timeout: 90_000, intervals: [2000] })
    .toBe("!");
  const pop = await popupFor(rig, page);
  const row = pop.getByTestId("device-request");
  await expect(row).toContainText("new device");
  const opened = rig.ctx.waitForEvent("page");
  await row.click();
  const v = await opened;
  await v.waitForLoadState();
  expect(v.url()).toContain("vault.html#/devices");
  await expect(v.getByText("A new phone")).toBeVisible({ timeout: 30_000 });
  await v.close();
  await pop.close();
  await page.close();
});

// ---- Clipboard (plan 4) --------------------------------------------------------------------

test("clipboard: a popup copy clears with the popup closed, and never touches something newer when it can tell", async () => {
  await setSettings({ clipboardSeconds: 5 });
  const page = await rig.ctx.newPage();
  await page.goto("http://nomatch.localhost:8111/login.html");
  const copyFromPopup = async () => {
    const pop = await popupFor(rig, page);
    await pop.bringToFront();
    await pop.getByRole("button", { name: "Generator" }).click();
    await expect(pop.getByTestId("generated")).not.toBeEmpty();
    const value = (await pop.getByTestId("generated").textContent())!;
    await pop.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(pop.getByRole("status")).toHaveText("Copied.");
    await pop.close();
    return value;
  };

  const value = await copyFromPopup();
  expect(await readClipboard(rig)).toBe(value);
  await expect.poll(() => readClipboard(rig), { timeout: 15_000, intervals: [1000] }).toBe("");

  // Something else went on the clipboard since, and we have the permission to see that.
  await copyFromPopup();
  await writeClipboard(rig, "something of mine");
  await page.waitForTimeout(6500);
  expect(await readClipboard(rig)).toBe("something of mine");

  // Without the permission there's no telling, so it's cleared.
  await testHook(rig, "noClipRead", { on: true });
  await copyFromPopup();
  await writeClipboard(rig, "can't be told apart");
  await expect.poll(() => readClipboard(rig), { timeout: 15_000, intervals: [1000] }).toBe("");
  await testHook(rig, "noClipRead", { on: false });
  await page.close();
  await setSettings({ clipboardSeconds: 30 });
});

test("clipboard: the alarm still clears it after the worker's been killed", async () => {
  await setSettings({ clipboardSeconds: 5 });
  const page = await rig.ctx.newPage();
  await page.goto("http://nomatch.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await pop.bringToFront();
  await pop.getByRole("button", { name: "Generator" }).click();
  await expect(pop.getByTestId("generated")).not.toBeEmpty();
  const value = (await pop.getByTestId("generated").textContent())!;
  await pop.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(pop.getByRole("status")).toHaveText("Copied.");
  await pop.close();
  const cdp = await rig.ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  expect(await readClipboard(rig)).toBe(value);
  // The timer died with the worker. The alarm has a 30 second floor.
  await expect.poll(() => readClipboard(rig), { timeout: 45_000, intervals: [2000] }).toBe("");
  await page.close();
  await setSettings({ clipboardSeconds: 30 });
});

// ---- Generator -------------------------------------------------------------------------------

test("plus-addressing in the popup generator", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://shop.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Generator" }).click();
  const box = pop.getByLabel("An email address for this site");
  await box.fill("ana+old@example.com");
  await expect(pop.getByTestId("plus-address")).toHaveText("ana+shop@example.com");
  await box.fill("not an address");
  await expect(pop.getByTestId("plus-address")).toHaveCount(0);
  await pop.close();
  await page.close();
});

// ---- Route changes (plan 6.1) ------------------------------------------------------------------

test("route changes are noticed with no field added, and a route storm stays inside the budget", async () => {
  const reportOf = async (page: Page) => testHook<{ report: { roles: string[] } | null; count: number }>(rig, "reports", { tabId: await tabIdOf(rig, page) });
  for (const how of ["push", "hash"]) {
    const page = await rig.ctx.newPage();
    await page.goto(siteA("spa-routes.html"));
    await page.waitForTimeout(600);
    expect((await reportOf(page)).report?.roles ?? []).not.toContain("password");
    await page.evaluate((h) => (window as any).__toSignIn(h), how);
    await expect.poll(async () => (await reportOf(page)).report?.roles ?? [], { timeout: 8000 }).toContain("password");
    await page.close();
  }

  const page = await rig.ctx.newPage();
  await page.goto(siteA("spa-routes.html"));
  await page.waitForTimeout(500);
  const before = (await reportOf(page)).count;
  await page.evaluate(() => (window as any).__storm());
  await page.waitForTimeout(4600);
  const added = (await reportOf(page)).count - before;
  // 180 route changes in 4.5 s. The budget is one look per 250 ms at most.
  expect(added).toBeGreaterThan(1);
  expect(added).toBeLessThanOrEqual(21);
  await page.close();
});

// ---- Saving with no submit event (plan 6.4) ---------------------------------------------------

async function typeLogin(page: Page, user: string, pass: string) {
  await page.locator("#user").pressSequentially(user);
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially(pass);
  await page.keyboard.press("Escape");
}

test("username on one page and password on the next survives the navigation", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://twostep.localhost:8111/step-user.html");
  await page.locator("#user").pressSequentially("split@example.com");
  await page.keyboard.press("Escape");
  await page.click("#next");
  await page.waitForURL(/step-pass/);
  await page.locator("#pass").pressSequentially("Split-Pw-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  const save = saveFrame(page)!;
  await expect(save.getByText("split@example.com")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await forHost("twostep.localhost"))[0]?.username).toBe("split@example.com");
  await page.close();
});

test("a username from one site is never paired with a password on another", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://first-site.localhost:8111/step-user.html");
  await page.locator("#user").pressSequentially("mine@example.com");
  await page.keyboard.press("Escape");
  await page.click("#next");
  await page.waitForURL(/step-pass/);
  await page.goto("http://other-site.localhost:8111/step-pass.html");
  await page.locator("#pass").pressSequentially("Other-Pw-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  await expect(saveFrame(page)!.getByText("Save this login")).toBeVisible();
  await expect(saveFrame(page)!.getByText("mine@example.com")).toHaveCount(0);
  await page.close();
});

test("a failed login that reloads the page isn't offered", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://reload.localhost:8111/reload-fail.html");
  await typeLogin(page, "typo@example.com", "wrong-password");
  await page.click("#go");
  await page.waitForURL(/tried/);
  await page.waitForTimeout(2500);
  expect(saveFrame(page)).toBeUndefined();
  // Nothing's left waiting for the next page either.
  const tabId = await tabIdOf(rig, page);
  const waiting = await bg<unknown[]>(rig, `return ((await chrome.storage.session.get("pendingSave")).pendingSave ?? []).filter((p) => p.tabId === arg);`, tabId);
  expect(waiting).toEqual([]);
  await page.close();
});

test("a page with no form and no submit event: a good request and a form that goes means a save offer", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://spaok.localhost:8111/spa-login.html?result=ok");
  await typeLogin(page, "spa@example.com", "Spa-Pw-1");
  await page.click("#go");
  await expect.poll(() => !!saveFrame(page), { timeout: 8000 }).toBe(true);
  await expect(saveFrame(page)!.getByText("spa@example.com")).toBeVisible();
  await page.close();
});

test("a 401 from the page's request means no offer, whatever the page looks like", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://spadenied.localhost:8111/spa-login.html?result=denied");
  await typeLogin(page, "spa@example.com", "Spa-Pw-1");
  await page.click("#go");
  await page.waitForTimeout(3000);
  expect(saveFrame(page)).toBeUndefined();
  await page.close();
});

test("a form that goes with no request behind it, like a closed dialog, isn't a sign-in", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://spaclose.localhost:8111/spa-login.html?result=no-request");
  await typeLogin(page, "spa@example.com", "Spa-Pw-1");
  await page.click("#go");
  await page.waitForTimeout(3000);
  expect(saveFrame(page)).toBeUndefined();
  await page.close();
});

test("a good request with the form still on screen is no signal", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://spakeep.localhost:8111/spa-login.html?result=ok-keeps-form");
  await typeLogin(page, "spa@example.com", "Spa-Pw-1");
  await page.click("#go");
  await page.waitForTimeout(3000);
  expect(saveFrame(page)).toBeUndefined();
  await page.close();
});

// ---- Rules pack (plan 6.5) ----------------------------------------------------------------------

function signedPack(pack: unknown, keyFile = path.join(EXTENSION, "rules", "test-key.jwk.json")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-pack-"));
  const packFile = path.join(dir, "pack.json");
  const sigFile = path.join(dir, "pack.sig");
  fs.writeFileSync(packFile, JSON.stringify(pack));
  execFileSync(process.execPath, [path.join(EXTENSION, "rules", "sign-pack.mjs"), "--key", keyFile, "--in", packFile, "--out", sigFile], { encoding: "utf8" });
  const out = { pack: fs.readFileSync(packFile).toString("base64url"), signature: fs.readFileSync(sigFile, "utf8") };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const packPage = async () => {
  const page = await rig.ctx.newPage();
  await page.route("**/odd.html", (r) => r.fulfill({ contentType: "text/html", body: `<title>Odd</title><p>A</p><input id="a1"><p>B</p><input id="b2">` }));
  await page.goto("http://packed.localhost:8111/odd.html");
  await page.waitForTimeout(300);
  return page;
};

test("the shipped pack is empty, and a signed pack's rules apply, beneath the person's own", async () => {
  expect(await testHook<{ rules: number }>(rig, "resetPack")).toEqual({ rules: 0 });
  await saved({ title: "Packed", url: "http://packed.localhost:8111", username: "pack@example.com", password: "Pack-Pw-1" });

  // With no rule, the classifier can't read this page at all.
  let page = await packPage();
  let pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Packed" }).click();
  await expect(pop.getByRole("status")).toContainText("No fields");
  await pop.close();
  await page.close();

  await testHook(rig, "loadPack", signedPack({ version: 2, rules: [{ host: "packed.localhost", username: "#a1", password: "#b2" }] }));
  page = await packPage();
  pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Packed" }).click();
  await expect.poll(() => page.evaluate(() => (document.getElementById("b2") as HTMLInputElement).value)).toBe("Pack-Pw-1");
  await pop.close().catch(() => undefined);
  await page.close();

  // Taught by the person, the other way round. Theirs wins.
  await testHook(rig, "saveRule", { rule: { host: "packed.localhost", username: "#b2", password: "#a1" } });
  page = await packPage();
  pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Packed" }).click();
  await expect.poll(() => page.evaluate(() => (document.getElementById("a1") as HTMLInputElement).value)).toBe("Pack-Pw-1");
  await pop.close().catch(() => undefined);
  await page.close();
});

test("a pack that's altered, wrongly signed, older, or carrying anything but rules is refused", async () => {
  const good = signedPack({ version: 9, rules: [] });
  const refused = async (args: { pack: string; signature: string }) => bg<{ ok: boolean; error?: string }>(rig, `return chrome.runtime.sendMessage({ t: "test", op: "loadPack", ...arg });`, args);

  const tampered = Buffer.from(JSON.stringify({ version: 9, rules: [{ host: "bank.example", never: true }] })).toString("base64url");
  expect((await refused({ pack: tampered, signature: good.signature })).error).toContain("signed");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-wrong-key-"));
  const other = path.join(dir, "other.jwk.json");
  execFileSync(process.execPath, [path.join(EXTENSION, "rules", "sign-pack.mjs"), "--new-key", other], { encoding: "utf8" });
  expect((await refused(signedPack({ version: 9, rules: [] }, other))).error).toContain("signed");
  fs.rmSync(dir, { recursive: true, force: true });

  // The last test loaded version 2.
  expect((await refused(signedPack({ version: 1, rules: [] }))).error).toContain("out of date");

  for (const rule of [{ host: "a.example", script: "alert(1)" }, { host: "a.example", username: { toString: "x" } }, { host: "NOT A HOST" }]) {
    expect((await refused(signedPack({ version: 9, rules: [rule] }))).error, JSON.stringify(rule)).toContain("malformed");
  }
  await testHook(rig, "resetPack");
});

test("a release build holds no test key, no test hooks and no way to take a pack without a real key", async () => {
  const dist = path.join(EXTENSION, "dist", "chrome");
  test.skip(!fs.existsSync(path.join(dist, "background.js")), "Needs a release build: node build.mjs all");
  const source = fs.readFileSync(path.join(EXTENSION, "src", "rules-key.ts"), "utf8");
  const testKey = /__TEST_BUILD__ \? "([^"]+)"/.exec(source)![1];
  const background = fs.readFileSync(path.join(dist, "background.js"), "utf8");
  expect(background).not.toContain(testKey);
  for (const hook of ["seedItems", "patchItem", "sleepGap", "pretendNoRead"]) expect(background, hook).not.toContain(hook);
  expect(fs.existsSync(path.join(dist, "rules", "test-key.jwk.json"))).toBe(false);
  // The pack is there, and no key beside it.
  expect(Array.isArray(JSON.parse(fs.readFileSync(path.join(dist, "rules", "pack.json"), "utf8")).rules)).toBe(true);
});

// ---- IntersectionObserver v2 (plan 6.6) -------------------------------------------------------------

test("a parent frame hiding a whole frame: style checks can't see it, and IntersectionObserver v2 can", async () => {
  await saved({ title: "Framed", url: "http://login.iosite.localhost:8111", username: "f@example.com", password: "Framed-Pw-1" });
  const src = encodeURIComponent("http://login.iosite.localhost:8111/login.html");
  const inner = (page: Page) => page.frames().find((f) => f !== page.mainFrame() && f.url().includes("login.iosite"))!;

  const strike = async (page: Page) => {
    await inner(page).click("#user");
    await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
    const m = menuFrame(page)!;
    await m.waitForLoadState();
    await page.waitForTimeout(LOOK_MS);
    await m.getByRole("button", { name: "Fill Framed" }).click({ force: true });
    await page.waitForTimeout(600);
    return { pass: await inner(page).evaluate(() => (document.getElementById("pass") as HTMLInputElement).value), menu: m };
  };

  // Plainly visible: filling from the menu in a frame works.
  const shown = await rig.ctx.newPage();
  await shown.goto(`http://top.iosite.localhost:8111/frames.html?src=${src}`);
  await shown.waitForTimeout(400);
  expect((await strike(shown)).pass).toBe("Framed-Pw-1");
  await shown.close();

  const hidden = await rig.ctx.newPage();
  await hidden.goto(`http://top.iosite.localhost:8111/frames.html?src=${src}`);
  await hidden.waitForTimeout(400);
  await hidden.evaluate(() => {
    document.getElementById("widget")!.style.opacity = "0.001";
  });
  const r = await strike(hidden);
  expect(r.pass).toBe("");
  await expect(r.menu.getByText("wasn't fully in view")).toBeVisible();
  await hidden.close();
});

// ---- Several frames --------------------------------------------------------------------------------

async function addCard() {
  const v = await vaultPage("#/all");
  await v.getByRole("button", { name: "New", exact: true }).click();
  await v.getByRole("menuitem", { name: "Card" }).click();
  await v.getByLabel("Name", { exact: true }).fill("Frame Visa");
  await v.getByLabel("Card number").fill("4111111111111111");
  await v.getByLabel("Name on card").fill("Ana Example").catch(() => undefined);
  await v.getByLabel("Security code").fill("123");
  await v.getByRole("button", { name: "Save" }).click();
  await expect(v.getByRole("article", { name: "Frame Visa" })).toBeVisible();
  await v.close();
  await bg(rig, `await chrome.runtime.sendMessage({ t: "sync" });`);
}

const boxIn = (page: Page, field: string) => page.frames().find((f) => f.url().includes(`card-frame.html?field=${field}`))!.evaluate(() => (window as any).__value());

test("a card in hosted frames: each frame gets its own box and nothing else, after naming their origin", async () => {
  await addCard();
  const page = await rig.ctx.newPage();
  await page.goto(`http://shop.localhost:8111/card-frames.html?at=${encodeURIComponent("http://payments.localhost:8112")}`);
  await page.waitForTimeout(500);
  const before = (await testHook<{ doFills: unknown[] }>(rig, "log")).doFills.length;
  const pop = await popupFor(rig, page);
  await pop.getByRole("textbox", { name: "Search your vault" }).fill("Frame Visa");
  await pop.getByRole("button", { name: "Fill Frame Visa" }).click();
  const ask = pop.getByRole("alertdialog");
  await expect(ask).toContainText("http://payments.localhost:8112");
  expect(await boxIn(page, "number")).toBe("");
  await pop.getByRole("button", { name: "Don't fill" }).click();
  expect(await boxIn(page, "number")).toBe("");

  await pop.getByRole("button", { name: "Fill Frame Visa" }).click();
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => boxIn(page, "number")).toBe("4111111111111111");
  expect(await boxIn(page, "cvc")).toBe("123");
  await pop.close().catch(() => undefined);

  const log = (await testHook<{ doFills: { url: string; keys: string[] }[] }>(rig, "log")).doFills.slice(before);
  const cvc = log.find((x) => x.url.includes("field=cvc"))!;
  const number = log.find((x) => x.url.includes("field=number"))!;
  expect(cvc.keys).toEqual(["card-cvv"]);
  expect(number.keys).toEqual(["card-number"]);
  await page.close();
});

test("a card in frames on the page's own origin asks only the usual question", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://shop.localhost:8111/card-frames.html");
  await page.waitForTimeout(500);
  const pop = await popupFor(rig, page);
  await pop.getByRole("textbox", { name: "Search your vault" }).fill("Frame Visa");
  await pop.getByRole("button", { name: "Fill Frame Visa" }).click();
  const ask = pop.getByRole("alertdialog");
  await expect(ask).toContainText("Fill your card");
  await expect(ask).not.toContainText("frames from");
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => boxIn(page, "cvc")).toBe("123");
  await pop.close().catch(() => undefined);
  await page.close();
});

test("a hosted frame its parent has hidden gets nothing, where the browser can tell", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`http://shop.localhost:8111/card-frames.html?hide=cvc&at=${encodeURIComponent("http://payments.localhost:8112")}`);
  await page.waitForTimeout(500);
  // In a window of its own, so the page stays on screen as it would under a real popup.
  const tabId = await tabIdOf(rig, page);
  await bg(rig, `await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?tab=" + arg), type: "popup", width: 400, height: 600 });`, tabId);
  await expect.poll(() => rig.ctx.pages().some((x) => x.url().includes("popup.html?tab="))).toBe(true);
  const pop = rig.ctx.pages().find((x) => x.url().includes("popup.html?tab="))!;
  await pop.getByRole("textbox", { name: "Search your vault" }).fill("Frame Visa");
  await pop.getByRole("button", { name: "Fill Frame Visa" }).click();
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => boxIn(page, "number")).toBe("4111111111111111");
  await page.waitForTimeout(600);
  expect(await boxIn(page, "cvc")).toBe("");
  await pop.close().catch(() => undefined);
  await page.close();
});

test("a login split across frames: the password goes to a frame on the item's exact host, and nowhere looser", async () => {
  await saved({ title: "Split", url: "http://split.localhost:8111", username: "split@example.com", password: "Split-Frame-1" });

  const run = async (frameUrl: string) => {
    const page = await rig.ctx.newPage();
    await page.goto(`http://split.localhost:8111/login-split.html?frame=${encodeURIComponent(frameUrl)}`);
    await page.waitForTimeout(500);
    const pop = await popupFor(rig, page);
    await pop.getByRole("button", { name: "Fill Split" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__state().user)).toBe("split@example.com");
    await pop.close().catch(() => undefined);
    // The frame goes second, after its own check that it can be seen.
    await page.waitForTimeout(1500);
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("password-frame.html"))!;
    const value = await frame.evaluate(() => (window as any).__value());
    await page.close();
    return value;
  };

  expect(await run("http://split.localhost:8111/password-frame.html")).toBe("Split-Frame-1");
  expect(await run("http://other.split.localhost:8111/password-frame.html"), "same site, another host").toBe("");
  expect(await run("http://elsewhere.localhost:8112/password-frame.html"), "another site").toBe("");
});

test("an inline pick fills the frame its menu is in, and no other", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`http://split.localhost:8111/login-split.html?frame=${encodeURIComponent("http://split.localhost:8111/password-frame.html")}`);
  await page.waitForTimeout(500);
  const f = await openMenu(page, "#user");
  await f.getByRole("button", { name: "Fill Split" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().user)).toBe("split@example.com");
  await page.waitForTimeout(1500);
  const frame = page.frames().find((x) => x !== page.mainFrame() && x.url().includes("password-frame.html"))!;
  expect(await frame.evaluate(() => (window as any).__value())).toBe("");
  await page.close();
});

// ---- Windows Hello from the popup -------------------------------------------------------------------

test("Windows Hello: only offered when the desktop app says it's on, and a real secret unlocks", async () => {
  const secret = await bg<string>(rig, `return (await chrome.storage.session.get("unlock")).unlock;`);
  await lockExt(rig);

  const popupWith = async (reply: string) => {
    const p = await rig.ctx.newPage();
    await p.addInitScript(`chrome.runtime.sendNativeMessage = async (host, m) => { window.__nativeHost = host; ${reply} };`);
    await p.goto(`chrome-extension://${rig.extId}/popup.html`);
    await expect(p.getByLabel("Master password")).toBeVisible();
    return p;
  };

  // No app at all: the browser's real answer.
  let p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(p.getByLabel("Master password")).toBeVisible();
  await p.waitForTimeout(500);
  await expect(p.getByRole("button", { name: "Use Windows Hello" })).toHaveCount(0);
  await p.close();

  // The app's there, and Hello isn't turned on for this browser.
  p = await popupWith(`return { ok: true, available: true, enabled: false };`);
  await p.waitForTimeout(500);
  await expect(p.getByRole("button", { name: "Use Windows Hello" })).toHaveCount(0);
  await p.close();

  // Turned on, and the person says no at the prompt.
  p = await popupWith(`return m.t === "status" ? { ok: true, available: true, enabled: true } : { ok: false, cancelled: true };`);
  await p.getByRole("button", { name: "Use Windows Hello" }).click();
  await p.waitForTimeout(300);
  await expect(p.getByLabel("Master password")).toBeVisible();
  await p.close();

  // A wrong secret from the app gets a message, and leaves it locked.
  p = await popupWith(`return m.t === "status" ? { ok: true, available: true, enabled: true } : { ok: true, secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };`);
  await p.getByRole("button", { name: "Use Windows Hello" }).click();
  await expect(p.locator(".err")).toBeVisible({ timeout: 30_000 });
  await expect(p.getByLabel("Master password")).toBeVisible();
  await p.close();

  p = await popupWith(`return m.t === "status" ? { ok: true, available: true, enabled: true } : { ok: true, secret: ${JSON.stringify(secret)} };`);
  await p.getByRole("button", { name: "Use Windows Hello" }).click();
  await expect(p.getByLabel("Search your vault")).toBeVisible({ timeout: 30_000 });
  expect(await p.evaluate(() => (window as any).__nativeHost)).toBe("org.promptly.passwords");
  await p.close();
});

// ---- While the shared copy is being re-read ---------------------------------------------------

test("a question asked while the background re-reads the vault still gets the whole answer", async () => {
  const want = (await items()).length;
  expect(want).toBeGreaterThan(5);
  const counts = await bg<number[]>(
    rig,
    `const out = [];
     for (let i = 0; i < 12; i++) {
       const sync = chrome.runtime.sendMessage({ t: "sync" });
       out.push((await chrome.runtime.sendMessage({ t: "list" })).r.length);
       await sync;
     }
     return out;`,
  );
  for (const n of counts) expect(n).toBeGreaterThanOrEqual(want);
});

// ---- Who may ask ------------------------------------------------------------------------------

test("a content script, and a page's menu frame, can't reach the new messages", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://nomatch.localhost:8111/login.html");
  const asks = [{ t: "generate" }, { t: "plusBase" }, { t: "clipWatch", text: "x" }, { t: "clipClear" }, { t: "activity" }, { t: "totp", id: "x" }, { t: "test", op: "items" }];
  const out = await bg<unknown[]>(
    rig,
    `const res = await chrome.scripting.executeScript({ target: { tabId: arg.tab }, world: "ISOLATED", args: [arg.asks], func: async (asks) => Promise.all(asks.map((m) => chrome.runtime.sendMessage(m).catch(() => "blocked"))) });
     return res[0].result;`,
    { tab: await tabIdOf(rig, page), asks },
  );
  for (const answer of out) expect(answer ?? null).toBeNull();

  const f = await openMenu(page, "#user");
  const fromMenu = await f.evaluate(async (list) => Promise.all(list.map((m) => chrome.runtime.sendMessage(m).catch(() => "blocked"))), asks);
  for (const answer of fromMenu) expect(answer ?? null).toBeNull();
  await page.close();
});

// ---- Size ---------------------------------------------------------------------------------------------

test("the popup bundle stays light, with no generator or site matching in it", async () => {
  const file = path.join(EXTENSION, "dist", "chrome", "popup.js");
  test.skip(!fs.existsSync(file), "Needs a release build: node build.mjs all");
  const js = fs.readFileSync(file, "utf8");
  expect(js.length).toBeLessThan(200_000);
  expect(js, "the word list").not.toContain("abacus");
  expect(js, "the Public Suffix List").not.toContain("amazonaws");
});

// ---- Steps that the page shows and focuses itself (D102) -----------------------------

test("the menu comes up on a password step that slides in and focuses itself, and on the box a page focused at load", async () => {
  await saved({ title: "Slide", url: "http://slide.localhost:8111", username: "slide@example.com", password: "Slide-Pw-1" });
  const page = await rig.ctx.newPage();
  await page.goto("http://slide.localhost:8111/slide-step.html");
  // The identifier was focused by the page before the extension was ready.
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator("#user").pressSequentially("slide@example.com");
  await page.keyboard.press("Escape");
  await page.click("#next");
  await page.waitForSelector("body[data-settled]");
  // No click: the page put the focus there itself, after the slide.
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  await page.waitForTimeout(LOOK_MS);
  await f.getByRole("button", { name: /Slide/ }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass), { timeout: 10_000 }).toBe("Slide-Pw-1");
  // The hidden carrier the page keeps for password managers is left as the page set it.
  expect(await page.evaluate(() => (document.getElementById("carrier") as HTMLInputElement).value)).toBe("slide@example.com");
  await page.close();
});

test("a press on a box that already has focus opens the menu", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://slide.localhost:8111/slide-step.html");
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => !!menuFrame(page)).toBe(false);
  // Still focused, so this click fires no focus event.
  await page.click("#user");
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  await page.close();
});
