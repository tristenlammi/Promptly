import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Porch push, admin and phone (WP-P1.7): Settings → Notifications kind by
 *  kind (kept after a reload), a group's bell and "Notify me" on a profile;
 *  report a post → the admin removes it in Admin → Porch → the poster sees
 *  why in Activity; Admin → Porch off hides Porch; a phone width; and
 *  accessibility scans. Dana is the server admin. Screenshots go to
 *  ``PORCH_SHOTS`` (default ``test-results/porch-shots``). */

const SHOTS = process.env.PORCH_SHOTS || path.join("test-results", "porch-shots");

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForResponse((r) => !!r.request().headers()["authorization"] && r.url().includes("/api/") && r.ok());
  await page.goto("/files");
  await ready(page);
  return (await seen).request().headers()["authorization"];
}

const porch = (page: Page, auth: string) => ({
  get: async (url: string) => page.request.get(`/api${url}`, { headers: { Authorization: auth } }),
  post: async (url: string, data?: unknown) => page.request.post(`/api${url}`, { headers: { Authorization: auth }, data }),
  put: async (url: string, data?: unknown) => page.request.put(`/api${url}`, { headers: { Authorization: auth }, data }),
  patch: async (url: string, data?: unknown) => page.request.patch(`/api${url}`, { headers: { Authorization: auth }, data }),
  del: async (url: string) => page.request.delete(`/api${url}`, { headers: { Authorization: auth } }),
});

async function porchReady(page: Page, auth: string): Promise<string> {
  const a = porch(page, auth);
  const b = await a.get("/porch/bootstrap");
  expect(b.ok(), await b.text()).toBe(true);
  expect((await a.patch("/porch/me/profile", { welcomed: true })).ok()).toBe(true);
  return (await b.json()).me.id as string;
}

async function groupWith(owner: Page, oAuth: string, name: string, members: [Page, string, string][]): Promise<string> {
  const r = await porch(owner, oAuth).post("/porch/groups", { name, visibility: "private", invite: members.map(([, , id]) => id) });
  expect(r.status(), await r.text()).toBe(201);
  const gid = (await r.json()).id as string;
  for (const [p, auth] of members) expect((await porch(p, auth).post(`/porch/groups/${gid}/accept`)).ok()).toBe(true);
  return gid;
}

