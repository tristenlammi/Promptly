// The extension on real Firefox: temporary add-on, real content scripts, trusted clicks
// by WebDriver Actions. Shares fixtures and expectations with the Chromium suite.
//   cd e2e && node --test passwords-firefox/extension.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { By, until } from "selenium-webdriver";

import { BASE, button, byText, click, fill, labelled, makeUsers, MASTER, newFirefox, onboard, see, signIn } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../frontend/package.json"));
const { zipSync } = require("fflate");

const UUID = "11112222-3333-4444-5555-666677778888";
const EXT = `moz-extension://${UUID}`;
const DIST = path.resolve(here, "../../passwords/extension/dist/firefox-test");
const SITE = path.resolve(here, "../../passwords/test-sites/ext");
const PORT = 8111;

let driver;
let ffUserId;
let server;
let xpi;
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

const siteA = (p) => `http://localhost:${PORT}/${p}`;

async function newTab(url) {
  await driver.switchTo().newWindow("tab");
  await driver.get(url);
  return driver.getWindowHandle();
}

/** Runs with extension privileges, in our own page. */
async function extEval(fn, ...args) {
  const handle = await driver.getWindowHandle();
  await driver.switchTo().window(extTab);
  const out = await driver.executeAsyncScript(`const done = arguments[arguments.length-1]; (${fn})(...Array.from(arguments).slice(0,-1)).then(done, (e) => done({__error:String(e)}));`, ...args);
  await driver.switchTo().window(handle);
  return out;
}

const hook = (op, args = {}) => extEval(`async (m) => { const r = await browser.runtime.sendMessage(m); if (!r?.ok) throw new Error(r?.error ?? "no answer"); return r.r; }`, { t: "test", op, ...args });

const addLogin = (title, url, username, password) => extEval(`(m) => browser.runtime.sendMessage(m)`, { t: "addLogin", title, url, username, password });

async function tabId(url) {
  return extEval(`async (u) => (await browser.tabs.query({})).find((t) => t.url === u)?.id ?? -1`, url);
}

/** The popup, in a tab, aimed at the page in the current tab. */
async function popup(pageUrl) {
  const id = await tabId(pageUrl);
  const before = await driver.getAllWindowHandles();
  await extEval("(u) => browser.tabs.create({ url: u })", `${EXT}/popup.html?tab=${id}`);
  await driver.wait(async () => (await driver.getAllWindowHandles()).length > before.length, 15000);
  const h = (await driver.getAllWindowHandles()).find((x) => !before.includes(x));
  await driver.switchTo().window(h);
  return h;
}

async function clickAt(x, y) {
  await driver.actions({ async: true }).move({ x: Math.round(x), y: Math.round(y) }).click().perform();
}

async function rectOf(sel) {
  return driver.executeScript(`const r=document.querySelector(arguments[0]).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}`, sel);
}

async function state() {
  return driver.executeScript("return window.__state()");
}

before(async () => {
  makeUsers(["root"], "admin");
  server = http.createServer((req, res) => {
    const asked = new URL(req.url, "http://x");
    // A stand-in for a site's login API: answers with the status it's asked for.
    if (asked.pathname === "/api/login") return res.writeHead(Number(asked.searchParams.get("status") ?? 200), { "Content-Type": "application/json" }).end("{}");
    const rel = asked.pathname.replace(/^\/ext\//, "").replace(/^\//, "");
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("no");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...(rel.includes("sandboxed") ? { "Content-Security-Policy": "sandbox allow-scripts" } : {}) });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  xpi = zipDir();
  driver = await newFirefox({
    prefs: {
      "extensions.webextensions.uuids": JSON.stringify({ "passwords@promptly.app": UUID }),
      "extensions.webextOptionalPermissionPrompts": false,
      "xpinstall.signatures.required": false,
    },
  });
  await driver.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });
  await driver.manage().setTimeouts({ script: 120000 });
  await driver.installAddon(xpi, true);

  const [u] = makeUsers(["ffext"]);
  ffUserId = u.id;
  await signIn(driver, u);
  const secret = await onboard(driver);

  // Connect, as a person would. The test build opened its vault page when installed.
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
    if ((await driver.getCurrentUrl()).includes('/passwords/connect')) break;
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
  // The real site-access question.
  await click(driver, button("On all sites (best filling)"), 60000);
  await see(driver, byText("Your vault is locked"), 60000);
  // Unlock through the background.
  await fill(driver, labelled("Master password"), MASTER);
  await click(driver, button("Unlock"));
  await see(driver, By.css('nav[aria-label="Passwords"]'), 60000);
  await addLogin("Acme", siteA(""), "ana@example.com", "acme-Pass-1");
});

