import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { pptxDeck } from "../lib/files";

/** Faithful Office previews (Stage 12): with the converter running, a
 *  PowerPoint file previews as the slides themselves (a PDF of them), not
 *  a text outline. Skipped when this instance has no converter. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a PowerPoint file previews as its slides", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  const name = `e2e-deck-${stamp}`;
  const up = await page.request.post("/api/files/", {
    headers: auth,
    multipart: { scope: "mine", file: { name: `${name}.pptx`, mimeType: "application/octet-stream", buffer: fs.readFileSync(pptxDeck(`${name}.pptx`, "Big plans")) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  const first = await (await page.request.get(`/api/files/${id}/text`, { headers: auth })).json();
  test.skip(first.preview === null || first.preview === undefined, "no converter on this instance");

  await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
  const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
  await expect(preview.locator("#preview-title")).toHaveText(`${name}.pptx`);
  // The slides, as pages — once the converter has made them.
  await expect(preview.getByText("Page 1 of 2")).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByRole("toolbar", { name: "PDF tools" })).toBeVisible();
});
