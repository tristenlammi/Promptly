// The web vault on real Firefox (M3), including offline through a proxy we can stop.
//   cd e2e && node --test passwords-firefox/vault.test.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { By, until } from "selenium-webdriver";

import { addLogin, BASE, button, byText, click, fill, labelled, makeUsers, MASTER, newFirefox, onboard, see, signIn, startProxy, unlock } from "./lib.mjs";

let driver;
before(async () => {
  makeUsers(["root"], "admin");
  driver = await newFirefox();
  console.log("Firefox", (await driver.getCapabilities()).get("browserVersion"));
});
after(async () => {
  await driver?.quit();
});

async function freshProfile(user) {
  await driver.get(`${BASE}/favicon.png`);
  await driver.manage().deleteAllCookies();
  await driver.executeAsyncScript(`
    const done = arguments[0];
    (async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name);
      done();
    })();
  `);
  await signIn(driver, user);
}

test("onboarding, items with 2FA, lock, unlock, wrong password", async () => {
  const [u] = makeUsers(["items"]);
  await freshProfile(u);
  const secret = await onboard(driver);
  assert.match(secret, /^PWK1-/);
  await addLogin(driver, { title: "Firefox Item", username: "ana", password: "ff-Pass-1", url: "https://example.com", otp: "JBSWY3DPEHPK3PXP" });
  const code = await see(driver, By.css('[data-testid="totp-code"]'));
  await driver.wait(async () => /^\d{3} \d{3}$/.test(await code.getText()), 5000);
  assert.ok(!(await driver.getPageSource()).includes("ff-Pass-1"), "a secret stays out of the page until asked for");

  await driver.navigate().refresh();
  await fill(driver, labelled("Master password"), "not the password");
  await click(driver, button("Unlock"));
  await see(driver, byText("isn't right"), 60000);
  await unlock(driver);
  await click(driver, byText("Firefox Item", "button"));
  await click(driver, button("Show Password"));
  await see(driver, byText("ff-Pass-1"));
});

test("Argon2 WASM runs under the real CSP, and inline script doesn't", async () => {
  const [u] = makeUsers(["csp"]);
  await freshProfile(u);
  await driver.get(`${BASE}/passwords`);
  await see(driver, byText("I understand", "label"));
  const out = await driver.executeAsyncScript(`
    const done = arguments[0];
    (async () => {
      window.__ran = false;
      const s = document.createElement("script");
      s.textContent = "window.__ran = true";
      document.head.appendChild(s);
      let wasm = "ok";
      try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); } catch (e) { wasm = String(e); }
      let connect = "allowed";
      try { await fetch("https://example.com/x"); } catch { connect = "blocked"; }
      done({ ran: window.__ran, wasm, connect });
    })();
  `);
  assert.equal(out.ran, false);
  assert.equal(out.wasm, "ok");
  assert.equal(out.connect, "blocked");
  await driver.get(`${BASE}/favicon.png`);
  const main = await driver.executeAsyncScript(`
    const done = arguments[0];
    fetch("/").then((r) => done(r.headers.get("content-security-policy")));
  `);
  assert.ok(!main.includes("wasm-unsafe-eval"));
});

test("a second device joins with the kit", async () => {
  const [u] = makeUsers(["join"]);
  await freshProfile(u);
  const secret = await onboard(driver);
  await addLogin(driver, { title: "Synced Item", password: "sync-1" });
  await click(driver, byText("Sync now", "button"));
  await see(driver, By.xpath('//*[@role="status"][normalize-space(.)="Synced"]'));

  await freshProfile(u);
  await driver.get(`${BASE}/passwords`);
  await click(driver, button("Use my recovery kit"));
  await fill(driver, labelled("Secret Key"), secret);
  await fill(driver, labelled("Master password"), MASTER);
  await click(driver, button("Unlock"));
  await see(driver, byText("Synced Item", "button"), 60000);
});

test("offline: with the server gone the page still loads and unlocks", async () => {
  const [u] = makeUsers(["offline"]);
  const proxy = await startProxy();
  try {
    await driver.get(`${proxy.url}/favicon.png`);
    await signIn(driver, u, proxy.url);
    await onboard(driver, proxy.url);
    await addLogin(driver, { title: "Offline Item", password: "off-Pass-1" });
    await click(driver, byText("Sync now", "button"));
    await see(driver, By.xpath('//*[@role="status"][normalize-space(.)="Synced"]'));
    // Wait for the service worker to have finished precaching and be in control.
    await driver.executeAsyncScript(`
      const done = arguments[0];
      navigator.serviceWorker.ready.then(async (reg) => {
        for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 200));
        done();
      });
    `);
    await driver.get(`${proxy.url}/passwords`);
    await see(driver, labelled("Master password"));
    assert.ok(await driver.executeScript("return !!navigator.serviceWorker.controller"), "service worker in control");

    await proxy.off();
    await driver.get(`${proxy.url}/passwords`);
    await see(driver, labelled("Master password"), 30000);
    assert.equal(await driver.getTitle(), "Passwords");
    await unlock(driver);
    await see(driver, byText("Working offline"));
    await click(driver, byText("Offline Item", "button"));
    await click(driver, button("Show Password"));
    await see(driver, byText("off-Pass-1"));
  } finally {
    await proxy.off().catch(() => undefined);
  }
  void until;
});
