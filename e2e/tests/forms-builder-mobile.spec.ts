import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, stamp, test } from "../fixtures";

/** Forms WP-F1.2 on a phone (375×812): the Forms home's + button and
 *  template sheet, building with the bottom add bar, the full-screen
 *  preview, and an accessibility scan. */

async function phone(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  const auth = (await seen).headers()["authorization"];
  await expect(page.getByRole("heading", { name: "Forms", exact: true })).toBeVisible({ timeout: 20_000 });
  return auth;
}

async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 15_000 });
}

async function scan(page: Page, what: string, include: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include(include)
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("a sign-up sheet made and previewed on a phone", async ({ alice: page }) => {
  test.setTimeout(150_000);
  await phone(page);
  const auth = await bearer(page);

  await page.getByRole("button", { name: "New form" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a new form" });
  await sheet.getByRole("button", { name: /^Sign-up sheet/ }).click();
  await page.waitForURL(/\/files\/form\//);
  const fileId = /\/files\/form\/([0-9a-f-]{36})/.exec(page.url())![1];

  // Rename, then change an option on the limited question from the card.
  await page.getByRole("textbox", { name: "Form title" }).fill(`Bring a dish ${stamp}`);
  await page.getByRole("button", { name: /^Edit question: What will you bring\?/ }).click();
  const card = page.locator("[data-item]").filter({ has: page.getByRole("textbox", { name: "Question", exact: true }) });
  await expect(card.getByRole("spinbutton", { name: "Places for option 4" })).toHaveValue("1");
  await card.getByRole("textbox", { name: "Option 4" }).fill("Cake");
  // The phone's add bar is along the bottom.
  const bar = page.getByRole("toolbar", { name: "Add to the form" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Add question" }).click();
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Any allergies?");
  await saved(page);
  const def = (await (await page.request.get(`/api/forms/${fileId}`, { headers: { Authorization: auth } })).json()).form.definition;
  expect(def.title).toBe(`Bring a dish ${stamp}`);
  expect(def.items.map((i: { title: string }) => i.title)).toContain("Any allergies?");

  // Full-screen preview: places left show, a full form submits.
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Preview" });
  await expect(preview.getByText("Preview — answers aren't saved")).toBeVisible();
  await expect(preview.locator("label").filter({ hasText: "Salad" })).toContainText("2 left");
  await expect(preview.getByRole("radio", { name: /Cake/ })).toBeVisible();
  // Tap targets are at least 44px tall.
  const box = await preview.locator("label").filter({ hasText: "Salad" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const found = await scan(page, "phone preview", "[role=dialog][aria-label='Preview']");
  await preview.getByLabel("Your name").fill("Mum");
  await preview.getByRole("radio", { name: /Salad/ }).check();
  await preview.getByRole("button", { name: "Submit" }).click();
  await expect(preview.getByText("Thanks for signing up!")).toBeVisible();
  await preview.getByRole("button", { name: "Close the preview" }).click();
  await expect(preview).toHaveCount(0);

  found.push(...(await scan(page, "phone builder", "main")));
  // The home lists it, as a row.
  await page.goto("/forms");
  await expect(page.getByRole("link", { name: new RegExp(`Bring a dish ${stamp}`) })).toBeVisible();
  found.push(...(await scan(page, "phone forms home", "main")));
  expect(found, found.join("\n")).toEqual([]);
});
