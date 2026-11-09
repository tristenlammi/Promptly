/**
 * Keep a voice call going when you open Passwords.
 *
 * Passwords is its own page (passwords.html, with its own CSP), so going
 * there from the main app is a full page load, and that ends a LiveKit call
 * (``disconnectOnPageLeave``). While you're in voice, a way into Passwords
 * from this app opens it in a new tab instead, and the call stays up here.
 * Out of voice nothing changes. Links from the vault back into Promptly are
 * ordinary links (passwords/ui/PromptlyNav.tsx).
 */
import { useEffect } from "react";

import { useVoiceStore, type VoiceStatus } from "./store";

/** A call is up, or on its way up: leaving the page would drop it. */
export function voiceIsLive(status: VoiceStatus = useVoiceStore.getState().status): boolean {
  return status === "joining" || status === "connected" || status === "reconnecting";
}

/** Same-origin pages that are their own document, not a route of this app. */
export function isOwnDocument(url: URL, origin: string): boolean {
  return url.origin === origin && (url.pathname === "/passwords" || url.pathname.startsWith("/passwords/"));
}

type ClickLike = Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;
type AnchorLike = { href: string; target: string; hasAttribute(name: string): boolean };

/** The address a plain click on ``anchor`` would load in this tab, if that
 *  would leave for a page of its own while in voice; otherwise null (the
 *  browser or the router does what it always does). */
export function passwordsTabFor(e: ClickLike, anchor: AnchorLike | null, status: VoiceStatus, origin: string): string | null {
  if (!anchor || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, origin);
  } catch {
    return null;
  }
  if (!isOwnDocument(url, origin) || !voiceIsLive(status)) return null;
  return url.href;
}

/** Opens ``href`` in a new tab. False if the browser blocked it. */
export function openInNewTab(href: string): boolean {
  const w = window.open(href, "_blank");
  if (!w) return false;
  try {
    w.opener = null;
  } catch {
    /* already cut off */
  }
  return true;
}

/** Mounted once at the app's root: a click on any Passwords link (the
 *  sidebar row, the phone menu, a card) while in voice opens a new tab.
 *  Runs in the capture phase, before the router's own link handling, which
 *  stands down for a click that's already handled. */
export function useKeepVoiceForPasswords(onOpened?: () => void): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = passwordsTabFor(e, anchor, useVoiceStore.getState().status, window.location.origin);
      // Blocked: the usual page load, as out of voice.
      if (!href || !openInNewTab(href)) return;
      e.preventDefault();
      onOpened?.();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [onOpened]);
}
