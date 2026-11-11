import { expect, test } from "../fixtures";

/** Your reply is in the conversation straight away: "Sending…" until it's gone, then an
 *  ordinary message. One that couldn't go says so and can be tried again. */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OUTBOX = "44444444-4444-4444-8444-444444444444";
const teresa = { name: "Teresa", addr: "teresa@example.com" };
const me = { name: "Me", addr: "me@example.com" };

function message(id: string, from: typeof me, text: string, at: string, outgoing: unknown = null) {
  return { id, message_id: `<${id}@example.com>`, subject: "#21819 - booking", from, to: [from === me ? teresa : me], cc: [], at, text, html: "", attachments: [], unsubscribe: "", seen: true, starred: false, remote_images: false, reply_to: "", invite: null, outgoing };
}

async function mailbox(page: import("@playwright/test").Page, conversation: () => unknown[], posted: string[]) {
  await page.route("**/api/mail/**", async (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname.endsWith("/mail/overview")) {
      return r.fulfill({ json: { accounts: [{ id: ACCOUNT, email: me.addr, display_name: "Me", color: "#D97757", provider: "imap", signature: "", notify: false, status: "ok", status_detail: "", last_sync_at: "2026-11-09T01:00:00+00:00", pinned: false }], folders: [], labels: [], sorting: false, needs_reply: 0, failed: [] } });
    }
    if (pathname.endsWith("/mail/threads")) {
      return r.fulfill({ json: { threads: [{ account_id: ACCOUNT, key: "a", subject: "#21819 - booking", snippet: "A reminder", from: teresa, at: "2026-11-09T05:55:00+00:00", count: 1, unread: 0, starred: false, attachments: false, labels: [], summary: "", needs_reply: false }], next: null } });
    }
    if (pathname.endsWith(`/threads/${ACCOUNT}/a`) && r.request().method() === "GET") {
      return r.fulfill({ json: { account_id: ACCOUNT, key: "a", subject: "#21819 - booking", labels: [], snoozed_until: null, summary: "", messages: conversation() } });
    }
    if (r.request().method() === "POST" && pathname.includes("/mail/send/")) {
      posted.push(pathname);
      return r.fulfill({ status: 204, body: "" });
    }
    return r.fulfill({ json: {} });
  });
}

test("a reply shows as Sending… in its conversation, then as sent", async ({ alice: page }) => {
  let looks = 0;
  const reminder = message("33333333-3333-4333-8333-333333333333", teresa, "A reminder about your booking", "2026-11-09T05:55:00+00:00");
  await mailbox(page, () => {
    looks++;
    const reply = message(looks < 3 ? `outbox-${OUTBOX}` : "55555555-5555-4555-8555-555555555555", me, "Thanks, see you then", "2026-11-09T08:52:00+00:00", looks < 3 ? { id: OUTBOX, status: "waiting", error: "" } : null);
    return [reminder, reply];
  }, []);

  await page.goto("/mail");
  await page.getByRole("button", { name: /#21819 - booking/ }).first().click();
  const sending = page.getByRole("status").filter({ hasText: "Sending…" });
  await expect(sending).toBeVisible();
  await expect(page.getByText("Thanks, see you then").first()).toBeVisible();
  // It looks again by itself, and the reply settles in as an ordinary message.
  await expect(sending).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Thanks, see you then").first()).toBeVisible();
  expect(looks).toBeGreaterThanOrEqual(3);
});

test("a reply that couldn't go says so and can be tried again", async ({ alice: page }) => {
  const posted: string[] = [];
  const reminder = message("33333333-3333-4333-8333-333333333333", teresa, "A reminder about your booking", "2026-11-09T05:55:00+00:00");
  await mailbox(page, () => {
    const status = posted.length ? "waiting" : "failed";
    return [reminder, message(`outbox-${OUTBOX}`, me, "Thanks, see you then", "2026-11-09T08:52:00+00:00", { id: OUTBOX, status, error: status === "failed" ? "Couldn't send this message." : "" })];
  }, posted);

  await page.goto("/mail");
  await page.getByRole("button", { name: /#21819 - booking/ }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Not sent" })).toBeVisible();
  await expect(page.getByText("Couldn't send this message.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sending…" })).toBeVisible();
  expect(posted).toEqual([`/api/mail/send/${OUTBOX}/retry`]);
});
