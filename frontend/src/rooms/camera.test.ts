import { describe, expect, it } from "vitest";

import {
  HOLD_MS,
  MAX_FILE_BYTES,
  MAX_VIDEO_S,
  audioBits,
  cameraProblem,
  captureName,
  extensionFor,
  pickVideoType,
  plainType,
  pressOutcome,
  recordingClock,
  ringFraction,
  videoBits,
} from "./camera";

describe("the shutter", () => {
  it("a tap is a photo, a hold is a video", () => {
    expect(pressOutcome(1000, 1000 + HOLD_MS - 1)).toBe("photo");
    expect(pressOutcome(1000, 1000 + HOLD_MS)).toBe("video");
    expect(pressOutcome(1000, 9000)).toBe("video");
    expect(pressOutcome(1000, 1000)).toBe("photo");
  });

  it("the ring fills over the longest video and stops there", () => {
    expect(ringFraction(0)).toBe(0);
    expect(ringFraction(-5)).toBe(0);
    expect(ringFraction((MAX_VIDEO_S * 1000) / 2)).toBeCloseTo(0.5);
    expect(ringFraction(MAX_VIDEO_S * 1000 * 3)).toBe(1);
    expect(recordingClock(0)).toBe("0:00");
    expect(recordingClock(7_900)).toBe("0:07");
    expect(recordingClock(60_000)).toBe("1:00");
  });
});

describe("a video fits in a message", () => {
  it("a full-length video stays under the file limit, sound included", () => {
    const bytes = ((videoBits() + audioBits) * MAX_VIDEO_S) / 8;
    expect(bytes).toBeLessThan(MAX_FILE_BYTES);
    // Good quality where there's room for it...
    expect(videoBits()).toBe(2_500_000);
    // ...and less where there isn't: a 5 MB limit still takes a minute.
    const small = 5 * 1024 * 1024;
    expect(((videoBits(small) + audioBits) * MAX_VIDEO_S) / 8).toBeLessThan(small);
    // Never so little that it's a smear.
    expect(videoBits(100_000)).toBe(250_000);
  });

  it("records MP4 where the browser can, WebM otherwise", () => {
    expect(pickVideoType(() => true)).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(pickVideoType((t) => t.startsWith("video/webm"))).toBe("video/webm;codecs=vp9,opus");
    expect(pickVideoType((t) => t === "video/mp4")).toBe("video/mp4");
    expect(pickVideoType(() => false)).toBeNull();
    expect(
      pickVideoType((t) => {
        if (t.includes("mp4")) throw new Error("unknown type");
        return t === "video/webm";
      }),
    ).toBe("video/webm");
  });
});

describe("what it makes is called", () => {
  it("a name that says what and when", () => {
    const when = new Date(2026, 10, 15, 18, 4, 9);
    expect(captureName("photo", when, "image/jpeg")).toBe("Photo 2026-11-15 18.04.09.jpg");
    expect(captureName("video", when, "video/mp4;codecs=avc1.42E01E,mp4a.40.2")).toBe("Video 2026-11-15 18.04.09.mp4");
    expect(captureName("video", when, "video/webm;codecs=vp9,opus")).toBe("Video 2026-11-15 18.04.09.webm");
    expect(plainType("video/webm;codecs=vp9,opus")).toBe("video/webm");
    expect(extensionFor("video/x-something")).toBe("mp4");
    expect(extensionFor("")).toBe("jpg");
  });
});

describe("when the camera won't open", () => {
  it("says why in plain words", () => {
    expect(cameraProblem({ name: "NotAllowedError" })).toMatch(/isn't allowed to use the camera/);
    expect(cameraProblem({ name: "NotFoundError" })).toBe("No camera was found on this device.");
    expect(cameraProblem({ name: "NotReadableError" })).toMatch(/busy in another app/);
    expect(cameraProblem(new Error("?"))).toBe("The camera couldn't be opened.");
    expect(cameraProblem(null, false)).toMatch(/secure/);
  });
});