async function scan(page: Page, what: string, selector: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include(selector).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("Settings → Notifications per kind, a group's bell and Notify me, on a phone", async ({ alice, bob }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth] = [await bearer(alice), await bearer(bob)];
  const [aliceId, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth)];
  const fam = `Bells ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  // Start from the defaults whatever an earlier run left.
  await porch(alice, aAuth).patch("/porch/me/notifications", {
    modes: { post: "on", comment: "on", reply: "on", mention: "on", tag: "on", invite: "on", reaction: "summary", birthday: "on" },
    porch: true,
  });
  await porch(bob, bAuth).del(`/porch/alerts/${aliceId}`);

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.goto(`/porch/u/${aliceId}`);
  await alice.getByRole("button", { name: /^Notifications/ }).click();
  await expect(alice).toHaveURL(/\/porch\/settings$/);
  await expect(alice.getByRole("heading", { name: "Notifications" })).toBeVisible();

  // Each kind: On / Daily summary / Off. Reactions start on Daily summary.
  const reactions = alice.getByRole("radiogroup", { name: "Reactions" });
  await expect(reactions.getByRole("radio", { name: "Daily summary" })).toHaveAttribute("aria-checked", "true");
  const comments = alice.getByRole("radiogroup", { name: "Comments on your posts" });
  await comments.getByRole("radio", { name: "Off" }).click();
  await expect(comments.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  await reactions.getByRole("radio", { name: "On", exact: true }).click();
  await expect(reactions.getByRole("radio", { name: "On", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await (await porch(alice, aAuth).get("/porch/me/notifications")).json()).modes)
    .toMatchObject({ comment: "off", reaction: "on" });

  // The group's bell, here and on the Groups tab.
  const bell = alice.locator(`#porch-scroll [data-bell="${famId}"]`);
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(alice.getByText(`You'll get a notification for every new post in ${fam}.`)).toBeVisible();
  await shot(alice, "settings-phone");
  const errs = await scan(alice, "settings (phone)", "#porch-scroll");

  // Kept after a reload.
  await alice.reload();
  await expect(alice.getByRole("radiogroup", { name: "Comments on your posts" }).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  await expect(alice.locator(`#porch-scroll [data-bell="${famId}"]`)).toHaveAttribute("aria-pressed", "true");
  await alice.goto("/porch/groups");
  await expect(alice.locator(`#porch-scroll [data-bell="${famId}"]`)).toHaveAttribute("aria-pressed", "true");
  // No sideways scrolling at phone width.
  expect(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // Bob: Notify me when Alice posts, from her profile; it shows in his Settings.
  await bob.goto(`/porch/u/${aliceId}`);
  const notify = bob.getByRole("button", { name: /Notify me/ });
  await expect(notify).toHaveAttribute("aria-pressed", "false");
  await notify.click();
  await expect(bob.getByRole("button", { name: /Notifying you/ })).toHaveAttribute("aria-pressed", "true");
  await bob.goto("/porch/settings");
  await expect(bob.getByRole("button", { name: new RegExp(`Stop notifications when ${(await (await porch(alice, aAuth).get("/porch/bootstrap")).json()).me.name}`) })).toBeVisible();
  errs.push(...(await scan(bob, "settings (desktop)", "#porch-scroll")));
  expect(errs).toEqual([]);

  await porch(bob, bAuth).del(`/porch/alerts/${aliceId}`);
  await porch(alice, aAuth).patch("/porch/me/notifications", { modes: { comment: "on", reaction: "summary" } });
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("report a post; the admin removes it in Admin → Porch; the poster sees why", async ({ alice, bob, dana }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const mates = `Mates ${stamp}`;
  const gid = await groupWith(alice, aAuth, mates, [[bob, bAuth, bobId]]);
  const words = `Rude words ${stamp}`;
  const post = await (await porch(alice, aAuth).post("/porch/posts", { kind: "text", body: words, groups: [gid] })).json();

  // Bob reports it from the post's "…".
  await bob.goto(`/porch/p/${post.id}`);
  await bob.getByRole("button", { name: /More for/ }).first().click();
  await bob.getByRole("button", { name: "Report" }).click();
  const sheet = bob.getByRole("dialog", { name: "Report this post" });
  await sheet.getByRole("radio", { name: "It's unkind or hurtful" }).click();
  await sheet.getByRole("textbox", { name: /Anything to add/ }).fill("Not nice to Mum");
  const errs = await scan(bob, "report sheet", '[role="dialog"]');
  await sheet.getByRole("button", { name: "Send report" }).click();
  await expect(bob.getByText(/Thanks for telling us/)).toBeVisible();

  // Dana (a server admin, not in Mates) handles it in Admin → Porch.
  await dana.goto("/admin?tab=porch");
  await expect(dana.getByRole("heading", { name: "Reports" })).toBeVisible();
  const row = dana.locator("[data-report]").filter({ hasText: words });
  await expect(row).toBeVisible();
  await expect(row).toContainText("It's unkind or hurtful. Not nice to Mum");
  await expect(row).toContainText("1 other group"); // a group she isn't in isn't named
  await shot(dana, "admin-reports");
  errs.push(...(await scan(dana, "admin porch", "main")));
  await row.getByRole("textbox", { name: /Reason, if you remove it/ }).fill(`Please keep it friendly ${stamp}`);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(dana.getByText(/Removed\. .* told why/)).toBeVisible();
  await expect(dana.locator("[data-report]").filter({ hasText: words })).toHaveCount(0);

  // Gone for Bob; Alice is told why, in Activity.
  expect((await porch(bob, bAuth).get(`/porch/posts/${post.id}`)).status()).toBe(404);
  await alice.goto("/porch/activity");
  const told = alice.locator('[data-activity="removed"]').filter({ hasText: `Please keep it friendly ${stamp}` });
  await expect(told).toContainText("Your post was removed");
  await expect(told).toContainText(words);
  await shot(alice, "activity-removed");
  errs.push(...(await scan(alice, "activity", "#porch-scroll")));
  expect(errs).toEqual([]);

  await porch(alice, aAuth).del(`/porch/groups/${gid}`);
});

test("Admin → Porch off hides Porch; on again brings it back", async ({ bob, dana }) => {
  test.setTimeout(120_000);
  const [bAuth, dAuth] = [await bearer(bob), await bearer(dana)];
  await porchReady(bob, bAuth);
  try {
    await dana.goto("/admin?tab=porch");
    const on = dana.getByRole("checkbox", { name: /Porch is on/ });
    await expect(on).toBeChecked();
    await on.click();
    await expect(on).not.toBeChecked();
    await expect.poll(async () => (await (await porch(bob, bAuth).get("/porch/available")).json()).available).toBe(false);
    await bob.goto("/porch/");
    await expect(bob.getByText("Porch isn't turned on for you. Ask the person who runs this Promptly.")).toBeVisible();
    await on.click();
    await expect(on).toBeChecked();
    await bob.goto("/porch/");
    await expect(bob.getByRole("navigation", { name: "Porch" })).toBeVisible();
  } finally {
    // Never leave a shared stack with Porch off.
    await porch(dana, dAuth).patch("/admin/porch", { enabled: true });
  }
});
