import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** "Set up Photos" (PH-7): from the Photos home's banner through bringing
 *  photos in, understanding, who's who and pets, to a first question —
 *  after which the banner is gone. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("set up Photos walks through to a first question", async ({ dana: page }) => {
  const auth = { Authorization: await bearer(page) };
  await page.request.put("/api/photos/settings", { headers: auth, data: { setup_done: false } });

  await page.goto("/files/photos");
  await ready(page);
  const banner = page.getByRole("region", { name: "Set up Photos" });
  await banner.getByRole("link", { name: "Start" }).click();
  await expect(page.getByRole("heading", { name: "Bring your photos in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import", exact: true })).toHaveAttribute("href", "/files/import");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Let Promptly understand them" })).toBeVisible();
  const faces = page.getByRole("checkbox", { name: "Find faces" });
  if (!(await faces.isChecked())) {
    const saved = page.waitForResponse((r) => r.url().endsWith("/photos/settings") && r.request().method() === "PUT");
    await faces.check();
    expect((await (await saved).json()).faces).toBe(true);
  }

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Who's who" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Your pets" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Ask your photos" })).toBeVisible();
  await page.getByRole("button", { name: "sunset" }).click();
  await expect(page).toHaveURL(/\/files\/photos\/search\?q=sunset/);

  const settings = await (await page.request.get("/api/photos/settings", { headers: auth })).json();
  expect(settings.setup_done).toBe(true);
  await page.goto("/files/photos");
  await ready(page);
  await expect(page.locator("[data-photo]").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Set up Photos" })).toHaveCount(0);
});