after(async () => {
  await driver?.quit();
  server?.close();
});

async function page(p) {
  await driver.switchTo().window(extTab);
  const h = await newTab(siteA(p));
  await driver.sleep(250);
  return h;
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

test("Firefox: popup fills the page", async () => {
  const pg = await page("login.html");
  const url = await driver.getCurrentUrl();
  await popup(url);
  await click(driver, button("Fill Acme"));
  await driver.sleep(500);
  await driver.switchTo().window(pg);
  assert.deepEqual(await state(), { user: "ana@example.com", pass: "acme-Pass-1" });
  await closeTabs();
});

test("Firefox: the inline menu never fills, since nothing here can tell it's really showing", async () => {
  await page("login.html");
  const r = await rectOf("#user");
  await clickAt(r.x + 10, r.y + 5);
  await driver.sleep(1200);
  const seen = await driver.executeScript(`const el=document.documentElement.lastElementChild;return {tag:el.tagName,id:el.id,cls:el.className,shadow:!!el.shadowRoot,frames:document.querySelectorAll('iframe').length}`);
  assert.deepEqual(seen, { tag: "DIV", id: "", cls: "", shadow: false, frames: 0 });
  // Where the first row would be, looked at for as long as anyone likes.
  await clickAt(r.x + 80, r.y + r.h + 24);
  await driver.sleep(700);
  assert.equal((await state()).pass, "");
  await closeTabs();
});

test("Firefox: the review's covers make no difference, and the popup still fills the same page", async () => {
  for (const name of ["adv-hide.html?drop=1&how=focus", "adv-hide.html?drop=0&how=focus", "adv-shadow-cover.html?how=focus", "adv-hide.html?drop=1"]) {
    await driver.switchTo().window(extTab);
    await newTab(`http://evil.acme.localhost:${PORT}/${name}`);
    await driver.sleep(1800);
    await clickAt(180, 150);
    await driver.sleep(800);
    assert.equal((await state()).pass, "", name);
    await closeTabs();
  }
});

test("Firefox: a page that knows our address and frames our menu gets nothing", async () => {
  await driver.switchTo().window(extTab);
  // Firefox's stack traces hide the address today. If a page ever had it anyway, this is what happens.
  await newTab(`http://evil.acme.localhost:${PORT}/adv-war.html?uuid=${UUID}`);
  await driver.sleep(1800);
  await clickAt(180, 130);
  await driver.sleep(800);
  assert.equal((await state()).pass, "");
  await closeTabs();

  await driver.switchTo().window(extTab);
  await newTab(`http://evil.acme.localhost:${PORT}/adv-war.html?page=save.html&uuid=${UUID}`);
  await driver.sleep(1800);
  await clickAt(180, 130);
  await driver.sleep(500);
  assert.equal((await hook("pending")).filter((p) => p.offer.host.startsWith("evil.acme")).length, 0);
  await closeTabs();
});

test("Firefox: a page that sets values and submits gets no offer, and neither does a sandboxed one get a fill", async () => {
  await addLogin("Fox save", `http://foxsave.localhost:${PORT}`, "victim@example.com", "Fox-Real-1");
  await driver.switchTo().window(extTab);
  await newTab(`http://foxsave.localhost:${PORT}/adv-sv.html`);
  await driver.sleep(2800);
  const waiting = await hook("pending");
  assert.ok(!JSON.stringify(waiting).includes("attacker-chosen-1"), JSON.stringify(waiting));
  await closeTabs();

  const added = await addLogin("Fox sandbox", `http://foxbox.localhost:${PORT}`, "victim@example.com", "Fox-Box-1");
  await hook("patchItem", { id: added.r.id, patch: { autofillOnLoad: true } });
  await driver.switchTo().window(extTab);
  await newTab(`http://foxbox.localhost:${PORT}/adv-sandboxed.html`);
  await driver.sleep(1500);
  assert.equal((await state()).pass, "", "not on load");
  assert.equal((await state()).origin, "null");
  const id = await tabId(await driver.getCurrentUrl());
  const r = await extEval(`(m) => browser.runtime.sendMessage(m)`, { t: "fill", tabId: id, itemId: added.r.id });
  assert.equal(r.r.ok, false, JSON.stringify(r));
  await driver.sleep(300);
  assert.equal((await state()).pass, "", "not from the popup");
  await hook("patchItem", { id: added.r.id, patch: { autofillOnLoad: false } });
  await closeTabs();
});

test("Firefox: boxes that can't be seen stay empty", async () => {
  const added = await addLogin("Fox hidden", `http://foxhid.localhost:${PORT}`, "victim@example.com", "Fox-Hid-1");
  for (const v of ["two", "cover", "pecover", "clip", "right", "below", "transp"]) {
    await driver.switchTo().window(extTab);
    await newTab(`http://foxhid.localhost:${PORT}/adv-hidden.html?v=${v}`);
    await driver.sleep(500);
    const id = await tabId(await driver.getCurrentUrl());
    await extEval(`(m) => browser.runtime.sendMessage(m)`, { t: "fill", tabId: id, itemId: added.r.id });
    await driver.sleep(300);
    const s = await state();
    assert.equal(s.pass, "", v);
    assert.equal(s.user, "victim@example.com", v);
    await closeTabs();
  }
});

test("Firefox: a frame swapped after the origin check gets nothing, by the content script's own check", async () => {
  const added = await addLogin("Fox swap", `http://foxbank.localhost:${PORT}`, "victim@example.com", "Fox-Swap-1");
  await hook("flags", { flags: { fillDelayMs: 1200 } });
  try {
    await driver.switchTo().window(extTab);
    const url = `http://foxevil.localhost:${PORT}/adv-swap.html?bank=${encodeURIComponent(`http://foxbank.localhost:${PORT}/login.html`)}&grab=${encodeURIComponent(`http://foxevil.localhost:${PORT}/adv-grab.html`)}`;
    const pg = await newTab(url);
    await driver.sleep(800);
    const id = await tabId(url);
    await driver.switchTo().window(extTab);
    await driver.executeScript(`window.__fillRun = browser.runtime.sendMessage(arguments[0]);`, { t: "fill", tabId: id, itemId: added.r.id, confirmOrigin: `http://foxbank.localhost:${PORT}` });
    await driver.switchTo().window(pg);
    await driver.sleep(500);
    await driver.executeScript("window.__swap()");
    await driver.sleep(1800);
    assert.deepEqual((await state()).got, []);
    await closeTabs();
  } finally {
    await hook("flags", { flags: { fillDelayMs: 0 } });
  }
});

test("Firefox: the toolbar popup is where a save gets answered", async () => {
  await driver.switchTo().window(extTab);
  const url = `http://foxoffer.localhost:${PORT}/adv-typed.html`;
  const pg = await newTab(url);
  await driver.findElement(By.css("#user")).sendKeys("offer@example.com");
  await driver.findElement(By.css("#pass")).sendKeys("Fox-Offer-1");
  await driver.findElement(By.css("#go")).click();
  await driver.sleep(2500);
  await popup(url);
  await see(driver, By.css('[data-testid="save-offer"]'));
  await click(driver, By.xpath('//*[@data-testid="save-offer"]//button[normalize-space(.)="Save"]'));
  await driver.sleep(800);
  const items = await hook("items");
  assert.ok(items.some((i) => i.username === "offer@example.com" && i.password === "Fox-Offer-1"), JSON.stringify(items.map((i) => i.title)));
  await driver.switchTo().window(pg);
  await closeTabs();
});

test("Firefox: closed shadow root fields are found through the real API", async () => {
  await page("login.html");
  await driver.executeScript(`
    document.body.innerHTML = '<h1>Sign in</h1><div id="h"></div>';
    const root = document.getElementById('h').attachShadow({mode:'closed'});
    root.innerHTML = '<form><label>Email <input id="u" name="email" autocomplete="username"></label><label>Password <input id="p" type="password" autocomplete="current-password"></label><button>Sign in</button></form>';
    window.__root = root;
  `);
  await driver.sleep(700);
  const url = await driver.getCurrentUrl();
  const pg = await driver.getWindowHandle();
  await popup(url);
  await click(driver, button("Fill Acme"));
  await driver.sleep(600);
  await driver.switchTo().window(pg);
  assert.equal(await driver.executeScript("return window.__root.getElementById('p').value"), "acme-Pass-1");
  await closeTabs();
});

test("Firefox: a content script can't read storage.session, or ask for secrets", async () => {
  const pg = await page("login.html");
  const url = await driver.getCurrentUrl();
  const id = await tabId(url);
  await driver.switchTo().window(extTab);
  const out = await driver.executeAsyncScript(
    `const done = arguments[arguments.length-1];
     browser.scripting.executeScript({ target: { tabId: arguments[0] }, func: async () => {
       let session = "readable";
       try { const v = await browser.storage.session.get("unlock"); if (!v.unlock) session = "empty"; } catch (e) { session = "blocked"; }
       const item = await browser.runtime.sendMessage({ t: "session" }).catch(() => "blocked");
       return { session, item: item === undefined ? null : item };
     }}).then((r) => done(r[0].result), (e) => done({ error: String(e) }));`,
    id,
  );
  assert.notEqual(out.session, "readable", JSON.stringify(out));
  assert.ok(out.item === null || out.item === "blocked", JSON.stringify(out));
  await driver.switchTo().window(pg);
  await closeTabs();
});

test("Firefox: a passkey made and used here satisfies an independent WebAuthn library", async () => {
  const { verifyAuthenticationResponse, verifyRegistrationResponse } = await import("@simplewebauthn/server");
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const crypto = await import("node:crypto");
  await driver.switchTo().window(extTab);
  await newTab(siteA("webauthn.html"));
  const pg = await driver.getWindowHandle();

  const finishPrompt = async (buttonName, handles) => {
    await driver.wait(async () => (await driver.getAllWindowHandles()).length > handles.length, 15000);
    const h = (await driver.getAllWindowHandles()).find((x) => !handles.includes(x));
    await driver.switchTo().window(h);
    await click(driver, buttonName);
    await driver.sleep(300);
    await driver.switchTo().window(pg);
  };

  const challenge = b64u(crypto.randomBytes(32));
  let handles = await driver.getAllWindowHandles();
  // Our window only opens for a real gesture.
  await clickAt(300, 300);
  await driver.executeScript(`window.__res = null; window.__register(arguments[0]).then((r) => (window.__res = r));`, { rpId: "localhost", userId: b64u("user-ff"), userName: "ff@example.com", challenge });
  await finishPrompt(button("Save as a new item"), handles);
  await driver.wait(async () => driver.executeScript("return window.__res !== null"), 15000);
  const reg = await driver.executeScript("return window.__res");
  assert.equal(reg.error, undefined);
  const v = await verifyRegistrationResponse({ response: reg, expectedChallenge: challenge, expectedOrigin: `http://localhost:${PORT}`, expectedRPID: "localhost", requireUserVerification: false });
  assert.ok(v.verified);
  assert.equal(v.registrationInfo.userVerified, false, "a click doesn't verify anyone");

  const c2 = b64u(crypto.randomBytes(32));
  handles = await driver.getAllWindowHandles();
  await clickAt(300, 300);
  await driver.executeScript(`window.__res = null; window.__auth(arguments[0]).then((r) => (window.__res = r));`, { rpId: "localhost", challenge: c2, allow: [v.registrationInfo.credential.id] });
  await finishPrompt(By.xpath('//button[contains(., "ff@example.com")]'), handles);
  await driver.wait(async () => driver.executeScript("return window.__res !== null"), 15000);
  const auth = await driver.executeScript("return window.__res");
  assert.equal(auth.error, undefined);
  const a = await verifyAuthenticationResponse({ response: auth, expectedChallenge: c2, expectedOrigin: `http://localhost:${PORT}`, expectedRPID: "localhost", credential: { id: v.registrationInfo.credential.id, publicKey: v.registrationInfo.credential.publicKey, counter: 0 }, requireUserVerification: false });
  assert.ok(a.verified);
  await closeTabs();
});

test("Firefox: a quiet passkey request is answered from the toolbar, and verified by a library", async () => {
  const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
  const crypto = await import("node:crypto");
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const guid = "c1df3f1c-2b3c-4d4e-9fa0-1b2c3d4e5f60";
  const siteId = Buffer.from(guid.replace(/-/g, ""), "hex").toString("base64url");
  const now = new Date().toISOString();
  // As a Bitwarden export holds it, so the same conversion has to be working here.
  await hook("seedBody", {
    body: {
      v: 1, kind: "login", title: "Imported fox", createdAt: now, updatedAt: now, username: "fox@example.com", urls: [{ url: "http://localhost:8111" }],
      passkeys: [{ credentialId: guid, rpId: "localhost", userHandle: Buffer.from("fox").toString("base64url"), userName: "fox@example.com", key: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), alg: -7, signCount: 0, createdAt: now, discoverable: true }],
    },
  });
  const challenge = crypto.randomBytes(32).toString("base64url");
  const url = `${siteA("webauthn.html")}?auto=${challenge}&rp=localhost&m=conditional&allow=${siteId}`;
  await driver.switchTo().window(extTab);
  const pg = await newTab(url);
  await driver.sleep(800);
  assert.equal(await driver.executeScript("return window.__result"), null, "nothing's answered by itself");
  await popup(url);
  const before = await driver.getAllWindowHandles();
  await click(driver, button("Sign in with a passkey as fox@example.com"));
  await driver.wait(async () => (await driver.getAllWindowHandles()).length > before.length, 15000);
  const prompt = (await driver.getAllWindowHandles()).find((x) => !before.includes(x));
  await driver.switchTo().window(prompt);
  await click(driver, By.xpath('//button[contains(., "fox@example.com")]'));
  await driver.sleep(400);
  await driver.switchTo().window(pg);
  await driver.wait(async () => driver.executeScript("return window.__result !== null"), 15000);
  const r = await driver.executeScript("return window.__result");
  assert.equal(r.error, undefined);
  assert.equal(r.id, siteId);
  const jwk = pair.publicKey.export({ format: "jwk" });
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url")]);
  const v = await verifyAuthenticationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: "http://localhost:8111", expectedRPID: "localhost", credential: { id: siteId, publicKey: new Uint8Array(cose), counter: 0 }, requireUserVerification: false });
  assert.ok(v.verified);
  await closeTabs();
});

