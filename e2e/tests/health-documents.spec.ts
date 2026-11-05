import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Attach a report in the Health app's AI chat. The model's side is covered by the
 *  backend tests: here, that the file goes up and is sent with the message. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a report attached in the Ask panel goes with the message", async ({ alice: page }) => {
  test.setTimeout(90_000);
  const auth = await bearer(page);
  const headers = { Authorization: auth };
  await page.request.post("/api/items/store/health", { headers });
  const made = await page.request.post("/api/items", { headers, data: { kind: "health" } });
  const fileId = (await made.json()).file_id as string;
  // Installed apps add tools to every chat: don't leave it for the other tests.
  try {

    let sent: { message?: string; attachment_ids?: string[] } = {};
    await page.route(`**/api/items/${fileId}/ai`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "text", text: "Logged 3 results." })}\n\ndata: ${JSON.stringify({ type: "done", changed: false, revision: 1, version_id: null })}\n\n`,
      });
    });

    await page.goto(`/apps/health/${fileId}`);
    const attach = page.locator('input[type="file"][aria-label="Attach a file"]');
    await expect(page.getByRole("button", { name: /^Ask AI/ })).toBeVisible({ timeout: 20_000 });
    // It may remember being open.
    if (!(await attach.count())) await page.getByRole("button", { name: /^Ask AI/ }).click();
    const name = `bloods-${stamp}.txt`;
    await attach.setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("Collected 28 Oct 2026 08:15\nFerritin 18 ug/L (30-500)\n"),
    });
    const chip = page.getByRole("button", { name: `Remove ${name}` });
    await expect(chip).toBeVisible({ timeout: 20_000 });

    // Just the file, with nothing typed.
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Logged 3 results.")).toBeVisible({ timeout: 20_000 });
    expect(sent.attachment_ids).toHaveLength(1);
    expect(sent.message).toBeTruthy();
    await expect(chip).toHaveCount(0);
    await expect(page.getByText(`[Attached: ${name}]`, { exact: false })).toBeVisible();
  } finally {
    await page.request.delete("/api/items/store/health", { headers });
  }
});
