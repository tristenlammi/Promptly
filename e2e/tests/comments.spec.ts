import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";

/** Comments on every office file (WP-6.1): sheets (cells) and whiteboards (shapes). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test.describe("comments", () => {
  test("a comment on a sheet cell tells the person mentioned, and their link opens on the cell", async ({
    alice,
    bob,
  }) => {
    const auth = await bearer(alice);
    const title = `E2E rota ${stamp}`;
    const r = await alice.request.post("/api/files/office", { headers: { Authorization: auth }, data: { kind: "sheet", title } });
    const sheetId = (await r.json()).id as string;
    const cell = (row: number, col: number, v: string) => ({ r: row, c: col, v: { v, m: v } });
    await alice.request.put(`/api/files/${sheetId}/sheet`, {
      headers: { Authorization: auth },
      data: { data: [{ name: "Rota", id: "rota", order: 0, celldata: [cell(0, 0, "Day"), cell(1, 0, "Tuesday"), cell(1, 1, "Sam")] }] },
    });
    const bobUser = run.users.bob;
    const grant = await alice.request.post(`/api/files/file/${sheetId}/grants`, {
      headers: { Authorization: auth },
      data: { grantee_user_id: bobUser.id, can_edit: true },
    });
    expect(grant.ok()).toBeTruthy();

    // Alice: row 2 selected → comment on A2, mentioning Bob.
    await alice.goto(`/files/sheet/${sheetId}?tab=Rota&row=2`);
    await expect(alice.locator(".fortune-name-box")).toContainText("A2", { timeout: 20_000 });
    await alice.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = alice.getByRole("complementary", { name: "Comments" });
    await panel.getByRole("button", { name: "Comment on A2" }).click();
    await panel.getByRole("textbox").first().fill(`@${bobUser.username} can you cover this?`);
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = panel.getByRole("article", { name: /Comment by/ });
    await expect(thread).toContainText("can you cover this?");
    await expect(thread.getByText("A2", { exact: true })).toBeVisible();
    await expect(thread).toContainText("Tuesday");
    await expect(alice.getByRole("button", { name: "Comments (1)" })).toBeVisible();

    // Bob is told, and the notification opens the sheet on that cell.
    await bob.goto("/chat");
    await ready(bob);
    await bob.locator("aside").getByRole("button", { name: "Open notification inbox" }).click();
    const note = bob.getByText(`${run.users.alice.username} mentioned you in a comment on “${title}”`);
    await expect(note).toBeVisible({ timeout: 20_000 });
    await note.click();
    await expect(bob).toHaveURL(new RegExp(`/files/sheet/${sheetId}\\?comment=`), { timeout: 20_000 });
    const bobPanel = bob.getByRole("complementary", { name: "Comments" });
    await expect(bobPanel.getByRole("article", { name: /Comment by/ })).toContainText("can you cover this?");
    await expect(bob.locator(".fortune-name-box")).toContainText("A2", { timeout: 20_000 });
    // He replies; Alice sees it without reloading.
    await bobPanel.getByRole("button", { name: "Reply" }).click();
    await bobPanel.getByRole("textbox", { name: "Reply…" }).fill("Yes, I can.");
    await bobPanel.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread).toContainText("Yes, I can.", { timeout: 20_000 });
  });

  test("a comment on whiteboard shapes selects them again when clicked", async ({ alice: page }) => {
    const auth = await bearer(page);
    const r = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "whiteboard", title: `E2E garden ${stamp}` },
    });
    const boardId = (await r.json()).id as string;
    await page.goto(`/files/whiteboard/${boardId}`);
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Connecting canvas…")).toHaveCount(0, { timeout: 20_000 });

    // Draw a rectangle (R, then drag) — it stays selected.
    const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;
    await page.getByTitle(/^Rectangle/).click();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x - 80, y - 50);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 50, { steps: 8 });
    await page.mouse.up();

    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Comments" });
    await panel.getByRole("button", { name: "Comment on the selection" }).click();
    await panel.getByRole("textbox").first().fill("Make the shed bigger?");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = panel.getByRole("article", { name: /Comment by/ });
    await expect(thread).toContainText("Make the shed bigger?");
    await expect(thread.getByText("1 shape", { exact: true })).toBeVisible();

    // Deselect, then the thread brings the selection back.
    await page.keyboard.press("Escape");
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.7);
    await expect(panel.getByRole("button", { name: "Comment on the whiteboard" })).toBeVisible();
    await thread.click();
    await expect(panel.getByRole("button", { name: "Comment on the selection" })).toBeVisible();
  });
});