test("Firefox: a page asking for a passkey with no click gets our window when it's here", async () => {
  const crypto = await import("node:crypto");
  // The passkey from the test above, by its id.
  const guid = "c1df3f1c-2b3c-4d4e-9fa0-1b2c3d4e5f60";
  const siteId = Buffer.from(guid.replace(/-/g, ""), "hex").toString("base64url");
  const challenge = crypto.randomBytes(32).toString("base64url");
  const url = `${siteA("webauthn.html")}?late=1&auto=${challenge}&rp=localhost&allow=${siteId}`;
  await driver.switchTo().window(extTab);
  const before = await driver.getAllWindowHandles();
  const pg = await newTab(url);
  const withPage = [...before, pg];
  await driver.wait(async () => (await driver.getAllWindowHandles()).length > withPage.length, 20000, "our window");
  const prompt = (await driver.getAllWindowHandles()).find((x) => !withPage.includes(x));
  await driver.switchTo().window(prompt);
  await see(driver, button("Use another device or security key"));
  await click(driver, By.xpath('//button[contains(., "fox@example.com")]'));
  await driver.sleep(400);
  await driver.switchTo().window(pg);
  await driver.wait(async () => driver.executeScript("return window.__result !== null"), 15000);
  assert.equal(await driver.executeScript("return window.__hadClick"), false, "really no click behind it");
  const r = await driver.executeScript("return window.__result");
  assert.equal(r.error, undefined);
  assert.equal(r.id, siteId);
  await closeTabs();
});

