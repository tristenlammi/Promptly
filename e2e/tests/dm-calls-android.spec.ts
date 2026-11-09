// Calls WP-D3: the Promptly Android app rings DM calls itself, on the
// emulator. Alice (a desktop browser) calls Bob, whose phone is the
// emulator: the locked phone lights up with the full-screen ring, Bob
// answers there (the app's call service holds the audio), hangs up from the
// call notification; declines; misses a call (the ring's 45 s run out); and
// answers on his laptop, which stops the phone ringing.
//
// The emulator has no Chrome to deliver the push, so the test hands the
// app what Chrome would (the debug build's DebugRing receiver: the call
// push's tag with the ring's answer token), and everything after that is
// the real app against the real stack. Needs:
//   - scripts/stack.sh up <name> --with calls, with LiveKit's media ports
//     reachable from the emulator (see the WP-D3 report);
//   - the debug APK installed, set up with http://10.0.2.2:<port>;
//   - E2E_ANDROID=1 (and ANDROID_SERIAL if more than one device).
// Skipped otherwise. Screenshots land in .stacks/dm-calls-android/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import { expect, run, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, BASE_URL, E2E_ROOT, storageStateFile } from "../lib/stack";

const speech = writeSpeechWav(path.join(os.tmpdir(), "promptly-e2e-calls-android-speech.wav"), 60);
/** A moving test picture for the fake camera (Chrome's own ends at once here). */
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
const camera = writeCameraY4m(path.join(os.tmpdir(), "promptly-e2e-calls-android-camera.y4m"));
const CHROME_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${speech}`,
  `--use-file-for-fake-video-capture=${camera}`,
  "--autoplay-policy=no-user-gesture-required",
];
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
test.use({ channel: "chrome", launchOptions: { args: CHROME_ARGS } });
test.describe.configure({ mode: "serial" });

const ADB = process.env.ADB ?? path.join(process.env.ANDROID_HOME ?? path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"), "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const SHOTS = path.join(E2E_ROOT, "..", ".stacks", "dm-calls-android");
fs.mkdirSync(SHOTS, { recursive: true });

function adb(...args: string[]): string {
  return execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function phoneReady(): boolean {
  if (process.env.E2E_ANDROID !== "1") return false;
  try {
    return adb("shell", "pm", "path", "org.promptly.app").includes("package:");
  } catch {
    return false;
  }
}

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

/** The ring's answer token, as the push carries it (``ring.py``). */
function answerToken(userId: string, callId: string): string {
  return py(`
import asyncio, uuid
import app.db_models  # noqa: F401
from app.database import SessionLocal
from app.auth.models import User
from app.notifications import actions
async def main():
    async with SessionLocal() as db:
        u = await db.get(User, uuid.UUID("${userId}"))
        print("TOKEN", actions.sign(u, "call_answer", "${callId}", ttl_s=120))
asyncio.run(main())
`)
    .split(/\r?\n/)
    .find((l) => l.startsWith("TOKEN "))!
    .slice(6)
    .trim();
}

/** What Chrome does with a call push: hand its notification to the app. */
function ringPhone(callId: string, token: string, from: string, video = false): void {
  const tag = `p#${BASE_URL}#0call:${callId}|r|${video ? "v" : "a"}|0|0|${token}`;
  const out = adb("shell", `am broadcast -n org.promptly.app/org.promptly.sync.calls.DebugRing --es tag '${tag}' --es title '${from}' --es text '${video ? "Incoming video call" : "Incoming call"}'`);
  expect(out).toContain("Broadcast completed");
}

/** Text on the phone's screen (uiautomator), and where. */
function screenNodes(): { text: string; x: number; y: number }[] {
  try {
    adb("shell", "uiautomator", "dump", "/data/local/tmp/e2e_ui.xml");
    const xml = adb("exec-out", "cat", "/data/local/tmp/e2e_ui.xml");
    const out: { text: string; x: number; y: number }[] = [];
    for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
      const [, t, d, x1, y1, x2, y2] = m;
      for (const text of [t, d]) if (text) out.push({ text, x: (Number(x1) + Number(x2)) >> 1, y: (Number(y1) + Number(y2)) >> 1 });
    }
    return out;
  } catch {
    return [];
  }
}

const onScreen = (text: string | RegExp) => screenNodes().some((n) => (typeof text === "string" ? n.text === text : text.test(n.text)));

