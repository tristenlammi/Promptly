import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Version history (WP-6.2): named versions, what restoring changes, and a
 *  restore that every open editor reloads onto. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test.describe("version history", () => {
  test("restoring a document version brings it back for every open tab", async ({ alice: page }) => {
    test.setTimeout(120_000);
    const auth = await bearer(page);
    const r = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "document", title: `E2E history ${stamp}` },
    });
    const docId = (await r.json()).id as string;
    await page.goto(`/files/doc/${docId}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
    await editor.click();
    await page.keyboard.type("Version one.");
    await expect(editor).toContainText("Version one.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3500); // the collab store is debounced

    // Save a named version.
    await page.getByRole("button", { name: "History" }).click();
    const panel = page.getByRole("complementary", { name: "Version history" });
    await panel.getByRole("button", { name: "Save a version now" }).click();
    await panel.getByLabel("Version name").fill("First draft");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("First draft")).toBeVisible();
    await panel.getByRole("button", { name: "Close version history" }).click();

    // A second tab, and more writing.
    const other = await page.context().newPage();
    await other.goto(`/files/doc/${docId}`);
    const otherEditor = other.locator(".ProseMirror").first();
    await expect(otherEditor).toContainText("Version one.", { timeout: 20_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Plus two.");
    await expect(otherEditor).toContainText("Plus two.", { timeout: 20_000 });

    // What restoring would change, then restore.
    await page.getByRole("button", { name: "History" }).click();
    await panel.getByRole("button", { name: /First draft/ }).click();
    await expect(panel.getByLabel("Changes")).toContainText("Restoring brings back", { timeout: 20_000 });
    await panel.getByRole("button", { name: "Restore this version" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();

    // Both tabs reload onto it.
    await expect(page.getByText(/reloading…/)).toBeVisible();
    await page.waitForLoadState("load");
    await expect(page.locator(".ProseMirror").first()).toContainText("Version one.", { timeout: 30_000 });
    await expect(page.locator(".ProseMirror").first()).not.toContainText("Plus two.");
    await expect(other.locator(".ProseMirror").first()).not.toContainText("Plus two.", { timeout: 30_000 });
    await expect(other.locator(".ProseMirror").first()).toContainText("Version one.");

    // What was there is kept.
    const versions = await (await page.request.get(`/api/files/${docId}/versions`, { headers: { Authorization: auth } })).json();
    expect(versions.versions.some((v: { label: string | null }) => v.label?.startsWith("Before restoring"))).toBe(true);
  });

  test("restoring a sheet version shows the changed cells and brings the workbook back exactly", async ({
    alice: page,
  }) => {
    const auth = await bearer(page);
    const r = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "sheet", title: `E2E ledger ${stamp}` },
    });
    const sheetId = (await r.json()).id as string;
    const cell = (row: number, col: number, v: string | number) => ({ r: row, c: col, v: { v, m: String(v) } });
    const put = (data: unknown) =>
      page.request.put(`/api/files/${sheetId}/sheet`, { headers: { Authorization: auth }, data: { data } });
    const v1 = [{ name: "Q1", id: "q1", order: 0, celldata: [cell(0, 0, "Rent"), cell(0, 1, 900)],
      config: { merge: {} } }];
    expect((await put(v1)).ok()).toBeTruthy();
    const snap = await page.request.post(`/api/files/${sheetId}/versions`, {
      headers: { Authorization: auth },
      data: { source: "manual", label: "Before the rent rise" },
    });
    expect(snap.ok()).toBeTruthy();
    expect((await put([{ ...v1[0], celldata: [cell(0, 0, "Rent"), cell(0, 1, 950)] },
      { name: "Q2", id: "q2", order: 1, celldata: [] }])).ok()).toBeTruthy();

    await page.goto(`/files/sheet/${sheetId}`);
    await page.getByRole("button", { name: "History", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Version history" });
    await panel.getByRole("button", { name: /Before the rent rise/ }).click();
    const changes = panel.getByLabel("Changes");
    await expect(changes).toContainText("Q1!B1", { timeout: 20_000 });
    await expect(changes).toContainText("tabs added since: Q2");
    await panel.getByRole("button", { name: "Restore this version" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText(/reloading…/)).toBeVisible();
    await expect
      .poll(async () => {
        const body = await (await page.request.get(`/api/files/${sheetId}/sheet`, { headers: { Authorization: auth } })).json();
        const tabs = body.data as { name: string; celldata: { r: number; c: number; v: { v: unknown } }[] }[];
        return `${tabs.length}:${tabs[0].celldata.find((c) => c.r === 0 && c.c === 1)?.v.v}`;
      }, { timeout: 30_000 })
      .toBe("1:900");
  });
});
