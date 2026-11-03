import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { gpsPhoto } from "../lib/files";

/** The Photos map (PH-5): a photo with a location is a dot on the map;
 *  clicking it lists it. Nothing is fetched from elsewhere but OpenFreeMap's
 *  tiles, when the online map is on. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("located photos are on the map", async ({ dana: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  const name = `map-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: auth,
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(gpsPhoto(name)) } },
  });
  const id = (await up.json()).id as string;
  await expect
    .poll(async () => ((await (await page.request.get("/api/photos/map", { headers: auth })).json()).ids as string[]).includes(id), { timeout: 60_000 })
    .toBe(true);

  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(new URL(page.url()).origin) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) external.push(r.url());
  });
  await page.goto("/files/photos/places");
  await ready(page);
  await page.getByRole("link", { name: "Map" }).click();
  const map = page.getByRole("region", { name: "Map of your photos" });
  await expect(map.locator("canvas")).toBeVisible({ timeout: 20_000 });
  // The photos there: a click on the cluster (the map is fitted to them once
  // its style has loaded — online, that's a fetch from OpenFreeMap first).
  const box = await map.boundingBox();
  const here = page.getByRole("complementary", { name: "Photos here" });
  await expect(async () => {
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(here).toContainText(/\d+ photos? here/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(here.getByRole("button", { name: /^Photo, / }).first()).toBeVisible();
  // The map (and the app shell, whose DM Sans is bundled) fetches nothing
  // from anywhere else — but OpenFreeMap's tiles when the online map is on
  // (PHOTOS_ONLINE_MAP, the default).
  const online = (await (await page.request.get("/api/photos/map", { headers: auth })).json()).online;
  expect(external.filter((u) => !(online && new URL(u).hostname.endsWith("openfreemap.org")))).toEqual([]);
});
