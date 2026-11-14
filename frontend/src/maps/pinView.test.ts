import { describe, expect, it } from "vitest";

import { pinTarget } from "./pinView";

const phone = { w: 390, h: 800 };
const half = { top: 80, bottom: 400, left: 0, right: 0 };
const tall = { top: 80, bottom: 560, left: 0, right: 0 };

describe("pinTarget", () => {
  it("leaves the map alone once you've moved it yourself", () => {
    expect(pinTarget({ x: 195, y: 700 }, phone, half, "off")).toBeNull();
  });

  it("puts a centred pin back in the middle of the clear map when the panel grows", () => {
    // Centred above a half-height panel, then the panel grows.
    const before = { x: 195, y: 240 };
    expect(pinTarget(before, phone, half, "centre")).toBeNull();
    expect(pinTarget(before, phone, tall, "centre")).toEqual({ x: 195, y: 160 });
  });

  it("follows the panel back down when it shrinks", () => {
    expect(pinTarget({ x: 195, y: 160 }, phone, half, "centre")).toEqual({ x: 195, y: 240 });
  });

  it("doesn't twitch for a few pixels", () => {
    expect(pinTarget({ x: 199, y: 246 }, phone, half, "centre")).toBeNull();
  });

  it("leaves a dropped pin where it is while it's in sight", () => {
    expect(pinTarget({ x: 80, y: 300 }, phone, half, "visible")).toBeNull();
  });

  it("brings a dropped pin out from under the panel", () => {
    expect(pinTarget({ x: 80, y: 300 }, phone, tall, "visible")).toEqual({ x: 195, y: 160 });
  });

  it("counts a pin whose head is under the search bar as hidden", () => {
    expect(pinTarget({ x: 195, y: 100 }, phone, half, "visible")).toEqual({ x: 195, y: 240 });
  });

  it("gives up when almost no map is left", () => {
    expect(pinTarget({ x: 195, y: 700 }, phone, { top: 80, bottom: 640, left: 0, right: 0 }, "centre")).toBeNull();
  });

  it("works beside a side panel on a big screen", () => {
    const desk = { w: 1400, h: 900 };
    const side = { top: 0, bottom: 0, left: 400, right: 0 };
    expect(pinTarget({ x: 100, y: 450 }, desk, side, "visible")).toEqual({ x: 900, y: 450 });
  });
});
