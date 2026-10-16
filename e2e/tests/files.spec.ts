import type { Page, WebSocketRoute } from "@playwright/test";

import fs from "node:fs";

import { expect, ready, run, showRow, stamp, test } from "../fixtures";
import { pdf, png, wordDoc, xlsxDoc } from "../lib/files";

async function openDrive(page: Page): Promise<void> {
  await page.goto("/files");
  await ready(page);
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
}

/** The list row (<li>) whose open button is called `name` — not the
 *  folder-tree rail's entry (a <nav>), which repeats folder names. */
/** Upload through New ▸ Upload files, then find the file through search —
 *  a well-used test account's file list is long and virtualised, so the
 *  new row may not be rendered where a test looks. Returns its row. */
async function uploadAndFind(page: Page, file: string, name: string) {
  await openDrive(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/files\/$/.test(r.url()));
  await (await chooser).setFiles(file);
  expect((await uploaded).ok()).toBeTruthy();
  await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
  const open = page.getByRole("button", { name: new RegExp(`^${name}`) }).first();
  await expect(open).toBeVisible();
  return open;
}

const row = (page: Page, name: string) =>
  page.locator("li:not(nav li)").filter({ has: page.getByRole("button", { name, exact: true }) }).last();

test.describe("files", () => {
  test("upload a PDF and open it", async ({ alice: page }) => {
    const name = `e2e-report-${stamp}`;
    const file = pdf(`${name}.pdf`, `Safety net ${stamp}`);
    await openDrive(page);

    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/files\/$/.test(r.url()));
    await (await chooser).setFiles(file);

    // Uploaded; then find it (a well-used test account's list is long and
    // virtualised, so the new row can be out of view). Rows are named
    // without the extension.
    expect((await uploaded).ok()).toBeTruthy();
    await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
    const open = page.getByRole("button", { name: new RegExp(`^${name}`) }).first();
    await expect(open).toBeVisible();
    await open.click();

    const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
    await expect(preview.locator("#preview-title")).toHaveText(`${name}.pdf`);
    await expect(preview.getByText("Page 1 of 1")).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator(".pdfViewer .page canvas").first()).toBeVisible();
  });

  test("share a folder with someone and they see it", async ({ alice, bob }) => {
    const folder = `E2E shared ${stamp}`;
    await openDrive(alice);

    await alice.getByRole("button", { name: "New", exact: true }).click();
    await alice.getByRole("menuitem", { name: "New folder" }).click();
    await alice.getByLabel("Folder name").fill(folder);
    await alice.getByRole("button", { name: "Create", exact: true }).click();
    await expect(row(alice, folder)).toBeVisible();

    await row(alice, folder).getByRole("button", { name: "More actions" }).click();
    await alice.getByRole("button", { name: "Share", exact: true }).click();
    const share = alice.getByRole("dialog").filter({ has: alice.getByRole("heading", { name: "Share folder" }) });
    await share.getByPlaceholder("Search by name or email…").fill(run.users.bob.username);
    await share.getByRole("button", { name: new RegExp(`@${run.users.bob.username}`) }).click();
    await expect(share.getByRole("button", { name: "Revoke access" })).toBeVisible();
    await share.getByRole("button", { name: "Done" }).click();

    await bob.goto("/files/shared");
    await ready(bob);
    await showRow(bob, folder);
    const shared = row(bob, folder).getByRole("button", { name: folder, exact: true });
    await expect(shared).toBeVisible();
    await shared.dblclick();
    // R-023: a folder shared with you opens as shared, with its contents.
    await expect(bob).toHaveURL(/\/files\/folder\/[^?]+\?scope=shared/);
    await expect(bob.getByText("Nothing here yet")).toBeVisible();
  });

  test("trash lists the folder, and restore says where it went", async ({ alice: page }) => {
    const folder = `E2E trip ${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    await page.getByLabel("Folder name").fill(folder);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(row(page, folder)).toBeVisible();

    await row(page, folder).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
    await expect(row(page, folder)).toHaveCount(0);

    // R-209: the trashed folder shows where it was; restore names the place.
    await page.goto("/files/trash");
    await ready(page);
    await showRow(page, page.getByText(folder));
    // The row's button also carries "From My files · deleted …", so match
    // the row by its text rather than the button's exact name.
    const trashed = page.locator("li:not(nav li)").filter({ hasText: folder }).last();
    await expect(trashed.getByText(/From My files/)).toBeVisible();
    await trashed.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText(`Restored “${folder}” to My files`)).toBeVisible();
  });

  test("search finds a file by part of its name as you type", async ({ alice: page }) => {
    const name = `Q3_budget-${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/files\/$/.test(r.url()));
    await (await chooser).setFiles(pdf(`${name}.pdf`, "nothing about money in here"));
    // Uploaded (the new row can be below the fold of a long, virtualised
    // list in a well-used test account, so wait on the upload itself).
    expect((await uploaded).ok()).toBeTruthy();

    // R-213: "budget" used to miss "Q3_budget-…" (one token to Postgres),
    // and results only came on submit.
    const box = page.getByPlaceholder("Search Drive…");
    await box.click();
    await box.fill(`budget ${stamp}`);
    // In the instant-results dropdown (the folder list has the file too).
    const dropdown = box.locator("xpath=ancestor::form[1]");
    await expect(dropdown.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  });

  test("one search box: words as you type, kind chips, inside a folder, and where each result is", async ({
    alice: page,
  }) => {
    // WP-5.4.
    const auth = await bearer(page);
    const upload = async (name: string, text: string, folderId?: string) => {
      const r = await page.request.post("/api/files/", {
        headers: { Authorization: auth },
        multipart: {
          scope: "mine",
          ...(folderId ? { folder_id: folderId } : {}),
          file: { name, mimeType: "text/plain", buffer: Buffer.from(text) },
        },
      });
      expect(r.ok()).toBeTruthy();
      return (await r.json()).id as string;
    };
    const f = await page.request.post("/api/files/folders", {
      headers: { Authorization: auth },
      data: { name: `E2E kickoff ${stamp}`, scope: "mine" },
    });
    const folderId = (await f.json()).id as string;
    await upload(`inside-${stamp}.txt`, `Kickoff milestones${stamp} agreed`, folderId);
    await upload(`outside-${stamp}.txt`, `Kickoff milestones${stamp} draft`);

    // A word from inside the files, half typed, finds both — with where they are.
    await page.goto(`/files/search?q=${encodeURIComponent(`milestones${stamp}`.slice(0, -2))}`);
    const results = page.locator("main, body").first();
    await expect(results.getByText(`inside-${stamp}`, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(results.getByText(`outside-${stamp}`, { exact: true })).toBeVisible();
    await expect(results.getByText(`My files / E2E kickoff ${stamp}`, { exact: true })).toBeVisible();
    // "Show in folder" (row menu) opens where it lives.
    await results.getByText(`inside-${stamp}`, { exact: true }).click({ button: "right" });
    await page.getByRole("button", { name: "Show in folder" }).click();
    await expect(page).toHaveURL(new RegExp(`/files/folder/${folderId}$`));
    await page.goBack();

    // A kind chip narrows it.
    await page.getByRole("radio", { name: "PDFs" }).click();
    await expect(page.getByText("No results")).toBeVisible();
    await page.getByRole("radio", { name: "All" }).click();
    await expect(results.getByText(`outside-${stamp}`, { exact: true })).toBeVisible();

    // From inside the folder, the box searches that folder.
    await page.goto(`/files/folder/${folderId}`);
    await ready(page);
    const box = page.getByPlaceholder("Search Drive…");
    await box.click();
    await box.fill(`milestones${stamp}`);
    const dropdown = box.locator("xpath=ancestor::form[1]");
    await expect(dropdown.getByRole("button", { name: `E2E kickoff ${stamp}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dropdown.getByRole("button", { name: new RegExp(`inside-${stamp}`) })).toBeVisible();
    await expect(dropdown.getByRole("button", { name: new RegExp(`outside-${stamp}`) })).toHaveCount(0);
    await box.press("Enter");
    await expect(page).toHaveURL(new RegExp(`in=${folderId}`));
    await expect(page.getByText(`In My files / E2E kickoff ${stamp}`)).toBeVisible();
    await expect(results.getByText(`outside-${stamp}`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Search everywhere" }).click();
    await expect(results.getByText(`outside-${stamp}`, { exact: true })).toBeVisible();
  });

  test("a sheet from a template opens on its own page, shares, and the person is told", async ({ alice, bob }) => {
    await openDrive(alice);
    await alice.getByRole("button", { name: "New", exact: true }).click();
    await alice.getByRole("menuitem", { name: "From template…" }).click();
    const picker = alice.getByRole("dialog").filter({ hasText: "New from template" });
    await picker.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(alice).toHaveURL(/\/files\/sheet\//);
    const sheetUrl = alice.url();

    // Rename it in the header, then share it with Bob from there.
    const title = `Budget ${stamp}`;
    const name = alice.getByLabel("Name");
    await expect(name).toHaveValue("Budget");
    await name.fill(title);
    await name.press("Enter");
    await expect(name).toHaveValue(title);
    await alice.getByRole("button", { name: "Share", exact: true }).click();
    const share = alice.getByRole("dialog").filter({ has: alice.getByRole("heading", { name: "Share file" }) });
    await share.getByPlaceholder("Search by name or email…").fill(run.users.bob.username);
    await share.getByRole("button", { name: new RegExp(`@${run.users.bob.username}`) }).click();
    await expect(share.getByRole("button", { name: "Revoke access" })).toBeVisible();
    await share.getByRole("button", { name: "Done" }).click();

    // Bob gets a notification, and the shared sheet opens on the same page,
    // view-only, and lands in his Recent.
    await bob.goto("/chat");
    await ready(bob);
    await bob.locator("aside").getByRole("button", { name: "Open notification inbox" }).click();
    await expect(bob.getByText(`${run.users.alice.username} shared “${title}” with you`)).toBeVisible();
    await bob.goto("/files/shared");
    await ready(bob);
    await showRow(bob, title);
    const shared = row(bob, title).getByRole("button", { name: title, exact: true });
    await expect(shared).toBeVisible();
    await shared.dblclick();
    await expect(bob).toHaveURL(new RegExp(sheetUrl.split("/files/")[1]));
    await expect(bob.getByText("You can view this spreadsheet.")).toBeVisible();
    await bob.goto("/files/recent");
    await ready(bob);
    await expect(bob.getByRole("button", { name: title, exact: true }).first()).toBeVisible();
  });

  test("a new whiteboard opens on its own page", async ({ alice: page }) => {
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Whiteboard", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/whiteboard\//);
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Name")).toHaveValue("Untitled whiteboard");
  });

  test("a click selects and fills the details pane; Enter opens", async ({ alice: page }) => {
    const name = `e2e-details-${stamp}`;
    // Its own folder: the account's root is long and virtualised, so a new
    // row there can be out of view.
    const auth = await bearer(page);
    const folder = await (
      await page.request.post("/api/files/folders", {
        headers: { Authorization: auth },
        data: { name: `E2E details ${stamp}`, scope: "mine" },
      })
    ).json();
    await page.goto(`/files/folder/${folder.id}`);
    await ready(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    await (await chooser).setFiles(pdf(`${name}.pdf`, "details pane"));
    const open = page.getByRole("button", { name, exact: true });
    await expect(open).toBeVisible();

    await open.click();
    const details = page.locator("aside").filter({ hasText: "Details" });
    await expect(details.getByText("Owner")).toBeVisible();
    await expect(details.getByText("You", { exact: true })).toBeVisible();
    await expect(details.getByText(`My files / E2E details ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask about this" }).first()).toBeVisible();

    await open.press("Enter");
    const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
    await expect(preview.locator("#preview-title")).toHaveText(`${name}.pdf`);
  });

  test("Home shows Recent, and asking about a file starts a chat with it attached", async ({ alice: page }) => {
    const name = `e2e-home-${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/files\/$/.test(r.url()));
    await (await chooser).setFiles(pdf(`${name}.pdf`, "home recent"));
    // The account's list is long and virtualised — the new row may be out
    // of view; Recent below is what this test is about.
    expect((await uploaded).ok()).toBeTruthy();

    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/home/);
    await page.getByLabel(`Pick ${name} to ask about`).check();
    await page.getByLabel("Ask about your files").fill("What is this about?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByText(`${name}.pdf`).first()).toBeVisible();
  });


  test("the save chip tells the truth when the connection drops", async ({ alice: page }) => {
    // R-224: typing offline showed a green "All changes saved". The live
    // socket is cut and kept down through the page's own WebSocket route
    // (offline emulation doesn't close an open socket).
    let online = true;
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/collab\//, (ws) => {
      if (!online) {
        void ws.close();
        return;
      }
      ws.connectToServer();
      sockets.push(ws);
    });
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/doc\//);
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.type("Online words. ");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    online = false;
    for (const ws of sockets) await ws.close();
    await expect(page.getByText("Live sync offline.")).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("Offline words.");
    await expect(page.getByText(/Offline · \d+ unsynced change/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);

    // Back online: the edits reach the server and the chip says so — the
    // editor was never replaced by an error card (R-221).
    online = true;
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Collaboration unavailable")).toHaveCount(0);
    await expect(editor).toContainText("Offline words.");
  });

  test("a backend restart while reconnecting doesn't take the editor down", async ({ alice: page }) => {
    // R-221: one failed token fetch replaced the document with
    // "Collaboration unavailable" until it was closed and reopened.
    let online = true;
    let restarting = false;
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/collab\//, (ws) => {
      if (!online) {
        void ws.close();
        return;
      }
      ws.connectToServer();
      sockets.push(ws);
    });
    await page.route(/\/api\/documents\/[^/]+\/collab-token/, (route) =>
      restarting ? route.fulfill({ status: 502, body: "Bad Gateway" }) : route.continue()
    );
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });

    // The socket drops and the backend is "restarting" when it reconnects.
    restarting = true;
    online = false;
    for (const ws of sockets) await ws.close();
    online = true;
    await expect(page.getByText(/Reconnecting to live editing/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Collaboration unavailable")).toHaveCount(0);

    // The backend is back: live editing resumes on its own.
    restarting = false;
    await expect(page.getByText(/Reconnecting to live editing/)).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.type("Still here.");
    await expect(editor).toContainText("Still here.");
  });

  test("a document's blocks survive into the saved copy", async ({ alice: page }) => {
    // WP-4.2 (TipTap v3): every block type the slash menu offers, typed in
    // the editor, must come back from the server-rendered snapshot.
    const name = `E2E blocks ${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const title = page.getByLabel("Document title").first();
    await title.fill(name);
    await title.press("Enter");
    await editor.click();

    // One word — the "/" menu closes at a space, like any suggestion menu.
    const slash = async (item: string) => {
      await page.keyboard.type(`/${item}`);
      await expect(page.locator(".slash-command-popup")).toBeVisible();
      await page.keyboard.press("Enter");
    };
    await page.keyboard.type("Intro paragraph.");
    await page.keyboard.press("Enter");
    // The table first (nothing follows it to step out into), then the
    // other blocks go in between the intro and the table.
    await slash("Table");
    await page.keyboard.type("Cell one");
    // Back to the end of the intro. ProseMirror reads a click's selection on
    // the (async) selectionchange event, so wait for the editor itself to
    // leave the cell before typing — else Enter splits the cell instead.
    await editor.getByText("Intro paragraph.").click();
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        editor.evaluate((el) => {
          const ed = (el as unknown as { editor: { state: { selection: { $from: { depth: number; node: (d: number) => { type: { name: string } } } } } } }).editor;
          const $from = ed.state.selection.$from;
          for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return "in table";
          return "outside";
        })
      )
      .toBe("outside");
    await page.keyboard.press("Enter");
    await expect(editor.locator("table")).not.toContainText("Intro");
    await slash("To-do");
    await page.keyboard.type("Task one");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await slash("Code");
    await page.keyboard.type("const x = 1;");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await slash("Callout");
    await page.keyboard.type("Callout text");

    await expect(editor.locator('ul[data-type="taskList"]')).toContainText("Task one");
    await expect(editor.locator("pre code")).toContainText("const x = 1;");
    await expect(editor.locator("table")).toContainText("Cell one");
    await expect(editor).toContainText("Callout text");
    await expect(editor.locator("table")).not.toContainText("Callout text");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The server's web-page export renders from the saved Yjs state (Export
    // itself gives a .docx since WP-4.3, built from the live editor).
    await expect(async () => {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download document" }).click();
      await page.getByRole("menuitem", { name: "Web page (.html)" }).click();
      const html = await (await (await download).createReadStream()).toArray();
      const text = Buffer.concat(html as Buffer[]).toString("utf-8");
      expect(text).toContain("<table");
      expect(text).toContain("Cell one");
      expect(text).toMatch(/data-type="taskList"[\s\S]*Task one/);
      expect(text).toMatch(/<pre><code[^>]*>const x = 1;/);
      expect(text).toMatch(/data-type="callout"[\s\S]*Callout text/);
      expect(text).toContain("Intro paragraph.");
      // In document order, with the table last (not swallowing the rest).
      expect(text.indexOf("Callout text")).toBeLessThan(text.indexOf("<table"));
    }).toPass({ timeout: 40_000 });
  });

  test("a Word file previews, opens as a document, and exports back to Word", async ({ alice: page }) => {
    // WP-4.3: upload → preview → "Open in Promptly Docs" → .docx out.
    const name = `e2e-plan-${stamp}`;
    const file = await wordDoc(`${name}.docx`);
    const open = await uploadAndFind(page, file, name);

    // The preview renders the Word file itself, in a sandboxed frame.
    await open.click();
    const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
    await expect(preview.locator("#preview-title")).toHaveText(`${name}.docx`);
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByText("Quarterly plan")).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "allow-same-origin");

    // An editable copy, next to the original.
    await preview.getByRole("button", { name: "Open in Promptly Docs" }).click();
    await expect(page).toHaveURL(/\/files\/doc\//, { timeout: 30_000 });
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator("h1")).toHaveText("Quarterly plan");
    await expect(editor.locator("strong")).toHaveText("new onboarding");
    await expect(editor.locator("ul li")).toHaveCount(2);
    await expect(editor.locator("table")).toContainText("31 March");
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(1);
    // What didn't come across is said once, up front.
    const note = page.getByRole("status").filter({ hasText: "Converted from" });
    await expect(note).toContainText(`${name}.docx`);
    await expect(note).toContainText("1 comment wasn't brought over");
    await expect(note).toContainText("Text colours aren't kept");

    // Back out as Word.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe(`${name}.docx`);
    const bytes = Buffer.concat((await (await saved.createReadStream()).toArray()) as Buffer[]);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("word/document.xml"))).toBe(true);
    expect(bytes.includes(Buffer.from("word/media/"))).toBe(true);

    // The original is still there, unchanged, beside the new document.
    // (Found by search: the file list of a well-used test account is long.)
    await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("button", { name: new RegExp(`^${name} `) })).toHaveCount(2);
  });

  test("an Excel file previews as a grid and opens as a formatted sheet", async ({ alice: page }) => {
    // WP-4.4: upload → grid preview → "Open in Promptly Sheets" → .xlsx out.
    const name = `e2e-budget-${stamp}`;
    const file = await xlsxDoc(`${name}.xlsx`);
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    await (await chooser).setFiles(file);
    const open = page.getByRole("button", { name, exact: true });
    await showRow(page, open); // a long list: scrolled to
    await expect(open).toBeVisible();

    // The preview is the workbook itself: merged bold title, money formatted.
    await open.dblclick();
    const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
    const grid = preview.getByRole("table", { name: "Budget" });
    const title = grid.getByRole("cell", { name: "Quarterly budget" });
    await expect(title).toBeVisible({ timeout: 20_000 });
    await expect(title).toHaveAttribute("colspan", "3");
    await expect(title).toHaveCSS("font-weight", "600");
    await expect(grid.getByRole("cell", { name: "1,200.50" })).toBeVisible();
    await expect(grid.getByRole("cell", { name: "Item" })).toHaveCSS("background-color", "rgb(255, 230, 153)");
    await preview.getByRole("tab", { name: "Notes" }).click();
    await expect(preview.getByRole("table", { name: "Notes" }).getByRole("cell", { name: "Ask Sam about power" })).toBeVisible();

    // A sheet next to it. Its first save carries the total the editor worked
    // out (the file had the formula but no result).
    const recalculated = page.waitForRequest(
      (r) => {
        if (r.method() !== "PUT" || !/\/api\/files\/[^/]+\/sheet$/.test(r.url())) return false;
        const body = r.postDataJSON() as { data: { celldata: { r: number; c: number; v: { v?: unknown } }[] }[] };
        return body.data[0].celldata.some((c) => c.r === 4 && c.c === 1 && Number(c.v.v) === 1380.5);
      },
      { timeout: 30_000 }
    );
    await preview.getByRole("button", { name: "Open in Promptly Sheets" }).click();
    await expect(page).toHaveURL(/\/files\/sheet\//, { timeout: 30_000 });
    const note = page.getByRole("status").filter({ hasText: "Converted from" });
    await expect(note).toContainText(`${name}.xlsx`);
    await expect(note).toContainText("Everything came across");
    await recalculated;

    // Back out as Excel, still looking like itself.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe(`${name}.xlsx`);
    const bytes = Buffer.concat((await (await saved.createReadStream()).toArray()) as Buffer[]);
    // @ts-expect-error — the minified bundle ships without its own typings path.
    const JSZip = ((await import("../../frontend/node_modules/jszip/dist/jszip.min.js")) as { default: {
      loadAsync: (b: Buffer) => Promise<{ file: (n: string) => { async: (t: "string") => Promise<string> } | null }>;
    } }).default;
    const zip = await JSZip.loadAsync(bytes);
    const sheet1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet1).toContain('<mergeCell ref="A1:C1"/>');
    expect(sheet1).toMatch(/<col [^>]*width="28(\.0+)?"/);
    expect(sheet1).toContain("SUM(B3:B4)");

    // The original is still there, beside the new sheet.
    // (Found by search: the file list of a well-used test account is long.)
    await page.goto(`/files/search?q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("button", { name: new RegExp(`^${name} `) })).toHaveCount(2);
  });

  test("a document has the formatting Docs and Word have", async ({ alice: page }) => {
    // WP-4.5 (R-226): alignment, font size, selection bubble, table menu,
    // callout colour, page break, find & replace — and they survive into
    // the server's copy (R-223 stopped the sanitiser blanking styles).
    const name = `E2E parity ${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const title = page.getByLabel("Document title").first();
    await title.fill(name);
    await title.press("Enter");
    await editor.click();
    await page.keyboard.type("Quarterly cats report");
    await page.keyboard.press("Enter");
    await page.keyboard.type("The cats sat on the mat with other cats.");

    // Select through the editor itself (a click's selection lands late).
    const select = (text: string, caretAfter = false) =>
      editor.evaluate((el, [t, after]) => {
        type PM = { isText: boolean; text?: string };
        const ed = (el as unknown as { editor: {
          state: { doc: { descendants: (f: (n: PM, pos: number) => void) => void } };
          chain: () => { focus: () => { setTextSelection: (r: { from: number; to: number }) => { run: () => void } } };
        } }).editor;
        let at = -1;
        ed.state.doc.descendants((n, pos) => {
          if (at < 0 && n.isText && n.text?.includes(t)) at = pos + n.text.indexOf(t);
        });
        const end = at + t.length;
        ed.chain().focus().setTextSelection(after ? { from: end, to: end } : { from: at, to: end }).run();
      }, [text, caretAfter] as const);

    // A selection brings up the formatting bubble.
    await select("Quarterly");
    await expect(page.getByRole("toolbar", { name: "Selection formatting" })).toBeVisible();
    // Centre the heading line and make it bigger.
    await page.getByRole("button", { name: "Alignment" }).click();
    await page.getByRole("menuitemradio", { name: "Centre" }).click();
    await expect(editor.locator("p").first()).toHaveCSS("text-align", "center");
    await select("Quarterly cats report");
    await page.getByRole("button", { name: "Font size", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "18", exact: true }).click();
    await expect(editor.locator('span[style*="font-size: 18pt"]')).toHaveText("Quarterly cats report");

    // Find & replace every "cats".
    await select("mat");
    await page.keyboard.press("ControlOrMeta+h");
    const find = page.getByRole("search", { name: "Find in document" });
    await find.getByLabel("Find", { exact: true }).fill("cats");
    // Like a browser, it starts at the first match after the cursor.
    await expect(find.getByText("3 of 3")).toBeVisible();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find.getByText("1 of 3")).toBeVisible();
    await find.getByLabel("Replace with").fill("dogs");
    await find.getByRole("button", { name: "Replace all" }).click();
    await expect(editor).toContainText("Quarterly dogs report");
    await expect(editor).toContainText("The dogs sat on the mat with other dogs.");
    await find.getByRole("button", { name: "Close find" }).click();
    await expect(find).toHaveCount(0);

    // A table: the block menu adds a column; a callout changes colour.
    await select("other dogs.", true);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/Table");
    await expect(page.locator(".slash-command-popup")).toBeVisible();
    await page.keyboard.press("Enter");
    const blockBar = page.getByRole("toolbar", { name: "Block options" });
    await expect(blockBar.getByRole("group", { name: "Table" })).toBeVisible();
    await expect(editor.locator("table tr").first().locator("th, td")).toHaveCount(3);
    await blockBar.getByRole("button", { name: "Insert column right" }).click();
    await expect(editor.locator("table tr").first().locator("th, td")).toHaveCount(4);
    await expect(blockBar.getByRole("button", { name: "Merge cells" })).toBeDisabled();
    await blockBar.getByRole("button", { name: "Delete table" }).click();
    await expect(editor.locator("table")).toHaveCount(0);

    await select("other dogs.", true);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/Callout");
    await expect(page.locator(".slash-command-popup")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Careful now");
    await blockBar.getByRole("button", { name: "Red callout" }).click();
    await expect(editor.locator('[data-type="callout"]')).toHaveAttribute("data-variant", "danger");

    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/Page");
    await expect(page.locator(".slash-command-popup")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor.locator(".doc-page-break")).toHaveCount(1);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The server's web-page export has all of it.
    await expect(async () => {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download document" }).click();
      await page.getByRole("menuitem", { name: "Web page (.html)" }).click();
      const text = Buffer.concat((await (await (await download).createReadStream()).toArray()) as Buffer[]).toString("utf-8");
      expect(text).toContain('style="text-align:center"');
      expect(text).toContain("font-size:18pt");
      expect(text).toContain("The dogs sat on the mat with other dogs.");
      expect(text).toContain('data-variant="danger"');
      expect(text).toContain('class="doc-page-break"');
    }).toPass({ timeout: 40_000 });
  });

  test("comments are anchored in the text, threaded, resolved and live", async ({ alice: page }) => {
    // WP-4.5 (R-227): Drive documents had no comments at all.
    const name = `E2E comments ${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/doc\//, { timeout: 30_000 });
    const docUrl = page.url();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Document title").first().fill(name);
    await editor.click();
    await page.keyboard.type("We launch on the first of March, budget permitting.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // A second tab on the same document, to see changes arrive live.
    const other = await page.context().newPage();
    await other.goto(docUrl);
    const otherEditor = other.locator('.ProseMirror[contenteditable="true"]');
    await expect(otherEditor).toContainText("first of March", { timeout: 20_000 });

    // Select "first of March" through the editor and comment from the bubble.
    await editor.evaluate((el) => {
      type PM = { isText: boolean; text?: string };
      const ed = (el as unknown as { editor: {
        state: { doc: { descendants: (f: (n: PM, pos: number) => void) => void } };
        chain: () => { focus: () => { setTextSelection: (r: { from: number; to: number }) => { run: () => void } } };
      } }).editor;
      let at = -1;
      ed.state.doc.descendants((n, pos) => {
        if (at < 0 && n.isText && n.text?.includes("first of March")) at = pos + n.text.indexOf("first of March");
      });
      ed.chain().focus().setTextSelection({ from: at, to: at + "first of March".length }).run();
    });
    await page.getByRole("toolbar", { name: "Selection formatting" }).getByRole("button", { name: "Comment" }).click();
    const panel = page.getByRole("complementary", { name: "Comments" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("first of March"); // the quoted text
    await panel.getByRole("textbox", { name: /Add a comment/ }).fill("Is March realistic?");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = panel.getByRole("article", { name: /Comment by/ });
    await expect(thread).toContainText("Is March realistic?");
    // The words are highlighted in the text.
    await expect(editor.locator(".doc-comment")).toHaveText("first of March");
    await expect(page.getByRole("button", { name: "Comments (1 open)" })).toBeVisible();

    // The other tab hears about it without a reload.
    await expect(otherEditor.locator(".doc-comment")).toHaveText("first of March", { timeout: 15_000 });

    // Reply, then resolve: the highlight goes; reopening brings it back.
    await thread.getByRole("button", { name: "Reply" }).click();
    await thread.getByRole("textbox", { name: "Reply…" }).fill("Yes, if design lands by February.");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread).toContainText("Yes, if design lands by February.");
    await thread.getByRole("button", { name: "Resolve" }).click();
    await expect(editor.locator(".doc-comment")).toHaveCount(0);
    await panel.getByRole("button", { name: /Resolved \(1\)/ }).click();
    await panel.getByRole("button", { name: "Reopen" }).click();
    await expect(editor.locator(".doc-comment")).toHaveText("first of March");

    // Edits before the anchor don't move the highlight off its words.
    await other.close();
    // Focus the text first: after the panel's buttons, a keypress under load
    // could land before the editor had focus back.
    await editor.click();
    await editor.press("ControlOrMeta+Home");
    await expect
      .poll(
        () =>
          editor.evaluate((el) => (el as unknown as { editor: { state: { selection: { from: number } } } }).editor.state.selection.from),
        { timeout: 15_000 }
      )
      .toBe(1);
    await page.keyboard.type("Plan: ");
    await expect(editor.locator(".doc-comment")).toHaveText("first of March");

    // It's all still there after a reload.
    await page.reload();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator(".doc-comment")).toHaveText("first of March", { timeout: 15_000 });
    await page.getByRole("button", { name: "Comments (1 open)" }).click();
    await expect(page.getByRole("complementary", { name: "Comments" })).toContainText("Yes, if design lands by February.");
  });

  test("a picture is stored as a path and shown through a short-lived link", async ({ alice: page }) => {
    // WP-4.6 (R-228): documents used to bake a permanent signature into
    // every image URL.
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/doc\//, { timeout: 30_000 });
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Document title").first().fill(`E2E picture ${stamp}`);
    await editor.click();
    await page.keyboard.type("Logo below.");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Insert image" }).click();
    await (await chooser).setFiles(png("e2e-photo.png"));
    const img = editor.locator("img");
    await expect(img).toHaveCount(1, { timeout: 20_000 });
    // Displayed through a signed, expiring link…
    await expect(img).toHaveAttribute("src", /\/assets\/[0-9a-f-]{36}\?exp=\d+&sig=/);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // …while the document itself holds only the path.
    const stored = await editor.evaluate((el) => {
      const ed = (el as unknown as { editor: { getHTML: () => string } }).editor;
      return ed.getHTML();
    });
    expect(stored).toMatch(/src="\/api\/documents\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}"/);
    expect(stored).not.toContain("sig=");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // After a reload it still shows.
    await page.reload();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("on a phone the toolbar is one row and blocks can be moved", async ({ alice: page }) => {
    // WP-4.6 (R-231): the toolbar wrapped to ~3 rows; drag was mouse-only.
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/doc\//, { timeout: 30_000 });
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.click();
    await page.keyboard.type("First line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line");
    const toolbar = page.getByRole("toolbar", { name: "Document formatting" });
    const box = await toolbar.boundingBox();
    expect(box!.height).toBeLessThan(56);
    // The block bar offers move up / down; the second line moves above the first.
    const blockBar = page.getByRole("toolbar", { name: "Block options" });
    await blockBar.getByRole("button", { name: "Move block up" }).click();
    await expect(editor.locator("p").first()).toHaveText("Second line");
    await blockBar.getByRole("button", { name: "Move block down" }).click();
    await expect(editor.locator("p").first()).toHaveText("First line");
  });

  test("AI search of your files is opt-in, shows progress and can leave folders out", async ({ bob: page }) => {
    // WP-5.1: Ask your Drive. Bob has few files, so the real embedder isn't
    // flooded; it's turned off again at the end (which wipes the index).
    const folder = `E2E private ${stamp}`;
    await openDrive(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload files" }).click();
    await (await chooser).setFiles(pdf(`e2e-ai-${stamp}.pdf`, `Boiler service quote ${stamp}`));
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill(folder);
    await page.getByRole("dialog").getByRole("button", { name: /Create/ }).click();
    await expect(row(page, folder)).toBeVisible();

    await page.getByRole("button", { name: /^AI search/ }).click();
    const dialog = page.getByRole("dialog", { name: "AI search of your files" });
    const toggle = dialog.getByRole("switch", { name: "Search inside my files" });
    // Start from off (an interrupted earlier run may have left it on).
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText(/Indexing…|searchable/)).toBeVisible();
    await page.keyboard.press("Escape");

    // A folder can be left out from its menu, and shows in the list.
    const folderRow = row(page, folder);
    await folderRow.hover();
    await folderRow.getByRole("button", { name: "More actions" }).first().click();
    await page.getByRole("button", { name: "Leave out of AI search" }).click();
    await page.getByRole("button", { name: /^AI search/ }).click();
    await expect(dialog.getByText(folder)).toBeVisible();

    // Off again: nothing of Bob's stays indexed.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("a chat citation opens the PDF at its page, the sheet at its row, the document at the passage", async ({
    alice: page,
  }) => {
    // WP-5.2: the links search_my_files puts under a reply.
    const auth = await bearer(page);
    const up = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: {
        scope: "mine",
        file: {
          name: `e2e-lease-${stamp}.pdf`,
          mimeType: "application/pdf",
          buffer: fs.readFileSync(pdf(`e2e-lease-${stamp}.pdf`, ["Tenancy terms", "Rent and deposit", "Break clause"])),
        },
      },
    });
    expect(up.ok()).toBeTruthy();
    const pdfId = (await up.json()).id as string;
    await page.goto(`/files/f/${pdfId}?page=3`);
    const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
    await expect(preview.getByText("Page 3 of 3")).toBeVisible({ timeout: 20_000 });
    const target = preview.locator('.pdfViewer .page[data-page-number="3"][data-target]');
    await expect(target).toBeInViewport();
    await expect(target.locator("canvas")).toBeVisible();

    // A sheet, at Q2 row 12.
    const sh = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "sheet", title: `E2E cite ${stamp}` },
    });
    const sheetId = (await sh.json()).id as string;
    const save = await page.request.put(`/api/files/${sheetId}/sheet`, {
      headers: { Authorization: auth },
      data: {
        data: [
          { name: "Q1", id: "q1", order: 0, celldata: [{ r: 0, c: 0, v: { v: "Rent", m: "Rent" } }] },
          { name: "Q2", id: "q2", order: 1, celldata: [{ r: 11, c: 0, v: { v: "Gym", m: "Gym" } }, { r: 11, c: 1, v: { v: 45, m: "45" } }] },
        ],
        content_text: "Rent Gym 45",
      },
    });
    expect(save.ok()).toBeTruthy();
    await page.goto(`/files/f/${sheetId}?tab=Q2&row=12`);
    await expect(page).toHaveURL(new RegExp(`/files/sheet/${sheetId}\\?tab=Q2&row=12`), { timeout: 20_000 });
    await expect(page.locator(".fortune-name-box")).toContainText("A12", { timeout: 20_000 });

    // A document, with find open on the passage.
    const dc = await page.request.post("/api/files/office", {
      headers: { Authorization: auth },
      data: { kind: "document", title: `E2E cite doc ${stamp}` },
    });
    const docId = (await dc.json()).id as string;
    await page.goto(`/files/doc/${docId}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.type("Shopping list for the weekend.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("The spare key is under the blue flowerpot by the shed.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.goto(`/files/f/${docId}?q=${encodeURIComponent("The spare key is under the blue flowerpot")}`);
    const find = page.getByRole("search", { name: "Find in document" });
    await expect(find.getByRole("textbox").first()).toHaveValue("The spare key is under the blue flowerpot", {
      timeout: 20_000,
    });
    await expect(find.getByText("1 of 1")).toBeVisible();
  });
});

test.describe("organise with AI", () => {
  test("a chat proposes moving files into a new folder, and Apply does it", async ({ alice: page }) => {
    // WP-5.3: propose_file_changes → proposal card → Apply. The fake model
    // calls the tool when the message carries a [tool:…] marker.
    const auth = await bearer(page);
    const ids: string[] = [];
    for (const n of ["one", "two"]) {
      const up = await page.request.post("/api/files/", {
        headers: { Authorization: auth },
        multipart: {
          scope: "mine",
          file: { name: `e2e-loose-${n}-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from(`loose ${n}`) },
        },
      });
      expect(up.ok()).toBeTruthy();
      ids.push((await up.json()).id as string);
    }
    const folder = `E2E sorted ${stamp}`;
    const ops = ids.map((id) => ({ op: "move", item_type: "file", item_id: id, to: folder }));
    await page.goto("/chat");
    await ready(page);
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
    await page.getByPlaceholder(/^Message Promptly/).fill(`[tool:propose_file_changes ${JSON.stringify({ operations: ops })}] tidy up`);
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText("AI proposes: organise your files")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("· move 2 items, 1 new folder")).toBeVisible();
    await page.getByRole("button", { name: "Preview" }).click();
    const list = page.getByRole("list", { name: "Proposed file changes" });
    await expect(list.getByText(`e2e-loose-one-${stamp}.txt`)).toBeVisible();
    await expect(list.getByText("(new)").first()).toBeVisible();
    // Nothing has moved yet.
    let row = await (await page.request.get(`/api/files/${ids[0]}`, { headers: { Authorization: auth } })).json();
    expect(row.folder_id).toBeNull();

    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("Files organised").first()).toBeVisible();
    row = await (await page.request.get(`/api/files/${ids[0]}`, { headers: { Authorization: auth } })).json();
    expect(row.folder_id).not.toBeNull();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/files/folder/${row.folder_id}`));
    await expect(page.getByRole("button", { name: `e2e-loose-two-${stamp}`, exact: true })).toBeVisible();
  });
});

/** The signed-in page's bearer token, for seeding through the API. */
async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}

test("a folder downloads as a zip with its folders inside", async ({ alice: page }) => {
  // WP-7.6: made in the background, nested folders kept, downloaded by the
  // browser from a signed link.
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  const auth = (await seen).headers()["authorization"];
  const mk = async (name: string, parent?: string) =>
    (await (await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name, scope: "mine", parent_id: parent } })).json()).id as string;
  const box = await mk(`E2E zip ${stamp}`);
  const inner = await mk("Trip", await mk("Photos", box));
  for (const [folder, name] of [[box, "readme.txt"], [inner, "day1.txt"]] as const) {
    const r = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { scope: "mine", folder_id: folder, file: { name, mimeType: "text/plain", buffer: Buffer.from(`hello ${name}`) } },
    });
    expect(r.ok()).toBeTruthy();
  }
  await page.goto("/files");
  await ready(page);
  await showRow(page, `E2E zip ${stamp}`);
  await row(page, `E2E zip ${stamp}`).getByRole("button", { name: "More actions" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const d = await download;
  expect(d.url()).toMatch(/\/m\//);
  expect(d.suggestedFilename()).toBe(`E2E zip ${stamp}.zip`);
  // @ts-expect-error — the minified bundle ships without its own typings path.
  const JSZip = ((await import("../../frontend/node_modules/jszip/dist/jszip.min.js")) as {
    default: { loadAsync: (b: Buffer) => Promise<{ files: Record<string, unknown> }> };
  }).default;
  const zip = await JSZip.loadAsync(fs.readFileSync((await d.path())!));
  expect(Object.keys(zip.files)).toEqual(
    expect.arrayContaining([`E2E zip ${stamp}/readme.txt`, `E2E zip ${stamp}/Photos/Trip/day1.txt`])
  );
});
