import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Editing (PH-7): turn a photo and brighten it — saved beside the
 *  original, shown edited, and reverted. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a photo is edited without touching the original, then reverted", async ({ dana: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  const name = `edit-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: auth,
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, "EDIT ME")) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  await expect
    .poll(async () => (await (await page.request.get(`/api/files/${id}/signed-urls`, { headers: auth })).json()).state, { timeout: 60_000 })
    .toBe("ready");

  await page.goto("/files/photos");
  await ready(page);
  await page.locator(`[data-photo="${id}"]`).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit photo" });
  await expect(editor.getByRole("img", { name: "Photo being edited" })).toBeVisible();
  await editor.getByRole("button", { name: "Rotate right" }).click();
  await editor.getByRole("tab", { name: "Adjust" }).click();
  await editor.getByRole("slider", { name: "Brightness" }).fill("20");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/photos/files/${id}/edit`) && r.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save" }).click();
  const out = await (await saved).json();
  expect(out.ops.rotate).toBe(90);
  expect(out.ops.brightness).toBeCloseTo(0.2);
  // 400×300 turned on its side.
  expect([out.item.width, out.item.height]).toEqual([300, 400]);
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "Download edited" })).toBeVisible();

  // The original file is as uploaded.
  const links = await (await page.request.get(`/api/files/${id}/signed-urls`, { headers: auth })).json();
  expect(links.edited).toBe(true);
  const original = await page.request.get(links.original);
  expect((await original.body()).equals(fs.readFileSync(wordPhoto(name, "EDIT ME")))).toBe(true);

  // Revert.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit photo" }).getByRole("button", { name: "Revert to original" }).click();
  await expect(page.getByRole("dialog", { name: "Edit photo" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Download edited" })).toHaveCount(0);
  const back = await (await page.request.get(`/api/photos/files/${id}/edit`, { headers: auth })).json();
  expect(back.ops).toBeNull();
  expect([back.item.width, back.item.height]).toEqual([400, 300]);
});
