// What differs between the web page, the extension's full page and the desktop app.
// The screens only talk to this, so the same UI runs everywhere.
import type { ReactNode } from "react";

import { VaultApi } from "../core/api";
import type { memoryPin } from "../core/connections";
import { IdbStore, type LocalStore } from "../core/store";

export type Platform = {
  kind: "web" | "chromium" | "firefox" | "windows";
  baseUrl: string;
  api: VaultApi;
  store: LocalStore;
  /** Set where a real Promptly login exists to send people to. */
  signIn?: () => void;
  copy: (text: string, sensitive: boolean) => Promise<void>;
  clearClipboard?: () => Promise<void>;
  /** Native extras, where the platform has them. */
  hello?: { available: () => Promise<boolean>; enable: (secret: Uint8Array) => Promise<void>; unlock: () => Promise<Uint8Array | null>; disable: () => Promise<void> };
  backup?: { save: (data: string, name: string) => Promise<string> };
  /** The extension: another of its parts may already be unlocked. */
  restore?: () => Promise<{ secret: Uint8Array; session: string | null } | null>;
  /** The extension: unlock happens in the background, and pages restore from it. */
  unlock?: (password: string) => Promise<unknown>;
  lock?: () => Promise<unknown>;
  /** The extension: pages and the background share one offline copy, so each tells
   *  the other when it changed. */
  notifyChanged?: () => void;
  subscribeChanged?: (cb: () => void) => () => void;
  /** Desktop: its background client has to open as well when the PIN unlocks. */
  adoptSecret?: (secret: Uint8Array) => Promise<void>;
  /** A short PIN for this run of the app. Off unless set. */
  pin?: ReturnType<typeof memoryPin>;
  /** Settings only this platform has. */
  /** Settings only this platform has, shown in the group they belong to. */
  pinControls?: ReactNode;
  fillControls?: ReactNode;
  clipboardControls?: ReactNode;
  /** Turning bookmark sync on and off: only a browser extension can reach a browser's bookmarks. */
  bookmarkControls?: ReactNode;
  /** This platform decides when it locks, and shows its own setting. Otherwise the app's idle
   *  and sleep timers run, from the Settings screen's values. */
  lockControls?: ReactNode;
};

type Token = { value: string; exp: number };

function expiry(jwt: string): number {
  try {
    return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000;
  } catch {
    return 0;
  }
}

/** A bearer token from the refresh cookie, like the main app, kept in memory only. */
export function webAuth() {
  let token: Token | null = null;
  let inflight: Promise<string | null> | null = null;
  return async (): Promise<string | null> => {
    if (token && token.exp - Date.now() > 30_000) return token.value;
    inflight ??= (async () => {
      try {
        const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", cache: "no-store" });
        if (!r.ok) return null;
        const body = (await r.json()) as { access_token: string };
        token = { value: body.access_token, exp: expiry(body.access_token) };
        return token.value;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

export function webPlatform(): Platform {
  return {
    kind: "web",
    baseUrl: location.origin,
    api: new VaultApi(location.origin, webAuth()),
    store: new IdbStore(),
    signIn: () => {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    },
    copy: (text) => navigator.clipboard.writeText(text),
    clearClipboard: () => navigator.clipboard.writeText(""),
  };
}
