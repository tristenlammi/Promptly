// Spoken test clips for Talk (WP-T4), made at test time by the stack's own
// text-to-speech (Kokoro, through /api/voice/tts), so no audio sits in the
// repo. A clip is speech and silence laid end to end into one WAV, which
// Chrome plays as the microphone once (--use-file-for-fake-audio-capture
// with %noloop), starting when the page opens the microphone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { APIRequestContext } from "@playwright/test";

export interface Pcm {
  rate: number;
  samples: Int16Array;
}

/** PCM16 mono out of a WAV file's bytes. */
export function readWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let rate = 24000;
  let channels = 1;
  let bits = 16;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`WAV is ${bits}-bit, expected 16`);
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(body + i * 2 * channels);
      return { rate, samples: out };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV has no data");
}

export function writeWav(pcm: Pcm): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2);
  pcm.samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(pcm.rate, 24);
  head.writeUInt32LE(pcm.rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** ``text`` spoken by the server's TTS. */
export async function say(request: APIRequestContext, auth: string, text: string, voice = "am_michael"): Promise<Pcm> {
  const r = await request.post("/api/voice/tts", {
    headers: { Authorization: auth },
    data: { text, voice, speed: 1.0 },
    timeout: 60_000,
  });
  if (!r.ok()) throw new Error(`TTS failed: ${r.status()} ${await r.text()}`);
  return readWav(Buffer.from(await r.body()));
}

/** Speech and silences (in seconds) one after another, as a WAV file in the
 *  temp folder; returns its path. */
export function clip(name: string, parts: (Pcm | number)[]): string {
  const rate = parts.find((p): p is Pcm => typeof p !== "number")?.rate ?? 24000;
  const chunks: Int16Array[] = parts.map((p) => {
    if (typeof p === "number") return new Int16Array(Math.round(p * rate));
    if (p.rate !== rate) throw new Error("mixed sample rates");
    return p.samples;
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const file = path.join(os.tmpdir(), `promptly-talk-${name}-${process.pid}.wav`);
  fs.writeFileSync(file, writeWav({ rate, samples: all }));
  return file;
}

/** Chrome flags for a fake microphone that plays ``wav`` once. */
export function fakeMic(wav: string): string[] {
  return [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    // A reload mid-conversation resumes without a tap (the test can't
    // tap "Tap to hear Promptly" in between).
    "--autoplay-policy=no-user-gesture-required",
  ];
}