/** Tap it on the phone (the topmost, when the shade covers a screen with the same words). */
function tapOnPhone(text: string | RegExp): void {
  // uiautomator's dump fails now and then while the screen changes: a few tries.
  for (let i = 0; i < 5; i++) {
    const n = screenNodes()
      .filter((n) => (typeof text === "string" ? n.text === text : text.test(n.text)))
      .sort((a, b) => a.y - b.y)[0];
    if (n) {
      adb("shell", "input", "tap", String(n.x), String(n.y));
      return;
    }
  }
  throw new Error(`nothing called ${text} on the phone's screen`);
}

function phoneShot(file: string): void {
  fs.writeFileSync(path.join(SHOTS, file), execFileSync(ADB, ["exec-out", "screencap", "-p"]));
}

const screenOn = () => /mWakefulness=Awake/.test(adb("shell", "dumpsys", "power"));
const locked = () => /mIsShowing=true/.test(adb("shell", "dumpsys", "window"));
const callScreenUp = () => /CallActivity/.test(adb("shell", "dumpsys", "activity", "activities").split(/\r?\n/).filter((l) => /mResumedActivity|topResumedActivity/.test(l)).join("\n"));
const ringing = () => /tag=call-ring/.test(adb("shell", "dumpsys", "notification", "--noredact"));

function lockPhone(): void {
  adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
}

function unlockPhone(): void {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
}

/** The audio the app's call service hears (debug builds log it every 2 s). */
function audioPackets(): { in: number; out: number } {
  const log = adb("logcat", "-d", "-s", "PromptlyCall:D");
  const ins = [...log.matchAll(/audio in: tracks=\d+ packets=(\d+)/g)].map((m) => Number(m[1]));
  const outs = [...log.matchAll(/audio out: muted=\w+ packets=(\d+)/g)].map((m) => Number(m[1]));
  return { in: ins.at(-1) ?? 0, out: outs.at(-1) ?? 0 };
}

let browser: Browser | null = null;
async function person(who: "alice" | "bob"): Promise<Page> {
  browser ??= await chromium.launch({ channel: "chrome", args: CHROME_ARGS });
  const ctx = await browser.newContext({ storageState: storageStateFile(who), baseURL: BASE_URL, viewport: { width: 1366, height: 860 }, serviceWorkers: "block" });
  await ctx.route("**/version.json*", (r) => r.abort());
  return ctx.newPage();
}

