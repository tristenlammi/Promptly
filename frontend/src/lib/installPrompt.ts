import { useSyncExternalStore } from "react";

/**
 * Early capture of the browser's install prompt.
 *
 * Chrome / Edge / Android fire ``beforeinstallprompt`` once the page's
 * manifest qualifies — often before React has mounted anything, so a
 * component that starts listening in an effect can miss it. This module
 * listens from import time (``main.tsx`` imports it first thing), stashes
 * the latest event and lets any component read it / subscribe to changes.
 *
 * The event belongs to whichever manifest was linked when it fired; when
 * the route swaps manifests (``useDrivePwaManifest``) the browser fires a
 * fresh one and the stash is replaced. Safari never fires it — iPhone/iPad
 * users install with Share → Add to Home Screen.
 */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let started = false;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  for (const fn of listeners) fn();
}

/** Start listening (idempotent; also runs on import). */
export function initInstallPromptCapture(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep it for our own Install button instead of the browser's mini-infobar.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

initInstallPromptCapture();

/** The stashed ``beforeinstallprompt`` event, or null when none is available. */
export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferred;
}

/** True once the browser reported an install in this page session. */
export function wasAppInstalled(): boolean {
  return installed;
}

/** Called whenever the stashed event or the installed flag changes. */
export function subscribeInstallPrompt(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Show the browser's install dialog. An event can be prompted only once. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null;
  emit();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice.outcome;
  } catch {
    return "unavailable";
  }
}

/** Running as an installed app (its own window), not in a browser tab. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Which of Promptly's apps a path belongs to (each installs separately). */
export function appKeyFor(path: string): string {
  if (path === "/photos" || path.startsWith("/photos/")) return "photos";
  if (path === "/rooms" || path.startsWith("/rooms/")) return "rooms";
  if (path === "/calendar" || path.startsWith("/calendar/")) return "calendar";
  const m = /^\/app\/([^/]+)/.exec(path);
  return m ? `app:${m[1]}` : "promptly";
}

// An installed app's window can't tell which app it is from the display
// mode alone, so remember the app the window opened as (the first page an
// installed window loads is its start_url). sessionStorage lives as long
// as the window does.
const LAUNCH_KEY = "promptly:launched-app";
if (typeof window !== "undefined" && isStandaloneDisplay()) {
  try {
    if (!sessionStorage.getItem(LAUNCH_KEY)) sessionStorage.setItem(LAUNCH_KEY, appKeyFor(location.pathname));
  } catch {
    /* storage blocked: treat the window as Promptly */
  }
}

/** The app this installed window was launched as ("promptly", "photos", "app:<id>"). */
export function launchedAppKey(): string | null {
  if (!isStandaloneDisplay()) return null;
  try {
    return sessionStorage.getItem(LAUNCH_KEY) ?? "promptly";
  } catch {
    return "promptly";
  }
}

export function isAndroidDevice(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/** Open a page in the browser rather than inside this installed app — a
 *  browser only offers to install from one of its own tabs. Every page here
 *  is inside the installed Promptly app's scope, so on Android a plain link
 *  would just stay in the app; an ``intent://`` link hands it to Chrome
 *  (falling back to the system's handler when Chrome isn't there). */
export function openInBrowser(url: string): void {
  const u = new URL(url, location.href);
  if (isAndroidDevice()) {
    const fallback = encodeURIComponent(u.href);
    location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(":", "")};package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
    return;
  }
  window.open(u.href, "_blank", "noopener");
}

/** iPhone / iPad (including iPadOS reporting itself as a Mac). */
export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export interface InstallPromptState {
  /** The browser offered installation: ``prompt()`` will show its dialog. */
  canPrompt: boolean;
  /** Installed during this page session (``appinstalled`` fired). */
  installed: boolean;
  /** This page is running inside an installed app window. */
  standalone: boolean;
  /** iPhone / iPad — install via Share → Add to Home Screen. */
  ios: boolean;
  prompt: typeof promptInstall;
}

/** React view of the stash above. */
export function useInstallPrompt(): InstallPromptState {
  useSyncExternalStore(subscribeInstallPrompt, () => version, () => version);
  return {
    canPrompt: deferred !== null,
    installed,
    standalone: isStandaloneDisplay(),
    ios: isIosDevice(),
    prompt: promptInstall,
  };
}
