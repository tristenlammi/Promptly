// Calls WP-V5: the phone side of voice channels, as far as a desktop
// browser can show it, plus the Voice & video settings polish.
//
//  - Settings inside Rooms (whose own accent is Discord blurple) use
//    Promptly's terracotta for sliders, toggles and selected options, and
//    push to talk says what to do in a game ("Use voice activity instead").
//  - On an Android phone with the Promptly app, Join hands the channel to the
//    app (promptly://voice) and the page becomes its remote control. The app
//    is stood in for by a second page that does what VoiceService does: it
//    connects with the voice session, obeys the server's voice.control
//    commands and reports back with the session. The real app is checked on
//    the emulator (see the WP-V5 report).
//
// Needs the calls service in the stack (scripts/stack.sh up <name> --with
// calls); skipped without it.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, storageStateFile } from "../lib/stack";

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

const TERRACOTTA = "rgb(217, 119, 87)"; // --accent: sliders, radios, focus rings
const TERRACOTTA_STRONG = "rgb(181, 83, 47)"; // --accent-strong: fills with white text
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";

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

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

async function prefs(page: Page, auth: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.patch("/api/auth/me/preferences", {
    headers: { Authorization: auth },
    data: { voice: { noise: "enhanced", input_mode: "vad", auto_sensitivity: true, sounds: false, tips_seen: true, input_volume: 100, output_volume: 100, ...extra } },
  });
  expect(r.ok()).toBe(true);
}

/** What the voice harness exposes (localStorage "promptly.dev" = "voice"). */
type Harness = { store: { getState(): Record<string, unknown> } };
const voiceState = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __voice: Harness }).__voice.store.getState()[k], key);

const memberRow = (page: Page, who: string) => page.getByTestId(`voice-member-${who}`);
const panel = (page: Page) => page.getByTestId("voice-panel").first();

