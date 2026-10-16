import { expect, ready, run, test } from "../fixtures";

test.describe("sign in", () => {
  test("a wrong password is refused, the right one lands in chat", async ({ browser }) => {
    // A clean context: no stored session, exactly like a new visitor.
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/chat");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email or username").fill(run.users.alice.username);
    await page.getByLabel("Password").fill(`${run.password}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Password").fill(run.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/chat/);
    await ready(page);

    // The session survives a reload (refresh cookie → new access token).
    await page.reload();
    await ready(page);
    await expect(page).toHaveURL(/\/chat/);
    await context.close();
  });

  test("forgot password asks for an email and answers the same way for any address", async ({ browser }) => {
    // R-191: there was no way back in without an admin.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Your email address").fill("nobody@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByText(/If that address has an account/)).toBeVisible();
    await context.close();
  });

  test("account security offers signing out of every device", async ({ alice: page }) => {
    await page.goto("/account/security");
    await expect(page.getByRole("button", { name: "Sign out of all devices" })).toBeVisible();
  });
});
