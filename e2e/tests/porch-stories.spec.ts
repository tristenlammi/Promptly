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
