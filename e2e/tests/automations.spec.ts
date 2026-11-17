import { expect, ready, test } from "../fixtures";

test.describe("AI tasks", () => {
  test("the AI tasks page opens on AI tasks (V13)", async ({ bob: page }) => {
    await page.goto("/tasks");
    await ready(page);
    // It opened on Prompts (text snippets), which aren't things that run.
    await expect(page.getByRole("tab", { name: /AI tasks/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /Prompts/ }).click();
    await page.reload();
    await ready(page);
    await expect(page.getByRole("tab", { name: /Prompts/ })).toHaveAttribute("aria-selected", "true");
    await page.goto("/tasks?tab=scheduled");
    await ready(page);
    await expect(page.getByRole("tab", { name: /AI tasks/ })).toHaveAttribute("aria-selected", "true");
  });

  test("a new AI task is one form, and lets you choose when it notifies (R-152)", async ({ bob: page }) => {
    await page.goto("/tasks");
    await ready(page);
    // Straight to the form: no "simple or advanced?" first.
    await page.getByRole("button", { name: /New AI task/i }).first().click();
    await expect(page.getByRole("dialog", { name: /New AI task/ })).toBeVisible();
    const notify = page.getByRole("combobox").filter({ has: page.getByRole("option", { name: /When it fails/ }) });
    await expect(notify).toHaveValue("failures");
  });
});
