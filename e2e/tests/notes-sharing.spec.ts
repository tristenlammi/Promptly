import type { Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { card, notesReady, scan } from "../lib/notes";

/** Promptly Notes (N1.4): sharing with people on this server (both tick
 *  live, both edit the body at once and see the merge, leave, removed
 *  while open → Keep a copy) and reminders as tasks in Tasks (shown in
 *  Tasks, Done clears the chip), on a phone too, with axe scans. */

const shots = (name: string) => `test-results/notes-sharing-${name}.png`;

async function newNote(page: Page, auth: string, body: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const r = await page.request.post("/api/notes", { headers: { Authorization: auth }, data: { client_id: id, ...body } });
  expect(r.ok()).toBe(true);
  return id;
}

async function serverNote(page: Page, auth: string, id: string) {
  const r = await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } });
  expect(r.ok()).toBe(true);
  return (await r.json()).note;
}

/** The share dialog: pick someone with the people picker, Share. */
async function shareInDialog(page: Page, username: string) {
  const dlg = page.getByRole("dialog", { name: "Share" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("combobox", { name: "Search people" }).fill(username);
  await dlg.getByRole("option", { name: new RegExp(username) }).click();
  await expect(dlg.getByRole("button", { name: `Remove ${username}` }).first()).toBeVisible();
  return dlg;
}

const bodyOf = (page: Page) => page.getByRole("textbox", { name: "Note text" });

test.describe("notes: sharing and reminders", () => {
  test("share a list: both tick live; both edit the body at once and see the merge; leave", async ({ alice, bob }) => {
    test.setTimeout(180_000);
    const bobName = run.users.bob.username;
    const aliceName = run.users.alice.username;
    const auth = await notesReady(alice);
    const bobAuth = await notesReady(bob);

    // A list, shared from the note's Share button.
    const list = `Shopping ${stamp}`;
    const items = ["Oat milk", "Eggs", "Bread"].map((text) => ({ id: crypto.randomUUID(), text }));
    const id = await newNote(alice, auth, { kind: "list", title: list, items });
    await alice.goto("/notes");
    await card(alice, list).getByRole("button", { name: `Open ${list}` }).click();
    const ad = alice.getByRole("dialog", { name: list });
    await ad.getByRole("button", { name: "Share", exact: true }).click();
    const dlg = await shareInDialog(alice, bobName);
    await expect(dlg.getByText("Only the people you add can see this note.")).toBeVisible();
    await alice.screenshot({ path: shots("share-dialog") });
    expect(await scan(alice, "share dialog", "[role=dialog][aria-labelledby]")).toEqual([]);
    await dlg.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(alice.getByText(`Shared with ${bobName}`).first()).toBeVisible();
    await expect(ad.getByRole("button", { name: new RegExp(`^Shared with ${bobName}`) })).toBeVisible();

    // It turns up on Bob's grid without a reload, as shared by Alice.
    await expect(card(bob, list)).toBeVisible({ timeout: 15_000 });
    await card(bob, list).getByRole("button", { name: `Open ${list}` }).click();
    const bd = bob.getByRole("dialog", { name: list });
    await expect(bd.getByRole("button", { name: new RegExp(`Shared with you by ${aliceName}`) })).toBeVisible();

    // Both tick; each sees the other's within seconds.
    await ad.getByRole("checkbox", { name: "Tick Eggs" }).check();
    await expect(bd.getByRole("button", { name: "1 ticked item" })).toBeVisible({ timeout: 8_000 });
    await bd.getByRole("checkbox", { name: "Tick Bread" }).check();
    await expect(ad.getByRole("button", { name: "2 ticked items" })).toBeVisible({ timeout: 8_000 });
    await alice.screenshot({ path: shots("shared-list") });
    await ad.getByRole("button", { name: "Close", exact: true }).click();
    await bd.getByRole("button", { name: "Close", exact: true }).click();

    // A text note: both type in different paragraphs at once — each sees both.
    const plan = `Trip plan ${stamp}`;
    const pid = await newNote(alice, auth, {
      kind: "text",
      title: plan,
      body_doc: {
        type: "doc",
        content: [
          { type: "paragraph", attrs: { id: "p1aaaaaaaa" }, content: [{ type: "text", text: "Pack the tent" }] },
          { type: "paragraph", attrs: { id: "p2bbbbbbbb" }, content: [{ type: "text", text: "Book the ferry" }] },
        ],
      },
    });
    expect((await alice.request.post(`/api/notes/${pid}/members`, { headers: { Authorization: auth }, data: { user_ids: [run.users.bob.id] } })).ok()).toBe(true);
    await alice.goto(`/notes/n/${pid}`);
    await bob.goto(`/notes/n/${pid}`);
    const ap = alice.getByRole("dialog", { name: plan });
    const bp = bob.getByRole("dialog", { name: plan });
    await expect(bodyOf(ap)).toContainText("Book the ferry");
    await expect(bodyOf(bp)).toContainText("Book the ferry");
    await Promise.all([
      (async () => {
        await bodyOf(ap).getByText("Pack the tent").click();
        await alice.keyboard.press("End");
        await alice.keyboard.type(" and the stove", { delay: 30 });
      })(),
      (async () => {
        await bodyOf(bp).getByText("Book the ferry").click();
        await bob.keyboard.press("End");
        await bob.keyboard.type(" for Friday", { delay: 30 });
      })(),
    ]);
    for (const box of [ap, bp]) {
      await expect(bodyOf(box)).toContainText("Pack the tent and the stove", { timeout: 15_000 });
      await expect(bodyOf(box)).toContainText("Book the ferry for Friday", { timeout: 15_000 });
    }
    await expect.poll(async () => (await serverNote(alice, auth, pid)).body_text, { timeout: 10_000 }).toBe("Pack the tent and the stove\nBook the ferry for Friday");
    await alice.screenshot({ path: shots("merged-body") });

    // The same paragraph changed on both sides (Bob offline): both versions are kept, with a line saying so.
    await bob.context().setOffline(true);
    await bodyOf(bp).getByText("Book the ferry for Friday").click();
    await bob.keyboard.press("End");
    await bob.keyboard.type(" morning");
    await bodyOf(ap).getByText("Book the ferry for Friday").click();
    await alice.keyboard.press("End");
    await alice.keyboard.type(" at 9");
    await expect.poll(async () => (await serverNote(alice, auth, pid)).body_text, { timeout: 10_000 }).toContain("for Friday at 9");
    await bob.context().setOffline(false);
    for (const box of [ap, bp]) {
      await expect(bodyOf(box)).toContainText("changed this while you were editing", { timeout: 20_000 });
      await expect(bodyOf(box)).toContainText("Book the ferry for Friday at 9");
      await expect(bodyOf(box)).toContainText("Book the ferry for Friday morning");
    }

    // Bob leaves the list: it goes from his notes; Alice's note no longer lists him.
    await bob.goto(`/notes/n/${id}`);
    const bl = bob.getByRole("dialog", { name: list });
    await bl.getByRole("button", { name: "People on this note" }).click();
    const people = bob.getByRole("dialog", { name: "People on this note" });
    await expect(people.getByText(aliceName).first()).toBeVisible();
    await people.getByRole("button", { name: "Leave", exact: true }).click();
    await people.getByRole("button", { name: "Leave note" }).click();
    await expect(people).toHaveCount(0);
    await expect(bob).toHaveURL(/\/notes\/?$/);
    await expect(card(bob, list)).toHaveCount(0);
    expect((await bob.request.get(`/api/notes/${id}`, { headers: { Authorization: bobAuth } })).status()).toBe(404);
    await alice.goto("/notes");
    await expect.poll(async () => (await serverNote(alice, auth, id)).members.length).toBe(0);

    // Removed while it's open: "isn't shared with you any more" — Keep a copy.
    await bob.goto(`/notes/n/${pid}`);
    await expect(bodyOf(bp)).toContainText("Pack the tent");
    expect((await alice.request.delete(`/api/notes/${pid}/members/${run.users.bob.id}`, { headers: { Authorization: auth } })).ok()).toBe(true);
    await expect(bob.getByText("This note isn't shared with you any more")).toBeVisible({ timeout: 15_000 });
    await bob.getByRole("button", { name: "Keep a copy" }).click();
    const copy = bob.getByRole("dialog", { name: plan });
    await expect(copy).toBeVisible();
    await expect(bodyOf(copy)).toContainText("Pack the tent and the stove");
    await expect.poll(async () => {
      const r = await bob.request.get("/api/notes?limit=200", { headers: { Authorization: bobAuth } });
      return ((await r.json()).notes as { title: string; is_owner: boolean }[]).some((n) => n.title === plan && n.is_owner);
    }).toBe(true);
  });

  test("a reminder is a task in Tasks; ticking it off clears the chip", async ({ alice }) => {
    test.setTimeout(120_000);
    const auth = await notesReady(alice);
    const title = `Call the plumber ${stamp}`;
    const id = await newNote(alice, auth, { kind: "text", title, text: "About the leak under the sink" });
    await alice.goto(`/notes/n/${id}`);
    const nd = alice.getByRole("dialog", { name: title });
    await nd.getByRole("button", { name: "Remind me" }).click();
    const picker = alice.getByRole("dialog", { name: "Remind me" });
    expect(await scan(alice, "reminder picker", "[role=dialog][aria-label='Remind me']")).toEqual([]);
    await picker.getByRole("button", { name: /^Tomorrow/ }).click();
    const chip = nd.locator("[data-note-reminder]");
    await expect(chip).toContainText("Tomorrow");
    await expect.poll(async () => (await serverNote(alice, auth, id)).reminder?.due ?? null).not.toBeNull();
    const rem = (await serverNote(alice, auth, id)).reminder;
    expect(rem.time).toBe("08:00");

    // Custom day, time and a weekly repeat moves the same task.
    await chip.getByRole("button", { name: /^Reminder: Tomorrow/ }).click();
    await picker.getByRole("button", { name: "Pick a day and time" }).click();
    await picker.getByLabel("Time").fill("17:30");
    await picker.getByLabel("Repeat").selectOption("weekly");
    await picker.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await serverNote(alice, auth, id)).reminder?.time).toBe("17:30");
    const moved = (await serverNote(alice, auth, id)).reminder;
    expect(moved.task_id).toBe(rem.task_id);
    expect(moved.repeat).toBe("weekly");
    await nd.getByRole("button", { name: "Close", exact: true }).click();

    // On the card, and in the Reminders view.
    await expect(card(alice, title).locator("[data-note-reminder]")).toContainText("Tomorrow");
    await alice.getByRole("link", { name: "Reminders" }).click();
    await expect(alice.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    await expect(card(alice, title)).toBeVisible();
    await alice.screenshot({ path: shots("reminders-view") });
    expect(await scan(alice, "reminders view", "main")).toEqual([]);

    // It's a task in Tasks, linked to the note.
    const tasks = await alice.context().newPage();
    await tasks.goto(moved.href);
    await expect(tasks.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
    const done = tasks.getByRole("checkbox", { name: `Complete “${title}”` }).first();
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(tasks.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

    // Ticking it off there clears the chip in the open Notes, live.
    // A weekly repeat moves on rather than clearing: stop it repeating first.
    expect(
      (await alice.request.put(`/api/notes/${id}/reminder`, { headers: { Authorization: auth }, data: { due: moved.due, time: "17:30", repeat: null } })).ok(),
    ).toBe(true);
    await tasks.reload();
    await tasks.getByRole("checkbox", { name: `Complete “${title}”` }).first().click();
    await expect.poll(async () => (await serverNote(alice, auth, id)).reminder, { timeout: 15_000 }).toBeNull();
    await expect(card(alice, title)).toHaveCount(0, { timeout: 15_000 });
    await alice.goto("/notes");
    await expect(card(alice, title).locator("[data-note-reminder]")).toHaveCount(0);
    await tasks.close();
  });
});

test.describe("notes sharing on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a shared note, its people and a reminder at phone width", async ({ alice, bob }) => {
    test.setTimeout(120_000);
    const auth = await notesReady(alice);
    await notesReady(bob);
    const title = `Groceries ${stamp}`;
    const id = await newNote(alice, auth, { kind: "list", title, items: [{ id: crypto.randomUUID(), text: "Apples" }] });
    expect((await alice.request.post(`/api/notes/${id}/members`, { headers: { Authorization: auth }, data: { user_ids: [run.users.bob.id] } })).ok()).toBe(true);

    await bob.goto("/notes");
    await expect(card(bob, title)).toBeVisible({ timeout: 15_000 });
    await card(bob, title).getByRole("button", { name: `Open ${title}` }).tap();
    await expect(bob.getByRole("button", { name: "Back to notes" })).toBeVisible();
    await bob.getByRole("button", { name: "Remind me" }).tap();
    await bob.getByRole("dialog", { name: "Remind me" }).getByRole("button", { name: /^Tomorrow/ }).tap();
    await expect(bob.locator("[data-note-reminder]").first()).toContainText("Tomorrow");
    await bob.getByRole("button", { name: "People on this note" }).tap();
    const people = bob.getByRole("dialog", { name: "People on this note" });
    await expect(people.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
    const width = await bob.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await bob.screenshot({ path: shots("phone-people") });
    expect(await scan(bob, "phone people", "[role=dialog][aria-labelledby]")).toEqual([]);
    await people.getByRole("button", { name: "Done" }).tap();
    expect(await scan(bob, "phone shared note", "body")).toEqual([]);

    // Only Bob gets his reminder: Alice's note has none.
    expect((await serverNote(alice, auth, id)).reminder).toBeNull();
  });
});
