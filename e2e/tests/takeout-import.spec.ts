import { expect, ready, stamp, test } from "../fixtures";
import { takeout } from "../lib/files";

/** Moving in (WP-10.1): a Google Takeout's parts are uploaded on the Import
 *  page, read, and the dry-run report says what's in them. */

test("a Takeout's parts are uploaded and checked, and the report says what's in it", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const parts = takeout(stamp);
  await page.goto("/files/import");
  await ready(page);
  await page.getByRole("button", { name: /Google Takeout/ }).click();
  await expect(page).toHaveURL(/\/files\/import\/[0-9a-f-]{36}$/);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles(parts);
  const uploaded = page.getByRole("list", { name: "Uploaded parts" });
  await expect(uploaded.getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
  await expect(uploaded).toContainText(`takeout-${stamp}-001.zip`);

  // The archives are checked as soon as the uploads finish.
  const report = page.getByRole("region", { name: "What's in it" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status")).toHaveText("Ready to import");
  // Two photos (the album's copy is the same photo), one album, one Drive file.
  await expect(report.getByText("photos", { exact: true }).locator("..")).toContainText("2");
  await expect(report.getByText("albums", { exact: true }).locator("..")).toContainText("1");
  await expect(report.getByText("Drive files", { exact: true }).locator("..")).toContainText("1");
  await expect(report).toContainText("100% come with Google's details");
  await expect(report).toContainText("From 2018 to 2018");

  // Cancelling deletes what was uploaded.
  await page.getByRole("button", { name: "Cancel import" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel import" }).click();
  await expect(page).toHaveURL(/\/files\/import$/);
});

test("a Takeout is imported once — importing it again adds nothing", async ({ alice: page }) => {
  test.setTimeout(180_000);
  const tag = `${stamp}r`;
  const parts = takeout(tag);
  const importOnce = async () => {
    await page.goto("/files/import");
    await ready(page);
    await page.getByRole("button", { name: /Google Takeout/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files" }).click();
    await (await chooser).setFiles(parts);
    await expect(page.getByRole("list", { name: "Uploaded parts" }).getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
    await page.getByRole("button", { name: "Import", exact: true }).click({ timeout: 30_000 });
    const progress = page.getByRole("region", { name: "Import progress" });
    await expect(progress).toContainText("It's in.", { timeout: 90_000 });
    return progress;
  };
  const stat = (region: import("@playwright/test").Locator, label: string) => region.getByText(label, { exact: true }).locator("..");

  const first = await importOnce();
  await expect(stat(first, "new")).toContainText("3"); // two photos and the Drive document
  await expect(stat(first, "albums made")).toContainText("1");
  await expect(stat(first, "couldn't import")).toContainText("0");
  // The album is there, with its photo.
  await page.getByRole("link", { name: "Albums" }).click();
  await expect(page.getByRole("list", { name: "Albums" }).getByRole("link", { name: new RegExp(`Camping ${tag}`) })).toContainText("1 item");

  const second = await importOnce();
  await expect(stat(second, "new")).toContainText("0");
  await expect(stat(second, "already there")).toContainText("3");
  await expect(stat(second, "albums made")).toContainText("0");
});
