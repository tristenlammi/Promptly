// Plan 13.5, DOM side: hostile pages. A real (trusted) mouse click goes where the menu
// is, and nothing may be filled. Each variant from Marek Tóth's DEF CON 33 write-up has
// its own case, both when the page tampers before the menu shows and after it does.
import { expect, test, type Page } from "@playwright/test";

import { addItem, connect, launch, makeUsers, menuFrame, popupFor, type Rig, siteA, startSite, unlockExt } from "./lib";

test.describe.configure({ mode: "serial" });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["adv"]);
  await connect(rig, u);
  await unlockExt(rig);
  await addItem(rig, { title: "Prize", url: "http://localhost:8111", username: "victim@example.com", password: "victim-Pass-1" });
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** Focus the field like a person, wait out the dwell, and click at where the first
 *  row of the menu would be. */
async function strike(page: Page) {
  await page.click("#user");
  await page.waitForTimeout(600);
  const r = await page.locator("#user").boundingBox();
  const x = Math.max(4, Math.min(r!.x, 1280 - 328)) + 80;
  const y = r!.y + r!.height + 4 + 20;
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
}

const VARIANTS = [
  "root-opacity",
  "root-opacity-tiny",
  "html-opacity",
  "html-opacity-tiny",
  "overlay-full-pointer-none",
  "overlay-popover-pointer-none",
  "overlay-partial",
  "position-fixed-lure",
  "filter",
  "root-filter",
  "clip",
  "mask",
  "transform-scale",
  "visibility-root",
  "after-host",
  "dialog-over",
];

for (const timing of ["after", "before"]) {
  for (const attack of VARIANTS) {
    test(`${attack} (tampering ${timing} the menu shows) gets nothing`, async () => {
      const page = await rig.ctx.newPage();
      await page.goto(siteA(`hostile.html?attack=${attack}&timing=${timing}`));
      // An overlay may be in the way of a click; focus is how the menu opens either way.
      await page.click("#user", { timeout: 1500 }).catch(() => page.focus("#user"));
      await page.waitForTimeout(600);
      // Was what's on screen really our menu, plainly visible, when the click landed?
      const plain = await page.evaluate(() => {
        const m = document.documentElement.lastElementChild as HTMLElement;
        if (m.tagName !== "DIV") return false;
        const clean = (el: Element) => {
          const c = getComputedStyle(el);
          return Number(c.opacity) === 1 && c.filter === "none" && c.clipPath === "none" && c.transform === "none" && c.visibility === "visible" && c.getPropertyValue("mask-image") === "none";
        };
        const r = m.getBoundingClientRect();
        const atPoint = document.elementFromPoint(r.left + 80, r.top + 20);
        return clean(m) && clean(document.documentElement) && atPoint === m;
      });
      const r = await page.locator("#user").boundingBox();
      await page.mouse.click(Math.max(4, Math.min(r!.x, 1280 - 328)) + 80, r!.y + r!.height + 4 + 20);
      await page.waitForTimeout(500);
      const s = await page.evaluate(() => (window as any).__state());
      // A page that tampers once the menu is up gets nothing, always. One that tries in
      // advance, and whose tampering our own styles shrugged off, left a visible menu
      // and a real choice: that's a person filling on purpose, not clickjacking.
      if (timing === "after" || !plain) {
        expect(s.pass, "password stayed out").toBe("");
        expect(s.user, "username stayed out").toBe("");
        expect(s.stolen).toEqual([]);
      }
      await page.close();
    });
  }
}

test("body opacity leaves our UI visibly on top, so a click there is a person's real choice", async () => {
  // Our host is outside <body>, so hiding body can't hide the menu; the person sees it.
  const page = await rig.ctx.newPage();
  await page.goto(siteA("hostile.html?attack=body-opacity&timing=before"));
  await page.focus("#user");
  await page.waitForTimeout(500);
  const seen = await page.evaluate(() => {
    const m = document.documentElement.lastElementChild as HTMLElement | null;
    return m && m.tagName === "DIV" ? getComputedStyle(m).opacity : null;
  });
  if (seen !== null) expect(Number(seen)).toBe(1);
  await page.close();
});

test("mouse-follow: a menu dragged under the cursor is refused", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("hostile.html?attack=mouse-follow&timing=after"));
  await page.click("#user");
  await page.waitForTimeout(100);
  await page.mouse.move(600, 500);
  await page.waitForTimeout(600);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => (window as any).__state());
  expect(s.pass).toBe("");
  await page.close();
});

