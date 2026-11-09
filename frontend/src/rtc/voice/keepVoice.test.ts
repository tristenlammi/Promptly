// In a voice call, a Passwords link opens a new tab (a full page load would
// end the call); out of a call, and for every other link, nothing changes.
import { describe, expect, it } from "vitest";

import { isOwnDocument, passwordsTabFor, voiceIsLive } from "./keepVoice";

const ORIGIN = "https://promptly.example";
const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const link = (href: string, attrs: { target?: string; download?: boolean } = {}) => ({
  href: new URL(href, ORIGIN).href,
  target: attrs.target ?? "",
  hasAttribute: (name: string) => name === "download" && !!attrs.download,
});

describe("keeping a call up when Passwords opens", () => {
  it("counts joining, connected and reconnecting as in a call", () => {
    for (const s of ["joining", "connected", "reconnecting"] as const) expect(voiceIsLive(s)).toBe(true);
    for (const s of ["idle", "lost"] as const) expect(voiceIsLive(s)).toBe(false);
  });

  it("knows Passwords is a page of its own, and nothing else here is", () => {
    for (const p of ["/passwords", "/passwords/", "/passwords#/security", "/passwords/send/abc"]) expect(isOwnDocument(new URL(p, ORIGIN), ORIGIN)).toBe(true);
    for (const p of ["/files", "/passwordsx", "/apps/passwords", "/chat?q=/passwords"]) expect(isOwnDocument(new URL(p, ORIGIN), ORIGIN)).toBe(false);
    expect(isOwnDocument(new URL("https://elsewhere.example/passwords"), ORIGIN)).toBe(false);
  });

  it("opens a Passwords link in a new tab while in a call", () => {
    expect(passwordsTabFor(click, link("/passwords"), "connected", ORIGIN)).toBe(`${ORIGIN}/passwords`);
    expect(passwordsTabFor(click, link("/passwords#/security"), "reconnecting", ORIGIN)).toBe(`${ORIGIN}/passwords#/security`);
    expect(passwordsTabFor(click, link("/passwords/"), "joining", ORIGIN)).toBe(`${ORIGIN}/passwords/`);
  });

  it("changes nothing out of a call", () => {
    expect(passwordsTabFor(click, link("/passwords"), "idle", ORIGIN)).toBeNull();
    expect(passwordsTabFor(click, link("/passwords"), "lost", ORIGIN)).toBeNull();
  });

  it("leaves other links, and clicks the browser already handles, alone", () => {
    expect(passwordsTabFor(click, link("/files"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor(click, null, "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor({ ...click, ctrlKey: true }, link("/passwords"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor({ ...click, metaKey: true }, link("/passwords"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor({ ...click, shiftKey: true }, link("/passwords"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor({ ...click, button: 1 }, link("/passwords"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor({ ...click, defaultPrevented: true }, link("/passwords"), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor(click, link("/passwords", { target: "_blank" }), "connected", ORIGIN)).toBeNull();
    expect(passwordsTabFor(click, link("/passwords", { download: true }), "connected", ORIGIN)).toBeNull();
  });
});
