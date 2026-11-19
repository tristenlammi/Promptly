/**
 * The Promptly Android app's own camera for Rooms.
 *
 * A web page's camera (``CameraView``) gets the sensor's picture as it is. On
 * a phone with the app, the camera button in a conversation hands over to the
 * app instead (``android/app/.../roomscam/RoomsCameraActivity.kt``): the
 * phone's real camera, tap for a photo and hold for a video as before. The
 * app sends what you took to this conversation itself, with a ticket this
 * page asks the server for (``rooms/camera.py``): good for this one
 * conversation, photos and videos only, and nothing to read.
 *
 * The app says it has the camera: its launchers open Promptly with
 * ``caps=…,camera`` (``SuiteLauncher.java``). An older app doesn't, an iPhone
 * or a plain browser never does, and they all keep the page's own camera.
 * Imported early (``main.tsx``) to catch that before the router tidies the
 * address.
 */
import { roomsApi } from "@/api/rooms";
import { openHandoff } from "@/rtc/voice/androidApp";

const KEY = "promptly.android.camera";
const NO_APP_HASH = "#camera-no-app";

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/** What the launcher's address says about the camera: has it, hasn't, or says nothing. */
export function capFromSearch(search: string): boolean | null {
  const q = new URLSearchParams(search);
  const caps = q.get("caps");
  if (caps === null) return null;
  return caps.split(",").includes("camera");
}

/** Remember (or forget) that this phone's app has the camera. */
export function captureCameraCap(): void {
  try {
    const has = capFromSearch(window.location.search);
    if (has === true) window.localStorage.setItem(KEY, "1");
    // Opened by an app that doesn't say so: an older one. Its camera isn't there.
    else if (has === false) window.localStorage.removeItem(KEY);
  } catch {
    /* no storage: the page's own camera */
  }
}

/** This is an Android phone whose Promptly app has the Rooms camera. */
export function hasNativeCamera(): boolean {
  if (!isAndroid()) return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** The hand-off didn't work (app removed or too old): stop trying. */
export function forgetNativeCamera(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* fine */
  }
}

/**
 * ``intent://rooms/camera?…#Intent;scheme=promptly;package=org.promptly.app;…``.
 * The app only takes it for its own server. If the app can't take it, Chrome
 * comes back to this page with ``#camera-no-app`` ([onNoCameraApp]).
 */
export function cameraHandoffUrl(
  t: { ticket: string; room: string; title: string; maxBytes: number; bigMaxBytes?: number; tusEndpoint?: string | null },
  here: string = window.location.href, origin: string = window.location.origin): string {
  const q = new URLSearchParams({
    server: origin,
    ticket: t.ticket,
    room: t.room,
    title: t.title.slice(0, 80),
    max: String(t.maxBytes),
  });
  // Resumable uploads are on: the app may record a fuller video and send it in pieces.
  if (t.bigMaxBytes && t.tusEndpoint) {
    q.set("big", String(t.bigMaxBytes));
    q.set("tus", t.tusEndpoint);
  }
  const back = new URL(here);
  back.hash = NO_APP_HASH;
  return `intent://rooms/camera?${q.toString()}#Intent;scheme=promptly;package=org.promptly.app;S.browser_fallback_url=${encodeURIComponent(back.href)};end`;
}

/** Calls [cb] when Chrome came back to the fallback (no app to take the
 *  camera), now or later. Returns an unsubscribe. */
export function onNoCameraApp(cb: () => void): () => void {
  const check = () => {
    if (window.location.hash !== NO_APP_HASH) return;
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    cb();
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}

/**
 * Open the app's camera for this conversation. False when it couldn't even
 * be asked for (no connection, not allowed): the caller opens the page's own
 * camera, so the button never does nothing.
 */
export async function openNativeCamera(roomId: string, replyToId: string | null): Promise<boolean> {
  try {
    const t = await roomsApi.cameraTicket(roomId, replyToId);
    openHandoff(cameraHandoffUrl({ ticket: t.ticket, room: roomId, title: t.title, maxBytes: t.max_bytes, bigMaxBytes: t.big_max_bytes, tusEndpoint: t.tus_endpoint }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Back from the app's camera: did it send? True when one of [mine] is newer
 * than when the camera was opened and, if you were replying, answers that
 * message. [skewMs] forgives a phone clock a little ahead of the server's.
 */
export function sentFromCamera(
  mine: { created_at: string; reply_to: { id: string } | null }[],
  opened: { at: number; replyId: string | null },
  skewMs = 15_000,
): boolean {
  return mine.some((m) => {
    const at = Date.parse(m.created_at);
    if (!(at >= opened.at - skewMs)) return false;
    return opened.replyId ? m.reply_to?.id === opened.replyId : true;
  });
}

captureCameraCap();
