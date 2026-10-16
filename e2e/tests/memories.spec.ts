import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { datedPhoto, resetMemories } from "../lib/files";

/** Memories (PH-5): photos taken on today's date years ago come back as
 *  "On this day" on the Photos home; one plays, becomes an album, or goes. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

const pad = (n: number) => String(n).padStart(2, "0");

test("on this day comes back, plays, and can be put away", async ({ bob: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  resetMemories("e2e_bob");
  // Today where the browser is and in UTC (they differ for part of the day,
  // and the user's own time zone is one of them).
  const now = new Date();
  const days = [...new Set([`${pad(now.getMonth() + 1)}:${pad(now.getDate())}`, `${pad(now.getUTCMonth() + 1)}:${pad(now.getUTCDate())}`])];
  const ids: string[] = [];
  for (const md of days) {
    for (const hour of ["10", "11"]) {
      const name = `otd-${stamp}-${md.replace(":", "")}-${hour}.jpg`;
      const up = await page.request.post("/api/files/", {
        headers: auth,
        multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(datedPhoto(name, `2019:${md} ${hour}:00:00`)) } },
      });
      expect(up.ok()).toBe(true);
      ids.push((await up.json()).id);
    }
  }

  // Once their dates are read, the Photos home has the memory.
  const ago = `${now.getFullYear() - 2019} years ago`;
  await expect
    .poll(async () => {
      const r = await (await page.request.get("/api/photos/memories", { headers: auth })).json();
      return (r.memories as { title: string }[]).some((m) => m.title === ago);
    }, { timeout: 60_000, intervals: [3_000] })
    .toBe(true);
  await page.goto("/files/photos");
  await ready(page);
  const strip = page.getByRole("list", { name: "Memories" });
  await strip.getByRole("link", { name: new RegExp(ago) }).click();
  await expect(page.getByRole("heading", { name: ago })).toBeVisible();
  const tiles = page.getByLabel("Memory photos").locator("[data-photo]");
  await expect(tiles.first()).toBeVisible();
  for (const id of ids.slice(0, 2)) {
    // At least the photos of one of the two days are in it.
    if (await page.locator(`[data-photo="${id}"]`).count()) await expect(page.locator(`[data-photo="${id}"]`)).toBeVisible();
  }

  // Played: the viewer opens on the first, paused with Space.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Kept as an album.
  await page.getByRole("button", { name: "Save as album" }).click();
  await expect(page).toHaveURL(/\/files\/photos\/albums\//);
  await expect(page.locator("[data-photo]").first()).toBeVisible();

  // Put away: gone from the Photos home.
  await page.goBack();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Don't show this memory" }).click();
  await expect(page).toHaveURL(/\/files\/photos$/);
  await expect(page.getByRole("list", { name: "Memories" }).getByRole("link", { name: new RegExp(ago) })).toHaveCount(0);
});
