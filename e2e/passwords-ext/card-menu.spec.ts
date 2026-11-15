// Cards in the menu on the page (D137): a card box lists your cards and never says "no
// saved logins"; a pick opens the panel, which asks before it fills; and a box in a frame
// too small to show the menu (a hosted card field) gets its menu drawn, whole, by the
// frame around it.
import { expect, type Page, test } from "@playwright/test";

import { connect, launch, makeUsers, menuFrame, popupFor, type Rig, siteA, startSite, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 240_000 });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [owner] = makeUsers(["cardy"]);
  await connect(rig, owner);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** A press only counts once the menu has been showing for a moment (D77). */
const LOOK_MS = 800;
const PAY = "http://payments.localhost:8112";
const shop = (query = "") => `http://shop.localhost:8111/card-frames.html?at=${encodeURIComponent(PAY)}${query}`;

type ItemOut = { id: string; title: string };
const patch = (id: string, change: Record<string, unknown>) => testHook(rig, "patchItem", { id, patch: change });

async function menuOn(page: Page, press: () => Promise<void>) {
  await press();
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  return f;
}

const numberBox = (page: Page) => page.frameLocator("#f-number").locator("#box");
const valueIn = (page: Page, part: string) => page.frames().find((f) => f.url().includes(part))!.evaluate(() => (window as any).__value());

test("with no cards saved, a card box says so, and doesn't talk about logins", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("card.html"));
  const f = await menuOn(page, () => page.click("#num"));
  await expect(f.getByText("No saved cards.")).toBeVisible();
  await expect(f.getByText("No saved logins for this site.")).toHaveCount(0);
  await expect(f.getByRole("button", { name: "Open Promptly Passwords to add one" })).toBeVisible();
  await page.close();
});

test("a card box lists your cards; a pick fills nothing and puts the card at the top of the panel, which asks", async () => {
  await testHook(rig, "addCard", { title: "Shop Visa", cardNumber: "4111111111111111", cardCvv: "123" });
  const it = (await testHook<ItemOut[]>(rig, "items")).find((i) => i.title === "Shop Visa")!;
  await patch(it.id, { cardBrand: "Visa", cardholder: "Ana Example", cardExpMonth: "12", cardExpYear: "2031" });

  const page = await rig.ctx.newPage();
  await page.goto(siteA("card.html"));
  const f = await menuOn(page, () => page.click("#num"));
  await expect(f.getByRole("button", { name: "Pick Shop Visa" })).toBeVisible();
  // The brand and the last four digits, and never the number.
  await expect(f.getByText("Visa ending 1111")).toBeVisible();
  await expect(f.locator("body")).not.toContainText("4111");
  await expect(f.getByText("No saved logins for this site.")).toHaveCount(0);
  await page.waitForTimeout(LOOK_MS);
  await f.getByRole("button", { name: "Pick Shop Visa" }).click();
  await expect(f.getByText(/Shop Visa (is at the top of the Promptly Passwords panel|will be at the top)/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__state().num)).toBe("");

  const pop = await popupFor(rig, page);
  const picked = pop.getByTestId("handoff");
  await expect(picked).toContainText("Shop Visa");
  await picked.getByRole("button", { name: "Fill Shop Visa" }).click();
  await expect(pop.getByRole("alertdialog")).toContainText("card");
  expect(await page.evaluate(() => (window as any).__state().num)).toBe("");
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().num)).toBe("4111111111111111");
  await pop.close().catch(() => undefined);
  await page.close();
});

