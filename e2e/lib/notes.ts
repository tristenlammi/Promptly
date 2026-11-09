// Helpers for the Notes specs (notes*.spec.ts).
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect } from "../fixtures";

export async function notesReady(page: Page, path = "/notes"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/notes"));
  await page.goto(path);
  await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("searchbox", { name: "Search your notes" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Loading your notes…")).toHaveCount(0, { timeout: 20_000 });
  return (await seen).headers()["authorization"];
}

export async function serverNotes(page: Page, auth: string, view = "home"): Promise<{ id: string; title: string; kind: string; color: string; pinned: boolean; archived: boolean; snippet: string; items: { text: string; checked: boolean }[]; labels: { name: string }[]; items_checked: number }[]> {
  const r = await page.request.get(`/api/notes?view=${view}&limit=200`, { headers: { Authorization: auth } });
  expect(r.ok()).toBe(true);
  return (await r.json()).notes;
}

export const card = (page: Page, name: string): Locator => page.locator("article[data-note-card]").filter({ has: page.getByText(name, { exact: true }) });

export async function scan(page: Page, what: string, include?: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) b = b.include(include);
  const { violations } = await b.analyze();
  const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // The accent buttons' contrast is the app's brand colour, tracked on its own.
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

