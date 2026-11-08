// Browser sync on real Firefox (passwords/SYNC.md): its open tabs reach the web vault, a tab sent
// to it opens (or shows a notification), history stays off until it's turned on, and the reading
// list is ours here, since Firefox has no reading list API.
//   cd e2e && node --test passwords-firefox/browsersync.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { By } from "selenium-webdriver";

import { BASE, button, byText, click, fill, labelled, makeUsers, MASTER, newFirefox, onboard, see, signIn } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../frontend/package.json"));
const { zipSync } = require("fflate");

const UUID = "11112222-3333-4444-5555-6666777788bb";
const EXT = `moz-extension://${UUID}`;
const DIST = path.resolve(here, "../../passwords/extension/dist/firefox-test");
const SITE = path.resolve(here, "../../passwords/test-sites/ext");
const PORT = 8111;
const siteA = (p) => `http://localhost:${PORT}/${p}`;

let driver;
let server;
let extTab;

function zipDir() {
  const files = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files[path.relative(DIST, p).replace(/\\/g, "/")] = new Uint8Array(fs.readFileSync(p));
    }
  };
  walk(DIST);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pw-xpi-")), "ext.xpi");
  fs.writeFileSync(out, zipSync(files));
  return out;
}

/** Runs with extension privileges, in our own page. */
async function extEval(fn, ...args) {
  const handle = await driver.getWindowHandle();
  await driver.switchTo().window(extTab);
  const out = await driver.executeAsyncScript(`const done = arguments[arguments.length-1]; (${fn})(...Array.from(arguments).slice(0,-1)).then(done, (e) => done({__error:String(e)}));`, ...args);
  await driver.switchTo().window(handle);
  return out;
}

/** What the panel and the vault page send the background. */
async function ask(m) {
  const r = await extEval(`(m) => browser.runtime.sendMessage(m)`, m);
  if (!r?.ok) throw new Error(r?.error ?? JSON.stringify(r));
  return r.r;
}
const syncNow = () => ask({ t: "bs:syncNow" });

async function newTab(url) {
  await driver.switchTo().newWindow("tab");
  await driver.get(url);
  return driver.getWindowHandle();
}

async function closeTabs() {
  for (const h of await driver.getAllWindowHandles()) {
    if (h !== extTab) {
      await driver.switchTo().window(h);
      await driver.close();
    }
  }
  await driver.switchTo().window(extTab);
}

async function openSettings() {
  await driver.switchTo().window(extTab);
  await driver.executeScript(`location.hash = "#/settings";`);
  await see(driver, By.css('[data-testid="browser-sync-settings"]'), 30000);
}

async function setBox(testId, on) {
  await openSettings();
  const box = await see(driver, By.css(`[data-testid="${testId}"]`));
  if ((await box.isSelected()) !== on) await box.click();
  await driver.wait(async () => (await (await see(driver, By.css(`[data-testid="${testId}"]`))).isSelected()) === on, 10000);
}

const tabUrls = () => extEval(`async () => (await browser.tabs.query({})).map((t) => t.url ?? "")`);

