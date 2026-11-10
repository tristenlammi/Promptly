// Calls WP-V4: voice channels as people use them, in the real UI. Alice
// (the space's owner), Bob and Dana in three browser contexts: join from
// the channel list, see each other and the speaking rings, mute and
// deafen icons, switch channel, the voice panel following you to another
// app and back after a reload, per-person volume, an admin's server-mute,
// Go Live with Watch and theatre, channel settings and the alone prompt,
// and the phone layout. Screenshots of the main screens (light, dark,
// phone) land in .stacks/voice-ui/ (gitignored). Needs the calls service in the
// stack (scripts/stack.sh up <name> --with calls); skipped without it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, E2E_ROOT, storageStateFile } from "../lib/stack";

const speech = writeSpeechWav(path.join(os.tmpdir(), "promptly-e2e-voice-speech.wav"), 30);
test.use({
  channel: "chrome",
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${speech}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});
test.describe.configure({ mode: "serial" });

// Outside test-results (Playwright empties that at the start of every run).
const SHOTS = process.env.VOICE_SHOTS ?? path.join(E2E_ROOT, "..", ".stacks", "voice-ui");
fs.mkdirSync(SHOTS, { recursive: true });

function py(script: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: script, encoding: "utf8" });
}

function voiceOn(on: boolean): void {
  py(`
import asyncio
import app.db_models  # noqa: F401
from app.database import SessionLocal
from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
async def main():
    async with SessionLocal() as db:
        row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        row.calls_enabled = ${on ? "True" : "False"}
        row.calls_group_ids = None
        row.calls_max_stream = "1080p60"
        await db.commit()
asyncio.run(main())
`);
}

function livekitRunning(): boolean {
  try {
    const out = execFileSync("docker", ["exec", BACKEND, "python", "-c", "import socket; socket.getaddrinfo('livekit', 7880); print('yes')"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes("yes");
  } catch {
    return false;
  }
}

/** The alone timer, run now instead of after the channel's minutes (the
 *  arq job does exactly this when its time comes). */
function aloneCheckNow(roomId: string): string {
  return py(`
import asyncio, json
import app.db_models  # noqa: F401
from app.redis_client import redis
from app.calls import voice
async def main():
    cur = json.loads(await redis.get("voice:alone:${roomId}") or "null")
    print("RESULT", await voice.alone_check("${roomId}", cur["token"]) if cur else "none")
    try:
        await redis.aclose()
    except Exception:
        pass
asyncio.run(main())
`)
    .split(/\r?\n/)
    .find((l) => l.startsWith("RESULT"))!
    .slice(7);
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

type Who = "alice" | "bob" | "dana";
const name = (w: Who) => run.users[w].username;

/** Each person's voice settings to a known start (tips seen except where asked). */
async function prefs(page: Page, auth: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.patch("/api/auth/me/preferences", {
    headers: { Authorization: auth },
    data: {
      voice: { noise: "enhanced", input_mode: "vad", auto_sensitivity: true, sounds: true, data_saver: false, tips_seen: true, input_volume: 100, output_volume: 100, stream_quality: "720p30", stream_hint: "motion", ...extra },
      voice_volumes: {},
      voice_local_mutes: [],
    },
  });
  expect(r.ok()).toBe(true);
}

function setTheme(page: Page, theme: "light" | "dark") {
  return page.addInitScript((t) => {
    window.localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 }));
    window.localStorage.setItem("promptly.dev", "voice");
  }, theme);
}

async function shot(page: Page, file: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, file) });
}

async function axe(page: Page, what: string, include?: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Someone's 0..1 level as this page hears them (the voice engine's meter). */
async function levelOf(page: Page, userId: string): Promise<number> {
  return page.evaluate((uid) => {
    const v = (window as unknown as { __voice?: { levels: { getState(): { levels: Record<string, number> } } } }).__voice;
    return v?.levels.getState().levels[uid] ?? 0;
  }, userId);
}

async function peakOf(page: Page, userId: string, ms = 2500): Promise<number> {
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    peak = Math.max(peak, await levelOf(page, userId));
    await page.waitForTimeout(100);
  }
  return peak;
}

/** Client-side navigation (a page load would end the call, as it should). */
async function go(page: Page, to: string) {
  await page.evaluate((url) => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, to);
}

