import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";

/** Porch (WP-P1.3): the app's feed, groups, invites, live "new posts" pill,
 *  who can see what from the outside, public joins, the feed's ticks after a
 *  reload, a phone, first run and empty states — and an accessibility scan. */

/** A working access token (one the server just accepted: the stored one may
 *  have expired and been refreshed on load). */
async function bearer(page: Page): Promise<string> {
  const seen = page.waitForResponse((r) => !!r.request().headers()["authorization"] && r.url().includes("/api/") && r.ok());
  await page.goto("/files");
  await ready(page);
  return (await seen).request().headers()["authorization"];
}

const api = (page: Page, auth: string) => ({
  get: async (url: string) => page.request.get(`/api/porch${url}`, { headers: { Authorization: auth } }),
  post: async (url: string, data?: unknown) => page.request.post(`/api/porch${url}`, { headers: { Authorization: auth }, data }),
  patch: async (url: string, data?: unknown) => page.request.patch(`/api/porch${url}`, { headers: { Authorization: auth }, data }),
});

/** Ready for Porch: bootstrapped, first-run welcome already seen. */
async function porchReady(page: Page, auth: string) {
  const a = api(page, auth);
  expect((await a.get("/bootstrap")).ok()).toBe(true);
  expect((await a.patch("/me/profile", { welcomed: true })).ok()).toBe(true);
}

async function say(page: Page, auth: string, groups: string[] | "all", body: string): Promise<string> {
  const r = await api(page, auth).post("/posts", { kind: "text", body, groups });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as string;
}

