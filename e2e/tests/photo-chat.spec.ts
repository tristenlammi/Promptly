import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** A photo of this spec's own to find: on a fresh stack the library is empty
 *  until some other spec has left a photo behind, and this one runs first. */
async function ownPhoto(page: Page, searchable: boolean): Promise<void> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  const headers = { Authorization: (await seen).headers()["authorization"] };
  if (searchable) {
    const probe = await page.request.get("/api/photos/search?q=x", { headers });
    test.skip(probe.status() === 503, `photos-ml isn't running: ${await probe.text()}`);
  }
  const name = `pancakes-chat-${stamp}.jpg`;
  const timeline = await (await page.request.get("/api/photos/timeline?limit=50", { headers })).json();
  let id = (timeline.items as { id: string; name?: string }[]).find((i) => i.name === name)?.id;
  if (!id) {
    const up = await page.request.post("/api/files/", {
      headers,
      multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, "PANCAKES")) } },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
    id = (await up.json()).id as string;
  }
  if (!searchable) return;
  await expect
    .poll(async () => {
      const r = await page.request.get("/api/photos/search?q=pancakes", { headers });
      return r.ok() ? ((await r.json()).items as { id: string }[]).some((i) => i.id === id) : false;
    }, { timeout: 180_000, intervals: [5_000] })
    .toBe(true);
}

/** Ask your photos in chat (PH-4): the model calls search_photos and the
 *  photos it found show as a gallery under its reply. (The fake model calls
 *  the tool when the message carries a [tool:…] marker.) */
test("a chat finds photos and shows them", async ({ dana: page }) => {
  test.setTimeout(300_000);
  await ownPhoto(page, true);
  await page.goto("/chat");
  await ready(page);
  await page.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
  await page.getByPlaceholder(/^Message Promptly/).fill('[tool:search_photos {"text": "pancakes"}] find the pancakes photo');
  await page.getByRole("button", { name: "Send message" }).click();

  const gallery = page.getByRole("region", { name: "Photos found" }).last();
  await expect(gallery).toBeVisible({ timeout: 30_000 });
  const first = gallery.getByRole("list", { name: "Found photos" }).getByRole("button").first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByRole("button", { name: "Info", exact: true })).toBeVisible();
});

/** Doing things from a chat: the model proposes an album, a card shows it,
 *  and nothing happens until the person applies it. */
test("an album proposed in a chat is made when applied", async ({ dana: page }) => {
  test.setTimeout(120_000);
  await ownPhoto(page, false);
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/chat");
  await ready(page);
  const auth = { Authorization: (await seen).headers()["authorization"] };
  const timeline = await (await page.request.get("/api/photos/timeline?limit=2", { headers: auth })).json();
  const ids = (timeline.items as { id: string }[]).map((i) => i.id);
  expect(ids.length).toBeGreaterThan(0);
  const title = `Chat album ${Date.now().toString(36)}`;

  await page.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
  await page.getByPlaceholder(/^Message Promptly/).fill(
    `[tool:propose_photo_action ${JSON.stringify({ action: "album", file_ids: ids, title })}] make an album of these`,
  );
  await page.getByRole("button", { name: "Send message" }).click();

  const card = page.getByText(`New album “${title}”`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const before = await (await page.request.get("/api/photos/albums", { headers: auth })).json();
  expect((before.albums as { title: string }[]).some((a) => a.title === title)).toBe(false);
  await page.getByRole("button", { name: "Apply" }).last().click();
  await expect(page.getByText("Album ready").first()).toBeVisible({ timeout: 15_000 });
  const after = await (await page.request.get("/api/photos/albums", { headers: auth })).json();
  const made = (after.albums as { title: string; count: number }[]).find((a) => a.title === title);
  expect(made?.count).toBe(ids.length);
});
