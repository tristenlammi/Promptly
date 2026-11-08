// Calls WP-D2: DM calls in the real UI, Messenger-style. Alice rings Bob
// (both of Bob's tabs ring, he answers in one and the other stops), video
// on and off, screen sharing, mute, the small window; decline; a missed
// call after the ring times out ("Missed call" in the conversation); busy
// ("End and answer"); a group call of three with a late joiner from the
// "Call in progress · Join" bar; a blocked caller refused; the phone
// layout; axe on the incoming call and the call screen. Screenshots land
// in .stacks/dm-calls/ (gitignored). Needs the calls service in the stack
// (scripts/stack.sh up <name> --with calls); skipped without it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, BASE_URL, E2E_ROOT, storageStateFile } from "../lib/stack";

const speech = writeSpeechWav(path.join(os.tmpdir(), "promptly-e2e-calls-speech.wav"), 30);
/** A moving test picture for the fake camera. Chrome's built-in fake
 *  camera ends its track at once here (Chrome 14x, Windows); a file works. */
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
const camera = writeCameraY4m(path.join(os.tmpdir(), "promptly-e2e-calls-camera.y4m"));
const CHROME_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${speech}`,
  `--use-file-for-fake-video-capture=${camera}`,
  "--autoplay-policy=no-user-gesture-required",
];
test.use({ channel: "chrome", launchOptions: { args: CHROME_ARGS } });
test.describe.configure({ mode: "serial" });

// Chrome's fake camera can only be open in one browser context at a time
// (the others see no camera at all), so each person in a call gets a
// browser of their own.
const browsers: Browser[] = [];
async function person(who: "alice" | "bob" | "dana", opts: BrowserContextOptions = {}): Promise<Page> {
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
  return ctx.newPage();
}
test.afterEach(async () => {
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
});

const SHOTS = process.env.CALL_SHOTS ?? path.join(E2E_ROOT, "..", ".stacks", "dm-calls");
fs.mkdirSync(SHOTS, { recursive: true });

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
        row.calls_max_stream = "1080p30"
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

/** The 45-second ring timeout, run now (the arq job does exactly this
 *  when its time comes). */
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

type Who = "alice" | "bob" | "dana";
const name = (w: Who) => run.users[w].username;

async function prefs(page: Page, auth: string) {
  const r = await page.request.patch("/api/auth/me/preferences", {
    headers: { Authorization: auth },
    data: {
      voice: { noise: "enhanced", input_mode: "vad", auto_sensitivity: true, sounds: true, data_saver: false, tips_seen: true, input_volume: 100, output_volume: 100, stream_quality: "720p30", stream_hint: "detail" },
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
  await page.waitForTimeout(400);
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

/** Client-side navigation (a page load would end the call, as it should). */
async function go(page: Page, to: string) {
  await page.evaluate((url) => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, to);
}

const incoming = (page: Page) => page.getByTestId("incoming-call");
const screen = (page: Page) => page.getByTestId("call-screen");
const status = (page: Page) => page.getByTestId("call-status");

/** A <video>'s picture has arrived. */
async function playing(page: Page, testId: string): Promise<number> {
  return page
    .getByTestId(testId)
    .first()
    .evaluate((v) => (v as HTMLVideoElement).videoWidth)
    .catch(() => 0);
}

/** The timer is running (a clock like 0:07). */
const TIMER = /^\d+:\d{2}$/;

test.describe("DM calls", () => {
  const ids = { dm: "", group: "", bobDana: "" };
  const auth: Partial<Record<Who, string>> = {};
  const axeProblems: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    callsOn(true);
    const ctx = await browser.newContext({ storageState: storageStateFile("alice") });
    const page = await ctx.newPage();
    const a = await bearer(page);
    const headers = { Authorization: a };
    const dm = await page.request.post("/api/rooms/dms", { headers, data: { user_ids: [run.users.bob.id] } });
    expect(dm.ok()).toBe(true);
    ids.dm = (await dm.json()).id;
    const group = await page.request.post("/api/rooms/dms", { headers, data: { user_ids: [run.users.bob.id, run.users.dana.id] } });
    expect(group.ok()).toBe(true);
    ids.group = (await group.json()).id;
    await page.request.patch(`/api/rooms/rooms/${ids.group}`, { headers, data: { name: `Weekend ${stamp}` } });
    await ctx.close();
    // Dana and Bob's own conversation (for "End and answer").
    const cctx = await browser.newContext({ storageState: storageStateFile("dana") });
    const cpage = await cctx.newPage();
    const c = await bearer(cpage);
    const bc = await cpage.request.post("/api/rooms/dms", { headers: { Authorization: c }, data: { user_ids: [run.users.bob.id] } });
    expect(bc.ok()).toBe(true);
    ids.bobDana = (await bc.json()).id;
    await cctx.close();
  });

  test.afterAll(() => {
    try {
      callsOn(false);
    } catch {
      /* the stack went away */
    }
  });

  async function open(page: Page, who: Who, to: string, theme: "light" | "dark" = "light") {
    await setTheme(page, theme);
    auth[who] = await bearer(page);
    await prefs(page, auth[who]!);
    await page.goto(to);
  }

  test("Alice video-calls Bob: both his tabs ring, he answers in one, video, screen share, mute, the small window", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    test.setTimeout(300_000);
    const A = name("alice");
    const B = name("bob");
    await open(alice, "alice", `/rooms/r/${ids.dm}`);
    await open(bob, "bob", `/rooms/r/${ids.dm}`, "dark");
    const bob2 = await bob.context().newPage();
    await setTheme(bob2, "dark");
    await bob2.goto("/calendar");
    await expect(alice.getByTestId("room-call-video")).toBeVisible({ timeout: 20_000 });
    // A grace moment for both of Bob's tabs to be listening.
    await bob2.waitForTimeout(1500);

    await alice.getByTestId("room-call-video").click();
    await expect(screen(alice)).toBeVisible();
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });

    // Every Bob tab rings (one in Rooms, one in Calendar).
    for (const page of [bob, bob2]) {
      await expect(incoming(page)).toBeVisible({ timeout: 20_000 });
      await expect(incoming(page)).toContainText(A);
      await expect(incoming(page)).toContainText("Incoming video call");
    }
    await expect(incoming(bob).getByRole("button", { name: "Answer with video" })).toBeFocused();
    await shot(bob, "incoming-call-desktop-dark.png");
    axeProblems.push(...(await axe(bob, "incoming call", '[data-testid="incoming-call"]')));

    // Bob answers in one tab; the other stops ringing.
    await incoming(bob).getByRole("button", { name: "Answer with video" }).click();
    await expect(incoming(bob2)).toHaveCount(0, { timeout: 15_000 });
    await expect(screen(bob)).toBeVisible();
    await expect(status(bob)).toHaveText(TIMER, { timeout: 30_000 });
    await expect(status(alice)).toHaveText(TIMER, { timeout: 30_000 });

    // Video both ways, and who's talking.
    await expect.poll(() => playing(alice, `call-video-${B}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => playing(bob, `call-video-${A}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(bob.getByTestId(`call-tile-${A}`)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    await expect(alice.getByTestId("call-self-video")).toBeVisible();
    await shot(alice, "call-1to1-video-desktop-light.png");
    axeProblems.push(...(await axe(alice, "call screen", '[data-testid="call-screen"]')));

    // The other tab knows: "You're in this call on another device".
    await go(bob2, `/rooms/r/${ids.dm}`);
    await expect(bob2.getByTestId("call-in-progress")).toContainText("You're in this call on another device", { timeout: 20_000 });
    await expect(bob2.getByTestId("call-join")).toHaveText("Switch here");
    await bob2.close();

    // Camera off: Alice sees his picture go.
    await bob.getByTestId("call-camera").click();
    await expect(bob.getByTestId("call-camera")).toHaveAttribute("aria-pressed", "false");
    await expect(alice.getByTestId(`call-video-${B}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(alice.getByTestId(`call-tile-${B}`)).toContainText("Camera off");
    // ...and back on.
    await bob.getByTestId("call-camera").click();
    await expect.poll(() => playing(alice, `call-video-${B}`), { timeout: 30_000 }).toBeGreaterThan(0);

    // Mute: Bob sees it.
    await alice.getByTestId("call-mute").click();
    await expect(alice.getByTestId("call-mute")).toHaveAttribute("aria-pressed", "true");
    await expect(bob.getByRole("img", { name: `${A} is muted` })).toBeVisible({ timeout: 15_000 });
    await alice.keyboard.press("Control+Shift+M");
    await expect(bob.getByRole("img", { name: `${A} is muted` })).toHaveCount(0, { timeout: 15_000 });

    // Screen sharing (Go Live's capture), big for Bob.
    await alice.getByTestId("call-share").click();
    await expect(alice.getByTestId("call-sharing")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => playing(bob, `call-screen-${A}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(bob.getByText(`${A} is sharing their screen`)).toBeVisible();
    await shot(bob, "call-screen-share-desktop-dark.png");
    await alice.getByTestId("call-share").click();
    await expect(bob.getByTestId(`call-screen-${A}`)).toHaveCount(0, { timeout: 15_000 });

    // The small window: keep talking while using Promptly.
    await alice.getByTestId("call-minimize").click();
    await expect(alice.getByTestId("call-mini")).toBeVisible();
    await go(alice, "/calendar");
    await expect(alice.getByTestId("call-mini")).toBeVisible();
    await expect(alice.getByTestId("call-mini-status")).toHaveText(TIMER);
    await shot(alice, "call-mini-window-desktop-light.png");
    await alice.getByTestId("call-expand").click();
    await expect(screen(alice)).toBeVisible();

    // Alice hangs up: it ends for both, and the conversation says so.
    await alice.getByTestId("call-hangup").click();
    await expect(bob.getByTestId("call-ended")).toContainText("Call ended", { timeout: 15_000 });
    await expect(screen(bob)).toHaveCount(0, { timeout: 15_000 });
    await expect(screen(alice)).toHaveCount(0, { timeout: 15_000 });
    await expect(bob.getByTestId("call-line").last()).toContainText("Video call ·", { timeout: 15_000 });
    await go(alice, `/rooms/r/${ids.dm}`);
    await expect(alice.getByTestId("call-line").last()).toContainText("Video call ·", { timeout: 15_000 });
  });

  test("Bob declines; then a missed call shows in the conversation", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    test.setTimeout(180_000);
    const A = name("alice");
    await open(alice, "alice", `/rooms/r/${ids.dm}`);
    await open(bob, "bob", `/rooms/r/${ids.dm}`);
    await expect(alice.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await bob.waitForTimeout(1000);

    // Declined: Alice hears "No answer" (never "declined").
    await alice.getByTestId("room-call-audio").click();
    await expect(incoming(bob)).toContainText("Incoming call", { timeout: 20_000 });
    await incoming(bob).getByRole("button", { name: "Decline" }).click();
    await expect(incoming(bob)).toHaveCount(0);
    await expect(alice.getByTestId("call-ended")).toContainText("No answer", { timeout: 15_000 });
    await expect(bob.getByTestId("call-line").last()).toContainText(`You declined a call from ${A}`, { timeout: 15_000 });
    await expect(alice.getByTestId("call-line").last()).toContainText("No answer", { timeout: 15_000 });
    await expect(screen(alice)).toHaveCount(0, { timeout: 15_000 });

    // Missed: nobody answers; the 45 s timeout (run now) ends it.
    await alice.getByTestId("room-call-audio").click();
    await expect(incoming(bob)).toBeVisible({ timeout: 20_000 });
    const callId = (await incoming(bob).getAttribute("data-call-id"))!;
    expect(ringTimeoutNow(callId)).toBe("missed");
    await expect(incoming(bob)).toHaveCount(0, { timeout: 15_000 });
    await expect(alice.getByTestId("call-ended")).toContainText("No answer", { timeout: 15_000 });
    const line = bob.getByTestId("call-line").last();
    await expect(line).toContainText(`Missed call from ${A}`, { timeout: 15_000 });
    await expect(line.getByRole("button", { name: "Call back" })).toBeVisible();
    await shot(bob, "missed-call-line-desktop-light.png");
    await expect(alice.getByTestId("call-line").last()).toContainText("No answer");
  });

  test("busy: Dana calls Bob mid-call, he ends one and answers the other", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const dana = await person("dana");
    test.setTimeout(180_000);
    await open(alice, "alice", `/rooms/r/${ids.dm}`);
    await open(bob, "bob", `/rooms/r/${ids.dm}`);
    await open(dana, "dana", `/rooms/r/${ids.bobDana}`);
    await expect(alice.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await bob.waitForTimeout(1000);
    await alice.getByTestId("room-call-audio").click();
    await incoming(bob).getByRole("button", { name: "Answer" }).click({ timeout: 20_000 });
    await expect(status(bob)).toHaveText(TIMER, { timeout: 30_000 });

    await dana.getByTestId("room-call-audio").click();
    await expect(incoming(bob)).toContainText(name("dana"), { timeout: 20_000 });
    await expect(bob.getByTestId("incoming-busy")).toContainText("You're on a call. Answering ends it.");
    await incoming(bob).getByRole("button", { name: "End and answer" }).click();
    await expect(status(bob)).toHaveText(TIMER, { timeout: 30_000 });
    await expect(bob.getByTestId("call-title")).toHaveText(name("dana"));
    // Alice's call with him ended.
    await expect(alice.getByTestId("call-ended")).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId("call-hangup").click();
    await expect(dana.getByTestId("call-ended")).toBeVisible({ timeout: 15_000 });
  });

  test("a group call of three: the grid, and Dana joins late from the bar", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const dana = await person("dana");
    test.setTimeout(240_000);
    const A = name("alice");
    const B = name("bob");
    const D = name("dana");
    await open(alice, "alice", `/rooms/r/${ids.group}`);
    await open(bob, "bob", `/rooms/r/${ids.group}`, "dark");
    await open(dana, "dana", `/rooms/r/${ids.group}`);
    await expect(alice.getByTestId("room-call-video")).toBeVisible({ timeout: 20_000 });
    await dana.waitForTimeout(1000);

    await alice.getByTestId("room-call-video").click();
    await expect(status(alice)).toHaveText("Ringing everyone…", { timeout: 20_000 });
    for (const page of [bob, dana]) await expect(incoming(page)).toContainText(`${A} is starting a video call`, { timeout: 20_000 });
    await expect(alice.getByTestId(`call-ringing-${B}`)).toBeVisible();
    await incoming(bob).getByRole("button", { name: "Answer with video" }).click();
    // Dana says no for now: the call carries on for the others.
    await incoming(dana).getByRole("button", { name: "Decline" }).click();
    await expect(status(alice)).toHaveText(/^2 people · \d+:\d{2}$/, { timeout: 30_000 });

    // The bar: "Call in progress · 2 people · Join".
    const bar = dana.getByTestId("call-in-progress");
    await expect(bar).toContainText("Video call in progress · 2 people", { timeout: 20_000 });
    await shot(dana, "call-in-progress-bar-desktop-light.png");
    await bar.getByRole("button", { name: "Join" }).click();
    await expect(status(dana)).toHaveText(/^3 people · \d+:\d{2}$/, { timeout: 30_000 });
    await dana.getByTestId("call-camera").click();
    for (const page of [alice, bob, dana]) {
      await expect(page.getByTestId("call-grid")).toBeVisible();
      await expect(page.getByTestId("call-tile-me")).toBeVisible();
    }
    await expect.poll(() => playing(dana, `call-video-${A}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => playing(alice, `call-video-${D}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => playing(alice, `call-video-${B}`), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(bob.getByTestId(`call-tile-${A}`)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    await shot(alice, "call-group-grid-desktop-light.png");
    await shot(bob, "call-group-grid-desktop-dark.png");

    // Bob leaves: it carries on for Alice and Dana.
    await bob.getByTestId("call-hangup").click();
    await expect(status(alice)).toHaveText(/^2 people · /, { timeout: 20_000 });
    for (const page of [alice, dana]) await page.getByTestId("call-hangup").click();
    await expect(alice.getByTestId("call-line").last()).toContainText("You started a video call ·", { timeout: 20_000 });
    await expect(bob.getByTestId("call-line").last()).toContainText(`${A} started a video call ·`, { timeout: 20_000 });
  });

  test("a blocked person can't call; the person who blocked sees why", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    test.setTimeout(120_000);
    await open(alice, "alice", `/rooms/r/${ids.dm}`);
    auth.bob = await bearer(bob);
    const r = await bob.request.put(`/api/people/blocks/${run.users.alice.id}`, { headers: { Authorization: auth.bob! } });
    expect(r.ok()).toBe(true);
    try {
      await alice.reload();
      await alice.getByTestId("room-call-audio").click({ timeout: 20_000 });
      await expect(alice.getByText("Calls can't be made in this conversation.")).toBeVisible({ timeout: 15_000 });
      await expect(screen(alice)).toHaveCount(0);
      await bob.goto(`/rooms/r/${ids.dm}`);
      await expect(bob.getByTestId("room-call-audio")).toBeDisabled({ timeout: 20_000 });
      await expect(bob.getByTestId("room-call-audio")).toHaveAttribute("title", `Unblock ${name("alice")} to call`);
    } finally {
      await bob.request.delete(`/api/people/blocks/${run.users.alice.id}`, { headers: { Authorization: auth.bob! } });
    }
  });

  test("on a phone: the incoming call fills the screen, then the call", async () => {
    test.setTimeout(180_000);
    const alice = await person("alice");
    const phone = await person("bob", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await open(alice, "alice", `/rooms/r/${ids.dm}`);
    await open(phone, "bob", `/rooms/r/${ids.dm}`);
    // The header keeps the call buttons; the rest is under More.
    await expect(phone.getByTestId("room-call-audio")).toBeVisible({ timeout: 20_000 });
    await expect(phone.getByRole("button", { name: "More" })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await phone.waitForTimeout(1000);

    await alice.getByTestId("room-call-audio").click();
    await expect(incoming(phone)).toBeVisible({ timeout: 20_000 });
    const box = await incoming(phone).boundingBox();
    expect(box && box.width >= 389 && box.height >= 840).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "incoming-call-phone-light.png") });
    axeProblems.push(...(await axe(phone, "phone incoming call", '[data-testid="incoming-call"]')));
    await incoming(phone).getByRole("button", { name: "Answer" }).tap();
    await expect(status(phone)).toHaveText(TIMER, { timeout: 30_000 });
    await phone.getByTestId("call-camera").tap();
    await expect(phone.getByTestId("call-self-video")).toBeVisible({ timeout: 15_000 });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "call-phone-light.png") });
    axeProblems.push(...(await axe(phone, "phone call screen", '[data-testid="call-screen"]')));
    // Minimise: the small window over Rooms.
    await phone.getByTestId("call-minimize").tap();
    await expect(phone.getByTestId("call-mini")).toBeVisible();
    await phone.getByTestId("call-mini-hangup").tap();
    await expect(alice.getByTestId("call-ended")).toBeVisible({ timeout: 15_000 });
    expect(axeProblems).toEqual([]);
  });
});
