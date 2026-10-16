import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Versions of uploaded files (WP-8.1): Replace keeps the old bytes as a
 *  version, which can be compared, downloaded and restored. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("replacing a file keeps the old one as a version you can get back", async ({ alice: page }) => {
  test.setTimeout(90_000);
  const auth = await bearer(page);
  const folder = await (
    await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `E2E versions ${stamp}`, scope: "mine" } })
  ).json();
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", folder_id: folder.id, file: { name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("first draft\n") } },
  });
  const original = await up.json();

  // The same name again, through the page: Replace.
  await page.goto(`/files/folder/${folder.id}`);
  await ready(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  await (await chooser).setFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("second draft\n") });
  await page.getByRole("button", { name: "Replace (keep the old one as a version)" }).click();

  // Still one file, the same one.
  await expect.poll(async () => (await (await page.request.get(`/api/files/${original.id}/versions`, { headers: { Authorization: auth } })).json()).versions.length).toBe(1);
  const row = page.getByRole("button", { name: "plan", exact: true });
  await expect(row).toHaveCount(1);

  // Details → Version history.
  await row.click();
  await page.getByRole("button", { name: "Version history" }).click();
  const panel = page.getByRole("complementary", { name: "Version history" });
  await panel.getByText("Replaced by an upload").click();
  await expect(panel.getByLabel("Changes")).toContainText("first draft");

  const download = page.waitForEvent("download");
  await panel.getByRole("link", { name: /Download this version/ }).click();
  const d = await download;
  expect(fs.readFileSync((await d.path())!).toString()).toBe("first draft\n");

  await panel.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect.poll(async () => {
    const urls = await (await page.request.get(`/api/files/${original.id}/signed-urls`, { headers: { Authorization: auth } })).json();
    return (await (await page.request.get(urls.original)).text());
  }).toBe("first draft\n");
});
