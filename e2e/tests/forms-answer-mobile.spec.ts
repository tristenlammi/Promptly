import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { BASE_URL } from "../lib/stack";

/** Forms WP-F1.3: answering on a phone (375×812). Someone without an
 *  account answers a branching link form — with a draft that survives a
 *  reload, sent while offline and delivered once (not twice) when back —
 *  then changes it with the saved link; a signed-in person answers a server
 *  form, is told they've already answered, and changes their answer; two
 *  people race for the last place on a sign-up sheet; and the owner's Send
 *  dialog makes, copies and resets the link. */

const PHONE = { width: 375, height: 812 };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type Item = Record<string, unknown>;
const opt = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, go_to: null, limit: null, image_asset_id: null, ...extra,
});
const q = (id: string, kind: string, title: string, config: Record<string, unknown>, required = false): Item => ({
  id, kind, title, description: "", image_asset_id: null, required, config, deleted: false,
});
const text = (id: string, title: string, required = false) =>
  q(id, "short_text", title, { validation: { kind: "any", min: null, max: null, integer: false }, min_length: null, max_length: null }, required);
const section = (id: string, title: string) => q(id, "section", title, { after: "continue" });

/** A form made through the API, taking answers, with its link. */
async function makeForm(
  page: Page,
  auth: string,
  title: string,
  items: Item[],
  settings: Record<string, unknown>
): Promise<{ fileId: string; token: string }> {
  const headers = { Authorization: auth };
  const made = await page.request.post("/api/forms", { headers, data: {} });
  expect(made.ok()).toBe(true);
  const fileId = (await made.json()).file.id as string;
  const definition = {
    version: 1, title, description: "", after: "continue", items,
    theme: { accent: "teal", header_asset_id: null, header_builtin: null, font: "default" },
  };
  const saved = await page.request.put(`/api/forms/${fileId}/definition`, { headers, data: { definition, data_version: 1 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const set = await page.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: true, ...settings } });
  expect(set.ok(), await set.text()).toBe(true);
  const link = await page.request.post(`/api/forms/${fileId}/link`, { headers, data: {} });
  expect(link.ok()).toBe(true);
  return { fileId, token: (await link.json()).link.token as string };
}

async function answerCount(page: Page, auth: string, fileId: string): Promise<number> {
  const r = await page.request.get(`/api/forms/${fileId}`, { headers: { Authorization: auth } });
  return (await r.json()).form.response_count as number;
}

/** A phone with nobody signed in. */
async function stranger(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/version.json*", (r) => r.abort());
  return { context, page: await context.newPage() };
}

