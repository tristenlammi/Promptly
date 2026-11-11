import { expect, ready, stamp, test } from "../fixtures";

/** Send feedback goes to this server's admin and nowhere else: a person
 *  writes it from the account menu, the admin reads it under
 *  Admin → Feedback. Replies in chat have no thumbs any more. */

test("feedback from the account menu reaches the admin's Feedback list", async ({ alice: page, dana: admin }) => {
  test.setTimeout(90_000);
  const words = `The calendar is lovely ${stamp}`;

  await page.goto("/");
  await ready(page);
  await page.locator("aside").getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await expect(dialog.getByText("This goes to your server's admin.")).toBeVisible();
  // No outside address, no "include my email" box.
  await expect(dialog.locator('a[href^="mailto:"]')).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  const send = dialog.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Your message" }).fill(words);
  await send.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Sent to your admin. Thank you.")).toBeVisible();

  // The person who wrote it can't open the list.
  const denied = await page.request.get("/api/admin/feedback");
  expect([401, 403]).toContain(denied.status());

  await admin.goto("/admin?tab=feedback");
  await ready(admin);
  const row = admin.getByRole("list", { name: "Feedback" }).getByRole("listitem").filter({ hasText: words });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-read", "false");
  await expect(row.getByText("New", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Mark read" }).click();
  await expect(row).toHaveAttribute("data-read", "true");
  await expect(row.getByRole("button", { name: "Mark unread" })).toBeVisible();

  admin.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(admin.getByText(words)).toHaveCount(0);
});
