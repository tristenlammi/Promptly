import { expect, test } from "../fixtures";

/** An attachment that can't be found right now doesn't claim to be deleted, and can be tried again. */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "33333333-3333-4333-8333-333333333333";

test("an attachment not found yet says so, and Try again gets it", async ({ alice: page }) => {
  let found = false;
  let asked = 0;
  const person = { name: "Sam", addr: "sam@example.com" };
  await page.route("**/api/mail/**", async (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname.endsWith("/mail/overview")) {
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
    if (pathname.endsWith("/mail/threads")) {
      return r.fulfill({ json: { threads: [{ account_id: ACCOUNT, key: "a", subject: "Payslip", snippet: "Attached", from: person, at: "2026-11-05T01:00:00+00:00", count: 1, unread: 0, starred: false, attachments: true, labels: [], summary: "", needs_reply: false }], next: null } });
    }
    if (pathname.endsWith(`/attachments/0`)) {
      asked++;
      if (!found) return r.fulfill({ status: 404, json: { detail: "Attachment not found." } });
      return r.fulfill({ contentType: "text/plain", body: "the payslip" });
    }
    if (pathname.includes(`/threads/${ACCOUNT}/a`) && r.request().method() === "GET") {
      return r.fulfill({
        json: {
          account_id: ACCOUNT,
          key: "a",
          subject: "Payslip",
          labels: [],
          messages: [{ id: MESSAGE, message_id: "<a@example.com>", subject: "Payslip", from: person, to: [], cc: [], at: "2026-11-05T01:00:00+00:00", text: "Attached", html: "", attachments: [{ part: 0, name: "payslip.txt", mime: "text/plain", size: 11 }], unsubscribe: "", seen: true, starred: false, remote_images: false, reply_to: "", invite: null }],
        },
      });
    }
    return r.fulfill({ json: {} });
  });

  await page.goto("/mail");
  await page.getByRole("button", { name: /Payslip/ }).first().click();
  await page.getByTitle("Open payslip.txt").click();
  await expect(page.getByText("Couldn't find this in your mailbox just now")).toBeVisible();
  await expect(page.getByText(/may have been deleted/)).toHaveCount(0);

  found = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("the payslip")).toBeVisible();
  expect(asked).toBe(2);
});
