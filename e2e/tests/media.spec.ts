import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { png } from "../lib/files";

/** A photo's own details (WP-7.3): when it was taken, and the owner's
 *  corrections to the date and place. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a photo shows when it was taken, and the owner can correct the date and place", async ({ alice: page }) => {
  test.setTimeout(90_000);
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E photos ${stamp}`, scope: "mine" } })
  ).json();
  const name = `e2e-holiday-${stamp}`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: {
      scope: "mine",
      folder_id: folder.id,
      // The photo's date on the device it came from — no date inside a PNG.
      last_modified: String(Date.UTC(2022, 7, 14, 10, 30)),
      file: { name: `${name}.png`, mimeType: "image/png", buffer: fs.readFileSync(png(`${name}.png`)) },
    },
  });
  expect(up.ok()).toBeTruthy();

  await page.goto(`/files/folder/${folder.id}`);
  await page.getByRole("button", { name, exact: true }).click();
  const details = page.getByLabel("Photo details");
  await expect(details).toContainText("from the file's date", { timeout: 20_000 });
  await expect(details).toContainText("2022");
  await expect(details).toContainText("64 × 64");

  await details.getByRole("button", { name: "Edit date and place" }).click();
  const aside = page.locator("aside").filter({ hasText: "Details" });
  await aside.getByLabel("Taken").fill("2021-12-25T09:15");
  await aside.getByLabel("Latitude").fill("51.5007");
  await aside.getByLabel("Longitude").fill("-0.1246");
  await aside.getByRole("button", { name: "Save" }).click();
  await expect(details).toContainText("edited");
  await expect(details).toContainText("2021");
  await expect(details.getByRole("link", { name: "51.50070, -0.12460" })).toBeVisible();
});

test("a photo's grid tile is the media worker's WebP thumbnail", async ({ alice: page }) => {
  // WP-7.4: the media worker makes the tile in the background; the grid
  // shows the blurred placeholder until then, then the WebP rendition.
  test.setTimeout(90_000);
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E tiles ${stamp}`, scope: "mine" } })
  ).json();
  const name = `e2e-tile-${stamp}`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: {
      scope: "mine",
      folder_id: folder.id,
      file: { name: `${name}.png`, mimeType: "image/png", buffer: fs.readFileSync(png(`${name}.png`)) },
    },
  });
  expect(up.ok()).toBeTruthy();
  const { id } = await up.json();
  // Ready once the worker has made it — the tile then comes from derived/.
  await expect
    .poll(async () => (await page.request.get(`/api/files/${id}/thumbnail`, { headers: { Authorization: auth } })).headers()["content-type"], {
      timeout: 60_000,
    })
    .toBe("image/webp");

  // The grid loads it as a plain image from its signed link (WP-7.5/7.6).
  const tile = page.waitForResponse((r) => r.url().includes("/m/") && r.request().resourceType() === "image" && r.ok());
  await page.goto(`/files/folder/${folder.id}`);
  await page.getByRole("button", { name: "Grid view" }).click();
  expect((await tile).headers()["content-type"]).toBe("image/webp");
  await page.getByRole("button", { name: "List view" }).click();
});
