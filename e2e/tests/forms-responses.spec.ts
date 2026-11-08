import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Forms WP-F1.4: the owner's Responses tab. A few answers arrive (through
 *  the answer link), Today says how many are new, the summary shows the
 *  charts, Individual steps through answers and deletes one (its place on a
 *  limited option opens again), the Question view searches, both downloads
 *  work and stay formula-safe, the per-form notification choice sticks, it
 *  all fits a phone, and axe finds nothing serious. */

const PHONE = { width: 375, height: 812 };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

const opt = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, go_to: null, limit: null, image_asset_id: null, ...extra,
});
const q = (id: string, kind: string, title: string, config: Record<string, unknown>, required = false) => ({
  id, kind, title, description: "", image_asset_id: null, required, config, deleted: false,
});

/** The Responses panel only: the app's shell (sidebar, the accent Send
 *  button) has its own known contrast item, tracked separately. */
async function scan(page: Page, what: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).include("#form-panel-responses").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("the owner reads, steps through, deletes and downloads answers", async ({ alice }) => {
  test.setTimeout(240_000);
  const auth = await bearer(alice);
  const headers = { Authorization: auth };
  const title = `Potluck ${stamp}`;

  // A form, taking answers from anyone with the link.
  const made = await alice.request.post("/api/forms", { headers, data: {} });
  const fileId = (await made.json()).file.id as string;
  const definition = {
    version: 1, title, description: "", after: "continue",
    theme: { accent: "terracotta", header_asset_id: null, header_builtin: null, font: "default" },
    items: [
      q("dish", "multiple_choice", "What will you bring?", {
        options: [opt("salad", "Salad", { limit: 2 }), opt("cake", "Cake"), opt("bread", "Bread")],
        other: false, shuffle: false, branching: false,
      }, true),
      q("hungry", "linear_scale", "How hungry?", { min: 1, max: 5, min_label: "A bit", max_label: "Starving" }),
      q("notes", "paragraph", "Anything else?", { min_length: null, max_length: 5000 }),
    ],
  };
  expect((await alice.request.put(`/api/forms/${fileId}/definition`, { headers, data: { definition, data_version: 1 } })).ok()).toBe(true);
  expect((await alice.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: true, audience: "link" } })).ok()).toBe(true);
  const token = (await (await alice.request.post(`/api/forms/${fileId}/link`, { headers, data: {} })).json()).link.token as string;

  // Three answers through the link (the page's start token, then a pause:
  // the server refuses answers sent within 3 seconds of opening).
  const page = await (await alice.request.get(`/api/f/${token}`)).json();
  await alice.waitForTimeout(3300);
  const answers = [
    { dish: { option: "salad" }, hungry: 5, notes: "=HYPERLINK(\"http://evil.example\",\"click\")" },
    { dish: { option: "salad" }, hungry: 3, notes: "Bringing my cousin" },
    { dish: { option: "cake" }, hungry: 4 },
  ];
  for (const a of answers) {
    const r = await alice.request.post(`/api/f/${token}/submit`, {
      data: { answers: a, submit_id: crypto.randomUUID(), start_token: page.start_token },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }

  // Today says how many are new (never what they say).
  await alice.goto("/today");
  const card = alice.locator("section").filter({ has: alice.getByRole("heading", { name: "Forms", exact: true }) });
  await expect(card.getByText("3 new answers")).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(title)).toBeVisible();
  await expect(card.getByText("HYPERLINK")).toHaveCount(0);

  // The Responses tab: total, "new since you last looked", the summary.
  await card.getByRole("link", { name: new RegExp(title) }).click();
  await expect(alice).toHaveURL(new RegExp(`/files/form/${fileId}\\?tab=responses`));
  await expect(alice.getByRole("tab", { name: /Responses \(3\)/ })).toHaveAttribute("aria-selected", "true");
  await expect(alice.getByTestId("responses-total")).toHaveText("3 answers", { timeout: 20_000 });
  await expect(alice.getByText("3 new since you last looked")).toBeVisible();
  const summary = alice.getByTestId("responses-summary");
  await expect(summary.locator(".recharts-surface").first()).toBeVisible();
  await expect(summary.getByRole("heading", { name: "What will you bring?" })).toBeVisible();
  // Screen readers get the same numbers as a table; full options say so.
  await expect(summary.locator("table").first()).toContainText("Salad (2/2 (full))");
  await expect(summary.getByText("Average")).toBeVisible();
  // Text is shown as text: the formula is just words, not a link.
  await expect(summary.getByText("=HYPERLINK(\"http://evil.example\",\"click\")")).toBeVisible();
  await expect(summary.locator("a[href*='evil.example']")).toHaveCount(0);

  const found = await scan(alice, "responses summary, light");
  await alice.emulateMedia({ colorScheme: "dark" });
  found.push(...(await scan(alice, "responses summary, dark")));
  await alice.emulateMedia({ colorScheme: "light" });

  // Individual: newest first, step back, delete one.
  await alice.getByRole("button", { name: "Individual" }).click();
  await expect(alice.getByTestId("individual-position")).toHaveText("3 of 3");
  await alice.getByRole("button", { name: "Previous answer" }).click();
  await expect(alice.getByTestId("individual-position")).toHaveText("2 of 3");
  await expect(alice.getByText("Bringing my cousin")).toBeVisible();
  await expect(alice.getByText("Someone with the link")).toBeVisible();
  found.push(...(await scan(alice, "one answer")));
  await alice.getByRole("button", { name: "Delete this answer" }).click();
  await alice.getByRole("button", { name: "Delete answer" }).click();
  await expect(alice.getByText("Deleted answer #2")).toBeVisible();
  await expect(alice.getByTestId("responses-total")).toHaveText("2 answers", { timeout: 20_000 });
  await expect(alice.getByTestId("individual-position")).toHaveText("2 of 2");
  // The Salad place it held is free again.
  const remaining = (await (await alice.request.get(`/api/f/${token}`)).json()).remaining;
  expect(remaining.dish.salad).toBe(1);

  // Question: every answer to one question, searchable.
  await alice.getByRole("button", { name: "Question" }).click();
  await alice.getByLabel("Question").selectOption({ label: "Anything else? · 1 answer" });
  await expect(alice.getByTestId("question-answers").getByText(/HYPERLINK/)).toBeVisible();
  await alice.getByLabel("Search these answers").fill("cousin");
  await expect(alice.getByText("Nothing matches “cousin”.")).toBeVisible();

  // Downloads: Excel and CSV, formula-safe.
  await alice.getByRole("button", { name: "Download answers" }).click();
  let dl = alice.waitForEvent("download");
  await alice.getByRole("menuitem", { name: "Excel (.xlsx)" }).click();
  expect((await dl).suggestedFilename()).toBe(`${title} (Responses).xlsx`);
  await alice.getByRole("button", { name: "Download answers" }).click();
  dl = alice.waitForEvent("download");
  await alice.getByRole("menuitem", { name: "CSV (.csv)" }).click();
  const csvFile = await dl;
  expect(csvFile.suggestedFilename()).toBe(`${title} (Responses).csv`);
  const csv = Buffer.concat(await (await csvFile.createReadStream()).toArray()).toString("utf-8");
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).not.toMatch(/,=HYPERLINK/);

  // Notifications for this form: once a day, and it sticks.
  await alice.getByRole("button", { name: /Notifying|Notifications for this form/ }).click();
  await alice.getByRole("radio", { name: /Once a day/ }).check();
  await expect(alice.getByRole("button", { name: /Daily/ })).toBeVisible();
  await alice.keyboard.press("Escape");
  await alice.reload();
  await expect(alice.getByTestId("responses-total")).toHaveText("2 answers", { timeout: 20_000 });
  await alice.getByRole("button", { name: /Daily/ }).click();
  await expect(alice.getByRole("radio", { name: /Once a day/ })).toBeChecked();
  // Seen: nothing new now, and Today has nothing to say about it.
  await expect(alice.getByText(/new since you last looked/)).toHaveCount(0);
  await alice.keyboard.press("Escape");

  // A phone: the summary stacks, nothing scrolls sideways, Individual still steps.
  await alice.setViewportSize(PHONE);
  await alice.reload();
  await expect(alice.getByTestId("responses-total")).toHaveText("2 answers", { timeout: 20_000 });
  await expect(alice.getByTestId("responses-summary").locator(".recharts-surface").first()).toBeVisible();
  const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  found.push(...(await scan(alice, "responses on a phone")));
  await alice.getByRole("button", { name: "Individual" }).click();
  await expect(alice.getByTestId("individual-position")).toHaveText("2 of 2");
  await expect(alice.getByText("Swipe left or right for the next answer.")).toBeVisible();
  await alice.getByRole("button", { name: "Previous answer" }).click();
  await expect(alice.getByTestId("individual-position")).toHaveText("1 of 2");

  // Delete all, asked twice; then the empty state offers Send.
  await alice.getByRole("button", { name: "More answer actions" }).click();
  await alice.getByRole("menuitem", { name: "Delete all answers" }).click();
  await alice.getByRole("button", { name: "Continue" }).click();
  await alice.getByRole("button", { name: "Delete all answers" }).last().click();
  await expect(alice.getByText("No answers yet")).toBeVisible({ timeout: 20_000 });
  await expect(alice.getByRole("button", { name: "Send your form" })).toBeVisible();

  expect(found, found.join("\n")).toEqual([]);
});
