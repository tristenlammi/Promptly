import type { Page } from "@playwright/test";

import { expect, ready, showRow, stamp, test } from "../fixtures";

/** Photos (WP-9.1–9.2): the library by date taken, selection, archive, and
 *  a folder left out of Photos. */

// An 8×8 JPEG whose EXIF says it was taken on 4 July 2021.
const JPEG_2021_07_04 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QBIRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAZADAAIAAAAUAAAALAAAAAAyMDIxOjA3OjA0IDEwOjAwOjAwAP/bAEMAEAsMDgwKEA4NDhIREBMYKBoYFhYYMSMlHSg6Mz08OTM4N0BIXE5ARFdFNzhQbVFXX2JnaGc+TXF5cGR4XGVnY//bAEMBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY//AABEIAAgACAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AKVFFFe0eOf/2Q==";

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function july2021(page: Page, auth: string, view = "all"): Promise<string[]> {
  const r = await page.request.get(`/api/photos/timeline?view=${view}&month=2021-07&limit=500`, { headers: { Authorization: auth } });
  return ((await r.json()).items as { filename: string; taken_local: string }[])
    .filter((i) => i.taken_local.startsWith("2021-07"))
    .map((i) => i.filename);
}

test("photos show by date taken, can be archived, and a folder can be left out", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const folderName = `E2E photos ${stamp}`;
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: folderName, scope: "mine" } })
  ).json();
  const names = [`e2e-photo-a-${stamp}.jpg`, `e2e-photo-b-${stamp}.jpg`];
  const ids: string[] = [];
  for (const name of names) {
    const bytes = Buffer.concat([Buffer.from(JPEG_2021_07_04, "base64"), Buffer.from(name)]);
    const r = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { file: { name, mimeType: "image/jpeg", buffer: bytes }, scope: "mine", folder_id: folder.id },
    });
    expect(r.status()).toBe(201);
    ids.push((await r.json()).id);
  }
  // The media worker reads each one's date, then it's in the library.
  await expect.poll(async () => (await july2021(page, auth)).filter((n) => names.includes(n)).length, { timeout: 30_000 }).toBe(2);

  await page.goto("/files/photos");
  await ready(page);
  await expect(page.getByRole("navigation", { name: "Photo views" })).toBeVisible();
  // To July 2021 on the scrubber, a month at a time from the newest (the
  // test account has older photos too, from other tests).
  await page.locator("[data-photo]").first().waitFor();
  const scrub = page.getByRole("slider", { name: "Jump to a date" });
  await scrub.focus();
  for (let i = 0; i < 400 && (await scrub.getAttribute("aria-valuetext")) !== "July 2021"; i++) {
    await scrub.press("ArrowDown");
  }
  const tileA = page.locator(`[data-photo="${ids[0]}"]`);
  const tileB = page.locator(`[data-photo="${ids[1]}"]`);
  await expect(tileA).toBeVisible();
  await expect(page.locator('[data-month="2021-07"]').getByRole("heading", { name: "July 2021" })).toBeVisible();

  // Select both, archive them: gone from the timeline, there under Archive.
  await tileA.hover();
  await tileA.getByRole("button", { name: "Select" }).click();
  await tileB.click();
  const bar = page.getByRole("toolbar", { name: "Selected photos" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Archive" }).click();
  await expect.poll(async () => (await july2021(page, auth)).filter((n) => names.includes(n)).length).toBe(0);
  await page.getByRole("navigation", { name: "Photo views" }).getByRole("button", { name: "Archive" }).click();
  await expect(tileA).toBeVisible();
  await tileA.hover();
  await tileA.getByRole("button", { name: "Select" }).click();
  await tileB.click();
  await bar.getByRole("button", { name: "Unarchive" }).click();
  await expect.poll(async () => (await july2021(page, auth)).filter((n) => names.includes(n)).length).toBe(2);

  // Hide the folder from Photos — from its menu in Files.
  await page.goto("/files");
  await ready(page);
  await showRow(page, folderName);
  const row = page.locator("li:not(nav li)").filter({ has: page.getByRole("button", { name: folderName, exact: true }) }).last();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Hide from Photos" }).click();
  await expect.poll(async () => (await july2021(page, auth)).filter((n) => names.includes(n)).length).toBe(0);
});
