import { expect, ready, stamp, test } from "../fixtures";

test.describe("commands", () => {
  test("make an Insert-text command and run it from chat", async ({ alice: page }) => {
    const name = `e2estandup${stamp}`;
    const body = `Standup notes ${stamp}`;

    await page.goto("/tasks");
    await ready(page);
    await page.getByRole("tab", { name: "Commands" }).click();
    await page.getByRole("button", { name: "New command" }).first().click();

    // Retitles itself ("New prompt") once "Insert text" is picked.
    const editor = page.getByRole("dialog");
    await editor.getByPlaceholder("Garage lights off", { exact: true }).fill(name);
    await editor.getByRole("button", { name: "Insert text" }).click();
    await editor.getByPlaceholder("Write my standup for today…").fill(body);
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);
    // An Insert-text command is a prompt: it's listed under Prompts.
    await page.getByRole("tab", { name: "Prompts" }).click();
    await expect(page.getByText(name)).toBeVisible();

    await page.goto("/chat");
    await ready(page);
    const composer = page.getByPlaceholder(/^Message Promptly/);
    await composer.fill(`/${name}`);
    const menu = page.getByRole("listbox", { name: "Insert a prompt or run a command" });
    await expect(menu.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue(body);

    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".promptly-message:not(.flex-row-reverse)").last()).toContainText(body);
  });
});
