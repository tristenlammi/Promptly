// The toolbar panel: setting up, its sections, copying, and bookmarks from anywhere.
// Pictures go to PW_PANEL_SHOTS if it's set, to look at by eye.
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { addItem, BASE, connect, launch, makeUsers, popupFor, type Rig, startSite, testHook, unlockExt } from "./lib";

let rig: Rig;
let site: { close: () => void };
const SITE = "http://panel.localhost:8111/login.html";

const shot = async (page: Page, name: string) => {
  const dir = process.env.PW_PANEL_SHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

async function panel(): Promise<Page> {
  const page = await rig.ctx.newPage();
  await page.goto(SITE);
  const pop = await popupFor(rig, page);
  await pop.setViewportSize({ width: 360, height: 580 });
  return pop;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  site = await startSite();
  rig = await launch();
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

test("before it's connected, the panel explains setup and brings the server's address from the page", async () => {
  const pop = await rig.ctx.newPage();
  await pop.setViewportSize({ width: 360, height: 420 });
  // Aim it as the toolbar would see a Promptly page in front.
  await pop.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(pop.getByRole("heading", { name: "Set up Promptly Passwords" })).toBeVisible();
  await expect(pop.getByText("Signing in on the website doesn't connect the extension")).toBeVisible();
  await expect(pop.getByTestId("setup-server")).toHaveCount(0);
  await pop.close();

  // In front of a Promptly page, it picks up the address and carries it to the form.
  const promptly = await rig.ctx.newPage();
  await promptly.goto(`${BASE}/passwords`);
  await promptly.waitForURL("**/login?next=*");
  const onPromptly = await popupFor(rig, promptly);
  await onPromptly.setViewportSize({ width: 360, height: 420 });
  await expect(onPromptly.getByTestId("setup-server")).toContainText(BASE);
  await shot(onPromptly, "1-setup");
  const opening = rig.ctx.waitForEvent("page");
  await onPromptly.getByRole("button", { name: "Set up" }).click();
  const carried = await opening;
  await expect(carried.getByLabel("Your server's address")).toHaveValue(BASE);
  await carried.close();
  await onPromptly.close();
  await promptly.close();

  // Any other site doesn't get to suggest itself.
  const other = await rig.ctx.newPage();
  await other.goto(SITE);
  const onOther = await popupFor(rig, other);
  await expect(onOther.getByRole("heading", { name: "Set up Promptly Passwords" })).toBeVisible();
  await expect(onOther.getByTestId("setup-server")).toHaveCount(0);
  await onOther.close();
  await other.close();

  const form = await rig.ctx.newPage();
  await form.goto(`chrome-extension://${rig.extId}/vault.html?server=${encodeURIComponent(BASE)}`);
  await expect(form.getByLabel("Your server's address")).toHaveValue(BASE);
  await expect(form.getByText("This came from the page you were on")).toBeVisible();
  await form.close();
});

test("the sections all open, with this site's logins first", async () => {
  const [user] = makeUsers(["panel"]);
  await connect(rig, user);
  await unlockExt(rig);
  await addItem(rig, { title: "Panel Site", url: "http://panel.localhost:8111", username: "ana@example.com", password: "panel-Pass-1" });
  await addItem(rig, { title: "Elsewhere", url: "https://elsewhere.example", username: "bob@example.com", password: "else-Pass-2" });
  await addItem(rig, { title: "Guarded", url: "https://guarded.example", username: "g@example.com", password: "guard-Pass-3" });
  const items = await testHook<{ id: string; title: string }[]>(rig, "items");
  const guarded = items.find((i) => i.title === "Guarded")!;
  await testHook(rig, "patchItem", { id: guarded.id, patch: { reprompt: true, favorite: true } });
  const panelItem = items.find((i) => i.title === "Panel Site")!;
  await testHook(rig, "patchItem", { id: panelItem.id, patch: { totp: { secret: "JBSWY3DPEHPK3PXP" } } });

  const pop = await panel();
  await expect(pop.getByRole("button", { name: "Fill Panel Site" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Fill Panel Site" })).toContainText("Fill");
  await expect(pop.getByRole("button", { name: "Fill Elsewhere" })).toHaveCount(0);
  await expect(pop.getByRole("button", { name: "Fill Guarded" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Show Logins" })).toContainText("3");
  await shot(pop, "2-vault");

  await pop.getByRole("button", { name: "Show Logins" }).click();
  await expect(pop.getByRole("button", { name: "Fill Elsewhere" })).toBeVisible();
  await pop.getByRole("button", { name: "Logins" }).click();

  await pop.getByRole("button", { name: "Codes", exact: true }).click();
  await expect(pop.getByRole("button", { name: "Copy 2FA code for Panel Site" })).toBeVisible();
  await expect(pop.getByRole("button", { name: /2FA code for Elsewhere/ })).toHaveCount(0);
  await shot(pop, "3-codes");

  await pop.getByRole("button", { name: "Generator" }).click();
  const made = pop.getByTestId("generated");
  await expect(made).not.toBeEmpty();
  const password = await made.innerText();
  await pop.getByRole("button", { name: "passphrase" }).click();
  await expect.poll(() => made.innerText()).toMatch(/^[a-z]+(-[a-z]+){4}/);
  await pop.getByRole("button", { name: "PIN" }).click();
  await expect.poll(() => made.innerText()).toMatch(/^\d{6}$/);
  await pop.getByRole("button", { name: "password", exact: true }).click();
  await expect.poll(() => made.innerText()).not.toBe(password);
  await shot(pop, "4-generator");

  await pop.getByRole("button", { name: "More", exact: true }).click();
  await expect(pop.getByRole("button", { name: "Security check" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Sync now" })).toBeVisible();
  await shot(pop, "5-more");
  const opened = rig.ctx.waitForEvent("page");
  await pop.getByRole("button", { name: "Security check" }).click();
  expect((await opened).url()).toContain("vault.html#/security");
});

test("describing a form says what was decided about each box, and holds no values", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(SITE);
  await page.fill("#user", "typed-user-value");
  await page.fill("#pass", "typed-secret-value");
  const pop = await popupFor(rig, page);
  await pop.setViewportSize({ width: 360, height: 580 });
  await pop.getByRole("button", { name: "Fill Panel Site" }).click();
  await page.waitForTimeout(300);
  const again = await popupFor(rig, page);
  await again.getByText("This page", { exact: true }).click();
  await again.getByRole("button", { name: "Describe this form for a bug report" }).click();
  const text = await again.getByLabel("Form description").inputValue();
  const parsed = JSON.parse(text);
  expect(parsed.decided.best).toBeTruthy();
  const box = parsed.decided.boxes.find((b: { type: string }) => b.type === "password");
  expect(box).toMatchObject({ visible: true, fillable: { ok: true }, clear: { ok: true }, role: "password" });
  expect(parsed.decided.last_fill.filled).toContain("password");
  for (const secret of ["typed-user-value", "typed-secret-value", "panel-Pass-1", "ana@example.com"]) expect(text).not.toContain(secret);
  await again.close();
  await pop.close();
  await page.close();
});

test("copying a password respects a reprompt, and searching finds it from any section", async () => {
  const pop = await panel();
  await pop.bringToFront();
  await pop.getByRole("button", { name: "Codes", exact: true }).click();
  await pop.getByLabel("Search your vault").fill("guarded");
  const row = pop.getByRole("button", { name: "Fill Guarded" });
  await expect(row).toBeVisible();
  await row.hover();
  await pop.getByRole("button", { name: "Copy password for Guarded" }).click();
  await expect(pop.getByText("This item asks for your master password.")).toBeVisible();
  // The background won't give it up on its own, whatever the popup does.
  const direct = await pop.evaluate(async (id) => (await chrome.runtime.sendMessage({ t: "secretField", id, field: "password" })).r, (await testHook<{ id: string; title: string }[]>(rig, "items")).find((i) => i.title === "Guarded")!.id);
  expect(direct).toEqual({ reason: "reprompt" });
});

test("bookmarks: the panel says how to turn it on, shows what's synced, and only opens web addresses", async () => {
  const pop = await panel();
  await pop.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(pop.getByTestId("bookmarks-off")).toBeVisible();
  const opened = rig.ctx.waitForEvent("page");
  await pop.getByRole("button", { name: "Turn on bookmark sync" }).click();
  const settings = await opened;
  await expect(settings.getByTestId("bookmark-settings")).toBeVisible({ timeout: 30_000 });
  // The shared page's logo is there in an extension, too.
  expect(await settings.locator('img[src*="passwords-192"]').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  // A real bookmark, synced, then found.
  const helper = await rig.ctx.newPage();
  await helper.goto(`chrome-extension://${rig.extId}/test.html`);
  const folder = await helper.evaluate(async () => (await chrome.bookmarks.create({ parentId: "1", title: "Reading" })).id);
  await helper.evaluate(async (parentId) => chrome.bookmarks.create({ parentId, title: "A good read", url: "https://read.example/article" }), folder);
  await settings.getByTestId("bookmark-settings").getByRole("checkbox", { name: /same in every browser/ }).click();
  await expect(settings.getByTestId("bookmark-status")).toContainText("2 bookmarks and folders", { timeout: 30_000 });
  await shot(settings, "7-bookmarks-page");

  // The vault page's own list.
  await expect(settings.getByTestId("bookmarks-screen").getByRole("button", { name: /Bookmarks bar/ })).toBeVisible();
  await settings.getByTestId("bookmarks-screen").getByLabel("Search bookmarks").fill("good read");
  const link = settings.getByRole("link", { name: /A good read/ });
  await expect(link).toHaveAttribute("href", "https://read.example/article");
  await expect(link).toHaveAttribute("rel", /noopener/);

  const again = await panel();
  await again.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await again.getByRole("button", { name: "Open folder Bookmarks bar" }).click();
  await again.getByRole("button", { name: "Open folder Reading" }).click();
  await expect(again.getByRole("button", { name: "Open bookmark A good read" })).toBeVisible();
  await shot(again, "6-bookmarks");
  await again.getByLabel("Search bookmarks").fill("nothing like this");
  await expect(again.getByText("No bookmarks match that.")).toBeVisible();
  await again.getByLabel("Search bookmarks").fill("good read");
  await expect(again.getByRole("button", { name: "Open bookmark A good read" })).toBeVisible();

  // Asking for something that isn't a bookmark, or an item with a bad address, opens nothing.
  const items = await testHook<{ id: string; title: string }[]>(rig, "items");
  const login = items.find((i) => i.title === "Panel Site")!;
  const refused = await again.evaluate(async (id) => (await chrome.runtime.sendMessage({ t: "openBookmark", id })).r, login.id);
  expect(refused).toEqual({ ok: false });
  await helper.close();
});

test("bookmarks: with sync on the section is never blank, and says what's wrong if it failed", async () => {
  const helper = await rig.ctx.newPage();
  await helper.goto(`chrome-extension://${rig.extId}/test.html`);
  const pop = await panel();
  await pop.getByRole("button", { name: "Bookmarks", exact: true }).click();
  const status = pop.getByTestId("bookmarks-status");
  await expect(status).toContainText("Sync is on");
  await expect(status).toContainText("This browser has 1 bookmark");
  await expect(status.getByRole("button", { name: "Sync settings" })).toBeVisible();

  // A bookmark added here shows up with the button, without waiting for the alarm.
  await helper.evaluate(() => chrome.bookmarks.create({ parentId: "2", title: "Added just now", url: "https://justnow.example/" }));
  await status.getByRole("button", { name: "Sync now" }).click();
  await expect(status).toContainText("This browser has 2 bookmarks");
  await pop.getByLabel("Search bookmarks").fill("just now");
  await expect(pop.getByRole("button", { name: "Open bookmark Added just now" })).toBeVisible();
  await pop.close();

  // A sync that fails says so, in the panel.
  await testHook(rig, "bookmarkBreak", { error: "A made-up problem" });
  const broken = await panel();
  await broken.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(broken.getByTestId("bookmarks-status")).toContainText("Bookmarks didn't sync: A made-up problem");
  await testHook(rig, "bookmarkBreak", { error: null });
  await broken.getByTestId("bookmarks-status").getByRole("button", { name: "Sync now" }).click();
  await expect(broken.getByTestId("bookmarks-status")).toContainText("Last synced");
  await expect(broken.getByTestId("bookmarks-status")).not.toContainText("didn't sync");
  await broken.close();

  // With no bookmarks anywhere, on: there's a sentence and a way forward, not a blank panel.
  const items = await testHook<{ id: string; title: string; url?: string }[]>(rig, "bookmarkItems");
  await helper.evaluate(async () => {
    const [top] = await chrome.bookmarks.getTree();
    for (const root of top.children ?? []) for (const c of root.children ?? []) await chrome.bookmarks.removeTree(c.id);
  });
  expect(items.length).toBeGreaterThan(0);
  await testHook(rig, "bookmarkRun");
  // All of them gone at once stops and asks, in the panel too, and a yes goes ahead.
  const held = await panel();
  await held.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(held.getByTestId("bookmarks-held")).toBeVisible();
  await held.close();
  await helper.evaluate(() => chrome.runtime.sendMessage({ t: "bookmarkAnswer", go: true }));
  await testHook(rig, "bookmarkRun");
  const empty = await panel();
  await empty.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(empty.getByText("No bookmarks yet.")).toBeVisible({ timeout: 30_000 });
  await expect(empty.getByTestId("bookmarks-status")).toContainText("This browser has 0 bookmarks");
  await shot(empty, "8-bookmarks-empty");
  await empty.close();
  await helper.close();
});

test("the web vault has the screen too, and says the extension's where it's turned on", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`${BASE}/passwords`);
  const master = page.getByLabel("Master password");
  await master.fill("correct horse battery staple 7!");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("navigation", { name: "Passwords" }).getByText("Bookmarks", { exact: true }).click();
  await expect(page.getByTestId("bookmarks-get-extension")).toBeVisible();
  await expect(page.getByText("No bookmarks yet.")).toBeVisible();
  await page.close();
});
