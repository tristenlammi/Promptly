import { lastModelRequest } from "../lib/stack";
import { expect, ready, test } from "../fixtures";

test.describe("context", () => {
  test("a one-line question is small, and the meter shows what's in it", async ({ alice: page }) => {
    await page.goto("/chat");
    await ready(page);
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
    await page.getByPlaceholder(/^Message Promptly/).fill("what is 2+2?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".promptly-message:not(.flex-row-reverse)").last()).toContainText("Echo");

    // What was sent: the standing instructions first (cacheable), the
    // date and time after them, and the tools described once (WP-1.4).
    const body = lastModelRequest();
    const system: string = body.messages.find((m: { role: string }) => m.role === "system").content;
    expect(system.startsWith("Tools you can call this turn:")).toBe(true);
    expect(system.indexOf("Today's date")).toBeGreaterThan(system.indexOf("Formatting rules"));
    const size = (JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length) / 4;
    // ~2.9k, plus ~0.5k for the photo tools (search_photos, refine) offered to
    // anyone with a photo library (PH-4), and ~0.2k for propose_photo_action
    // (albums, sharing, relationships from a chat).
    expect(size).toBeLessThan(3700);

    // The meter reads that request and breaks it down.
    const pill = page.getByRole("button", { name: /\d.*\/ 32k/ });
    await pill.click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Tool definitions")).toBeVisible();
    await expect(panel.getByText("Instructions")).toBeVisible();
    await expect(panel.getByText("Date, memories & files")).toBeVisible();
  });
});
