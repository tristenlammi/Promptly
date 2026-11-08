import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

/** Picking several emails to act on together, and Mark all as read. */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const person = { name: "Sam", addr: "sam@example.com" };
const SUBJECTS = { a: "First email", b: "Second email", c: "Third email", d: "Fourth email" };
const row = (key: keyof typeof SUBJECTS) => ({ account_id: ACCOUNT, key, subject: SUBJECTS[key], snippet: "Hello", from: person, at: "2026-11-05T01:00:00+00:00", count: 1, unread: 1, starred: false, attachments: false, labels: [], summary: "", needs_reply: false });
const label = (id: string, name: string) => ({ id, name, color: "#D97757", unread: 1, fetching: false });

interface Sent {
  keys: string[];
  action: string;
}

async function mailbox(page: Page) {
  const state = { inbox: ["a", "b", "c", "d"] as (keyof typeof SUBJECTS)[], acted: [] as Sent[], labelled: [] as { label: string; keys: string[] }[], markedAll: [] as unknown[] };
  await page.route("**/api/mail/**", async (r) => {
    const url = new URL(r.request().url());
    const post = r.request().method() === "POST";
    if (url.pathname.endsWith("/mail/mark-all-read")) {
      state.markedAll.push(r.request().postDataJSON());
      return r.fulfill({ json: { marked: 2 } });
    }
    if (url.pathname.endsWith("/mail/threads/action") && post) {
      const { threads, action } = r.request().postDataJSON() as { threads: { key: keyof typeof SUBJECTS }[]; action: string };
      const keys = threads.map((t) => t.key);
      state.acted.push({ keys, action });
      if (action === "trash" || action === "archive") state.inbox = state.inbox.filter((k) => !keys.includes(k));
      return r.fulfill({ status: 204 });
    }
    const labelling = url.pathname.match(/mail\/labels\/([^/]+)\/threads$/);
    if (labelling) {
      const keys = (r.request().postDataJSON() as { threads: { key: keyof typeof SUBJECTS }[] }).threads.map((t) => t.key);
      state.labelled.push({ label: labelling[1], keys });
      state.inbox = state.inbox.filter((k) => !keys.includes(k));
      return r.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/mail/overview")) {
      return r.fulfill({
        json: {
          accounts: [{ id: ACCOUNT, email: "me@example.com", display_name: "Me", color: "#D97757", provider: "imap", signature: "", notify: false, status: "ok", status_detail: "", last_sync_at: "2026-11-05T01:00:00+00:00", pinned: false }],
          folders: [],
          labels: [label("homes", "Homes"), label("lot", "Homes/Lot 7"), label("family", "Family")],
          sorting: false,
          needs_reply: 0,
          failed: [],
        },
      });
    }
    if (url.pathname.endsWith("/mail/threads")) {
      const here = (url.searchParams.get("role") ?? "inbox") === "inbox" && !url.searchParams.get("label");
      return r.fulfill({ json: { threads: here ? state.inbox.map(row) : [], next: null } });
    }
    const reading = url.pathname.match(/mail\/threads\/[^/]+\/([abcd])$/);
    if (reading) {
      const key = reading[1] as keyof typeof SUBJECTS;
      return r.fulfill({
        json: {
          account_id: ACCOUNT,
          key,
          subject: SUBJECTS[key],
          labels: [],
          messages: [{ id: "33333333-3333-4333-8333-333333333333", message_id: `<${key}@example.com>`, subject: SUBJECTS[key], from: person, to: [], cc: [], at: "2026-11-05T01:00:00+00:00", text: "Hello", html: "", attachments: [], unsubscribe: "", seen: true, starred: false, remote_images: false, reply_to: "", invite: null }],
        },
      });
    }
    return r.fulfill({ json: {} });
  });
  await page.goto("/mail");
  await expect(email(page, "First")).toBeVisible();
  return state;
}

const email = (page: Page, word: string) => page.getByRole("button", { name: new RegExp(`${word} email`) }).first();
const bar = (page: Page) => page.getByRole("toolbar", { name: "Selected conversations" });
const menu = (page: Page) => page.getByRole("menu");

