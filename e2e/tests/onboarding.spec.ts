import { expect, ready, run, stamp, test } from "../fixtures";

/** A new family member's first time: the admin's "Send them this" card, the
 *  sign-in page's words, choosing their own password (live rules, plain
 *  errors), the welcome, landing on Today, and a Rooms picker that lists
 *  the people already here. */

test("an admin adds someone, and their first sign-in is easy", async ({ dana: admin, browser }) => {
  test.setTimeout(180_000);
  const username = `e2e_new_${stamp}`;
  const temp = `Start-${stamp}-42!`;
  const mine = `Garden-${stamp}-77?`;

  // --- Admin → Users → Create user ---
  await admin.goto("/admin");
  await ready(admin);
  await admin.getByRole("button", { name: "Create user" }).first().click();
  const form = admin.getByRole("dialog");
  await expect(form.getByText("Make an account for someone in your family")).toBeVisible();
  await form.getByLabel("Email").fill(`${username}@example.com`);
  await form.getByLabel("Username").fill(username);
  const pw = form.getByLabel("Password", { exact: true });
  // The rules show, and an 8-character password no longer gets through.
  await pw.fill("short1!x");
  const rules = form.getByTestId("password-checklist");
  await expect(rules.locator('li[data-ok="false"]')).toHaveCount(1);
  await expect(form.getByRole("button", { name: "Create user" })).toBeDisabled();
  await pw.fill(temp);
  await expect(rules.locator('li[data-ok="true"]')).toHaveCount(3);
  await expect(form.getByText("Chat only")).toHaveCount(0);
  await form.getByRole("button", { name: "Create user" }).click();

  // --- The "Send them this" card ---
  const card = admin.getByTestId("new-member-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("new-member-username")).toHaveText(username);
  await expect(card.getByTestId("new-member-password")).toHaveText(temp);
  await expect(card.getByTestId("new-member-address")).toHaveText(new URL(admin.url()).origin);
  await expect(card.getByText("Add to Home Screen")).toBeVisible();
  await expect(card.getByRole("button", { name: "Copy" })).toBeVisible();
  await admin.getByRole("button", { name: "Done" }).click();
  await expect(card).toHaveCount(0);

  // --- Their first sign-in, on a phone ---
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByText("Your family's private space")).toBeVisible();
  await expect(page.getByText("Ask the person who set up Promptly for one.")).toBeVisible();
  await expect(page.getByText("admin panel")).toHaveCount(0);
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password").fill(temp);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Choose their own password: a live checklist, and the server's "too common" in plain words.
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
  await page.getByLabel("Current password").fill(temp);
  const next = page.getByLabel("New password", { exact: true });
  const checklist = page.getByTestId("password-checklist");
  await next.fill("abc");
  await expect(checklist.locator('li[data-ok="true"]')).toHaveCount(0);
  await next.fill("welcome123!");
  await expect(checklist.locator('li[data-ok="true"]')).toHaveCount(3);
  await page.getByLabel("Confirm new password").fill("welcome123!");
  await page.getByRole("button", { name: "Change password" }).click();
  const error = page.getByTestId("password-error");
  await expect(error).toHaveText("That password is too common. Choose something less guessable.");
  await expect(page.getByText(/Value error|new_password:/)).toHaveCount(0);

  await next.fill(mine);
  await expect(error).toHaveCount(0);
  await page.getByLabel("Confirm new password").fill(mine);
  await page.getByRole("button", { name: "Change password" }).click();

  // --- The welcome, on Today ---
  const welcome = page.getByTestId("welcome-dialog");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByText("Couldn't change your password")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
  await expect(welcome.getByText("Messages with your family")).toBeVisible();
  await expect(page.getByText(/Workspaces|Places/)).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(welcome).toHaveAttribute("data-step", "install");
  await expect(welcome.getByRole("button", { name: /Install apps|More help/ })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(welcome).toHaveAttribute("data-step", "hi");
  await expect(welcome.getByRole("button", { name: /^Message / })).toBeVisible();
  await page.getByRole("button", { name: "Start using Promptly" }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("today-install-nudge")).toBeVisible();

  // Answered once: signing in again goes to the usual place, no welcome.
  await page.goto("/chat");
  await ready(page);
  await expect(page.getByTestId("welcome-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat/);

  // --- Rooms: a new message lists the people already here ---
  await page.goto("/rooms/dm");
  await page.getByRole("button", { name: "New message" }).first().click();
  await expect(page.getByText("People on Promptly")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("option", { name: new RegExp(run.users.dana.username) })).toBeVisible();
  await ctx.close();
});

test("Install apps leads with one step for this device and folds the rest under More", async ({ alice }) => {
  await alice.goto("/apps/install");
  await ready(alice);
  const lead = alice.getByTestId("install-this-device");
  await expect(lead.getByRole("heading", { name: "Install Promptly on this computer" })).toBeVisible();
  await expect(lead.getByRole("button", { name: "Install Promptly" })).toBeVisible();
  const more = alice.getByTestId("install-more");
  await expect(more.getByText("Promptly Photos")).toBeHidden();
  await more.locator("summary").click();
  await expect(more.getByText("Promptly Photos")).toBeVisible();
  await expect(more.getByRole("heading", { name: /Android Auto/ })).toBeVisible();
});

test("on an iPhone in Safari, Install apps shows Add to Home Screen first", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(run.users.alice.username);
  await page.getByLabel("Password").fill(run.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await ready(page);
  await page.goto("/apps/install");
  const lead = page.getByTestId("install-this-device");
  await expect(lead.getByRole("heading", { name: "Install Promptly on this iPhone" })).toBeVisible();
  await expect(lead.getByText("Add to Home Screen")).toBeVisible();
  // Notifications say how to get alerts instead of hiding the option.
  await page.goto("/account/notifications");
  await expect(page.getByTestId("ios-push-note").first()).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});
