import fs from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";
import { wordPhoto } from "../lib/files";

/** Porch's composer (WP-P1.4): pick photos from your library, put them in
 *  order, crop one for this post only (the library photo stays as it is),
 *  describe them, post to some groups (an outsider can't see it), mention
 *  only people who can see it; a life event with a new upload that lands in
 *  Photos once; editing a post's photos and place; and a phone with an
 *  accessibility scan. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForResponse((r) => !!r.request().headers()["authorization"] && r.url().includes("/api/") && r.ok());
  await page.goto("/files");
  await ready(page);
  return (await seen).request().headers()["authorization"];
}

const porch = (page: Page, auth: string) => ({
  get: async (url: string) => page.request.get(`/api${url}`, { headers: { Authorization: auth } }),
  post: async (url: string, data?: unknown) => page.request.post(`/api${url}`, { headers: { Authorization: auth }, data }),
  patch: async (url: string, data?: unknown) => page.request.patch(`/api${url}`, { headers: { Authorization: auth }, data }),
  del: async (url: string) => page.request.delete(`/api${url}`, { headers: { Authorization: auth } }),
});

async function porchReady(page: Page, auth: string) {
  const a = porch(page, auth);
  expect((await a.get("/porch/bootstrap")).ok()).toBe(true);
  expect((await a.patch("/porch/me/profile", { welcomed: true })).ok()).toBe(true);
}

/** A photo in this person's library, its tile ready. */
async function libraryPhoto(page: Page, auth: string, word: string): Promise<string> {
  const name = `porch-${word.toLowerCase()}-${stamp}.jpg`;
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, word)) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json()).id as string;
  await expect
    .poll(async () => (await (await page.request.get(`/api/files/${id}/signed-urls`, { headers: { Authorization: auth } })).json()).state, { timeout: 60_000 })
    .toBe("ready");
  return id;
}

/** A private group of ``owner``'s with these people in it. */
async function groupWith(owner: Page, oAuth: string, name: string, members: [Page, string][]): Promise<string> {
  const ids = await Promise.all(members.map(async ([, auth]) => (await (await porch(owner, auth).get("/porch/bootstrap")).json()).me.id as string));
  const r = await porch(owner, oAuth).post("/porch/groups", { name, visibility: "private", invite: ids });
  expect(r.status(), await r.text()).toBe(201);
  const gid = (await r.json()).id as string;
  for (const [p, auth] of members) expect((await porch(p, auth).post(`/porch/groups/${gid}/accept`)).ok()).toBe(true);
  return gid;
}

