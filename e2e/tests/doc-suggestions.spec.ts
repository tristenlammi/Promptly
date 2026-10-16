import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Suggestion mode (Stage 6 stretch): in Suggesting, typing is a suggested
 *  insertion and deleting strikes text through instead of removing it; a
 *  click on either offers Accept / Reject. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("suggestions are made, accepted and rejected", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const dc = await page.request.post("/api/files/office", {
    headers: { Authorization: auth },
    data: { kind: "document", title: `E2E suggest ${stamp}` },
  });
  const docId = (await dc.json()).id as string;
  await page.goto(`/files/doc/${docId}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("We meet on Monday.");

  // Suggesting: type a word, and delete one.
  await page.getByRole("button", { name: "Editing" }).click();
  await page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
  await expect(page.getByRole("button", { name: /^Suggesting/ })).toBeVisible();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft"); // before the full stop
  await page.keyboard.type(" at noon");
  const ins = editor.locator('[data-suggest="ins"]');
  await expect(ins).toHaveText(" at noon");
  // Backspace over "Monday" (6 letters, before " at noon").
  for (let i = 0; i < " at noon".length; i++) await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
  const del = editor.locator('[data-suggest="del"]');
  await expect(del).toHaveText("Monday");
  await expect(editor).toContainText("We meet on Monday at noon.");
  await expect(page.getByRole("button", { name: /^Suggesting.*, 2 suggestions/ })).toBeVisible();

  // Accept the insertion, reject the deletion.
  await ins.click();
  const bubble = page.getByRole("dialog", { name: "Suggestion" });
  await expect(bubble).toContainText("suggested adding this");
  await bubble.getByRole("button", { name: "Accept" }).click();
  await expect(ins).toHaveCount(0);
  await del.click();
  await expect(bubble).toContainText("suggested deleting this");
  await bubble.getByRole("button", { name: "Reject" }).click();
  await expect(del).toHaveCount(0);
  await expect(editor).toHaveText("We meet on Monday at noon.");

  // Accept all: a suggested deletion goes for good.
  await editor.click();
  await page.keyboard.press("End");
  for (let i = 0; i < 9; i++) await page.keyboard.press("Backspace"); // " at noon." … struck, cursor moves left
  await expect(del).toHaveText(" at noon.");
  await page.getByRole("button", { name: /^Suggesting/ }).click();
  await page.getByRole("menuitem", { name: /Accept all suggestions/ }).click();
  await expect(editor).toHaveText("We meet on Monday");
});
