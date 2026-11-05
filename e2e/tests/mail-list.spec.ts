import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** The mail list, on a made-up mailbox: quick actions as you point at an email, and
 *  an email you delete stays gone. */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const row = (key: string, subject: string, unread = 1) => ({
  account_id: ACCOUNT,
  key,
  subject,
  snippet: "Hello there",
  from: { name: "Sam", addr: "sam@example.com" },
  at: "2026-11-05T01:00:00+00:00",
  count: 1,
  unread,
  starred: false,
  attachments: false,
  labels: [],
  summary: "",
  needs_reply: false,
});

async function fakeMailbox(page: Page, labels: unknown[] = []) {
  const state = { threads: [row("a", "First email"), row("b", "Second email", 0)], acted: [] as { key: string; action: string }[] };
  await page.route("**/api/mail/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/mail/overview")) {
      return r.fulfill({
        json: {
          accounts: [{ id: ACCOUNT, email: "me@example.com", display_name: "Me", color: "#D97757", provider: "imap", signature: "", notify: false, status: "ok", status_detail: "", last_sync_at: "2026-11-05T01:00:00+00:00", pinned: false }],
          folders: [],
          labels,
          sorting: false,
          needs_reply: 0,
          failed: [],
        },
      });
    }
    if (url.pathname.endsWith("/mail/threads")) {
      // Slow enough that a row put back too early would be seen.
      await new Promise((done) => setTimeout(done, 700));
      return r.fulfill({ json: { threads: state.threads, next: null } });
    }
    const acting = url.pathname.match(/threads\/[^/]+\/([^/]+)\/action$/);
    if (acting) {
      const { action } = r.request().postDataJSON();
      state.acted.push({ key: acting[1], action });
      if (action === "trash" || action === "archive") state.threads = state.threads.filter((t) => t.key !== acting[1]);
      if (action === "read") state.threads = state.threads.map((t) => (t.key === acting[1] ? { ...t, unread: 0 } : t));
      return r.fulfill({ status: 204 });
    }
    return r.fulfill({ json: {} });
  });
  return state;
}

test("an email has quick actions as you point at it", async ({ alice: page }) => {
  const state = await fakeMailbox(page);
  await page.goto("/mail");
  const first = page.getByRole("button", { name: /First email/ });
  await expect(first).toBeVisible();

  const actions = page.getByRole("group", { name: "Quick actions" }).first();
  await expect(actions).toHaveCSS("opacity", "0");
  await first.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  for (const name of ["Archive", "Move to Trash", "Mark as read", "Snooze"]) {
    await expect(actions.getByRole("button", { name })).toBeVisible();
  }

  // An action doesn't open the email as well.
  await actions.getByRole("button", { name: "Mark as read" }).click();
  await expect.poll(() => state.acted).toEqual([{ key: "a", action: "read" }]);
  await expect(page.getByRole("heading", { name: "First email" })).toHaveCount(0);

  await first.hover();
  await actions.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a deleted email doesn't flash back when the undo time runs out", async ({ alice: page }) => {
  const state = await fakeMailbox(page);
  await page.goto("/mail");
  await expect(page.getByRole("button", { name: /First email/ })).toBeVisible();

  // Anything that puts the row back, however briefly, is caught here.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: number; __on: boolean };
    w.__seen = 0;
    w.__on = false;
    const tick = () => {
      if (w.__on) {
        const hit = [...document.querySelectorAll("button")].some(
          (b) => b.textContent?.includes("First email") && b.getBoundingClientRect().height > 20 && getComputedStyle(b.parentElement!.parentElement!.parentElement!).opacity !== "0",
        );
        if (hit) w.__seen++;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });

  await page.getByRole("button", { name: /First email/ }).hover();
  await page.getByRole("group", { name: "Quick actions" }).first().getByRole("button", { name: "Move to Trash" }).click();
  await page.waitForTimeout(400); // the row closing
  await page.evaluate(() => { (window as unknown as { __on: boolean }).__on = true; });

  await expect.poll(() => state.acted, { timeout: 8000 }).toEqual([{ key: "a", action: "trash" }]);
  await page.waitForTimeout(1500); // the slow list arriving, and after
  expect(await page.evaluate(() => (window as unknown as { __seen: number }).__seen)).toBe(0);
  await expect(page.getByRole("button", { name: /Second email/ })).toBeVisible();
});

test("a label still being fetched says so", async ({ alice: page }) => {
  await fakeMailbox(page, [{ id: "22222222-2222-4222-8222-222222222222", name: "Work", color: "#D97757", unread: 0, fetching: true }]);
  await page.route("**/api/mail/threads*", (r) => r.fulfill({ json: { threads: [], next: null } }));
  await page.goto("/mail");
  await page.getByRole("navigation", { name: "Mail folders" }).getByRole("button", { name: "Work" }).click();
  await expect(page.getByText("Fetching this label's mail")).toBeVisible();
});
