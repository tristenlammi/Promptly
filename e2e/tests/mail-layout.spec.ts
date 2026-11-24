import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** The mail list, on a made-up mailbox: attachment names on the list that open the
 *  file, and the full-width layout (chosen in Mail settings, kept on the real server). */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const person = { name: "Sam Taylor", addr: "sam@example.com" };
const file = (key: string, part: number, name: string, mime = "text/plain") => ({ message_id: messageId(key), part, name, mime, size: 2048 });
const messageId = (key: string) => `33333333-3333-4333-8333-${key.padStart(12, "0")}`;

function thread(n: number) {
  const key = `k${n}`;
  const files =
    n === 1 ? [file(key, 1, "Trip notes for the long weekend away.txt"), file(key, 2, "Packing list.txt"), file(key, 3, "Map.txt"), file(key, 4, "Tickets.txt")]
    : n === 3 ? [file(key, 1, "Invoice 2041.pdf", "application/pdf")]
    : [];
  return {
    account_id: ACCOUNT,
    key,
    subject: `Email number ${n}`,
    snippet: "Hello there, here is what we talked about",
    from: person,
    at: new Date(Date.UTC(2026, 10, 5, 1, 0) - n * 3_600_000).toISOString(),
    count: 1,
    unread: n % 4 === 0 ? 1 : 0,
    starred: false,
    attachments: files.length > 0,
    files,
    // More than the list was sent: it counts the rest.
    files_total: n === 1 ? 6 : files.length,
    labels: [],
    summary: "",
    needs_reply: false,
  };
}

async function fakeMailbox(page: Page) {
  const seen = { conversations: [] as string[], files: [] as string[] };
  const threads = Array.from({ length: 60 }, (_, i) => thread(i + 1));
  await page.route("**/api/mail/**", async (r) => {
    const { pathname } = new URL(r.request().url());
    // The layout is the real thing: saved on the server, read back after a reload.
    if (pathname.includes("/mail/settings")) return r.continue();
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
    if (pathname.endsWith("/mail/threads")) return r.fulfill({ json: { threads, next: null } });
    const attachment = pathname.match(/messages\/([^/]+)\/attachments\/(\d+)$/);
    if (attachment) {
      seen.files.push(`${attachment[1]}/${attachment[2]}`);
      return r.fulfill({ contentType: "text/plain", body: `the words in file ${attachment[2]}` });
    }
    const one = pathname.match(/threads\/[^/]+\/(k\d+)$/);
    if (one && r.request().method() === "GET") {
      const t = threads.find((x) => x.key === one[1])!;
      seen.conversations.push(t.key);
      return r.fulfill({
        json: {
          account_id: ACCOUNT, key: t.key, subject: t.subject, labels: [], snoozed_until: null, summary: "",
          messages: [{ id: messageId(t.key), message_id: `<${t.key}@example.com>`, subject: t.subject, from: person, to: [], cc: [], at: t.at, text: `The words of ${t.subject}.`, html: "", attachments: t.files.map(({ part, name, mime, size }) => ({ part, name, mime, size })), unsubscribe: "", seen: true, starred: false, remote_images: false, reply_to: "", invite: null }],
        },
      });
    }
    if (r.request().method() === "POST" && pathname.endsWith("/action")) return r.fulfill({ status: 204 });
    return r.fulfill({ json: {} });
  });
  return seen;
}

/** Sets the layout on the server, as the settings sheet would. */
async function setLayout(page: Page, layout: "split" | "full") {
  const asked = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/");
  await ready(page);
  const auth = (await asked).headers()["authorization"];
  const r = await page.request.put("/api/mail/settings/layout", { headers: { Authorization: auth }, data: { layout } });
  expect(r.ok(), await r.text()).toBe(true);
  return auth;
}

const list = (page: Page) => page.getByRole("region", { name: "Conversations" });
const scroller = (page: Page) => page.locator("[data-mail-list-scroll]");
const panel = (page: Page) => page.getByRole("region", { name: "Open conversation" });

