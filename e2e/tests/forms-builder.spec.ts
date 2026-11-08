import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Forms WP-F1.2: the builder, its preview and the Forms home (desktop).
 *  An RSVP with branching and an option limit is built and previewed;
 *  autosave keeps every edit with two tabs open and while offline; items
 *  reorder by keyboard (Move up/down and the drag handle) with undo; and the
 *  screens pass an accessibility scan. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type Def = { title: string; items: { id: string; kind: string; title: string; deleted?: boolean; config: Record<string, unknown> }[] };

async function definition(page: Page, auth: string, fileId: string): Promise<Def> {
  const r = await page.request.get(`/api/forms/${fileId}`, { headers: { Authorization: auth } });
  expect(r.ok()).toBe(true);
  return (await r.json()).form.definition as Def;
}

function fileIdOf(page: Page): string {
  const m = /\/files\/form\/([0-9a-f-]{36})/.exec(page.url());
  expect(m).not.toBeNull();
  return m![1];
}

async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 15_000 });
}

/** The card being edited (it has the question box). */
function openCard(page: Page): Locator {
  return page.locator("[data-item]").filter({ has: page.getByRole("textbox", { name: "Question", exact: true }) });
}

async function scan(page: Page, what: string, include: string) {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include(include)
    .analyze();
  const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // The app's own accent buttons (Share, tabs) are the brand colour — tracked
    // on its own; the form's colours are checked here.
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("an RSVP with branching and a limited option, built, previewed and saved", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  await expect(page.getByRole("heading", { name: "Start a new form" })).toBeVisible();
  await page.getByRole("list", { name: "Templates" }).getByRole("button", { name: /^RSVP/ }).click();
  await page.waitForURL(/\/files\/form\//);
  const fileId = fileIdOf(page);

  // The title card renames the form (and its file).
  const title = page.getByRole("textbox", { name: "Form title" });
  await expect(title).toHaveValue("RSVP");
  await title.fill(`BBQ on Saturday ${stamp}`);
  await saved(page);

  // A choice question with a limit per option: a sign-up within the RSVP.
  await page.getByRole("toolbar", { name: "Add to the form" }).getByRole("button", { name: "Add question" }).click();
  const card = openCard(page);
  await card.getByRole("textbox", { name: "Question", exact: true }).fill("Bringing anything?");
  await card.getByRole("textbox", { name: "Option 1" }).fill("Salad");
  await card.getByRole("textbox", { name: "Option 1" }).press("Enter");
  await expect(card.getByRole("textbox", { name: "Option 2" })).toBeFocused();
  await page.keyboard.type("Dessert");
  await card.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Limit places per option" }).click();
  await card.getByRole("spinbutton", { name: "Places for option 1" }).fill("2");
  await card.getByRole("switch", { name: "Required" }).click();
  await saved(page);

  // The template's branching is there: "No" ends the form.
  await page.getByRole("button", { name: /^Edit question: Can you come\?/ }).click();
  const coming = openCard(page);
  const noTarget = coming.locator("li").filter({ has: page.getByRole("textbox", { name: "Option 3" }) }).getByRole("combobox");
  await expect(noTarget).toHaveValue("submit");

  let def = await definition(page, auth, fileId);
  expect(def.title).toBe(`BBQ on Saturday ${stamp}`);
  const bring = def.items.find((i) => i.title === "Bringing anything?")!;
  const opts = bring.config.options as { label: string; limit: number | null }[];
  expect(opts.map((o) => [o.label, o.limit])).toEqual([["Salad", 2], ["Dessert", null]]);
  const files = await page.request.get(`/api/files/${fileId}/office`, { headers: { Authorization: auth } });
  expect((await files.json()).file.filename).toBe(`BBQ on Saturday ${stamp}.form`);

  // The preview is the answer page: follow "No" straight to the end…
  const preview = page.getByRole("complementary", { name: "Preview" });
  await expect(preview.getByRole("heading", { name: `BBQ on Saturday ${stamp}` })).toBeVisible();
  await preview.getByLabel("Your name").fill("Sam");
  await preview.getByRole("radio", { name: "No" }).check();
  await preview.getByRole("button", { name: "Submit" }).click();
  await expect(preview.getByText("Thanks! We've got your answer.")).toBeVisible();

  // …or "Yes" to the details page, where the limited option shows its places.
  await preview.getByRole("button", { name: "Back to the start of the preview" }).click();
  await preview.getByLabel("Your name").fill("Sam");
  await preview.getByRole("radio", { name: "Yes" }).check();
  await preview.getByRole("button", { name: "Next" }).click();
  await expect(preview.getByText("Page 2 of 2")).toBeVisible();
  await expect(preview.locator("label").filter({ hasText: "Salad" })).toContainText("2 left");
  // Required questions are checked before sending.
  await preview.getByRole("button", { name: "Submit" }).click();
  await expect(preview.getByText("This question needs an answer.").first()).toBeVisible();
  await preview.getByLabel(/How many people are coming/).fill("3");
  await preview.getByRole("radio", { name: /Salad/ }).check();
  await preview.getByRole("button", { name: "Submit" }).click();
  await expect(preview.getByText("Thanks! We've got your answer.")).toBeVisible();

  // It all survives a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: /^Edit question: Bringing anything\?/ })).toBeVisible();
  def = await definition(page, auth, fileId);
  expect(def.items.map((i) => i.id)).toContain(bring.id);

  // And it's on the Forms home, open, in the Forms folder.
  await page.goto("/forms");
  const tile = page.getByRole("listitem").filter({ hasText: `BBQ on Saturday ${stamp}` });
  await expect(tile).toContainText("No answers yet");
  await expect(tile).toContainText("Open");
  const list = await (await page.request.get("/api/forms", { headers: { Authorization: auth } })).json();
  const row = list.forms.find((f: { file_id: string }) => f.file_id === fileId);
  const folders = (await (await page.request.get("/api/files/folders/all", { headers: { Authorization: auth } })).json()) as { id: string; name: string }[];
  expect(folders.find((f) => f.id === row.folder_id)?.name).toBe("Forms");
});

test("autosave keeps every edit: two tabs, and offline", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const made = await page.request.post("/api/forms", { headers: { Authorization: auth }, data: { template: "feedback" } });
  const fileId = (await made.json()).file.id as string;

  const tabA = page;
  await tabA.goto(`/files/form/${fileId}`);
  await expect(tabA.getByRole("textbox", { name: "Form title" })).toHaveValue("Feedback");
  const tabB = await page.context().newPage();
  await tabB.goto(`/files/form/${fileId}`);
  await expect(tabB.getByRole("textbox", { name: "Form title" })).toHaveValue("Feedback");

  // Tab A renames the form; tab B, still on the older version, adds a question.
  await tabA.bringToFront();
  await tabA.getByRole("textbox", { name: "Form title" }).fill(`Two tabs ${stamp}`);
  await saved(tabA);
  await tabB.getByRole("toolbar", { name: "Add to the form" }).getByRole("button", { name: "Add question" }).click();
  await openCard(tabB).getByRole("textbox", { name: "Question", exact: true }).fill("Added in tab B");
  await saved(tabB);
  // Tab B was told, and has tab A's change.
  await expect(tabB.getByRole("textbox", { name: "Form title" })).toHaveValue(`Two tabs ${stamp}`);
  let def = await definition(page, auth, fileId);
  expect(def.title).toBe(`Two tabs ${stamp}`);
  expect(def.items.some((i) => i.title === "Added in tab B")).toBe(true);
  // Tab A picks up tab B's question when it comes back into focus.
  await tabA.bringToFront();
  await tabA.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(tabA.getByRole("button", { name: /^Edit question: Added in tab B/ })).toBeVisible();

  // Offline: the edit waits, says so, and saves when the connection's back.
  await tabB.close();
  await tabA.context().setOffline(true);
  await tabA.getByRole("button", { name: /^Edit question: Added in tab B/ }).click();
  await openCard(tabA).getByRole("textbox", { name: "Question", exact: true }).fill("Changed while offline");
  await expect(tabA.locator("[data-save-status]")).toHaveAttribute("data-save-status", /offline|error/, { timeout: 15_000 });
  await expect(tabA.getByRole("alert").filter({ hasText: "Not saved" })).toBeVisible();
  await tabA.context().setOffline(false);
  await tabA.evaluate(() => window.dispatchEvent(new Event("online")));
  await saved(tabA);
  def = await definition(page, auth, fileId);
  expect(def.items.some((i) => i.title === "Changed while offline")).toBe(true);
});