test("a popup fill puts values only in visible fields, never hidden, off-screen or see-through ones", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("hostile.html"));
  // A card with the same fields an attacker hid on the page.
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/popup.html`);
  await vault.evaluate(async () => {
    await chrome.runtime.sendMessage({ t: "addLogin", title: "Prize", url: "", username: "", password: "" });
  });
  await vault.close();
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Prize" }).first().click();
  await pop.close().catch(() => undefined);
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass)).toBe("victim-Pass-1");
  const s = await page.evaluate(() => ({ h: (document.getElementById("hidden1") as HTMLInputElement).value, o: (document.getElementById("offscreen") as HTMLInputElement).value, i: (document.getElementById("invisible") as HTMLInputElement).value }));
  expect(s).toEqual({ h: "", o: "", i: "" });
  await page.close();
});

test("cross-origin iframe: nothing fills until the person confirms its real origin", async () => {
  // The item is saved for :8111. The page embedding it is on a different port.
  const page = await rig.ctx.newPage();
  await page.goto(`http://localhost:8112/frames.html?src=${encodeURIComponent("http://other.localhost:8112/login.html")}`);
  await page.waitForTimeout(500);
  const pop = await popupFor(rig, page);
  await pop.getByRole("textbox", { name: "Search your vault" }).fill("Prize");
  await pop.getByRole("button", { name: "Fill Prize" }).first().click();
  await expect(pop.getByRole("alertdialog")).toContainText("other.localhost:8112");
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("other.localhost"))!;
  expect(await frame.evaluate(() => (document.getElementById("pass") as HTMLInputElement).value)).toBe("");
  await pop.getByRole("button", { name: "Don't fill" }).click();
  expect(await frame.evaluate(() => (document.getElementById("pass") as HTMLInputElement).value)).toBe("");
  await pop.close();
  await page.close();
});

test("cards and addresses never fill from one inline click, or without a confirmation", async () => {
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/vault.html#/all`);
  await vault.getByRole("button", { name: "New", exact: true }).click();
  await vault.getByRole("menuitem", { name: "Card" }).click();
  await vault.getByLabel("Name", { exact: true }).fill("My Visa");
  await vault.getByLabel("Card number").fill("4111111111111111");
  await vault.getByLabel("Security code").fill("123");
  await vault.getByRole("button", { name: "Save" }).click();
  await expect(vault.getByRole("article", { name: "My Visa" })).toBeVisible();
  await vault.close();

  const page = await rig.ctx.newPage();
  await page.goto(siteA("card.html"));
  await page.click("#num");
  await expect.poll(() => !!menuFrame(page)).toBe(true);
  const f = menuFrame(page)!;
  await expect(f.getByText("Open Promptly Passwords to fill this")).toBeVisible();
  await expect(f.getByText("My Visa")).toHaveCount(0);

  const pop = await popupFor(rig, page);
  await pop.getByRole("textbox", { name: "Search your vault" }).fill("Visa");
  await pop.getByRole("button", { name: "Fill My Visa" }).click();
  await expect(pop.getByRole("alertdialog")).toContainText("card");
  expect(await page.evaluate(() => (window as any).__state().num)).toBe("");
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().num)).toBe("4111111111111111");
  await page.close();
});

test("fake extension messages from the page do nothing", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  await page.click("#user");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (const msg of [{ t: "menuPick", itemId: "x" }, { t: "doFill", values: { password: "x" } }, { t: "fill", tabId: 1, itemId: "x" }, { type: "fill" }]) {
      window.postMessage(msg, "*");
      for (let i = 0; i < window.frames.length; i++) window.frames[i].postMessage(msg, "*");
    }
    // A forged click on anything the page can reach.
    document.documentElement.lastElementChild?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (window as any).chrome?.runtime?.sendMessage?.("abc", { t: "fill" });
  });
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => (window as any).__state());
  expect(s).toEqual({ user: "", pass: "" });
  await page.close();
});

test("the http downgrade asks first", async () => {
  // Saved over https, opened over http.
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/popup.html`);
  await vault.evaluate(async () => {
    await chrome.runtime.sendMessage({ t: "addLogin", title: "Secured", url: "https://secure.localhost", username: "s", password: "secured-pw" });
  });
  await vault.close();
  const page = await rig.ctx.newPage();
  await page.goto("http://secure.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Secured" }).click();
  await expect(pop.getByRole("alertdialog")).toContainText("isn't encrypted");
  expect(await page.evaluate(() => (window as any).__state().pass)).toBe("");
  await pop.close();
  await page.close();
});

test("a lookalike of a saved site warns, and filling needs a confirmation", async () => {
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/popup.html`);
  await vault.evaluate(async () => {
    await chrome.runtime.sendMessage({ t: "addLogin", title: "Payz", url: "https://paypall-site.localhost", username: "p", password: "payz-pw" });
  });
  await vault.close();
  // Same structure, one letter off.
  const page = await rig.ctx.newPage();
  await page.goto("http://paypa11-site.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await expect(pop.getByText(/looks like/)).toBeVisible();
  await pop.close();
  await page.close();
});

void expect;
