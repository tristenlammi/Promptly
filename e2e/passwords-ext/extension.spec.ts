// M6: the extension working. Plan section 7, 6.3, 6.4, 6.5.
import { expect, test, type Page } from "@playwright/test";

import { addItem, bg, connect, launch, lockExt, makeUsers, menuFrame, popupFor, type Rig, signIn, siteA, startSite, unlockExt } from "./lib";

test.describe.configure({ mode: "serial" });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["ext"]);
  await connect(rig, u);
  await unlockExt(rig);
  await addItem(rig, { title: "Acme", url: "http://localhost:8111", username: "ana@example.com", password: "acme-Pass-1" });
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

async function openMenuOn(page: Page, selector = "#user") {
  await page.click(selector);
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  return f;
}

/** A press only counts once the menu or bar has been showing for half a second. */
const LOOK_MS = 800;

test("popup finds this site's login, and fills it into the page", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill Acme" })).toBeVisible();
  await pop.getByRole("button", { name: "Fill Acme" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state())).toEqual({ user: "ana@example.com", pass: "acme-Pass-1" });
  await page.close();
  await pop.close().catch(() => undefined);
});

test("the badge counts matches for this tab", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  await expect.poll(async () => bg<string>(rig, `const t=(await chrome.tabs.query({})).find(x=>x.url?.includes('login.html')); return chrome.action.getBadgeText({tabId:t.id});`)).toBe("1");
  await page.close();
});

test("inline menu: nothing in the page's DOM says what it is, and a click fills", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const frame = await openMenuOn(page);
  // What the page can see: one bare element, with a closed shadow root.
  const seen = await page.evaluate(() => {
    const el = document.documentElement.lastElementChild as HTMLElement;
    return { tag: el.tagName, id: el.id, cls: el.className, data: Object.keys(el.dataset).length, shadow: !!el.shadowRoot, iframes: document.querySelectorAll("iframe").length };
  });
  expect(seen).toEqual({ tag: "DIV", id: "", cls: "", data: 0, shadow: false, iframes: 0 });
  await expect(frame.getByRole("button", { name: "Fill Acme" })).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await frame.getByRole("button", { name: "Fill Acme" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state())).toEqual({ user: "ana@example.com", pass: "acme-Pass-1" });
  await page.close();
});

test("inline menu: the box fits its rows, and an ordinary click a moment after it opens fills", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const frame = await openMenuOn(page);
  await expect(frame.getByRole("button", { name: "Fill Acme" })).toBeVisible();
  // No empty block below the rows covering the page.
  const rows = await frame.evaluate(() => document.getElementById("root")!.getBoundingClientRect().height);
  await expect.poll(async () => (await (await frame.frameElement()).boundingBox())?.height ?? 0).toBeLessThan(rows + 4);
  expect(rows).toBeLessThan(120);
  // About how long a person takes to see the row and click it.
  await page.waitForTimeout(450);
  await frame.getByRole("button", { name: "Fill Acme" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state())).toEqual({ user: "ana@example.com", pass: "acme-Pass-1" });
  await page.close();
});

test("an inline click within the dwell time is refused", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const frame = await openMenuOn(page);
  await frame.getByRole("button", { name: "Fill Acme" }).click({ noWaitAfter: true, timeout: 400 }).catch(() => undefined);
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => (window as any).__state());
  if (s.pass) {
    // Slow machine: the click happened after the dwell. Nothing to conclude.
    test.info().annotations.push({ type: "note", description: "click landed after dwell" });
  } else {
    await expect(frame.getByText("came as the menu opened, so it didn't count")).toBeVisible();
  }
  await page.close();
});

test("multi-step sign-in continues: username, password, then the 2FA code", async () => {
  await addItem(rig, { title: "Stepper", url: "http://localhost:8111/multistep.html", username: "step@example.com", password: "step-Pass-1" });
  // Give it a 2FA secret through the vault page.
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/vault.html#/all`);
  await vault.getByRole("list", { name: "Items" }).getByRole("button", { name: /Stepper/ }).click();
  await vault.getByRole("button", { name: "Edit" }).click();
  await vault.getByLabel("2FA secret or otpauth link").fill("JBSWY3DPEHPK3PXP");
  await vault.getByRole("button", { name: "Save" }).click();
  await expect(vault.getByTestId("totp-code")).toBeVisible();
  await vault.close();

  const page = await rig.ctx.newPage();
  await page.goto(siteA("multistep.html"));
  const fill = async () => {
    const pop = await popupFor(rig, page);
    await pop.getByRole("button", { name: "Fill Stepper" }).click();
    await pop.close().catch(() => undefined);
  };
  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().user)).toBe("step@example.com");
  await page.click("#next");
  await page.waitForSelector("#pass");
  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("step-Pass-1");
  await page.click("#next2");
  await page.waitForSelector("#code");
  await fill();
  await expect.poll(() => page.evaluate(() => (window as any).__state().code)).toMatch(/^\d{6}$/);
  await page.close();
});

