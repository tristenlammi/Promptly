import { expect, ready, run, test } from "../fixtures";

test("a user given a password by an admin must choose their own first", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(run.users.carol.username);
  await page.getByLabel("Password").fill(run.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
  // Nothing else is reachable meanwhile.
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();

  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(run.password);
  await fields.nth(1).fill(`${run.password}-new`);
  if ((await fields.count()) > 2) await fields.nth(2).fill(`${run.password}-new`);
  await page.getByRole("button", { name: /change password|update password|save/i }).click();

  await ready(page);
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toHaveCount(0);
  await context.close();
});
