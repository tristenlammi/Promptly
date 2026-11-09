import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { png } from "../lib/files";
import { notesReady } from "../lib/notes";
import { BACKEND, BASE_URL, storageStateFile } from "../lib/stack";

/** Promptly Notes (N1.3): pictures and voice notes.
 *
 *  - a picture from this device, and a voice note recorded in the browser
 *    (Chromium's fake microphone playing real speech made by the stack's own
 *    TTS), transcribed by the stack's Whisper, found by a word in it, and
 *    played by a collaborator; a removed collaborator's link and a stranger
 *    get 404;
 *  - a 20-minute recording uploads over a connection that drops mid-way
 *    (tus carries on from where it got to), plays back for a collaborator
 *    (seekable), and is found by a word spoken 15 minutes in.
 *
 *  Needs the stack's voice extra: scripts/stack.sh up notes --with media,voice */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notes-e2e-"));

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

async function say(page: Page, auth: string, text: string, file: string): Promise<string> {
  const r = await page.request.post("/api/voice/tts", { headers: { Authorization: auth }, data: { text } });
  expect(r.ok(), `the stack's TTS (${r.status()})`).toBe(true);
  const out = path.join(tmp, file);
  fs.writeFileSync(out, await r.body());
  return out;
}


async function newNote(page: Page, auth: string, title: string, text = ""): Promise<string> {
  const r = await page.request.post("/api/notes", {
    headers: { Authorization: auth },
    data: { client_id: crypto.randomUUID(), title, text },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).note.id;
}

async function serverNote(page: Page, auth: string, id: string) {
  const r = await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } });
  return r.ok() ? (await r.json()).note : null;
}

async function share(page: Page, auth: string, id: string, userId: string) {
  const r = await page.request.post(`/api/notes/${id}/members`, { headers: { Authorization: auth }, data: { user_ids: [userId] } });
  expect(r.ok()).toBe(true);
}

