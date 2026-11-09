import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Admin privacy, part 2: an admin's change to someone's account is never
 *  silent (AP5), and the app says once what an admin can and can't see
 *  (AP9). */

async function bearer(page: Page, path = "/"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(path);
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a password reset by the admin is shown to the person, with the privacy statement", async ({
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

  // They sign in with it: told who did it, and what an admin can see.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password").fill(temp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
  await expect(page.getByText(/Your administrator reset your password on/)).toBeVisible();
  await page.getByText("What your server admin can and can't see").click();
  await expect(page.getByText(/The app never shows them your chats, mail, files/)).toBeVisible();

  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(temp);
  await fields.nth(1).fill(`${temp}-new`);
  if ((await fields.count()) > 2) await fields.nth(2).fill(`${temp}-new`);
  await page.getByRole("button", { name: /change password|update password|save/i }).click();
  await ready(page);

  // A new member's Welcome dialog carries the same statement.
  const welcome = page.getByRole("dialog", { name: "Pick your apps" });
  await expect(welcome.getByText("What your server admin can and can't see")).toBeVisible();
  await welcome.getByRole("button", { name: "Not now" }).click();
  await expect(welcome).toHaveCount(0);

  // The banner, until they close it; and Recent activity marks the reset.
  const banner = page.getByRole("status").filter({ hasText: "Your administrator reset your password" });
  await expect(banner).toBeVisible();
  await banner.getByRole("link", { name: "See recent activity" }).click();
  await expect(page).toHaveURL(/\/account\/privacy/);
  const activity = page.locator("#recent-activity");
  await expect(activity.getByText("Password reset to a temporary one")).toBeVisible();
  await expect(activity.getByText(/By your administrator/).first()).toBeVisible();
  await expect(page.locator("#privacy-statement")).toContainText("Only Passwords is.");
  await banner.getByRole("button", { name: "Close this notice" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(page.getByText(/Your administrator reset your password on/)).toHaveCount(0);
  await context.close();
});
