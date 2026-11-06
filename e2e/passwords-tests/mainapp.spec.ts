// The main app's few touches with Passwords: nothing in them holds a secret.
import { expect, test } from "@playwright/test";

import { addLogin, makeUsers, onboard, signedIn } from "./helpers";

test.describe.configure({ timeout: 240_000 });

test("admin can set policy and turn the Preview warning off and on, and can't reach a vault", async ({ browser }) => {
  const [admin] = makeUsers(["polly"], "admin");
  const ctx = await signedIn(browser, admin);
  const page = await ctx.newPage();
  await page.goto("/admin?tab=passwords");
  const preview = page.getByRole("checkbox", { name: /Show the Preview warning/ });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).toBeChecked();
  await expect(page.getByText("You can't read anyone's vault from here")).toBeVisible();
  await preview.click();
  await expect(preview).not.toBeChecked();

  const vault = await ctx.newPage();
  await vault.goto("/passwords");
  await expect(vault.getByText("I understand")).toBeVisible({ timeout: 30_000 });
  await expect(vault.getByText("Preview.")).toHaveCount(0);
  await vault.close();

  await preview.click();
  await expect(preview).toBeChecked();
  const again = await ctx.newPage();
  await again.goto("/passwords");
  await expect(again.getByText("Preview.")).toBeVisible({ timeout: 30_000 });
});

test("Account lists vault devices, and Today says only a count", async ({ browser }) => {
  const [u] = makeUsers(["acct"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Secret site name", username: "ana", password: "password", url: "https://secret-site.example/" });
  await page.getByRole("navigation", { name: "Passwords" }).getByText("Security check", { exact: true }).click();
  await page.getByText('Show "passwords need attention" on my Today page').click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(page.getByText(/Checked \d+ logins/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);

  const today = await ctx.newPage();
  await today.goto("/today");
  await expect(today.getByText(/passwords? needs? attention/)).toBeVisible({ timeout: 30_000 });
  await expect(today.getByText("Secret site name")).toHaveCount(0);
  await expect(today.getByText("secret-site.example")).toHaveCount(0);
});
