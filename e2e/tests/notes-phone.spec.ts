import { expect, stamp, test } from "../fixtures";
import { card, notesReady, scan, serverNotes } from "../lib/notes";

/** Notes at phone width (N1.2): Keep's layout — search bar with the menu,
 *  a two-column grid, + and New list at the bottom, the note as a full page. */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe("notes on a phone", () => {
  test("write a note and a list on a phone", async ({ alice: page }) => {
    const auth = await notesReady(page);

    // + opens a new note as its own page; Back keeps it.
    const t = `Phone note ${stamp}`;
    await page.getByRole("button", { name: "New note" }).click();
    await expect(page).toHaveURL(/\/notes\/n\//);
    await page.getByRole("textbox", { name: "Title" }).fill(t);
    await page.getByRole("textbox", { name: "Note text" }).click();
    await page.keyboard.type("Call the plumber about the tap");
    await page.getByRole("button", { name: "Back to notes" }).click();
    await expect(page).toHaveURL(/\/notes\/?$/);
    await expect(card(page, t)).toBeVisible();
    await expect.poll(async () => (await serverNotes(page, auth)).some((n) => n.title === t)).toBe(true);

    // Two columns side by side.
    const lefts = await page.locator("article[data-note-card]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    if (lefts.length >= 2) expect(new Set(lefts).size).toBe(2);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);

    // New list from the bottom bar.
    const list = `Hardware ${stamp}`;
    await page.getByRole("button", { name: "New list" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(list);
    await page.getByRole("textbox", { name: "New list item" }).click();
    await page.keyboard.type("Washers");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Tape");
    await page.getByRole("checkbox", { name: "Tick Washers" }).tap();
    await page.getByRole("button", { name: "Back to notes" }).click();
    await expect(card(page, list)).toContainText("Tape");
    await expect.poll(async () => (await serverNotes(page, auth)).find((n) => n.title === list)?.items_checked).toBe(1);

    // The note opens as a page; the browser's Back returns to the grid.
    await card(page, t).getByRole("button", { name: `Open ${t}` }).tap();
    await expect(page.getByRole("button", { name: "Back to notes" })).toBeVisible();
    await page.goBack();
    await expect(card(page, t)).toBeVisible();

    // The menu holds the rail: Archive.
    await page.getByRole("button", { name: "Notes menu" }).click();
    const menu = page.getByRole("dialog", { name: "Notes menu" });
    await expect(menu.getByRole("link", { name: "Trash" })).toBeVisible();
    await menu.getByRole("link", { name: "Archive" }).click();
    await expect(page.getByText("Archived notes appear here").or(page.locator("article[data-note-card]").first())).toBeVisible();

    expect(await scan(page, "phone archive", "main")).toEqual([]);
  });
});
