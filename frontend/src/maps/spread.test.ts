import { describe, expect, it } from "vitest";

import { spreadOffsets } from "./MapView";

describe("markers that land on top of each other", () => {
  it("leaves markers that are apart where they are", () => {
    expect(spreadOffsets([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 200 }])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("puts two on the same spot side by side, centred on it", () => {
    const [a, b] = spreadOffsets([{ x: 100, y: 50 }, { x: 100, y: 50 }], 30);
    expect(a).toEqual([-15, 0]);
    expect(b).toEqual([15, 0]);
  });

  it("fans three near neighbours out in a row a gap apart", () => {
    const pts = [{ x: 100, y: 100 }, { x: 104, y: 98 }, { x: 96, y: 102 }];
    const out = spreadOffsets(pts, 30);
    const xs = pts.map((p, i) => p.x + out[i][0]);
    const ys = pts.map((p, i) => p.y + out[i][1]);
    expect(xs[1] - xs[0]).toBeCloseTo(30);
    expect(xs[2] - xs[1]).toBeCloseTo(30);
    expect(new Set(ys.map((y) => Math.round(y))).size).toBe(1);
  });

  it("only moves the ones in a crowd", () => {
    const out = spreadOffsets([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 400, y: 400 }], 30);
    expect(out[2]).toEqual([0, 0]);
    expect(out[0][0]).toBeLessThan(0);
  });
});
