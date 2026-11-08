import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

/** Account → Memory: what it always keeps in mind, what's waiting for approval, what used
 *  to be true, and where it may learn from. On a made-up store. */

const fact = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, content, source: "auto", source_conversation_id: null, category: "context", pinned: false, times_used: 0, last_used_at: null,
  created_at: "2026-11-01T01:00:00+00:00", updated_at: "2026-11-01T01:00:00+00:00", status: "active", valid_until: null, retired_reason: null,
  expires_at: null, workspace_id: null, source_ref: null, ...extra,
});

async function store(page: Page) {
  const state = {
    posted: [] as string[],
    learning: { mail: false, calendar: false, health: false, mail_allowed: true },
    saved: [] as unknown[],
    suggestions: [
      fact("s1", "User has asthma", { status: "suggested", source_conversation_id: "11111111-1111-4111-8111-111111111111" }),
      fact("s2", "User is flying to Tokyo", { status: "suggested", source_ref: { kind: "mail", title: "Booking", url: "/mail?open=x/y" } }),
    ],
    past: [fact("p1", "User drove a Hilux", { status: "retired", retired_reason: "no_longer_true", valid_until: "2026-10-01T00:00:00+00:00" })],
  };
  await page.route("**/api/memory**", async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^.*\/api\/memory/, "");
    const method = r.request().method();
    if (method === "POST" || method === "PUT") state.posted.push(`${method} ${path}`);
    if (path === "" && method === "GET") {
      return r.fulfill({ json: [fact("a1", "User's brother Sam is an electrician", { expires_at: "2027-01-01T00:00:00+00:00", workspace_id: "22222222-2222-4222-8222-222222222222" })] });
    }
    if (path === "/suggestions") return r.fulfill({ json: state.suggestions });
    if (path === "/past") return r.fulfill({ json: state.past });
    if (path === "/people-links") return r.fulfill({ json: { a1: ["Sam Reyes"] } });
    if (path === "/profile") return r.fulfill({ json: { content: "Jordan is a physio with two children.", generated_at: "2026-11-05T01:00:00+00:00" } });
    if (path === "/profile/rebuild") return r.fulfill({ json: { content: "Rewritten profile.", generated_at: "2026-11-06T01:00:00+00:00" } });
    if (path === "/learning" && method === "GET") return r.fulfill({ json: state.learning });
    if (path === "/learning" && method === "PUT") {
      state.saved.push(r.request().postDataJSON());
      state.learning = { ...state.learning, ...r.request().postDataJSON() };
      return r.fulfill({ json: state.learning });
    }
    if (path === "/learning/check") return r.fulfill({ json: { suggested: 2 } });
    if (path === "/read-older-chats") return r.fulfill({ json: { chats: 14 } });
    if (path === "/a1/history") return r.fulfill({ json: [{ id: "v1", content: "User's brother Sam is an apprentice", category: "context", replaced_at: "2026-09-01T00:00:00+00:00", changed_by: "capture" }] });
    const answered = path.match(/^\/(s\d)\/(approve|dismiss)$/);
    if (answered) {
      state.suggestions = state.suggestions.filter((m) => m.id !== answered[1]);
      return r.fulfill({ status: answered[2] === "approve" ? 200 : 204, json: answered[2] === "approve" ? fact(answered[1], "x") : undefined });
    }
    if (path === "/p1/restore") {
      state.past = [];
      return r.fulfill({ json: fact("p1", "User drove a Hilux") });
    }
    return r.fulfill({ json: fact("a1", "x") });
  });
  await page.goto("/account/memory");
  return state;
}

test("what it keeps in mind, and a fact's dates, people and history", async ({ bob: page }) => {
  const state = await store(page);
  await expect(page.getByText("Jordan is a physio with two children.")).toBeVisible();
  await page.getByRole("button", { name: "Rewrite" }).click();
  await expect.poll(() => state.posted).toContain("POST /profile/rebuild");

  await expect(page.getByText("Sam Reyes")).toBeVisible();
  await expect(page.getByText(/Until /)).toBeVisible();
  await expect(page.getByText("In one workspace")).toBeVisible();

  await page.getByRole("button", { name: "What it used to say" }).click();
  await expect(page.getByText(/brother Sam is an apprentice/)).toBeVisible();
  await page.getByRole("button", { name: "Use this" }).click();
  await expect.poll(() => state.posted).toContain("POST /a1/history/v1/restore");
});

