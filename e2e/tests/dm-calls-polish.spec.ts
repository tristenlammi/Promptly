// Calls WP-D5: polish for DM calls in the web app.
//
//  - Starting a call on an Android phone with the Promptly app hands it to
//    the app (promptly://call/start with an Android call session): the page
//    shows the call as one the app holds. If the app can't take it (Chrome
//    comes back to #call-no-app), the page holds the call itself and stops
//    sending calls to the app.
//  - Sounds: ringback, through, reconnecting / reconnected, the other side's
//    hold, the end (recorded through window.__callSounds).
//  - "Reconnecting…" and "You're offline" over the call, and the call
//    carrying on after.
//  - The other side's phone holding the call ("On hold").
//  - Data saver says video is lowered.
//  - A missed call's notification opens that call in the Calls tab.
//  - Quiet hours: calls ring through by default; "Don't ring me during
//    quiet hours" in Account → Notifications.
// The real app is checked on a phone (see the WP-D5 report's owner checks).
// Needs the calls service in the stack (scripts/stack.sh up <name> --with
// calls); skipped without it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, BASE_URL, storageStateFile } from "../lib/stack";

const speech = writeSpeechWav(path.join(os.tmpdir(), "promptly-e2e-polish-speech.wav"), 30);
/** A moving test picture for the fake camera (Chrome's built-in one ends at once here). */
function writeCameraY4m(file: string, w = 320, h = 240, frames = 60): string {
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) y[r * w + c] = (c + r + i * 6) % 256;
    parts.push(y, Buffer.alloc((w * h) / 4, 90), Buffer.alloc((w * h) / 4, 200));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}
const camera = writeCameraY4m(path.join(os.tmpdir(), "promptly-e2e-polish-camera.y4m"));
const CHROME_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${speech}`,
  `--use-file-for-fake-video-capture=${camera}`,
  "--autoplay-policy=no-user-gesture-required",
];
test.use({ channel: "chrome", launchOptions: { args: CHROME_ARGS } });
test.describe.configure({ mode: "serial" });

const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";

const browsers: Browser[] = [];
type Who = "alice" | "bob";
async function person(who: Who, opts: BrowserContextOptions = {}): Promise<Page> {
  const b = await chromium.launch({ channel: "chrome", args: CHROME_ARGS });
  browsers.push(b);
  const ctx = await b.newContext({
    storageState: storageStateFile(who),
    baseURL: BASE_URL,
    viewport: { width: 1366, height: 860 },
    serviceWorkers: "block",
    ...opts,
  });
  await ctx.route("**/version.json*", (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("promptly.dev", "voice");
    (window as unknown as { __callSounds: string[] }).__callSounds = [];
  });
  return page;
}
test.afterEach(async () => {
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
});

function py(script: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: script, encoding: "utf8" });
}

function callsOn(on: boolean): void {
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

/** The 45-second ring timeout, run now (the arq job does exactly this). */
function ringTimeoutNow(callId: string): string {
  return py(`
import asyncio, uuid
import app.db_models  # noqa: F401
from sqlalchemy import func, select
from app.database import SessionLocal
from app.calls import dm
from app.calls.models import CallParticipant
from app.redis_client import redis
async def main():
    async with SessionLocal() as db:
        at = (await db.execute(select(func.max(CallParticipant.rung_at)).where(CallParticipant.call_id == uuid.UUID("${callId}")))).scalar()
    print("RESULT", await dm.ring_timeout("${callId}", at.isoformat()))
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

async function prefs(page: Page, auth: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.patch("/api/auth/me/preferences", {
    headers: { Authorization: auth },
    data: {
      voice: {
        noise: "standard",
        input_mode: "vad",
        auto_sensitivity: true,
        sounds: true,
        data_saver: false,
        tips_seen: true,
        input_volume: 100,
        output_volume: 100,
        stream_quality: "720p30",
        stream_hint: "detail",
        ...extra,
      },
    },
  });
  expect(r.ok()).toBe(true);
}

const name = (w: Who) => run.users[w].username;
const incoming = (page: Page) => page.getByTestId("incoming-call");
const screen = (page: Page) => page.getByTestId("call-screen");
const status = (page: Page) => page.getByTestId("call-status");
const sounds = (page: Page) => page.evaluate(() => [...((window as unknown as { __callSounds?: string[] }).__callSounds ?? [])]);
const TIMER = /^\d+:\d{2}$/;

