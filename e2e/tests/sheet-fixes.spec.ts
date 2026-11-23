import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** A sheet whose cells were written by something other than the editor (the
 *  API, an import, the AI): the name box, the status bar and the font. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a sheet opens on A1, adds up formatted numbers, and shows the default font", async ({ alice }) => {
  const auth = await bearer(alice);
  const r = await alice.request.post("/api/files/office", { headers: { Authorization: auth }, data: { kind: "sheet", title: `E2E budget ${stamp}` } });
  const sheetId = (await r.json()).id as string;
  const money = (row: number, col: number, v: number) => ({ r: row, c: col, v: { v, m: v.toLocaleString("en-AU"), ct: { fa: "#,##0", t: "n" } } });
  const put = await alice.request.put(`/api/files/${sheetId}/sheet`, {
    headers: { Authorization: auth },
    data: { data: [{ name: "Budget", id: "budget", order: 0, celldata: [money(0, 0, 5570), money(1, 0, 1200), money(2, 0, 30)] }] },
  });
  expect(put.ok()).toBeTruthy();

  await alice.goto(`/files/sheet/${sheetId}`);
  const box = alice.locator(".fortune-name-box");
  // No cell clicked yet: this read "A1:NaN".
  await expect(box).toHaveText(/^A\.? ?1$/, { timeout: 20_000 });
  await expect(box).not.toContainText("NaN");
  // A cell with no font of its own is in the default, which the toolbar names.
  await expect(alice.locator(".fortune-toolbar")).toContainText("Arial");
  await expect(alice.locator(".fortune-toolbar")).not.toContainText("Times New Roman");

  // A1 and A2 selected: 5,570 + 1,200 (it summed 5 + 1).
  const canvas = alice.locator(".fortune-sheet-overlay");
  const at = await canvas.boundingBox();
  if (!at) throw new Error("no sheet");
  await alice.mouse.click(at.x + 40, at.y + 10);
  await alice.keyboard.down("Shift");
  await alice.mouse.click(at.x + 40, at.y + 45);
  await alice.keyboard.up("Shift");
  const stats = alice.locator(".fortune-stat-area");
  await expect(stats).toContainText("Sum: 6770.00");
  await expect(stats).toContainText("Max: 5570.00");
});
