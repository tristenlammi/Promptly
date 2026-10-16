import { expect, ready, stamp, test } from "../fixtures";
import { photoFolder } from "../lib/files";

/** Moving in (WP-10.3): a zipped folder — photos by their date, everything
 *  else keeping its folders, junk left out. */

test("a zipped folder is imported: photos by date, other files in their folders", async ({ alice: page }) => {
  test.setTimeout(180_000);
  const zip = photoFolder(stamp);
  await page.goto("/files/import");
  await ready(page);
  await page.getByRole("button", { name: /A folder of photos/ }).click();
  await expect(page.getByRole("heading", { name: "A folder of photos" })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles(zip);
  await expect(page.getByRole("list", { name: "Uploaded parts" }).getByRole("listitem")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: "Check the archives" }).click();

  const report = page.getByRole("region", { name: "What's in it" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.getByText("photos", { exact: true }).locator("..")).toContainText("2");
  await expect(report.getByText("other files", { exact: true }).locator("..")).toContainText("1");
  await expect(report).toContainText("From 2013 to 2013");
  await expect(report).toContainText(`“Imported – Old laptop ${stamp}”`);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  const progress = page.getByRole("region", { name: "Import progress" });
  await expect(progress).toContainText("It's in.", { timeout: 90_000 });
  await expect(progress.getByText("new", { exact: true }).locator("..")).toContainText("3");
  await expect(progress.getByText("albums made")).toHaveCount(0);
  await progress.getByRole("link", { name: new RegExp(`Imported – Old laptop ${stamp}`) }).click();
  await expect(page.getByText(`Imported – Old laptop ${stamp}`, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
