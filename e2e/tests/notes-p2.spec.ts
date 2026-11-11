import type { Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { card, notesReady, scan } from "../lib/notes";

/** Notes phase 2: shopping lists by aisle (Sort by aisle, Keep sorted by
 *  aisle), the Meal Plan's grocery list sent to the Shopping note with the
 *  other person on it seeing it arrive, the Notes section on a person page,
 *  and Copy to a workspace. */

const shots = (name: string) => `test-results/notes-p2-${name}.png`;

async function newNote(page: Page, auth: string, body: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const r = await page.request.post("/api/notes", { headers: { Authorization: auth }, data: { client_id: id, ...body } });
  expect(r.ok()).toBe(true);
  return id;
}

async function itemsOf(page: Page, auth: string, id: string): Promise<{ text: string; aisle: string | null }[]> {
  const r = await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } });
  expect(r.ok()).toBe(true);
  const items = (await r.json()).note.items as { text: string; aisle: string | null; position: number }[];
  return items.sort((a, b) => a.position - b.position);
}

/** What the open list's item boxes hold, top to bottom. */
const values = (scope: import("@playwright/test").Locator) => scope.locator("textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));

const list = (items: string[]) => ({ kind: "list", items: items.map((text) => ({ id: crypto.randomUUID(), text })) });

test.describe("notes phase 2", () => {
  test("keep a list sorted by aisle: new items land in their aisle", async ({ alice: page }) => {
    test.setTimeout(120_000);
    const auth = await notesReady(page);
    const title = `Aisles ${stamp}`; // not "Shop": notes.spec makes a list of that name in the same run
    const id = await newNote(page, auth, { title, ...list(["Frozen peas", "Bread", "Apples"]) });
    await page.goto("/notes");
    await card(page, title).getByRole("button", { name: `Open ${title}` }).click();
    const dlg = page.getByRole("dialog", { name: title });
    await dlg.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Keep sorted by aisle" }).click();
    // Sorted at once, with thin aisle lines.
    await expect(dlg.getByText("Produce", { exact: true })).toBeVisible();
    await expect(dlg.getByText("Bakery", { exact: true })).toBeVisible();
    await expect(dlg.getByText("Frozen", { exact: true })).toBeVisible();
    await expect.poll(async () => (await itemsOf(page, auth, id)).map((i) => i.text).join(",")).toBe("Apples,Bread,Frozen peas");

    // Typed and Enter: it goes under Dairy, not at the bottom.
    const add = dlg.getByRole("textbox", { name: "New list item" });
    await add.fill("Milk");
    await add.press("Enter");
    await expect(add).toHaveValue("");
    await expect(dlg.getByText("Dairy & eggs", { exact: true })).toBeVisible();
    await expect.poll(async () => (await itemsOf(page, auth, id)).map((i) => i.text).join(",")).toBe("Apples,Bread,Milk,Frozen peas");
    // Added from somewhere else (the API stands in for chat and the widget): its aisle too.
    const r = await page.request.post(`/api/notes/${id}/items`, { headers: { Authorization: auth }, data: { id: crypto.randomUUID(), text: "Bananas" } });
    expect(r.ok()).toBe(true);
    await expect.poll(async () => (await itemsOf(page, auth, id)).map((i) => i.text).join(",")).toBe("Apples,Bananas,Bread,Milk,Frozen peas");
    // …and the open note shows it there too, live.
    await expect.poll(async () => (await values(dlg)).filter((v) => v !== title).slice(0, 2).join(","), { timeout: 10_000 }).toBe("Apples,Bananas");
    await page.screenshot({ path: shots("aisles") });
    expect(await scan(page, "list kept by aisle", "[role=dialog]")).toEqual([]);

    // The tick shows in the menu; Sort by aisle is for lists not kept sorted.
    await dlg.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Keep sorted by aisle" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitem", { name: "Sort by aisle" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await dlg.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("the Meal Plan's grocery list goes to the shared Shopping note, live", async ({ alice, bob }) => {
    test.setTimeout(150_000);
    const auth = await notesReady(alice);
    const bobAuth = await notesReady(bob);
    // A Shopping note Alice shares with Bob.
    const shopTitle = "Shopping";
    const existing = (await (await alice.request.get("/api/notes?limit=200", { headers: { Authorization: auth } })).json()).notes as { id: string; title: string }[];
    for (const n of existing.filter((x) => /^(shopping|groceries)$/i.test(x.title))) {
      await alice.request.delete(`/api/notes/${n.id}/forever`, { headers: { Authorization: auth } });
    }
    const shop = await newNote(alice, auth, { title: shopTitle, ...list([`Coffee ${stamp}`]) });
    const shared = await alice.request.post(`/api/notes/${shop}/members`, { headers: { Authorization: auth }, data: { user_ids: [run.users.bob.id] } });
    expect(shared.ok()).toBe(true);

    // A meal plan with a grocery list.
    await alice.request.post("/api/items/store/mealplan", { headers: { Authorization: auth } });
    const plan = ((await (await alice.request.post("/api/items/open/mealplan", { headers: { Authorization: auth } })).json()) as { file_id: string }).file_id;
    const added = await alice.request.post(`/api/items/${plan}/actions/add_grocery_items`, { headers: { Authorization: auth }, data: { args: { lines: ["2 l milk", "3 limes"] } } });
    expect(added.ok()).toBe(true);
    // Past the Meal Plan's first-run questions.
    const item = await (await alice.request.get(`/api/items/${plan}`, { headers: { Authorization: auth } })).json();
    const data = { ...item.data, preferences: { ...item.data.preferences, onboarded: true } };
    expect((await alice.request.put(`/api/items/${plan}`, { headers: { Authorization: auth }, data: { data, base_revision: item.revision } })).ok()).toBe(true);

    // Bob has the note open.
    await bob.goto(`/notes/n/${shop}`);
    const bd = bob.getByRole("dialog", { name: shopTitle });
    await expect(bd.getByText(`Coffee ${stamp}`)).toBeVisible({ timeout: 20_000 });

    await alice.goto(`/apps/mealplan/${plan}?tab=groceries`);
    await alice.getByRole("button", { name: /Send to list/ }).click();
    await expect(alice.getByText("Adds to your Shopping note, by aisle. Everyone on it sees the changes.")).toBeVisible();
    await alice.getByRole("menuitem", { name: "Shopping (note)" }).click();
    await expect(alice.getByText(/to buy in the note “Shopping”/)).toBeVisible({ timeout: 15_000 });
    await alice.screenshot({ path: shots("sent") });

    // Bob sees them arrive without reloading.
    await expect.poll(async () => (await values(bd)).some((v) => /milk/i.test(v)), { timeout: 15_000 }).toBe(true);
    const texts = (await itemsOf(bob, bobAuth, shop)).map((i) => i.text.toLowerCase());
    expect(texts.some((t) => t.startsWith("milk"))).toBe(true);
    expect(texts.some((t) => t.startsWith("lime"))).toBe(true);
    expect(texts).toContain(`coffee ${stamp}`.toLowerCase());

    // Sending again adds nothing twice.
    await alice.getByRole("button", { name: /Send to list/ }).click();
    await alice.getByRole("menuitem", { name: "Shopping (note)" }).click();
    await expect(alice.getByText(/nothing new/)).toBeVisible({ timeout: 15_000 });
    expect((await itemsOf(bob, bobAuth, shop)).length).toBe(texts.length);
  });

  test("a person page shows the notes you both have; See all opens them in Notes", async ({ alice, bob }) => {
    test.setTimeout(120_000);
    const auth = await notesReady(alice);
    const title = `Ours ${stamp}`;
    const id = await newNote(alice, auth, { title, color: "mint", ...list(["Paint", "Brushes"]) });
    const r = await alice.request.post(`/api/notes/${id}/members`, { headers: { Authorization: auth }, data: { user_ids: [run.users.bob.id] } });
    expect(r.ok()).toBe(true);
    const mine = `Only mine ${stamp}`;
    await newNote(alice, auth, { title: mine, text: "secret" });

    await alice.goto(`/people/u/${run.users.bob.id}`);
    const section = alice.locator("section").filter({ has: alice.getByRole("heading", { name: "Notes", exact: true }) });
    await expect(section.getByRole("link", { name: new RegExp(title) })).toBeVisible({ timeout: 20_000 });
    await expect(section.getByRole("link", { name: new RegExp(title) })).toContainText("2 left · Yours");
    await expect(alice.getByText(mine)).toHaveCount(0);
    await alice.screenshot({ path: shots("person-page") });

    await section.getByRole("link", { name: "See all" }).click();
    await expect(alice).toHaveURL(new RegExp(`/notes\\?with=${run.users.bob.id}`));
    await expect(card(alice, title)).toBeVisible({ timeout: 15_000 });
    await expect(card(alice, mine)).toHaveCount(0);
    await expect(alice.getByRole("button", { name: new RegExp(`With ${run.users.bob.username}`) })).toBeVisible();
    void bob;
  });

  test("copy a note to a workspace as a page", async ({ alice: page }) => {
    test.setTimeout(120_000);
    const auth = await notesReady(page);
    const ws = await page.request.post("/api/workspaces", { headers: { Authorization: auth }, data: { title: `Reno ${stamp}` } });
    expect(ws.ok()).toBe(true);
    const title = `Paint ${stamp}`;
    const id = await newNote(page, auth, { title, text: "Dulux White on the walls" });
    await page.goto("/notes");
    await card(page, title).getByRole("button", { name: `Open ${title}` }).click();
    const dlg = page.getByRole("dialog", { name: title });
    await dlg.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Copy to a workspace…" }).click();
    const sheet = page.getByRole("dialog", { name: "Copy to a workspace" });
    await sheet.getByRole("combobox", { name: "Workspace" }).selectOption({ label: `Reno ${stamp}` });
    await expect(sheet.getByText(`People in Reno ${stamp} will see this copy. Your note stays as it is.`)).toBeVisible();
    expect(await scan(page, "copy to a workspace", "[role=dialog][aria-labelledby]")).toEqual([]);
    await sheet.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByText(`Copied to Reno ${stamp}`)).toBeVisible({ timeout: 15_000 });
    // The note is as it was, and still only Alice's.
    const n = (await (await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } })).json()).note;
    expect(n.member_ids).toEqual([]);
    expect(n.revision).toBe(1);
  });
});
