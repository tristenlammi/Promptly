import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Sheet structure is shared live (WP-6.3): a merge in one window and a new
 *  tab in another both survive — the workbook used to be last-save-wins. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type Saved = { name: string; config?: { merge?: Record<string, unknown> } }[];

test("a merge in one window and a new tab in another both reach everyone and the saved sheet", async ({
  alice: page,
}) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const r = await page.request.post("/api/files/office", {
    headers: { Authorization: auth },
    data: { kind: "sheet", title: `E2E structure ${stamp}` },
  });
  const sheetId = (await r.json()).id as string;
  const cell = (row: number, col: number, v: string) => ({ r: row, c: col, v: { v, m: v } });
  await page.request.put(`/api/files/${sheetId}/sheet`, {
    headers: { Authorization: auth },
    data: { data: [{ name: "Plan", id: "plan", order: 0, celldata: [cell(0, 0, "Title"), cell(1, 0, "a"), cell(1, 1, "b")] }] },
  });

  await page.goto(`/files/sheet/${sheetId}`);
  const other = await page.context().newPage();
  await other.goto(`/files/sheet/${sheetId}`);
  for (const p of [page, other]) {
    await expect(p.locator(".fortune-sheettab-container").getByText("Plan", { exact: true })).toBeVisible({ timeout: 20_000 });
  }
  await page.waitForTimeout(1500); // both joined the room

  // Window 1: select A1:B1 and merge.
  const area = (await page.locator(".fortune-cell-area").boundingBox())!;
  await page.mouse.move(area.x + 20, area.y + 8);
  await page.mouse.down();
  await page.mouse.move(area.x + 73 + 30, area.y + 8, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".fortune-name-box")).toContainText("A1:B1");
  await page.locator('.fortune-toolbar-combo-button[data-tips="Merge cells"]').click();

  // Window 2, straight after: add a tab.
  await other.locator(".fortune-sheettab-button").first().click();

  // Each window sees the other's change…
  await expect(page.locator(".fortune-sheettab-container .luckysheet-sheets-item")).toHaveCount(2, { timeout: 20_000 });
  await expect(other.locator(".fortune-sheettab-container .luckysheet-sheets-item")).toHaveCount(2);

  // …and the saved workbook keeps both: the merge and the second tab.
  await expect
    .poll(
      async () => {
        const body = await (await page.request.get(`/api/files/${sheetId}/sheet`, { headers: { Authorization: auth } })).json();
        const tabs = body.data as Saved;
        const plan = tabs.find((t) => t.name === "Plan");
        return `${tabs.length}:${Object.keys(plan?.config?.merge ?? {}).join(",")}`;
      },
      { timeout: 30_000 }
    )
    .toBe("2:0_0");
});
