import { expect, ready, test } from "../fixtures";

test.describe("sidebar", () => {
  test("older chats load as you scroll, and folders show their own chats", async ({ alice: page }) => {
    await page.goto("/chat");
    await ready(page);

    // The seed's 70 old chats (plus every earlier run's chats) are more
    // than one page, so the oldest isn't there until you scroll to it.
    await expect(page.getByRole("button", { name: "Load older chats" })).toBeVisible();
    const oldest = page.getByRole("button", { name: "E2E archive-era chat 00", exact: true });
    await expect(oldest).toHaveCount(0);

    await expect(async () => {
      const more = page.getByRole("button", { name: "Load older chats" });
      if (await more.count()) await more.scrollIntoViewIfNeeded();
      await expect(oldest).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 45_000 }); // grows with every earlier run's chats

    // A folder whose only chat is old, far outside any page of recent chats.
    // Its count comes from the server, not from what happens to be loaded.
    const folder = page.getByRole("button", { name: /^E2E old folder 1$/ });
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folder.click();
    await expect(page.getByRole("button", { name: "E2E filed chat", exact: true })).toBeVisible();
  });
});