async function scan(page: Page, what: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("someone without an account answers a branching form on a phone, offline and back", async ({ alice, browser }) => {
  test.setTimeout(180_000);
  const auth = await bearer(alice);
  const title = `Picnic feedback ${stamp}`;
  const { fileId, token } = await makeForm(alice, auth, title, [
    text("name", "Your name", true),
    q("enjoy", "multiple_choice", "Did you enjoy it?", {
      options: [opt("yes", "Yes", { go_to: "submit" }), opt("no", "No", { go_to: "s3" })],
      other: false, shuffle: false, branching: true,
    }, true),
    section("s2", "Great!"),
    text("best", "What was best?"),
    section("s3", "Tell us more"),
    q("better", "paragraph", "What could be better?", { min_length: null, max_length: 5000 }, true),
  ], { audience: "link", allow_edit: true, confirmation: "Thanks for the feedback!" });

  const { context, page } = await stranger(browser);
  await page.goto(`/f/${token}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Don't put passwords or bank details in a form.")).toBeVisible();
  const found = await scan(page, "answer page, light");
  await page.emulateMedia({ colorScheme: "dark" });
  found.push(...(await scan(page, "answer page, dark")));
  await page.emulateMedia({ colorScheme: "light" });

  // Required is checked before moving on, and said in words.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("This question needs an answer.").first()).toBeVisible();
  await page.getByLabel("Your name").fill("Uncle Bob");
  const choice = page.locator("label").filter({ hasText: /^No$/ });
  expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("radio", { name: "No" }).check();
  // "No" skips section 2.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Tell us more")).toBeVisible();
  await expect(page.getByText("Page 3 of 3")).toBeVisible();
  await page.getByLabel("What could be better?").fill("More shade");

  // The draft survives a reload.
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel("Your name")).toHaveValue("Uncle Bob");
  await expect(page.getByRole("radio", { name: "No" })).toBeChecked();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("What could be better?")).toHaveValue("More shade");

  // Offline: it waits, then sends once when the phone's back.
  await context.setOffline(true);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("You're offline. We'll send it when you're back.").first()).toBeVisible();
  expect(await answerCount(alice, auth, fileId)).toBe(0);
  await context.setOffline(false);
  await expect(page.getByText("Thanks for the feedback!")).toBeVisible({ timeout: 30_000 });
  expect(await answerCount(alice, auth, fileId)).toBe(1);

  // Change it later with the saved link.
  const editUrl = await page.getByLabel("Save this link to change your answer later").inputValue();
  expect(editUrl).toContain(`/f/${token}?edit=`);
  await page.goto(editUrl);
  await expect(page.getByText(/You're changing your answer/)).toBeVisible({ timeout: 20_000 });
  expect(page.url()).not.toContain("edit=");
  await expect(page.getByLabel("Your name")).toHaveValue("Uncle Bob");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("What could be better?").fill("More shade, and music");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Your changes are saved.")).toBeVisible({ timeout: 20_000 });
  expect(await answerCount(alice, auth, fileId)).toBe(1);

  // Report this form is on link forms.
  await page.getByRole("button", { name: "Report this form" }).click();
  await expect(page.getByLabel("What's wrong with this form?")).toBeVisible();
  await context.close();
  expect(found, found.join("\n")).toEqual([]);
});

test("a signed-in person answers a server form on a phone, then changes it", async ({ alice, bob }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const title = `BBQ RSVP ${stamp}`;
  const { fileId, token } = await makeForm(alice, auth, title, [
    q("coming", "multiple_choice", "Coming?", {
      options: [opt("yes", "Yes"), opt("maybe", "Maybe"), opt("no", "No")], other: false, shuffle: false, branching: false,
    }, true),
    text("bring", "Bringing anything?"),
  ], { audience: "server", one_per_person: true, allow_edit: true });

  await bob.setViewportSize(PHONE);
  await bob.goto(`/f/${token}`);
  await expect(bob.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  await expect(bob.getByText(/Answering as/)).toBeVisible();
  await expect(bob.getByRole("button", { name: "Not you?" })).toBeVisible();
  await bob.getByRole("radio", { name: "Maybe" }).check();
  await bob.getByRole("button", { name: "Submit" }).click();
  await expect(bob.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });

  // Back later: already answered, and can change it.
  await bob.goto(`/f/${token}`);
  await expect(bob.getByText("You've already answered this form.")).toBeVisible({ timeout: 20_000 });
  await bob.getByRole("button", { name: "Change your answer" }).click();
  await expect(bob.getByRole("radio", { name: "Maybe" })).toBeChecked();
  await bob.getByRole("radio", { name: "Yes" }).check();
  await bob.getByLabel("Bringing anything?").fill("Sausages");
  await bob.getByRole("button", { name: "Save changes" }).click();
  await expect(bob.getByText("Your changes are saved.")).toBeVisible({ timeout: 20_000 });
  expect(await answerCount(alice, auth, fileId)).toBe(1);
});

test("two people race for the last place on a sign-up sheet", async ({ alice, browser }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const title = `Dish race ${stamp}`;
  const { fileId, token } = await makeForm(alice, auth, title, [
    text("name", "Your name", true),
    q("dish", "multiple_choice", "What will you bring?", {
      options: [opt("cake", "Cake", { limit: 1 }), opt("salad", "Salad", { limit: 3 })], other: false, shuffle: false, branching: false,
    }, true),
  ], { audience: "link", show_remaining: true });

  const a = await stranger(browser);
  const b = await stranger(browser);
  for (const [p, name] of [[a.page, "Ann"], [b.page, "Ben"]] as const) {
    await p.goto(`/f/${token}`);
    await expect(p.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
    await expect(p.locator("label").filter({ hasText: "Cake" })).toContainText("1 left");
    await p.getByLabel("Your name").fill(name);
    await p.getByRole("radio", { name: /Cake/ }).check();
  }
  await a.page.waitForTimeout(3500);
  await Promise.all([
    a.page.getByRole("button", { name: "Submit" }).click(),
    b.page.getByRole("button", { name: "Submit" }).click(),
  ]);
  const sent = (p: Page) => p.getByText("Your answer has been sent.");
  const full = (p: Page) => p.getByText("“Cake” just filled up. Pick another option.").first();
  await expect
    .poll(async () => (await sent(a.page).count()) + (await sent(b.page).count()), { timeout: 30_000 })
    .toBe(1);
  const loser = (await sent(a.page).count()) ? b.page : a.page;
  await expect(full(loser)).toBeVisible();
  // The place is shown as taken; the loser picks another and gets in.
  await expect(loser.locator("label").filter({ hasText: "Cake" })).toContainText("full");
  await loser.getByRole("radio", { name: /Salad/ }).check();
  await loser.getByRole("button", { name: "Submit" }).click();
  await expect(sent(loser)).toBeVisible({ timeout: 20_000 });
  expect(await answerCount(alice, auth, fileId)).toBe(2);
  await a.context.close();
  await b.context.close();
});

test("Send: the link, its QR code, and resetting it", async ({ alice, browser }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const headers = { Authorization: auth };
  const made = await alice.request.post("/api/forms", { headers, data: { template: "rsvp", title: `Send test ${stamp}` } });
  const fileId = (await made.json()).file.id as string;
  await alice.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: false } });

  await alice.goto(`/files/form/${fileId}`);
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = alice.getByRole("dialog", { name: "Send" });
  await expect(dialog.getByText("This form isn't taking answers yet.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Start taking answers" }).click();
  await expect(dialog.getByText("This form isn't taking answers yet.", { exact: false })).toHaveCount(0);
  const field = dialog.getByRole("textbox", { name: "Answer link" });
  await expect(field).toHaveValue(/\/f\/[A-Za-z0-9_-]{20,}$/);
  const first = await field.inputValue();
  await expect(dialog.getByRole("img", { name: "QR code for the answer link" })).toBeVisible();
  await expect(dialog.getByText("Add collaborators", { exact: true }).first()).toBeVisible();

  await dialog.getByRole("button", { name: "Reset link" }).click();
  await dialog.getByRole("alertdialog", { name: "Reset the link?" }).getByRole("button", { name: "Reset link" }).click();
  await expect(field).not.toHaveValue(first);
  const second = await field.inputValue();

  const { context, page } = await stranger(browser);
  await page.goto(first);
  await expect(page.getByText("This form doesn't exist or its link was turned off.")).toBeVisible({ timeout: 20_000 });
  // RSVP forms are for people on this server: signed out, you're asked to sign in.
  await page.goto(second);
  await expect(page.getByText(/This form is for people on .+\. Sign in to answer it\./)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await context.close();
});
