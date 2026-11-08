// Calls WP-V3: the web voice engine, end to end, through its developer
// harness (/dev/voice; the real voice UI is WP-V4). Alice and Bob join a
// voice channel in two browser contexts, hear each other (a level is
// measured on the sound that actually arrives), mute, deafen, and Alice
// goes live while Bob watches. Needs the calls service in the stack under
// test (scripts/stack.sh up <name> --with calls); skipped without it.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, storageStateFile } from "../lib/stack";

// Both people's fake microphone plays synthetic speech (Chrome's default
// beep is noise to the suppressor); the fake screen is Chrome's own.
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

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/dev/voice");
  return (await seen).headers()["authorization"];
}

/** Opens the harness with default voice settings (Enhanced, voice activity). */
async function openHarness(page: Page, inputMode: "vad" | "ptt" = "vad"): Promise<string> {
  await page.addInitScript(() => window.localStorage.setItem("promptly.dev", "voice"));
  const auth = await bearer(page);
  const r = await page.request.patch("/api/auth/me/preferences", {
    headers: { Authorization: auth },
    data: {
      voice: { noise: "enhanced", input_mode: inputMode, ptt_key: "Backquote", ptt_release_ms: 200, auto_sensitivity: true, input_volume: 100, output_volume: 100, sounds: true, data_saver: false },
      voice_volumes: {},
      voice_local_mutes: [],
    },
  });
  expect(r.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Voice engine harness" })).toBeVisible({ timeout: 20_000 });
  return auth;
}

const level = (page: Page, label: string) => page.getByRole("meter", { name: label });

/** Waits until a meter reads above / below a value (0..100). */
async function meterWhere(page: Page, label: string, test: (v: number) => boolean, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => test(Number(await level(page, label).getAttribute("aria-valuenow"))), { timeout, intervals: [200], message: `${label} meter` })
    .toBe(true);
}

/** Over ``ms``, the meter's highest reading. */
async function meterPeak(page: Page, label: string, ms = 2500): Promise<number> {
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    peak = Math.max(peak, Number((await level(page, label).getAttribute("aria-valuenow")) ?? 0));
    await page.waitForTimeout(100);
  }
  return peak;
}

