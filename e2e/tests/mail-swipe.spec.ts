// Mail on a phone: swiping an email away. One slim notice for a run of
// swipes ("Archived 3 conversations"), sitting above the bottom bars, whose
// Undo puts back the last one; a short swipe springs back and does nothing.
// The mailbox is faked in the page (as the other mail specs do), so nothing
// is sent anywhere.
import { type Locator, type Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SUBJECTS = ["Payslip", "Rates notice", "School newsletter", "Flight booking"];

type Posted = { action: string; keys: string[] };

async function mailbox(page: Page) {
  const state = { gone: new Set<string>(), posted: [] as Posted[] };
  const person = { name: "Sam", addr: "sam@example.com" };
  await page.route("**/api/mail/**", async (r) => {
    const url = new URL(r.request().url());
    const method = r.request().method();
    if (method === "POST" && url.pathname.endsWith("/threads/action")) {
      const body = r.request().postDataJSON() as { action: string; threads: { key: string }[] };
      state.posted.push({ action: body.action, keys: body.threads.map((t) => t.key) });
      for (const t of body.threads) state.gone.add(t.key);
      return r.fulfill({ status: 204 });
    }
    const one = url.pathname.match(/\/threads\/[^/]+\/([^/]+)\/action$/);
    if (method === "POST" && one) {
      state.posted.push({ action: (r.request().postDataJSON() as { action: string }).action, keys: [one[1]] });
      state.gone.add(one[1]);
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
      const inbox = (url.searchParams.get("role") ?? "inbox") === "inbox";
      const threads = SUBJECTS.map((subject, i) => ({ account_id: ACCOUNT, key: `k${i}`, subject, snippet: "…", from: person, at: `2026-11-0${5 - (i % 4)}T01:00:00+00:00`, count: 1, unread: 0, starred: false, attachments: false, labels: [], summary: "", needs_reply: false }));
      return r.fulfill({ json: { threads: inbox ? threads.filter((t) => !state.gone.has(t.key)) : [], next: null } });
    }
    return r.fulfill({ json: {} });
  });
  return state;
}

/** A finger dragged across a row: real touch events, as the row listens for. */
async function swipe(page: Page, row: Locator, dx: number) {
  const b = (await row.boundingBox())!;
  const x = dx > 0 ? b.x + 40 : b.x + b.width - 40;
  const y = b.y + b.height / 2;
  await row.evaluate(
    async (el, { x, y, dx }) => {
      const touch = (cx: number) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y, pageX: cx, pageY: y });
      const fire = (type: string, cx: number, end = false) =>
        el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [touch(cx)], targetTouches: end ? [] : [touch(cx)], changedTouches: [touch(cx)] }));
      const wait = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      fire("touchstart", x);
      for (let i = 1; i <= 12; i++) {
        fire("touchmove", x + (dx * i) / 12);
        await wait();
      }
      fire("touchend", x + dx, true);
    },
    { x, y, dx },
  );
}

test("swiping emails away on a phone: one notice for the run, Undo for the last, a short swipe does nothing", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStateFile("alice"), viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await ctx.route("**/version.json*", (r) => r.abort());
  const page = await ctx.newPage();
  try {
    const state = await mailbox(page);
    await page.goto("/mail");
    const row = (subject: string) => page.getByRole("button", { name: new RegExp(subject) }).first();
    await expect(row("Payslip")).toBeVisible({ timeout: 20_000 });

    // A short swipe springs back: nothing leaves, nothing is said.
    await swipe(page, row("Payslip"), 60);
    await page.waitForTimeout(600);
    await expect(row("Payslip")).toBeVisible();
    await expect(page.getByText(/^Archived/)).toHaveCount(0);

    // Three in a row to the right: archived, counted in ONE notice.
    for (const s of ["Payslip", "Rates notice", "School newsletter"]) {
      await swipe(page, row(s), 260);
      await expect(row(s)).toHaveCount(0, { timeout: 5_000 });
    }
    const notice = page.getByRole("status").filter({ hasText: /^Archived/ });
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText("Archived 3 conversations");
    // Slim: one line, with Undo on it, and clear of the bars at the bottom.
    const n = (await notice.boundingBox())!;
    expect(n.height).toBeLessThan(64);
    const folders = (await page.getByRole("navigation", { name: "Mail folders" }).boundingBox())!;
    expect(n.y + n.height).toBeLessThanOrEqual(folders.y + 1);
    const ask = await page.getByLabel("Ask about your mail").boundingBox();
    if (ask) expect(n.y + n.height).toBeLessThanOrEqual(ask.y + 1);
    // Nothing has been done yet: Undo still works.
    expect(state.posted).toEqual([]);

    // Undo puts back the last one; the two before it go now.
    await notice.getByRole("button", { name: "Undo" }).click();
    await expect(row("School newsletter")).toBeVisible();
    await expect.poll(() => state.posted).toEqual([{ action: "archive", keys: ["k0", "k1"] }]);
    await expect(row("Payslip")).toHaveCount(0);

    // A swipe the other way is a delete, with its own notice.
    await swipe(page, row("Flight booking"), -260);
    await expect(row("Flight booking")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByRole("status").filter({ hasText: "Moved to Trash" })).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});
