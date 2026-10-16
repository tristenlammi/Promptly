import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Search photos by what's in them (PH-2): the photos-ml service embeds a
 *  new photo within a tick, and the words find it. Needs the photos-ml
 *  service (started by default); skipped when the service isn't running. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a photo is found by what's in it", async ({ dana: page }) => {
  test.setTimeout(240_000);
  const auth = await bearer(page);
  const probe = await page.request.get("/api/photos/search?q=x", { headers: { Authorization: auth } });
  test.skip(probe.status() === 503, `photos-ml isn't running: ${await probe.text()}`);

  const name = `pancakes-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, "PANCAKES")) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  await expect
    .poll(async () => {
      const r = await page.request.get("/api/photos/search?q=pancakes", { headers: { Authorization: auth } });
      return r.ok() ? ((await r.json()).items as { id: string }[]).map((i) => i.id).includes(id) : false;
    }, { timeout: 180_000, intervals: [5_000] })
    .toBe(true);

  await page.goto("/files/photos");
  await ready(page);
  await page.getByRole("link", { name: "Search photos" }).click();
  await page.getByRole("searchbox", { name: "Search your photos" }).or(page.getByLabel("Search your photos")).fill("pancakes");
  await page.keyboard.press("Enter");
  const results = page.getByLabel("Search results");
  await expect(results.locator(`[data-photo="${id}"]`)).toBeVisible({ timeout: 20_000 });
  // The word is read in the picture too (OCR), so it's a match by its words.
  await expect(page.getByText(/with “pancakes” in/)).toBeVisible({ timeout: 120_000 });
  await results.locator(`[data-photo="${id}"]`).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Photo info" })).toContainText(name);
});
