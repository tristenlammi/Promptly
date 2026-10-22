import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";

/** The Photos folder (WP-8.5; was "Camera Uploads"): a photo shared to the
 *  installed Files app goes into Photos under the month it was taken — and the same photo
 *  shared again is still one file. */

// An 8×8 JPEG whose EXIF says it was taken on 4 July 2021.
const JPEG_2021_07_04 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QBIRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAZADAAIAAAAUAAAALAAAAAAyMDIxOjA3OjA0IDEwOjAwOjAwAP/bAEMAEAsMDgwKEA4NDhIREBMYKBoYFhYYMSMlHSg6Mz08OTM4N0BIXE5ARFdFNzhQbVFXX2JnaGc+TXF5cGR4XGVnY//bAEMBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY//AABEIAAgACAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AKVFFFe0eOf/2Q==";

/** What the OS does on "Share → Promptly Files": a multipart POST the
 *  service worker answers. Bytes after the image's end make it this run's
 *  own photo. */
async function share(page: Page, name: string) {
  await page.evaluate(
    async ({ b64, name, tag }) => {
      await navigator.serviceWorker.ready;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const trailer = new TextEncoder().encode(tag);
      const form = new FormData();
      form.append("files", new File([bytes, trailer], name, { type: "image/jpeg" }));
      await fetch("/files/share-target", { method: "POST", body: form });
    },
    { b64: JPEG_2021_07_04, name, tag: `e2e-${name}` },
  );
}

async function browse(page: Page, auth: string, folderId: string | null) {
  const q = folderId ? `&folder_id=${folderId}` : "";
  return (await page.request.get(`/api/files/browse?scope=mine${q}`, { headers: { Authorization: auth } })).json();
}

test("a shared photo lands in the Photos folder under the month it was taken, once", async ({ browser }) => {
  test.setTimeout(90_000);
  // The share goes through the service worker, which the suite blocks.
  const context = await browser.newContext({ storageState: storageStateFile("alice"), serviceWorkers: "allow" });
  await context.route("**/version.json*", (r) => r.abort());
  const page = await context.newPage();
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  const auth = (await seen).headers()["authorization"];
  // The worker has to be in charge of this page to receive the share.
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await ready(page);
  }

  const name = `IMG_${stamp}.jpg`;
  await share(page, name);
  await page.goto("/files/?shared=1");
  await expect(page.getByText("Uploading 1 shared photo to Photos")).toBeVisible();
  await expect(page.getByRole("region", { name: "Uploads" }).getByText("Done")).toBeVisible({ timeout: 20_000 });

  // Photos → 2021 → 07.
  const root = await browse(page, auth, null);
  const cam = root.folders.find((f: { system_kind: string | null }) => f.system_kind === "camera_uploads");
  const year = (await browse(page, auth, cam.id)).folders.find((f: { name: string }) => f.name === "2021");
  const month = (await browse(page, auth, year.id)).folders.find((f: { name: string }) => f.name === "07");
  const inMonth = async () =>
    (await browse(page, auth, month.id)).files.filter((f: { filename: string }) => f.filename === name).length;
  expect(await inMonth()).toBe(1);

  // Shared again: still the one file.
  await share(page, name);
  await page.goto("/files/?shared=1");
  await expect(page.getByRole("region", { name: "Uploads" }).getByText("Done").first()).toBeVisible({ timeout: 20_000 });
  expect(await inMonth()).toBe(1);
  await context.close();
});
