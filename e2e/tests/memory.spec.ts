import { readFileSync } from "node:fs";

import { expect, ready, stamp, test } from "../fixtures";

test.describe("memory", () => {
  test("export downloads your memories, and turning memory off keeps them listed", async ({ bob: page }) => {
    const fact = `Test fact ${stamp}`;
    await page.goto("/account/memory");
    await ready(page);

    // The seed turns memory off (no capture calls in other tests). Bob,
    // not alice: alice chats in parallel tests, and memory on changes them.
    const modes = page.getByRole("radiogroup", { name: "Memory mode" });
    await modes.getByRole("radio", { name: "Auto" }).click();

    const add = page.getByPlaceholder("Add something for Promptly to remember…");
    await add.fill(fact);
    await add.locator("xpath=ancestor::form").locator('button[type="submit"]').click();
    // The box clears once the server has saved it (the text in the box
    // itself would otherwise satisfy the visibility check).
    await expect(add).toHaveValue("");
    await expect(page.getByText(fact)).toBeVisible();

    // R-264: the download used to be a 401 error page, not the memories.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const file = await (await download).path();
    expect(readFileSync(file, "utf-8")).toContain(fact);

    // R-291: memory off used to hide everything already stored.
    await modes.getByRole("radio", { name: "Off" }).click();
    await expect(modes.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(fact)).toBeVisible();
    await expect(add).toHaveCount(0);
  });
});
