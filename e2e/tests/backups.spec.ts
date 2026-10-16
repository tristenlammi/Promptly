import { expect, ready, test } from "../fixtures";

test.describe("backups", () => {
  test("off-site backup to a folder: amber until set up, then a real copy", async ({ dana: page }) => {
    // WP-2.3: every copy used to live on the machine it protects.
    test.setTimeout(180_000);
    await page.goto("/admin?tab=backups");
    await ready(page);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Off-site backup" }) });
    await expect(card).toBeVisible();

    const on = card.getByRole("checkbox", { name: "Off-site backup on" });
    if (!(await on.isChecked())) {
      await expect(card.getByText(/Not a real backup yet/)).toBeVisible();
    }

    await card.getByRole("combobox").first().selectOption("folder");
    // One folder for every run: restic de-duplicates, so repeat runs add
    // almost nothing (a fresh folder each time would pile up full copies).
    await card.getByPlaceholder("promptly").fill("e2e");
    await card.getByRole("button", { name: "Save and test" }).click();
    await expect(card.getByText(/^Connected — /)).toBeVisible({ timeout: 60_000 });

    await on.check();
    await card.getByRole("button", { name: "Copy now" }).click();
    await expect(card.getByText(/^OK · /).first()).toBeVisible({ timeout: 150_000 });
    await expect(card.getByText(/Last off-site copy/)).toBeVisible();

    // Leave the dev instance as it was.
    await on.uncheck();
    await expect(card.getByText(/Not a real backup yet/)).toBeVisible();
  });
});