before(async () => {
  makeUsers(["root"], "admin");
  server = http.createServer((req, res) => {
    const rel = new URL(req.url, "http://x").pathname.replace(/^\//, "");
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("no");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  driver = await newFirefox({
    prefs: {
      "extensions.webextensions.uuids": JSON.stringify({ "passwords@promptly.app": UUID }),
      // Says yes to optional permissions (tabs, history, notifications) as a person would.
      "extensions.webextOptionalPermissionPrompts": false,
      "xpinstall.signatures.required": false,
    },
  });
  await driver.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });
  await driver.manage().setTimeouts({ script: 120000 });
  await driver.installAddon(zipDir(), true);

  const [u] = makeUsers(["ffsync"]);
  await signIn(driver, u);
  const secret = await onboard(driver);
  for (const h of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(h);
    if ((await driver.getCurrentUrl()).startsWith("moz-extension://")) extTab = h;
  }
  if (!extTab) throw new Error("The extension didn't open its page");
  await driver.switchTo().window(extTab);
  await fill(driver, labelled("Your server's address"), BASE);
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
  await closeTabs();
  await click(driver, button("Use my recovery kit"));
  await fill(driver, labelled("Secret Key"), secret);
  await fill(driver, labelled("Master password"), MASTER);
  await click(driver, button("Unlock"));
  await click(driver, button("On all sites (best filling)"), 60000);
  await see(driver, byText("Your vault is locked"), 60000);
  await fill(driver, labelled("Master password"), MASTER);
  await click(driver, button("Unlock"));
  await see(driver, By.css('nav[aria-label="Passwords"]'), 60000);
});

after(async () => {
  await driver?.quit();
  server?.close();
});

test("Firefox: its open tabs reach the web vault, and its own pages don't", async () => {
  await setBox("bs-tabs", true);
  await newTab(siteA("login.html?bs=ff-tabs"));
  await driver.switchTo().window(extTab);
  await syncNow();

  // The web vault in the same profile is a different device: it shows Firefox's tabs.
  await newTab(`${BASE}/passwords#/browser-sync`);
  // Either the screen, or the lock screen first (its box is labelled, not aria-labelled).
  await see(driver, By.xpath('//*[@data-testid="browser-sync-screen"] | //label[.//span[normalize-space(.)="Master password"]]//input'), 60000);
  if ((await driver.findElements(By.css('[data-testid="browser-sync-screen"]'))).length === 0) {
    await fill(driver, labelled("Master password"), MASTER);
    await click(driver, button("Unlock"));
  }
  const device = await see(driver, By.css('[data-testid="device-tabs"]'), 60000);
  const text = await device.getText();
  assert.match(text, /Sign in to Acme/);
  assert.match(text, /just now/);
  assert.doesNotMatch(text, /moz-extension/);
  const links = await driver.findElements(By.css('[data-testid="device-tabs"] a'));
  for (const a of links) assert.match(await a.getAttribute("href"), /^https?:/);
  await closeTabs();
});

test("Firefox: a tab sent here opens, or shows a notification when asked to", async () => {
  // This browser's own device id, from its own store: a send to itself goes through the server
  // like any other.
  const me = await extEval(`() => new Promise((res, rej) => { const r = indexedDB.open("promptly-vault"); r.onsuccess = () => { const g = r.result.transaction("meta").objectStore("meta").get("device_id"); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); })`);
  assert.ok(me);
  await ask({ t: "bs:send", target: me, url: siteA("card.html?bs=ff-sent"), title: "Card" });
  await syncNow();
  await driver.wait(async () => (await tabUrls()).filter((u) => u.includes("bs=ff-sent")).length === 1, 30000);
  await syncNow();
  assert.equal((await tabUrls()).filter((u) => u.includes("bs=ff-sent")).length, 1);

  await setBox("bs-notify", true);
  await ask({ t: "bs:send", target: me, url: siteA("card.html?bs=ff-noted"), title: "Card" });
  await syncNow();
  const notes = await extEval(`async () => Object.keys(await browser.notifications.getAll())`);
  assert.equal(notes.filter((k) => k.startsWith("bs-sent:")).length, 1);
  assert.equal((await tabUrls()).filter((u) => u.includes("bs=ff-noted")).length, 0);
  await closeTabs();
});

test("Firefox: history stays off until it's turned on, and then only from then on", async () => {
  await newTab(siteA("login.html?bs=ff-history-off"));
  await driver.switchTo().window(extTab);
  await syncNow();
  const marked = async () => (await ask({ t: "bs:history", query: "", all: true })).rows.map((r) => r.url).filter((u) => u.includes("bs=ff-history"));
  assert.deepEqual(await marked(), []);

  await setBox("bs-history", true);
  await see(driver, byText("Off unless you turn it on"));
  const on = siteA("login.html?bs=ff-history-on");
  await newTab(on);
  await driver.switchTo().window(extTab);
  await driver.wait(async () => {
    await syncNow();
    return (await marked()).length > 0;
  }, 30000);
  assert.deepEqual(await marked(), [on]);

  await click(driver, By.css('[data-testid="bs-forget"]'));
  await see(driver, byText("synced history is deleted"));
  assert.deepEqual(await marked(), []);
  await setBox("bs-history", false);
  await closeTabs();
});

test("Firefox: the reading list is ours here, saved from the panel", async () => {
  await openSettings();
  await see(driver, byText("Firefox has no reading list extensions can use"));
  assert.equal((await driver.findElements(By.css('[data-testid="bs-reading"]'))).length, 0);

  const pg = await newTab(siteA("login.html?bs=ff-reading"));
  const url = await driver.getCurrentUrl();
  const id = await extEval(`async (u) => (await browser.tabs.query({})).find((t) => t.url === u)?.id ?? -1`, url);
  await driver.switchTo().window(extTab);
  await newTab(`${EXT}/popup.html?tab=${id}`);
  await click(driver, button("Browse"));
  await click(driver, By.css('[data-testid="save-for-later"]'));
  await see(driver, byText("Saved for later"));
  await click(driver, By.css('[data-testid="browse-reading"]'));
  await see(driver, By.css('[data-testid="reading-entry"]'));
  const list = await ask({ t: "bs:reading" });
  assert.deepEqual(list.entries.map((e) => [e.url, e.read]), [[url, false]]);
  void pg;
  await closeTabs();
});
