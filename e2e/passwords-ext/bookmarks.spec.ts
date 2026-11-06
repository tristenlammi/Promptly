// Bookmark sync on real browsers against one account: Chrome, a second Chromium browser (Helium
// when it's installed, through PW_BM_SECOND), and Firefox. Each has a throwaway profile, so nobody's
// real bookmarks are near this. Runs are forced through a test hook so it doesn't wait for alarms.
//   cd e2e && npx playwright test --config passwords-ext.config.ts passwords-ext/bookmarks.spec.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";
import { By } from "selenium-webdriver";

import { BASE as FF_BASE, button, byText, click, fill, labelled, MASTER as FF_MASTER, newFirefox, see, signIn as ffSignIn } from "../passwords-firefox/lib.mjs";
import { BASE, connect, launch, makeUsers, MASTER, type Rig, signIn, testHook, unlockExt } from "./lib";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(path.resolve(here, "../../frontend/package.json"));
const { zipSync } = require_("fflate");

const SECOND_EXE = process.env.PW_BM_SECOND ?? "C:\\Users\\Tristen\\AppData\\Local\\imput\\Helium\\Application\\chrome.exe";
const CANARY = "BMCANARY7Q3XZ";
const FF_UUID = "11112222-3333-4444-5555-666677778899";
const FF_EXT = `moz-extension://${FF_UUID}`;
const FF_DIST = path.resolve(here, "../../passwords/extension/dist/firefox-test");

type Shape = { bar: unknown[]; other: unknown[]; menu: unknown[]; mobile: unknown[] };

let chrome_: Rig;
let second: Rig | null = null;
let driver: any;
let extTab: string;
let user: ReturnType<typeof makeUsers>[number];

/** A browser's tree, in the same terms everywhere. Only what's meant to sync. */
const NORMALISE = `
  const api = globalThis.browser?.bookmarks ?? chrome.bookmarks;
  const [top] = await api.getTree();
  const shape = (n) => (n.children ?? [])
    .filter((c) => c.type !== "separator" && (c.url === undefined || /^https?:/.test(c.url)))
    .map((c) => c.url !== undefined ? c.title + "=" + c.url : { [c.title]: shape(c) });
  const out = { bar: [], other: [], menu: [], mobile: [] };
  const byId = { toolbar_____: "bar", unfiled_____: "other", menu________: "menu", mobile______: "mobile", 1: "bar", 2: "other", 3: "mobile" };
  const byType = { "bookmarks-bar": "bar", other: "other", mobile: "mobile" };
  for (const r of top.children ?? []) {
    const k = r.folderType ? byType[r.folderType] : byId[r.id];
    if (k) out[k] = shape(r);
  }
  // Chromium keeps Firefox's menu in a folder.
  const at = out.other.findIndex((x) => typeof x === "object" && "Bookmarks menu" in x);
  if (at >= 0) { out.menu = out.other[at]["Bookmarks menu"]; out.other.splice(at, 1); }
  return out;
`;

async function rigEval<T>(rig: Rig, body: string, arg?: unknown): Promise<T> {
  const page = await rig.ctx.newPage();
  try {
    await page.goto(`chrome-extension://${rig.extId}/test.html`);
    return await page.evaluate(new Function("arg", `return (async () => { ${body} })()`) as (a: unknown) => Promise<T>, arg);
  } finally {
    await page.close();
  }
}

async function ffEval<T>(body: string, arg?: unknown): Promise<T> {
  await driver.switchTo().window(extTab);
  return driver.executeAsyncScript(`const done = arguments[arguments.length-1]; (async (arg) => { ${body} })(arguments[0]).then(done, (e) => done({ __error: String(e) }));`, arg ?? null);
}

const shapeOf = (rig: Rig) => rigEval<Shape>(rig, NORMALISE);
const ffShape = () => ffEval<Shape>(NORMALISE);
const runRig = (rig: Rig) => testHook<{ on: boolean; held?: unknown; error?: string; __error?: string }>(rig, "bookmarkRun");
const runFf = () => ffEval<any>(`const r = await browser.runtime.sendMessage({ t: "test", op: "bookmarkRun" }); if (!r?.ok) throw new Error(r?.error); return r.r;`);

