import { describe, expect, it } from "vitest";

import {
  HOLD_MS,
  MAX_FILE_BYTES,
  MAX_VIDEO_S,
  VIDEO_BITS_BEST,
  audioBits,
  autoSettings,
  bitsForPicture,
  cameraConstraints,
  cameraProblem,
  focusSettings,
  pictureSpot,
  pinchZoom,
  zoomLabel,
  zoomRange,
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
    // With no word from the server (50 MB a file), a minute still fits, at well over twice the old 2.5 Mbit/s.
    expect(videoBits()).toBeGreaterThan(6_000_000);
    expect(videoBits()).toBeLessThan(VIDEO_BITS_BEST);
    // Where the server takes big files (1 GB), the picture gets all it wants and no more.
    const big = 1024 ** 3;
    expect(videoBits(big)).toBe(VIDEO_BITS_BEST);
    expect(((videoBits(big) + audioBits) * MAX_VIDEO_S) / 8).toBeLessThan(big);
    // A smaller picture asks for less, and gets no more than it asks.
    expect(videoBits(big, MAX_VIDEO_S, bitsForPicture(1280, 720))).toBe(bitsForPicture(1280, 720));
    // ...and less where there isn't: a 5 MB limit still takes a minute.
    const small = 5 * 1024 * 1024;
    expect(((videoBits(small) + audioBits) * MAX_VIDEO_S) / 8).toBeLessThan(small);
    // Never so little that it's a smear.
    expect(videoBits(100_000)).toBe(250_000);
  });

  it("asks for what the picture's size wants", () => {
    // Full HD at 30: about 10 Mbit/s, what a phone's own camera uses.
    expect(bitsForPicture(1920, 1080, 30)).toBeGreaterThan(9_000_000);
    expect(bitsForPicture(1920, 1080, 30)).toBeLessThanOrEqual(VIDEO_BITS_BEST);
    // Held upright the sides swap: the same picture, the same answer.
    expect(bitsForPicture(1080, 1920, 30)).toBe(bitsForPicture(1920, 1080, 30));
    // 720p wants about half; 60 frames a second isn't given double.
    expect(bitsForPicture(1280, 720, 30)).toBeLessThan(5_000_000);
    expect(bitsForPicture(1280, 720, 60)).toBe(bitsForPicture(1280, 720, 30));
    // 4K is held to the best, a tiny picture isn't starved, and no size means the best.
    expect(bitsForPicture(3840, 2160)).toBe(VIDEO_BITS_BEST);
    expect(bitsForPicture(320, 240)).toBe(1_000_000);
    expect(bitsForPicture(0, 0)).toBe(VIDEO_BITS_BEST);
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

describe("what the camera is asked for", () => {
  it("full HD at 30 frames a second, from the camera you chose", () => {
    expect(cameraConstraints("environment")).toEqual({ facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
    expect(cameraConstraints("user").facingMode).toEqual({ ideal: "user" });
  });

  it("keeps itself in focus and well lit, only where the camera can", () => {
    expect(autoSettings({ focusMode: ["manual", "single-shot", "continuous"], exposureMode: ["continuous", "manual"], whiteBalanceMode: ["continuous"] })).toEqual({
      focusMode: "continuous",
      exposureMode: "continuous",
      whiteBalanceMode: "continuous",
    });
    expect(autoSettings({ focusMode: ["continuous"] })).toEqual({ focusMode: "continuous" });
    // A fixed-focus front camera, or a browser that says nothing: nothing is asked.
    expect(autoSettings({ focusMode: ["manual"] })).toBeNull();
    expect(autoSettings({})).toBeNull();
  });

  it("a tap focuses there, and does nothing on a camera that can't", () => {
    const at = { x: 0.25, y: 0.75 };
    expect(focusSettings({ focusMode: ["continuous", "single-shot"], exposureMode: ["continuous", "single-shot"] }, at)).toEqual({
      pointsOfInterest: [at],
      focusMode: "single-shot",
      exposureMode: "single-shot",
    });
    expect(focusSettings({ focusMode: ["continuous"], exposureMode: ["continuous"] }, at)).toEqual({ pointsOfInterest: [at], focusMode: "continuous", exposureMode: "continuous" });
    expect(focusSettings({ focusMode: ["single-shot"] }, at)).toEqual({ pointsOfInterest: [at], focusMode: "single-shot" });
    expect(focusSettings({ focusMode: ["manual"] }, at)).toBeNull();
    expect(focusSettings({}, at)).toBeNull();
  });
});

describe("where a tap is in the picture", () => {
  const box = { left: 0, top: 100, width: 400, height: 800 };

  it("the middle is the middle, whatever is cropped", () => {
    expect(pictureSpot({ x: 200, y: 500 }, box, { width: 1080, height: 1920 })).toEqual({ x: 0.5, y: 0.5 });
    expect(pictureSpot({ x: 200, y: 500 }, box, { width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("counts the part of the picture cropped off the sides", () => {
    // A wide picture in a tall box: it's scaled to the box's height, and its sides are cut.
    // Shown 1422 wide in a 400 box, so the box's left edge is 36% of the way across.
    const left = pictureSpot({ x: 0, y: 100 }, box, { width: 1920, height: 1080 });
    expect(left?.x).toBeCloseTo(0.359, 2);
    expect(left?.y).toBeCloseTo(0, 5);
    const right = pictureSpot({ x: 400, y: 900 }, box, { width: 1920, height: 1080 });
    expect(right?.x).toBeCloseTo(0.641, 2);
    expect(right?.y).toBeCloseTo(1, 5);
  });

  it("a front camera is shown mirrored, so left is right", () => {
    const plain = pictureSpot({ x: 100, y: 500 }, box, { width: 1080, height: 1920 });
    const mirrored = pictureSpot({ x: 100, y: 500 }, box, { width: 1080, height: 1920 }, true);
    expect(mirrored?.x).toBeCloseTo(1 - (plain?.x ?? 0), 5);
    expect(mirrored?.y).toBeCloseTo(plain?.y ?? 0, 5);
  });

  it("nothing for a tap outside, or a picture with no size yet", () => {
    expect(pictureSpot({ x: 200, y: 50 }, box, { width: 1080, height: 1920 })).toBeNull();
    expect(pictureSpot({ x: 200, y: 500 }, box, { width: 0, height: 0 })).toBeNull();
    expect(pictureSpot({ x: 200, y: 500 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 1080, height: 1920 })).toBeNull();
  });
});

describe("zoom", () => {
  const range = { min: 1, max: 8, step: 0.1 };

  it("only a camera that zooms has a range", () => {
    expect(zoomRange({ zoom: { min: 1, max: 8, step: 0.1 } })).toEqual(range);
    expect(zoomRange({ zoom: { min: 1, max: 5 } })).toEqual({ min: 1, max: 5, step: 0.1 });
    expect(zoomRange({ zoom: { min: 1, max: 1 } })).toBeNull();
    expect(zoomRange({})).toBeNull();
  });

  it("spreading two fingers zooms in, by how far they spread", () => {
    expect(pinchZoom(1, 100, 200, range)).toBe(2);
    expect(pinchZoom(2, 200, 100, range)).toBe(1);
    expect(pinchZoom(2, 100, 125, range)).toBe(2.5);
  });

  it("stays inside what the camera does, on its steps", () => {
    expect(pinchZoom(4, 100, 1000, range)).toBe(8);
    expect(pinchZoom(1, 100, 10, range)).toBe(1);
    expect(pinchZoom(1, 100, 133, { min: 1, max: 4, step: 0.5 })).toBe(1.5);
    // Fingers that haven't moved apart yet change nothing.
    expect(pinchZoom(3, 0, 50, range)).toBe(3);
  });

  it("reads as a phone's camera writes it", () => {
    expect(zoomLabel(1)).toBe("1x");
    expect(zoomLabel(2.04)).toBe("2x");
    expect(zoomLabel(2.5)).toBe("2.5x");
    expect(zoomLabel(7.96)).toBe("8x");
  });
});
