import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { png } from "../lib/files";

/** Public album links (WP-9.5): the owner makes a link from Share, and
 *  someone with no account opens the album, looks through it, and can
 *  download it. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("an album link opens for someone without an account", async ({ alice, browser }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const ids: string[] = [];
  for (const n of ["a", "b"]) {
    const name = `e2e-link-${n}-${stamp}.png`;
    const r = await alice.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { file: { name, mimeType: "image/png", buffer: fs.readFileSync(png(name)) }, scope: "mine" },
    });
    ids.push((await r.json()).id);
  }
  await expect
    .poll(async () => {
      const t = await (await alice.request.get("/api/photos/timeline?limit=200", { headers: { Authorization: auth } })).json();
      return ids.every((id) => t.items.some((i: { id: string; thumb: string | null }) => i.id === id && i.thumb));
    }, { timeout: 60_000 })
    .toBe(true);
  const title = `E2E grandparents ${stamp}`;
  const album = await (
    await alice.request.post("/api/photos/albums", { headers: { Authorization: auth }, data: { title, file_ids: ids } })
  ).json();

  await alice.goto(`/files/photos/albums/${album.id}`);
  await ready(alice);
  await alice.getByRole("button", { name: "Share" }).click();
  const section = alice.getByRole("region", { name: "Album link" });
  await section.getByRole("button", { name: "Make a link" }).click();
  await expect(section.getByRole("img", { name: "QR code for the album link" })).toBeVisible();
  await expect(section).toContainText("Without where photos were taken");
  const url = (await section.getByLabel("Album link").textContent())!.trim();

  // Someone with no Promptly account.
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await guest.newPage();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("2 photos")).toBeVisible();
  const tiles = page.getByRole("button", { name: /^Photo \d of 2$/ });
  await expect(tiles).toHaveCount(2);
  await tiles.first().click();
  const box = page.getByRole("dialog", { name: "Photo" });
  await expect(box.locator("img")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  const zip = await page.request.get(await page.getByRole("link", { name: "Download all" }).getAttribute("href") as string);
  expect(zip.status()).toBe(200);
  expect(zip.headers()["content-type"]).toContain("application/zip");

  // Turned off: the guest's next visit finds it gone.
  await section.getByRole("button", { name: "Turn off" }).click();
  await page.reload();
  await expect(page.getByText("This link isn't available")).toBeVisible();
  await guest.close();
});
