import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

async function newWorkspace(page: Page, title: string): Promise<void> {
  await page.goto("/workspaces");
  await ready(page);
  await page.getByRole("button", { name: "New workspace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByPlaceholder("e.g. Home renovation, Book draft, Client XYZ").fill(title);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}/);
}

async function addItem(page: Page, kind: "New note" | "New board"): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
}

const tree = (page: Page) => page.getByRole("tree", { name: "Workspace content" });

/** A board column: from its heading up to the column container. */
const column = (page: Page, name: string) =>
  page
    .getByText(name, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');

test.describe("workspaces", () => {
  test("write in a note and share it with a public link", async ({ alice: page, browser }) => {
    await newWorkspace(page, `E2E notes ${stamp}`);
    await addItem(page, "New note");

    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    const words = `Shared from the safety net ${stamp}`;
    await page.keyboard.type(words);
    await expect(editor).toContainText(words);

    const noteRow = tree(page).locator("li").filter({
      has: page.getByRole("button", { name: "Untitled note", exact: true }),
    }).last();
    await noteRow.hover();
    // exact: the row itself is a role=button whose name also says "More actions".
    await noteRow.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Public link…" }).click();

    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Create link" }) });
    await expect(dialog.getByText("Include photo location")).toBeVisible();
    await dialog.getByRole("button", { name: "Create link" }).click();
    const url = await dialog.locator("input[readonly]").first().inputValue();
    expect(url).toMatch(/\/s\//);

    // Someone with no account opens it. The shared copy follows edits
    // via the collab server, so give it a moment to catch up.
    const visitor = await (await browser.newContext()).newPage();
    await expect(async () => {
      await visitor.goto(url);
      await visitor.getByRole("button", { name: "Preview" }).click({ timeout: 5_000 });
      await expect(visitor.locator(".promptly-prose")).toContainText(words, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await visitor.context().close();
  });

  test("add a card to a board and drag it to Done", async ({ alice: page }) => {
    await newWorkspace(page, `E2E board ${stamp}`);
    await addItem(page, "New board");
    await tree(page).getByRole("button", { name: "Board", exact: true }).click();

    await expect(column(page, "To Do")).toBeVisible();
    await column(page, "To Do").getByTitle("New item").click();
    const card = `Ship the safety net ${stamp}`;
    const panel = page.locator("div.fixed.inset-0").filter({ has: page.getByLabel("Column") });
    await panel.locator("input").first().fill(card);
    await panel.locator("input").first().press("Enter");
    await panel.getByRole("button", { name: "Close card" }).click();
    await expect(panel).toHaveCount(0);

    const inTodo = column(page, "To Do").locator('[draggable="true"]', { hasText: card });
    await expect(inTodo).toBeVisible();
    await inTodo.dragTo(column(page, "Done"));
    await expect(column(page, "Done").locator('[draggable="true"]', { hasText: card })).toBeVisible();

    // The move was saved, not just drawn.
    await page.reload();
    await ready(page);
    await expect(column(page, "Done").locator('[draggable="true"]', { hasText: card })).toBeVisible();
    await expect(column(page, "To Do").locator('[draggable="true"]', { hasText: card })).toHaveCount(0);
  });

  test("a deleted workspace can be restored from Recently deleted", async ({ alice: page }) => {
    const title = `E2E trash ${stamp}`;
    await newWorkspace(page, title);
    await page.goto("/workspaces");
    await ready(page);
    const card = page.locator("div.group").filter({ has: page.getByRole("button", { name: `Open ${title}` }) });
    await card.hover();
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Delete workspace" }).click();
    await expect(page.getByText(`"${title}" moved to Recently deleted.`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Open ${title}` })).toHaveCount(0);

    await page.getByRole("tab", { name: /^Archive/ }).click();
    const trashSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Recently deleted" }) });
    const row = trashSection.locator("li").filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole("tab", { name: /^Active/ }).click();
    await expect(page.getByRole("button", { name: `Open ${title}` })).toBeVisible();
  });

  test("Back returns to the previous item instead of leaving the workspace", async ({ alice: page }) => {
    await newWorkspace(page, `E2E back ${stamp}`);
    const home = page.url().split("?")[0];
    await addItem(page, "New note");
    await addItem(page, "New board");
    await tree(page).getByRole("button", { name: "Untitled note", exact: true }).click();
    await expect(page).toHaveURL(/item=/);
    const noteUrl = page.url();
    await tree(page).getByRole("button", { name: "Board", exact: true }).click();
    await expect(page).not.toHaveURL(noteUrl);
    await page.goBack();
    await expect(page).toHaveURL(noteUrl);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 20_000 });
    expect(page.url().startsWith(home)).toBe(true);
  });

  test("a board reads on a phone", async ({ alice: page }) => {
    await newWorkspace(page, `E2E phone ${stamp}`);
    await addItem(page, "New board");
    await tree(page).getByRole("button", { name: "Board", exact: true }).click();
    await column(page, "To Do").getByTitle("New item").click();
    const card = `Read me on a phone ${stamp}`;
    const panel = page.locator("div.fixed.inset-0").filter({ has: page.getByLabel("Column") });
    await panel.locator("input").first().fill(card);
    await panel.locator("input").first().press("Enter");
    await panel.getByRole("button", { name: "Close card" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(page.url().split("?")[0]);
    await ready(page);
    await page.getByRole("button", { name: /^Board/ }).first().click();
    await expect(page.getByText(card)).toBeVisible();
    await expect(page.getByText("Read-only on a phone")).toBeVisible();
    await expect(page.getByText("best on desktop")).toHaveCount(0);
  });

  test("renaming a column keeps every character typed", async ({ alice: page }) => {
    await newWorkspace(page, `E2E columns ${stamp}`);
    await addItem(page, "New board");
    await tree(page).getByRole("button", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const name = page.getByLabel("Column name").first();
    await name.fill("");
    // Fast typing used to drop characters: each keystroke saved and the
    // input reverted to the server's copy until the round trip (R-169).
    await name.pressSequentially("Backlog of ideas", { delay: 5 });
    await expect(name).toHaveValue("Backlog of ideas");
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes("/items/") && r.ok()
    );
    await name.press("Enter");
    await saved;
    await page.reload();
    await ready(page);
    await expect(page.getByText("Backlog of ideas", { exact: true }).first()).toBeVisible();
  });

  test("a sheet can be exported, has a history and takes comments", async ({ alice: page }) => {
    await newWorkspace(page, `E2E sheet ${stamp}`);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New sheet", exact: true }).click();
    await expect(page.getByRole("button", { name: "Import" })).toBeVisible({ timeout: 20_000 });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: ".xlsx" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("complementary", { name: "Version history" })).toBeVisible();
    await page.getByRole("button", { name: "Open comments" }).click();
    await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
  });

  test("a workspace sheet is a file in Files and opens back in its workspace", async ({ alice: page }) => {
    const title = `E2E budget ${stamp}`;
    await newWorkspace(page, `E2E office ${stamp}`);
    const wsUrl = page.url();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New sheet", exact: true }).click();
    await expect(page.getByRole("button", { name: "Import" })).toBeVisible({ timeout: 20_000 });
    const row = tree(page).locator("li").filter({ has: page.getByRole("button", { name: /^Untitled sheet/ }) }).last();
    await row.hover();
    await row.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await expect(tree(page).getByRole("button", { name: title, exact: true })).toBeVisible();

    // WP-3.2: it's found in Files by name, as a Sheet — not as a .md mirror.
    await page.goto("/files/search?q=" + encodeURIComponent(title));
    await ready(page);
    // The result row's button also carries its breadcrumb and snippet.
    const open = page.getByRole("button", { name: new RegExp(`^${title} My files`) }).first();
    const hit = page.locator("li").filter({ has: open }).first();
    await expect(hit).toBeVisible();
    await expect(hit.getByText("Sheet", { exact: true })).toBeVisible();
    // WP-3.4: it opens on its own editor page, which leads back to the
    // workspace.
    await open.click();
    await expect(page).toHaveURL(/\/files\/sheet\//);
    await page.getByRole("button", { name: "Open in workspace" }).click();
    const wsId = wsUrl.split("/workspaces/")[1].split(/[?#]/)[0];
    await expect(page).toHaveURL(new RegExp(`/workspaces/${wsId}[?]item=`));
  });

  test("a workspace shows up under Files as a drive", async ({ alice: page }) => {
    const ws = `E2E drive ${stamp}`;
    await newWorkspace(page, ws);
    const wsId = page.url().split("/workspaces/")[1].split(/[?#]/)[0];
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New sheet", exact: true }).click();
    await expect(page.getByRole("button", { name: "Import" })).toBeVisible({ timeout: 20_000 });

    // WP-3.5: Files › Workspaces lists it like a shared drive.
    await page.goto("/files");
    await ready(page);
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    await page.getByRole("link", { name: ws, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/files/workspaces/${wsId}`));
    await expect(page.getByRole("heading", { name: /Spreadsheets/ })).toBeVisible();
    await page.getByRole("button", { name: /^Untitled sheet/ }).click();
    await expect(page).toHaveURL(/\/files\/sheet\//);
  });

  test("renaming a note from its title renames it in the workspace", async ({ alice: page }) => {
    // R-218: the title went through Drive's rename, which refuses a
    // workspace's files — every title edit came back "Rename failed".
    const title = `E2E renamed ${stamp}`;
    await newWorkspace(page, `E2E titles ${stamp}`);
    await addItem(page, "New note");
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible({ timeout: 20_000 });
    const field = page.getByLabel("Document title").first();
    await field.fill(title);
    await field.press("Enter");
    await expect(tree(page).getByRole("button", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("Rename failed")).toHaveCount(0);
    await expect(page.getByText(/belongs to the workspace/)).toHaveCount(0);
  });
});

test("the workspace drive is the Files browser, with the workspace's own details", async ({ alice: page }) => {
  // WP-7.6: one browser, one upload queue.
  test.setTimeout(90_000);
  await newWorkspace(page, `E2E ws drive ${stamp}`);
  await page.getByRole("button", { name: "Workspace drive" }).click();

  const name = `e2e-ws-notes-${stamp}`;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles({ name: `${name}.txt`, mimeType: "text/plain", buffer: Buffer.from("Meeting notes for the drive") });

  // The shared row: name, then who added it and whether chats can use it.
  const row = page.locator("li").filter({ has: page.getByRole("button", { name, exact: false }) }).last();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("added");
  await expect(row).toContainText("in context");

  // Leave it out of the workspace's context from its menu.
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Leave out of context" }).click();
  await expect(row).toContainText("not in context");

  // A folder, opened from the list; the breadcrumb leads back.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Receipts");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Receipts", exact: true }).dblclick();
  await expect(page.getByText("Drop files anywhere on this pane")).toBeVisible();
  await page.getByRole("navigation", { name: "Drive folders" }).getByRole("button", { name: "All files" }).click();

  // Grid view is the Files grid.
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator("ul.grid li").filter({ hasText: name })).toBeVisible();
  await page.getByRole("button", { name: "List view" }).click();

  // Removing takes it out of the workspace.
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Remove from workspace" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  // (The uploads panel still lists it as uploaded — only the drive rows count.)
  await expect(page.locator("[data-drive-item]").filter({ hasText: name })).toHaveCount(0);
});