/** The page's call engine (developer builds and the e2e suite expose it). */
async function engineEval<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(async (body) => {
    const calls = (window as unknown as { __calls: { engine: () => Promise<unknown> } }).__calls;
    const e = (await calls.engine()) as Record<string, unknown>;
    return new Function("e", `return (async () => { ${body} })()`)(e) as T;
  }, fn);
}

test.describe("DM calls polish (WP-D5)", () => {
  let dm = "";

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    callsOn(true);
    const ctx = await browser.newContext({ storageState: storageStateFile("alice") });
    const page = await ctx.newPage();
    const r = await page.request.post("/api/rooms/dms", { headers: { Authorization: await bearer(page) }, data: { user_ids: [run.users.bob.id] } });
    expect(r.ok()).toBe(true);
    dm = (await r.json()).id;
    await ctx.close();
    // Bob opens it too (a new conversation shows for the other person once it has something in it).
    const bctx = await browser.newContext({ storageState: storageStateFile("bob") });
    const bpage = await bctx.newPage();
    const rb = await bpage.request.post("/api/rooms/dms", { headers: { Authorization: await bearer(bpage) }, data: { user_ids: [run.users.alice.id] } });
    expect(rb.ok()).toBe(true);
    expect((await rb.json()).id).toBe(dm);
    await bctx.close();
  });

  test.afterAll(() => {
    try {
      callsOn(false);
    } catch {
      /* the stack went away */
    }
  });

  test("a call started on a phone with the app is handed to the app, and the page holds it when there's no app", async () => {
    test.setTimeout(240_000);
    const A = name("alice");
    const alice = await person("alice");
    await prefs(alice, await bearer(alice));
    await alice.goto(`/rooms/r/${dm}`);

    // Bob, on an Android phone whose Promptly app takes calls (caps=…,callout).
    const bob = await person("bob", { userAgent: PIXEL_UA, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
    await bob.addInitScript(() => {
      // A desktop browser has no app to open: keep the hand-off instead.
      (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff = [];
    });
    const bobAuth = await bearer(bob);
    await prefs(bob, bobAuth);
    await bob.goto(`/rooms/?source=android&caps=voice,calls,callout`);
    expect(await bob.evaluate(() => window.localStorage.getItem("promptly.android.callout"))).not.toBeNull();
    await bob.goto(`/rooms/r/${dm}`);
    await expect(bob.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await bob.getByTestId("room-call-audio").click();

    const handoff = await expect
      .poll(() => bob.evaluate(() => (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff[0] ?? ""), { timeout: 15_000 })
      .toMatch(/^intent:\/\/call\/start\?/)
      .then(() => bob.evaluate(() => (window as unknown as { __voiceHandoff: string[] }).__voiceHandoff[0]));
    expect(handoff).toContain("#Intent;scheme=promptly;package=org.promptly.app;");
    expect(handoff).toContain(encodeURIComponent("#call-no-app"));
    const q = new URLSearchParams(handoff.slice("intent://call/start?".length, handoff.indexOf("#Intent")));
    expect(q.get("server")).toBe(new URL(bob.url()).origin);
    expect(q.get("video")).toBe("0");
    expect(q.get("title")).toBe(A);
    const callId = q.get("call")!;
    expect(q.get("session")!.split(".")).toHaveLength(3);

    // The server started it for the phone, and Alice's phone rings.
    const c = await bob.request.get(`/api/calls/${callId}`, { headers: { Authorization: bobAuth } });
    const me = (await c.json()).participants.find((p: { user_id: string }) => p.user_id === run.users.bob.id);
    expect(me.device).toBe("android");
    await expect(incoming(alice)).toBeVisible({ timeout: 20_000 });

    // The page shows it as the app's call (no ringback here: the app plays it).
    await expect(screen(bob)).toBeVisible();
    await expect(status(bob)).toHaveText("Calling…", { timeout: 20_000 });
    await expect(bob.getByTestId("call-in-app")).toBeVisible();
    expect(await sounds(bob)).not.toContain("ringback");

    // No app to take it after all: Chrome comes back to the page.
    await bob.evaluate(() => {
      window.location.hash = "#call-no-app";
    });
    await expect(bob.getByText("The Promptly app couldn't take the call")).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId("call-in-app")).toHaveCount(0, { timeout: 20_000 });
    await expect(status(bob)).toHaveText("Calling…", { timeout: 20_000 });
    await expect.poll(() => sounds(bob), { timeout: 15_000 }).toContain("ringback");
    expect(await bob.evaluate(() => window.localStorage.getItem("promptly.android.calls"))).toBeNull();
    expect(await bob.evaluate(() => window.localStorage.getItem("promptly.android.callout"))).toBeNull();
    const c2 = await bob.request.get(`/api/calls/${callId}`, { headers: { Authorization: bobAuth } });
    expect((await c2.json()).participants.find((p: { user_id: string }) => p.user_id === run.users.bob.id).device).toBe("web");

    // Still the same call: Alice answers, and it's through (with its tone).
    await expect(incoming(alice)).toBeVisible();
    await incoming(alice).getByRole("button", { name: "Answer", exact: true }).click();
    await expect(status(bob)).toHaveText(TIMER, { timeout: 30_000 });
    await expect.poll(() => sounds(bob), { timeout: 10_000 }).toContain("call-connect");

    // Bob hangs up: the end tone.
    await bob.getByTestId("call-hangup").click();
    await expect(screen(alice)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => sounds(bob), { timeout: 10_000 }).toContain("call-end");
  });

  test("reconnecting, offline, the other side's hold and Data saver, said over the call", async () => {
    test.setTimeout(240_000);
    const B = name("bob");
    const alice = await person("alice");
    const bob = await person("bob");
    // Alice has Data saver on.
    await prefs(alice, await bearer(alice), { data_saver: true });
    await prefs(bob, await bearer(bob));
    await alice.goto(`/rooms/r/${dm}`);
    await bob.goto(`/rooms/r/${dm}`);
    await expect(alice.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await bob.waitForTimeout(1500);
    await alice.getByTestId("room-call-audio").click();
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });
    await expect.poll(() => sounds(alice), { timeout: 10_000 }).toContain("ringback");
    await expect(incoming(bob)).toBeVisible({ timeout: 20_000 });
    await incoming(bob).getByRole("button", { name: "Answer", exact: true }).click();
    await expect(status(alice)).toHaveText(TIMER, { timeout: 30_000 });
    await expect(status(bob)).toHaveText(TIMER, { timeout: 30_000 });
    await expect.poll(() => sounds(alice), { timeout: 10_000 }).toContain("call-connect");

    // Data saver: once there's video, Alice is told it's lowered.
    await expect(alice.getByTestId("call-lowered")).toHaveCount(0);
    await bob.getByTestId("call-camera").click();
    await expect(alice.getByTestId("call-lowered")).toHaveText("Data saver is on: video lowered", { timeout: 30_000 });
    await bob.getByTestId("call-camera").click();

    // The connection drops and comes back: "Reconnecting…", its tones, and the call carries on.
    await alice.evaluate(() => {
      const w = window as unknown as { __statuses: string[]; __calls: { store: { subscribe: (f: (s: { status: string }) => void) => void } } };
      w.__statuses = [];
      w.__calls.store.subscribe((s) => w.__statuses.push(s.status));
    });
    await engineEval(alice, `await e.room.simulateScenario("full-reconnect");`);
    await expect
      .poll(() => alice.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(["reconnecting", "connected"]));
    await expect(status(alice)).toHaveText(TIMER, { timeout: 30_000 });
    await expect.poll(() => sounds(alice), { timeout: 10_000 }).toEqual(expect.arrayContaining(["reconnecting", "reconnected"]));
    await expect(alice.getByTestId("call-reconnecting")).toHaveCount(0);

    // Offline (Wi-Fi to mobile data, a tunnel): said at once.
    await alice.context().setOffline(true);
    await expect(alice.getByTestId("call-reconnecting")).toContainText("You're offline", { timeout: 15_000 });
    await expect(status(alice)).toHaveText("You're offline…");
    await alice.context().setOffline(false);
    await expect(alice.getByTestId("call-reconnecting")).toHaveCount(0, { timeout: 60_000 });
    await expect(status(alice)).toHaveText(TIMER, { timeout: 60_000 });

    // Bob's phone takes a phone call and holds this one: Alice hears the
    // hold tone and is told; then he's back.
    await engineEval(bob, `await e.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ hold: true })), { reliable: true, topic: "call.hold" });`);
    await expect(alice.getByTestId("call-on-hold")).toBeVisible({ timeout: 15_000 });
    await expect(status(alice)).toHaveText(/^On hold · \d+:\d{2}$/);
    await expect.poll(() => sounds(alice), { timeout: 10_000 }).toContain("hold");
    await engineEval(bob, `await e.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ hold: false })), { reliable: true, topic: "call.hold" });`);
    await expect(alice.getByTestId("call-on-hold")).toHaveCount(0, { timeout: 15_000 });
    await expect(status(alice)).toHaveText(TIMER);
    // (Anything but a boolean on that topic is ignored.)
    await engineEval(bob, `await e.room.localParticipant.publishData(new TextEncoder().encode("nope"), { reliable: true, topic: "call.hold" });`);
    await alice.waitForTimeout(1000);
    await expect(alice.getByTestId("call-on-hold")).toHaveCount(0);

    await alice.getByTestId("call-hangup").click();
    await expect(screen(bob)).toHaveCount(0, { timeout: 15_000 });
    expect(B).toBeTruthy();
  });

  test("a missed call's notification opens that call in the Calls tab", async () => {
    test.setTimeout(180_000);
    const A = name("alice");
    const alice = await person("alice");
    const bob = await person("bob");
    await prefs(alice, await bearer(alice));
    const bobAuth = await bearer(bob);
    await alice.goto(`/rooms/r/${dm}`);
    await expect(alice.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await alice.getByTestId("room-call-audio").click();
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });
    const callId = await alice.evaluate(() => (window as unknown as { __calls: { store: { getState: () => { callId: string } } } }).__calls.store.getState().callId);
    expect(ringTimeoutNow(callId)).toBe("missed");
    await expect(screen(alice)).toHaveCount(0, { timeout: 15_000 });

    // Where its push points: the call in the Calls tab (the push itself is
    // checked in test_calls_dm.py; here, that the place opens that call).
    await bob.goto(`/rooms/calls/${callId}`);
    await expect(bob.getByTestId("call-detail")).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByTestId("call-detail")).toContainText(A);
    await expect(bob.getByTestId("call-detail-entry").first()).toContainText("Missed call");
    await expect(bob.getByTestId("call-detail-call")).toBeEnabled();
    // Seen: the badge clears.
    await expect.poll(async () => (await (await bob.request.get("/api/calls/missed", { headers: { Authorization: bobAuth } })).json()).count, { timeout: 15_000 }).toBe(0);
  });

  test("quiet hours: calls ring through by default; Don't ring me during quiet hours, from Account → Notifications", async () => {
    // (The settings need Web Push, so a service worker.)
    const bob = await person("bob", { serviceWorkers: "allow" });
    const auth = await bearer(bob);
    const on = await bob.request.patch("/api/notifications/preferences", { headers: { Authorization: auth }, data: { quiet_enabled: true, call_quiet_hold: false } });
    expect(on.ok()).toBe(true);
    await bob.goto("/account/notifications");
    const box = bob.getByTestId("call-quiet-hold");
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box).not.toBeChecked();
    await expect(bob.getByText("Don't ring me during quiet hours", { exact: false })).toBeVisible();
    await box.check();
    await expect
      .poll(async () => (await (await bob.request.get("/api/notifications/preferences", { headers: { Authorization: auth } })).json()).call_quiet_hold, { timeout: 10_000 })
      .toBe(true);
    // Quiet hours off: nothing to let through, so it's not offered.
    await bob.request.patch("/api/notifications/preferences", { headers: { Authorization: auth }, data: { quiet_enabled: false, call_quiet_hold: false } });
    await bob.reload();
    await expect(bob.getByText("Calls", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByTestId("call-quiet-hold")).toHaveCount(0);
    expect(stamp).toBeTruthy();
  });
});