const memberRow = (page: Page, who: string) => page.getByTestId(`voice-member-${who}`);
const panel = (page: Page) => page.getByTestId("voice-panel").first();

test.describe("voice channels", () => {
  const lounge = `Lounge ${stamp}`;
  const games = `Games ${stamp}`;
  const ids: { space: string; general: string; lounge: string; games: string } = { space: "", general: "", lounge: "", games: "" };
  const auth: Partial<Record<Who, string>> = {};

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    voiceOn(true);
    const ctx = await browser.newContext({ storageState: storageStateFile("alice") });
    const page = await ctx.newPage();
    const a = await bearer(page);
    const headers = { Authorization: a };
    const space = await (await page.request.post("/api/rooms/spaces", { headers, data: { name: `Lads ${stamp}` } })).json();
    ids.space = space.id;
    ids.general = space.room_id;
    expect((await page.request.post(`/api/rooms/spaces/${space.id}/members`, { headers, data: { user_ids: [run.users.bob.id, run.users.dana.id] } })).ok()).toBe(true);
    for (const [key, n] of [["lounge", lounge], ["games", games]] as const) {
      const r = await page.request.post(`/api/rooms/spaces/${space.id}/rooms`, { headers, data: { name: n, kind: "voice" } });
      expect(r.ok()).toBe(true);
      ids[key] = (await r.json()).id;
    }
    await ctx.close();
  });

  test.afterAll(() => {
    try {
      voiceOn(false);
    } catch {
      /* the stack went away */
    }
  });

  async function open(page: Page, who: Who, theme: "light" | "dark" = "light", extra: Record<string, unknown> = {}) {
    await setTheme(page, theme);
    auth[who] = await bearer(page);
    await prefs(page, auth[who]!, extra);
    await page.goto(`/rooms/r/${ids.general}`);
    await expect(page.getByTestId(`voice-channel-${lounge}`)).toBeVisible({ timeout: 20_000 });
  }

  test("join from the list, rings, mute and deafen, switch, the panel follows you", async ({ alice, bob, dana }) => {
    test.setTimeout(300_000);
    const A = name("alice");
    const B = name("bob");
    await open(alice, "alice", "light", { tips_seen: false });
    await open(bob, "bob", "dark");
    await open(dana, "dana");

    // Hovering warms up; one click joins and opens the channel.
    await alice.getByTestId(`voice-channel-${lounge}`).hover();
    await alice.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    await expect(alice).toHaveURL(new RegExp(`/rooms/r/${ids.lounge}`));
    // First time in voice: the tip says where things are.
    await expect(alice.getByTestId("voice-tip")).toBeVisible();
    await alice.getByTestId("voice-tip").getByRole("button", { name: "Got it" }).click();
    await expect(alice.getByTestId("voice-tip")).toHaveCount(0);

    await bob.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(bob).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    await expect(bob.getByTestId("voice-tip")).toHaveCount(0);

    // Everyone looking at the space sees who's in it, and who's talking.
    for (const page of [alice, bob, dana]) {
      await expect(page.getByTestId(`voice-members-${lounge}`)).toContainText(A, { timeout: 20_000 });
      await expect(page.getByTestId(`voice-members-${lounge}`)).toContainText(B);
    }
    await expect(memberRow(dana, A)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    await expect(alice.getByTestId(`voice-tile-${B}`)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    // They hear each other.
    await expect.poll(() => peakOf(bob, run.users.alice.id), { timeout: 30_000 }).toBeGreaterThan(0.15);

    await shot(alice, "desktop-light-channel.png");
    await shot(bob, "desktop-dark-channel.png");

    // Mute: the icon shows for everyone; Bob stops hearing her.
    await panel(alice).getByTestId("voice-mute").click();
    await expect(panel(alice).getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "true");
    for (const page of [bob, dana]) await expect(memberRow(page, A).locator('[aria-label="Muted"]')).toBeVisible({ timeout: 15_000 });
    await bob.waitForTimeout(1500);
    expect(await peakOf(bob, run.users.alice.id)).toBeLessThan(0.05);
    // Ctrl+Shift+M unmutes (shown in the button's tooltip).
    await alice.keyboard.press("Control+Shift+M");
    await expect(memberRow(bob, A).locator('[aria-label="Muted"]')).toHaveCount(0, { timeout: 15_000 });

    // Deafen: Bob is deafened (and muted) for everyone to see.
    await panel(bob).getByTestId("voice-deafen").click();
    await expect(memberRow(alice, B).locator('[aria-label="Deafened"]')).toBeVisible({ timeout: 15_000 });
    await expect(memberRow(dana, B).locator('[aria-label="Deafened"]')).toBeVisible({ timeout: 15_000 });
    await panel(bob).getByTestId("voice-deafen").click();
    await expect(memberRow(alice, B).locator('[aria-label="Deafened"]')).toHaveCount(0, { timeout: 15_000 });

    // Per-person volume, from someone's menu; it's saved to Bob's account.
    await memberRow(bob, A).click();
    const slider = bob.getByLabel(`Volume of ${A}`);
    await expect(slider).toBeVisible();
    await shot(bob, "desktop-dark-person-menu.png");
    await slider.fill("60");
    await expect(bob.getByRole("dialog", { name: "Voice options" })).toContainText("60%");
    await bob.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const me = await (await bob.request.get("/api/auth/me", { headers: { Authorization: auth.bob! } })).json();
        return me.settings?.voice_volumes?.[run.users.alice.id];
      }, { timeout: 10_000 })
      .toBe(60);

    // Switch channel: one click moves you.
    await alice.getByRole("button", { name: `Join ${games}` }).click();
    await expect(panel(alice).getByTestId("voice-panel-channel")).toContainText(games, { timeout: 20_000 });
    await expect(bob.getByTestId(`voice-members-${games}`)).toContainText(A, { timeout: 20_000 });
    await expect(bob.getByTestId(`voice-members-${lounge}`)).not.toContainText(A);

    // Another app: the call comes along as a card in Promptly's sidebar dock,
    // still connected.
    await go(alice, "/calendar");
    await expect(alice).toHaveURL(/\/calendar/);
    const card = alice.getByTestId("dock-card-voice").first();
    await expect(card).toContainText(games, { timeout: 15_000 });
    await shot(alice, "desktop-light-panel-in-calendar.png");
    // Mute from there works too.
    await card.getByTestId("dock-action-mute").click();
    await expect(memberRow(bob, A).locator('[aria-label="Muted"]')).toBeVisible({ timeout: 15_000 });
    await card.getByTestId("dock-action-mute").click();
    // Back to Rooms in one click from the card.
    await card.getByRole("button", { name: new RegExp(games) }).click();
    await expect(alice).toHaveURL(new RegExp(`/rooms/r/${ids.games}`));

    // A reload drops the connection; you come straight back.
    await alice.reload();
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 40_000 });
    await expect(bob.getByTestId(`voice-members-${games}`)).toContainText(A, { timeout: 20_000 });

    // Bob's volume for Alice is still 60% after his own reload.
    await bob.reload();
    await expect(memberRow(bob, A)).toBeVisible({ timeout: 20_000 });
    await memberRow(bob, A).click();
    await expect(bob.getByLabel(`Volume of ${A}`)).toHaveValue("60");
    await bob.keyboard.press("Escape");

    for (const page of [alice, bob]) {
      await panel(page).getByTestId("voice-disconnect").click();
    }
    await expect(dana.getByTestId(`voice-members-${games}`)).toHaveCount(0, { timeout: 20_000 });
    await expect(dana.getByTestId(`voice-members-${lounge}`)).toHaveCount(0, { timeout: 20_000 });
  });

  test("an admin server-mutes: the icon shows and the mic is cut", async ({ alice, bob }) => {
    test.setTimeout(180_000);
    const B = name("bob");
    await open(alice, "alice");
    await open(bob, "bob");
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: `Join ${lounge}` }).click();
      await expect(panel(page).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    }
    await expect.poll(() => peakOf(alice, run.users.bob.id), { timeout: 30_000 }).toBeGreaterThan(0.15);

    // Alice (the space's owner) mutes Bob for everyone.
    await memberRow(alice, B).click({ button: "right" });
    await alice.getByRole("button", { name: "Mute for everyone" }).click();
    await expect(memberRow(alice, B).locator('[aria-label="Muted by an admin"]')).toBeVisible({ timeout: 15_000 });
    await expect(panel(bob)).toContainText("An admin muted you", { timeout: 15_000 });
    await expect(panel(bob).getByTestId("voice-mute")).toBeDisabled();
    // Enforced by the server, not just drawn: nothing of Bob reaches Alice.
    await alice.waitForTimeout(2000);
    expect(await peakOf(alice, run.users.bob.id)).toBeLessThan(0.05);
    await shot(bob, "desktop-light-server-muted.png");

    // Lifted: he can talk again.
    await memberRow(alice, B).click();
    await alice.getByRole("button", { name: "Unmute for everyone" }).click();
    await expect(panel(bob).getByTestId("voice-mute")).toBeEnabled({ timeout: 15_000 });
    await expect.poll(() => peakOf(alice, run.users.bob.id), { timeout: 30_000 }).toBeGreaterThan(0.15);

    // A member's menu has no admin options.
    await memberRow(bob, name("alice")).click();
    await expect(bob.getByRole("dialog", { name: "Voice options" })).toBeVisible();
    await expect(bob.getByRole("button", { name: "Mute for everyone" })).toHaveCount(0);
    await bob.keyboard.press("Escape");

    for (const page of [alice, bob]) await panel(page).getByTestId("voice-disconnect").click();
  });

  test("Go Live, Watch with a viewer count, theatre and full screen", async ({ alice, bob }) => {
    test.setTimeout(180_000);
    const A = name("alice");
    await open(alice, "alice");
    await open(bob, "bob", "dark");
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: `Join ${lounge}` }).click();
      await expect(panel(page).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    }

    await panel(alice).getByRole("button", { name: "Go Live" }).click();
    const sheet = alice.getByTestId("go-live-sheet");
    await expect(sheet).toBeVisible();
    // The sound limits, said plainly.
    await sheet.getByRole("radio", { name: /A window/ }).click();
    await expect(alice.getByTestId("go-live-sound-tip")).toContainText("A single window's sound can't be shared from a browser");
    await sheet.getByRole("radio", { name: /Entire screen/ }).click();
    await sheet.getByRole("radio", { name: "1080p 30" }).click();
    await sheet.getByRole("radio", { name: "Better for text" }).click();
    await shot(alice, "desktop-light-go-live.png");
    await alice.getByTestId("go-live-start").click();
    await expect(alice.getByTestId(`voice-stream-${A}`)).toContainText("You're live", { timeout: 20_000 });

    // Bob sees LIVE, and nothing downloads until he presses Watch.
    await expect(memberRow(bob, A).locator('[aria-label="Live"]')).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId(`voice-stream-${A}`)).toContainText("0 watching");
    await bob.getByRole("button", { name: `Watch ${A}'s stream` }).click();
    const focus = bob.getByTestId("voice-focus");
    await expect(focus).toBeVisible();
    const video = focus.getByLabel(`${A}'s stream`);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(alice.getByTestId("stream-viewers")).toContainText("1 watching", { timeout: 15_000 });
    await expect(focus.getByTestId("focus-viewers")).toContainText("1 watching");
    await focus.hover();
    // Pop out (picture-in-picture) where the browser has it.
    if (await bob.evaluate(() => !!document.pictureInPictureEnabled)) await expect(focus.getByRole("button", { name: "Pop out" })).toBeVisible();
    await shot(bob, "desktop-dark-watching.png");

    // Theatre: the stream takes the window; Escape comes back.
    await focus.getByRole("button", { name: "Theatre mode" }).click();
    await expect(bob.getByTestId("voice-channel-view")).toHaveAttribute("data-theatre", "true");
    // It covers the whole window (the lists and sidebar are out of the way).
    expect((await bob.getByTestId("voice-channel-view").boundingBox())?.x).toBe(0);
    await shot(bob, "desktop-dark-theatre.png");
    await bob.keyboard.press("Escape");
    await expect(bob.getByTestId("voice-channel-view")).toHaveAttribute("data-theatre", "false");
    // Full screen.
    await focus.hover();
    await focus.getByRole("button", { name: "Full screen" }).click();
    await expect.poll(() => bob.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await bob.evaluate(() => document.exitFullscreen());

    await focus.hover();
    await focus.getByRole("button", { name: "Stop watching" }).click();
    await expect(focus).toHaveCount(0);
    await expect(alice.getByTestId("stream-viewers")).toContainText("0 watching", { timeout: 15_000 });
    await alice.getByRole("button", { name: "Stop streaming" }).first().click();
    await expect(memberRow(bob, A).locator('[aria-label="Live"]')).toHaveCount(0, { timeout: 15_000 });

    for (const page of [alice, bob]) await panel(page).getByTestId("voice-disconnect").click();
  });

  test("channel settings, and the alone prompt", async ({ alice, bob }) => {
    test.setTimeout(180_000);
    await open(alice, "alice");
    await open(bob, "bob");
    // Alice opens Lounge's settings from the list.
    await alice.getByTestId(`voice-channel-${lounge}`).hover();
    await alice.getByRole("button", { name: `${lounge} settings` }).click();
    const settings = alice.getByTestId("channel-voice-settings");
    await expect(settings).toBeVisible();
    await settings.getByLabel("User limit").selectOption("2");
    await settings.getByRole("radio", { name: /High/ }).click();
    await settings.getByTestId("alone-minutes").selectOption("5");
    await shot(alice, "desktop-light-channel-settings.png");
    await expect
      .poll(async () => {
        const b = await (await alice.request.get("/api/rooms/bootstrap", { headers: { Authorization: auth.alice! } })).json();
        const room = b.spaces.flatMap((s: { rooms: { id: string; voice?: unknown }[] }) => s.rooms).find((r: { id: string }) => r.id === ids.lounge);
        return room.voice;
      }, { timeout: 10_000 })
      .toMatchObject({ user_limit: 2, quality: "high", alone_minutes: 5 });
    await alice.keyboard.press("Escape");
    // Bob sees the limit on the channel.
    await expect(bob.getByTestId(`voice-channel-${lounge}`)).toContainText("00/02", { timeout: 15_000 });

    // A bob-only settings sheet is read-only.
    await bob.getByTestId(`voice-channel-${lounge}`).hover();
    await bob.getByRole("button", { name: `Open chat in ${lounge}` }).click();
    await bob.getByRole("button", { name: "Channel settings" }).click();
    await expect(bob.getByTestId("channel-voice-settings")).toContainText("Only the space's admins can change these.");
    await bob.keyboard.press("Escape");

    // Alone in the channel: after its minutes (run now), "Still there?".
    await alice.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    await expect.poll(() => aloneCheckNow(ids.lounge), { timeout: 15_000 }).toBe("asked");
    await expect(alice.getByTestId("still-there")).toBeVisible({ timeout: 15_000 });
    await shot(alice, "desktop-light-still-there.png");
    await alice.getByRole("button", { name: "I'm still here" }).click();
    await expect(alice.getByTestId("still-there")).toHaveCount(0);
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected");
    // Unanswered: disconnected, and told why.
    expect(aloneCheckNow(ids.lounge)).toBe("asked");
    await expect(alice.getByTestId("still-there")).toBeVisible({ timeout: 15_000 });
    expect(aloneCheckNow(ids.lounge)).toBe("disconnected");
    await expect(alice.getByText("because you were on your own for a while")).toBeVisible({ timeout: 15_000 });
    await expect(panel(alice).getByTestId("voice-status")).toHaveCount(0);

    // Put the channel back as it was for the other tests.
    const r = await alice.request.patch(`/api/rooms/rooms/${ids.lounge}/voice`, {
      headers: { Authorization: auth.alice! },
      data: { user_limit: 0, quality: "good", alone_minutes: 15 },
    });
    expect(r.ok()).toBe(true);
  });

  test("voice settings, Ctrl+K, creating a channel, and an accessibility scan", async ({ alice }) => {
    test.setTimeout(180_000);
    await open(alice, "alice");
    const found: string[] = [];
    found.push(...(await axe(alice, "rooms with voice channels (light)", "main")));

    // Create a voice channel from the space's menu.
    await alice.locator('button[aria-haspopup="menu"]', { hasText: `Lads ${stamp}` }).click();
    await alice.getByRole("menuitem", { name: "New voice channel" }).click();
    await expect(alice.getByRole("radio", { name: /Voice channel/ })).toHaveAttribute("aria-checked", "true");
    await alice.getByLabel("Name").fill(`Movie night ${stamp}`);
    await alice.getByRole("button", { name: "Create voice channel" }).click();
    await expect(alice.getByTestId(`voice-channel-Movie night ${stamp}`)).toBeVisible({ timeout: 15_000 });
    await expect(alice.getByTestId("voice-join")).toBeVisible();

    // Ctrl+K: join a channel by name.
    await alice.keyboard.press("Control+k");
    await alice.keyboard.type(`join ${lounge.toLowerCase()}`);
    await expect(alice.getByRole("button", { name: new RegExp(`Join ${lounge}.*Lads`) })).toBeVisible();
    await alice.keyboard.press("Enter");
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    await alice.keyboard.press("Control+k");
    await alice.keyboard.type("leave");
    await expect(alice.getByRole("button", { name: /Leave voice.*Disconnect from/ })).toBeVisible();
    await alice.keyboard.press("Escape");

    found.push(...(await axe(alice, "voice channel stage (light)", "main")));
    found.push(...(await axe(alice, "voice panel (light)", "[data-testid=voice-panel]")));

    // Settings from the panel's gear.
    await panel(alice).getByRole("button", { name: "Voice & video settings" }).click();
    const settings = alice.getByTestId("voice-settings");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Let's check" }).click();
    await expect.poll(async () => Number(await settings.getByRole("meter", { name: "Your microphone level" }).getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeGreaterThan(10);
    await settings.getByRole("radio", { name: "Push to talk" }).click();
    await settings.getByTestId("ptt-keybind").click();
    await alice.keyboard.press("KeyV");
    await expect(settings.getByTestId("ptt-keybind")).toContainText("V");
    await shot(alice, "desktop-light-voice-settings.png");
    found.push(...(await axe(alice, "voice settings (light)", "[role=dialog]")));
    await settings.getByRole("radio", { name: "Voice activity" }).click();
    await alice.keyboard.press("Escape");

    await panel(alice).getByTestId("voice-disconnect").click();
    expect(found, found.join("\n")).toEqual([]);
  });

  test("dark theme passes the accessibility scan too", async ({ bob }) => {
    test.setTimeout(120_000);
    await open(bob, "bob", "dark");
    await bob.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(bob).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    const found: string[] = [];
    found.push(...(await axe(bob, "voice channel stage (dark)", "main")));
    await memberRow(bob, name("bob")).click();
    found.push(...(await axe(bob, "person menu (dark)", "[role=dialog]")));
    await bob.keyboard.press("Escape");
    await panel(bob).getByRole("button", { name: "Go Live" }).click();
    await expect(bob.getByTestId("go-live-sheet")).toBeVisible();
    await bob.waitForTimeout(600); // the sheet's fade-in, or axe measures half-faded text
    found.push(...(await axe(bob, "go live (dark)", "[role=dialog]")));
    await bob.keyboard.press("Escape");
    await panel(bob).getByTestId("voice-disconnect").click();
    expect(found, found.join("\n")).toEqual([]);
  });

  test("on a phone: join, the stage, minimise to the bar", async ({ browser }) => {
    test.setTimeout(150_000);
    const ctx: BrowserContext = await (browser as Browser).newContext({
      storageState: storageStateFile("bob"),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await ctx.route("**/version.json*", (r) => r.abort());
    const phone = await ctx.newPage();
    await setTheme(phone, "light");
    auth.bob = await bearer(phone);
    await prefs(phone, auth.bob);
    await phone.goto(`/rooms/r/${ids.lounge}`);
    await phone.getByTestId("voice-join").tap();
    await expect(phone.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => phone.evaluate(() => (window as unknown as { __voice?: { store: { getState(): { status: string } } } }).__voice?.store.getState().status), { timeout: 30_000 })
      .toBe("connected");
    await expect(phone.getByText("Voice may stop if you lock your phone")).toBeVisible();
    await expect(phone.getByRole("button", { name: "Leave voice" })).toBeVisible();
    // No sideways scrolling at phone width.
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "phone-light-stage.png") });
    await phone.getByRole("button", { name: "Dismiss" }).tap();
    // Minimise: back to the list, with the bar to return.
    await phone.getByRole("button", { name: "Minimise" }).tap();
    await expect(phone.getByTestId("voice-pill")).toBeVisible();
    await expect(phone.getByTestId("voice-pill")).toContainText(lounge);
    await expect(phone.getByTestId("voice-pill")).toContainText("tap to return");
    await phone.screenshot({ path: path.join(SHOTS, "phone-light-pill.png") });
    await phone.getByTestId("voice-pill").getByRole("button", { name: /Return to the channel/ }).tap();
    await expect(phone.getByTestId("voice-stage")).toBeVisible();
    await phone.getByRole("button", { name: "Leave voice" }).first().tap();
    await expect(phone.getByTestId("voice-join")).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });
});