test("Firefox: saves a new login after a sign-in", async () => {
  await driver.switchTo().window(extTab);
  await newTab(`http://localhost:${PORT}/login.html`);
  await addLogin("Unrelated", "https://other.test", "x", "y");
  await driver.findElement(By.css("#user")).sendKeys("firefox-new@example.com");
  await driver.findElement(By.css("#pass")).sendKeys("ff-new-Pass-1");
  await driver.findElement(By.css("#go")).click();
  await driver.wait(until.urlContains("welcome"), 10000);
  await driver.sleep(1500);
  const shown = await driver.executeScript(`return document.documentElement.lastElementChild.tagName === 'DIV'`);
  assert.ok(shown, "the save bar's host is there");
  await closeTabs();
});

// ---- Where Firefox's background differs from Chromium's -----------------------------------

async function openSettings() {
  await driver.switchTo().window(extTab);
  await driver.executeScript(`location.hash = "#/settings";`);
  await see(driver, By.css('[data-testid="ext-settings"]'), 30000);
}

const settingsBox = (text) => By.xpath(`//*[@data-testid="ext-settings"]//label[contains(normalize-space(.), ${JSON.stringify(text)})]//input`);

const setNumber = async (locator, value) => {
  const el = await see(driver, locator);
  await driver.executeScript(`arguments[0].scrollIntoView({ block: "center" });`, el);
  // All at once: the box puts its default back the moment it's empty, so typing can't do it.
  await driver.executeScript(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(arguments[0], arguments[1]); arguments[0].dispatchEvent(new Event("input", { bubbles: true }));`, el, String(value));
  await driver.sleep(300);
};

async function readClip() {
  await driver.switchTo().window(extTab);
  return driver.executeAsyncScript(`const done = arguments[arguments.length-1]; navigator.clipboard.readText().then(done, (e) => done("READ FAILED " + e));`);
}

const signedIn = async () => (await extEval(`(m) => browser.runtime.sendMessage(m)`, { t: "state" })).r.unlocked;

test("Firefox: the on-click box walks the real permission path, and takes both scripts with it", async () => {
  await openSettings();
  const scripts = () => extEval(`async () => (await browser.scripting.getRegisteredContentScripts()).map((x) => x.id).sort()`);
  assert.deepEqual(await scripts(), ["promptly-fields", "promptly-passkey"]);
  const box = settingsBox("Only fill when I click");
  await (await see(driver, box)).click();
  await driver.sleep(500);
  assert.deepEqual(await scripts(), []);
  assert.equal(await (await see(driver, box)).isSelected(), true);

  // No wrapper on a new page, so WebAuthn is the browser's. A wrapper left behind with no
  // bridge hands over too, instead of hanging.
  const pg = await page("webauthn.html");
  await driver.executeScript(`navigator.credentials.create = () => Promise.resolve("reached the browser"); navigator.credentials.get = () => Promise.resolve("reached the browser");`);
  const id = await tabId(await driver.getCurrentUrl());
  await extEval(`(id) => browser.scripting.executeScript({ target: { tabId: id }, world: "MAIN", files: ["passkey-main.js"] })`, id);
  await driver.switchTo().window(pg);
  const out = await driver.executeAsyncScript(`
    const done = arguments[arguments.length-1];
    const started = Date.now();
    navigator.credentials.create({ publicKey: { rp: { name: "x" }, user: { id: new Uint8Array(4), name: "u", displayName: "u" }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: "public-key", alg: -7 }] } }).then(
      (r) => done({ r, ms: Date.now() - started }),
      (e) => done({ error: String(e) }),
    );`);
  assert.equal(out.r, "reached the browser", JSON.stringify(out));
  assert.equal(await driver.executeScript(`return "__promptlyPk" in window`), false);
  assert.ok(out.ms < 5000, JSON.stringify(out));
  await closeTabs();

  await openSettings();
  await (await see(driver, box)).click();
  await driver.sleep(800);
  assert.deepEqual(await scripts(), ["promptly-fields", "promptly-passkey"]);
  assert.equal(await (await see(driver, box)).isSelected(), false);
});

test("Firefox: clipboard clears from the event page, and leaves something newer alone when allowed to look", async () => {
  await openSettings();
  await setNumber(By.css('input[type=number][min="5"]'), 5);
  // Asking for clipboardRead is a real click on a real box. The test pref says yes to it.
  const box = settingsBox("Don't clear the clipboard");
  await (await see(driver, box)).click();
  await driver.sleep(500);
  assert.equal(await (await see(driver, box)).isSelected(), true);

  const pg = await page("login.html");
  const url = await driver.getCurrentUrl();
  const copyFromPopup = async () => {
    await popup(url);
    await click(driver, button("Generator"));
    const shown = await see(driver, By.css('[data-testid="generated"]'));
    await driver.wait(async () => (await shown.getText()).length > 0, 10000);
    const value = await shown.getText();
    await click(driver, button("Copy"));
    await see(driver, byText("Copied."));
    await driver.close();
    return value;
  };

  const value = await copyFromPopup();
  assert.equal(await readClip(), value);
  await driver.sleep(7000);
  assert.equal(await readClip(), "");

  await copyFromPopup();
  await driver.switchTo().window(extTab);
  await driver.executeAsyncScript(`const done = arguments[arguments.length-1]; navigator.clipboard.writeText("something of mine").then(done, done);`);
  await driver.sleep(6500);
  assert.equal(await readClip(), "something of mine");

  await driver.switchTo().window(pg);
  await closeTabs();
  await openSettings();
  await setNumber(By.css('input[type=number][min="5"]'), 30);
});

test("Firefox: the 2FA code is copied from the event page once the next page has no box", async () => {
  const added = await addLogin("Firefox 2FA", "http://twofa.localhost:8111", "two@example.com", "Two-Pw-1");
  await hook("patchItem", { id: added.r.id, patch: { totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } } });
  await driver.switchTo().window(extTab);
  const pg = await newTab("http://twofa.localhost:8111/login.html");
  const pop = await popup("http://twofa.localhost:8111/login.html");
  const before = await readClip();
  await driver.switchTo().window(pop);
  await click(driver, button("Fill Firefox 2FA"));
  await driver.sleep(1500);
  assert.equal(await readClip(), before, "nothing copied at the fill");
  await driver.switchTo().window(pg);
  assert.equal((await state()).pass, "Two-Pw-1");
  await driver.findElement(By.css("#go")).click();
  await driver.wait(until.urlContains("welcome"), 10000);
  await driver.sleep(2500);
  assert.match(await readClip(), /^\d{6}$/);
  await closeTabs();
});

test("Firefox: reading the page's requests from the isolated world", async () => {
  const hostShown = () => driver.executeScript(`return document.documentElement.lastElementChild.tagName === 'DIV'`);
  const typeAndGo = async (url) => {
    await driver.switchTo().window(extTab);
    await newTab(url);
    await driver.sleep(300);
    await driver.findElement(By.css("#user")).sendKeys("spa@example.com");
    await driver.findElement(By.css("#pass")).sendKeys("Spa-Pw-1");
    const r = await rectOf("#go");
    await clickAt(r.x + r.w / 2, r.y + r.h / 2);
  };

  await typeAndGo("http://spaok.localhost:8111/spa-login.html?result=ok");
  await driver.wait(hostShown, 8000);
  await closeTabs();

  await typeAndGo("http://spadenied.localhost:8111/spa-login.html?result=denied");
  await driver.sleep(3000);
  assert.equal(await hostShown(), false, "a 401 isn't a sign-in");
  await closeTabs();

  await typeAndGo("http://spaclose.localhost:8111/spa-login.html?result=no-request");
  await driver.sleep(3000);
  assert.equal(await hostShown(), false, "a form that goes with no request isn't one either");
  await closeTabs();
});

test("Firefox: a failed login that reloads the page isn't offered, and a username survives a real navigation", async () => {
  await driver.switchTo().window(extTab);
  await newTab("http://reloadff.localhost:8111/reload-fail.html");
  await driver.findElement(By.css("#user")).sendKeys("typo@example.com");
  await driver.findElement(By.css("#pass")).sendKeys("wrong");
  await driver.findElement(By.css("#go")).click();
  await driver.wait(until.urlContains("tried"), 10000);
  await driver.sleep(1500);
  assert.equal(await driver.executeScript(`return document.documentElement.lastElementChild.tagName === 'DIV'`), false);
  await closeTabs();

  await driver.switchTo().window(extTab);
  await newTab("http://twostepff.localhost:8111/step-user.html");
  await driver.findElement(By.css("#user")).sendKeys("step-ff@example.com");
  await driver.findElement(By.css("#next")).click();
  await driver.wait(until.urlContains("step-pass"), 10000);
  await driver.findElement(By.css("#pass")).sendKeys("Step-Ff-1");
  await driver.findElement(By.css("#go")).click();
  await driver.wait(until.urlContains("welcome"), 10000);
  await driver.sleep(1500);
  const pending = await extEval(`async () => (await browser.storage.session.get("pendingSave")).pendingSave`);
  const offer = pending.find((p) => p.offer.host === "twostepff.localhost");
  assert.equal(offer.offer.username, "step-ff@example.com");
  await closeTabs();
});

test("Firefox: route changes reach the frame, by webNavigation and by hash", async () => {
  for (const how of ["push", "hash"]) {
    await driver.switchTo().window(extTab);
    await newTab(siteA("spa-routes.html"));
    await driver.sleep(500);
    await driver.executeScript(`window.__toSignIn(arguments[0])`, how);
    const url = await driver.getCurrentUrl();
    const id = await tabId(url);
    let roles = [];
    for (let i = 0; i < 16 && !roles.includes("password"); i++) {
      await driver.sleep(500);
      roles = (await hook("reports", { tabId: id })).report?.roles ?? [];
    }
    assert.ok(roles.includes("password"), `${how}: ${JSON.stringify(roles)}`);
    await closeTabs();
  }
});

test("Firefox: a card in frames fills each frame's own box, after naming the other origin", async () => {
  await hook("addCard", { title: "Fox Visa", cardNumber: "4111111111111111", cardCvv: "123" });
  await driver.switchTo().window(extTab);
  const url = `http://shopff.localhost:8111/card-frames.html?at=${encodeURIComponent("http://paymentsff.localhost:8111")}`;
  const pg = await newTab(url);
  await driver.sleep(800);
  await popup(url);
  await fill(driver, By.css('input[aria-label="Search your vault"]'), "Fox Visa");
  await click(driver, button("Fill Fox Visa"));
  await see(driver, byText("http://paymentsff.localhost:8111"));
  await click(driver, button("Fill anyway"));
  await driver.sleep(1000);
  await driver.switchTo().window(pg);
  const valueIn = async (id) => {
    await driver.switchTo().frame(await driver.findElement(By.css(`#f-${id}`)));
    const v = await driver.executeScript(`return window.__value()`);
    await driver.switchTo().defaultContent();
    return v;
  };
  assert.equal(await valueIn("number"), "4111111111111111");
  assert.equal(await valueIn("cvc"), "123");
  await closeTabs();
});

