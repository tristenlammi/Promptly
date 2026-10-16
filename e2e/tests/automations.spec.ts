import { expect, ready, test } from "../fixtures";

test.describe("automations", () => {
  test("the Automations page opens on scheduled automations (V13)", async ({ bob: page }) => {
    await page.goto("/tasks");
    await ready(page);
    // It opened on Prompts (text snippets), which aren't automations.
    await expect(page.getByRole("tab", { name: /Scheduled/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /Prompts/ }).click();
    await page.reload();
    await ready(page);
    await expect(page.getByRole("tab", { name: /Prompts/ })).toHaveAttribute("aria-selected", "true");
    await page.goto("/tasks?tab=scheduled");
    await ready(page);
    await expect(page.getByRole("tab", { name: /Scheduled/ })).toHaveAttribute("aria-selected", "true");
  });

  test("a new automation lets you choose when it notifies (R-152)", async ({ bob: page }) => {
    await page.goto("/tasks");
    await ready(page);
    await page.getByRole("button", { name: /New automation/i }).first().click();
    await page.getByRole("button", { name: /Simple/ }).click();
    const notify = page.getByRole("combobox").filter({ has: page.getByRole("option", { name: /When it fails/ }) });
    await expect(notify).toHaveValue("failures");
  });
});