/** Enough rounds for a change to go up from one browser and come down in the others. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    const states = [await runRig(chrome_), second ? await runRig(second) : null, driver ? await runFf() : null];
    for (const st of states) {
      expect(st?.__error).toBeUndefined();
      expect(st?.error).toBeUndefined();
    }
  }
}

const addIn = (rig: Rig, b: { parent?: string; title: string; url?: string }) => rigEval<string>(rig, `const made = await chrome.bookmarks.create({ parentId: arg.parent ?? "1", title: arg.title, url: arg.url }); return made.id;`, b);

async function allAgree(): Promise<Shape> {
  const first = await shapeOf(chrome_);
  if (second) expect(await shapeOf(second)).toEqual(first);
  if (driver) expect(await ffShape()).toEqual(first);
  return first;
}

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

async function joinFirefox(secret: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files[path.relative(FF_DIST, p).replace(/\\/g, "/")] = new Uint8Array(fs.readFileSync(p));
    }
  };
  walk(FF_DIST);
  const xpi = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pw-xpi-")), "ext.xpi");
  fs.writeFileSync(xpi, zipSync(files));
  driver = await newFirefox({
    prefs: {
      "extensions.webextensions.uuids": JSON.stringify({ "passwords@promptly.app": FF_UUID }),
      "extensions.webextOptionalPermissionPrompts": false,
      "xpinstall.signatures.required": false,
    },
  });
  await driver.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });
  await driver.manage().setTimeouts({ script: 120000 });
  await driver.installAddon(xpi, true);
  await ffSignIn(driver, user);
  for (const h of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(h);
    if ((await driver.getCurrentUrl()).startsWith("moz-extension://")) extTab = h;
  }
  await driver.switchTo().window(extTab);
  await fill(driver, labelled("Your server's address"), FF_BASE);
  await click(driver, button("Connect"));
  await driver.sleep(1500);
  for (const h of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(h);
    if ((await driver.getCurrentUrl()).includes("/passwords/connect")) break;
  }
  await click(driver, button("Connect"));
  await see(driver, byText("Connected."));
  await driver.close();
  await driver.switchTo().window(extTab);
  await click(driver, button("Use my recovery kit"));
  await fill(driver, labelled("Secret Key"), secret);
  await fill(driver, labelled("Master password"), FF_MASTER);
  await click(driver, button("Unlock"));
  await click(driver, button("On all sites (best filling)"), 60000);
  await see(driver, byText("Your vault is locked"), 60000);
  await fill(driver, labelled("Master password"), FF_MASTER);
  await click(driver, button("Unlock"));
  await see(driver, By.css('nav[aria-label="Passwords"]'), 60000);
}

/** The real box on the real settings page. */
async function turnOn(rig: Rig) {
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html#/settings`);
  const panel = page.getByTestId("bookmark-settings");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("checkbox", { name: /same in every browser/ }).click();
  await expect(panel.getByTestId("bookmark-status")).toBeVisible();
  await page.close();
}

async function turnOnFirefox() {
  await driver.switchTo().window(extTab);
  await driver.get(`${FF_EXT}/vault.html#/settings`);
  await see(driver, By.css('[data-testid="bookmark-settings"]'), 60000).catch(async () => {
    await fill(driver, labelled("Master password"), FF_MASTER);
    await click(driver, button("Unlock"));
    await see(driver, By.css('[data-testid="bookmark-settings"]'), 60000);
  });
  await click(driver, By.css('[data-testid="bookmark-settings"] input[type="checkbox"]'));
  await see(driver, By.css('[data-testid="bookmark-status"]'), 30000);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  [user] = makeUsers(["bookmarks"]);
  chrome_ = await launch();
  const secret = await connect(chrome_, user);
  await unlockExt(chrome_);
  if (fs.existsSync(SECOND_EXE)) {
    second = await launch(undefined, { executablePath: SECOND_EXE });
    await join(second, secret);
  } else {
    second = await launch();
    await join(second, secret);
  }
  await joinFirefox(secret);
  // The report says which browsers this ran on, so the run has to say too.
  console.log(`bookmark browsers: Chrome ${chrome_.ctx.browser()?.version()}, second ${await (await second.ctx.newPage()).evaluate(() => navigator.userAgent)}, exe exists ${fs.existsSync(SECOND_EXE)}, Firefox ${(await driver.getCapabilities()).getBrowserVersion()}`);
});

test.afterAll(async () => {
  await driver?.quit();
  await second?.close();
  await chrome_?.close();
});