test("a suggestion waits for a yes or a no, and shows where it came from", async ({ bob: page }) => {
  const state = await store(page);
  await expect(page.getByText("None of these are used until you say yes.")).toBeVisible();
  await expect(page.getByRole("link", { name: /From mail: Booking/ })).toHaveAttribute("href", "/mail?open=x/y");
  await expect(page.getByRole("link", { name: "From a chat" })).toHaveAttribute("href", "/chat/11111111-1111-4111-8111-111111111111");

  await page.getByRole("button", { name: "Keep: User has asthma", exact: true }).click();
  await expect.poll(() => state.posted).toContain("POST /s1/approve");
  await page.getByRole("button", { name: "Don't keep: User is flying to Tokyo" }).click();
  await expect.poll(() => state.posted).toContain("POST /s2/dismiss");
  await expect(page.getByText("Waiting for your approval")).toHaveCount(0);
});

test("learning from other apps is off until you turn it on", async ({ bob: page }) => {
  const state = await store(page);
  const mail = page.getByRole("checkbox", { name: /^Mail/ });
  await expect(mail).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Look now" })).toHaveCount(0);

  await mail.click();
  await expect(mail).toBeChecked();
  await expect.poll(() => state.saved).toEqual([{ mail: true, calendar: false, health: false }]);
  await page.getByRole("button", { name: "Look now" }).click();
  await expect(page.getByText("2 new suggestions to review.")).toBeVisible();
});

test("an admin's no on AI reading mail is shown, and the switch can't be used", async ({ bob: page }) => {
  await page.route("**/api/memory/learning", (r) => r.fulfill({ json: { mail: false, calendar: false, health: false, mail_allowed: false } }));
  await page.goto("/account/memory");
  await expect(page.getByRole("checkbox", { name: /^Mail/ })).toBeDisabled();
  await expect(page.getByText("Your admin has turned off AI reading mail")).toBeVisible();
});

test("older chats are only read when you ask", async ({ bob: page }) => {
  const state = await store(page);
  await expect.poll(() => state.posted).toEqual([]);
  await page.getByRole("button", { name: "Read my older chats" }).click();
  await expect(page.getByText(/14 chats queued/)).toBeVisible();
  expect(state.posted).toContain("POST /read-older-chats");
});

test("what's no longer true can be put back", async ({ bob: page }) => {
  const state = await store(page);
  await page.getByRole("button", { name: "No longer true (1)" }).click();
  await expect(page.getByText("User drove a Hilux")).toBeVisible();
  await page.getByRole("button", { name: "Put back: User drove a Hilux" }).click();
  await expect.poll(() => state.posted).toContain("POST /p1/restore");
});

async function chatWith(page: Page, events: unknown[]) {
  await page.route("**/api/chat/stream/**", async (r) => {
    const real = await r.fetch();
    const extra = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    await r.fulfill({ response: real, body: extra + (await real.text()) });
  });
  await page.goto("/chat");
  const composer = page.getByPlaceholder(/^Message Promptly/);
  await composer.fill("hello there");
  await page.getByRole("button", { name: "Send message" }).click();
}

test("what was learned in the background is mentioned, with a way to look", async ({ alice: page }) => {
  await chatWith(page, [{ event: "memory_learned", facts: ["User owns a Tesla"], count: 1, suggested: 2 }]);
  await expect(page.getByText("Learned 1 thing from your chats")).toBeVisible();
  await expect(page.getByText(/User owns a Tesla/)).toBeVisible();
  await expect(page.getByText("2 waiting for you to approve")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review" })).toBeVisible();
});

test("Undo puts a changed fact back and only removes a new one", async ({ alice: page }) => {
  const calls: string[] = [];
  await page.route("**/api/memory/**", async (r) => {
    calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname.replace(/^.*\/api\/memory/, "")} ${r.request().postData() ?? ""}`.trim());
    await r.fulfill({ status: 200, json: {} });
  });
  await chatWith(page, [
    {
      event: "memory_saved",
      facts: ["User works at Canva", "User owns a Tesla"],
      ids: ["changed", "added"],
      previous: { changed: { content: "User works at Acme", category: "identity" } },
      count: 2,
    },
  ]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls).toContain('PATCH /changed {"content":"User works at Acme","category":"identity"}');
  expect(calls).toContain("DELETE /added");
  await expect(page.getByText("Undone")).toBeVisible();
});

test("a fact retired in a chat comes back as itself", async ({ alice: page }) => {
  const calls: string[] = [];
  await page.route("**/api/memory/**", async (r) => {
    calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname.replace(/^.*\/api\/memory/, "")}`);
    await r.fulfill({ status: 200, json: {} });
  });
  await chatWith(page, [{ event: "memory_removed", facts: [{ id: "gone", content: "User uses Vim", category: "preferences" }] }]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => calls).toEqual(["POST /gone/restore"]);
});
