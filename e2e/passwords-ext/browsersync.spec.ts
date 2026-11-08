// Browser sync on real Chrome (passwords/SYNC.md): two throwaway profiles on one account share
// their open tabs, a tab sent from one arrives in the other, history stays off until it's turned
// on and keeps excluded sites out, and the reading list goes both ways. Runs are forced through
// the panel's own "bs:syncNow" message so nothing waits a minute for an alarm.
//   cd e2e && npx playwright test --config passwords-ext.config.ts passwords-ext/browsersync.spec.ts
import { expect, type Page, test } from "@playwright/test";

import { BASE, bg, connect, launch, makeUsers, MASTER, PORT_A, popupFor, type Rig, signIn, startSite, unlockExt } from "./lib";

let a: Rig;
let b: Rig;
let site: { close: () => void };
let user: ReturnType<typeof makeUsers>[number];

/** Joining a browser that isn't the first: connect, the kit, the master password. */
async function join(rig: Rig, secret: string) {
  await signIn(rig, user);
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html`);
  await page.getByLabel("Your server's address").fill(BASE);
  const approve = rig.ctx.waitForEvent("page");
  await page.getByRole("button", { name: "Connect" }).click();
  const tab = await approve;
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tab.getByText("Connected.")).toBeVisible();
  await tab.close();
  await page.getByRole("button", { name: "Use my recovery kit" }).click();
  await page.getByLabel("Secret Key").fill(secret);
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Your vault is locked")).toBeVisible({ timeout: 60_000 });
  await page.close();
  await unlockExt(rig);
}

/** A message to the background from one of the extension's own pages, as the panel sends it. */
const ask = <T>(rig: Rig, m: Record<string, unknown>) =>
  bg<T>(rig, `const r = await chrome.runtime.sendMessage(arg); if (!r?.ok) throw new Error(r?.error ?? "no answer"); return r.r;`, m);
const syncNow = (rig: Rig) => ask(rig, { t: "bs:syncNow" });

/** The real box on the real Settings page. */
async function setBox(rig: Rig, testId: string, on: boolean) {
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html#/settings`);
  const box = page.getByTestId(testId);
  await expect(box).toBeVisible({ timeout: 60_000 });
  if ((await box.isChecked()) !== on) await box.click();
  await expect(box).toBeChecked({ checked: on });
  return page;
}

async function openSite(rig: Rig, path: string): Promise<Page> {
  const p = await rig.ctx.newPage();
  await p.goto(`http://localhost:${PORT_A}/${path}`);
  return p;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  site = await startSite();
  [user] = makeUsers(["browsersync"]);
  a = await launch();
  const secret = await connect(a, user);
  await unlockExt(a);
  b = await launch();
  await join(b, secret);
});

test.afterAll(async () => {
  await b?.close();
  await a?.close();
  site?.close();
});

