import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { bigText } from "../lib/files";

/** Big uploads, resumably (WP-8.2): over the threshold a file goes to tusd
 *  in chunks, and after a refresh choosing it again carries on where it
 *  stopped rather than starting over. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a big upload survives a refresh and carries on from where it got to", async ({ alice: page }) => {
  test.setTimeout(240_000);
  const big = bigText();
  const size = fs.statSync(big).size;
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E big ${stamp}`, scope: "mine" } })
  ).json();

  // Hold the second chunk long enough to refresh mid-upload.
  let patches = 0;
  await page.route("**/api/files/tus/**", async (route) => {
    if (route.request().method() === "PATCH" && ++patches === 2) {
      await new Promise((r) => setTimeout(r, 15_000));
    }
    await route.continue().catch(() => undefined);
  });
  await page.goto(`/files/folder/${folder.id}`);
  await ready(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  await (await chooser).setFiles(big);
  // The first ~50 MB chunk lands, then the page goes away mid-upload.
  await page.waitForResponse((r) => r.url().includes("/api/files/tus/") && r.request().method() === "PATCH" && r.status() === 204);
  await page.unroute("**/api/files/tus/**");
  await page.reload();
  await ready(page);

  // It's listed as unfinished; choosing the same file resumes it.
  const offsets: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/files/tus/") && r.method() === "PATCH") offsets.push(Number(r.headers()["upload-offset"]));
  });
  const row = page.getByRole("region", { name: "Uploads" }).locator("li").filter({ hasText: "didn't finish" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const again = page.waitForEvent("filechooser");
  await row.getByRole("button", { name: "Choose file to continue" }).click();
  await (await again).setFiles(big);

  await expect(page.getByRole("button", { name: "e2e-big", exact: true })).toBeVisible({ timeout: 120_000 });
  expect(offsets[0]).toBeGreaterThanOrEqual(50 * 1024 * 1024); // not from zero
  const listing = await (
    await page.request.get(`/api/files/browse?scope=mine&folder_id=${folder.id}`, { headers: { Authorization: auth } })
  ).json();
  expect(listing.files.map((f: { size_bytes: number }) => f.size_bytes)).toEqual([size]);
});

test("uploading the same file again is skipped — it's already there", async ({ alice: page }) => {
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E again ${stamp}`, scope: "mine" } })
  ).json();
  await page.goto(`/files/folder/${folder.id}`);
  await ready(page);
  const file = { name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from(`Paid ${stamp}\n`) };
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    await (await chooser).setFiles(file);
    await expect(page.getByRole("region", { name: "Uploads" }).getByText(round === 0 ? "Done" : "Already there")).toBeVisible({
      timeout: 15_000,
    });
  }
  const listing = await (
    await page.request.get(`/api/files/browse?scope=mine&folder_id=${folder.id}`, { headers: { Authorization: auth } })
  ).json();
  expect(listing.files).toHaveLength(1);
});