test("Firefox: a mail code from the toolbar fills the sender's own site as text", async () => {
  execFileSync("docker", ["exec", "-i", "PromptlyPw-Backend", "python"], {
    encoding: "utf8",
    input: `
import asyncio, uuid
from datetime import datetime, timezone
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${ffUserId}")
        acc = await db.scalar(select(MailAccount).where(MailAccount.user_id == uid))
        if acc is None:
            acc = MailAccount(user_id=uid, email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
            db.add(acc)
            await db.flush()
            db.add(MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox"))
            await db.flush()
        folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == acc.id, MailFolder.role == "inbox"))
        db.add(MailMessage(account_id=acc.id, folder_id=folder.id, uid=int(datetime.now().timestamp()*1000) % 2000000000, thread_key=uuid.uuid4().hex, subject="Your verification code", from_name="Fox", from_addr="no-reply@foxcodes.localhost", sent_at=datetime.now(timezone.utc), body_text="Your code is 615204"))
        await db.commit()
asyncio.run(main())
`,
  });
  await extEval("() => browser.runtime.sendMessage({ t: 'setMailCodes', on: true })");
  const url = "http://foxcodes.localhost:8111/otp.html";
  const pg = await newTab(url);
  await driver.sleep(800);
  await popup(url);
  await click(driver, button("Fill code from foxcodes.localhost"));
  await driver.sleep(800);
  await driver.switchTo().window(pg);
  assert.deepEqual(await driver.executeScript("return window.__state()"), { code: "615204" });
  await extEval("() => browser.runtime.sendMessage({ t: 'setMailCodes', on: false })");
  await closeTabs();
});

