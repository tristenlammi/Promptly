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
    // A copy made under an earlier install's keys can't be opened ("wrong
    // password") — then the next fixed name, which later runs reuse.
    const connected = card.getByText(/^Connected — /);
    const refused = card.getByText(/^Couldn't use it: .*wrong password/);
    for (const folder of ["e2e", "e2e-2", "e2e-3", "e2e-4"]) {
      await card.getByPlaceholder("promptly").fill(folder);
      const tested = page.waitForResponse((r) => r.url().includes("/backups/offsite/test"), { timeout: 60_000 });
      await card.getByRole("button", { name: "Save and test" }).click();
      await tested;
      await expect(connected.or(refused)).toBeVisible();
      if (await connected.isVisible()) break;
    }
    await expect(connected).toBeVisible();

    await on.check();
    await card.getByRole("button", { name: "Copy now" }).click();
    await expect(card.getByText(/^OK · /).first()).toBeVisible({ timeout: 150_000 });
    await expect(card.getByText(/Last off-site copy/)).toBeVisible();

    // Leave the dev instance as it was.
    await on.uncheck();
    await expect(card.getByText(/Not a real backup yet/)).toBeVisible();
  });
});
