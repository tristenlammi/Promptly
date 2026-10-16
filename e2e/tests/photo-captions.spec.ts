import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";
import { readRun } from "../lib/stack";

/** Describing photos (PH-2): an admin chooses the Photos vision model (here
 *  the fake model, "on this server"); a person turns describing on; their
 *  new photo gets a sentence and tags, and is found by them. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a photo is described and found by its description", async ({ dana: page }) => {
  test.setTimeout(240_000);
  const auth = { Authorization: await bearer(page) };
  const set = await page.request.patch("/api/admin/app-settings", {
    headers: auth,
    data: { photos_vision_provider_id: readRun().provider_id, photos_vision_model_id: "e2e-mock-vision" },
  });
  expect(set.ok(), await set.text()).toBeTruthy();
  try {
    await page.goto("/files/photos");
    await ready(page);
    await page.getByRole("button", { name: "Photos settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Photos settings" });
    await expect(dialog).toContainText("written by e2e-mock-vision");
    const describe = dialog.getByRole("checkbox", { name: /Describe my photos/ });
    await expect(describe).toBeEnabled();
    if (!(await describe.isChecked())) await describe.check();
    await page.keyboard.press("Escape");

    const name = `headland-${stamp}.jpg`;
    const up = await page.request.post("/api/files/", {
      headers: auth,
      multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, "~")) } },
    });
    const id = (await up.json()).id as string;
    await expect
      .poll(async () => (await (await page.request.get(`/api/files/${id}/media`, { headers: auth })).json()).caption?.text, {
        timeout: 180_000,
        intervals: [5_000],
      })
      .toBe("A lighthouse on a rocky headland by the sea.");
    const found = await (await page.request.get("/api/photos/search?q=lighthouses", { headers: auth })).json();
    expect(found.items.find((i: { id: string }) => i.id === id)?.matched).toBe("description");
  } finally {
    await page.request.put("/api/photos/settings", { headers: auth, data: { captions: false } });
    await page.request.patch("/api/admin/app-settings", {
      headers: auth,
      data: { photos_vision_provider_id: null, photos_vision_model_id: null },
    });
  }
});
