import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

const composer = (page: Page) => page.getByPlaceholder(/^Message Promptly/);
const userMsgs = (page: Page) => page.locator(".promptly-message.flex-row-reverse");
const replies = (page: Page) => page.locator(".promptly-message:not(.flex-row-reverse)");

async function newChat(page: Page) {
  await page.goto("/chat");
  await ready(page);
}

async function say(page: Page, text: string) {
  const before = await replies(page).count();
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(replies(page)).toHaveCount(before + 1);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
}

test.describe("chat feel", () => {
  test("Enter while composing CJK text doesn't send", async ({ alice: page }) => {
    await newChat(page);
    await composer(page).fill("你好");
    // What an input method sends while a candidate is being chosen.
    await composer(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/chat$/);
    await expect(composer(page)).toHaveValue("你好");
  });

  test("any turn can be edited or regenerated, not just the last", async ({ alice: page }) => {
    await newChat(page);
    await say(page, "first question");
    await say(page, "second question");

    await expect(page.getByRole("button", { name: "Regenerate reply" })).toHaveCount(2);
    await userMsgs(page).first().getByRole("button", { name: "More actions" }).click();
    await expect(page.getByText("Edit & resend")).toBeVisible();
  });

  test("a question left without an answer can be sent again", async ({ alice: page }) => {
    await newChat(page);
    await say(page, "will this get answered?");
    const id = new URL(page.url()).pathname.split("/").pop();
    // As if the reply never arrived: drop it from what the page loads.
    await page.route(`**/api/chat/conversations/${id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.messages = (body.messages as Array<{ role: string }>).filter((m) => m.role !== "assistant");
      await route.fulfill({ response: res, json: body });
    }, { times: 1 });
    await page.reload();
    await ready(page);

    await page.getByRole("button", { name: "No reply yet — send again" }).click();
    await expect(replies(page).last()).toContainText("will this get answered?");
  });

  test("a new question scrolls to the top with room for the answer", async ({ alice: page }) => {
    await page.setViewportSize({ width: 1366, height: 640 });
    await newChat(page);
    for (let i = 0; i < 5; i++) await say(page, `filler message number ${i} to fill the screen`);

    await composer(page).fill("[slow] and now a long answer");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/word2\b/)).toBeVisible();
    await page.waitForTimeout(800); // the smooth scroll

    const scroller = page.locator(".promptly-scroll").first();
    const top = await scroller.evaluate((el) => el.getBoundingClientRect().top);
    const bubbleTop = await userMsgs(page).last().evaluate((el) => el.getBoundingClientRect().top);
    expect(bubbleTop - top).toBeLessThan(80);
    await page.getByRole("button", { name: "Stop generating" }).click();
  });

  test("a rejected send explains itself", async ({ alice: page }) => {
    await newChat(page);
    await page.route("**/api/chat/conversations/*/messages", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 429, contentType: "text/html", body: "<html>429 Too Many Requests</html>" })
        : route.fallback()
    );
    await composer(page).fill("hello?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Too many requests at once. Wait a moment and try again.").first()).toBeVisible();
    await expect(page.getByText(/status code 429/)).toHaveCount(0);
    // The message isn't lost: it stays, ready to send again.
    await expect(page.locator(".promptly-message.flex-row-reverse").last()).toContainText("hello?");
  });
});
