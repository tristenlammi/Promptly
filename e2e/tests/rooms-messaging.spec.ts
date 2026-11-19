// Rooms messaging between two people, in the real pages: a message arriving
// live with Sent → Seen under it, a photo, a poll whose counts move as the
// other person votes, a voice message from Chromium's fake microphone, muting
// a conversation, and the latest message staying in view when the screen gets
// shorter (what an on-screen keyboard does to a phone).
//
// Everything happens in the one conversation between alice and bob. Its
// messages stay between runs (the seeded users persist), so every assertion
// looks for this run's own text.
import { type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";

// A fake microphone for the voice message: Chromium plays a tone into it.
test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });
test.describe.configure({ mode: "serial" });

type Api = {
  get: (url: string) => Promise<import("@playwright/test").APIResponse>;
  post: (url: string, data?: unknown) => Promise<import("@playwright/test").APIResponse>;
  patch: (url: string, data?: unknown) => Promise<import("@playwright/test").APIResponse>;
  del: (url: string) => Promise<import("@playwright/test").APIResponse>;
};

const api = (page: Page, auth: string): Api => ({
  get: (url) => page.request.get(`/api${url}`, { headers: { Authorization: auth } }),
  post: (url, data) => page.request.post(`/api${url}`, { headers: { Authorization: auth }, data }),
  patch: (url, data) => page.request.patch(`/api${url}`, { headers: { Authorization: auth }, data }),
  del: (url) => page.request.delete(`/api${url}`, { headers: { Authorization: auth } }),
});

/** The signed-in page's bearer token, from its own first API call. */
async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