test("Shift-click picks everything between two emails, and they go to Trash together", async ({ alice: page }) => {
  const state = await mailbox(page);
  await email(page, "First").click();
  await expect(page.getByRole("heading", { name: "First email" })).toBeVisible();

  await email(page, "Third").click({ modifiers: ["Shift"] });
  await expect(bar(page).getByText("3 selected")).toBeVisible();
  await expect(page.getByText("3 conversations selected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "First email" })).toHaveCount(0);
  await expect(email(page, "Second")).toHaveAttribute("aria-pressed", "true");
  await expect(email(page, "Fourth")).not.toHaveAttribute("aria-pressed", "true");
  // Shift doesn't drag a text selection across the list.
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");

  // Shift-clicking somewhere else measures from the same start.
  await email(page, "Fourth").click({ modifiers: ["Shift"] });
  await expect(bar(page).getByText("4 selected")).toBeVisible();
  await email(page, "Second").click({ modifiers: ["Shift"] });
  await expect(bar(page).getByText("2 selected")).toBeVisible();
  await email(page, "Third").click({ modifiers: ["Shift"] });

  await bar(page).getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("status").getByText("Moved 3 conversations to Trash")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(email(page, "Second")).toHaveCount(0);
  await expect(email(page, "Fourth")).toBeVisible();
  // Inside the undo time nothing has gone yet, and looking for it sends it.
  expect(state.acted).toEqual([]);
  await page.getByRole("button", { name: "Trash", exact: true }).first().click();
  await expect.poll(() => state.acted).toEqual([{ keys: ["a", "b", "c"], action: "trash" }]);
});

test("Ctrl-click picks one at a time, starting from the one you're reading", async ({ alice: page }) => {
  await mailbox(page);
  await email(page, "Second").click();
  await email(page, "Fourth").click({ modifiers: ["Control"] });
  await expect(bar(page).getByText("2 selected")).toBeVisible();
  await expect(email(page, "Second")).toHaveAttribute("aria-pressed", "true");
  await expect(email(page, "Third")).not.toHaveAttribute("aria-pressed", "true");

  await email(page, "Fourth").click({ modifiers: ["Control"] });
  await expect(bar(page).getByText("1 selected")).toBeVisible();

  // Nothing open and nothing picked: Ctrl-click doesn't open it, so it stays unread.
  await email(page, "Second").click({ modifiers: ["Control"] });
  await expect(bar(page)).toHaveCount(0);
  await email(page, "First").click({ modifiers: ["Control"] });
  await expect(bar(page).getByText("1 selected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "First email" })).toHaveCount(0);

  // A plain click is back to reading.
  await email(page, "Third").click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Third email" })).toBeVisible();
});

test("Undo puts them all back, and nothing was sent", async ({ alice: page }) => {
  const state = await mailbox(page);
  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Second").click({ modifiers: ["Control"] });
  await bar(page).getByRole("button", { name: "Archive" }).click();
  await expect(email(page, "First")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(email(page, "First")).toBeVisible();
  await expect(email(page, "Second")).toBeVisible();
  await page.waitForTimeout(5500);
  expect(state.acted).toEqual([]);
});

test("right-clicking one you've picked acts on them all; any other is on its own", async ({ alice: page }) => {
  const state = await mailbox(page);
  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Second").click({ modifiers: ["Control"] });

  // Escape closes the menu and leaves what you picked alone.
  await email(page, "Second").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(bar(page).getByText("2 selected")).toBeVisible();

  // Delete with a menu open doesn't reach the emails underneath.
  await email(page, "Second").click({ button: "right" });
  await page.keyboard.press("Delete");
  await expect(email(page, "Second")).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);

  await menu(page).getByRole("button", { name: "Mark as read" }).click();
  await expect.poll(() => state.acted).toEqual([{ keys: ["a", "b"], action: "read" }]);
  await expect(bar(page).getByText("2 selected")).toBeVisible();

  await email(page, "Fourth").click({ button: "right" });
  await expect(menu(page).getByRole("button", { name: "Make a rule from this…" })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
});

test("several go into a label at once", async ({ alice: page }) => {
  const state = await mailbox(page);
  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Third").click({ modifiers: ["Control"] });
  await bar(page).getByRole("button", { name: "Move to label…" }).click();
  const sheet = page.getByRole("dialog");
  // A rule is made from one email.
  await expect(sheet.getByText("Do this for future emails too…")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Family" }).click();
  await expect.poll(() => state.labelled).toEqual([{ label: "family", keys: ["a", "c"] }]);
  await expect(page.getByRole("status").getByText("Moved 2 conversations to Family")).toBeVisible();
});

test("keys: Ctrl+A picks the list, Delete bins it, Escape lets go", async ({ alice: page }) => {
  const state = await mailbox(page);
  await page.keyboard.press("Control+a");
  await expect(bar(page).getByText("4 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);

  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Second").click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await expect(page.getByRole("status").getByText("Moved 2 conversations to Trash")).toBeVisible();
  await expect.poll(() => state.acted, { timeout: 8000 }).toEqual([{ keys: ["a", "b"], action: "trash" }]);

  // Reading an email, Ctrl+A is for its words.
  await email(page, "Third").click();
  await expect(page.getByRole("heading", { name: "Third email" })).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(bar(page)).toHaveCount(0);
});

test("dragging one you've picked brings the others", async ({ alice: page }) => {
  const state = await mailbox(page);
  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Second").click({ modifiers: ["Control"] });

  const from = (await email(page, "Second").boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 40, { steps: 3 });
  const archive = (await page.locator('[data-mail-drop="role:archive"]').boundingBox())!;
  await page.mouse.move(archive.x + 20, archive.y + 10, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByRole("status").getByText("Archived 2 conversations")).toBeVisible();
  await expect.poll(() => state.acted, { timeout: 8000 }).toEqual([{ keys: ["a", "b"], action: "archive" }]);
});

test("closing the page straight after binning several doesn't lose them", async ({ alice: page }) => {
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = (url, options) => {
      if (options?.keepalive) sessionStorage.setItem("sent-as-closing", `${url} ${options.body}`);
      return real(url, options);
    };
  });
  await mailbox(page);
  await email(page, "First").click({ modifiers: ["Control"] });
  await email(page, "Second").click({ modifiers: ["Control"] });
  await bar(page).getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("status").getByText("Moved 2 conversations to Trash")).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("sent-as-closing"))).toBe(
    `/api/mail/threads/action {"threads":[{"account_id":"${ACCOUNT}","key":"a"},{"account_id":"${ACCOUNT}","key":"b"}],"action":"trash"}`,
  );
});

test("Mark all as read, from a folder, a label, the list and an email", async ({ alice: page }) => {
  const state = await mailbox(page);
  const nav = page.getByRole("navigation", { name: "Mail folders" });
  const markAll = () => menu(page).getByRole("button", { name: "Mark all as read" }).click();

  await nav.getByRole("button", { name: "Archive", exact: true }).click({ button: "right" });
  await markAll();
  await expect(page.getByText("Marked 2 conversations as read.")).toBeVisible();
  await expect.poll(() => state.markedAll).toEqual([{ role: "archive" }]);

  // A label on its own, with what's inside it only when that's folded away.
  await nav.getByRole("button", { name: "Homes", exact: true }).click({ button: "right" });
  await expect(menu(page).getByRole("button", { name: "Manage labels and rules…" })).toBeVisible();
  await markAll();
  await expect.poll(() => state.markedAll).toEqual([{ role: "archive" }, { labels: ["homes"] }]);

  await nav.getByRole("button", { name: "Hide labels inside Homes" }).click();
  await nav.getByRole("button", { name: "Homes", exact: true }).click({ button: "right" });
  await markAll();
  await expect.poll(() => state.markedAll.at(-1)).toEqual({ labels: ["homes", "lot"] });

  await email(page, "First").click({ button: "right" });
  await markAll();
  await expect.poll(() => state.markedAll.at(-1)).toEqual({ role: "inbox" });

  // Search results aren't a place, so there's nothing to mark "all" of.
  await page.getByLabel("Search your mail").fill("First");
  await page.waitForTimeout(400);
  await nav.getByRole("button", { name: "Inbox", exact: true }).click({ button: "right" });
  await expect(menu(page).getByRole("button", { name: "Mark all as read" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await email(page, "First").click({ button: "right" });
  await expect(menu(page).getByRole("button", { name: "Mark as read" })).toBeVisible();
  await expect(menu(page).getByRole("button", { name: "Mark all as read" })).toHaveCount(0);
});

test("on a phone, Select from the menu and then tap to pick more", async ({ alice: page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mailbox(page);
  await email(page, "First").click({ button: "right" });
  await menu(page).getByRole("button", { name: "Select" }).click();
  await expect(bar(page).getByText("1 selected")).toBeVisible();

  await email(page, "Third").click();
  await expect(bar(page).getByText("2 selected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Third email" })).toHaveCount(0);

  await bar(page).getByRole("button", { name: "Clear selection" }).click();
  await email(page, "Third").click();
  await expect(page.getByRole("heading", { name: "Third email" })).toBeVisible();
});
