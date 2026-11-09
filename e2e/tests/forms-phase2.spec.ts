import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { BASE_URL } from "../lib/stack";

/** Forms phase 2 (WP-F2.1 to F2.4): a multiple-choice grid built in the
 *  builder and answered on a phone with no sideways scroll; a Location
 *  question answered by someone without an account; a quiz marked on
 *  sending, a paragraph marked by hand and the scores released. Each
 *  answer page is scanned with axe in light and dark. */

const PHONE = { width: 375, height: 812 };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type Item = Record<string, unknown>;
const opt = (id: string, label: string) => ({ id, label, go_to: null, limit: null, image_asset_id: null });
const q = (id: string, kind: string, title: string, config: Record<string, unknown>, required = false, extra: Item = {}): Item => ({
  id, kind, title, description: "", image_asset_id: null, required, config, deleted: false, ...extra,
});

async function makeForm(page: Page, auth: string, title: string, items: Item[], settings: Record<string, unknown>): Promise<{ fileId: string; token: string }> {
  const headers = { Authorization: auth };
  const made = await page.request.post("/api/forms", { headers, data: {} });
  expect(made.ok()).toBe(true);
  const fileId = (await made.json()).file.id as string;
  const definition = {
    version: 1, title, description: "", after: "continue", items,
    theme: { accent: "terracotta", header_asset_id: null, header_builtin: null, font: "default" },
  };
  const saved = await page.request.put(`/api/forms/${fileId}/definition`, { headers, data: { definition, data_version: 1 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const set = await page.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: true, ...settings } });
  expect(set.ok(), await set.text()).toBe(true);
  const link = await page.request.post(`/api/forms/${fileId}/link`, { headers, data: {} });
  expect(link.ok()).toBe(true);
  return { fileId, token: (await link.json()).link.token as string };
}

async function stranger(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/version.json*", (r) => r.abort());
  return { context, page: await context.newPage() };
}

async function scan(page: Page, what: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function scanBoth(page: Page, what: string): Promise<string[]> {
  const found = await scan(page, `${what}, light`);
  await page.emulateMedia({ colorScheme: "dark" });
  found.push(...(await scan(page, `${what}, dark`)));
  await page.emulateMedia({ colorScheme: "light" });
  return found;
}

async function noSidewaysScroll(page: Page) {
  const wide = await page.evaluate(() => {
    const box = document.getElementById("form-answer-scroll");
    return {
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      box: box ? box.scrollWidth - box.clientWidth : 0,
    };
  });
  expect(wide.doc).toBeLessThanOrEqual(0);
  expect(wide.box).toBeLessThanOrEqual(0);
}

async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 15_000 });
}

function openCard(page: Page): Locator {
  return page.locator("[data-item]").filter({ has: page.getByRole("textbox", { name: "Question", exact: true }) });
}

// ---------------------------------------------------------------- WP-F2.1