test.afterEach(async ({ alice: page }) => {
  // The next test, and the next run, start from the layout everyone starts with.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setLayout(page, "split");
});

test("what's attached is named on the list, and a name opens the file without opening the email", async ({ alice: page }) => {
  await setLayout(page, "split");
  const seen = await fakeMailbox(page);
  await page.goto("/mail");
  await expect(list(page)).toHaveAttribute("data-mail-layout", "split");

  const first = page.locator('[data-mail-row$="/k1"]');
  const chips = first.getByRole("group", { name: "Attachments" });
  // The narrow list: what fits on a line, then how many more.
  await expect(chips.getByRole("button")).toHaveCount(2);
  await expect(chips.getByRole("button", { name: /^Open attachment Packing list\.txt/ })).toBeVisible();
  await expect(chips.getByText("+4")).toBeVisible();
  // A long name is cut in the middle: its end, with the kind of file, is still on screen.
  const long = chips.getByRole("button", { name: /^Open attachment Trip notes for the long weekend away\.txt/ });
  await expect(long).toHaveAttribute("title", /Trip notes for the long weekend away\.txt/);
  const cut = await long.evaluate((el) => {
    const [start, end] = [...el.querySelectorAll("span > span")] as HTMLElement[];
    return { clipped: start.scrollWidth > start.clientWidth, end: end.textContent, endShown: end.getBoundingClientRect().right <= el.getBoundingClientRect().right };
  });
  expect(cut).toEqual({ clipped: true, end: "ay.txt", endShown: true });
  // Nothing attached, no names.
  await expect(page.locator('[data-mail-row$="/k2"]').getByRole("group", { name: "Attachments" })).toHaveCount(0);
  // Never wider than the row it's in.
  expect(await first.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await chips.getByRole("button", { name: /^Open attachment Packing list\.txt/ }).click();
  const viewer = page.getByRole("dialog", { name: "Packing list.txt" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("the words in file 2")).toBeVisible();
  // The same email's other files are a step away.
  await expect(viewer.getByText("2 of 4")).toBeVisible();
  // The email itself was never opened, or even asked for.
  await expect(page.getByRole("heading", { name: "Email number 1" })).toHaveCount(0);
  expect(seen.conversations).toEqual([]);
  expect(seen.files).toEqual([`${messageId("k1")}/2`]);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.getByText("Pick a conversation to read.")).toBeVisible();

  // With the keyboard: Tab reaches a name, Enter opens it.
  const invoice = page.locator('[data-mail-row$="/k3"]').getByRole("button", { name: /^Open attachment Invoice 2041\.pdf/ });
  await invoice.focus();
  await expect(invoice).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Invoice 2041.pdf" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Anywhere else on the row still opens the email.
  await first.getByRole("button", { name: /Email number 1/ }).click();
  await expect(page.getByRole("heading", { name: "Email number 1" })).toBeVisible();
});

test("the layout you choose in Mail settings is still there after a reload", async ({ alice: page }) => {
  const auth = await setLayout(page, "split");
  await fakeMailbox(page);
  await page.goto("/mail");
  await expect(list(page)).toHaveAttribute("data-mail-layout", "split");

  await page.getByRole("navigation", { name: "Mail folders" }).getByRole("button", { name: "All mailboxes" }).click();
  await page.getByRole("menuitem", { name: "Mail settings" }).click();
  const choice = page.getByRole("radiogroup", { name: "Layout" });
  await expect(choice.getByRole("radio", { name: /^Split/ })).toBeChecked();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/mail/settings/layout") && r.request().method() === "PUT");
  await choice.getByRole("radio", { name: /^Full list/ }).click();
  expect((await saved).ok()).toBe(true);
  await expect(choice.getByRole("radio", { name: /^Full list/ })).toBeChecked();
  // The list behind the sheet has already changed.
  await expect(list(page)).toHaveAttribute("data-mail-layout", "full");

  await page.reload();
  await expect(list(page)).toHaveAttribute("data-mail-layout", "full");
  expect((await (await page.request.get("/api/mail/settings", { headers: { Authorization: auth } })).json()).layout).toBe("full");
  // One line each, the list as wide as the space beside the folders, and up to three names.
  const first = page.locator('[data-mail-row$="/k1"]');
  await expect(first.getByRole("group", { name: "Attachments" }).getByRole("button")).toHaveCount(3);
  await expect(first.getByText("+3")).toBeVisible();
  const box = await list(page).boundingBox();
  expect(box!.width).toBeGreaterThan(1000);
  const plain = await page.locator('[data-mail-row$="/k2"]').boundingBox();
  expect(plain!.height).toBeLessThan(56);
  expect(await list(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // A phone is list, then email, whatever was chosen.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(list(page)).toHaveAttribute("data-mail-layout", "split");
  await page.setViewportSize({ width: 1366, height: 860 });
  await expect(list(page)).toHaveAttribute("data-mail-layout", "full");
});

test("in the full list an email opens over the list, and closing it leaves the list where it was", async ({ alice: page }) => {
  await setLayout(page, "full");
  await fakeMailbox(page);
  await page.goto("/mail");
  await expect(list(page)).toHaveAttribute("data-mail-layout", "full");
  await expect(page.locator('[data-mail-row$="/k60"]')).toBeAttached();

  await scroller(page).evaluate((el) => { el.scrollTop = 900; });
  const at = await scroller(page).evaluate((el) => el.scrollTop);
  expect(at).toBe(900);
  const where = () => scroller(page).evaluate((el) => el.scrollTop);
  const row = page.locator('[data-mail-row$="/k28"]').getByRole("button", { name: /Email number 28/ });
  await expect(row).toBeInViewport();

  // The Back button in the panel.
  await row.click();
  await expect(panel(page).getByRole("heading", { name: "Email number 28" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/mail\\?open=${ACCOUNT}/k28$`));
  // Wide: nearly all of the space the list has.
  const [wide, room] = [await panel(page).boundingBox(), await list(page).boundingBox()];
  expect(wide!.width).toBeGreaterThan(room!.width * 0.9);
  for (const name of ["Reply", "Forward", "Archive", "Move to Trash", "Snooze", "Label"]) await expect(panel(page).getByRole("button", { name, exact: true }).first()).toBeVisible();
  await panel(page).getByRole("button", { name: "Back to the list" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mail$/);
  expect(await where()).toBe(at);
  // You can see which one you were reading, and the keyboard is back on it.
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toBeFocused();

  // Esc.
  await row.click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  expect(await where()).toBe(at);

  // The browser's own Back.
  await row.click();
  await expect(panel(page)).toBeVisible();
  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mail$/);
  await expect(list(page)).toBeVisible();
  expect(await where()).toBe(at);
  // And forward opens it again.
  await page.goForward();
  await expect(panel(page).getByRole("heading", { name: "Email number 28" })).toBeVisible();

  // On to the next one and back, with the buttons and with j and k. Not new steps for Back.
  await panel(page).getByRole("button", { name: "Next conversation" }).click();
  await expect(panel(page).getByRole("heading", { name: "Email number 29" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`open=${ACCOUNT}/k29$`));
  await page.keyboard.press("k");
  await expect(panel(page).getByRole("heading", { name: "Email number 28" })).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(panel(page).getByRole("heading", { name: "Email number 30" })).toBeVisible();

  // A reload, or a link, opens the same email over the list.
  await page.reload();
  await expect(panel(page).getByRole("heading", { name: "Email number 30" })).toBeVisible();
  await expect(list(page)).toHaveAttribute("data-mail-layout", "full");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mail$/);

  // Archiving from the panel closes it and takes the email off the list.
  await page.locator('[data-mail-row$="/k2"]').getByRole("button", { name: /Email number 2/ }).click();
  await panel(page).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("Archived")).toBeVisible();
  await expect(page.locator('[data-mail-row$="/k2"]').getByRole("button", { name: /Email number 2/ })).toBeHidden();
});
