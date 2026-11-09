import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Porch hand-offs (WP-P1.6): Ctrl+K and Porch's own search find a post you
 *  can see (and never one you can't), Make this an event (only people who can
 *  see the post can be invited), Share to a Room (someone in the room who
 *  can't see the post gets "This post isn't shared with you"), Reply privately
 *  (the Rooms conversation opens with the post attached), Photos' trash
 *  warning, and a phone with an accessibility scan. Screenshots go to
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

const api = (page: Page, auth: string) => ({
  get: async (url: string, params?: Record<string, string>) => page.request.get(`/api${url}`, { headers: { Authorization: auth }, params }),
  post: async (url: string, data?: unknown) => page.request.post(`/api${url}`, { headers: { Authorization: auth }, data }),
  patch: async (url: string, data?: unknown) => page.request.patch(`/api${url}`, { headers: { Authorization: auth }, data }),
  del: async (url: string) => page.request.delete(`/api${url}`, { headers: { Authorization: auth } }),
});

async function porchReady(page: Page, auth: string): Promise<string> {
  const a = api(page, auth);
  const b = await a.get("/porch/bootstrap");
  expect(b.ok()).toBe(true);
  expect((await a.patch("/porch/me/profile", { welcomed: true })).ok()).toBe(true);
  return (await b.json()).me.id as string;
}

async function groupWith(owner: Page, oAuth: string, name: string, members: [Page, string, string][]): Promise<string> {
  const r = await api(owner, oAuth).post("/porch/groups", { name, visibility: "private", invite: members.map(([, , id]) => id) });
  expect(r.status(), await r.text()).toBe(201);
  const gid = (await r.json()).id as string;
  for (const [p, auth] of members) expect((await api(p, auth).post(`/porch/groups/${gid}/accept`)).ok()).toBe(true);
  return gid;
}

async function libraryPhoto(page: Page, auth: string, word: string): Promise<string> {
  const name = `porch-handoff-${word.toLowerCase()}-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, word, { clean: true })) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  await expect
    .poll(async () => (await (await page.request.get(`/api/files/${id}/signed-urls`, { headers: { Authorization: auth } })).json()).state, { timeout: 60_000 })
    .toBe("ready");
  return id;
}

async function scan(page: Page, what: string, selector?: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (selector) b = b.include(selector);
  const { violations } = await b.analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "More for this post" }).first().click();
  return page.getByRole("dialog", { name: /post$/ });
}

test("Ctrl+K and Porch search find a post you can see, never one you can't", async ({ alice, bob, dana }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const famId = await groupWith(alice, aAuth, `Search ${stamp}`, [[bob, bAuth, bobId]]);
  const words = `Lighthouse picnic ${stamp}`;
  const made = await api(alice, aAuth).post("/porch/posts", { kind: "text", body: words, groups: [famId] });
  expect(made.status(), await made.text()).toBe(201);
  const post = (await made.json()).id as string;

  // Bob: Ctrl+K in Promptly shows it under Porch, and opens it.
  await bob.goto("/files");
  await ready(bob);
  await bob.keyboard.press("Control+k");
  await bob.getByPlaceholder(/^Search chats, /).fill(`lighthouse ${stamp}`);
  const row = bob.getByRole("button", { name: new RegExp(`Lighthouse picnic ${stamp}`) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await shot(bob, "ctrl-k");
  await row.click();
  await expect(bob).toHaveURL(new RegExp(`/porch/p/${post}`));
  await expect(bob.getByRole("article", { name: /Post by/ }).getByText(words)).toBeVisible();

  // Porch's own search sheet.
  await bob.goto("/porch");
  await bob.getByRole("button", { name: "Search posts" }).click();
  const sheet = bob.getByRole("dialog", { name: "Search Porch" });
  await sheet.getByRole("searchbox", { name: "Search posts" }).fill("lighthouse picnic");
  const hit = sheet.getByRole("button", { name: new RegExp(`Lighthouse picnic ${stamp}`) });
  await expect(hit).toBeVisible({ timeout: 15_000 });
  expect(await scan(bob, "search sheet", '[role="dialog"]')).toEqual([]);
  await hit.click();
  await expect(bob).toHaveURL(new RegExp(`/porch/p/${post}`));

  // Dana isn't in the group: nothing, in Ctrl+K or Porch.
  const ck = await (await api(dana, dAuth).get("/today/search", { q: `lighthouse ${stamp}` })).json();
  expect(ck.porch.map((p: { id: string }) => p.id)).not.toContain(post);
  const ps = await (await api(dana, dAuth).get("/porch/search", { q: `lighthouse ${stamp}` })).json();
  expect(ps.results.map((p: { id: string }) => p.id)).not.toContain(post);

  await api(alice, aAuth).del(`/porch/posts/${post}`);
  await api(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("make an event from a post: filled in, inviting only people who can see it", async ({ alice, bob, dana }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [aliceId, bobId, danaId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const famId = await groupWith(alice, aAuth, `Event ${stamp}`, [[bob, bAuth, bobId]]);
  const made = await api(alice, aAuth).post("/porch/posts", {
    kind: "text", body: `BBQ at ours ${stamp}\nBring a chair`, groups: [famId], place: { name: "Noosa Heads" },
  });
  const post = (await made.json()).id as string;

  await bob.goto(`/porch/p/${post}`);
  const menu = await openMenu(bob);
  await menu.getByRole("button", { name: /^Make this an event/ }).click();
  const editor = bob.getByRole("dialog", { name: "New event" });
  await expect(editor.getByRole("textbox", { name: "Title" })).toHaveValue(new RegExp(`BBQ at ours ${stamp}`));
  await expect(editor.getByPlaceholder("Add a place")).toHaveValue("Noosa Heads");
  await expect(editor.getByText("You can invite the people who can see this post.")).toBeVisible();
  await editor.getByRole("button", { name: "Add guests" }).click();
  const guests = bob.getByRole("dialog", { name: "Add guests" });
  // Only Alice can see it (besides Bob): Dana isn't offered.
  await expect(guests.getByRole("checkbox")).toHaveCount(1);
  await guests.getByRole("checkbox").check();
  await shot(bob, "make-event-guests");
  await guests.getByRole("button", { name: "Done" }).click();
  const saved = bob.waitForResponse((r) => r.url().endsWith("/api/calendar/events") && r.request().method() === "POST");
  await editor.getByRole("button", { name: /^Save/ }).click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  const ev = (await res.json()).event;
  expect(ev.source).toEqual({ kind: "porch_post", post_id: post });
  expect(ev.attendees.map((a: { user_id: string }) => a.user_id)).toContain(aliceId);
  expect(ev.description).toContain(`/porch/p/${post}`);

  // The server holds the same line: Dana can't be invited from it.
  const bad = await api(bob, bAuth).post("/calendar/events", {
    title: "x", start: "2026-12-01T08:00:00Z", end: "2026-12-01T09:00:00Z", guests: [danaId], source: { kind: "porch_post", post_id: post },
  });
  expect(bad.status()).toBe(400);

  await api(bob, bAuth).del(`/calendar/events/${ev.event_id}`);
  await api(alice, aAuth).del(`/porch/posts/${post}`);
  await api(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("share to a Room: an outsider in the room sees it isn't shared with them; reply privately opens the DM with the post", async ({ alice, bob, dana }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [aliceId, bobId, danaId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const famId = await groupWith(alice, aAuth, `Share ${stamp}`, [[bob, bAuth, bobId]]);
  const words = `New puppy ${stamp}`;
  const post = (await (await api(alice, aAuth).post("/porch/posts", { kind: "text", body: words, groups: [famId] })).json()).id as string;
  const space = await api(alice, aAuth).post("/rooms/spaces", { name: `Porch room ${stamp}`, emoji: "🏡" });
  expect(space.status(), await space.text()).toBe(201);
  const { id: spaceId, room_id: roomId } = await space.json();
  expect((await api(alice, aAuth).post(`/rooms/spaces/${spaceId}/members`, { user_ids: [bobId, danaId] })).ok()).toBe(true);

  // Alice shares it to the room from the post's menu.
  await alice.goto(`/porch/p/${post}`);
  await (await openMenu(alice)).getByRole("button", { name: /^Share to a Room/ }).click();
  const send = alice.getByRole("dialog", { name: "Send to…" });
  await expect(send.getByText("Only people who can see this post in Porch can open it.", { exact: false })).toBeVisible();
  await send.getByRole("button", { name: new RegExp(`#general.*Porch room ${stamp}`) }).click();
  await send.getByRole("textbox", { name: "Message" }).fill("Look at him!");
  await send.getByRole("button", { name: "Send", exact: true }).click();
  await expect(alice.getByText(/Sent to #general/)).toBeVisible();

  // Bob (in the group) sees the card; Dana (not) sees it isn't shared with her.
  await bob.goto(`/rooms/r/${roomId}`);
  await expect(bob.getByRole("button", { name: new RegExp(words) })).toBeVisible({ timeout: 15_000 });
  await dana.goto(`/rooms/r/${roomId}`);
  await expect(dana.getByText("This post isn't shared with you.")).toBeVisible({ timeout: 15_000 });
  await expect(dana.getByText(words)).toHaveCount(0);
  await shot(dana, "room-card-outsider");

  // Bob replies privately: his conversation with Alice, the post attached.
  await bob.goto(`/porch/p/${post}`);
  await (await openMenu(bob)).getByRole("button", { name: /^Reply privately/ }).click();
  await expect(bob).toHaveURL(/\/rooms\/r\/[0-9a-f-]+\?share=porch_post:/);
  const attached = bob.getByRole("group", { name: "Attached to your message" });
  await expect(attached.getByText(words)).toBeVisible();
  await shot(bob, "reply-privately");
  await bob.getByRole("textbox", { name: "Message to send with it" }).fill(`So cute! ${stamp}`);
  await bob.getByRole("button", { name: "Send", exact: true }).click();
  await expect(attached).toHaveCount(0);
  await expect(bob).not.toHaveURL(/share=/);
  await expect(bob.getByRole("button", { name: new RegExp(words) })).toBeVisible({ timeout: 15_000 });
  await expect(bob.getByText(`So cute! ${stamp}`, { exact: true })).toBeVisible();
  // Alice gets it in her conversations.
  const boot = await (await api(alice, aAuth).get("/rooms/bootstrap")).json();
  const dm = boot.dms.find((r: { members?: string[] }) => r.members?.includes(bobId) && r.members?.includes(aliceId) && r.members.length === 2);
  expect(dm).toBeTruthy();

  await api(alice, aAuth).del(`/rooms/spaces/${spaceId}`);
  await api(alice, aAuth).del(`/porch/posts/${post}`);
  await api(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("Photos warns before trashing a photo that's in a Porch post; a phone and an accessibility scan", async ({ alice, bob }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth] = [await bearer(alice), await bearer(bob)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth)];
  const famId = await groupWith(alice, aAuth, `Trash ${stamp}`, [[bob, bAuth, bobId]]);
  const pic = await libraryPhoto(alice, aAuth, "SUNSET");
  const made = await api(alice, aAuth).post("/porch/posts", { kind: "photo", body: `Sunset ${stamp}`, groups: [famId], media: [{ file_id: pic }] });
  expect(made.status(), await made.text()).toBe(201);
  const post = (await made.json()).id as string;
  expect((await (await api(alice, aAuth).get(`/porch/files/${pic}/uses`)).json()).posts).toBe(1);

  await alice.goto("/files/photos");
  await ready(alice);
  const tile = alice.locator(`[data-photo="${pic}"]`);
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await tile.click();
  const viewer = alice.getByRole("dialog", { name: "Photo viewer" });
  await viewer.getByRole("button", { name: "Move to trash" }).click();
  const warn = alice.getByRole("dialog", { name: "Move this photo to the trash?" });
  await expect(warn.getByText(/This photo is in 1 Porch post\./)).toBeVisible();
  await shot(alice, "trash-warning");
  await warn.getByRole("button", { name: "Cancel" }).click();
  await expect(warn).toHaveCount(0);
  // Still in the post.
  expect((await (await api(bob, bAuth).get(`/porch/posts/${post}`)).json()).media).toHaveLength(1);

  // Today: the Porch card with Alice's birthday, and "Post for" opens a post for her.
  const now = new Date();
  const born = `1990-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  expect((await api(alice, aAuth).patch("/porch/me/profile", { birthday: born, show_birthday: true })).ok()).toBe(true);
  await bob.goto("/today");
  await ready(bob);
  const card = bob.locator("section").filter({ has: bob.getByRole("heading", { name: "Porch", exact: true }) });
  await expect(card.getByRole("link", { name: `${run.users.alice.username} Birthday today` })).toBeVisible({ timeout: 20_000 });
  await shot(bob, "today-card");
  await card.getByRole("link", { name: /^Post for / }).click();
  await expect(bob.getByRole("combobox", { name: "What's new?" })).toHaveValue(new RegExp(`^Happy birthday @${run.users.alice.username}! `));
  expect((await api(alice, aAuth).patch("/porch/me/profile", { show_birthday: false })).ok()).toBe(true);

  // A phone: the post's menu, Porch search, and the hand-offs fit.
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.goto(`/porch/p/${post}`);
  const menu = await openMenu(bob);
  for (const name of [/^Reply privately/, /^Share to a Room/, /^Make this an event/]) await expect(menu.getByRole("button", { name })).toBeVisible();
  const box = await menu.boundingBox();
  expect(box && box.width).toBeLessThanOrEqual(390);
  expect(await scan(bob, "post menu (phone)", '[role="dialog"]')).toEqual([]);
  await shot(bob, "post-menu-phone");
  await bob.keyboard.press("Escape");
  await bob.goto("/porch");
  await bob.getByRole("button", { name: "Search posts" }).click();
  const sheet = bob.getByRole("dialog", { name: "Search Porch" });
  await sheet.getByRole("searchbox", { name: "Search posts" }).fill(`sunset ${stamp}`);
  await expect(sheet.getByRole("button", { name: new RegExp(`Sunset ${stamp}`) })).toBeVisible({ timeout: 15_000 });
  const overflow = await bob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await scan(bob, "search sheet (phone)", '[role="dialog"]')).toEqual([]);
  await shot(bob, "search-phone");

  await api(alice, aAuth).del(`/porch/posts/${post}`);
  await api(alice, aAuth).del(`/porch/groups/${famId}`);
});