/** Bob's P Rooms page on the phone itself: Android, opened by the app (caps=calls). */
async function phonePage(): Promise<Page> {
  browser ??= await chromium.launch({ channel: "chrome", args: CHROME_ARGS });
  const ctx = await browser.newContext({
    storageState: storageStateFile("bob"),
    baseURL: BASE_URL,
    viewport: { width: 412, height: 915 },
    userAgent: PIXEL_UA,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  await ctx.route("**/version.json*", (r) => r.abort());
  await ctx.addInitScript(() => window.localStorage.setItem("promptly.android.calls", String(Date.now())));
  return ctx.newPage();
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

const TIMER = /^\d+:\d{2}$/;

test.describe("DM calls on the Android app", () => {
  let dm = "";
  let aliceAuth = "";
  const A = () => run.users.alice.username;

  // The emulator's lock screen may be off ("None"): a swipe lock for the
  // test, put back afterwards.
  let lockWasOff = false;

  test.beforeAll(async () => {
    test.skip(!phoneReady(), "no emulator with the Promptly debug app (E2E_ANDROID=1)");
    lockWasOff = adb("shell", "locksettings", "get-disabled").trim() === "true";
    if (lockWasOff) adb("shell", "locksettings", "set-disabled", "false");
    callsOn(true);
    adb("shell", "pm", "grant", "org.promptly.app", "android.permission.RECORD_AUDIO");
    adb("shell", "pm", "grant", "org.promptly.app", "android.permission.BLUETOOTH_CONNECT");
    adb("logcat", "-c");
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    browser = null;
    try {
      unlockPhone();
      if (lockWasOff) adb("shell", "locksettings", "set-disabled", "true");
      callsOn(false);
    } catch {
      /* the stack or the phone went away */
    }
  });

  async function aliceCalls(alice: Page, video = false): Promise<string> {
    if (!aliceAuth) aliceAuth = await bearer(alice);
    if (!dm) {
      const r = await alice.request.post("/api/rooms/dms", { headers: { Authorization: aliceAuth }, data: { user_ids: [run.users.bob.id] } });
      expect(r.ok()).toBe(true);
      dm = (await r.json()).id;
    }
    await alice.goto(`/rooms/r/${dm}`);
    await alice.getByTestId(video ? "room-call-video" : "room-call-audio").click();
    await expect(alice.getByTestId("call-status")).toHaveText("Calling…", { timeout: 20_000 });
    const live = await alice.request.get("/api/calls/live", { headers: { Authorization: aliceAuth } });
    const call = ((await live.json()).calls as { id: string; room_id: string }[]).find((c) => c.room_id === dm)!;
    return call.id;
  }

  async function callRow(alice: Page, id: string) {
    const r = await alice.request.get(`/api/calls/${id}`, { headers: { Authorization: aliceAuth } });
    return (await r.json()) as { live: boolean; ended_reason: string | null; participants: { user_id: string; in_call: boolean; device: string | null; ring: string }[] };
  }

  test("a locked phone rings full screen; Bob answers there, talks, and hangs up from the notification", async () => {
    test.setTimeout(180_000);
    const alice = await person("alice");
    const id = await aliceCalls(alice);

    lockPhone();
    await expect.poll(screenOn, { timeout: 10_000 }).toBe(false);
    ringPhone(id, answerToken(run.users.bob.id, id), A());

    // The ring turns the screen on, over the lock screen.
    await expect.poll(screenOn, { timeout: 15_000 }).toBe(true);
    await expect.poll(callScreenUp, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => onScreen("Answer"), { timeout: 15_000 }).toBe(true);
    expect(onScreen(A())).toBe(true);
    expect(onScreen("Decline")).toBe(true);
    expect(locked()).toBe(true);
    expect(ringing()).toBe(true);
    phoneShot("ring-locked.png");

    tapOnPhone("Answer");
    await expect(alice.getByTestId("call-status")).toHaveText(TIMER, { timeout: 30_000 });
    await expect.poll(async () => (await callRow(alice, id)).participants.find((p) => p.user_id === run.users.bob.id)?.device, { timeout: 15_000 }).toBe("android");
    await expect.poll(() => onScreen("Hang up"), { timeout: 15_000 }).toBe(true);
    expect(ringing()).toBe(false);

    // Sound both ways: Alice's speech reaches the phone, the phone's microphone goes out.
    await expect.poll(() => audioPackets().in, { timeout: 30_000 }).toBeGreaterThan(50);
    const a = audioPackets();
    await alice.waitForTimeout(5000);
    const b = audioPackets();
    expect(b.in).toBeGreaterThan(a.in);
    expect(b.out).toBeGreaterThan(a.out);
    phoneShot("in-call-locked.png");

    // Hang up from the call notification. (Unlocked first: uiautomator
    // can't read the shade over the lock screen; the button is the same.)
    unlockPhone();
    adb("shell", "cmd", "statusbar", "expand-notifications");
    // The call notification's own Hang up, in the shade (not the call screen's under it).
    const inShade = () => screenNodes().find((n) => /^Hang up$/i.test(n.text) && n.y < 1500);
    await expect.poll(() => !!inShade(), { timeout: 15_000 }).toBe(true);
    phoneShot("call-notification.png");
    const button = inShade()!;
    adb("shell", "input", "tap", String(button.x), String(button.y));
    adb("shell", "cmd", "statusbar", "collapse");
    await expect(alice.getByTestId("call-ended")).toContainText("Call ended", { timeout: 20_000 });
    await expect.poll(async () => (await callRow(alice, id)).live, { timeout: 15_000 }).toBe(false);
    await alice.context().close();
  });

  test("Bob declines on the phone", async () => {
    test.setTimeout(120_000);
    unlockPhone();
    await new Promise((r) => setTimeout(r, 1500));
    const alice = await person("alice");
    const id = await aliceCalls(alice);
    ringPhone(id, answerToken(run.users.bob.id, id), A());
    await expect.poll(() => onScreen("Decline"), { timeout: 15_000 }).toBe(true);
    phoneShot("ring-unlocked.png");
    tapOnPhone("Decline");
    await expect.poll(async () => (await callRow(alice, id)).ended_reason, { timeout: 15_000 }).toBe("declined");
    await expect(alice.getByTestId("call-ended")).toBeVisible({ timeout: 15_000 });
    await expect.poll(ringing, { timeout: 10_000 }).toBe(false);
    await alice.context().close();
  });

  test("a call nobody answers stops ringing after 45 seconds and is missed", async () => {
    test.setTimeout(150_000);
    const alice = await person("alice");
    const id = await aliceCalls(alice);
    lockPhone();
    ringPhone(id, answerToken(run.users.bob.id, id), A());
    await expect.poll(callScreenUp, { timeout: 15_000 }).toBe(true);
    expect(ringing()).toBe(true);
    // Still ringing a little before the 45 s.
    await alice.waitForTimeout(35_000);
    expect(ringing()).toBe(true);
    await expect.poll(ringing, { timeout: 20_000, intervals: [1000] }).toBe(false);
    await expect.poll(async () => (await callRow(alice, id)).ended_reason, { timeout: 30_000 }).toBe("missed");
    await expect.poll(callScreenUp, { timeout: 10_000 }).toBe(false);
    await alice.context().close();
  });

  test("answered on the phone, the page shows the call's video and drives the app's mute and hang up", async () => {
    test.setTimeout(180_000);
    unlockPhone();
    const alice = await person("alice");
    const id = await aliceCalls(alice);
    ringPhone(id, answerToken(run.users.bob.id, id), A());
    await expect.poll(() => onScreen("Answer"), { timeout: 15_000 }).toBe(true);
    tapOnPhone("Answer");
    await expect(alice.getByTestId("call-status")).toHaveText(TIMER, { timeout: 30_000 });
    await alice.getByTestId("call-camera").click();

    // Bob's page on the same phone: no ring of its own, and the call's video.
    const page = await phonePage();
    await page.goto(`/rooms/r/${dm}?call=${id}`);
    const screen = page.getByTestId("call-screen");
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("call-in-app")).toBeVisible();
    await expect(page.getByTestId("call-status")).toHaveText(TIMER, { timeout: 20_000 });
    await expect
      .poll(() => page.getByTestId(`call-video-${A()}`).first().evaluate((v) => (v as HTMLVideoElement).videoWidth).catch(() => 0), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.screenshot({ path: path.join(SHOTS, "page-phone-mode.png") });

    // Mute on the page mutes the app (its own microphone track says so).
    await page.getByTestId("call-mute").click();
    await expect.poll(() => /audio out: muted=true/.test(adb("logcat", "-d", "-s", "PromptlyCall:D")), { timeout: 15_000 }).toBe(true);
    await expect(page.getByTestId("call-mute")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.getByRole("img", { name: `${run.users.bob.username} is muted` })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("call-mute").click();
    await expect(alice.getByRole("img", { name: `${run.users.bob.username} is muted` })).toHaveCount(0, { timeout: 15_000 });

    // Hang up on the page: the app's call ends, and Alice's.
    await page.getByTestId("call-hangup").click();
    await expect(alice.getByTestId("call-ended")).toBeVisible({ timeout: 20_000 });
    await expect.poll(callScreenUp, { timeout: 15_000 }).toBe(false);
    // The call notification (the service's, id 4302) is gone.
    await expect.poll(() => /id=4302/.test(adb("shell", "dumpsys", "notification", "--noredact")), { timeout: 15_000 }).toBe(false);
    await page.context().close();
    await alice.context().close();
  });

  test("answered on the laptop: the phone stops ringing", async () => {
    test.setTimeout(150_000);
    unlockPhone();
    const alice = await person("alice");
    const bob = await person("bob");
    await bob.goto(`/rooms/`);
    const id = await aliceCalls(alice);
    ringPhone(id, answerToken(run.users.bob.id, id), A());
    await expect.poll(ringing, { timeout: 15_000 }).toBe(true);
    // Bob answers in his browser; the phone hears about it within seconds
    // (it asks the server while it rings, besides Chrome's stop push).
    await expect(bob.getByTestId("incoming-call")).toBeVisible({ timeout: 20_000 });
    await bob.getByTestId("incoming-call").getByRole("button", { name: /^Answer/ }).first().click();
    await expect(alice.getByTestId("call-status")).toHaveText(TIMER, { timeout: 30_000 });
    await expect.poll(ringing, { timeout: 12_000, intervals: [500] }).toBe(false);
    await expect.poll(callScreenUp, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await callRow(alice, id)).participants.find((p) => p.user_id === run.users.bob.id)?.device, { timeout: 5_000 }).toBe("web");
    await alice.getByTestId("call-hangup").click();
    await alice.context().close();
    await bob.context().close();
  });
});
