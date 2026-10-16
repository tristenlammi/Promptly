import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { pdf } from "../lib/files";

/** AI in the editors (WP-5.5), against the fake model (e2e/mock-llm). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type SavedSheet = { data: { name: string; celldata: { r: number; c: number; v: { v?: unknown; m?: unknown; f?: string } }[] }[] };

test.describe("editor AI", () => {
  test("Sheet AI fills a column and builds a tab, both previewed before they apply", async ({ alice: page }) => {
    test.setTimeout(120_000);
    const auth = await bearer(page);
    const r = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "sheet", title: `E2E spend ${stamp}` },
    });
    const sheetId = (await r.json()).id as string;
    const cell = (row: number, col: number, v: string | number) => ({ r: row, c: col, v: { v, m: String(v) } });
    await page.request.put(`/api/files/${sheetId}/sheet`, {
      headers: { Authorization: auth },
      data: {
        data: [{ name: "Spend", id: "spend", order: 0, celldata: [
          cell(0, 0, "Item"), cell(0, 1, "Cost"),
          cell(1, 0, "Groceries"), cell(1, 1, 54),
          cell(2, 0, "Train"), cell(2, 1, 12),
        ] }],
        content_text: "Item Cost Groceries 54 Train 12",
      },
    });
    await page.goto(`/files/sheet/${sheetId}`);
    await expect(page.getByRole("button", { name: "AI", exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "AI", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Sheet AI" });

    // Fill a new column.
    await panel.getByLabel("New column name").fill("Category");
    await panel.getByLabel("What to fill in").fill("the spending category");
    await panel.getByRole("button", { name: "Suggest values" }).click();
    const preview = panel.getByLabel("Preview");
    await expect(preview.getByText("Cat 2")).toBeVisible({ timeout: 30_000 });
    await expect(preview.getByText("Cat 3")).toBeVisible();
    const filled = page.waitForRequest(
      (q) => {
        if (q.method() !== "PUT" || !q.url().endsWith(`/api/files/${sheetId}/sheet`)) return false;
        const body = q.postDataJSON() as SavedSheet;
        const cells = body.data[0].celldata;
        const at = (row: number, col: number) => cells.find((c) => c.r === row && c.c === col)?.v;
        return at(0, 2)?.v === "Category" && at(1, 2)?.v === "Cat 2" && at(2, 2)?.v === "Cat 3";
      },
      { timeout: 30_000 }
    );
    await panel.getByRole("button", { name: "Apply" }).click();
    await filled;

    // Build a tab from a description — formulas included.
    await panel.getByRole("tab", { name: "Build" }).click();
    await panel.getByLabel("Describe the sheet").fill("a tiny monthly budget");
    await panel.getByRole("button", { name: "Design it" }).click();
    await expect(panel.getByLabel("Preview").getByText("=SUM(B2:B3)")).toBeVisible({ timeout: 30_000 });
    const built = page.waitForRequest(
      (q) => {
        if (q.method() !== "PUT" || !q.url().endsWith(`/api/files/${sheetId}/sheet`)) return false;
        const tab = (q.postDataJSON() as SavedSheet).data.find((t) => t.name === "E2E budget");
        return !!tab && tab.celldata.some((c) => c.v?.f === "=SUM(B2:B3)") && tab.celldata.some((c) => c.v?.v === "Rent");
      },
      { timeout: 30_000 }
    );
    await panel.getByRole("button", { name: "Apply" }).click();
    await built;

    // Ask about the sheet from the header.
    await page.getByRole("button", { name: "Ask AI about this file" }).click();
    const ask = page.getByRole("complementary", { name: "Ask AI" });
    await ask.getByRole("button", { name: "What does this sheet show?" }).click();
    await expect(ask.getByTestId("ask-answer").first()).toContainText("What does this sheet show?", { timeout: 30_000 });
  });

  test("Ask in a document answers about it and can insert the answer", async ({ alice: page }) => {
    const auth = await bearer(page);
    const r = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "document", title: `E2E memo ${stamp}` },
    });
    const docId = (await r.json()).id as string;
    await page.goto(`/files/doc/${docId}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.type("The launch moves to the first of May.");
    await page.getByRole("button", { name: "Ask AI about this file" }).click();
    const ask = page.getByRole("complementary", { name: "Ask AI" });
    await ask.getByLabel("Ask about this file").fill("When is the launch?");
    await ask.getByRole("button", { name: "Ask", exact: true }).click();
    const answer = ask.getByTestId("ask-answer").first();
    await expect(answer).toContainText("When is the launch?", { timeout: 30_000 });
    // The question went with the document's text.
    await answer.getByRole("button", { name: "Insert" }).click();
    await expect(editor).toContainText("Echo #");
    await expect(editor).toContainText("When is the launch?");
  });

  test("Convert with AI turns a PDF letter into a document beside it", async ({ alice: page }) => {
    const auth = await bearer(page);
    const name = `e2e-letter-${stamp}`;
    const up = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: {
        scope: "mine",
        file: {
          name: `${name}.pdf`,
          mimeType: "application/pdf",
          buffer: fs.readFileSync(pdf(`${name}.pdf`, `Dear Sam thank you for the quote of 340 pounds ${stamp}`)),
        },
      },
    });
    expect(up.ok()).toBeTruthy();
    await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
    await page.getByRole("button", { name: "Convert with AI" }).click();
    await page.getByRole("menuitem", { name: /To a document/ }).click();
    await expect(page).toHaveURL(/\/files\/doc\//, { timeout: 60_000 });
    const editor = page.locator(".ProseMirror").first();
    await expect(editor.getByRole("heading", { name: "Converted" })).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText(`quote of 340 pounds ${stamp}`);
  });
});
