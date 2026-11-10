import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Porch talking (WP-P1.5): comments and replies, reactions whose names only
 *  the post's author sees, a poll (vote, change, who voted for what), a tag
 *  approved from Activity, an outsider who sees none of it, and a phone with
 *  the comments sheet and an accessibility scan. Screenshots of the comments
 *  sheet, a poll and Activity go to ``PORCH_SHOTS`` (default
 *  ``test-results/porch-shots``). */

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
  expect(b.ok()).toBe(true);
  expect((await a.patch("/porch/me/profile", { welcomed: true })).ok()).toBe(true);
  return (await b.json()).me.id as string;
}

async function libraryPhoto(page: Page, auth: string, word: string): Promise<string> {
  const name = `porch-talk-${word.toLowerCase()}-${stamp}.jpg`;
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

async function groupWith(owner: Page, oAuth: string, name: string, members: [Page, string, string][]): Promise<string> {
  const r = await porch(owner, oAuth).post("/porch/groups", { name, visibility: "private", invite: members.map(([, , id]) => id) });
  expect(r.status(), await r.text()).toBe(201);
  const gid = (await r.json()).id as string;
  for (const [p, auth] of members) expect((await porch(p, auth).post(`/porch/groups/${gid}/accept`)).ok()).toBe(true);
  return gid;
}

async function scan(page: Page, what: string, selector = "#porch-scroll"): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include(selector).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("comments and replies; reactions named only for the author; D5; an outsider sees none of it", async ({ alice, bob, dana }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  const fam = `Talk ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  const pic = await libraryPhoto(alice, aAuth, "BEACH");
  const made = await porch(alice, aAuth).post("/porch/posts", { kind: "photo", body: `Beach day ${stamp}`, groups: [famId], media: [{ file_id: pic }] });
  expect(made.status(), await made.text()).toBe(201);
  const post = (await made.json()).id as string;

  // Bob comments on the post's page (inline on a computer).
  await bob.goto(`/porch/p/${post}`);
  const bobComments = bob.getByRole("region", { name: "Comments" });
  await expect(bobComments.getByText("No comments yet. Say something nice.")).toBeVisible();
  await bobComments.getByRole("combobox", { name: "Add a comment" }).fill("Gorgeous!");
  await bobComments.getByRole("button", { name: "Post comment" }).click();
  await expect(bobComments.getByRole("list", { name: "Comments" }).getByText("Gorgeous!")).toBeVisible();

  // Bob reacts with a heart.
  await bob.getByRole("button", { name: /React to .*'s post with a heart/ }).click();
  await expect(bob.getByRole("button", { name: /Take back your ❤️/ })).toHaveAttribute("aria-pressed", "true");

  // Alice replies to him.
  await alice.goto(`/porch/p/${post}`);
  const comments = alice.getByRole("region", { name: "Comments" });
  await comments.getByRole("button", { name: /^Reply to / }).first().click();
  const box = comments.getByRole("combobox", { name: /Reply to/ });
  await expect(box).toHaveValue(`@${run.users.bob.username} `);
  await box.pressSequentially("Thanks!");
  await comments.getByRole("button", { name: "Post reply" }).click();
  await expect(comments.getByRole("list", { name: "Replies" }).getByText("Thanks!")).toBeVisible();

  // The author sees who reacted…
  const who = alice.getByRole("button", { name: /reacted\. See who\./ });
  await expect(who).toContainText(/.+/);
  await who.click();
  const sheet = alice.getByRole("dialog", { name: "Reactions" });
  await expect(sheet.getByText("Only you can see who reacted.")).toBeVisible();
  await expect(sheet.getByRole("listitem")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Close" }).click();
  // …nobody else does: Bob sees only the emoji.
  await bob.reload();
  await expect(bob.getByRole("button", { name: /reacted\. See who\./ })).toHaveCount(0);
  const bobView = await (await porch(bob, bAuth).get(`/porch/posts/${post}`)).json();
  expect(Object.keys(bobView.reactions).sort()).toEqual(["emojis", "mine"]);
  expect((await porch(bob, bAuth).get(`/porch/posts/${post}/reactions`)).status()).toBe(403);
  // Bob's own comment is his to edit; the reply mentions him.
  await expect(bob.getByRole("list", { name: "Replies" }).getByRole("link", { name: `@${run.users.bob.username}` })).toBeVisible();

  // Dana (not in the group) sees none of it.
  expect((await porch(dana, dAuth).get(`/porch/posts/${post}`)).status()).toBe(404);
  expect((await porch(dana, dAuth).get(`/porch/posts/${post}/comments`)).status()).toBe(404);
  expect((await porch(dana, dAuth).put(`/porch/posts/${post}/reactions`, { emoji: "❤️" })).status()).toBe(404);
  await dana.goto(`/porch/p/${post}`);
  await expect(dana.getByText("This post isn't available")).toBeVisible();
  const dAct = await (await porch(dana, dAuth).get("/porch/activity")).json();
  expect(JSON.stringify(dAct)).not.toContain(post);

  // D5: Alice deletes Bob's comment on her post (his reply thread keeps its place).
  await comments.getByRole("button", { name: /More for .*'s comment/ }).first().click();
  await alice.getByRole("dialog").getByRole("button", { name: /^Delete/ }).click();
  await alice.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(comments.getByText("This comment was deleted.")).toBeVisible();
  await expect(comments.getByText("Thanks!")).toBeVisible();

  await porch(alice, aAuth).del(`/porch/posts/${post}`);
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("a poll: ask, vote, change your vote, and see who voted for what", async ({ alice, bob }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth] = [await bearer(alice), await bearer(bob)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth)];
  const fam = `Poll ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);

  // Alice asks, from the composer (a new post starts at the words).
  await alice.goto("/porch/new");
  await alice.getByRole("button", { name: "Poll", exact: true }).click();
  const editor = alice.getByRole("dialog", { name: "Add a poll" });
  await editor.getByRole("textbox", { name: "Option 1" }).fill("Pizza");
  await editor.getByRole("textbox", { name: "Option 2" }).fill("Pasta");
  await editor.getByRole("button", { name: "Add an option" }).click();
  await editor.getByRole("textbox", { name: "Option 3" }).fill("Tacos");
  await editor.getByRole("radio", { name: "1 day" }).click();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(alice.getByText("Write your question in the box above.")).toBeVisible();
  await expect(alice.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  await alice.getByRole("combobox", { name: "Question" }).fill(`Dinner on Friday? ${stamp}`);
  await alice.getByRole("button", { name: /Share to/ }).click();
  const who = alice.getByRole("dialog", { name: "Share to" });
  await who.getByRole("radio", { name: /Choose groups/ }).click();
  await who.getByRole("checkbox", { name: new RegExp(fam) }).click();
  await who.getByRole("button", { name: "Done" }).click();
  const posted = alice.waitForResponse((r) => r.url().endsWith("/api/porch/posts") && r.request().method() === "POST");
  await alice.getByRole("button", { name: "Post", exact: true }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  const poll = await res.json();
  expect(poll.kind).toBe("poll");
  expect(poll.poll.options.map((o: { label: string }) => o.label)).toEqual(["Pizza", "Pasta", "Tacos"]);
  expect(poll.poll.closes_at).toBeTruthy();

  // Bob votes, changes his mind; results show once he has.
  await bob.goto(`/porch/p/${poll.id}`);
  const card = bob.locator(`[data-poll="${poll.id}"]`);
  await expect(card.getByText("Vote to see the results")).toBeVisible();
  await card.getByRole("radio", { name: "Pizza" }).click();
  await expect(card.getByRole("radio", { name: /Pizza: 1 vote, your vote/ })).toHaveAttribute("aria-checked", "true");
  await card.getByRole("radio", { name: /Pasta/ }).click();
  await expect(card.getByRole("radio", { name: /Pasta: 1 vote, your vote/ })).toBeVisible();
  await expect(card.getByRole("radio", { name: /Pizza: 0 votes/ })).toBeVisible();
  await expect(card.getByText(/Closes in/)).toBeVisible();

  // D4: everyone who sees it sees who voted for what.
  await alice.goto(`/porch/p/${poll.id}`);
  const aCard = alice.locator(`[data-poll="${poll.id}"]`);
  await expect(aCard.getByRole("button", { name: /voted for Pasta/ })).toBeVisible();
  await aCard.getByRole("radio", { name: "Tacos" }).click();
  await expect(aCard.getByText("2 votes")).toBeVisible();
  await shot(alice, "poll");

  await porch(alice, aAuth).del(`/porch/posts/${poll.id}`);
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("tag someone on a photo; they say yes from Activity; the badge; an outsider sees nothing", async ({ alice, bob, dana }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const [aliceId, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth), await porchReady(dana, dAuth)];
  // A reused stack can hold tag requests from earlier runs that stopped part
  // way: answer them first, so this run's request is the only one waiting.
  const left = await (await porch(bob, bAuth).get("/porch/activity")).json();
  for (const t of left.tag_requests as { id: string }[]) await porch(bob, bAuth).post(`/porch/tags/${t.id}/decline`);
  const fam = `Tags ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  const pic = await libraryPhoto(alice, aAuth, "FAMILY");

  // Alice picks the photo, tags Bob in Arrange, posts it to the group.
  await alice.goto("/porch/new");
  await alice.getByRole("button", { name: "Add photos or videos" }).click();
  await alice.locator(`[data-photo="${pic}"]`).click();
  await alice.getByRole("button", { name: "Next" }).first().click();
  await expect(alice.getByRole("heading", { name: "Arrange" })).toBeVisible();
  await alice.getByRole("button", { name: "Tag people" }).click();
  const surface = alice.locator("[data-tag-surface]");
  await expect(surface).toBeVisible();
  await surface.click({ position: { x: 60, y: 60 } });
  const whoSheet = alice.getByRole("dialog", { name: "Who's this?" });
  await whoSheet.getByRole("button", { name: new RegExp(run.users.bob.username) }).click();
  await expect(alice.getByText(/Tagged: /)).toBeVisible();
  await alice.getByRole("button", { name: "Done tagging" }).click();
  await alice.getByRole("button", { name: "Next" }).first().click();
  await alice.getByRole("button", { name: /Share to/ }).click();
  const share = alice.getByRole("dialog", { name: "Share to" });
  await share.getByRole("radio", { name: /Choose groups/ }).click();
  await share.getByRole("checkbox", { name: new RegExp(fam) }).click();
  await share.getByRole("button", { name: "Done" }).click();
  await expect(alice.getByRole("button", { name: /Tagged/ })).toBeVisible();
  await alice.getByRole("combobox", { name: "Caption" }).fill(`Sunday lunch ${stamp}`);
  const posted = alice.waitForResponse((r) => r.url().endsWith("/api/porch/posts") && r.request().method() === "POST");
  await alice.getByRole("button", { name: "Post", exact: true }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  const post = await res.json();
  expect(post.media[0].tags.map((t: { user: { id: string }; status: string }) => [t.user.id, t.status])).toEqual([[bobId, "pending"]]);

  // More for Bob's Activity: Dana invites him to a group; Alice comments on his post.
  const lads = await porch(dana, dAuth).post("/porch/groups", { name: `Lads ${stamp}`, visibility: "private", invite: [bobId] });
  const ladsId = (await lads.json()).id as string;
  const his = await (await porch(bob, bAuth).post("/porch/posts", { kind: "text", body: `Anyone for tennis? ${stamp}`, groups: [famId] })).json();
  await porch(alice, aAuth).post(`/porch/posts/${his.id}/comments`, { body: `Count me in @${run.users.bob.username}`, mentions: [bobId] });
  await porch(alice, aAuth).put(`/porch/posts/${his.id}/reactions`, { emoji: "😂" });

  // Bob's Activity badge, then Activity: the invite and the tag request pinned on top.
  await bob.goto("/porch/");
  const nav = bob.getByRole("navigation", { name: "Porch" });
  await expect(nav.getByRole("link", { name: /Activity/ })).toContainText(/[0-9]/);
  await nav.getByRole("link", { name: /Activity/ }).click();
  await expect(bob.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(bob.getByText("Needs your OK")).toBeVisible();
  await expect(bob.locator(`#porch-scroll [data-invite="${ladsId}"]`)).toBeVisible();
  await expect(bob.locator('[data-activity="comment"]').first()).toContainText("commented on your post");
  await expect(bob.locator('[data-activity="reaction"]').first()).toContainText("reacted");
  await shot(bob, "activity");
  // Opening Activity cleared the badge (the invite and tag still wait).
  // (Leftovers of earlier runs may add invites, so count what's waiting.)
  const waiting = await (await porch(bob, bAuth).get("/porch/activity")).json();
  expect(waiting.items.some((i: { unseen: boolean }) => i.unseen)).toBe(false);
  await expect
    .poll(async () => (await (await porch(bob, bAuth).get("/porch/bootstrap")).json()).activity_unseen)
    .toBe(waiting.invites.length + waiting.tag_requests.length);

  // Bob says yes: the tag shows for people who see the post.
  // (This run's request: earlier runs' leftovers may be there too.)
  const mine = bob.locator("[data-tag-request]").filter({ has: bob.locator(`a[href="/porch/p/${post.id}"]`) });
  const req = mine.first();
  await expect(req).toContainText("tagged you in a photo");
  await req.getByRole("button", { name: "Show it" }).click();
  await expect(bob.getByText("Your tag shows on the photo now.")).toBeVisible();
  await expect(mine).toHaveCount(0);
  await bob.goto(`/porch/p/${post.id}`);
  await bob.getByRole("button", { name: /Show who's in this photo/ }).click();
  await expect(bob.getByRole("list", { name: "Tagged in this photo" }).getByRole("link")).toHaveCount(1);
  const seen = await (await porch(alice, aAuth).get(`/porch/posts/${post.id}`)).json();
  expect(seen.media[0].tags[0].status).toBe("approved");

  // Dana can't see the post, its tag or anything about it.
  expect((await porch(dana, dAuth).get(`/porch/posts/${post.id}`)).status()).toBe(404);
  const dAct = await (await porch(dana, dAuth).get("/porch/activity")).json();
  expect(JSON.stringify(dAct)).not.toContain(post.id);
  expect(dAct.tag_requests).toEqual([]);
  void aliceId;

  await porch(alice, aAuth).del(`/porch/posts/${post.id}`);
  await porch(bob, bAuth).del(`/porch/posts/${his.id}`);
  await porch(dana, dAuth).del(`/porch/groups/${ladsId}`);
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
});

test("on a phone: the comments sheet, Activity in the bottom bar, and accessibility scans", async ({ alice, bob }) => {
  test.setTimeout(200_000);
  const [aAuth, bAuth] = [await bearer(alice), await bearer(bob)];
  const [, bobId] = [await porchReady(alice, aAuth), await porchReady(bob, bAuth)];
  const fam = `Phone ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth, bobId]]);
  const pic = await libraryPhoto(alice, aAuth, "PHONE");
  const post = await (await porch(alice, aAuth).post("/porch/posts", { kind: "photo", body: `At the park ${stamp}`, groups: [famId], media: [{ file_id: pic }] })).json();
  const c1 = await (await porch(bob, bAuth).post(`/porch/posts/${post.id}/comments`, { body: "Lovely light in this one" })).json();
  for (const body of ["Is that the old oak?", "Yes! Planted by Grandad", "No way"]) {
    await porch(alice, aAuth).post(`/porch/posts/${post.id}/comments`, { body, parent_id: c1.id });
  }
  await porch(bob, bAuth).put(`/porch/posts/${post.id}/reactions`, { emoji: "❤️" });
  await porch(bob, bAuth).post(`/porch/posts/${post.id}/comments`, { body: "Can't wait for the next picnic 🧺" });
  const found: string[] = [];

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.goto("/porch/");
  const nav = alice.getByRole("navigation", { name: "Porch" });
  await expect(nav.getByRole("link", { name: /Activity/ })).toBeVisible();
  const card = alice.locator(`article[data-post="${post.id}"]`);
  await expect(card.getByRole("button", { name: /View all 5 comments/ })).toBeVisible();
  found.push(...(await scan(alice, "phone feed with talk")));

  // The comments sheet: oldest first, replies collapsed after two.
  await card.getByRole("button", { name: /^Comment/ }).click();
  const sheet = alice.getByRole("dialog", { name: /Comments/ });
  await expect(sheet.getByText("Lovely light in this one")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "View 1 more reply" })).toBeVisible();
  await expect(sheet.getByRole("combobox", { name: "Add a comment" })).toBeVisible();
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(alice, "comments-sheet");
  found.push(...(await scan(alice, "phone comments sheet", "[role=dialog]")));
  await sheet.getByRole("button", { name: "View 1 more reply" }).click();
  await expect(sheet.getByText("No way")).toBeVisible();
  await sheet.getByRole("combobox", { name: "Add a comment" }).fill("See you there");
  await sheet.getByRole("button", { name: "Post comment" }).click();
  await expect(sheet.getByText("See you there")).toBeVisible();
  await alice.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: /View all 6 comments/ })).toBeVisible();

  // Hold the heart for the other reactions.
  await card.getByRole("button", { name: "More reactions" }).click();
  const menu = alice.getByRole("menu", { name: /React to/ });
  await menu.getByRole("menuitemradio", { name: "😂" }).click();
  await expect(card.getByRole("button", { name: /Take back your 😂/ })).toBeVisible();

  await nav.getByRole("link", { name: /Activity/ }).click();
  await expect(alice.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(alice.locator('[data-activity="comment"]').first()).toBeVisible();
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  found.push(...(await scan(alice, "phone activity")));

  await alice.goto(`/porch/p/${post.id}`);
  await expect(alice.getByRole("region", { name: "Comments" })).toBeVisible();
  found.push(...(await scan(alice, "phone post page")));

  expect(found, found.join("\n")).toEqual([]);
  await porch(alice, aAuth).del(`/porch/posts/${post.id}`);
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
});