/** A 2×2 PNG: enough to be a photo. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQImWP8z8Dwn4GBgYGJAQoAHxcCAr3oJ1AAAAAASUVORK5CYII=",
  "base64",
);

const log = (page: Page) => page.getByRole("log");
const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ }).first();

let dm = "";
let aAuth = "";
let bAuth = "";

async function setUp(alice: Page, bob: Page) {
  if (!aAuth) aAuth = await bearer(alice);
  if (!bAuth) bAuth = await bearer(bob);
  if (!dm) {
    const r = await api(alice, aAuth).post("/rooms/dms", { user_ids: [run.users.bob.id] });
    expect(r.ok(), await r.text()).toBe(true);
    dm = (await r.json()).id;
    // Earlier runs may have left it muted.
    await api(bob, bAuth).patch(`/rooms/rooms/${dm}/me`, { notify: "all", muted_until: null });
  }
}

test("a message arrives live, and goes from Sent to Seen", async ({ alice, bob }) => {
  await setUp(alice, bob);
  const words = `Dinner at seven? ${stamp}`;
  // Bob is somewhere else in Promptly: nothing has reached a page of his.
  await bob.goto("/files");
  await alice.goto(`/rooms/r/${dm}`);
  await box(alice).fill(words);
  await box(alice).press("Enter");
  const mine = log(alice).getByText(words);
  await expect(mine).toBeVisible();
  // Under her latest message: Sent or Delivered, not yet Seen.
  await expect(log(alice).getByRole("note").last()).toHaveText(/^(Sent|Delivered)$/);

  // He opens the conversation: it's there without a reload on her side.
  await bob.goto(`/rooms/r/${dm}`);
  await expect(log(bob).getByText(words)).toBeVisible();
  await expect(log(alice).getByRole("note", { name: `Seen by ${run.users.bob.username}` })).toBeVisible({ timeout: 20_000 });

  // And his answer shows on her page as it's sent.
  const back = `Seven works ${stamp}`;
  await box(bob).fill(back);
  await box(bob).press("Enter");
  await expect(log(alice).getByText(back)).toBeVisible({ timeout: 20_000 });
});

test("the Photos picker takes pictures and videos only, and what you pick is attached", async ({ alice, bob }) => {
  await setUp(alice, bob);
  await alice.goto(`/rooms/r/${dm}`);
  const pick = alice.getByTestId("composer-photo-input");
  // Photos and videos only is what makes a phone open its photo picker, not the file browser.
  await expect(pick).toHaveAttribute("accept", "image/*,video/*");
  await expect(pick).toHaveAttribute("multiple", "");
  const name = `e2e-pick-${stamp}.png`;
  await pick.setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(alice.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  await alice.getByRole("button", { name: `Remove ${name}` }).click();
});

test("a photo is sent and shows for both", async ({ alice, bob }) => {
  await setUp(alice, bob);
  await bob.goto(`/rooms/r/${dm}`);
  await alice.goto(`/rooms/r/${dm}`);
  const name = `e2e-${stamp}.png`;
  await alice.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(alice.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  const caption = `The view ${stamp}`;
  await box(alice).fill(caption);
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  // Send leaves you in the typing box, so a phone keeps its keyboard up for the next message.
  await expect(box(alice)).toBeFocused();
  for (const page of [alice, bob]) {
    await expect(log(page).getByText(caption)).toBeVisible({ timeout: 20_000 });
    // The picture itself, loaded (not a broken image).
    const img = log(page).locator("img").last();
    await expect(img).toBeVisible();
    await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
});

test("a poll's counts move as the other person votes", async ({ alice, bob }) => {
  await setUp(alice, bob);
  await bob.goto(`/rooms/r/${dm}`);
  await alice.goto(`/rooms/r/${dm}`);
  const question = `Pizza or curry ${stamp}?`;
  await alice.getByRole("button", { name: "Add a file, poll or event" }).click();
  await alice.getByRole("menuitem", { name: /Ask a poll/ }).click();
  const sheet = alice.getByRole("dialog", { name: "Ask a poll" });
  await sheet.getByPlaceholder("Where should we go for lunch?").fill(question);
  await sheet.getByLabel("Answer 1").fill("Pizza");
  await sheet.getByLabel("Answer 2").fill("Curry");
  await sheet.getByRole("button", { name: "Send poll" }).click();

  const hers = log(alice).getByRole("group", { name: `Poll: ${question}` }).or(log(alice).getByLabel(`Poll: ${question}`)).first();
  const his = log(bob).getByLabel(`Poll: ${question}`).first();
  await expect(hers).toBeVisible({ timeout: 20_000 });
  await expect(his).toBeVisible({ timeout: 20_000 });
  await his.getByRole("button", { name: /^Curry: 0 votes/ }).click();
  await expect(his.getByRole("button", { name: "Curry: 1 vote, your answer" })).toBeVisible();
  // Her page hears about it with no reload.
  await expect(hers.getByRole("button", { name: "Curry: 1 vote" })).toBeVisible({ timeout: 20_000 });
  // He changes his mind.
  await his.getByRole("button", { name: /^Pizza: 0 votes/ }).click();
  await expect(hers.getByRole("button", { name: "Pizza: 1 vote" })).toBeVisible({ timeout: 20_000 });
  await expect(hers.getByRole("button", { name: "Curry: 0 votes" })).toBeVisible();
});

test("a voice message is recorded, sent and can be played by the other person", async ({ alice, bob }) => {
  await setUp(alice, bob);
  const features = (await (await api(alice, aAuth).get("/rooms/bootstrap")).json()).features ?? {};
  test.skip(features.voice === false, "voice messages are switched off on this server (Admin → Rooms)");
  await bob.goto(`/rooms/r/${dm}`);
  await alice.goto(`/rooms/r/${dm}`);
  const before = await log(bob).getByRole("button", { name: /voice message/i }).count();
  // On a computer a click starts it and Send ends it.
  await alice.getByRole("button", { name: "Record a voice message" }).click();
  await expect(alice.getByRole("button", { name: "Send voice message" })).toBeVisible({ timeout: 15_000 });
  await alice.waitForTimeout(2_500); // something to listen to
  await alice.getByRole("button", { name: "Send voice message" }).click();
  // It reaches him unplayed, with a length.
  const play = log(bob).getByRole("button", { name: "Play voice message (not played yet)" }).last();
  await expect(play).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => log(bob).getByRole("button", { name: /voice message/i }).count()).toBeGreaterThan(before);
  await play.click();
  await expect(log(bob).getByRole("button", { name: "Pause voice message" }).last()).toBeVisible({ timeout: 15_000 });
});

test("a muted conversation says so and doesn't count as unread", async ({ alice, bob }) => {
  await setUp(alice, bob);
  const b = api(bob, bAuth);
  const unread = async () => {
    const rooms = ((await (await b.get("/rooms/bootstrap")).json()).dms ?? []) as { id: string; muted_until?: string | null; unread?: number }[];
    return rooms.find((r) => r.id === dm);
  };
  await bob.goto("/files"); // not looking at it
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  expect((await b.patch(`/rooms/rooms/${dm}/me`, { muted_until: until })).ok()).toBe(true);
  try {
    expect((await api(alice, aAuth).post(`/rooms/rooms/${dm}/messages`, { body: `While you were muted ${stamp}` })).ok()).toBe(true);
    const row = await unread();
    expect(row?.muted_until, "the conversation is muted").toBeTruthy();
    // His conversation list shows it muted.
    await bob.goto("/rooms/dm");
    const mine = bob.getByRole("navigation", { name: "Messages" }).getByRole("link").filter({ hasText: run.users.alice.username }).first();
    await expect(mine.getByLabel("Muted")).toBeVisible({ timeout: 20_000 });
    // A new message in a muted conversation isn't counted.
    await expect(mine.getByText(/^\d+$/)).toHaveCount(0);
  } finally {
    expect((await b.patch(`/rooms/rooms/${dm}/me`, { muted_until: null })).ok()).toBe(true);
  }
});

test("the latest message stays in view when the screen gets shorter", async ({ browser }) => {
  // A phone-sized page; a keyboard opening is the page getting shorter.
  const { storageStateFile } = await import("../lib/stack");
  const ctx = await browser.newContext({ storageState: storageStateFile("alice"), viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await ctx.route("**/version.json*", (r) => r.abort());
  const page = await ctx.newPage();
  try {
    const auth = await bearer(page);
    if (!dm) {
      const r = await api(page, auth).post("/rooms/dms", { user_ids: [run.users.bob.id] });
      dm = (await r.json()).id;
    }
    // Enough to scroll, ending in one this run can find.
    for (let i = 0; i < 14; i++) await api(page, auth).post(`/rooms/rooms/${dm}/messages`, { body: `Line ${i} of a long chat ${stamp}` });
    const last = `The last word ${stamp}`;
    await api(page, auth).post(`/rooms/rooms/${dm}/messages`, { body: last });
    await page.goto(`/rooms/r/${dm}`);
    const target = page.getByRole("log").getByText(last);
    await expect(target).toBeInViewport({ timeout: 20_000 });
    for (const height of [460, 800, 520]) {
      await page.setViewportSize({ width: 390, height });
      await expect(target, `at ${height}px tall`).toBeInViewport({ timeout: 10_000 });
      // …and above the message box, not under it.
      const t = (await target.boundingBox())!;
      const b = (await page.getByRole("textbox", { name: /^Message/ }).first().boundingBox())!;
      expect(t.y + t.height, `at ${height}px tall`).toBeLessThanOrEqual(b.y + 1);
    }
  } finally {
    await ctx.close();
  }
});