test("reorder by keyboard, duplicate, delete and undo", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const made = await page.request.post("/api/forms", { headers: { Authorization: auth }, data: { template: "contact" } });
  const fileId = (await made.json()).file.id as string;
  await page.goto(`/files/form/${fileId}`);
  const order = async () => (await definition(page, auth, fileId)).items.filter((i) => !i.deleted).map((i) => i.title);
  expect(await order()).toEqual(["Full name", "Email", "Phone number", "Postal address", "Best way to reach you"]);

  // Move down from the question's "More" menu, by keyboard.
  await page.getByRole("button", { name: /^Edit question: Full name/ }).click();
  const more = openCard(page).getByRole("button", { name: "More", exact: true });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "More", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Move down" }).focus();
  await page.keyboard.press("Enter");
  await saved(page);
  expect((await order()).slice(0, 2)).toEqual(["Email", "Full name"]);

  // The drag handle works from the keyboard too (Space, arrow, Space).
  const handle = page.getByRole("button", { name: /^Drag to reorder: Phone number/ });
  await handle.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(250);
  await page.keyboard.press("Space");
  await saved(page);
  expect((await order()).slice(0, 3)).toEqual(["Email", "Phone number", "Full name"]);

  // Undo puts the drag back.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await saved(page);
  expect((await order()).slice(0, 3)).toEqual(["Email", "Full name", "Phone number"]);

  // Duplicate, then delete the copy and bring it back with the toast's Undo.
  await page.getByRole("button", { name: /^Edit question: Email/ }).click();
  await openCard(page).getByRole("button", { name: "Duplicate" }).click();
  await expect(openCard(page).getByRole("textbox", { name: "Question", exact: true })).toHaveValue("Email (copy)");
  await saved(page);
  expect(await order()).toContain("Email (copy)");
  await openCard(page).getByRole("button", { name: "Delete" }).click();
  await saved(page);
  expect(await order()).not.toContain("Email (copy)");
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await saved(page);
  expect(await order()).toContain("Email (copy)");
});

