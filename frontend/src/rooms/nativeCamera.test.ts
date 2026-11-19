import { describe, expect, it } from "vitest";

import { cameraHandoffUrl, capFromSearch } from "./nativeCamera";

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
});
