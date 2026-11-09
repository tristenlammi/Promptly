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

// ---------------------------------------------------------------- WP-F2.2

test("a Location question: typed on a phone without an account, and a signed-in person's own Home", async ({ alice, bob, browser }) => {
  test.setTimeout(180_000);
  const auth = await bearer(alice);
  const title = `Pick-up spots ${stamp}`;
  const { fileId, token } = await makeForm(alice, auth, title, [
    q("where", "location", "Where should we pick you up?", { ask: "address" }, true),
    q("suburb", "location", "Which suburb?", { ask: "town" }),
  ], { audience: "link" });

  // This e2e stack has no map data (no Photon): the place search says so
  // quietly and the question is a plain text box. Picking a suggestion
  // from Photon is covered by backend/tests/test_forms_location.py.
  const probe = await alice.request.get(`/api/f/${token}/places`, { params: { q: "Smith" } });
  expect(probe.ok()).toBe(true);
  expect(await probe.json()).toEqual({ results: [], maps: false });

  const { context, page } = await stranger(browser);
  const asked: string[] = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await page.goto(`/f/${token}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  const found = await scanBoth(page, "answer page with a Location question (phone)");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("This question needs an answer.")).toBeVisible();
  const box = page.getByRole("combobox", { name: "Where should we pick you up?" });
  const searched = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/f/${token}/places`, { timeout: 10_000 });
  await box.click();
  await box.pressSequentially("12 Smith St, Hobart", { delay: 20 });
  await searched;
  await page.getByRole("combobox", { name: "Which suburb?" }).fill("Sandy Bay");
  await expect(box).toHaveValue("12 Smith St, Hobart");
  await noSidewaysScroll(page);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });
  // Someone without an account only ever uses the form's own place search.
  expect(asked.filter((p) => p.startsWith("/api/maps") || p.startsWith("/api/people"))).toEqual([]);
  await context.close();
  expect(found).toEqual([]);

  // The owner sees the words (no spot: it was typed).
  const s = await (await alice.request.get(`/api/forms/${fileId}/summary`, { headers: { Authorization: auth } })).json();
  expect(s.questions[0].places).toEqual([{ number: 1, text: "12 Smith St, Hobart" }]);
  expect(s.questions[0].with_spot).toBe(0);
  await alice.goto(`/files/form/${fileId}?tab=responses`);
  await expect(alice.getByRole("button", { name: "12 Smith St, Hobart" })).toBeVisible({ timeout: 20_000 });

  // Signed in, your own saved Home is offered — your contacts never are.
  const bobAuth = await bearer(bob);
  const home = await bob.request.post("/api/maps/places", {
    headers: { Authorization: bobAuth },
    data: { kind: "home", name: "Home", address: "7 Wattle Rd, Lindisfarne", lat: -42.85, lon: 147.36 },
  });
  expect(home.ok(), await home.text()).toBe(true);
  const bobAsked: string[] = [];
  bob.on("request", (r) => bobAsked.push(new URL(r.url()).pathname));
  await bob.goto(`/f/${token}`);
  const bobBox = bob.getByRole("combobox", { name: "Where should we pick you up?" });
  await bobBox.click();
  await bobBox.pressSequentially("hom", { delay: 40 });
  const option = bob.getByRole("option", { name: /Home/ });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await expect(bob.getByText("(a place on the map)")).toBeAttached();
  await expect(bobBox).toHaveValue("7 Wattle Rd, Lindisfarne");
  expect(bobAsked.filter((p) => p.startsWith("/api/people"))).toEqual([]);
  expect(bobAsked.filter((p) => p === "/api/maps/search")).toEqual([]);
  await bob.getByRole("button", { name: "Submit" }).click();
  await expect(bob.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });
  const pl = await (await alice.request.get(`/api/forms/${fileId}/places`, { headers: { Authorization: auth } })).json();
  expect(pl.places).toEqual([{ number: 2, text: "7 Wattle Rd, Lindisfarne", lat: -42.85, lon: 147.36, question_id: "where" }]);
});

// ---------------------------------------------------------------- WP-F2.3 / F2.4

