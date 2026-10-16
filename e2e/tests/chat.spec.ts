import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";
import { png } from "../lib/files";

const composer = (page: Page) => page.getByPlaceholder(/^Message Promptly/);
const replies = (page: Page) => page.locator(".promptly-message:not(.flex-row-reverse)");
const lastReply = (page: Page) => replies(page).last();

async function newChat(page: Page): Promise<void> {
  await page.goto("/chat");
  await ready(page);
  await expect(page.getByRole("heading", { name: "What can I help you with?" })).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function pickModel(page: Page, name: RegExp): Promise<void> {
  await page.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name }).click();
  await expect(page.locator('button[aria-haspopup="listbox"]').first()).toContainText(name);
}

test.describe("chat", () => {
  test("send a message and get a streamed reply", async ({ alice: page }) => {
    await newChat(page);
    await send(page, "hello from the safety net");

    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
    await expect(lastReply(page)).toContainText("hello from the safety net");
    await expect(lastReply(page)).toContainText(/Echo #\d+/);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

    // It's saved: a reload shows the same exchange.
    await page.reload();
    await ready(page);
    await expect(lastReply(page)).toContainText("hello from the safety net");
  });

  test("Stop ends a reply while it's streaming", async ({ alice: page }) => {
    await newChat(page);
    await send(page, "[slow] count for me");

    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    await expect(page.getByText(/word3\b/)).toBeVisible();
    await page.getByRole("button", { name: "Stop generating" }).click();

    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
    // What was written stays, marked as stopped (WP-1.2) — it used to vanish.
    await expect(lastReply(page)).toContainText("word3");
    await expect(lastReply(page)).toContainText("Stopped.");
    // Nothing more arrives after Stop: the last word is still well short
    // of the 40 the fake model would have sent.
    await page.waitForTimeout(1500);
    await expect(page.getByText(/word40\b/)).toHaveCount(0);

    // And it was saved, not just left on screen.
    await page.reload();
    await ready(page);
    await expect(lastReply(page)).toContainText("word3");
    await expect(lastReply(page)).toContainText("Stopped.");
  });

  test("a reply cut off by a dropped connection keeps its text and says so", async ({ alice: page }) => {
    await newChat(page);
    await send(page, "[fail] tell me something");

    await expect(page.getByText("The model host hiccuped")).toBeVisible();
    await expect(lastReply(page)).toContainText("Partial reply before the drop");
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

    await page.reload();
    await ready(page);
    await expect(lastReply(page)).toContainText("Partial reply before the drop");
    await expect(lastReply(page)).toContainText("didn't finish");
  });

  test("Regenerate replaces the reply with a new one", async ({ alice: page }) => {
    await newChat(page);
    await send(page, "say something");
    await expect(lastReply(page)).toContainText(/Echo #\d+/);
    const first = (await lastReply(page).innerText()).match(/Echo #(\d+)/)![1];

    await page.getByRole("button", { name: "Regenerate reply" }).click();
    await expect(lastReply(page)).not.toContainText(`Echo #${first}:`);
    await expect(lastReply(page)).toContainText(/Echo #\d+: say something/);
  });

  test("attach an image and a vision model sees it", async ({ alice: page }) => {
    const image = png();
    await newChat(page);
    await pickModel(page, /E2E Mock Vision/);

    await page.getByRole("button", { name: "Add to message" }).click();
    await page.getByRole("menuitem", { name: "Attach files" }).click();
    const picker = page.getByRole("dialog", { name: "Attach files" });
    await picker.getByRole("button", { name: "Upload new" }).click();
    const chooser = page.waitForEvent("filechooser");
    await picker.getByRole("button", { name: "Choose files to upload" }).click();
    await (await chooser).setFiles(image);
    await picker.getByRole("button", { name: /^Attach \(1\)/ }).click();

    await expect(page.locator('div[title^="e2e-photo.png"]')).toBeVisible();
    await send(page, "what is in this picture?");

    await expect(lastReply(page)).toContainText("I can see 1 image");
    await expect(page.getByRole("button", { name: "Preview e2e-photo.png" })).toBeVisible();
  });

  test("the desktop composer shows Enhance and Queue only when they can do something", async ({ alice: page }) => {
    // V5: seven controls, with Enhance and Queue greyed out most of the time.
    await newChat(page);
    const enhance = page.getByRole("button", { name: "Enhance" });
    const queue = page.getByRole("button", { name: "Queue this prompt for later" });
    await expect(enhance).toHaveCount(0);
    await expect(queue).toHaveCount(0);

    await composer(page).fill("draft");
    await expect(enhance).toBeVisible();

    await send(page, "[slow] count for me");
    await expect(queue).toBeVisible();
    await expect(enhance).toHaveCount(0);
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(queue).toHaveCount(0);
  });
});
