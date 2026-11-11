import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Admin privacy, part 2: an admin's change to someone's account is never
 *  silent (AP5). The statement of what an admin can and can't see (AP9)
 *  isn't put in front of people: it shows only at its own address. */

async function bearer(page: Page, path = "/"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(path);
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a password reset by the admin is shown to the person; the privacy statement stays out of the way", async ({
  dana: admin,
  browser,
}) => {
  test.setTimeout(120_000);
  const adminAuth = await bearer(admin);
  const username = `e2e_reset_${stamp}`;
  const first = `First-${stamp}-pass!42`;
  const made = await admin.request.post("/api/admin/users", {
    headers: { Authorization: adminAuth },
    data: { email: `${username}@example.com`, username, password: first, role: "user", must_change_password: false },
  });
  expect(made.ok(), await made.text()).toBe(true);

  // The admin resets it from Admin → Users. No email on this server, so
  // only the temporary password can be chosen.
  await admin.goto("/admin?tab=users");
  await admin.getByRole("searchbox", { name: "Search users" }).fill(username);
  await admin.getByRole("button", { name: `More actions for ${username}` }).click();
  await admin.getByRole("button", { name: /Reset password/ }).click();
  const dialog = admin.getByRole("dialog", { name: "Reset password" });
  await expect(dialog.getByRole("radio", { name: /Email them a reset link/ })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /Set a temporary password/ })).toBeChecked();
  const temp = `Temp-${stamp}-pass!42`;
  await dialog.getByRole("textbox", { name: /Temporary password/ }).fill(temp);
  await dialog.getByRole("textbox", { name: /Confirm password/ }).fill(temp);
  await dialog.getByRole("button", { name: "Reset password" }).click();
  await expect(dialog).toHaveCount(0);

  // They sign in with it: told who did it.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password").fill(temp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
  await expect(page.getByText(/Your administrator reset your password on/)).toBeVisible();
  await expect(page.getByText("What your server admin can and can't see")).toHaveCount(0);

  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(temp);
  await fields.nth(1).fill(`${temp}-new`);
  if ((await fields.count()) > 2) await fields.nth(2).fill(`${temp}-new`);
  await page.getByRole("button", { name: /change password|update password|save/i }).click();
  await ready(page);

  // A new member's Welcome dialog doesn't carry the statement.
  const welcome = page.getByTestId("welcome-dialog");
  await expect(welcome).toBeVisible();
  await expect(welcome.getByText(/server admin can and can't see/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(welcome).toHaveCount(0);

  // The banner, until they close it; and Recent activity marks the reset.
  const banner = page.getByRole("status").filter({ hasText: "Your administrator reset your password" });
  await expect(banner).toBeVisible();
  await banner.getByRole("link", { name: "See recent activity" }).click();
  await expect(page).toHaveURL(/\/account\/privacy/);
  const activity = page.locator("#recent-activity");
  await expect(activity.getByText("Password reset to a temporary one")).toBeVisible();
  await expect(activity.getByText(/By your administrator/).first()).toBeVisible();
  await expect(page.locator("#privacy-statement")).toHaveCount(0);
  await banner.getByRole("button", { name: "Close this notice" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(page.getByText(/Your administrator reset your password on/)).toHaveCount(0);

  // The statement is still there for anyone given its address.
  await page.goto("/account/privacy#privacy-statement");
  await ready(page);
  await expect(page.locator("#privacy-statement")).toContainText("Only Passwords is.");
  await context.close();
});
