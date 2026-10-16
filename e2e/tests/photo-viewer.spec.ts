import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { png, video } from "../lib/files";
import { BACKEND } from "../lib/stack";

/** The photo viewer (WP-9.3): open from the timeline, move with the keys,
 *  favourite, info, and a Live Photo playing while LIVE is held. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function upload(page: Page, auth: string, file: string, name: string, mimeType: string, folderId: string) {
  const r = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { file: { name, mimeType, buffer: fs.readFileSync(file) }, scope: "mine", folder_id: folderId },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id as string;
}

/** Pair a still and a clip the way the media worker pairs a Live Photo
 *  (an iPhone's ContentIdentifier can't be written into a test JPEG). */
function pairLive(still: string, clip: string) {
  const py = [
    "import asyncio, uuid",
    "from app.database import SessionLocal",
    "from app.files.models import FileMedia",
    "from app.photos.library import sync",
    "async def main():",
    "    async with SessionLocal() as db:",
    `        a, b = uuid.UUID('${still}'), uuid.UUID('${clip}')`,
    "        (await db.get(FileMedia, a)).live_pair_file_id = b",
    "        (await db.get(FileMedia, b)).live_pair_file_id = a",
    "        await db.flush(); await sync(db, a); await sync(db, b); await db.commit()",
    "asyncio.run(main())",
  ].join("\n");
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
}

test("the viewer: keys, favourite, info, and a Live Photo", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E viewer ${stamp}`, scope: "mine" } })
  ).json();
  const still = await upload(page, auth, png(`e2e-live-${stamp}.png`), `e2e-live-${stamp}.png`, "image/png", folder.id);
  const clip = await upload(page, auth, video(`e2e-live-${stamp}.mp4`, { seconds: 2 }), `e2e-live-${stamp}.mp4`, "video/mp4", folder.id);
  // Both read by the media worker (and the clip made playable) first.
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/files/${clip}/signed-urls`, { headers: { Authorization: auth } });
        return (await r.json()).video ? "ready" : "waiting";
      },
      { timeout: 60_000 },
    )
    .toBe("ready");
  pairLive(still, clip);

  await page.goto("/files/photos");
  await ready(page);
  const tile = page.locator(`[data-photo="${still}"]`);
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("LIVE");
  // The clip is shown behind its still, not on its own.
  await expect(page.locator(`[data-photo="${clip}"]`)).toHaveCount(0);

  await tile.click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer" });
  await expect(viewer).toBeVisible();

  // Hold LIVE: the moment of video plays; let go and it stops.
  const live = viewer.getByRole("button", { name: "Play the Live Photo" });
  await live.hover();
  await page.mouse.down();
  await expect(viewer.locator("video")).toHaveCount(1);
  await page.mouse.up();
  await page.mouse.move(5, 5);
  await expect(viewer.locator("video")).toHaveCount(0);

  // Favourite from the viewer — it's the Drive star.
  await viewer.getByRole("button", { name: "Favourite" }).click();
  await expect(viewer.getByRole("button", { name: "Unfavourite" })).toBeVisible();
  const file = await (await page.request.get(`/api/files/${still}`, { headers: { Authorization: auth } })).json();
  expect(file.starred_at).toBeTruthy();

  // Info: details and who can see it.
  await viewer.getByRole("button", { name: "Info", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Photo info" });
  await expect(info).toContainText(`e2e-live-${stamp}.png`);
  await expect(info).toContainText("Only you");

  // The keys move on, Esc closes.
  await page.keyboard.press("ArrowRight");
  await expect(info).not.toContainText(`e2e-live-${stamp}.png`);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});
