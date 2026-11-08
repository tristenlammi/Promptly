import { expect, stamp, test } from "../fixtures";
import { card, notesReady, scan, serverNotes } from "../lib/notes";

/** Promptly Notes (N1.2): the web app — write, list, colour, label, pin,
 *  archive, trash, search, and an accessibility scan in light and dark. */

test.describe("notes", () => {
  test("write a note and a list, tick items, and it's all saved", async ({ alice: page }) => {
    const auth = await notesReady(page);
    const title = `Gate code ${stamp}`;

    // Take a note…: no Save button — clicking away keeps it.
    await page.getByRole("button", { name: "Take a note…" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(title);
    await page.getByRole("textbox", { name: "Note text" }).click();
    await page.keyboard.type("4471, then the side door");
    await page.getByRole("heading", { name: "Notes", exact: true }).click();
    await expect(card(page, title)).toBeVisible();
    await expect(card(page, title)).toContainText("4471, then the side door");
    await expect.poll(async () => (await serverNotes(page, auth)).find((n) => n.title === title)?.snippet).toBe("4471, then the side door");

    // An empty note is just dropped.
    const before = (await serverNotes(page, auth)).length;
    await page.getByRole("button", { name: "Take a note…" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Take a note…" })).toBeVisible();
    expect((await serverNotes(page, auth)).length).toBe(before);

    // Open it, change the text, close.
    await card(page, title).getByRole("button", { name: `Open ${title}` }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Note text" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" (code changes in May)");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await serverNotes(page, auth)).find((n) => n.title === title)?.snippet).toContain("code changes in May");

    // A list: Enter adds the next item.
    const list = `Shop ${stamp}`;
    await page.getByRole("button", { name: "New list" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(list);
    await page.getByRole("textbox", { name: "New list item" }).click();
    await page.keyboard.type("Oat milk");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Eggs");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Bread");
    await page.getByRole("checkbox", { name: "Tick Eggs" }).check();
    await expect(page.getByRole("button", { name: "1 ticked item" })).toBeVisible();
    await page.getByRole("heading", { name: "Notes", exact: true }).click();
    const c = card(page, list);
    await expect(c).toContainText("Oat milk");
    await expect(c).toContainText("+ 1 ticked item");
    await expect
      .poll(async () => {
        const n = (await serverNotes(page, auth)).find((x) => x.title === list);
        return n ? `${n.kind}:${n.items_checked}:${n.items.map((i) => i.text).join(",")}` : null;
      })
      .toBe("list:1:Oat milk,Bread");

    // Tick from the open note, then untick all.
    await c.getByRole("button", { name: `Open ${list}` }).click();
    const ld = page.getByRole("dialog", { name: list });
    await ld.getByRole("checkbox", { name: "Tick Bread" }).check();
    await expect(ld.getByRole("button", { name: "2 ticked items" })).toBeVisible();
    await ld.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Untick all" }).click();
    await expect(ld.getByRole("checkbox", { name: "Tick Eggs" })).toBeVisible();
    await ld.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(async () => (await serverNotes(page, auth)).find((x) => x.title === list)?.items_checked).toBe(0);
  });

  test("colour, label, pin, archive, trash and search", async ({ alice: page }) => {
    const auth = await notesReady(page);
    const t = `Bills ${stamp}`;
    const other = `Recipe ${stamp}`;
    const label = `money${stamp}`;
    for (const name of [other, t]) {
      await page.getByRole("button", { name: "Take a note…" }).click();
      await page.getByRole("textbox", { name: "Title" }).fill(name);
      await page.getByRole("textbox", { name: "Note text" }).click();
      await page.keyboard.type(name === t ? "power and water" : "pancakes with lemon");
      await page.getByRole("heading", { name: "Notes", exact: true }).click();
      await expect(card(page, name)).toBeVisible();
    }

    // Colour from the card.
    await card(page, t).hover();
    await card(page, t).getByRole("button", { name: `Colour of ${t}` }).click();
    await page.getByRole("radio", { name: "Sand" }).click();
    await expect(card(page, t)).toHaveAttribute("data-color", "sand");

    // A label (a #tag) from the open note.
    await card(page, t).getByRole("button", { name: `Open ${t}` }).click();
    const d = page.getByRole("dialog", { name: t });
    await d.getByRole("button", { name: "Labels" }).click();
    await page.getByRole("textbox", { name: "Find or make a label" }).fill(label);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(d.getByRole("button", { name: `Remove label ${label}` })).toBeVisible();
    await d.getByRole("button", { name: "Pin" }).click();
    await d.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pinned" }).getByText(t, { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const n = (await serverNotes(page, auth)).find((x) => x.title === t);
      return n ? `${n.color}:${n.pinned}:${n.labels.map((l) => l.name).join(",")}` : null;
    }).toBe(`sand:true:${label}`);

    // The label in the rail lists it.
    await page.getByRole("link", { name: new RegExp(`^${label}`) }).click();
    await expect(card(page, t)).toBeVisible();
    await expect(card(page, other)).toHaveCount(0);
    await page.getByRole("link", { name: "Notes", exact: true }).click();

    // Search, and the Lists chip.
    const search = page.getByRole("searchbox", { name: "Search your notes" });
    await search.fill("pancakes");
    await expect(card(page, other)).toBeVisible();
    await expect(card(page, t)).toHaveCount(0);
    await search.fill(`nothing-like-this-${stamp}`);
    await expect(page.getByText(`Nothing matches “nothing-like-this-${stamp}”`)).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();

    // Archive (with Undo), then find it in Archive.
    await card(page, other).hover();
    await card(page, other).getByRole("button", { name: `Archive ${other}` }).click();
    await expect(card(page, other)).toHaveCount(0);
    await page.getByRole("link", { name: "Archive" }).click();
    await expect(card(page, other)).toBeVisible();
    await expect.poll(async () => (await serverNotes(page, auth, "archive")).some((x) => x.title === other)).toBe(true);

    // Delete → Trash → Restore.
    await card(page, other).hover();
    await card(page, other).getByRole("button", { name: `More for ${other}` }).click();
    await page.getByRole("menuitem", { name: "Delete note" }).click();
    await expect(card(page, other)).toHaveCount(0);
    await page.getByRole("link", { name: "Trash" }).click();
    await expect(page.getByText("Notes in the Trash are deleted after 30 days.")).toBeVisible();
    await expect(card(page, other)).toBeVisible();
    await card(page, other).hover();
    await card(page, other).getByRole("button", { name: `Restore ${other}` }).click();
    await expect(card(page, other)).toHaveCount(0);
    await expect.poll(async () => (await serverNotes(page, auth, "archive")).some((x) => x.title === other)).toBe(true);

    // Select two and colour them together.
    await page.getByRole("link", { name: "Notes", exact: true }).click();
    await card(page, t).hover();
    await card(page, t).getByRole("button", { name: `Select ${t}` }).click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.getByRole("toolbar", { name: "Selected notes" }).getByRole("button", { name: "Unpin" }).click();
    await expect(page.getByRole("region", { name: "Pinned" }).getByText(t, { exact: true })).toHaveCount(0);
    await expect(card(page, t)).toBeVisible();
  });

  test("Notes passes an accessibility scan in light and dark", async ({ alice: page }) => {
    test.setTimeout(120_000);
    const found: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      await page.addInitScript((th) => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: th }, version: 0 })), theme);
      await notesReady(page);
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      if (!(await page.locator("article[data-note-card]").count())) {
        await page.getByRole("button", { name: "Take a note…" }).click();
        await page.getByRole("textbox", { name: "Title" }).fill(`Scan ${stamp}`);
        await page.getByRole("heading", { name: "Notes", exact: true }).click();
      }
      found.push(...(await scan(page, `${theme} home`, "main")));
      const first = page.locator("article[data-note-card]").first();
      await first.locator("button[aria-label^='Open ']").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      found.push(...(await scan(page, `${theme} open note`, "[role=dialog]")));
      await page.keyboard.press("Escape");
      await page.getByRole("searchbox", { name: "Search your notes" }).click();
      found.push(...(await scan(page, `${theme} search`, "main")));
      await page.goto("/notes/trash");
      await expect(page.getByRole("searchbox", { name: "Search your notes" })).toBeVisible();
      found.push(...(await scan(page, `${theme} trash`, "main")));
    }
    expect(found).toEqual([]);
  });
});