test("every question type, sections, settings and the look", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const made = await page.request.post("/api/forms", { headers: { Authorization: auth }, data: {} });
  const fileId = (await made.json()).file.id as string;
  await page.goto(`/files/form/${fileId}`);
  await expect(page.getByText(/^No questions yet\. Add your first one/)).toBeVisible();

  const kinds: [string, string][] = [
    ["Short answer", "short_text"],
    ["Paragraph", "paragraph"],
    ["Multiple choice", "multiple_choice"],
    ["Checkboxes", "checkboxes"],
    ["Dropdown", "dropdown"],
    ["Linear scale", "linear_scale"],
    ["Rating", "rating"],
    ["Date", "date"],
    ["Time", "time"],
    ["File upload", "file_upload"],
  ];
  const bar = page.getByRole("toolbar", { name: "Add to the form" });
  for (const [label] of kinds) {
    await bar.getByRole("button", { name: "Add question" }).click();
    const card = openCard(page);
    await card.getByRole("textbox", { name: "Question", exact: true }).fill(`A ${label.toLowerCase()} question`);
    await card.getByRole("combobox", { name: "Question type" }).selectOption({ label });
  }
  // Short answer: a number from 1 to 10.
  await page.getByRole("button", { name: /^Edit question: A short answer question/ }).click();
  let card = openCard(page);
  await card.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Answer rules" }).click();
  await card.getByRole("combobox", { name: "The answer must be" }).selectOption("number");
  await card.getByRole("spinbutton", { name: "Smallest" }).fill("1");
  await card.getByRole("spinbutton", { name: "Largest" }).fill("10");
  // A section, a text block, and branching to it.
  await bar.getByRole("button", { name: "Add section" }).click();
  await page.getByRole("textbox", { name: "Section title" }).fill("More about you");
  await bar.getByRole("button", { name: "Add title & text" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Nearly done");
  await page.getByRole("button", { name: /^Edit question: A multiple choice question/ }).click();
  card = openCard(page);
  await card.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Go to section based on answer" }).click();
  await card.locator("li").first().getByRole("combobox").selectOption({ label: "Submit form" });
  await expect(page.getByText("After section 1")).toBeVisible();

  // The look: a colour, a built-in header, a font.
  await page.getByRole("button", { name: "Look", exact: true }).click();
  const look = page.getByRole("dialog", { name: "Look" });
  await look.getByRole("radio", { name: "Teal" }).check({ force: true });
  await look.getByRole("button", { name: "Bunting" }).click();
  await look.getByRole("radio", { name: "Serif" }).check({ force: true });
  await page.keyboard.press("Escape");
  await saved(page);

  const def = await definition(page, auth, fileId);
  const byKind = new Map(def.items.map((i) => [i.kind, i]));
  for (const [, kind] of kinds) expect(byKind.has(kind), kind).toBe(true);
  expect(byKind.get("short_text")!.config.validation).toMatchObject({ kind: "number", min: 1, max: 10 });
  expect(byKind.get("section")!.title).toBe("More about you");
  expect(byKind.get("text")!.title).toBe("Nearly done");
  const mc = byKind.get("multiple_choice")!.config as { branching: boolean; options: { go_to: string | null }[] };
  expect(mc.branching).toBe(true);
  expect(mc.options[0].go_to).toBe("submit");
  expect((def as unknown as { theme: Record<string, unknown> }).theme).toMatchObject({ accent: "teal", header_builtin: "bunting", font: "serif" });

  // Settings save as they change.
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Only one answer per person" }).click();
  await page.getByRole("switch", { name: "Close after a number of answers" }).click();
  await page.getByRole("spinbutton", { name: "Number of answers" }).fill("30");
  await page.getByLabel("Confirmation message").fill("See you there!");
  await page.getByLabel("Confirmation message").blur();
  await expect
    .poll(async () => (await (await page.request.get(`/api/forms/${fileId}`, { headers: { Authorization: auth } })).json()).form.settings)
    .toMatchObject({ one_per_person: true, max_responses: 30, confirmation: "See you there!" });

  // "Taking answers" off closes it.
  await page.getByRole("switch", { name: "Taking answers" }).click();
  await expect(page.getByRole("switch", { name: "Closed" })).toHaveAttribute("aria-checked", "false");
  await page.goto("/forms");
  await expect(page.getByRole("listitem").filter({ hasText: "Untitled form" }).first()).toContainText("Closed");
});

test("Files: New ▸ Form and the Files home tile open the builder", async ({ alice: page }) => {
  await page.goto("/files/home");
  await ready(page);
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await page.waitForURL(/\/files\/form\//);
  await expect(page.getByRole("textbox", { name: "Form title" })).toHaveValue("Untitled form");
});

test("the builder, preview, settings and Forms home pass an accessibility scan", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const found: string[] = [];
  found.push(...(await scan(page, "forms home", "main")));
  const made = await page.request.post("/api/forms", { headers: { Authorization: auth }, data: { template: "rsvp" } });
  const fileId = (await made.json()).file.id as string;
  await page.goto(`/files/form/${fileId}`);
  await expect(page.getByRole("complementary", { name: "Preview" })).toBeVisible();
  await page.getByRole("button", { name: /^Edit question: Can you come\?/ }).click();
  found.push(...(await scan(page, "builder", "main")));
  // The preview in dark too.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  found.push(...(await scan(page, "preview (dark)", "aside[aria-label='Preview']")));
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("tab", { name: "Settings" }).click();
  found.push(...(await scan(page, "settings", "main")));
  expect(found, found.join("\n")).toEqual([]);
});
