import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { gpsPhoto } from "../lib/files";

/** Understanding photos (PH-2): a photo with a location gets the place's
 *  name, worked out offline, within a minute or two of arriving — and is
 *  found under Places (PH-5). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a photo's place is named", async ({ dana: page }) => {
  test.setTimeout(240_000);
  const auth = await bearer(page);
  const name = `noosa-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(gpsPhoto(name)) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  // The media worker reads it, then the next understanding tick places it.
  await expect
    .poll(async () => (await (await page.request.get(`/api/files/${id}/media`, { headers: { Authorization: auth } })).json()).place?.name, {
      timeout: 180_000,
      intervals: [5_000],
    })
    .toBe("Noosa Heads");

  await page.goto("/files/photos");
  await ready(page);
  await page.locator(`[data-photo="${id}"]`).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Photo info" });
  await expect(info).toContainText("Noosa Heads, Queensland, Australia");
  await expect(info).toContainText("GeoNames");

  // Places (PH-5): Australia → Noosa Heads → the photo.
  await page.goto("/files/photos");
  await ready(page);
  await page.getByRole("link", { name: "Places" }).click();
  await page.getByRole("list", { name: "Countries" }).getByRole("link", { name: /Australia/ }).click();
  await page.getByRole("list", { name: "Towns" }).getByRole("link", { name: /Noosa Heads/ }).click();
  await expect(page.getByRole("heading", { name: "Noosa Heads" })).toBeVisible();
  await expect(page.getByLabel("Photos taken here").locator(`[data-photo="${id}"]`)).toBeVisible();
});