test.describe("voice on a phone with the Promptly app", () => {
  const lounge = `Lounge ${stamp}`;
  const ids = { space: "", general: "", lounge: "" };

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    voiceOn(true);
    const ctx = await browser.newContext({ storageState: storageStateFile("alice") });
    const page = await ctx.newPage();
    const headers = { Authorization: await bearer(page) };
    const space = await (await page.request.post("/api/rooms/spaces", { headers, data: { name: `Phones ${stamp}` } })).json();
    ids.space = space.id;
    ids.general = space.room_id;
    expect((await page.request.post(`/api/rooms/spaces/${space.id}/members`, { headers, data: { user_ids: [run.users.bob.id] } })).ok()).toBe(true);
    const r = await page.request.post(`/api/rooms/spaces/${space.id}/rooms`, { headers, data: { name: lounge, kind: "voice" } });
    expect(r.ok()).toBe(true);
    ids.lounge = (await r.json()).id;
    await ctx.close();
  });

  test.afterAll(() => {
    try {
      voiceOn(false);
    } catch {
      /* the stack went away */
    }
  });

  test("voice settings use Promptly's accent inside Rooms, and push to talk points games at voice activity", async ({ alice }) => {
    test.setTimeout(120_000);
    await alice.addInitScript(() => window.localStorage.setItem("promptly.dev", "voice"));
    const auth = await bearer(alice);
    await prefs(alice, auth);
    await alice.goto(`/rooms/r/${ids.general}`);
    await alice.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });
    // Rooms wears Promptly's accent now (it used to be blurple on the page)...
    const roomsAccent = await alice.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--item-accent").trim().toLowerCase());
    expect(roomsAccent).toBe("#d97757");

    await panel(alice).getByRole("button", { name: "Voice & video settings" }).click();
    const sheet = alice.getByTestId("voice-settings");
    await expect(sheet).toBeVisible();
    // ...and so does the settings sheet: terracotta controls.
    const slider = sheet.getByRole("slider", { name: /Input volume/ });
    expect(await slider.evaluate((el) => getComputedStyle(el).accentColor)).toBe(TERRACOTTA);
    const toggle = sheet.getByRole("switch", { name: "Echo cancellation" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(TERRACOTTA_STRONG);
    const noise = sheet.getByRole("radio", { name: /^Enhanced/ });
    expect(await noise.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(TERRACOTTA);

    // Push to talk: the honest line stays, and the tip offers voice
    // activity for games. Keyboard focus rings are terracotta too.
    const ptt = sheet.getByRole("radio", { name: "Push to talk" });
    await ptt.click();
    await expect(ptt).toHaveAttribute("aria-checked", "true");
    await expect(sheet).toContainText("browsers can't hear keys pressed in other apps");
    await expect(sheet.getByTestId("ptt-game-tip")).toContainText("Voice activity keeps working there");
    await sheet.getByRole("radio", { name: "Voice activity" }).focus();
    await alice.keyboard.press("Tab");
    await expect(ptt).toBeFocused();
    // (After the ring's transition.)
    await expect.poll(() => ptt.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(`${TERRACOTTA_STRONG} 0px 0px 0px 2px`);
    await alice.keyboard.press("Tab");
    const keybind = sheet.getByTestId("ptt-keybind");
    await expect(keybind).toBeFocused();
    await expect.poll(() => keybind.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(`${TERRACOTTA} 0px 0px 0px 2px`);

    // Contrast and labels in the sheet (serious / critical only), the
    // terracotta Let's check button included.
    const { violations } = await new AxeBuilder({ page: alice }).include('[data-testid="voice-settings"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")}: ${(n.failureSummary ?? "").replace(/\s+/g, " ")}`).join(" | ")}`)).toEqual([]);

    await sheet.getByTestId("use-voice-activity").click();
    await expect(sheet.getByRole("radio", { name: "Voice activity" })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByTestId("ptt-game-tip")).toHaveCount(0);
    await expect
      .poll(async () => (await (await alice.request.get("/api/auth/me", { headers: { Authorization: auth } })).json()).settings?.voice?.input_mode)
      .toBe("vad");
    await alice.keyboard.press("Escape");
    await panel(alice).getByTestId("voice-disconnect").click();
  });

  test("Join hands the channel to the app; the page is its remote control", async ({ browser, alice }) => {
    test.setTimeout(240_000);
    const B = run.users.bob.username;

    // Alice, on a desktop, is in Lounge to see what everyone else sees.
    await alice.addInitScript(() => window.localStorage.setItem("promptly.dev", "voice"));
    await prefs(alice, await bearer(alice));
    await alice.goto(`/rooms/r/${ids.general}`);
    await alice.getByRole("button", { name: `Join ${lounge}` }).click();
    await expect(panel(alice).getByTestId("voice-status")).toHaveText("Voice connected", { timeout: 30_000 });

    // Bob, on an Android phone with the Promptly app (its launchers say so).
    const bobCtx = await browser.newContext({
      storageState: storageStateFile("bob"),
      userAgent: PIXEL_UA,
      viewport: { width: 412, height: 860 },
      isMobile: true,
      hasTouch: true,
    });
    await bobCtx.route("**/version.json*", (r) => r.abort());
    const bob = await bobCtx.newPage();
    await bob.addInitScript(() => {
      window.localStorage.setItem("promptly.dev", "voice");
      // A desktop browser has no app to open: keep the hand-off instead.
      (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff = [];
    });
    await prefs(bob, await bearer(bob));
    await bob.goto(`/rooms/?source=android&caps=voice`);
    // (On a phone the channel's own page has the Join button.)
    await bob.goto(`/rooms/r/${ids.lounge}`);
    await bob.getByRole("button", { name: "Join voice" }).click();
    const handoff = await expect
      .poll(() => bob.evaluate(() => (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff[0] ?? ""), { timeout: 15_000 })
      .toMatch(/^intent:\/\/voice\/join\?/)
      .then(() => bob.evaluate(() => (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff[0]));
    expect(handoff).toContain("#Intent;scheme=promptly;package=org.promptly.app;");
    expect(handoff).toContain("S.browser_fallback_url=");
    const q = new URLSearchParams(handoff.slice("intent://voice/join?".length, handoff.indexOf("#Intent")));
    expect(q.get("room")).toBe(ids.lounge);
    expect(q.get("channel")).toBe(lounge);
    expect(q.get("space")).toBe(`Phones ${stamp}`);
    expect(q.get("server")).toBe(new URL(bob.url()).origin);
    const session = q.get("session")!;
    // The page waits for the app, saying what's happening; no screen lock.
    await expect(bob.getByTestId("voice-app-note")).toContainText("Handing over to the Promptly app");
    expect(await voiceState(bob, "remote")).toBe(true);

    // The "app": connects with the session (no sign-in), obeys the server's
    // commands and reports back, as VoiceService does.
    // (Any signed-in page has the LiveKit client; the "app" itself signs in
    // with nothing but the session.)
    const phone = await alice.context().newPage();
    await phone.addInitScript(() => window.localStorage.setItem("promptly.dev", "voice"));
    await phone.goto("/rooms/");
    await phone.waitForFunction(() => !!(window as unknown as { __voice?: unknown }).__voice, undefined, { timeout: 30_000 });
    await phone.evaluate(async (s) => {
      type Phone = { got: string[]; muted: boolean; deafened: boolean; gone: string | null; report: () => Promise<Response>; room: unknown };
      const w = window as unknown as { __voice: { engine(): Promise<{ loadLk(): Promise<Record<string, any>> }> }; __phone: Phone };
      const lk = await (await w.__voice.engine()).loadLk();
      const post = (p: string, body: unknown) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await (await post("/api/rooms/voice/refresh", { session: s })).json();
      const room = new lk.Room();
      const me: Phone = {
        got: [],
        muted: false,
        deafened: false,
        gone: null,
        room,
        report: () => post("/api/rooms/voice/session/state", { voice_session: s, muted: me.muted || me.deafened, deafened: me.deafened }),
      };
      w.__phone = me;
      room.on(lk.RoomEvent.DataReceived, (payload: Uint8Array, participant: unknown, _kind: unknown, topic: string) => {
        if (participant || topic !== "voice.control") return;
        const msg = JSON.parse(new TextDecoder().decode(payload));
        me.got.push(msg.action);
        if (msg.action === "mute") me.muted = true;
        if (msg.action === "unmute") me.muted = me.deafened = false;
        if (msg.action === "deafen") me.deafened = true;
        if (msg.action === "undeafen") me.deafened = false;
        void me.report();
      });
      room.on(lk.RoomEvent.Disconnected, (reason: unknown) => {
        me.gone = String(reason ?? "?");
      });
      await room.connect(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${j.url}`, j.token, { autoSubscribe: false });
      await room.localParticipant.setMicrophoneEnabled(true);
      await me.report();
    }, session);
    const phoneState = <T,>(k: string) => phone.evaluate((key) => (window as unknown as { __phone: Record<string, unknown> }).__phone[key], k) as Promise<T>;

    // The app is in: the page says so, and everyone sees Bob in Lounge.
    await expect.poll(() => voiceState(bob, "status"), { timeout: 30_000 }).toBe("connected");
    await expect(bob.getByTestId("voice-app-note")).toContainText("The Promptly app has the sound");
    await expect(alice.getByTestId(`voice-members-${lounge}`)).toContainText(B, { timeout: 20_000 });
    // No hold-to-talk or screen lock warning on the page: the app does voice.
    await expect(bob.getByText("Voice may stop if you lock your phone")).toHaveCount(0);

    // Mute on the page goes to the app through the server; the app reports.
    await bob.getByTestId("voice-mute").first().click();
    await expect.poll(() => phoneState<string[]>("got"), { timeout: 15_000 }).toContain("mute");
    await expect(memberRow(alice, B).locator('[aria-label="Muted"]')).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId("voice-mute").first().click();
    await expect.poll(() => phoneState<string[]>("got"), { timeout: 15_000 }).toContain("unmute");
    await expect(memberRow(alice, B).locator('[aria-label="Muted"]')).toHaveCount(0, { timeout: 15_000 });

    // Deafen from the app's notification: the page follows the app.
    await phone.evaluate(async () => {
      const p = (window as unknown as { __phone: { deafened: boolean; report(): Promise<Response> } }).__phone;
      p.deafened = true;
      await p.report();
    });
    await expect.poll(() => voiceState(bob, "deafened"), { timeout: 15_000 }).toBe(true);
    await expect(memberRow(alice, B).locator('[aria-label="Deafened"]')).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId("voice-deafen").first().click();
    await expect.poll(() => phoneState<string[]>("got"), { timeout: 15_000 }).toContain("undeafen");
    await expect.poll(() => voiceState(bob, "deafened"), { timeout: 15_000 }).toBe(false);

    // An admin mutes Bob for everyone: LiveKit takes his microphone away
    // (the app can't unmute), and his page says so.
    await memberRow(alice, B).click({ button: "right" });
    await alice.getByRole("button", { name: "Mute for everyone" }).click();
    await expect.poll(() => voiceState(bob, "serverMuted"), { timeout: 15_000 }).toBe(true);
    await expect
      .poll(
        () =>
          phone.evaluate(() => {
            const r = (window as unknown as { __phone: { room: { localParticipant: { permissions?: { canPublishSources?: number[] } } } } }).__phone.room;
            return (r.localParticipant.permissions?.canPublishSources ?? []).includes(2); // MICROPHONE
          }),
        { timeout: 15_000 },
      )
      .toBe(false);
    await memberRow(alice, B).click();
    await alice.getByRole("button", { name: "Unmute for everyone" }).click();
    await expect.poll(() => voiceState(bob, "serverMuted"), { timeout: 15_000 }).toBe(false);

    // Leave on the page: the server takes the app out of the channel.
    await bob.getByTestId("voice-leave").click();
    await expect.poll(() => phoneState<string | null>("gone"), { timeout: 20_000 }).not.toBeNull();
    await expect(alice.getByTestId(`voice-members-${lounge}`)).not.toContainText(B, { timeout: 20_000 });
    expect(await voiceState(bob, "status")).toBe("idle");

    // An app too old (or gone) to take the hand-off: Chrome comes back to
    // the page, which holds voice itself and stops trying the app.
    await bob.getByRole("button", { name: "Join voice" }).click();
    await expect.poll(() => voiceState(bob, "remote"), { timeout: 15_000 }).toBe(true);
    await bob.evaluate(() => {
      window.location.hash = "#voice-no-app";
    });
    await expect(bob.getByText("The Promptly app couldn't take over")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => voiceState(bob, "status"), { timeout: 30_000 }).toBe("connected");
    expect(await voiceState(bob, "remote")).toBe(false);
    expect(await bob.evaluate(() => window.localStorage.getItem("promptly.android.voice"))).toBeNull();
    await bob.getByTestId("voice-leave").click();

    await panel(alice).getByTestId("voice-disconnect").click();
    await phone.close();
    await bobCtx.close();
  });
});
