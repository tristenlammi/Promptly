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
  await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(1500);
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
  await more.locator(":scope > summary").click();
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
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  await page.goto("/apps/install");
  const lead = page.getByTestId("install-this-device");
  await expect(lead.getByRole("heading", { name: "Install Promptly on this iPhone" })).toBeVisible();
  await expect(lead.getByText("Add to Home Screen")).toBeVisible();
  // Notifications say how to get alerts instead of hiding the option.
  await page.goto("/account/notifications");
  await expect(page.getByTestId("ios-push-note").first()).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});

/** After a skipped or half-done first-run setup: what's left is on Today for
 *  the admin (until closed) and always under Admin → Setup, each row read
 *  from the server and linking to where it's done. */
test("an admin finds what is left to set up, on Today and in Admin", async ({ dana: admin, alice }) => {
  test.setTimeout(120_000);
  await admin.goto("/admin?tab=setup");
  await ready(admin);
  const panel = admin.getByTestId("setup-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // The run's AI service is connected; nobody set up email or off-site backups.
  await expect(panel.getByTestId("setup-row-provider")).toHaveAttribute("data-status", "done");
  await expect(panel.getByTestId("setup-row-email")).toHaveAttribute("data-status", "todo");
  await expect(panel.getByTestId("setup-row-backups")).toHaveAttribute("data-status", "todo");
  await expect(panel.getByTestId("setup-row-people")).toHaveAttribute("data-status", "done");
  // An earlier run may have closed the reminder: bring it back.
  const again = panel.getByRole("button", { name: "Show it again" });
  if (await again.isVisible()) await again.click();
  await expect(again).toHaveCount(0);

  // One step opens by itself, with a pick for each job, and goes back.
  await panel.getByRole("link", { name: /Choose the models Promptly uses/ }).click();
  await expect(admin).toHaveURL(/\/setup\?step=models/);
  const step = admin.getByTestId("models-step");
  await expect(step).toBeVisible({ timeout: 20_000 });
  await expect(step.locator("#setup-model-chat option")).not.toHaveCount(1);
  await expect(step.getByLabel("Talk")).toBeVisible();
  await admin.getByRole("link", { name: "Back to the list" }).click();
  await expect(admin).toHaveURL(/\/admin\?tab=setup/);

  // Away from home: only what this server has, nothing invented.
  await admin.goto("/setup?step=outside");
  const outside = admin.getByTestId("outside-step");
  await expect(outside).toBeVisible({ timeout: 20_000 });
  await expect(outside.getByTestId("outside-home")).toBeVisible();
  await expect(outside.getByText("Don't forward the web port")).toBeVisible();
  await expect(outside.getByLabel("Web address")).toBeVisible();

  // Today: the card, its link, and closing it for good.
  await admin.goto("/today");
  const card = admin.getByTestId("today-setup-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("heading", { name: "Finish setting up Promptly" })).toBeVisible();
  await expect(card.getByRole("link", { name: /See/ })).toHaveAttribute("href", "/admin?tab=setup");
  await card.getByRole("button", { name: /Hide this/ }).click();
  await expect(card).toHaveCount(0);
  await admin.reload();
  await ready(admin);
  await admin.waitForTimeout(1500);
  await expect(admin.getByTestId("today-setup-card")).toHaveCount(0);
  // The list itself is still in Admin; leave the reminder as it was found.
  await admin.goto("/admin?tab=setup");
  await admin.getByTestId("setup-panel").getByRole("button", { name: "Show it again" }).click();
  await expect(admin.getByTestId("setup-panel").getByRole("button", { name: "Show it again" })).toHaveCount(0);

  // Someone who isn't the admin never sees any of it.
  await alice.goto("/today");
  await ready(alice);
  await alice.waitForTimeout(1500);
  await expect(alice.getByTestId("today-setup-card")).toHaveCount(0);
  await alice.goto("/setup?step=models");
  await expect(alice).toHaveURL(/\/chat/);
});

/** The built-in Promptly model before an admin has chosen the model behind
 *  it: listed as not ready, and a message to it gets plain words, not an
 *  error. Only on a server where that's still the case (a fresh one). */
test("Promptly says so while it has no model behind it", async ({ dana: admin, alice: member }) => {
  test.setTimeout(120_000);
  await admin.goto("/chat");
  await ready(admin);
  await admin.locator('button[aria-haspopup="listbox"]').first().click();
  await expect(admin.locator('[role="option"]').first()).toBeVisible();
  const row = admin.locator('[role="option"][data-needs-setup="true"]');
  test.skip((await row.count()) === 0, "Promptly already has a model behind it on this server");
  await expect(row).toContainText("Promptly");
  await expect(row).toContainText("Not ready: choose the model behind it");
  // It is never what a chat starts on by itself.
  await expect(row).toHaveAttribute("aria-selected", "false");

  // A chat that is on it anyway (made the way the app makes one) answers
  // a message with plain words and, for an admin, the way to fix it.
  const token = (await (await admin.request.post("/api/auth/refresh")).json()).access_token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const models = (await (await admin.request.get("/api/models/available", { headers: auth })).json()) as {
    provider_id: string;
    model_id: string;
    needs_setup?: boolean;
  }[];
  const promptly = models.find((m) => m.needs_setup)!;
  const made = await admin.request.post("/api/chat/conversations", {
    headers: auth,
    data: { provider_id: promptly.provider_id, model_id: promptly.model_id },
  });
  expect(made.ok()).toBeTruthy();
  await admin.goto(`/chat/${(await made.json()).id}`);
  await ready(admin);
  await admin.getByPlaceholder(/^Message Promptly/).fill("Hello?");
  await admin.getByRole("button", { name: "Send message" }).click();
  const card = admin.getByTestId("model-not-ready");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Promptly doesn't have a model behind it yet");
  await expect(admin.getByText(/custom:|Unknown or disabled/)).toHaveCount(0);

  // A member sees the same row and gets the same plain words, with who to
  // ask instead of a way to fix it.
  await member.goto("/chat");
  await ready(member);
  await member.locator('button[aria-haspopup="listbox"]').first().click();
  const theirs = member.locator('[role="option"][data-needs-setup="true"]');
  await expect(theirs).toContainText("Promptly");
  await member.keyboard.press("Escape");
  const memberAuth = { Authorization: `Bearer ${(await (await member.request.post("/api/auth/refresh")).json()).access_token as string}` };
  const forMember = await member.request.post("/api/chat/conversations", {
    headers: memberAuth,
    data: { provider_id: promptly.provider_id, model_id: promptly.model_id },
  });
  expect(forMember.ok()).toBeTruthy();
  await member.goto(`/chat/${(await forMember.json()).id}`);
  await ready(member);
  await member.getByPlaceholder(/^Message Promptly/).fill("Hello?");
  await member.getByRole("button", { name: "Send message" }).click();
  const memberCard = member.getByTestId("model-not-ready");
  await expect(memberCard).toBeVisible({ timeout: 20_000 });
  await expect(memberCard).toContainText("Ask the person who runs this server");
  await expect(memberCard.getByRole("link", { name: "Choose its model" })).toHaveCount(0);
  await expect(member.getByText(/custom:|Unknown or disabled/)).toHaveCount(0);

  // The card's button, like the row in the list, goes to choosing its model.
  await card.getByRole("link", { name: "Choose its model" }).click();
  await expect(admin).toHaveURL(/\/setup\?step=models/);
  await expect(admin.getByLabel("The model behind Promptly")).toBeVisible({ timeout: 20_000 });
  await admin.goto("/admin?tab=setup");
  await expect(admin.getByTestId("setup-row-models")).toHaveAttribute("data-status", "todo", { timeout: 20_000 });
  await expect(admin.getByTestId("setup-row-models")).toContainText("doesn't have a model behind it yet");
});

/** Giving a new person only certain models: Promptly is first in the list and
 *  ticked to begin with, and the admin can untick it like any other. */
test("a new person's model list starts with Promptly ticked, and it can be unticked", async ({ dana: admin }) => {
  await admin.goto("/admin?tab=users");
  await ready(admin);
  await admin.getByRole("button", { name: "Create user" }).first().click();
  const form = admin.getByRole("dialog");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: /^Custom/ }).click();
  const promptly = form.getByTestId("user-model-builtin");
  await expect(promptly).toBeVisible({ timeout: 20_000 });
  await expect(promptly).toBeChecked();
  // First in the list, by its own name.
  const boxes = form.locator('[data-testid^="user-model"]');
  await expect(boxes.first()).toHaveAttribute("data-testid", "user-model-builtin");
  await expect(form.locator("label", { has: admin.getByTestId("user-model-builtin") })).toContainText("Promptly");
  // Nothing else is ticked for them.
  await expect(form.locator('[data-testid^="user-model"]:checked')).toHaveCount(1);
  await promptly.uncheck();
  await expect(promptly).not.toBeChecked();
  await expect(form.locator('[data-testid^="user-model"]:checked')).toHaveCount(0);
});
