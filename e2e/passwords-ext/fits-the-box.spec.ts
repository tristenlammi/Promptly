// The menu on the page offers what fits the box it's on, and nothing on a box that isn't
// ours: a "dd/mm/yyyy" date isn't a card's expiry, a sign-in box isn't offered cards because
// the page has a card form further down, and a card box isn't told about logins.
import { expect, type Page, test } from "@playwright/test";

import { connect, launch, makeUsers, menuFrame, type Rig, siteA, startSite, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 240_000 });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [owner] = makeUsers(["fits"]);
  await connect(rig, owner);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

async function menuOn(page: Page, box: string) {
  await page.click(box);
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  return f;
}

test("a date box gets no menu at all", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("rental.html"));
  // The menu does come up on this page: on the card box.
  const f = await menuOn(page, "#num");
  await expect(f.getByText("No saved cards.")).toBeVisible();
  for (const box of ["#started", "#finished", "#dob"]) {
    await page.click(box);
    await page.waitForTimeout(1500);
    expect(!!menuFrame(page), `${box} is offered something`).toBe(false);
  }
  await page.close();
});

test("a sign-in box is offered logins only, and a card box cards only, on the same page", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("rental.html"));
  const login = await menuOn(page, "#user");
  await expect(login.getByText("No saved logins for this site.")).toBeVisible();
  await expect(login.getByText("No saved cards.")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const card = await menuOn(page, "#num");
  await expect(card.getByText("No saved cards.")).toBeVisible();
  await expect(card.getByText("No saved logins for this site.")).toHaveCount(0);
  await page.close();
});
