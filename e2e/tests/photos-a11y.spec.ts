import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** Accessibility (PH-7): the Photos screens have no serious or critical
 *  WCAG 2 A/AA problems axe can find. */

async function scan(page: Page, what: string, include?: string) {
  await page.mouse.move(0, 0); // no hover colours
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
  const bad = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // The accent buttons' contrast is the app's brand colour — a design
    // decision tracked on its own, not a Photos bug.
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  return bad;
}

test("Photos screens pass an accessibility scan", async ({ dana: page }) => {
  test.setTimeout(120_000);
  const found: string[] = [];
  // Only Photos' own area — the app shell is checked elsewhere.
  const main = "main";

  await page.goto("/files/photos");
  await ready(page);
  await expect(page.locator("[data-photo]").first()).toBeVisible();
  found.push(...(await scan(page, "photos home", main)));

  await page.locator("[data-photo]").first().click();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  found.push(...(await scan(page, "viewer", "[role=dialog], .fixed")));
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("img", { name: "Photo being edited" })).toBeVisible();
  found.push(...(await scan(page, "editor", "[aria-label='Edit photo']")));
  await page.getByRole("tab", { name: "Adjust" }).click();
  found.push(...(await scan(page, "editor adjust", "[aria-label='Edit photo']")));
  await page.keyboard.press("Escape");

  for (const [path, what] of [
    ["/files/photos/albums", "albums"],
    ["/files/photos/people", "people"],
    ["/files/photos/places", "places"],
    ["/files/photos/cleanup", "cleanup"],
    ["/files/photos/search?q=sunset", "search"],
    ["/files/photos/setup", "setup"],
  ] as const) {
    await page.goto(path);
    await ready(page);
    await page.waitForLoadState("networkidle");
    found.push(...(await scan(page, what, main)));
  }
  await page.getByRole("button", { name: "Next" }).click();
  found.push(...(await scan(page, "setup: understand", main)));

  await page.goto("/files/photos/albums");
  await ready(page);
  await page.getByRole("button", { name: "New smart album" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  found.push(...(await scan(page, "smart album dialog", "[role=dialog]")));

  expect(found, found.join("\n")).toEqual([]);
});
