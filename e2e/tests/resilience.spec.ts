import type { Page } from "@playwright/test";

import { expect, ready, run, test } from "../fixtures";

async function aChat(page: Page): Promise<string> {
  await page.goto("/chat");
  await ready(page);
  await page.getByPlaceholder(/^Message Promptly/).fill("resilience check");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
  await expect(page.locator(".promptly-message:not(.flex-row-reverse)").last()).toContainText("Echo");
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Serve the real conversation, altered by ``mutate``. */
async function tamper(page: Page, id: string, mutate: (body: Record<string, unknown>) => void) {
  await page.route(`**/api/chat/conversations/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    mutate(body);
    await route.fulfill({ response: res, json: body });
  });
}

test.describe("resilience", () => {
  test("a link survives signing in", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/files/shared");
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Email or username").fill(run.users.alice.username);
    await page.getByLabel("Password").fill(run.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/files\/shared$/);
    await context.close();
  });

  test("a page that crashes keeps the rest of the app", async ({ alice: page }) => {
    const id = await aChat(page);
    await tamper(page, id, (body) => {
      body.messages = "not a list";
    });
    await page.reload();

    await expect(page.getByText("This page hit a problem")).toBeVisible();
    // The sidebar is still there, and leaving the page recovers.
    await page.getByRole("link", { name: "Files" }).click();
    await expect(page).toHaveURL(/\/files/);
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  });

  test("a message that can't be drawn shows its text instead", async ({ alice: page }) => {
    const id = await aChat(page);
    await tamper(page, id, (body) => {
      const msgs = body.messages as Array<Record<string, unknown>>;
      msgs[msgs.length - 1].content = { not: "a string" };
    });
    await page.reload();
    await ready(page);

    await expect(page.getByText("Couldn't display this message")).toBeVisible();
    // The rest of the conversation still renders.
    await expect(page.getByText("resilience check").first()).toBeVisible();
  });

  test("a failed action says so", async ({ alice: page }) => {
    await aChat(page);
    await page.route("**/api/chat/conversations/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, json: { detail: "Database is having a moment" } })
        : route.fallback()
    );
    // Pin has no error handling of its own — it used to fail silently.
    const row = page.locator("aside").getByRole("button", { name: "Pin conversation" }).first();
    await row.click({ force: true });

    const toasts = page.locator('[aria-live="polite"]');
    await expect(toasts.getByRole("alert")).toContainText("Database is having a moment");
  });

  test("a new chat doesn't claim no provider while models can't load", async ({ alice: page }) => {
    // R-284: loading and a failed fetch both read as "No model provider
    // is connected yet".
    await page.route("**/api/models/available", (route) => route.abort());
    await page.goto("/chat");
    await ready(page);

    await expect(page.getByText(/Couldn't reach the server to load models/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/No models are available yet|No model provider/)).toHaveCount(0);
  });

  test("a web search that found nothing doesn't read as a success", async ({ alice: page }) => {
    // V1: a ✓ "Searched the web" sat over an answer written from memory.
    const id = await aChat(page);
    await tamper(page, id, (body) => {
      const msgs = body.messages as Array<Record<string, unknown>>;
      msgs[msgs.length - 1].tool_calls = [
        { id: "c1", name: "web_search", ok: true, elapsed_ms: 900,
          meta: { query: "latest python version", provider: "searxng", result_count: 0 } },
      ];
    });
    await page.reload();
    await ready(page);

    const card = page.getByRole("button", { name: /Web search found nothing/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByText("no results")).toBeVisible();
  });

  test("a connector action that changes something waits for approval, and says what it did", async ({ alice: page }) => {
    // WP-2.1: destructive connector tools run from chat only after Approve;
    // R-166: the card names the connector, action and target.
    const id = await aChat(page);
    let messageId = "";
    await tamper(page, id, (body) => {
      const msgs = body.messages as Array<Record<string, unknown>>;
      const last = msgs[msgs.length - 1];
      messageId = String(last.id);
      last.tool_calls = [
        { id: "c1", name: "ha__HassUnlock", ok: true, elapsed_ms: 0,
          meta: { connector: "Home Assistant", tool: "HassUnlock", title: "Unlock", target: "front door",
                  acts: true, destructive: true, approval: "pending", connector_id: "00000000-0000-0000-0000-000000000000",
                  arguments: { name: "front door" } } },
      ];
    });
    await page.route("**/api/chat/messages/*/tool-calls/c1/approval", (route) =>
      route.fulfill({ json: { tool_call: {
        id: "c1", name: "ha__HassUnlock", ok: true,
        meta: { connector: "Home Assistant", tool: "HassUnlock", title: "Unlock", target: "front door",
                acts: true, approval: "approved" } } } })
    );
    await page.reload();
    await ready(page);

    await expect(page.getByRole("button", { name: /Waiting for your approval/ })).toBeVisible();
    const card = page.getByRole("group", { name: "Home Assistant: Unlock" });
    await expect(card).toContainText("Nothing has happened yet.");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toContainText("Approved and done.");
    expect(messageId).not.toBe("");
  });
});