/** The Porch area only (Promptly's own sidebar is checked elsewhere). */
async function scan(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include("#porch-scroll")
    .include("nav[aria-label='Porch']")
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("a private group: invite, accept, posts in the feed live — and invisible from outside", async ({ alice, bob, dana }) => {
  test.setTimeout(150_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  for (const [p, t] of [[alice, aAuth], [bob, bAuth], [dana, dAuth]] as const) await porchReady(p, t);
  const name = `Fam ${stamp}`;

  // Alice makes a private group (the default) and invites Bob.
  await alice.goto("/porch/groups");
  await expect(alice.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  await alice.getByRole("button", { name: "New group" }).first().click();
  const sheet = alice.getByRole("dialog", { name: "New group" });
  await sheet.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await expect(sheet.getByRole("radio", { name: /Private/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByLabel("Find people by name").fill(run.users.bob.username);
  await sheet.getByRole("checkbox", { name: new RegExp(run.users.bob.username) }).click();
  await sheet.getByRole("button", { name: "Make group" }).click();
  await expect(alice).toHaveURL(/\/porch\/g\/[0-9a-f-]{36}$/);
  const gid = alice.url().split("/").pop()!;
  await expect(alice.getByRole("heading", { name: new RegExp(name) }).first()).toBeVisible();
  await alice.getByRole("radio", { name: "Invites" }).click();
  await expect(alice.getByText(/Invited by/)).toBeVisible();

  // Bob gets the invite (live, with a badge) and joins.
  await bob.goto("/porch/groups");
  const invite = bob.locator("#porch-scroll").getByText(new RegExp(`invited you to.*${name}`));
  await expect(invite).toBeVisible();
  // The badge is on Activity (WP-P1.5), counting the invite.
  await expect(bob.getByRole("link", { name: /Activity\s*\d+ new/ })).toBeVisible();
  await bob.locator(`#porch-scroll [data-invite="${gid}"]`).getByRole("button", { name: "Join", exact: true }).click();
  await expect(bob.getByText(`You're in ${name}. Its posts are in your feed.`)).toBeVisible();

  // Alice posts to it; Bob sees it in his feed, with the group named.
  const first = `First family news ${stamp}`;
  const p1 = await say(alice, aAuth, [gid], first);
  await bob.goto("/porch/");
  const card = bob.locator(`article[data-post="${p1}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(first);
  await expect(card).toContainText(`in ${name}`);

  // While Bob's looking, another arrives: the "new posts" pill, not a jump.
  const second = `Second family news ${stamp}`;
  const p2 = await say(alice, aAuth, [gid], second);
  const pill = bob.getByRole("button", { name: /1 new post/ });
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await expect(bob.locator(`article[data-post="${p2}"]`)).toHaveCount(0);
  await pill.click();
  await expect(bob.locator(`article[data-post="${p2}"]`)).toBeVisible();

  // Dana, outside it: no group, no post, by id or anywhere else.
  const d = api(dana, dAuth);
  expect((await d.get(`/groups/${gid}`)).status()).toBe(404);
  expect((await d.get(`/posts/${p1}`)).status()).toBe(404);
  expect(JSON.stringify(await (await d.get("/groups/discover")).json())).not.toContain(name);
  await dana.goto(`/porch/g/${gid}`);
  await expect(dana.getByText("This group isn't available")).toBeVisible();
  await dana.goto(`/porch/p/${p1}`);
  await expect(dana.getByText("This post isn't available")).toBeVisible();
  await dana.goto("/porch/");
  // On a wide screen the feed's groups are the left-hand ticks.
  await expect(dana.getByRole("group", { name: "In your feed" })).toBeVisible();
  await expect(dana.getByText(first)).toHaveCount(0);
  await expect(dana.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
  await expect(dana.getByRole("checkbox", { name: new RegExp(name) })).toHaveCount(0);

  // The post's own page; then Alice deletes it and it's gone for Bob.
  await bob.goto(`/porch/p/${p1}`);
  await expect(bob.getByText(first)).toBeVisible();
  await alice.goto(`/porch/p/${p1}`);
  await alice.getByRole("button", { name: "More for this post" }).click();
  await alice.getByRole("button", { name: "Delete post" }).click();
  await alice.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(alice.getByText("Post deleted.")).toBeVisible();
  await bob.reload();
  await expect(bob.getByText("This post isn't available")).toBeVisible();

  // Tidy: Alice deletes the group.
  await alice.goto(`/porch/g/${gid}`);
  await alice.getByRole("button", { name: `More for ${name}` }).click();
  await alice.getByRole("button", { name: "Delete group" }).click();
  await alice.getByRole("button", { name: "Delete group" }).last().click();
  await expect(alice.getByText(`${name} was deleted.`)).toBeVisible();
});

test("a public group: found, joined in one tap, its older posts there at once", async ({ alice, dana }) => {
  test.setTimeout(120_000);
  const [aAuth, dAuth] = [await bearer(alice), await bearer(dana)];
  await porchReady(alice, aAuth);
  await porchReady(dana, dAuth);
  const name = `Fishing ${stamp}`;
  const r = await api(alice, aAuth).post("/groups", { name, visibility: "public", emoji: "🎣", about: "Weekend trips" });
  expect(r.status()).toBe(201);
  const gid = (await r.json()).id as string;
  const older = `Caught a flathead ${stamp}`;
  const pid = await say(alice, aAuth, [gid], older);

  // From outside: the outline, never the posts.
  expect((await api(dana, dAuth).get(`/groups/${gid}/posts`)).status()).toBe(403);
  await dana.goto(`/porch/g/${gid}`);
  await expect(dana.getByText("Posts show once you join. You're in straight away.")).toBeVisible();
  await expect(dana.getByText(older)).toHaveCount(0);

  // Find groups → Join.
  await dana.goto("/porch/groups#find");
  await dana.getByLabel("Filter public groups").fill(stamp);
  await dana.locator("#find").getByRole("button", { name: `Join ${name}` }).click();
  await expect(dana.getByText(`You're in ${name}. Its posts are in your feed.`)).toBeVisible();
  await dana.goto(`/porch/g/${gid}`);
  await expect(dana.locator(`article[data-post="${pid}"]`)).toContainText(older);
  await dana.goto("/porch/");
  await expect(dana.locator(`article[data-post="${pid}"]`)).toBeVisible();

  // Leave it again (and Alice tidies up).
  await dana.goto(`/porch/g/${gid}`);
  await dana.getByRole("button", { name: `More for ${name}` }).click();
  await dana.getByRole("button", { name: "Leave group" }).click();
  await dana.getByRole("button", { name: "Leave group" }).last().click();
  await expect(dana).toHaveURL(/\/porch\/groups$/);
  expect((await api(alice, aAuth).get(`/groups/${gid}`)).ok()).toBe(true);
  await alice.request.delete(`/api/porch/groups/${gid}`, { headers: { Authorization: aAuth } });
});

test("the feed's ticks are saved: unticked stays unticked after a reload", async ({ bob }) => {
  const auth = await bearer(bob);
  await porchReady(bob, auth);
  // A wide screen ticks groups in the left column (no chip row there).
  await bob.goto("/porch/");
  await expect(bob.getByRole("group", { name: "Groups in your feed" })).toBeHidden();
  const ticks = bob.getByRole("group", { name: "In your feed" });
  const box = ticks.getByRole("checkbox", { name: /Everyone/ });
  await expect(box).toHaveAttribute("aria-checked", "true");
  let saved = bob.waitForResponse((r) => r.url().includes("/api/porch/groups/") && r.url().endsWith("/me") && r.request().method() === "PATCH");
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "false");
  expect((await saved).ok()).toBe(true);
  await bob.reload();
  await expect(ticks.getByRole("checkbox", { name: /Everyone/ })).toHaveAttribute("aria-checked", "false");
  saved = bob.waitForResponse((r) => r.url().endsWith("/me") && r.request().method() === "PATCH");
  await ticks.getByRole("checkbox", { name: /Everyone/ }).click();
  await expect(ticks.getByRole("checkbox", { name: /Everyone/ })).toHaveAttribute("aria-checked", "true");
  await saved;

  // A phone or tablet ticks them as chips, saved the same way.
  await bob.setViewportSize({ width: 820, height: 1000 });
  await bob.goto("/porch/");
  const chips = bob.getByRole("group", { name: "Groups in your feed" });
  const everyone = chips.getByRole("button", { name: /Everyone/ });
  await expect(everyone).toHaveAttribute("aria-pressed", "true");
  saved = bob.waitForResponse((r) => r.url().includes("/api/porch/groups/") && r.url().endsWith("/me") && r.request().method() === "PATCH");
  await everyone.click();
  await expect(everyone).toHaveAttribute("aria-pressed", "false");
  expect((await saved).ok()).toBe(true);
  await bob.reload();
  await expect(chips.getByRole("button", { name: /Everyone/ })).toHaveAttribute("aria-pressed", "false");
  // And back on.
  await chips.getByRole("button", { name: /Everyone/ }).click();
  await expect(chips.getByRole("button", { name: /Everyone/ })).toHaveAttribute("aria-pressed", "true");
  await bob.waitForResponse((r) => r.url().endsWith("/me") && r.request().method() === "PATCH");
});

test("on a phone: its own app with a bottom bar, and the screens pass an accessibility scan", async ({ alice }) => {
  test.setTimeout(120_000);
  const auth = await bearer(alice);
  await porchReady(alice, auth);
  const pid = await say(alice, auth, "all", `Hello from the phone test ${stamp}`);
  const found: string[] = [];

  // Desktop first (inside Promptly).
  await alice.goto("/porch/");
  await expect(alice.locator(`article[data-post="${pid}"]`)).toBeVisible();
  found.push(...(await scan(alice, "desktop feed")));

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.goto("/porch/");
  const bar = alice.getByRole("navigation", { name: "Porch" });
  await expect(bar).toBeVisible();
  for (const label of ["Feed", "Groups", "New post", "Profile"]) await expect(bar.getByRole(label === "New post" ? "button" : "link", { name: label })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "Porch", exact: true })).toBeVisible();
  await expect(alice.locator(`article[data-post="${pid}"]`)).toBeVisible();
  // Nothing wider than the screen.
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  found.push(...(await scan(alice, "phone feed")));

  await bar.getByRole("link", { name: "Groups" }).click();
  await expect(alice.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  found.push(...(await scan(alice, "phone groups")));

  await bar.getByRole("link", { name: "Profile" }).click();
  await expect(alice.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Back to Promptly" })).toBeVisible();
  found.push(...(await scan(alice, "phone profile")));

  await alice.goto(`/porch/p/${pid}`);
  await expect(alice.getByText(`Hello from the phone test ${stamp}`)).toBeVisible();
  found.push(...(await scan(alice, "phone post")));

  await alice.goto("/porch/groups");
  await alice.getByRole("link", { name: /Everyone/ }).first().click();
  await expect(alice.getByText(/Everyone on this Promptly is here/)).toBeVisible();
  found.push(...(await scan(alice, "phone group")));

  // Tidy.
  await alice.request.delete(`/api/porch/posts/${pid}`, { headers: { Authorization: auth } });
  expect(found, found.join("\n")).toEqual([]);
});

test("first run on a one-person server, and Porch turned off", async ({ alice }) => {
  await bearer(alice);
  // As if Alice were the only person here, opening Porch for the first time.
  await alice.route("**/api/porch/bootstrap", async (route: Route) => {
    const res = await route.fetch();
    const b = await res.json();
    b.profile.welcomed = false;
    b.invites = [];
    b.groups = b.groups.filter((g: { kind: string }) => g.kind === "everyone").map((g: object) => ({ ...g, in_feed: true, member_count: 1 }));
    b.everyone.member_count = 1;
    await route.fulfill({ response: res, json: b });
  });
  await alice.route("**/api/porch/feed?*", (route: Route) => route.fulfill({ json: { posts: [], next: null, ticked: [], feed_seen_at: null } }));
  await alice.route("**/api/porch/feed", (route: Route) => route.fulfill({ json: { posts: [], next: null, ticked: [], feed_seen_at: null } }));
  await alice.route("**/api/porch/groups/discover*", (route: Route) => route.fulfill({ json: [] }));
  await alice.route("**/api/porch/people/suggested", (route: Route) => route.fulfill({ json: [] }));
  await alice.route("**/api/porch/me/profile", (route: Route) => route.fulfill({ json: {} }));
  await alice.goto("/porch/");
  const welcome = alice.getByRole("dialog", { name: "Welcome to Porch" });
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("You're in Everyone (1 person).");
  await expect(welcome.getByRole("button", { name: "Make a group" })).toBeVisible();
  await welcome.getByRole("button", { name: "Start" }).click();
  await expect(alice.getByText("It's quiet on the Porch")).toBeVisible();
  await expect(alice.getByRole("button", { name: "New post" }).last()).toBeVisible();
  await expect(alice.getByRole("button", { name: "Make a group" })).toBeVisible();
  await alice.unrouteAll({ behavior: "ignoreErrors" });

  // Turned off for her: one plain message.
  await alice.route("**/api/porch/bootstrap", (route: Route) => route.fulfill({ status: 404, json: { detail: "Porch isn't turned on for you" } }));
  await alice.goto("/porch/");
  await expect(alice.getByText("Porch isn't turned on for you. Ask the person who runs this Promptly.")).toBeVisible();
});