test("a hosted card box in its own small frame: the page around it draws the menu, whole", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(shop());
  await page.waitForTimeout(500);
  const f = await menuOn(page, () => numberBox(page).click());
  // Drawn by the top page, not squeezed into the 70 px frame the box is in.
  expect(f.parentFrame()).toBe(page.mainFrame());
  await expect(f.getByRole("button", { name: "Pick Shop Visa" })).toBeVisible();
  await expect(f.getByText("No saved logins for this site.")).toHaveCount(0);
  const menuBox = (await (await f.frameElement()).boundingBox())!;
  const frameBox = (await page.locator("#f-number").boundingBox())!;
  expect(menuBox.height).toBeGreaterThanOrEqual(60);
  // Under the box, inside the frame's own left and right edges.
  expect(menuBox.y).toBeGreaterThan(frameBox.y);
  expect(menuBox.y).toBeLessThan(frameBox.y + frameBox.height + 20);
  expect(menuBox.x).toBeGreaterThanOrEqual(frameBox.x - 2);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(860);

  await page.waitForTimeout(LOOK_MS);
  await f.getByRole("button", { name: "Pick Shop Visa" }).click();
  await expect(f.getByText(/Shop Visa (is at the top|will be at the top)/)).toBeVisible();
  expect(await valueIn(page, "field=number")).toBe("");

  // The panel names the frames' own origin before anything goes there (D43), and then
  // each frame gets its own box.
  const pop = await popupFor(rig, page);
  await pop.getByTestId("handoff").getByRole("button", { name: "Fill Shop Visa" }).click();
  await expect(pop.getByRole("alertdialog")).toContainText(PAY);
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  await expect.poll(() => valueIn(page, "field=number")).toBe("4111111111111111");
  expect(await valueIn(page, "field=cvc")).toBe("123");
  expect(await valueIn(page, "field=exp")).toMatch(/^12\s?\/\s?31$/);
  await pop.close().catch(() => undefined);
  await page.close();
});

test("the menu a bigger frame drew goes away when the box loses focus", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(shop());
  await page.waitForTimeout(500);
  await menuOn(page, () => numberBox(page).click());
  // A press on the page itself, away from any box.
  await page.click("h1");
  await expect.poll(() => !!menuFrame(page), { timeout: 5_000 }).toBe(false);
  await page.close();
});

test("one frame for the whole card, a single row tall: the same, and every box in it fills", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(shop("&layout=one"));
  await page.waitForTimeout(500);
  const f = await menuOn(page, () => numberBox(page).click());
  expect(f.parentFrame()).toBe(page.mainFrame());
  await expect(f.getByRole("button", { name: "Pick Shop Visa" })).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await f.getByRole("button", { name: "Pick Shop Visa" }).click();
  const pop = await popupFor(rig, page);
  await pop.getByTestId("handoff").getByRole("button", { name: "Fill Shop Visa" }).click();
  await pop.getByRole("button", { name: "Fill anyway" }).click();
  const all = () => page.frames().find((x) => x.url().includes("field=all"))!.evaluate(() => (window as any).__all());
  await expect.poll(async () => (await all()).number).toBe("4111111111111111");
  expect((await all()).cvc).toBe("123");
  expect((await all()).exp).toMatch(/^12\s?\/\s?31$/);
  await pop.close().catch(() => undefined);
  await page.close();
});

test("a box two small frames down: the menu is passed up to the first frame with room", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(shop("&layout=nested"));
  await page.waitForTimeout(800);
  const box = page.frameLocator("#f-number").frameLocator("#inner").locator("#box");
  const f = await menuOn(page, () => box.click());
  expect(f.parentFrame()).toBe(page.mainFrame());
  await expect(f.getByRole("button", { name: "Pick Shop Visa" })).toBeVisible();
  await page.close();
});

test("a frame that parks its box out of sight and focuses it itself can't move the menu off its own frame", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(shop("&far=1"));
  await page.waitForTimeout(500);
  const go = page.frameLocator("#f-number").locator("#go");
  // The box may not count as one a person could have chosen, and then there's no menu at
  // all. If there is one, it sits against the frame, not 3000 px down or 900 px across.
  await go.click();
  await page.waitForTimeout(1500);
  const f = menuFrame(page);
  if (f) {
    expect(f.parentFrame()).toBe(page.mainFrame());
    const menuBox = (await (await f.frameElement()).boundingBox())!;
    const frameBox = (await page.locator("#f-number").boundingBox())!;
    expect(menuBox.y).toBeLessThanOrEqual(frameBox.y + frameBox.height + 12);
    expect(menuBox.x).toBeLessThanOrEqual(frameBox.x + frameBox.width);
    expect(menuBox.x).toBeGreaterThanOrEqual(frameBox.x - 2);
  }
  await page.close();
});
