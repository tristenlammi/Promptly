import { expect, stamp, test } from "../fixtures";
import { card, notesReady, serverNotes } from "../lib/notes";

/** Notes with no connection (N1.2): changes show at once, wait on the
 *  device (surviving the page closing), and reach the server when the
 *  connection is back. */

test.describe("notes offline", () => {
  test("write and tick with no connection, then it syncs", async ({ alice: page }) => {
    const auth = await notesReady(page);
    const list = `Supermarket ${stamp}`;

    // A list made online.
    await page.getByRole("button", { name: "New list" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(list);
    await page.getByRole("textbox", { name: "New list item" }).click();
    await page.keyboard.type("Apples");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Rice");
    await page.getByRole("heading", { name: "Notes", exact: true }).click();
    await expect.poll(async () => (await serverNotes(page, auth)).find((n) => n.title === list)?.items.length).toBe(2);

    // No signal in the supermarket.
    await page.context().setOffline(true);
    await card(page, list).getByRole("button", { name: `Open ${list}` }).click();
    const d = page.getByRole("dialog", { name: list });
    await d.getByRole("checkbox", { name: "Tick Apples" }).check();
    await expect(d.getByText("Offline — changes will save when you're back.")).toBeVisible();
    await d.getByRole("button", { name: "Close", exact: true }).click();
    const offlineNote = `Written offline ${stamp}`;
    await page.getByRole("button", { name: "Take a note…" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(offlineNote);
    await page.getByRole("heading", { name: "Notes", exact: true }).click();
    await expect(card(page, offlineNote)).toBeVisible();
    await expect(card(page, offlineNote)).toContainText("Saved on this device");
    await expect(page.getByText(/^Offline · \d changes? waiting$/)).toBeVisible();

    // Back online: everything goes up.
    await page.context().setOffline(false);
    await expect
      .poll(async () => {
        const ns = await serverNotes(page, auth);
        const l = ns.find((n) => n.title === list);
        return `${l?.items_checked}:${ns.some((n) => n.title === offlineNote)}`;
      }, { timeout: 30_000 })
      .toBe("1:true");
    await expect(card(page, offlineNote)).not.toContainText("Saved on this device");
  });

  test("changes made offline survive closing the page", async ({ alice: page }) => {
    const auth = await notesReady(page);
    await page.context().setOffline(true);
    const t = `Kept on the device ${stamp}`;
    await page.getByRole("button", { name: "Take a note…" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(t);
    await page.getByRole("heading", { name: "Notes", exact: true }).click();
    await expect(card(page, t)).toBeVisible();
    // Give IndexedDB a moment, then close the tab while still offline.
    await page.waitForTimeout(500);
    const context = page.context();
    const again = await context.newPage();
    await page.close();
    await context.setOffline(false);
    await notesReady(again);
    await expect(card(again, t)).toBeVisible();
    await expect.poll(async () => (await serverNotes(again, auth)).some((n) => n.title === t), { timeout: 30_000 }).toBe(true);
  });
});