test("what's in each browser before turning it on ends up in all of them, with nothing doubled", async () => {
  // The same folder and bookmark in two, and something only one has.
  for (const rig of [chrome_, second!]) {
    const f = await addIn(rig, { title: "Shared folder" });
    await addIn(rig, { parent: f, title: "Both have this", url: "https://both.example/" });
  }
  await addIn(chrome_, { title: "Only Chrome", url: "https://chrome-only.example/" });
  await addIn(second!, { parent: "2", title: "Only second", url: "https://second-only.example/" });
  await turnOn(chrome_);
  await turnOn(second!);
  await turnOnFirefox();
  await settle();
  const all = await allAgree();
  expect(JSON.stringify(all)).toContain("Only Chrome=https://chrome-only.example/");
  expect(JSON.stringify(all)).toContain("Only second=https://second-only.example/");
  expect(JSON.stringify(all).match(/Both have this/g)).toHaveLength(1);
  expect(JSON.stringify(all).match(/Shared folder/g)).toHaveLength(1);
});

test("Firefox's own menu bookmarks land in a folder on Chromium, and come back as the menu", async () => {
  const id = await ffEval<string>(`const b = await browser.bookmarks.create({ parentId: "menu________", title: "From the menu", url: "https://menu.example/" }); return b.id;`);
  expect(id).toBeTruthy();
  await settle();
  const all = await allAgree();
  expect(JSON.stringify(all.menu)).toContain("From the menu");
  const raw = await rigEval<string>(chrome_, `const [o] = await chrome.bookmarks.search({ title: "Bookmarks menu" }); return o ? o.parentId : "";`);
  expect(raw).toBe("2");
});

test("add, rename, move and delete go from any browser to the others", async () => {
  const folder = await addIn(chrome_, { title: "Reading" });
  const page = await addIn(chrome_, { title: "Article", url: "https://article.example/" });
  await settle();
  expect(JSON.stringify(await allAgree())).toContain("Article=https://article.example/");

  // Edit in Firefox, and it reaches both Chromium browsers.
  await ffEval(`const [hit] = await browser.bookmarks.search({ url: "https://article.example/" }); await browser.bookmarks.update(hit.id, { title: "Long read" }); return true;`);
  await settle();
  expect(JSON.stringify(await allAgree())).toContain("Long read=https://article.example/");

  await rigEval(chrome_, `await chrome.bookmarks.move(arg.page, { parentId: arg.folder });`, { page, folder });
  await settle();
  const moved = await allAgree();
  expect(JSON.stringify(moved.bar)).toContain('{"Reading":["Long read=https://article.example/"]}');

  await rigEval(second!, `const [hit] = await chrome.bookmarks.search({ url: "https://article.example/" }); await chrome.bookmarks.remove(hit.id);`);
  await settle();
  expect(JSON.stringify(await allAgree())).not.toContain("article.example");
});

test("order carries across, and javascript: bookmarks stay where they are", async () => {
  const ids: string[] = [];
  const f = await addIn(chrome_, { title: "Ordered" });
  for (const n of ["one", "two", "three", "four"]) ids.push(await addIn(chrome_, { parent: f, title: n, url: `https://${n}.example/` }));
  await addIn(chrome_, { parent: f, title: "Bookmarklet", url: "javascript:alert(1)" });
  await settle();
  await rigEval(chrome_, `await chrome.bookmarks.move(arg, { index: 0 });`, ids[3]);
  await settle();
  const all = await allAgree();
  const text = JSON.stringify(all);
  expect(text.indexOf("four=")).toBeLessThan(text.indexOf("one="));
  expect(text.indexOf("one=")).toBeLessThan(text.indexOf("two="));
  // Not in the others, and still here.
  expect(await rigEval<number>(second!, `return (await chrome.bookmarks.search({ title: "Bookmarklet" })).length;`)).toBe(0);
  expect(await rigEval<number>(chrome_, `return (await chrome.bookmarks.search({ title: "Bookmarklet" })).length;`)).toBe(1);
  expect(await ffEval<number>(`return (await browser.bookmarks.search({ title: "Bookmarklet" })).length;`)).toBe(0);
});

