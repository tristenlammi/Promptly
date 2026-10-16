import { expect, ready, test } from "../fixtures";

test.describe("account", () => {
  test("the account page has its own address, and a section link opens at that section", async ({ alice: page }) => {
    // V25: it lived at /account/security while showing Profile.
    await page.goto("/chat");
    await ready(page);
    await page.locator("aside").getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Account" }).click();
    await expect(page).toHaveURL(/\/account$/);

    await page.goto("/account/security");
    await ready(page);
    await expect(page.locator("#section-security")).toBeInViewport();
  });

  test("the sidebar footer is one account menu", async ({ alice: page }) => {
    // V6: seven footer rows took about a third of the sidebar.
    await page.goto("/chat");
    await ready(page);
    const aside = page.locator("aside");
    const menuButton = aside.getByRole("button", { name: "Account menu" });
    await expect(aside.getByRole("button", { name: "Open notification inbox" })).toBeVisible();
    await expect(aside.getByRole("button", { name: "Log out" })).toHaveCount(0);

    await menuButton.click();
    const menu = page.getByRole("menu", { name: "Account" });
    for (const item of ["Account", "Archived chats", "Send feedback", "Log out"]) {
      await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
    }
    await expect(menu.getByRole("tablist", { name: "Colour theme" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuButton).toBeFocused();
  });
});
