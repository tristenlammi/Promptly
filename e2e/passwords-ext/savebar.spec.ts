// The save bar as a person sees it: in dark mode, on a page that's busy when it opens,
// and when what it was going to ask about has gone.
import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { bg, connect, launch, makeUsers, menuFrame, type Rig, startSite, tabIdOf, unlockExt } from "./lib";

test.describe.configure({ timeout: 240_000 });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [owner] = makeUsers(["bar"]);
  await connect(rig, owner);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** Set to a folder to keep the pictures the colours are read from. */
const SHOTS = process.env.SAVEBAR_SHOTS;
const saveFrame = (page: Page) => page.frames().find((f) => f.url().includes("/save.html"));

async function typeLogin(page: Page, user: string, pass: string) {
  await page.locator("#user").pressSequentially(user);
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially(pass);
  await page.keyboard.press("Escape");
}

type Rgb = [number, number, number];

/** The colours at some points of the page as drawn, read from a screenshot. */
async function coloursAt(page: Page, points: [number, number][], name: string): Promise<Rgb[]> {
  const shot = await page.screenshot();
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, name), shot);
  const reader = await rig.ctx.newPage();
  try {
    return await reader.evaluate(
      async ({ b64, points }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)) as [number, number, number]);
      },
      { b64: shot.toString("base64"), points },
    );
  } finally {
    await reader.close();
  }
}

const dark = ([r, g, b]: Rgb) => r + g + b < 240;
const light = ([r, g, b]: Rgb) => r + g + b > 600;

/** The bar is 360 by 150, 12px from the top right of a 1280-wide page. Its card is
 *  shorter than that, so the strip along the bottom of the box is the page showing through. */
const UNDER_CARD: [number, number][] = [[920, 156], [1100, 158], [1260, 157]];

async function signInTo(page: Page, url: string, user: string) {
  await page.goto(url);
  await typeLogin(page, user, "Bar-Pw-1");
  await page.click("#go");
  await page.waitForURL(/welcome/);
}

for (const scheme of ["light", "dark"] as const) {
  test(`the save bar is a card and nothing else, with the computer set to ${scheme}`, async () => {
    const page = await rig.ctx.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await signInTo(page, `http://bar${scheme}.localhost:8111/login.html`, `${scheme}@example.com`);
    await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
    const save = saveFrame(page)!;
    await expect(save.getByText(`Save this login for bar${scheme}.localhost?`)).toBeVisible();
    await expect(save.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    // The page is white. Around the card it still is: the frame draws no backdrop of its own.
    const around = await coloursAt(page, UNDER_CARD, `savebar-${scheme}.png`);
    for (const c of around) expect(light(c), `the page shows through under the card (${c})`).toBe(true);
    // And the card itself follows the computer's setting.
    const [card] = await coloursAt(page, [[1240, 30]], `savebar-${scheme}-card.png`);
    expect(scheme === "dark" ? dark(card) : light(card), `the card is ${scheme} (${card})`).toBe(true);
    await page.close();
  });
}

test("the inline menu draws no backdrop in dark mode either", async () => {
  const page = await rig.ctx.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("http://barmenu.localhost:8111/login.html");
  await page.click("#pass");
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  await menuFrame(page)!.waitForLoadState();
  await page.waitForTimeout(800);
  const box = await page.evaluate(() => {
    const r = document.getElementById("pass")!.getBoundingClientRect();
    return { left: r.left, bottom: r.bottom };
  });
  // Far to the right of the menu (it's 320 wide), level with it.
  const [beside] = await coloursAt(page, [[Math.round(box.left) + 500, Math.round(box.bottom) + 20]], "savebar-menu-dark.png");
  expect(light(beside), `the page shows beside the menu (${beside})`).toBe(true);
  await page.close();
});

test("a page that's busy as the bar opens still gets the question", async () => {
  const page = await rig.ctx.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await signInTo(page, "http://barbusy.localhost:8111/login-busy.html", "busy@example.com");
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(4000);
  await coloursAt(page, [[1, 1]], "savebar-busy.png");
  await expect(saveFrame(page)!.getByText("Save this login for barbusy.localhost?")).toBeVisible({ timeout: 15_000 });
  await page.close();
});

test("a bar with nothing to ask goes away, and leaves the page's own buttons pressable", async () => {
  const page = await rig.ctx.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("http://bargone.localhost:8111/login-busy.html");
  await typeLogin(page, "gone@example.com", "Bar-Pw-1");
  const tabId = await tabIdOf(rig, page);
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  await bg(rig, `const all = (await chrome.storage.session.get("pendingSave")).pendingSave ?? []; await chrome.storage.session.set({ pendingSave: all.filter((p) => p.tabId !== arg) });`, tabId);
  await coloursAt(page, [[1, 1]], "savebar-gone.png");
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(false);
  await page.click("#under", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __pressed?: number }).__pressed)).toBe(1);
  await page.close();
});
