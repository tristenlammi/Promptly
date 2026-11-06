// Copied secrets get cleared (plan 4), even with the popup closed and the worker gone.
// The schedule lives in an alarm and storage.session, so a restart doesn't lose it. A
// timer does the exact time while the worker's up, because alarms won't fire sooner than
// 30 s on Chrome and 60 s on Firefox.
//
// The clipboard can only be read with the clipboardRead permission, which we don't ask
// for unless the person turns it on (DECISIONS). With it, a clipboard that has changed
// since is left alone. Without it there's no way to tell, so it's cleared.
import { b64u, randomBytes, utf8 } from "../../../frontend/src/passwords/core/bytes";
import { ext } from "./rpc";

declare const __ENGINE__: string;
declare const __TEST_BUILD__: boolean;

export const CLIP_ALARM = "clip-clear";
const ALARM_FLOOR_MS = 30_000;
const session = ext.storage.session;

type ClipRecord = { salt: string; hash: string };

let timer: ReturnType<typeof setTimeout> | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pretendNoRead = false;

/** One clipboard job at a time, since Chromium allows one offscreen page. */
function inOrder<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function viaOffscreen<T>(message: Record<string, unknown>): Promise<T | undefined> {
  const off = chrome.offscreen;
  return inOrder(async () => {
    await off.createDocument({ url: "offscreen.html", reasons: [off.Reason.CLIPBOARD], justification: "Copy a 2FA code and clear copied secrets" }).catch(() => undefined);
    try {
      return (await ext.runtime.sendMessage({ t: "offscreenClip", ...message })) as T;
    } finally {
      await off.closeDocument().catch(() => undefined);
    }
  });
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (__ENGINE__ === "firefox") {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return !!(await viaOffscreen<{ ok: boolean }>({ op: "write", text }))?.ok;
  } catch {
    return false;
  }
}

export async function canCheckClipboard(): Promise<boolean> {
  if (__TEST_BUILD__ && pretendNoRead) return false;
  return ext.permissions.contains({ permissions: ["clipboardRead"] }).catch(() => false);
}

async function readClipboard(): Promise<string | null> {
  if (!(await canCheckClipboard())) return null;
  try {
    if (__ENGINE__ === "firefox") return await navigator.clipboard.readText();
    return (await viaOffscreen<{ text: string | null }>({ op: "read" }))?.text ?? null;
  } catch {
    return null;
  }
}

async function hashOf(text: string, salt: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(salt + text) as Uint8Array<ArrayBuffer>)));
}

function stopTimers() {
  if (timer) clearTimeout(timer);
  if (beat) clearInterval(beat);
  timer = null;
  beat = null;
}

/** Remember what was just copied, and when to clear it. Only a salted hash is kept. */
export async function watchClipboard(text: string, seconds: number): Promise<void> {
  const salt = b64u(randomBytes(16));
  await session.set({ clip: { salt, hash: await hashOf(text, salt) } satisfies ClipRecord });
  const ms = seconds * 1000;
  await ext.alarms.create(CLIP_ALARM, { when: Date.now() + Math.max(ms, ALARM_FLOOR_MS) });
  stopTimers();
  // Calling any extension API keeps the worker or event page from being put away early.
  beat = setInterval(() => void ext.runtime.getPlatformInfo().catch(() => undefined), 20_000);
  timer = setTimeout(() => void clearClipboardIfOurs(), ms);
}

/** Due. Clears unless we can tell the person has copied something else since. */
export async function clearClipboardIfOurs(): Promise<void> {
  stopTimers();
  const rec = (await session.get("clip")).clip as ClipRecord | undefined;
  await ext.alarms.clear(CLIP_ALARM);
  if (!rec) return;
  await session.remove("clip");
  // Empty, or a failed read, says nothing about the person's copying. Only something else
  // actually there means leave it alone.
  const now = await readClipboard();
  if (now && (await hashOf(now, rec.salt)) !== rec.hash) return;
  await writeClipboard("");
}

export const clipboardTest = {
  pretendNoRead: (on: boolean) => {
    pretendNoRead = on;
  },
};
