import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

/** A delete or archive waits out its undo time, unless you go looking for it or leave. */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

async function mailbox(page: Page) {
  const state = { place: "inbox", posted: [] as string[] };
  const person = { name: "Sam", addr: "sam@example.com" };
  await page.route("**/api/mail/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/action") && r.request().method() === "POST") {
      const action = r.request().postDataJSON().action as string;
      state.posted.push(action);
      state.place = action;
      return r.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/mail/overview")) {
      return r.fulfill({
        json: {
          accounts: [{ id: ACCOUNT, email: "me@example.com", display_name: "Me", color: "#D97757", provider: "imap", signature: "", notify: false, status: "ok", status_detail: "", last_sync_at: "2026-11-05T01:00:00+00:00", pinned: false }],
          folders: [],
          labels: [],
          sorting: false,
          needs_reply: 0,
          failed: [],
        },
      });
    }
    if (url.pathname.endsWith("/mail/threads")) {
      const here = (url.searchParams.get("role") ?? "inbox") === state.place;
      return r.fulfill({ json: { threads: here ? [{ account_id: ACCOUNT, key: "a", subject: "Payslip", snippet: "Attached", from: person, at: "2026-11-05T01:00:00+00:00", count: 1, unread: 0, starred: false, attachments: false, labels: [], summary: "", needs_reply: false }] : [], next: null } });
    }
    if (url.pathname.includes(`/threads/${ACCOUNT}/a`)) {
      return r.fulfill({
        json: {
          account_id: ACCOUNT,
          key: "a",
          subject: "Payslip",
          labels: [],
          messages: [{ id: "33333333-3333-4333-8333-333333333333", message_id: "<a@example.com>", subject: "Payslip", from: person, to: [], cc: [], at: "2026-11-05T01:00:00+00:00", text: "Attached", html: "", attachments: [], unsubscribe: "", seen: true, starred: false, remote_images: false, reply_to: "", invite: null }],
        },
      });
    }
    return r.fulfill({ json: {} });
  });
  await page.goto("/mail");
  const row = page.getByRole("button", { name: /Payslip/ }).first();
  await row.click();
  return { state, row };
}

test("going straight to Trash after deleting finds it there", async ({ alice: page }) => {
  const { state } = await mailbox(page);
  await page.getByRole("button", { name: "Move to Trash" }).first().click();
  await expect(page.getByText("Moved to Trash")).toBeVisible();
  expect(state.posted).toEqual([]);

  await page.getByRole("button", { name: "Trash", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /Payslip/ }).first()).toBeVisible();
  expect(state.posted).toEqual(["trash"]);
});

test("going straight to Archive after archiving finds it there", async ({ alice: page }) => {
  const { state } = await mailbox(page);
  // The one on the email, after the one in the sidebar.
  await page.getByRole("button", { name: "Archive", exact: true }).last().click();
  await expect(page.getByRole("status").getByText("Archived")).toBeVisible();

  await page.getByRole("button", { name: "Archive", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /Payslip/ }).first()).toBeVisible();
  expect(state.posted).toEqual(["archive"]);
});

test("closing the page straight after deleting doesn't lose it", async ({ alice: page }) => {
  // Playwright can't see a request made as a page closes, so note it from inside the page.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = (url, options) => {
      if (options?.keepalive) sessionStorage.setItem("sent-as-closing", `${url} ${options.body}`);
      return real(url, options);
    };
  });
  await mailbox(page);
  await page.getByRole("button", { name: "Move to Trash" }).first().click();
  await expect(page.getByText("Moved to Trash")).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("sent-as-closing"))).toBe(`/api/mail/threads/${ACCOUNT}/a/action {"action":"trash"}`);
});

test("Undo still means it never happened, and otherwise it goes when the time is up", async ({ alice: page }) => {
  const { state, row } = await mailbox(page);
  await page.getByRole("button", { name: "Move to Trash" }).first().click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeVisible();
  await page.waitForTimeout(5500);
  expect(state.posted).toEqual([]);

  await row.click();
  await page.getByRole("button", { name: "Move to Trash" }).first().click();
  await expect.poll(() => state.posted, { timeout: 8000 }).toEqual(["trash"]);
  await expect(page.getByText("Moved to Trash")).toHaveCount(0);
});