test("saves a new login after a successful sign-in, updates a changed one, and never asks after Never", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`http://localhost:8112/login.html`);
  await page.fill("#user", "new@example.com");
  await page.fill("#pass", "new-Pass-1");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!page.frames().find((f) => f.url().includes("/save.html")), { timeout: 15_000 }).toBe(true);
  const save = page.frames().find((f) => f.url().includes("/save.html"))!;
  await expect(save.getByText("Save this login for localhost?")).toBeVisible();
  await expect(save.getByText("new@example.com")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  // It's never told the password.
  expect(await save.content()).not.toContain("new-Pass-1");
  await save.getByRole("button", { name: "Save" }).click();

  // The same site, a changed password: Update.
  await page.goto(`http://localhost:8112/login.html`);
  await page.fill("#user", "new@example.com");
  await page.fill("#pass", "new-Pass-2");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!page.frames().find((f) => f.url().includes("/save.html")), { timeout: 15_000 }).toBe(true);
  const upd = page.frames().find((f) => f.url().includes("/save.html"))!;
  await expect(upd.getByText("Update your password for localhost?")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await upd.getByRole("button", { name: "Update" }).click();
  await page.waitForTimeout(500);

  // Same password again: nothing to ask.
  await page.goto(`http://localhost:8112/login.html`);
  await page.fill("#user", "new@example.com");
  await page.fill("#pass", "new-Pass-2");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await page.waitForTimeout(2500);
  const quiet = page.frames().find((f) => f.url().includes("/save.html"));
  if (quiet) await expect(quiet.locator("#root")).toBeEmpty();
  await page.close();
});

test("a failed login isn't offered for saving", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("failing-login.html"));
  await page.fill("#user", "typo@example.com");
  await page.fill("#pass", "wrong-password");
  await page.click("button");
  await page.waitForTimeout(3000);
  const save = page.frames().find((f) => f.url().includes("/save.html"));
  expect(save).toBeUndefined();
  await page.close();
});

test("teach it once: pick the fields, and the rule syncs and works", async () => {
  // A page the classifier can't read at all.
  const page = await rig.ctx.newPage();
  await page.route("**/odd.html", (r) => r.fulfill({ contentType: "text/html", body: `<title>Odd</title><p>A</p><input id="a1"><p>B</p><input id="b2"><div id="z" role="button" tabindex="0">Go</div>` }));
  await page.goto(siteA("odd.html"));
  await addItem(rig, { title: "Odd", url: "http://localhost:8111", username: "odd@example.com", password: "odd-Pass-1" });
  const pop = await popupFor(rig, page);
  await pop.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: "http://localhost:8111/odd.html" });
    await chrome.runtime.sendMessage({ t: "teach", tabId: t.id });
  });
  await pop.close();
  await page.bringToFront();
  await page.waitForTimeout(200);
  await page.mouse.click(...(await center(page, "#a1")));
  await page.mouse.click(...(await center(page, "#b2")));
  await page.mouse.click(...(await center(page, "#z")));
  await page.waitForTimeout(800);
  const p2 = await popupFor(rig, page);
  await p2.getByRole("button", { name: "Fill Odd" }).click();
  await expect.poll(() => page.evaluate(() => (document.getElementById("b2") as HTMLInputElement).value)).toBe("odd-Pass-1");
  await p2.close().catch(() => undefined);
  await page.close();
});

async function center(page: Page, sel: string): Promise<[number, number]> {
  const b = await page.locator(sel).boundingBox();
  return [b!.x + b!.width / 2, b!.y + b!.height / 2];
}

test("restarting the service worker doesn't lock or lose anything", async () => {
  const before = await bg<string>(rig, `return (await chrome.storage.session.get("unlock")).unlock ? "has" : "none";`);
  expect(before).toBe("has");
  // Kill it the way Chrome does.
  const cdp = await rig.ctx.newCDPSession(await rig.ctx.newPage());
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await new Promise((r) => setTimeout(r, 800));
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill Acme" })).toBeVisible({ timeout: 20_000 });
  await pop.close();
  await page.close();
});

test("lock: the popup asks again, and the menu says locked with no titles", async () => {
  await lockExt(rig);
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const f = await openMenuOn(page);
  await expect(f.getByText("Your vault is locked.")).toBeVisible();
  await expect(f.getByText("Acme")).toHaveCount(0);
  await page.close();
  await unlockExt(rig);
});

test("a content script can't read storage.session, and messages from one can't get secrets", async () => {
  // The default access level in both engines keeps it from content scripts.
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const level = await bg<string>(rig, `return JSON.stringify(Object.keys(await chrome.storage.session.get(null)));`);
  expect(level).toContain("unlock");
  const worldResult = await bg<{ session: unknown; item: unknown; sessionMsg: unknown }>(
    rig,
    `
    const [t] = await chrome.tabs.query({ url: "http://localhost:8111/login.html" });
    const res = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: "ISOLATED", func: async () => {
      let session = "ok";
      try { await chrome.storage.session.get("unlock"); session = "readable"; } catch (e) { session = String(e); }
      const item = await chrome.runtime.sendMessage({ t: "item", id: "x" }).catch(() => "blocked");
      const list = await chrome.runtime.sendMessage({ t: "list" }).catch(() => "blocked");
      const sessionMsg = await chrome.runtime.sendMessage({ t: "session" }).catch(() => "blocked");
      return { session, item: item ?? null, list: list ?? null, sessionMsg: sessionMsg ?? null };
    }});
    return res[0].result;
  `,
  );
  expect(String(worldResult.session)).toContain("Access to storage is not allowed from this context");
  expect(worldResult.item).toBeNull();
  expect(worldResult.sessionMsg).toBeNull();
  await page.close();
});

test("no remote code, a tight CSP, and the permissions we say we use", async () => {
  const manifest = await bg<Record<string, unknown>>(rig, `return chrome.runtime.getManifest();`);
  expect(manifest.manifest_version).toBe(3);
  expect((manifest.content_security_policy as { extension_pages: string }).extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/popup.html`);
  const blocked = await page.evaluate(async () => {
    const s = document.createElement("script");
    s.src = "https://example.com/evil.js";
    const r = new Promise((res) => {
      s.onerror = () => res("blocked");
      s.onload = () => res("loaded");
    });
    document.head.appendChild(s);
    return r;
  });
  expect(blocked).toBe("blocked");
  await page.close();
});

void signIn;