test("deleting a lot stops and asks, and keeping them brings them back everywhere", async () => {
  const f = await addIn(chrome_, { title: "Big folder" });
  for (let i = 0; i < 40; i++) await addIn(chrome_, { parent: f, title: `Link ${i}`, url: `https://link${i}.example/` });
  await settle();
  expect(JSON.stringify(await allAgree())).toContain("Link 39=");

  await rigEval(chrome_, `await chrome.bookmarks.removeTree(arg);`, f);
  const held = await runRig(chrome_);
  expect(held.held).toBeTruthy();
  // Nothing's gone anywhere else.
  for (let i = 0; i < 2; i++) await runRig(second!);
  expect(JSON.stringify(await shapeOf(second!))).toContain("Link 39=");

  const page = await chrome_.ctx.newPage();
  await page.goto(`chrome-extension://${chrome_.extId}/vault.html#/settings`);
  const ask = page.getByTestId("bookmark-held");
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toContainText("41");
  await ask.getByRole("button", { name: "Keep them everywhere" }).click();
  await expect(ask).toHaveCount(0, { timeout: 30_000 });
  await page.close();
  await settle();
  const back = await allAgree();
  expect(JSON.stringify(back)).toContain("Link 39=");
  expect(JSON.stringify(back).match(/Link 39=/g)).toHaveLength(1);
});

test("while locked nothing moves, and it catches up after unlocking", async () => {
  const lock = await chrome_.ctx.newPage();
  await lock.goto(`chrome-extension://${chrome_.extId}/popup.html`);
  await lock.getByRole("button", { name: "Lock" }).click();
  await lock.close();
  await addIn(chrome_, { title: "Made while locked", url: "https://locked.example/" });
  await addIn(second!, { title: "Made elsewhere meanwhile", url: "https://elsewhere.example/" });
  await runRig(second!);
  await runRig(second!);
  expect(JSON.stringify(await shapeOf(chrome_))).not.toContain("elsewhere.example");
  await unlockExt(chrome_);
  await settle();
  const all = await allAgree();
  expect(JSON.stringify(all)).toContain("locked.example");
  expect(JSON.stringify(all)).toContain("elsewhere.example");
});

test("bookmarks in a shared vault are ignored", async () => {
  const planted = await testHook<{ vaultId: string }>(chrome_, "bookmarkPlant", { title: "Planted", url: "https://planted.example/" });
  expect(planted.vaultId).toBeTruthy();
  await settle();
  expect(JSON.stringify(await allAgree())).not.toContain("planted.example");
});

test("the server holds no bookmark in the clear, and a copy can be saved", async () => {
  await addIn(chrome_, { title: `${CANARY} title`, url: `https://${CANARY.toLowerCase()}.example/secret-path` });
  await settle();
  const items = await testHook<{ title: string; url?: string }[]>(chrome_, "bookmarkItems");
  expect(items.some((i) => i.title.startsWith(CANARY))).toBe(true);
  const dump = execFileSync("docker", ["exec", "PromptlyPw-Postgres", "pg_dump", "-U", "promptly", "-d", "promptly", "--inserts"], { encoding: "utf8", maxBuffer: 1 << 30 });
  expect(dump.toLowerCase()).not.toContain(CANARY.toLowerCase());
  expect(dump.toLowerCase()).not.toContain(Buffer.from(CANARY).toString("hex").toLowerCase());
  const logs = execFileSync("docker", ["logs", "--tail", "5000", "PromptlyPw-Backend"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
  expect(logs.toLowerCase()).not.toContain(CANARY.toLowerCase());

  const html = await rigEval<{ ok: boolean; r: string }>(chrome_, `return chrome.runtime.sendMessage({ t: "bookmarkExport" });`);
  expect(html.r).toContain("NETSCAPE-Bookmark-file-1");
  expect(html.r).toContain(`${CANARY} title`);
  expect(html.r).not.toContain("javascript:");
});

test("turning it off keeps the bookmarks, and the vault's items don't show as items", async () => {
  const page = await chrome_.ctx.newPage();
  await page.goto(`chrome-extension://${chrome_.extId}/vault.html#/all`);
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Made while locked")).toHaveCount(0);
  await page.goto(`chrome-extension://${chrome_.extId}/vault.html#/settings`);
  await page.getByTestId("bookmark-settings").getByRole("checkbox", { name: /same in every browser/ }).click();
  await expect(page.getByTestId("bookmark-status")).toHaveCount(0);
  await page.close();
  const before = await rigEval<number>(second!, `return (await chrome.bookmarks.search({ title: "Made while locked" })).length;`);
  expect(before).toBe(1);
});