test("a quiz: answered on a phone, marked by hand, released, and seen from the saved link", async ({ alice, browser }) => {
  test.setTimeout(240_000);
  const auth = await bearer(alice);
  const title = `Trivia night ${stamp}`;
  const mc = q("cap", "multiple_choice", "Capital of Australia?", {
    options: [opt("syd", "Sydney"), opt("cbr", "Canberra"), opt("mel", "Melbourne")], other: false, shuffle: false, branching: false,
  }, true, { quiz: { points: 2, key: { options: ["cbr"] }, feedback_right: "Yes!", feedback_wrong: "It's Canberra." } });
  const sum = q("sum", "short_text", "What is 6 × 7?", {
    validation: { kind: "number", min: null, max: null, integer: false }, min_length: null, max_length: null,
  }, true, { quiz: { points: 1, key: { accept: ["42"] }, feedback_right: "", feedback_wrong: "" } });
  const why = q("why", "paragraph", "Why do leaves fall?", { min_length: null, max_length: 5000 }, false,
    { quiz: { points: 2, key: null, feedback_right: "", feedback_wrong: "" } });
  const { fileId, token } = await makeForm(alice, auth, title, [mc, sum, why], {
    audience: "link",
    quiz: { release: "later", show_score: true, show_right_wrong: true, show_answers: true, show_points: true },
  });

  // The builder shows it's a quiz, and each question's key.
  await alice.goto(`/files/form/${fileId}`);
  await expect(alice.getByTestId("quiz-badge")).toHaveText(/Quiz · 5 points/, { timeout: 20_000 });
  await expect(alice.getByText("2 points · key set").first()).toBeVisible();

  // Someone with the link, on a phone: no key ever reaches the page.
  const { context, page } = await stranger(browser);
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes(`/api/f/${token}`) && r.request().method() === "GET") bodies.push(await r.text().catch(() => ""));
  });
  await page.goto(`/f/${token}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  expect(bodies.join("")).not.toContain("Canberra.\"");
  expect(bodies.join("")).not.toContain("\"accept\":[\"42\"]");
  expect(bodies.join("")).not.toContain("\"quiz\":{\"points\"");
  const found = await scanBoth(page, "quiz answer page (phone)");
  await page.getByRole("radio", { name: "Canberra" }).check();
  await page.getByLabel("What is 6 × 7?").fill("42");
  await page.getByLabel("Why do leaves fall?").fill("Less sunlight in autumn.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByTestId("quiz-waiting")).toBeVisible({ timeout: 20_000 });
  const resultUrl = await page.getByLabel("Save this link to see your score later").inputValue();
  expect(resultUrl).toContain(`/f/${token}?result=`);
  found.push(...(await scanBoth(page, "quiz confirmation (phone)")));
  await context.close();

  // The owner marks the paragraph in one pass through "Next to mark", then releases.
  await alice.goto(`/files/form/${fileId}?tab=responses`);
  const strip = alice.getByTestId("scores-strip");
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await strip.getByRole("button", { name: "1 to mark" }).click();
  await expect(alice.getByTestId("answer-score")).toContainText("3 / 5");
  await alice.getByTestId("mark-why").getByRole("button", { name: "Right" }).click();
  await expect(alice.getByTestId("answer-score")).toContainText("5 / 5");
  await alice.getByRole("button", { name: "Next to mark" }).click();
  await expect(alice.getByText("Everything's marked.")).toBeVisible();
  await alice.getByRole("button", { name: "Summary" }).click();
  await alice.getByTestId("scores-strip").getByRole("button", { name: "Release scores" }).click();
  await expect(alice.getByText("Released 1 score.")).toBeVisible();
  await alice.getByRole("button", { name: "Scores", exact: true }).click();
  await expect(alice.getByTestId("scores-list")).toContainText("5 / 5");

  // Later, from the saved link: the score, ticks, right answers, feedback.
  const later = await stranger(browser);
  await later.page.goto(resultUrl);
  await expect(later.page.getByTestId("quiz-score")).toContainText("5 out of 5", { timeout: 20_000 });
  await expect(later.page.getByText("Yes!")).toBeVisible();
  await noSidewaysScroll(later.page);
  found.push(...(await scanBoth(later.page, "quiz result (phone)")));
  // A made-up link shows nothing of anyone's.
  await later.page.goto(`/f/${token}?result=1.not-a-real-key`);
  await expect(later.page.getByText("There's no score for you on this device.")).toBeVisible({ timeout: 20_000 });
  await later.context.close();
  expect(found).toEqual([]);
});
