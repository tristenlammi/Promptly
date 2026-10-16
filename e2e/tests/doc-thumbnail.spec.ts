import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Files polish: a Doc's tile in the grid is a picture of its first page
 *  (made on the server once the Doc is written), not just the Doc icon. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a doc shows its first page in the grid", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  const folder = await (await page.request.post("/api/files/folders", { headers: auth, data: { scope: "mine", name: `Thumbs ${stamp}` } })).json();
  const dc = await page.request.post("/api/files/office", {
    headers: auth, data: { kind: "document", title: `Plan ${stamp}`, folder_id: folder.id },
  });
  const docId = (await dc.json()).id as string;
  await page.goto(`/files/doc/${docId}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("Quarterly plan — hire two engineers and open the Sydney office.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });

  // Asked for, made on the worker, then served.
  await expect
    .poll(async () => (await page.request.get(`/api/files/${docId}/thumbnail`, { headers: auth })).status(), { timeout: 60_000, intervals: [2_000] })
    .toBe(200);

  await page.goto(`/files/folder/${folder.id}`);
  await ready(page);
  await page.getByRole("button", { name: "Grid view" }).click();
  const tile = page.getByRole("button", { name: new RegExp(`Plan ${stamp}`) }).first();
  await expect(tile).toBeVisible();
  await expect(tile.locator("img")).toBeVisible({ timeout: 15_000 });
});
