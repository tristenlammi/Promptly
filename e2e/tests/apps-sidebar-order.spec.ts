import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** Apps → Edit: the apps pinned to the sidebar can be put in order, by mouse or
 *  keyboard, without unpinning them. */

const NAMES = ["Rooms", "Calendar", "Maps"];
const sidebarOrder = (page: Page) =>
  page.evaluate((names) => {
    // A row's name without its count badge (unread Rooms, say).
    const name = (a: HTMLAnchorElement) => {
      const copy = a.cloneNode(true) as HTMLAnchorElement;
      copy.querySelectorAll("[data-badge]").forEach((b) => b.remove());
      return copy.textContent?.trim() ?? "";
    };
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(
      (a) => a.getBoundingClientRect().width > 0 && names.includes(name(a)),
    );
    return links.map(name);
  }, NAMES);

test("the sidebar's apps can be put in order from Edit", async ({ alice: page }) => {
  await page.goto("/apps");
  await page.getByRole("button", { name: "Edit" }).click();
  // Start from an empty sidebar list: a run that stopped part way (this one
  // or another that pins apps) can leave apps pinned.
  const offs = page.getByRole("region", { name: "Sidebar order" }).getByRole("button", { name: /^Take .* off the sidebar$/ });
  for (let n = await offs.count(); n > 0; n--) {
    await offs.first().click();
    await expect(offs).toHaveCount(n - 1);
  }
  for (const name of NAMES) await page.getByRole("button", { name: `Show ${name} in the sidebar` }).click();
  const list = page.getByRole("region", { name: "Sidebar order" });
  await expect(list.getByRole("button", { name: /^Move / })).toHaveCount(3);
  await expect.poll(() => sidebarOrder(page)).toEqual(["Rooms", "Calendar", "Maps"]);

  try {
    // By mouse: Maps to the top.
    const from = (await list.getByRole("button", { name: "Move Maps" }).boundingBox())!;
    const to = (await list.getByRole("button", { name: "Move Rooms" }).boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 10, { steps: 5 });
    await page.mouse.move(to.x + 40, to.y + 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => sidebarOrder(page)).toEqual(["Maps", "Rooms", "Calendar"]);

    // By keyboard: Rooms down one.
    await list.getByRole("button", { name: "Move Rooms" }).focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await page.keyboard.press("Space");
    await page.waitForTimeout(250);
    await expect.poll(() => sidebarOrder(page)).toEqual(["Maps", "Calendar", "Rooms"]);

    // Using the list doesn't close Edit, and the order is saved.
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
    await page.waitForTimeout(500);
    await page.reload();
    await expect.poll(() => sidebarOrder(page)).toEqual(["Maps", "Calendar", "Rooms"]);

    // Taking one off from the list.
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Take Calendar off the sidebar" }).click();
    await expect.poll(() => sidebarOrder(page)).toEqual(["Maps", "Rooms"]);
  } finally {
    // Leave the shared test account as it was.
    await page.goto("/apps");
    await page.getByRole("button", { name: "Edit" }).click();
    for (const name of NAMES) {
      const row = page.getByRole("button", { name: `Take ${name} off the sidebar` });
      if (await row.count()) await row.click();
    }
  }
});
