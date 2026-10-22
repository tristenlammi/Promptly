import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Cleanup (PH-7): the same photo uploaded twice is a duplicate; the extra
 *  copy goes to the trash (and comes back with Undo). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a duplicate is found and its extra copy moved to the trash", async ({ dana: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  const bytes = fs.readFileSync(wordPhoto(`dup-${stamp}.jpg`, `DUP ${stamp}`));
  const ids: string[] = [];
  // Uploading into Photos skips a photo it already has, so the copy goes
  // straight into a folder inside Photos (still the library).
  const photos = (await (await page.request.get("/api/photos/settings", { headers: auth })).json()).folder.id as string;
  const inner = await page.request.post("/api/files/folders", {
    headers: auth,
    data: { name: `Dupes ${stamp}`, parent_id: photos, scope: "mine" },
  });
  expect(inner.ok(), await inner.text()).toBeTruthy();
  const innerId = (await inner.json()).id as string;
  for (const [name, route] of [[`dup-${stamp}-a.jpg`, "camera"], [`dup-${stamp}-b.jpg`, ""]]) {
    const up = await page.request.post("/api/files/", {
      headers: auth,
      multipart: {
        scope: "mine",
        ...(route ? { route } : { folder_id: innerId }),
        file: { name, mimeType: "image/jpeg", buffer: bytes },
      },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
    ids.push((await up.json()).id);
  }
  // Both in the library: one group, the two of them.
  await expect
    .poll(async () => {
      const r = await (await page.request.get("/api/photos/cleanup", { headers: auth })).json();
      return (r.duplicate.groups as { keep: { id: string }; others: { id: string }[] }[]).some(
        (g) => [g.keep.id, ...g.others.map((o) => o.id)].sort().join() === [...ids].sort().join(),
      );
    }, { timeout: 60_000, intervals: [3_000] })
    .toBe(true);

  await page.goto("/files/photos");
  await ready(page);
  await page.getByRole("link", { name: "Clean up" }).click();
  await expect(page.getByRole("button", { name: /^Duplicates · \d+/ })).toBeVisible();
  const group = page.getByRole("list", { name: "Duplicate groups" }).getByRole("listitem").filter({ has: page.locator(`[data-photo="${ids[0]}"]`) });
  await expect(group.locator("[data-photo]")).toHaveCount(2);
  // Only this group's extra copy.
  await page.getByRole("button", { name: "Pick none" }).click();
  const extra = group.locator('[data-photo]:has(> button[aria-pressed="false"])');
  const extraId = await extra.getAttribute("data-photo");
  await extra.click();
  const bar = page.getByRole("toolbar", { name: "Chosen" });
  await expect(bar).toContainText("1 chosen");
  await bar.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.locator(`[data-photo="${extraId}"]`)).toHaveCount(0);
  const trashed = await (await page.request.get(`/api/files/${extraId}`, { headers: auth })).json();
  expect(trashed.trashed_at).toBeTruthy();

  // Undo brings it back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/files/${extraId}`, { headers: auth })).json()).trashed_at, { timeout: 10_000 }).toBeFalsy();
});