test.describe("voice engine", () => {
  const channel = `Lounge ${stamp}`;

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    voiceOn(true);
    // Alice makes a space with Bob in it, and a voice channel.
    const ctx = await browser.newContext({ storageState: storageStateFile("alice") });
    const page = await ctx.newPage();
    await page.addInitScript(() => window.localStorage.setItem("promptly.dev", "voice"));
    const auth = await bearer(page);
    const headers = { Authorization: auth };
    const space = await (await page.request.post("/api/rooms/spaces", { headers, data: { name: `Voice ${stamp}` } })).json();
    expect(space.id).toBeTruthy();
    const added = await page.request.post(`/api/rooms/spaces/${space.id}/members`, { headers, data: { user_ids: [run.users.bob.id] } });
    expect(added.ok()).toBe(true);
    const room = await page.request.post(`/api/rooms/spaces/${space.id}/rooms`, { headers, data: { name: channel, kind: "voice" } });
    expect(room.ok()).toBe(true);
    await ctx.close();
  });

  test.afterAll(() => {
    try {
      voiceOn(false);
    } catch {
      /* the stack went away */
    }
  });

  test("two people hear each other, mute, deafen, and go live", async ({ alice, bob }) => {
    test.setTimeout(240_000);
    const A = run.users.alice.username;
    const B = run.users.bob.username;
    await openHarness(alice);
    const bobAuth = await openHarness(bob);

    // Join: one click each.
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: `Join ${channel}` }).click();
      await expect(page.getByTestId("voice-status")).toHaveText("connected", { timeout: 30_000 });
      await expect(page.getByTestId("voice-room")).toHaveText(channel);
    }
    // Enhanced noise suppression runs GTCRN on this machine.
    await expect(alice.getByTestId("voice-noise")).toContainText("enhanced → gtcrn", { timeout: 15_000 });

    // Both in the channel, as the server sees it.
    await expect(bob.getByTestId(`occupants-${channel}`)).toContainText(A);
    await expect(bob.getByTestId(`occupants-${channel}`)).toContainText(B);

    // They hear each other: the sound that arrives has a level.
    await expect(bob.getByTestId(`peer-${A}`)).toBeVisible({ timeout: 20_000 });
    await meterWhere(bob, `Level of ${A}`, (v) => v > 15, 30_000);
    await meterWhere(alice, `Level of ${B}`, (v) => v > 15, 30_000);
    // Alice's own (suppressed) mic meter moves, and the server hears her
    // speaking edges: Bob's channel list shows the ring.
    await meterWhere(alice, "My level", (v) => v > 15);
    await expect(bob.getByTestId(`occupants-${channel}`)).toContainText(`${A} (speaking)`, { timeout: 20_000 });

    // Mute: Bob stops hearing Alice, and everyone sees her muted.
    await alice.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    await expect(bob.getByTestId(`member-${A}`)).toContainText("muted", { timeout: 15_000 });
    await bob.waitForTimeout(1500);
    expect(await meterPeak(bob, `Level of ${A}`)).toBeLessThan(5);
    await alice.getByRole("button", { name: "Unmute" }).click();
    await meterWhere(bob, `Level of ${A}`, (v) => v > 15);

    // Deafen: Bob hears nothing and is muted too; undeafen brings Alice back.
    await bob.getByRole("button", { name: "Deafen", exact: true }).click();
    await expect(alice.getByTestId(`member-${B}`)).toContainText("muted, deafened", { timeout: 15_000 });
    await bob.waitForTimeout(1500);
    expect(await meterPeak(bob, `Level of ${A}`)).toBeLessThan(5);
    expect(await meterPeak(alice, `Level of ${B}`)).toBeLessThan(5);
    await bob.getByRole("button", { name: "Undeafen" }).click();
    await meterWhere(bob, `Level of ${A}`, (v) => v > 15);
    await meterWhere(alice, `Level of ${B}`, (v) => v > 15);

    // Go Live: Alice shares (Chrome's fake screen), Bob watches.
    await alice.getByRole("button", { name: "Go Live" }).click();
    await expect(alice.getByTestId("live-info")).toContainText("LIVE 720p30", { timeout: 20_000 });
    await expect(bob.getByTestId(`member-${A}`)).toContainText("LIVE", { timeout: 15_000 });
    // Nothing downloads until Bob presses Watch.
    await expect(bob.getByLabel(`${A}'s stream`)).toHaveCount(0);
    await bob.getByRole("button", { name: `Watch ${A}` }).click();
    const stream = bob.getByLabel(`${A}'s stream`);
    await expect(stream).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => stream.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(alice.getByTestId(`member-${B}`)).toContainText(`watching ${A}`, { timeout: 15_000 });
    await bob.getByRole("button", { name: "Stop watching" }).click();
    await expect(stream).toHaveCount(0);
    await alice.getByRole("button", { name: "Stop streaming" }).click();
    await expect(bob.getByTestId(`member-${A}`)).not.toContainText("LIVE", { timeout: 15_000 });

    // How much of a core the GTCRN worklet (suppressor + gain + gate +
    // meter) uses on this machine: one-second readings for 10 s.
    const samples: number[] = [];
    let engine = "";
    for (let i = 0; i < 10; i++) {
      const n = await alice.evaluate(() => (window as unknown as { __voice: { store: { getState(): { noise: { load: number | null; engine: string } } } } }).__voice.store.getState().noise);
      engine = n.engine;
      if (n.load !== null) samples.push(n.load);
      await alice.waitForTimeout(1000);
    }
    samples.sort((x, y) => x - y);
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    console.log(`voice: ${engine} worklet load median ${pct(samples[samples.length >> 1])}, min ${pct(samples[0])}, max ${pct(samples[samples.length - 1])} of one core (${samples.length} readings)`);
    expect(engine).toBe("gtcrn");
    expect(samples.length).toBeGreaterThan(5);
    expect(samples[samples.length >> 1]).toBeLessThan(0.5);

    // Per-person volume is remembered (it's in Bob's account settings).
    await bob.getByLabel(`Volume of ${A}`).fill("60");
    await expect(bob.getByText("Volume 60%")).toBeVisible();

    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: "Leave" }).click();
      await expect(page.getByTestId("voice-status")).toHaveText("idle", { timeout: 15_000 });
    }
    await expect(bob.getByTestId(`occupants-${channel}`)).toHaveText("empty", { timeout: 15_000 });
    // Saved to Bob's account (debounced), so it follows him to every device.
    await expect
      .poll(async () => {
        const me = await (await bob.request.get("/api/auth/me", { headers: { Authorization: bobAuth } })).json();
        return me.settings?.voice_volumes?.[run.users.alice.id];
      }, { timeout: 10_000 })
      .toBe(60);
  });

  test("push to talk sends only while the key is held", async ({ alice, bob }) => {
    test.setTimeout(120_000);
    const A = run.users.alice.username;
    await openHarness(alice, "ptt");
    await openHarness(bob);
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: `Join ${channel}` }).click();
      await expect(page.getByTestId("voice-status")).toHaveText("connected", { timeout: 30_000 });
    }
    await expect(bob.getByTestId(`peer-${A}`)).toBeVisible({ timeout: 20_000 });
    // Talking without the key: nothing goes out.
    await bob.waitForTimeout(2000);
    expect(await meterPeak(bob, `Level of ${A}`)).toBeLessThan(5);
    // Holding the key (focus on the page, not in a field): Bob hears her.
    await alice.locator("body").click({ position: { x: 5, y: 5 } });
    await alice.keyboard.down("Backquote");
    await expect(alice.getByRole("button", { name: "Hold to talk" })).toHaveAttribute("aria-pressed", "true");
    await meterWhere(bob, `Level of ${A}`, (v) => v > 15);
    await alice.keyboard.up("Backquote");
    await bob.waitForTimeout(1500);
    expect(await meterPeak(bob, `Level of ${A}`)).toBeLessThan(5);
    for (const page of [alice, bob]) await page.getByRole("button", { name: "Leave" }).click();
  });
});