test("Firefox: auto-lock settings reach the background, and a long gap between alarms locks", async () => {
  await openSettings();
  await setNumber(By.xpath(`//label[.//span[normalize-space(.)="Lock after this many idle minutes"]]//input`), 37);
  const at = await extEval(`async () => { await browser.runtime.sendMessage({ t: "activity" }); return (await browser.alarms.get("autolock")).scheduledTime; }`);
  const minutes = (at - Date.now()) / 60000;
  assert.ok(minutes > 36 && minutes <= 37.1, String(minutes));
  await setNumber(By.xpath(`//label[.//span[normalize-space(.)="Lock after this many idle minutes"]]//input`), 15);

  // Firefox doesn't report "locked" from the idle API, so this is how sleep shows up here.
  assert.equal((await hook("sleepGap", { ms: 60 * 1000 })).unlocked, true);
  assert.equal((await hook("sleepGap", { ms: 10 * 60 * 1000 })).unlocked, false);
  assert.equal(await signedIn(), false);

  // Windows Hello isn't offered with no desktop app.
  await driver.switchTo().window(extTab);
  await see(driver, byText("Your vault is locked"), 30000);
  const before = await driver.getAllWindowHandles();
  await extEval("(u) => browser.tabs.create({ url: u })", `${EXT}/popup.html`);
  await driver.wait(async () => (await driver.getAllWindowHandles()).length > before.length, 15000);
  await driver.switchTo().window((await driver.getAllWindowHandles()).find((x) => !before.includes(x)));
  await see(driver, By.css('input[aria-label="Master password"]'));
  await driver.sleep(500);
  assert.equal((await driver.findElements(button("Use Windows Hello"))).length, 0);
  await closeTabs();

  await fill(driver, labelled("Master password"), MASTER);
  await click(driver, button("Unlock"));
  await see(driver, By.css('nav[aria-label="Passwords"]'), 60000);
});
