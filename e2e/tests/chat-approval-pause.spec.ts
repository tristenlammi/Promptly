// A page the reply wants to open after reading something from outside
// (chat/holds.py): the reply stops at the card and waits. Yes carries on with
// the page; no carries on without it. An address made only of your own words
// opens without asking.
//
// The fake model's "pausecheck" / "plaincheck" turns read your files, then
// open example.com. The page itself is a real site: these tests pass whether
// or not it can be reached (the answer is the tool's result either way).
import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

const composer = (page: Page) => page.getByPlaceholder(/^Message Promptly/);
const lastReply = (page: Page) => page.locator(".promptly-message:not(.flex-row-reverse)").last();
const card = (page: Page) => page.getByRole("group", { name: /^Open example\.com\?/ });
const shots = process.env.E2E_SHOTS_DIR;

async function ask(page: Page, text: string): Promise<void> {
  // Web tools on for this message, whatever the account's default is.
  await page.route("**/api/chat/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, web_search_mode: "auto", tools_enabled: true }) });
  });
  await page.goto("/chat");
  await ready(page);
  await page.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test.describe("a page the reply wants to open", () => {
  test("the reply stops at the card, and a yes carries on with the page", async ({ alice: page }) => {
    await ask(page, "pausecheck what does that page say");

    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("https://example.com/?ref=held-open");
    await expect(card(page)).toContainText("The reply is waiting for your answer.");
    // Still being written: nothing has been said yet.
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/pause-waiting-${page.viewportSize()?.width}.png` });

    await card(page).getByRole("button", { name: "Yes, do it" }).click();
    await expect(lastReply(page)).toContainText("Tool said:");
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(card(page)).toContainText(/Opened\.|Approved, but it failed/);
    await expect(card(page).getByRole("button", { name: "Yes, do it" })).toHaveCount(0);
    if (shots) await page.screenshot({ path: `${shots}/pause-done-${page.viewportSize()?.width}.png` });

    // Saved that way: no dump of the page on the card, no second question.
    await page.reload();
    await ready(page);
    await expect(card(page)).toContainText(/Opened\.|Approved, but it failed/);
    await expect(lastReply(page)).toContainText("Tool said:");
  });

  test("a no carries on without it", async ({ alice: page }) => {
    await ask(page, "pausecheck and then tell me");

    await card(page).getByRole("button", { name: "No", exact: true }).click();
    await expect(lastReply(page)).toContainText("Tool said: The user was asked and said no");
    await expect(card(page)).toContainText("Not opened.");
  });

  test("leaving and coming back mid-wait still shows the card, and it still answers", async ({ alice: page }) => {
    await ask(page, "pausecheck while I look away");
    await expect(card(page)).toBeVisible();

    await page.reload();
    await ready(page);
    await expect(card(page)).toContainText("The reply is waiting for your answer.");
    await card(page).getByRole("button", { name: "Yes, do it" }).click();
    await expect(lastReply(page)).toContainText("Tool said:");
    await expect(card(page)).toContainText(/Opened\.|Approved, but it failed/);
  });

  test("an address made of your own words opens without asking", async ({ alice: page }) => {
    await ask(page, "plaincheck on example please");

    await expect(lastReply(page)).toContainText("Tool said:");
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});
