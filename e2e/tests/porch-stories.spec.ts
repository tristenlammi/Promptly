import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Porch stories (WP-P2.2–P2.4, P3.x): post a text story to one group, an
 *  outsider sees no ring, a member watches it and the author sees "Seen by
 *  1". Screenshots go to ``PORCH_SHOTS`` (default ``test-results/porch-shots``). */

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
  get: async (url: string) => page.request.get(`/api${url}`, { headers: { Authorization: auth } }),
  post: async (url: string, data?: unknown) => page.request.post(`/api${url}`, { headers: { Authorization: auth }, data }),
  patch: async (url: string, data?: unknown) => page.request.patch(`/api${url}`, { headers: { Authorization: auth }, data }),
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

/** Accessibility of one full-screen story layer (the app under it isn't this spec's). */
async function scan(page: Page, what: string, selector: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("a text story reaches only its group, and its poster sees who watched", async ({ alice, bob, dana }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [aliceId, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const fam = `Stories ${stamp}`;
  await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  const words = `Pancakes for breakfast ${stamp}`;

  // Alice: ＋ → Story → Text, to that one group.
  await alice.goto("/porch/story/new");
  const composer = alice.getByRole("dialog", { name: "New story" });
  await expect(composer).toBeVisible();
  await composer.getByRole("button", { name: "Text", exact: true }).click();
  await composer.getByLabel("Your story's words").fill(words);
  await composer.getByRole("radio", { name: "Ocean" }).click();
  await composer.getByRole("button", { name: /^To / }).click();
  const to = alice.getByRole("dialog", { name: "Share to" });
  await to.getByRole("radio", { name: /Choose groups/ }).click();
  // It starts on what was used last: just this group.
  const ticked = to.getByRole("checkbox", { checked: true });
  while ((await ticked.count()) > 0) await ticked.first().click();
  await to.getByRole("checkbox", { name: new RegExp(fam) }).click();
  await to.getByRole("button", { name: "Done" }).click();
  await expect(composer.getByRole("button", { name: /^To / })).toContainText(fam);
  await shot(alice, "story-composer-text");
  expect(await scan(alice, "story composer", "[data-story-composer]")).toEqual([]);
  await composer.getByRole("button", { name: "Share", exact: true }).click();
  await expect(alice.getByText("Added to your story")).toBeVisible();
  await expect(alice.getByRole("button", { name: /^Your story/ })).toBeVisible();

  // Dana isn't in the group: no ring for Alice.
  await dana.goto("/porch/");
  await expect(dana.getByRole("heading", { name: /Porch|Feed/ }).first()).toBeVisible();
  await expect(dana.locator(`[data-story-ring="${aliceId}"]`)).toHaveCount(0);
  const outsider = await api(dana, dAuth).get(`/porch/stories/u/${aliceId}`);
  expect((await outsider.json()).stories).toEqual([]);

  // Bob watches it.
  await bob.goto("/porch/");
  const ring = bob.locator(`[data-story-ring="${aliceId}"]`);
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute("aria-label", /1 new/);
  const viewed = bob.waitForResponse((r) => r.url().includes("/view") && r.request().method() === "POST");
  await ring.click();
  const player = bob.getByRole("dialog", { name: /story$/ });
  await expect(player).toBeVisible();
  await expect(player.getByText(words, { exact: true })).toBeVisible();
  // Hold it still while we look (Space pauses).
  await bob.keyboard.press(" ");
  await shot(bob, "story-viewer");
  await expect(player.getByText(new RegExp(`^in ${fam} · `))).toBeVisible();
  await viewed;
  expect(await scan(bob, "story viewer", "[data-story-player]")).toEqual([]);

  // Bob replies (WP-P2.3): it lands in their 1:1 conversation in Rooms, with the story.
  const replied = bob.waitForResponse((r) => r.url().includes("/reply") && r.request().method() === "POST");
  await player.getByLabel(/^Send .* a message$/).fill(`Yum ${stamp}`);
  await player.getByRole("button", { name: "Send", exact: true }).click();
  const reply = await (await replied).json();
  await expect(bob.getByText(/Sent to .* in Rooms\./)).toBeVisible();
  await player.getByRole("button", { name: "Send ❤️" }).click();
  await expect(bob.getByText(/Sent ❤️ to/)).toBeVisible();
  await bob.keyboard.press("Escape");
  await expect(player).toHaveCount(0);
  await expect(ring).toHaveAttribute("aria-label", /seen/);

  // Alice sees "Seen by 1", and who.
  await alice.goto("/porch/");
  await alice.getByRole("button", { name: /^Your story/ }).click();
  const mine = alice.getByRole("dialog", { name: "Your story" });
  await expect(mine.getByRole("button", { name: "Seen by 1" })).toBeVisible();
  await mine.getByRole("button", { name: "Seen by 1" }).click();
  const list = alice.getByRole("dialog", { name: "Seen by 1 person" });
  await expect(list.getByText(/Bob/i)).toBeVisible();
  await shot(alice, "story-seen-by");
  await alice.keyboard.press("Escape");
  await alice.keyboard.press("Escape");

  // The reply in Alice's Rooms conversation, with the story's card while it's live.
  await alice.goto(reply.url);
  await expect(alice.getByText(`Yum ${stamp}`, { exact: true })).toBeVisible();
  await expect(alice.getByRole("button", { name: new RegExp(words) }).first()).toBeVisible();
  await shot(alice, "story-reply-in-rooms");

  // A phone: the row and the viewer fit the screen; the story maker's start.
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.goto("/porch/");
  await expect(bob.locator(`[data-story-ring="${aliceId}"]`)).toBeVisible();
  expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(bob, "story-row-phone");
  await bob.locator(`[data-story-ring="${aliceId}"]`).click();
  await expect(bob.getByRole("dialog", { name: /story$/ })).toBeVisible();
  await bob.keyboard.press(" ");
  await shot(bob, "story-viewer-phone");
  await bob.keyboard.press("Escape");
  await bob.getByRole("navigation", { name: "Porch" }).getByRole("button", { name: "New post or story" }).click();
  await bob.getByRole("dialog", { name: "New" }).getByRole("button", { name: /^Story/ }).click();
  await expect(bob.getByRole("dialog", { name: "New story" }).getByRole("button", { name: "Camera" })).toBeVisible();
  await shot(bob, "story-composer-phone");
});

test("plan a BBQ in a group: everyone's invited, a member answers from the card and it's in their calendar; pin it", async ({ alice, bob, dana }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [aliceId, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const fam = `Events ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  const title = `BBQ Saturday ${stamp}`;

  // Alice: the group's ＋ Event, the Calendar's own editor in group mode.
  await alice.goto(`/porch/g/${famId}`);
  await alice.getByRole("button", { name: "Event", exact: true }).click();
  const editor = alice.getByRole("dialog", { name: `Plan an event in ${fam}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("switch", { name: `Invite everyone in ${fam}` })).toHaveAttribute("aria-checked", "true");
  await editor.getByRole("textbox", { name: "Title" }).fill(title);
  await shot(alice, "group-event-editor");
  const planned = alice.waitForResponse((r) => r.url().endsWith(`/porch/groups/${famId}/events`) && r.request().method() === "POST");
  await editor.getByRole("button", { name: /^Post/ }).click();
  const res = await planned;
  expect(res.status(), await res.text()).toBe(201);
  const got = await res.json();
  expect(got.event.attendees.map((a: { user_id: string }) => a.user_id)).toEqual([bobId]);
  await expect(alice.getByText(`Event posted in ${fam}`)).toBeVisible();

  // Bob: the card in the group's Events tab; Going.
  await bob.goto(`/porch/g/${famId}`);
  await bob.getByRole("radio", { name: "Events" }).click();
  const card = bob.locator(`[data-event-card="${got.event.event_id}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByText(title)).toBeVisible();
  const answered = bob.waitForResponse((r) => r.url().includes(`/calendar/events/${got.event.event_id}/rsvp`));
  await card.getByRole("button", { name: "Going" }).click();
  expect((await answered).ok()).toBe(true);
  await expect(card.getByRole("button", { name: "Going" })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText(/are going/)).toBeVisible();
  await shot(bob, "group-event-card");

  // It's in Bob's calendar, answered.
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
  const cal = await (await api(bob, bAuth).get(`/calendar/events?start=${from}&end=${to}`)).json();
  const mine = cal.events.find((e: { event_id: string }) => e.event_id === got.event.event_id);
  expect(mine?.my_status).toBe("going");

  // Dana isn't in the group: no card, and Calendar won't open it for her.
  expect((await api(dana, dAuth).get(`/porch/posts/${got.post.id}`)).status()).toBe(404);
  expect((await api(dana, dAuth).get(`/calendar/events/${got.event.event_id}`)).status()).toBe(404);

  // Alice pins it: the Pinned strip on the group page (never the feed).
  await alice.goto(`/porch/p/${got.post.id}`);
  await alice.getByRole("button", { name: "More for this post" }).first().click();
  await alice.getByRole("menu", { name: /post$/ }).getByRole("menuitem", { name: new RegExp(`^Pin to ${fam}`) }).click();
  await expect(alice.getByText(`Pinned to ${fam}.`)).toBeVisible();
  await alice.goto(`/porch/g/${famId}`);
  const pinned = alice.getByRole("region", { name: `Pinned in ${fam}` });
  await expect(pinned).toBeVisible();
  await shot(alice, "group-pinned");

  // Alice's person page, as Bob sees it (WP-P3.3): On Porch, with the BBQ.
  await bob.goto(`/people/u/${aliceId}`);
  await expect(bob.getByRole("heading", { name: "On Porch" })).toBeVisible();
  await expect(bob.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(bob.getByText(/^Groups you're both in: /)).toBeVisible();
  await shot(bob, "person-page-on-porch");
});