test("two browsers share their open tabs, with internal pages left out, and it shows how fresh", async () => {
  for (const rig of [a, b]) await (await setBox(rig, "bs-tabs", true)).close();
  const pageA = await openSite(a, "login.html?bs=tabs-a");
  // An extension page and a browser page are open too, and must never be shared.
  const own = await a.ctx.newPage();
  await own.goto(`chrome-extension://${a.extId}/vault.html#/settings`);
  await syncNow(a);
  await syncNow(b);

  const seen = await ask<{ devices: { label: string; at: number; windows: { tabs: { url: string; title: string }[] }[] }[] }>(b, { t: "bs:tabs" });
  expect(seen.devices).toHaveLength(1);
  const urls = seen.devices[0].windows.flatMap((w) => w.tabs.map((t) => t.url));
  expect(urls).toContain(pageA.url());
  expect(urls.some((u) => !/^https?:/.test(u))).toBe(false);
  expect(Date.now() - seen.devices[0].at).toBeLessThan(5 * 60_000);

  // In the panel: Browse, Tabs, the device with "just now", and opening one here.
  const pop = await b.ctx.newPage();
  await pop.goto(`chrome-extension://${b.extId}/popup.html`);
  await pop.getByRole("button", { name: "Browse", exact: true }).click();
  await pop.getByTestId("browse-tabs").click();
  const device = pop.getByTestId("device-tabs");
  await expect(device).toContainText("just now");
  await expect(device.getByRole("button", { name: "Open Sign in to Acme" })).toBeVisible();
  // Search finds it across devices.
  await pop.getByLabel("Search bookmarks").fill("acme");
  await expect(pop.getByRole("button", { name: "Open Sign in to Acme" })).toBeVisible();
  await pop.close();

  // A closed tab goes from the other browser's list after the next publish.
  await pageA.close();
  await bg(a, "await chrome.tabs.query({});");
  await new Promise((r) => setTimeout(r, 6000));
  await syncNow(a);
  const after = await ask<{ devices: { windows: { tabs: { url: string }[] }[] }[] }>(b, { t: "bs:tabs" });
  expect(after.devices.flatMap((d) => d.windows.flatMap((w) => w.tabs.map((t) => t.url)))).not.toContain(pageA.url());
  await own.close();

  // Turning it off takes this browser off the others' lists.
  await (await setBox(a, "bs-tabs", false)).close();
  expect((await ask<{ devices: unknown[] }>(b, { t: "bs:tabs" })).devices).toHaveLength(0);
});

test("a tab sent from one browser's panel arrives in the other", async () => {
  const page = await openSite(a, "card.html?bs=sent-from-a");
  const pop = await popupFor(a, page);
  await pop.getByRole("button", { name: "Browse", exact: true }).click();
  await pop.getByTestId("send-tab").click();
  const targets = pop.getByTestId("send-targets");
  await expect(targets.getByRole("button").first()).toBeVisible();
  // Only the other browser: never itself.
  await expect(targets.getByRole("button")).toHaveCount(1);
  await targets.getByRole("button").first().click();
  await expect(pop.getByRole("status")).toContainText("Sent to");
  await pop.close();

  await syncNow(b);
  await expect
    .poll(async () => (await bg<string[]>(b, "return (await chrome.tabs.query({})).map((t) => t.url ?? '');")).filter((u) => u.includes("bs=sent-from-a")).length, { timeout: 30_000 })
    .toBe(1);
  // Once: a second run doesn't open it again.
  await syncNow(b);
  expect((await bg<string[]>(b, "return (await chrome.tabs.query({})).map((t) => t.url ?? '');")).filter((u) => u.includes("bs=sent-from-a"))).toHaveLength(1);
  await page.close();

  // Only web pages can be sent.
  await expect(ask(a, { t: "bs:send", target: "00000000-0000-4000-8000-000000000000", url: "javascript:alert(1)", title: "x" })).rejects.toThrow(/web pages/);
});