test("a 5×4 grid is built, previewed and answered on a phone with no sideways scroll", async ({ alice, browser }) => {
  test.setTimeout(180_000);
  const auth = await bearer(alice);
  const made = await alice.request.post("/api/forms", { headers: { Authorization: auth }, data: { title: `Helpers ${stamp}` } });
  const fileId = (await made.json()).file.id as string;
  await alice.goto(`/files/form/${fileId}`);
  await ready(alice);

  await alice.getByRole("toolbar", { name: "Add to the form" }).getByRole("button", { name: "Add question" }).click();
  const card = openCard(alice);
  await card.getByRole("textbox", { name: "Question", exact: true }).fill("Which shift can you do?");
  await card.getByRole("combobox", { name: "Question type" }).selectOption("choice_grid");
  await card.getByRole("textbox", { name: "Row 1" }).fill("Mon");
  for (const [n, day] of [[2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"]] as const) {
    await alice.keyboard.press("Enter");
    await expect(card.getByRole("textbox", { name: `Row ${n}` })).toBeFocused();
    await alice.keyboard.type(day);
  }
  await card.getByRole("textbox", { name: "Column 1" }).fill("Early");
  for (const [n, col] of [[2, "Mid"], [3, "Late"], [4, "Night"]] as const) {
    await alice.keyboard.press("Enter");
    await expect(card.getByRole("textbox", { name: `Column ${n}` })).toBeFocused();
    await alice.keyboard.type(col);
  }
  await card.getByRole("switch", { name: "Require an answer in each row" }).click();
  // One per column with more rows than columns can't be answered: said so.
  await card.getByRole("switch", { name: "Only one answer per column" }).click();
  await expect(card.getByRole("alert")).toContainText("at least as many columns as rows");
  await card.getByRole("switch", { name: "Only one answer per column" }).click();
  await saved(alice);

  const def = (await (await alice.request.get(`/api/forms/${fileId}`, { headers: { Authorization: auth } })).json()).form.definition;
  const g = def.items.find((i: { kind: string }) => i.kind === "choice_grid");
  expect(g.config.rows.map((r: { label: string }) => r.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  expect(g.config.columns.map((c: { label: string }) => c.label)).toEqual(["Early", "Mid", "Late", "Night"]);
  expect(g.config.each_row).toBe(true);

  // The preview shows it and checks "each row".
  const preview = alice.getByRole("complementary", { name: "Preview" });
  await expect(preview.getByText("Which shift can you do?")).toBeVisible();
  await preview.getByRole("radio", { name: /Mon.*Early|^Early$/ }).first().check();
  await preview.getByRole("button", { name: "Submit" }).click();
  await expect(preview.getByText("Answer every row.")).toBeVisible();

  // Answering it on a phone, without an account.
  await alice.request.patch(`/api/forms/${fileId}/settings`, { headers: { Authorization: auth }, data: { audience: "link", accepting: true } });
  const link = await alice.request.post(`/api/forms/${fileId}/link`, { headers: { Authorization: auth }, data: {} });
  const token = (await link.json()).link.token as string;
  const { context, page } = await stranger(browser);
  await page.goto(`/f/${token}`);
  await expect(page.getByText("Which shift can you do?")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-grid="rows"]')).toBeVisible();
  await noSidewaysScroll(page);
  const found = await scanBoth(page, "answer page with a grid (phone)");
  const chip = page.getByRole("group", { name: "Mon" }).locator("label").filter({ hasText: "Early" });
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("group", { name: "Mon" }).getByRole("radio", { name: "Early" }).check();
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Answer every row.")).toBeVisible();
  for (const [day, col] of [["Tue", "Mid"], ["Wed", "Late"], ["Thu", "Night"], ["Fri", "Early"]]) {
    await page.getByRole("group", { name: day }).getByRole("radio", { name: col }).check();
  }
  await noSidewaysScroll(page);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });
  await context.close();

  // On a wide screen the grid is a real table.
  await alice.goto(`/f/${token}`);
  await expect(alice.locator('[data-grid="table"]')).toBeVisible({ timeout: 20_000 });
  await expect(alice.getByRole("columnheader", { name: "Night" })).toBeVisible();
  await expect(alice.getByRole("rowheader", { name: "Thu" })).toBeVisible();
  found.push(...(await scanBoth(alice, "answer page with a grid (table)")));
  expect(found).toEqual([]);

  // The summary counts per row.
  const s = await (await alice.request.get(`/api/forms/${fileId}/summary`, { headers: { Authorization: auth } })).json();
  const row = s.questions[0].rows.find((r: { label: string }) => r.label === "Thu");
  const night = s.questions[0].columns.find((c: { label: string }) => c.label === "Night").id;
  expect(row.counts[night]).toBe(1);
  await alice.goto(`/files/form/${fileId}?tab=responses`);
  await expect(alice.getByRole("table", { name: /answers per row and column/ })).toBeAttached({ timeout: 20_000 });
});