async function scan(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include("#porch-scroll")
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function scanDialog(page: Page, what: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include("[role=dialog]").analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("three photos, reordered, one cropped for this post only, to one group: mentions and outsiders", async ({ alice, bob, dana }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  for (const [p, t] of [[alice, aAuth], [bob, bAuth], [dana, dAuth]] as const) await porchReady(p, t);
  const fam = `Fam ${stamp}`;
  const famId = await groupWith(alice, aAuth, fam, [[bob, bAuth]]);
  const lads = await groupWith(alice, aAuth, `Lads ${stamp}`, [[dana, dAuth]]);
  const [one, two, three] = [await libraryPhoto(alice, aAuth, "ONE"), await libraryPhoto(alice, aAuth, "TWO"), await libraryPhoto(alice, aAuth, "THREE")];

  // Pick: three from the library, in this order.
  await alice.goto("/porch/new");
  await expect(alice.getByRole("heading", { name: "Pick photos" })).toBeVisible();
  for (const id of [one, two, three]) await alice.locator(`[data-photo="${id}"]`).click();
  await expect(alice.locator(`[data-photo="${three}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(alice.locator(`[data-photo="${three}"]`)).toHaveAccessibleName(/picked 3$/);
  await alice.getByRole("button", { name: "Next" }).first().click();

  // Arrange: the third goes first.
  await expect(alice.getByRole("heading", { name: "Arrange" })).toBeVisible();
  const strip = alice.getByRole("list", { name: "Order of photos" });
  await strip.getByRole("button", { name: /Photo 3 of 3/ }).click();
  await alice.getByRole("button", { name: "Move earlier" }).click();
  await alice.getByRole("button", { name: "Move earlier" }).click();
  await expect(strip.getByRole("button", { name: /Photo 1 of 3, showing/ })).toBeVisible();

  // Crop it square and give it the Mono look, for this post only.
  await alice.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = alice.getByRole("dialog", { name: "Edit for this post" });
  await expect(editor).toContainText("The photo in your library stays as it is.");
  await expect(editor.getByRole("tab", { name: "Mark up" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Square" }).click();
  await editor.getByRole("tab", { name: "Filters" }).click();
  await editor.getByRole("radio", { name: "Mono" }).click();
  await expect(editor.getByRole("radio", { name: "Mono" })).toHaveAttribute("aria-checked", "true");
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toBeHidden();
  await expect(alice.getByText("For this post: cropped, Mono. The photo in your library stays as it is.")).toBeVisible();
  // Describe the second.
  await strip.getByRole("button", { name: /Photo 2 of 3/ }).click();
  await alice.getByLabel("Describe this photo").fill("The word ONE in black");
  await alice.getByRole("button", { name: "Next" }).first().click();

  // Share: Family only.
  await expect(alice.getByRole("heading", { name: "Share" })).toBeVisible();
  await alice.getByRole("button", { name: /Share to/ }).click();
  const who = alice.getByRole("dialog", { name: "Share to" });
  await who.getByRole("radio", { name: /Choose groups/ }).click();
  await who.getByRole("checkbox", { name: new RegExp(fam) }).click();
  await who.getByRole("button", { name: "Done" }).click();
  await expect(alice.getByRole("button", { name: /Share to/ })).toContainText(fam);

  // The mention picker offers Bob (in Family), never Dana (not in it).
  const caption = alice.getByRole("combobox", { name: "Caption" });
  const options = alice.getByRole("listbox", { name: "People who'll see this post" });
  await caption.fill("Who's around? ");
  await caption.press("End");
  await caption.pressSequentially("@");
  await expect(options.getByRole("option", { name: new RegExp(run.users.bob.username) })).toBeVisible();
  await expect(options.getByRole("option", { name: new RegExp(run.users.dana.username) })).toHaveCount(0);
  await caption.pressSequentially(run.users.dana.username.slice(0, 5));
  await expect(alice.getByText(/will see this post\./)).toBeVisible();
  await expect(alice.getByRole("option", { name: new RegExp(run.users.dana.username) })).toHaveCount(0);
  await caption.fill("Beach day with ");
  await caption.press("End");
  await caption.pressSequentially(`@${run.users.bob.username.slice(0, 5)}`);
  await options.getByRole("option", { name: new RegExp(run.users.bob.username) }).click();
  await expect(caption).toHaveValue(`Beach day with @${run.users.bob.username} `);
  await expect(alice.getByRole("list", { name: "Mentioned" }).getByRole("listitem")).toHaveCount(1);

  // A place, as typed (the map isn't needed for that).
  await alice.getByRole("button", { name: "Add a place" }).click();
  const placeSheet = alice.getByRole("dialog", { name: "Add a place" });
  await placeSheet.getByRole("searchbox", { name: "Search for a place" }).fill("Noosa Heads");
  await placeSheet.getByRole("button", { name: /Use “Noosa Heads”/ }).click();
  await expect(alice.getByRole("button", { name: /Place\s*Noosa Heads/ })).toBeVisible();

  const posted = alice.waitForResponse((r) => r.url().endsWith("/api/porch/posts") && r.request().method() === "POST");
  await alice.getByRole("button", { name: "Post", exact: true }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  const post = await res.json();
  expect(post.media.map((m: { file_id: string }) => m.file_id)).toEqual([three, one, two]);
  expect(post.media[0].edit.crop).not.toBeNull();
  expect(post.media[0].edit.saturation).toBe(-1);
  expect(post.media[1].alt_text).toBe("The word ONE in black");
  expect(post.groups.map((g: { id: string }) => g.id)).toEqual([famId]);
  expect(post.place.name).toBe("Noosa Heads");
  expect(post.mentions.map((m: { username: string }) => m.username)).toEqual([run.users.bob.username]);
  await expect(alice).toHaveURL(/\/porch\/$/);
  await expect(alice.locator(`article[data-post="${post.id}"]`)).toContainText(`in ${fam}`);

  // The library photo isn't changed: no edit in Photos, the original as it was.
  const lib = await (await porch(alice, aAuth).get(`/photos/files/${three}/edit`)).json();
  expect(lib.ops).toBeNull();
  expect((await (await porch(alice, aAuth).get(`/files/${three}/signed-urls`)).json()).edited).toBeFalsy();

  // Bob sees it in this order, the first one square, with his name linked.
  const seen = await (await porch(bob, bAuth).get(`/porch/posts/${post.id}`)).json();
  expect(seen.media.map((m: { id: string }) => m.id)).toEqual(post.media.map((m: { id: string }) => m.id));
  expect(seen.media[0].width).toBe(seen.media[0].height);
  await bob.goto(`/porch/p/${post.id}`);
  await expect(bob.getByRole("link", { name: `@${run.users.bob.username}` })).toBeVisible();
  await expect(bob.getByText("Noosa Heads")).toBeVisible();

  // Dana (in Lads, not Family) can't see it at all.
  expect((await porch(dana, dAuth).get(`/porch/posts/${post.id}`)).status()).toBe(404);
  await dana.goto("/porch/");
  await expect(dana.locator(`article[data-post="${post.id}"]`)).toHaveCount(0);

  // Tidy.
  await porch(alice, aAuth).del(`/porch/posts/${post.id}`);
  await porch(alice, aAuth).del(`/porch/groups/${famId}`);
  await porch(alice, aAuth).del(`/porch/groups/${lads}`);
});

test("a life event with a new upload (in Photos once), then its photos and place edited", async ({ alice }) => {
  test.setTimeout(240_000);
  const auth = await bearer(alice);
  await porchReady(alice, auth);
  const kept = await libraryPhoto(alice, auth, "KEPT");
  const name = `porch-job-${stamp}.jpg`;
  const file = wordPhoto(name, "NEW JOB");

  await alice.goto("/porch/new");
  await expect(alice.getByRole("heading", { name: "Pick photos" })).toBeVisible();
  const uploaded = alice.waitForResponse((r) => /\/api\/files\/?$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await alice.getByTestId("porch-upload").setInputFiles(file);
  const up = await uploaded;
  expect(up.ok(), await up.text()).toBe(true);
  const newId = (await up.json()).id as string;
  await expect(alice.getByRole("list", { name: "Picked" }).getByRole("listitem")).toHaveCount(1);
  await alice.getByRole("button", { name: "Next" }).first().click();
  await alice.getByRole("button", { name: "Next" }).first().click();

  // A life event: New job, with its day.
  await alice.getByRole("button", { name: "Life event" }).click();
  const sheet = alice.getByRole("dialog", { name: "Life event" });
  await sheet.getByRole("radio", { name: "New job" }).click();
  await sheet.getByLabel("In a few words (optional)").fill(`Started at the council ${stamp}`);
  await sheet.getByLabel("When").fill("2026-11-02");
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(alice.getByText(`Started at the council ${stamp}`)).toBeVisible();
  await alice.getByRole("combobox", { name: "Caption" }).fill("First day tomorrow!");

  const posted = alice.waitForResponse((r) => r.url().endsWith("/api/porch/posts") && r.request().method() === "POST");
  await alice.getByRole("button", { name: "Post", exact: true }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  const post = await res.json();
  expect(post.kind).toBe("life_event");
  expect(post.life_event).toEqual({ type: "new_job", title: `Started at the council ${stamp}`, date: "2026-11-02" });
  expect(post.media.map((m: { file_id: string }) => m.file_id)).toEqual([newId]);
  await expect(alice.locator(`article[data-post="${post.id}"]`)).toContainText(`Started at the council ${stamp}`);

  // The upload is in Photos, once.
  const tl = await (await porch(alice, auth).get("/photos/timeline?view=all&limit=300")).json();
  expect(tl.items.filter((p: { id: string; filename: string }) => p.id === newId || p.filename === name)).toHaveLength(1);

  // Edit: swap the photo for another and change the place.
  await alice.goto(`/porch/p/${post.id}`);
  await alice.getByRole("button", { name: "More for this post" }).click();
  await alice.getByRole("button", { name: /Edit post/ }).click();
  await expect(alice.getByRole("heading", { name: "Edit post" })).toBeVisible();
  await expect(alice.getByText(/A post's groups stay as they were/)).toBeVisible();
  await alice.getByRole("button", { name: "Edit photos" }).click();
  await alice.getByRole("button", { name: "Add more photos" }).click();
  await alice.locator(`[data-photo="${kept}"]`).click();
  await alice.getByRole("button", { name: "Next" }).first().click();
  const strip = alice.getByRole("list", { name: "Order of photos" });
  await strip.getByRole("button", { name: /Photo 1 of 2/ }).click();
  await alice.getByRole("button", { name: "Take this one out" }).click();
  await expect(strip.getByRole("button", { name: /of 1/ })).toHaveCount(1);
  await alice.getByRole("button", { name: "Next" }).first().click();
  await alice.getByRole("button", { name: "Add a place" }).click();
  await alice.getByRole("dialog", { name: "Add a place" }).getByRole("searchbox").fill("Council chambers");
  await alice.getByRole("dialog", { name: "Add a place" }).getByRole("button", { name: /Use “Council chambers”/ }).click();
  const saved = alice.waitForResponse((r) => r.url().endsWith(`/api/porch/posts/${post.id}`) && r.request().method() === "PATCH");
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  const out = await (await saved).json();
  expect(out.media.map((m: { file_id: string }) => m.file_id)).toEqual([kept]);
  expect(out.place.name).toBe("Council chambers");
  expect(out.edited_at).toBeTruthy();
  await expect(alice).toHaveURL(new RegExp(`/porch/p/${post.id}$`));
  await expect(alice.getByText("Council chambers")).toBeVisible();
  await expect(alice.getByText("· edited")).toBeVisible();
  // Taking a photo out of a post leaves it in the library.
  expect((await (await porch(alice, auth).get(`/files/${newId}/signed-urls`)).json()).state).toBe("ready");

  await porch(alice, auth).del(`/porch/posts/${post.id}`);
});

test("on a phone: the composer is full screen and passes an accessibility scan; chips there, ticks on a wide screen", async ({ alice }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  await porchReady(alice, auth);
  const pic = await libraryPhoto(alice, auth, "PHONE");
  const found: string[] = [];

  // Wide screen: the left-hand ticks are the feed's picker; no chip row.
  await alice.goto("/porch/");
  await expect(alice.getByRole("group", { name: "In your feed" }).getByRole("checkbox").first()).toBeVisible();
  await expect(alice.getByRole("group", { name: "Groups in your feed" })).toBeHidden();

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.goto("/porch/");
  const chips = alice.getByRole("group", { name: "Groups in your feed" });
  await expect(chips).toBeVisible();
  found.push(...(await scan(alice, "phone feed chips")));

  await alice.getByRole("navigation", { name: "Porch" }).getByRole("button", { name: "New post" }).click();
  await expect(alice).toHaveURL(/\/porch\/new$/);
  await expect(alice.getByRole("navigation", { name: "Porch" })).toHaveCount(0);
  await expect(alice.getByRole("heading", { name: "Pick photos" })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Camera" })).toBeVisible();
  await alice.locator(`[data-photo="${pic}"]`).click();
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  found.push(...(await scan(alice, "phone pick")));

  await alice.getByRole("button", { name: "Next" }).first().click();
  await expect(alice.getByRole("heading", { name: "Arrange" })).toBeVisible();
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  found.push(...(await scan(alice, "phone arrange")));

  await alice.getByRole("button", { name: "Next" }).first().click();
  await expect(alice.getByRole("heading", { name: "Share" })).toBeVisible();
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  found.push(...(await scan(alice, "phone share")));
  await alice.getByRole("button", { name: /Share to/ }).click();
  await alice.getByRole("dialog", { name: "Share to" }).getByRole("radio", { name: /Choose groups/ }).click();
  found.push(...(await scanDialog(alice, "phone audience sheet")));
  await alice.keyboard.press("Escape");

  // Leaving keeps a draft, offered next time.
  await alice.getByRole("button", { name: "Back" }).click();
  await alice.getByRole("button", { name: "Back" }).click();
  await alice.getByRole("button", { name: "Close" }).click();
  await alice.goto("/porch/new");
  await expect(alice.getByText("Here's the post you started before.")).toBeVisible();
  await alice.getByRole("button", { name: "Throw it away" }).click();
  await alice.getByRole("button", { name: "Throw away", exact: true }).click();
  await expect(alice.getByText("Here's the post you started before.")).toHaveCount(0);

  expect(found, found.join("\n")).toEqual([]);
});