test("history stays off until it's turned on, keeps excluded sites out, and can be deleted", async () => {
  const before = await openSite(a, "login.html?bs=history-before");
  await syncNow(a);
  const none = await ask<{ rows: { url: string }[] }>(b, { t: "bs:history", query: "", all: true });
  expect(none.rows.map((r) => r.url).filter((u) => u.includes("bs=history"))).toEqual([]);
  // Nothing at all reached the server.
  const status = await ask<{ settings: { history: boolean } }>(a, { t: "bs:state" });
  expect(status.settings.history).toBe(false);
  await before.close();

  const settings = await setBox(a, "bs-history", true);
  await expect(settings.getByText(/Off unless you turn it on/)).toBeVisible();
  await settings.getByTestId("bs-excludes").fill("127.0.0.1");
  await settings.getByRole("button", { name: "Save sites" }).click();
  await expect(settings.getByRole("status")).toContainText("Saved");
  await settings.close();

  const kept = await openSite(a, "login.html?bs=history-after");
  const excluded = await a.ctx.newPage();
  await excluded.goto(`http://127.0.0.1:${PORT_A}/card.html?bs=history-excluded`);
  await syncNow(a);
  await expect
    .poll(async () => (await ask<{ rows: { url: string }[] }>(b, { t: "bs:history", query: "", all: true })).rows.map((r) => r.url).filter((u) => u.includes("bs=history")), { timeout: 30_000 })
    .toEqual([kept.url()]);

  // The panel finds it by search, and names the browser it came from.
  const pop = await b.ctx.newPage();
  await pop.goto(`chrome-extension://${b.extId}/popup.html`);
  await pop.getByRole("button", { name: "Browse", exact: true }).click();
  await pop.getByTestId("browse-history").click();
  await pop.getByLabel("Search bookmarks").fill("history-after");
  await expect(pop.getByTestId("synced-history").getByRole("button", { name: "Open Sign in to Acme" })).toBeVisible();
  await pop.close();

  // "Delete all synced history" on the Tabs and history screen, everywhere.
  const screen = await b.ctx.newPage();
  await screen.goto(`chrome-extension://${b.extId}/vault.html#/browser-sync`);
  await screen.getByTestId("delete-history").click();
  await screen.getByTestId("confirm-delete-history").click();
  await expect(screen.getByTestId("synced-history")).toContainText("No synced history");
  await screen.close();
  expect((await ask<{ rows: unknown[] }>(a, { t: "bs:history", query: "", all: true })).rows).toEqual([]);
  await kept.close();
  await excluded.close();
  await (await setBox(a, "bs-history", false)).close();
});

test("the reading list goes both ways, with read and unread", async () => {
  const page = await openSite(a, "login.html?bs=reading");
  const pop = await popupFor(a, page);
  await pop.getByRole("button", { name: "Browse", exact: true }).click();
  await pop.getByTestId("save-for-later").click();
  await expect(pop.getByRole("status")).toContainText("Saved for later");
  await pop.close();

  const popB = await b.ctx.newPage();
  await popB.goto(`chrome-extension://${b.extId}/popup.html`);
  await popB.getByRole("button", { name: "Browse", exact: true }).click();
  await popB.getByTestId("browse-reading").click();
  const entry = popB.getByTestId("reading-entry");
  await expect(entry).toHaveCount(1);
  await entry.getByRole("button", { name: "Mark read" }).click();
  await expect(entry.getByRole("button", { name: "Mark unread" })).toBeVisible();
  await popB.close();

  const list = await ask<{ entries: { url: string; read: boolean }[] }>(a, { t: "bs:reading" });
  expect(list.entries).toEqual([expect.objectContaining({ url: page.url(), read: true })]);

  // Chrome's own reading list, where the API is there: the first run adds.
  const hasApi = await bg<boolean>(a, "return !!chrome.readingList;");
  if (hasApi) {
    await (await setBox(a, "bs-reading", true)).close();
    await syncNow(a);
    const theirs = await bg<{ url: string; hasBeenRead: boolean }[]>(a, "return await chrome.readingList.query({});");
    expect(theirs).toEqual([expect.objectContaining({ url: page.url(), hasBeenRead: true })]);
    // Removed from Chrome's list: gone from ours, and so from the other browser, next run.
    await bg(a, "await chrome.readingList.removeEntry({ url: arg });", page.url());
    await syncNow(a);
    expect((await ask<{ entries: unknown[] }>(b, { t: "bs:reading" })).entries).toEqual([]);
  }
  await page.close();
});

test("a locked browser can't be asked for anyone's tabs", async () => {
  const pop = await a.ctx.newPage();
  await pop.goto(`chrome-extension://${a.extId}/popup.html`);
  await pop.getByRole("button", { name: "Lock" }).click();
  await pop.close();
  await expect(ask(a, { t: "bs:tabs" })).rejects.toThrow(/Unlock/);
  await unlockExt(a);
});