test("on a phone with the Promptly app the camera button opens the app's camera, and what it sends arrives", async ({ browser, bob }) => {
  const { storageStateFile } = await import("../lib/stack");
  const ua = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
  const ctx = await browser.newContext({ storageState: storageStateFile("alice"), userAgent: ua, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
  await ctx.route("**/version.json*", (r) => r.abort());
  const page = await ctx.newPage();
  // A desktop browser has no app to open: keep the hand-off instead.
  await page.addInitScript(() => {
    (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff = [];
  });
  const handoffs = () => page.evaluate(() => (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff);
  try {
    const auth = await bearer(page);
    if (!dm) {
      const r = await api(page, auth).post("/rooms/dms", { user_ids: [run.users.bob.id] });
      dm = (await r.json()).id;
    }
    // An older app (no "camera" in what it says it can do): the page's own camera, as before.
    await page.goto("/rooms/?source=android&caps=voice,calls,callout,sound");
    await page.goto(`/rooms/r/${dm}`);
    await page.getByTestId("composer-camera").click();
    await expect(page.getByTestId("camera-view")).toBeVisible();
    expect(await handoffs()).toEqual([]);
    await page.getByTestId("camera-view").getByRole("button", { name: /close/i }).first().click();
    await expect(page.getByTestId("camera-view")).toHaveCount(0);

    // The app with the camera.
    await page.goto("/rooms/?source=android&caps=voice,calls,callout,sound,camera");
    await page.goto(`/rooms/r/${dm}`);
    await page.getByTestId("composer-camera").click();
    await expect.poll(async () => (await handoffs())[0] ?? "", { timeout: 15_000 }).toMatch(/^intent:\/\/rooms\/camera\?/);
    await expect(page.getByTestId("camera-view")).toHaveCount(0);
    const handoff = (await handoffs())[0];
    expect(handoff).toContain("#Intent;scheme=promptly;package=org.promptly.app;");
    expect(handoff).toContain(encodeURIComponent("#camera-no-app"));
    const q = new URLSearchParams(handoff.slice("intent://rooms/camera?".length, handoff.indexOf("#Intent")));
    expect(q.get("server")).toBe(new URL(page.url()).origin);
    expect(q.get("room")).toBe(dm);
    expect(q.get("title")).toBeTruthy();

    // What the app does with the ticket: one request, picture and words, no sign-in.
    const words = `From the app's camera ${stamp}`;
    const plain = await browser.newContext();
    try {
      const sent = await plain.request.post(`${new URL(page.url()).origin}/api/rooms/camera/send`, {
        headers: { "X-Promptly-Camera-Ticket": q.get("ticket")! },
        multipart: { body: words, client_id: `e2e-cam-${stamp}`, file: { name: `Photo ${stamp}.png`, mimeType: "image/png", buffer: PNG } },
      });
      expect(sent.status(), await sent.text()).toBe(201);
    } finally {
      await plain.close();
    }
    await bob.goto(`/rooms/r/${dm}`);
    for (const p of [page, bob]) {
      await expect(log(p).getByText(words)).toBeVisible({ timeout: 20_000 });
      const img = log(p).locator("img").last();
      await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }

    // The app has gone (Chrome comes back with #camera-no-app): the page's camera opens, and it stops asking.
    await page.evaluate(() => {
      window.location.hash = "#camera-no-app";
    });
    await expect(page.getByTestId("camera-view")).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("promptly.android.camera"))).toBeNull();
  } finally {
    await ctx.close();
  }
});
