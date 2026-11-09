import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { notesReady, scan } from "../lib/notes";

/** Promptly Notes (N1.5): across Promptly — the Today card, Ctrl+K, a [[
 *  mention, adding to the shopping list from a chat (the fake model calls
 *  the tool for a [tool:…] marker), AI Tidy up with Undo, Make an event,
 *  Turn into tasks (+ Undo), Make a copy (+ Undo). */

const shots = (name: string) => `test-results/notes-across-${name}.png`;

async function newNote(page: Page, auth: string, body: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const r = await page.request.post("/api/notes", { headers: { Authorization: auth }, data: { client_id: id, ...body } });
  expect(r.ok()).toBe(true);
  return id;
}

async function serverNote(page: Page, auth: string, id: string) {
  const r = await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } });
  return r.ok() ? (await r.json()).note : null;
}

async function openNote(page: Page, id: string, title: string) {
  await page.goto(`/notes/n/${id}`);
  const dlg = page.getByRole("dialog", { name: title });
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  return dlg;
}

async function more(page: Page, dlg: ReturnType<Page["getByRole"]>, item: string | RegExp) {
  await dlg.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("notes: across Promptly", () => {
  test("Today shows pinned notes, Ctrl+K finds one, and a [[ mention links it", async ({ alice: page }) => {
    test.setTimeout(150_000);
    const auth = await notesReady(page);
    const gate = `Gate code ${stamp}`;
    const picnic = `Picnic ${stamp}`;
    const gateId = await newNote(page, auth, { title: gate, text: `4471${stamp} then the side door`, pinned: true });
    const picnicId = await newNote(page, auth, {
      kind: "list", title: picnic, pinned: true,
      items: [{ id: crypto.randomUUID(), text: "Rug", checked: true }, { id: crypto.randomUUID(), text: "Plates" }, { id: crypto.randomUUID(), text: "Cups" }],
    });

    // Today: the Notes card, a list with how much is left.
    await page.goto("/today");
    await ready(page);
    const today = page.locator("section").filter({ has: page.getByRole("heading", { name: "Notes", exact: true }) });
    await expect(today).toBeVisible({ timeout: 20_000 });
    await expect(today.getByRole("link", { name: new RegExp(picnic) })).toContainText("2 left");
    await expect(today.getByRole("link", { name: new RegExp(gate) })).toContainText("then the side door");
    await page.screenshot({ path: shots("today") });
    await today.getByRole("link", { name: new RegExp(gate) }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/n/${gateId}`));
    await expect(page.getByRole("dialog", { name: gate })).toBeVisible();

    // Ctrl+K finds it by a word inside it.
    await page.goto("/today");
    await ready(page);
    await page.keyboard.press("Control+k");
    const box = page.getByPlaceholder("Search chats, notes, events, people, tasks…");
    await expect(box).toBeVisible();
    await box.fill(`4471${stamp}`);
    const hit = page.getByRole("button", { name: new RegExp(gate) });
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shots("ctrl-k") });
    await hit.click();
    await expect(page).toHaveURL(new RegExp(`/notes/n/${gateId}`));

    // [[ in another note links to it; clicking the link opens it.
    const plan = `Saturday ${stamp}`;
    const planId = await newNote(page, auth, { title: plan, text: "Remember" });
    const dlg = await openNote(page, planId, plan);
    const body = dlg.getByRole("textbox", { name: "Note text" });
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(` [[4471${stamp}`);
    const pick = page.locator(".wiki-link-popup").getByRole("button", { name: new RegExp(gate) });
    await expect(pick).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shots("mention-picker") });
    await page.keyboard.press("Enter");
    await expect(body.getByRole("link", { name: gate })).toBeVisible();
    await dlg.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(async () => JSON.stringify((await serverNote(page, auth, planId))?.body_doc ?? {})).toContain(`/link/note/${gateId}`);
    // The gate note is "mentioned in" the plan.
    await expect
      .poll(async () => {
        const r = await page.request.get(`/api/connections?kind=note&id=${gateId}`, { headers: { Authorization: auth } });
        return ((await r.json()).mentioned_in as { id: string }[]).map((m) => m.id);
      })
      .toContain(planId);
    const again = await openNote(page, planId, plan);
    await again.getByRole("link", { name: gate }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/n/${gateId}`), { timeout: 15_000 });
    void picnicId;
  });

  test("a chat adds to the shopping list note", async ({ alice: page }) => {
    test.setTimeout(150_000);
    const auth = await notesReady(page);
    const listId = await newNote(page, auth, { kind: "list", title: "Shopping", items: [{ id: crypto.randomUUID(), text: `Bread ${stamp}` }] });
    await page.goto("/chat");
    await ready(page);
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
    const items = [`Oat milk ${stamp}`, `Eggs ${stamp}`];
    await page.getByPlaceholder(/^Message Promptly/).fill(`[tool:add_to_note ${JSON.stringify({ note: "shopping list", items })}] add oat milk and eggs to my shopping list`);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/Tool said: Added 2 items to the note “Shopping”/)).toBeVisible({ timeout: 45_000 });
    await page.screenshot({ path: shots("chat") });
    const n = await serverNote(page, auth, listId);
    expect((n.items as { text: string }[]).map((i) => i.text)).toEqual([`Bread ${stamp}`, ...items]);
    // And it's there in Notes.
    const dlg = await openNote(page, listId, "Shopping");
    await expect(dlg.getByRole("checkbox", { name: `Tick Eggs ${stamp}` })).toBeVisible();
    await expect(dlg.getByRole("checkbox", { name: `Tick Oat milk ${stamp}` })).toBeVisible();
  });

  test("AI tidy with Undo, Make an event, Turn into tasks, Make a copy", async ({ alice: page }) => {
    test.setTimeout(240_000);
    const auth = await notesReady(page);

    // Tidy up: a preview first; nothing changes until Use this; Undo puts it back.
    const title = `Plumber ${stamp}`;
    const words = "um so the plumber comes tuesday at ten";
    const id = await newNote(page, auth, { title, text: words });
    let dlg = await openNote(page, id, title);
    await more(page, dlg, "Tidy up");
    const sheet = page.getByRole("dialog", { name: "Tidy up" });
    await expect(sheet.getByLabel("Tidied note")).toContainText("The plumber comes tuesday at ten.", { timeout: 30_000 });
    expect((await serverNote(page, auth, id)).body_text).toBe(words);
    await page.screenshot({ path: shots("tidy-preview") });
    expect(await scan(page, "tidy preview", "[role=dialog][aria-labelledby]")).toEqual([]);
    await sheet.getByRole("button", { name: "Use this" }).click();
    await expect(dlg.getByRole("textbox", { name: "Note text" })).toContainText("The plumber comes tuesday at ten.");
    await expect.poll(async () => (await serverNote(page, auth, id)).body_text).toBe("The plumber comes tuesday at ten.");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await serverNote(page, auth, id)).body_text, { timeout: 20_000 }).toBe(words);
    await expect(dlg.getByRole("textbox", { name: "Note text" })).toContainText(words);

    // Make an event: the day and time are read, Calendar's new event opens filled in.
    await more(page, dlg, "Make an event");
    await expect(page).toHaveURL(/\/calendar/, { timeout: 30_000 });
    const ev = page.getByRole("dialog", { name: "New event" });
    await expect(ev).toBeVisible({ timeout: 20_000 });
    await expect(ev.getByLabel("Title")).toHaveValue("E2E event");
    await expect(ev.getByPlaceholder("Add a place")).toHaveValue("The workshop");
    await expect(ev.getByLabel("Start time")).toHaveValue("10:00");
    await expect(ev.getByPlaceholder("Add notes")).toHaveValue(words);
    await page.screenshot({ path: shots("event") });
    await page.keyboard.press("Escape");

    // Turn into tasks: a list's unticked items, to a list you pick; Undo takes them back.
    const hw = `Hardware ${stamp}`;
    const hwId = await newNote(page, auth, {
      kind: "list", title: hw,
      items: [`Pipe tape ${stamp}`, `Washers ${stamp}`, `Old bulb ${stamp}`].map((text, i) => ({ id: crypto.randomUUID(), text, checked: i === 2 })),
    });
    dlg = await openNote(page, hwId, hw);
    await more(page, dlg, "Turn into tasks");
    const ts = page.getByRole("dialog", { name: "Turn into tasks" });
    const rows = ts.getByRole("list", { name: "Tasks to add" }).getByRole("checkbox");
    await expect(rows).toHaveCount(2);
    await ts.getByRole("combobox").selectOption("Home");
    await page.screenshot({ path: shots("tasks") });
    await ts.getByRole("button", { name: "Add 2 tasks" }).click();
    await expect(page.getByText("Added 2 tasks to Home in Tasks")).toBeVisible();
    const found = async () => {
      const r = await page.request.get(`/api/today/search?q=${encodeURIComponent(stamp)}&limit=20`, { headers: { Authorization: auth } });
      return ((await r.json()).tasks as { title: string; list: string; done: boolean }[]).filter((t) => !t.done).map((t) => `${t.title}|${t.list}`).sort();
    };
    await expect.poll(found).toEqual([`Pipe tape ${stamp}|Home`, `Washers ${stamp}|Home`]);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(found).toEqual([]);

    // Make a copy: yours, opened; Undo deletes it.
    await more(page, dlg, "Make a copy");
    await expect(page).not.toHaveURL(new RegExp(`/notes/n/${hwId}`), { timeout: 20_000 });
    const copyId = /\/notes\/n\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
    expect(copyId).toBeTruthy();
    await expect(page.getByRole("dialog", { name: hw })).toBeVisible();
    const copy = await serverNote(page, auth, copyId);
    expect((copy.items as { text: string; checked: boolean }[]).map((i) => [i.text, i.checked])).toEqual([
      [`Pipe tape ${stamp}`, false], [`Washers ${stamp}`, false], [`Old bulb ${stamp}`, true],
    ]);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => await serverNote(page, auth, copyId)).toBeNull();
    expect((await serverNote(page, auth, hwId)).title).toBe(hw);
  });
});
