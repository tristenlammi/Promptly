import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { seedFaces, wordPhoto } from "../lib/files";

/** Smart albums (PH-5): an album that is a saved question — "always add
 *  Kai" — built with a live preview; what's taken out stays out. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a smart album holds a person's photos, and what's taken out stays out", async ({ bob: page }) => {
  test.setTimeout(240_000);
  const auth = { Authorization: await bearer(page) };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const name = `kai-${stamp}-${i}.jpg`;
    const up = await page.request.post("/api/files/", {
      headers: auth,
      multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, `KAI ${i}`)) } },
    });
    ids.push((await up.json()).id);
  }
  const faces = seedFaces("e2e_bob", ids, 11 + (Number.parseInt(stamp.slice(-2), 36) % 400));

  // Clustered into a person at the next understanding tick (the one with
  // our faces — other runs' people may be unnamed too); named here.
  const name = `Kai ${stamp}`;
  let personId = "";
  await expect
    .poll(async () => {
      const r = await (await page.request.get("/api/photos/people/review", { headers: auth })).json();
      const p = (r.people as { id: string | null; samples: { id: string }[] }[]).find((x) => x.samples.some((f) => faces.includes(f.id)));
      personId = p?.id ?? "";
      return personId;
    }, { timeout: 180_000, intervals: [5_000] })
    .not.toBe("");
  expect((await page.request.patch(`/api/photos/people/${personId}`, { headers: auth, data: { name } })).ok()).toBe(true);

  await page.goto("/files/photos/albums");
  await ready(page);
  await page.getByRole("button", { name: "New smart album" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Album name" }).fill(`Always ${name}`);
  await dialog.getByRole("button", { name }).click();
  const preview = dialog.getByLabel("Preview");
  await expect(preview).toContainText("3 photos now", { timeout: 15_000 });
  await expect(preview).toContainText(name);
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("textbox", { name: "Album name" })).toHaveValue(`Always ${name}`);
  await expect(page.getByText(`Smart: ${name}`)).toBeVisible();
  const tiles = page.locator("[data-photo]");
  await expect(tiles).toHaveCount(3);

  // One taken out by hand stays out after the question is asked again.
  await tiles.first().hover();
  await tiles.first().getByRole("button", { name: "Select" }).click();
  await page.getByRole("toolbar", { name: "Selected photos" }).getByRole("button", { name: "Remove from album" }).click();
  await expect(tiles).toHaveCount(2);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit what it holds" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.reload();
  await ready(page);
  await expect(tiles).toHaveCount(2);
});
