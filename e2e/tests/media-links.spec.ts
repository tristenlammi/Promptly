import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { png, video } from "../lib/files";

/** Signed media links (WP-7.5): photos, videos and downloads load straight
 *  from /m/<token> — served by nginx with Range — with no bearer header. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function folderWith(page: Page, auth: string, label: string, files: { name: string; mime: string; path: string }[]) {
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `${label} ${stamp}`, scope: "mine" } })
  ).json();
  const ids: string[] = [];
  for (const f of files) {
    const r = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { scope: "mine", folder_id: folder.id, file: { name: f.name, mimeType: f.mime, buffer: fs.readFileSync(f.path) } },
    });
    expect(r.ok()).toBeTruthy();
    ids.push((await r.json()).id);
  }
  return { folder: folder.id as string, ids };
}

async function readyLinks(page: Page, auth: string, id: string) {
  let links: Record<string, string | null> = {};
  await expect
    .poll(
      async () => {
        links = await (await page.request.get(`/api/files/${id}/signed-urls`, { headers: { Authorization: auth } })).json();
        return links.state;
      },
      { timeout: 90_000 }
    )
    .toBe("ready");
  return links;
}

test("an iPhone video plays and seeks in the preview", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const name = `e2e-IMG-${stamp}`;
  const { folder, ids } = await folderWith(page, auth, "E2E video", [
    { name: `${name}.MOV`, mime: "video/quicktime", path: video(`${name}.MOV`, { hevc: true }) },
  ]);
  // The media worker makes the web copy and the poster.
  const links = await readyLinks(page, auth, ids[0]);
  expect(links.video).toMatch(/^\/m\//);

  // Range straight from nginx — no Authorization header on this request.
  const part = await page.request.get(links.video!, { headers: { Range: "bytes=0-1023" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-type"]).toBe("video/mp4");

  await page.goto(`/files/folder/${folder}`);
  await page.getByRole("button", { name, exact: true }).dblclick();
  const player = page.locator(`video[aria-label="${name}.MOV"]`);
  await expect(player).toBeVisible({ timeout: 20_000 });
  await expect(player).toHaveAttribute("poster", /^\/m\//);
  // It knows its length (metadata over Range) and seeks without the lot.
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(5);
  await player.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    v.currentTime = 4;
  });
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  expect(await player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(3.5);
  await page.keyboard.press("Escape");
});

test("photo tiles load as plain images from signed links", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const name = `e2e-signed-${stamp}`;
  const { folder, ids } = await folderWith(page, auth, "E2E signed tiles", [
    { name: `${name}.png`, mime: "image/png", path: png(`${name}.png`) },
  ]);
  await readyLinks(page, auth, ids[0]);

  const tiles: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/m/") && r.request().resourceType() === "image") tiles.push(r.headers()["content-type"]);
  });
  await page.goto(`/files/folder/${folder}`);
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect.poll(() => tiles.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(tiles[0]).toBe("image/webp");
  await page.getByRole("button", { name: "List view" }).click();
});

test("a download goes straight to the browser from a signed link", async ({ alice: page }) => {
  const auth = await bearer(page);
  const name = `e2e-native-${stamp}.png`;
  const { folder } = await folderWith(page, auth, "E2E downloads", [{ name, mime: "image/png", path: png(name) }]);
  await page.goto(`/files/folder/${folder}`);
  // Details pane → Download.
  await page.getByRole("button", { name: name.replace(/\.png$/, ""), exact: true }).click();
  const download = page.waitForEvent("download");
  await page.locator("aside").filter({ hasText: "Details" }).getByRole("button", { name: "Download", exact: true }).click();
  const d = await download;
  expect(d.url()).toMatch(/\/m\//);
  expect(d.suggestedFilename()).toBe(name);
  expect(fs.readFileSync((await d.path())!)).toEqual(fs.readFileSync(png(name)));
});
