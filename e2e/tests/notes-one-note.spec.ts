import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { notesReady } from "../lib/notes";

/** Promptly Notes (N1.7): one thing is called a note. A workspace's
 *  documents are Pages; Files' New → Note and its home tile, and the Ctrl+K
 *  palette's New note / New list / Record a voice note, all start a note in
 *  Notes. */

const NOTE_URL = /\/notes\/n\/[0-9a-f-]{36}/;

async function palette(page: Page, typed: string) {
  await page.goto("/today");
  await ready(page);
  await page.keyboard.press("Control+k");
  const box = page.getByPlaceholder("Search chats, notes, events, people, tasks…");
  await expect(box).toBeVisible();
  await box.fill(typed);
  return box;
}

test.describe("notes: one thing called a note", () => {
  test("a workspace offers Pages, not notes", async ({ alice: page }) => {
    await page.goto("/workspaces");
    await ready(page);
    await page.getByRole("button", { name: "New workspace" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New workspace" });
    await dialog.getByPlaceholder("e.g. Home renovation, Book draft, Client XYZ").fill(`E2E pages ${stamp}`);
    await dialog.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}/);

    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "New page", exact: true })).toBeVisible();
    // "Meeting notes" stays (it makes a page); nothing offers a "note".
    await expect(page.getByRole("menuitem", { name: /\bnote\b/i })).toHaveCount(0);
    await page.screenshot({ path: "test-results/notes-one-note-workspace-menu.png" });
    await page.getByRole("menuitem", { name: "New page", exact: true }).click();
    const tree = page.getByRole("tree", { name: "Workspace content" });
    await expect(tree.getByRole("button", { name: "Untitled page", exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("Files' New → Note and the home tile start a note in Notes", async ({ alice: page }) => {
    await notesReady(page);
    await page.goto("/files");
    await ready(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await expect(page).toHaveURL(NOTE_URL, { timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "Note text" })).toBeVisible({ timeout: 20_000 });
    const words = `From Files ${stamp}`;
    await page.getByRole("textbox", { name: "Note text" }).click();
    await page.keyboard.type(words);
    await page.getByRole("dialog", { name: words }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("article[data-note-card]").filter({ hasText: words })).toBeVisible({ timeout: 20_000 });

    await page.goto("/files/home");
    await ready(page);
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await expect(page).toHaveURL(NOTE_URL, { timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "Note text" })).toBeVisible({ timeout: 20_000 });
  });

  test("Ctrl+K: New note, New list (with its items) and Record a voice note open Notes", async ({ alice: page }) => {
    test.setTimeout(120_000);
    await notesReady(page);

    // "new list" with items: each comma is an item.
    const milk = `Milk ${stamp}`;
    await palette(page, `new list ${milk}, Bread`);
    const doRow = page.getByRole("button", { name: new RegExp(`New list: “${milk}, Bread”`) });
    await expect(doRow).toBeVisible();
    await page.screenshot({ path: "test-results/notes-one-note-palette.png" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(NOTE_URL, { timeout: 20_000 });
    const dlg = page.getByRole("dialog").filter({ has: page.getByText(milk) });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByText("Bread", { exact: true })).toBeVisible();
    await dlg.getByRole("button", { name: "Close", exact: true }).click();
    // By its own name: a Shopping list elsewhere can have a "Milk …" item too.
    await expect(page.getByRole("article", { name: milk, exact: true })).toBeVisible({ timeout: 20_000 });

    // The plain Create rows.
    await palette(page, "new note");
    await page.getByRole("button", { name: /^New note/ }).first().click();
    await expect(page).toHaveURL(NOTE_URL, { timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "Note text" })).toBeVisible({ timeout: 20_000 });

    await palette(page, "record a voice note");
    await page.getByRole("button", { name: /^Record a voice note/ }).first().click();
    await expect(page).toHaveURL(NOTE_URL, { timeout: 20_000 });
    await expect(page.getByRole("dialog", { name: "Record a voice note" })).toBeVisible({ timeout: 20_000 });
  });
});