/** The first recording in the open note plays: time moves on. */
async function plays(page: Page): Promise<void> {
  const player = page.locator("[data-note-audio]").first();
  await player.getByRole("button", { name: /^Play / }).click();
  await expect(player.getByRole("button", { name: /^Pause / })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLAudioElement>("[data-note-audio] audio")?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await player.getByRole("button", { name: /^Pause / }).click();
}

test.describe("notes: pictures and voice", () => {
  test("a picture and a recorded voice note: transcribed, found, and played by a collaborator", async ({ alice: page, bob }) => {
    test.setTimeout(6 * 60_000);
    const auth = await notesReady(page);
    const title = `Song ${stamp}`;
    const id = await newNote(page, auth, title, "Verse one: the lyrics stay mine");
    const speech = await say(page, auth, "The purple elephant sings the chorus. The purple elephant sings the chorus again.", "speech.wav");

    // A picture from this device.
    await page.goto(`/notes/n/${id}`);
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Add image" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "From this device" }).click();
    await (await chooser).setFiles(png("cover.png"));
    await expect(dialog.getByRole("img", { name: "cover.png" })).toBeVisible();
    await expect.poll(async () => (await serverNote(page, auth, id))?.attachments.length, { timeout: 30_000 }).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    // A voice note, recorded in the browser: Chromium's fake microphone plays the speech.
    const recBrowser = await chromium.launch({
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`],
    });
    try {
      const ctx = await recBrowser.newContext({ storageState: storageStateFile("alice"), baseURL: BASE_URL, viewport: { width: 1366, height: 860 }, serviceWorkers: "block" });
      await ctx.route("**/version.json*", (r) => r.abort());
      const rec = await ctx.newPage();
      await rec.goto(`/notes/n/${id}`);
      const d = rec.getByRole("dialog", { name: title });
      await expect(d).toBeVisible({ timeout: 20_000 });
      await d.getByRole("button", { name: "Record a voice note" }).click();
      const sheet = rec.getByRole("dialog", { name: "Record a voice note" });
      await expect(sheet.getByRole("button", { name: "Pause" })).toBeEnabled();
      await rec.waitForTimeout(7_000);
      await sheet.getByRole("button", { name: "Stop and save" }).click();
      await expect(sheet).toHaveCount(0);
      // In the note at once (from this device), then uploaded and attached.
      await expect(d.locator("[data-note-audio]")).toHaveCount(1);
      await expect.poll(async () => (await serverNote(page, auth, id))?.attachments.filter((a: { kind: string }) => a.kind === "audio").length, { timeout: 30_000 }).toBe(1);
      await expect(d.getByText("Transcribing…").or(d.getByText("purple", { exact: false }))).toBeVisible({ timeout: 20_000 });
      await ctx.close();
    } finally {
      await recBrowser.close();
    }

    // Whisper's words: under the recording, never replacing the note's text.
    await expect
      .poll(async () => {
        const n = await serverNote(page, auth, id);
        const a = n?.attachments.find((x: { kind: string }) => x.kind === "audio");
        return a ? `${a.transcript_state}:${a.transcript ?? ""}` : "";
      }, { timeout: 4 * 60_000, intervals: [2000] })
      .toMatch(/^done:.*purple/i);
    const n = await serverNote(page, auth, id);
    expect(n.body_text).toBe("Verse one: the lyrics stay mine");
    const audio = n.attachments.find((x: { kind: string }) => x.kind === "audio");
    expect(audio.peaks.length).toBeGreaterThan(10);
    expect(audio.duration_ms).toBeGreaterThan(4000);

    // Found by a word in it.
    await page.goto("/notes");
    await notesReady(page);
    await page.getByRole("searchbox", { name: "Search your notes" }).fill("elephant");
    await expect(page.locator("article[data-note-card]").filter({ hasText: title })).toBeVisible({ timeout: 15_000 });

    // Bob, once it's shared with him (the share dialog is N1.4): he sees the
    // picture and plays the recording — though Ann's Drive files aren't his.
    await share(page, auth, id, run.users.bob.id);
    const bobAuth = await notesReady(bob);
    await bob.goto(`/notes/n/${id}`);
    const bd = bob.getByRole("dialog", { name: title });
    await expect(bd).toBeVisible({ timeout: 20_000 });
    await expect(bd.getByText(/purple elephant/i).first()).toBeVisible();
    await expect.poll(() => bd.getByRole("img", { name: "cover.png" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await plays(bob);
    const bobNote = await serverNote(bob, bobAuth, id);
    const bobLink: string = bobNote.attachments.find((x: { kind: string }) => x.kind === "audio").urls.play ?? bobNote.attachments[0].urls.original;
    expect((await bob.request.get(bobLink)).status()).toBe(200);
    const fileId: string = audio.file_id;
    expect((await bob.request.get(`/api/files/${fileId}/signed-urls`, { headers: { Authorization: bobAuth } })).status()).toBe(404);

    // Removed: Bob's link stops at once. A stranger never had the note.
    const r = await page.request.delete(`/api/notes/${id}/members/${run.users.bob.id}`, { headers: { Authorization: auth } });
    expect(r.ok()).toBe(true);
    expect((await bob.request.get(bobLink)).status()).toBe(404);
    expect((await bob.request.get(`/api/notes/${id}`, { headers: { Authorization: bobAuth } })).status()).toBe(404);
  });

  test("a 20-minute recording uploads over a dropping connection, plays for a collaborator, and is found", async ({ alice: page, bob }) => {
    test.setTimeout(15 * 60_000);
    const auth = await notesReady(page);
    const title = `Rehearsal ${stamp}`;
    const id = await newNote(page, auth, title);
    // Twenty minutes: words at the start, silence, words 15 minutes in.
    const first = await say(page, auth, "Warm up with the scales first.", "first.wav");
    const later = await say(page, auth, "Now the saxophone solo in the bridge.", "later.wav");
    docker(["cp", first, `${BACKEND}:/tmp/first.wav`]);
    docker(["cp", later, `${BACKEND}:/tmp/later.wav`]);
    docker([
      "exec", BACKEND, "ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", "/tmp/first.wav", "-i", "/tmp/later.wav", "-filter_complex",
      "[0:a]aresample=48000,apad=whole_dur=900[a];[1:a]aresample=48000[b];[a][b]concat=n=2:v=0:a=1,apad=whole_dur=1200[out]",
      "-map", "[out]", "-ac", "1", "-c:a", "libopus", "-b:a", "48k", "-f", "webm", "/tmp/rehearsal.webm",
    ]);
    const long = path.join(tmp, "Rehearsal.webm");
    docker(["cp", `${BACKEND}:/tmp/rehearsal.webm`, long]);
    const size = fs.statSync(long).size;
    expect(size).toBeGreaterThan(2.5 * 1024 * 1024); // more than one 2 MB piece

    // The connection drops on the second piece: tus asks where it got to and carries on.
    let dropped = 0;
    const patches: string[] = [];
    await page.route("**/api/files/tus/**", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") {
        patches.push(req.headers()["upload-offset"] ?? "?");
        if (patches.length === 2 && !dropped) {
          dropped++;
          return route.abort("connectionreset");
        }
      }
      return route.continue();
    });

    await page.goto(`/notes/n/${id}`);
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Record a voice note" }).click();
    const sheet = page.getByRole("dialog", { name: "Record a voice note" });
    const chooser = page.waitForEvent("filechooser");
    await sheet.getByRole("button", { name: "Choose an audio file instead" }).click();
    await (await chooser).setFiles(long);
    await expect(sheet).toHaveCount(0);
    await expect(dialog.locator("[data-note-audio]")).toHaveCount(1);
    await expect.poll(async () => (await serverNote(page, auth, id))?.attachments.length, { timeout: 120_000 }).toBe(1);
    expect(dropped).toBe(1);
    // It went on from the piece it had, not from the start.
    const resumedAt = patches.slice(2).map(Number);
    expect(resumedAt.length).toBeGreaterThan(0);
    expect(Math.min(...resumedAt)).toBeGreaterThan(0);
    await page.unroute("**/api/files/tus/**");

    // Transcribed (two 10-minute chunks on the stack's Whisper), with the
    // words from 15 minutes in.
    await expect
      .poll(async () => {
        const a = (await serverNote(page, auth, id))?.attachments[0];
        return a ? `${a.transcript_state}:${a.transcript ?? ""}` : "";
      }, { timeout: 12 * 60_000, intervals: [5000] })
      .toMatch(/^done:[\s\S]*saxophone/i);
    const a = (await serverNote(page, auth, id)).attachments[0];
    expect(a.duration_ms).toBeGreaterThan(1_195_000);
    expect(a.transcript).toMatch(/\[0:10:00\]/);

    // Found by that word.
    const hits = await page.request.get("/api/notes", { headers: { Authorization: auth }, params: { q: "saxophone" } });
    expect((await hits.json()).notes.map((x: { id: string }) => x.id)).toContain(id);

    // Bob plays it from 15 minutes in (a seekable copy).
    await share(page, auth, id, run.users.bob.id);
    await notesReady(bob);
    await bob.goto(`/notes/n/${id}`);
    const bd = bob.getByRole("dialog", { name: title });
    await expect(bd).toBeVisible({ timeout: 20_000 });
    const slider = bd.getByRole("slider", { name: /Position in Rehearsal/ });
    await expect(slider).toHaveAttribute("aria-valuemax", /^1[12]\d\d$/);
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    await bob.mouse.click(box!.x + box!.width * 0.75, box!.y + box!.height / 2);
    await bd.getByRole("button", { name: /^Play / }).click();
    await expect
      .poll(() => bob.evaluate(() => document.querySelector<HTMLAudioElement>("[data-note-audio] audio")?.currentTime ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(880);
    await bd.getByRole("button", { name: /^Pause / }).click();
  });
});
