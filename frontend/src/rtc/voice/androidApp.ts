/**
 * The Promptly Android app's voice service (Calls WP-V5). Chrome on Android
 * (and so every P launcher, which is Chrome) can't keep a microphone going
 * with the screen off, so on a phone with the app, Join hands the channel to
 * the app (``android/app/.../voice/VoiceService.kt``), which holds the audio
 * in the background; this page stays the UI and drives it through the server.
 *
 * The app tells pages it can do this: its launchers open Promptly with
 * ``?caps=voice`` (``SuiteLauncher.java``). Imported early (``main.tsx``) to
 * catch that before the router tidies the address.
 */
import type { VoiceJoin } from "@/api/voiceChannels";

const KEY = "promptly.android.voice";
const NO_APP_HASH = "#voice-no-app";

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

const CALLS_KEY = "promptly.android.calls";
const CALLOUT_KEY = "promptly.android.callout";
const NO_CALL_APP_HASH = "#call-no-app";

/** Remember that this phone has the app (from the launcher's address). */
export function captureAppCaps(): void {
  try {
    const caps = (new URLSearchParams(window.location.search).get("caps") ?? "").split(",");
    if (caps.includes("voice")) window.localStorage.setItem(KEY, String(Date.now()));
    // Calls WP-D3: the app rings DM calls itself.
    if (caps.includes("calls")) window.localStorage.setItem(CALLS_KEY, String(Date.now()));
    // Calls WP-D5: and calls you start go through it too.
    if (caps.includes("callout")) window.localStorage.setItem(CALLOUT_KEY, String(Date.now()));
  } catch {
    /* no storage: the page holds voice itself */
  }
  if (hasAndroidCallsApp()) tellWorker(true);
}

/**
 * This is an Android phone whose Promptly app rings DM calls (Calls WP-D3):
 * full screen over the lock screen, through Android's call system, answered
 * by the app's own call service. The page then stays quiet when a call
 * rings, and the service worker gives the ring's answer token to the app.
 */
export function hasAndroidCallsApp(): boolean {
  if (!isAndroid()) return false;
  try {
    return !!window.localStorage.getItem(CALLS_KEY);
  } catch {
    return false;
  }
}

/**
 * This phone's Promptly app also takes calls you start (Calls WP-D5): Call
 * and Video call hand the call to the app, which holds it (and the camera)
 * with the screen locked or the page closed. Older apps don't say so, and
 * keep the call in the page.
 */
export function hasAndroidCallsOut(): boolean {
  if (!hasAndroidCallsApp()) return false;
  try {
    return !!window.localStorage.getItem(CALLOUT_KEY);
  } catch {
    return false;
  }
}

/** The app couldn't take a call (removed): the page rings and holds calls again. */
export function forgetAndroidCallsApp(): void {
  try {
    window.localStorage.removeItem(CALLS_KEY);
    window.localStorage.removeItem(CALLOUT_KEY);
  } catch {
    /* fine */
  }
  tellWorker(false);
}

/**
 * ``intent://call/start?…#Intent;scheme=promptly;package=org.promptly.app;…``:
 * a call this page started for the phone (``device: "android"``), handed to
 * the app with its session. The app only takes it for its own server, and
 * asks first. If the app can't take it, Chrome comes back to this page with
 * ``#call-no-app`` ([onNoCallApp]).
 */
export function callHandoffUrl(join: { session: string; call: { id: string; media: string }; title?: string | null }): string {
  const q = new URLSearchParams({
    server: window.location.origin,
    session: join.session,
    call: join.call.id,
    video: join.call.media === "video" ? "1" : "0",
    title: (join.title ?? "").slice(0, 80),
  });
  const here = new URL(window.location.href);
  here.hash = NO_CALL_APP_HASH;
  return `intent://call/start?${q.toString()}#Intent;scheme=promptly;package=org.promptly.app;S.browser_fallback_url=${encodeURIComponent(here.href)};end`;
}

/** Calls [cb] when Chrome came back to the fallback of a call hand-off. */
export function onNoCallApp(cb: () => void): () => void {
  const check = () => {
    if (window.location.hash !== NO_CALL_APP_HASH) return;
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    cb();
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}

/** The service worker can't read the page's storage: tell it (renewed on every visit). */
function tellWorker(on: boolean): void {
  try {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    void sw.ready.then((r) => r.active?.postMessage({ type: "promptly-android-calls", on })).catch(() => undefined);
  } catch {
    /* no service worker: no app rings either */
  }
}

/** This is an Android phone with the Promptly app's voice service. */
export function hasAndroidVoiceApp(): boolean {
  if (!isAndroid()) return false;
  try {
    return !!window.localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

/** The hand-off didn't work (app removed or too old): stop trying. */
export function forgetAndroidVoiceApp(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* fine */
  }
}

/**
 * ``intent://voice/join?…#Intent;scheme=promptly;package=org.promptly.app;…``.
 * If the app can't take it, Chrome goes to the fallback instead: this same
 * page with ``#voice-no-app``, which [onNoApp] notices.
 */
export function handoffUrl(join: VoiceJoin, names: { channel: string; space: string }): string {
  const q = new URLSearchParams({
    server: window.location.origin,
    session: join.session,
    room: join.room_id,
    channel: names.channel,
    space: names.space,
  });
  const here = new URL(window.location.href);
  here.hash = NO_APP_HASH;
  return `intent://voice/join?${q.toString()}#Intent;scheme=promptly;package=org.promptly.app;S.browser_fallback_url=${encodeURIComponent(here.href)};end`;
}

/** Calls [cb] when Chrome came back to the fallback (no app to take the
 *  hand-off), now or later. Returns an unsubscribe. */
export function onNoApp(cb: () => void): () => void {
  const check = () => {
    if (window.location.hash !== NO_APP_HASH) return;
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    cb();
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}

/** Opens the hand-off (voice or a call). In the e2e harness the URL is kept
 *  instead (a desktop browser has no app to open). */
export function openHandoff(url: string): void {
  const w = window as unknown as { __voiceHandoff?: string[] };
  if (w.__voiceHandoff) {
    w.__voiceHandoff.push(url);
    return;
  }
  window.location.href = url;
}

captureAppCaps();
