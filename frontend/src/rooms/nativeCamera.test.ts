import { describe, expect, it } from "vitest";

import { cameraHandoffUrl, capFromSearch, sentFromCamera } from "./nativeCamera";

describe("the app's camera for Rooms", () => {
  it("is only there when the app that opened the page says so", () => {
    expect(capFromSearch("?source=android&caps=voice,calls,callout,sound,camera")).toBe(true);
    // An older app: it opened the page, and has no camera of its own.
    expect(capFromSearch("?source=android&caps=voice,calls,callout,sound")).toBe(false);
    // "cameras" or "camera2" isn't it.
    expect(capFromSearch("?caps=cameras,xcamera")).toBe(false);
    // Says nothing either way (a link, a reload): what was known before stands.
    expect(capFromSearch("")).toBeNull();
    expect(capFromSearch("?q=camera")).toBeNull();
  });

  it("hands over to the app only, and comes back here if the app can't take it", () => {
    const url = cameraHandoffUrl(
      { ticket: "a.b.c", room: "0b3d7f7e-6a53-4c0e-9d0e-5a1f0f3b2c11", title: "Mum & Dad's place, the long name that goes on and on and on and on and on and on, past eighty", maxBytes: 52428800 },
      "https://home.example/rooms/r/0b3d7f7e?x=1#old",
      "https://home.example",
    );
    expect(url.startsWith("intent://rooms/camera?")).toBe(true);
    expect(url).toContain("#Intent;scheme=promptly;package=org.promptly.app;");
    const q = new URLSearchParams(url.slice("intent://rooms/camera?".length, url.indexOf("#Intent")));
    expect(q.get("server")).toBe("https://home.example");
    expect(q.get("ticket")).toBe("a.b.c");
    expect(q.get("room")).toBe("0b3d7f7e-6a53-4c0e-9d0e-5a1f0f3b2c11");
    expect(q.get("max")).toBe("52428800");
    expect(q.get("title")).toHaveLength(80);
    const back = decodeURIComponent(/S\.browser_fallback_url=([^;]+);end$/.exec(url)![1]);
    expect(back).toBe("https://home.example/rooms/r/0b3d7f7e?x=1#camera-no-app");
  });

  it("says a fuller video can be sent in pieces only when the server takes them", () => {
    const base = { ticket: "a.b.c", room: "r", title: "Ann", maxBytes: 52428800 };
    const q = (u: string) => new URLSearchParams(u.slice("intent://rooms/camera?".length, u.indexOf("#Intent")));
    const on = q(cameraHandoffUrl({ ...base, bigMaxBytes: 157286400, tusEndpoint: "/api/files/tus/" }, "https://h.example/x", "https://h.example"));
    expect(on.get("big")).toBe("157286400");
    expect(on.get("tus")).toBe("/api/files/tus/");
    const off = q(cameraHandoffUrl({ ...base, bigMaxBytes: 0, tusEndpoint: null }, "https://h.example/x", "https://h.example"));
    expect(off.get("big")).toBeNull();
    expect(off.get("tus")).toBeNull();
  });

  it("knows on coming back whether the camera sent, and whether it was the reply", () => {
    const at = Date.parse("2026-11-19T10:00:00Z");
    const msg = (iso: string, reply: string | null = null) => ({ created_at: iso, reply_to: reply ? { id: reply } : null });
    // Nothing new of yours: you backed out of the camera, and the reply bar stays.
    expect(sentFromCamera([msg("2026-11-19T09:58:00Z", "m1")], { at, replyId: "m1" })).toBe(false);
    expect(sentFromCamera([], { at, replyId: null })).toBe(false);
    // A new one that answers it.
    expect(sentFromCamera([msg("2026-11-19T10:00:20Z", "m1")], { at, replyId: "m1" })).toBe(true);
    // A new one that answers something else, or nothing: not the reply you had open.
    expect(sentFromCamera([msg("2026-11-19T10:00:20Z", "m2"), msg("2026-11-19T10:00:21Z")], { at, replyId: "m1" })).toBe(false);
    // Not replying: any new one of yours.
    expect(sentFromCamera([msg("2026-11-19T10:00:20Z")], { at, replyId: null })).toBe(true);
    // The server's clock a few seconds behind the phone's.
    expect(sentFromCamera([msg("2026-11-19T09:59:52Z")], { at, replyId: null })).toBe(true);
  });
});
