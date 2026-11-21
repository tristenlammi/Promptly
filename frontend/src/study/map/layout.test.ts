import { describe, expect, it } from "vitest";

import type { Concept, Unit } from "@/api/study";

import { bandOf, layoutMap, placeRow, ROW_H, routePath, UNIT_HEAD_H, unitLinks, unitRows, type RowItem } from "./layout";

function c(id: string, position: number, prereqs: string[] = [], extra: Partial<Concept> = {}): Concept {
  return {
    id, unit_id: "u", position, title: id, summary: "", objectives: [], nature: "principle", prereqs, mastery: 0, state: "new", locked: false,
    origin: "planned", reason: "", gap_for: null, steps_done: 0, sources: [], last_seen_at: null, mastered_at: null, due_at: null, due: false, reviews: 0, lapses: 0, ...extra,
  };
}
const unit = (id: string, position: number, concepts: Concept[]): Unit => ({ id, position, title: id, summary: "", capstone: null, concepts });
const links = (m: ReturnType<typeof layoutMap>) => m.edges.map((e) => `${e.from}>${e.to}`);

describe("unitRows", () => {
  it("puts a concept below what it depends on, and independent ones side by side", () => {
    const rows = unitRows([c("a", 1), c("b", 2, ["a"]), c("c", 3, ["a"]), c("d", 4, ["b", "c"])], 3);
    expect(rows).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("ignores prerequisites that live in another unit", () => {
    expect(unitRows([c("x", 5, ["elsewhere"]), c("y", 6, ["x"])], 3)).toEqual([["x"], ["y"]]);
  });

  it("wraps a row that is wider than the screen allows", () => {
    const rows = unitRows([c("a", 1), c("b", 2), c("c", 3)], 2);
    expect(rows).toEqual([["a", "b"], ["c"]]);
  });

  it("orders by position, so a gap concept (a float between two) lands in place", () => {
    const rows = unitRows([c("b", 2, ["g"]), c("a", 1), c("g", 1.5, ["a"], { origin: "gap", gap_for: "b" })], 3);
    expect(rows).toEqual([["a"], ["g"], ["b"]]);
  });

  it("does not hang on a loop", () => {
    expect(unitRows([c("a", 1, ["b"]), c("b", 2, ["a"])], 3).flat().sort()).toEqual(["a", "b"]);
  });
});

describe("unitLinks", () => {
  const rowOf = (rows: string[][]) => new Map(rows.flatMap((ids, r) => ids.map((id) => [id, r] as [string, number])));

  it("leaves out a line another route already implies", () => {
    const cs = [c("a", 1), c("b", 2, ["a"]), c("d", 3, ["a", "b"])];
    expect(unitLinks(cs, rowOf(unitRows(cs, 3)))).toEqual([["a", "b"], ["b", "d"]]);
  });

  it("keeps a line that skips a row when nothing else says it", () => {
    const cs = [c("a", 1), c("b", 2, ["a"]), c("x", 3), c("d", 4, ["b", "x"])];
    expect(unitLinks(cs, rowOf(unitRows(cs, 3)))).toEqual([["a", "b"], ["b", "d"], ["x", "d"]]);
  });

  it("does not hang on a loop, and never draws a line up the page", () => {
    const cs = [c("a", 1, ["b"]), c("b", 2, ["a"])];
    const out = unitLinks(cs, rowOf(unitRows(cs, 3)));
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe("placeRow", () => {
  const item = (id: string, want: number, pass = false): RowItem => ({ id, pass, order: 0, from: [], want, x: 0 });

  it("two that want the same place sit either side of it", () => {
    const row = [item("a", 0.5), item("b", 0.5)];
    placeRow(row, 1 / 3);
    expect(row[0].x).toBeCloseTo(1 / 3, 3);
    expect(row[1].x).toBeCloseTo(2 / 3, 3);
  });

  it("leaves one alone where it wants to be, and keeps stops off the edges", () => {
    const row = [item("a", 0.25)];
    placeRow(row, 1 / 3);
    expect(row[0].x).toBe(0.25);
    const edge = [item("a", 0.02), item("b", 0.99)];
    placeRow(edge, 1 / 3);
    expect(edge[0].x).toBeCloseTo(1 / 6, 3);
    expect(edge[1].x).toBeCloseTo(5 / 6, 3);
  });

  it("a passing line needs only half the room of a stop", () => {
    const row = [item("a", 0.2), item("p", 0.2, true), item("b", 0.5)];
    placeRow(row, 1 / 3);
    expect(row[1].x - row[0].x).toBeGreaterThanOrEqual(1 / 6 - 0.001);
    expect(row[2].x - row[1].x).toBeGreaterThanOrEqual(1 / 6 - 0.001);
  });
});

describe("layoutMap", () => {
  const units = [unit("u1", 1, [c("a", 1), c("b", 2, ["a"])]), unit("u2", 2, [c("d", 3, ["b"]), c("e", 4, ["b"])])];
  const m = layoutMap(units, 3);

  it("stacks the units and gives every concept a place inside its unit", () => {
    expect(m.nodes.map((n) => n.id)).toEqual(["a", "b", "d", "e"]);
    expect(m.units[0].top).toBe(0);
    expect(m.units[1].top).toBeGreaterThan(m.units[0].top + m.units[0].height);
    for (const n of m.nodes) {
      const u = m.units.find((x) => x.id === n.unitId);
      if (!u) throw new Error("a concept outside every unit");
      expect(n.y).toBeGreaterThan(u.top + UNIT_HEAD_H);
      expect(n.y).toBeLessThan(u.top + u.height);
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(1);
    }
    expect(m.byId.b.y - m.byId.a.y).toBe(ROW_H);
    expect(m.byId.d.y).toBe(m.byId.e.y);
    expect(m.height).toBe(m.units[1].top + m.units[1].height);
  });

  it("draws lines inside a unit only", () => {
    expect(links(m)).toEqual(["a>b"]);
  });

  it("a concept sits straight under the one it builds on", () => {
    expect(m.byId.b.x).toBe(m.byId.a.x);
    const fan = layoutMap([unit("u", 1, [c("a", 1), c("b", 2, ["a"]), c("c", 3, ["a"]), c("d", 4, ["a"]), c("e", 5, ["c"])])]);
    expect(fan.byId.a.x).toBe(0.5);
    expect(fan.byId.c.x).toBe(0.5);
    expect(fan.byId.e.x).toBe(0.5);
    expect(fan.byId.b.x).toBeLessThan(fan.byId.c.x);
    expect(fan.byId.d.x).toBeGreaterThan(fan.byId.c.x);
  });

  it("a concept that builds on two sits under the middle of them", () => {
    const join = layoutMap([unit("u", 1, [c("a", 1), c("b", 2), c("d", 3, ["a", "b"])])]);
    expect(join.byId.d.x).toBeCloseTo((join.byId.a.x + join.byId.b.x) / 2, 3);
  });

  it("stops in a row never sit closer than a column apart", () => {
    const busy = layoutMap([
      unit("u", 1, [c("a", 1), c("b", 2, ["a"]), c("c", 3, ["a"]), c("d", 4, ["a"]), c("e", 5, ["b"]), c("f", 6, ["b"]), c("g", 7, ["d"])]),
    ]);
    const rows = new Map<number, number[]>();
    for (const n of busy.nodes) rows.set(n.row, [...(rows.get(n.row) ?? []), n.x]);
    for (const xs of rows.values()) {
      xs.sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i += 1) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(1 / 3 - 0.001);
    }
  });

  it("a line that passes a row gets its own gap there, clear of the stops", () => {
    // d builds on b (the row above) and on x (two rows up, with nothing between).
    const skip = layoutMap([unit("u", 1, [c("a", 1), c("x", 2), c("b", 3, ["a"]), c("d", 4, ["b", "x"])])]);
    const long = skip.edges.find((e) => e.from === "x" && e.to === "d");
    if (!long) throw new Error("no line from x to d");
    expect(long.points.map((p) => p.pass)).toEqual([false, true, false]);
    const pass = long.points[1];
    expect(pass.y).toBe(skip.byId.b.y);
    expect(Math.abs(pass.x - skip.byId.b.x)).toBeGreaterThanOrEqual(1 / 6 - 0.001);
  });

  it("marks lines to a gap concept, and lines between finished concepts", () => {
    const g = layoutMap([
      unit("u", 1, [c("a", 1, [], { state: "mastered" }), c("g", 1.5, ["a"], { origin: "gap", gap_for: "b" }), c("b", 2, ["g"], { state: "known" }), c("k", 3, ["a"], { state: "known" })]),
    ]);
    const by = Object.fromEntries(g.edges.map((e) => [`${e.from}>${e.to}`, e]));
    expect(by["a>g"].gap).toBe(true);
    expect(by["g>b"].gap).toBe(true);
    expect(by["a>k"]).toMatchObject({ gap: false, done: true });
    expect(g.byId.g.y).toBeGreaterThan(g.byId.a.y);
    expect(g.byId.b.y).toBeGreaterThan(g.byId.g.y);
  });

  it("drops lines to concepts that are not on the map", () => {
    expect(layoutMap([unit("u", 1, [c("a", 1, ["ghost"])])]).edges).toEqual([]);
  });

  it("an empty subject has no height", () => {
    expect(layoutMap([]).height).toBe(0);
  });
});

describe("drawing", () => {
  it("a line to the stop straight below is one straight stroke", () => {
    expect(routePath([{ x: 0.5, y: 100, pass: false }, { x: 0.5, y: 248, pass: false }])).toBe("M 50 120 V 210");
  });

  it("a line to another column turns once, level, in the band above the row it is going to", () => {
    const d = routePath([{ x: 0.5, y: 100, pass: false }, { x: 0.2, y: 248, pass: false }]);
    expect(d).toBe("M 50 120 V 183 Q 50 192 48.4 192 H 21.6 Q 20 192 20 201 V 210");
  });

  it("a line with nowhere to go draws nothing", () => {
    expect(routePath([{ x: 0.5, y: 100, pass: false }])).toBe("");
  });

  it("bandOf: how a concept is shown", () => {
    expect(bandOf({ state: "known", mastery: 0.9, locked: false })).toBe("known");
    expect(bandOf({ state: "mastered", mastery: 0.8, locked: true })).toBe("mastered");
    expect(bandOf({ state: "new", mastery: 0, locked: true })).toBe("locked");
    expect(bandOf({ state: "new", mastery: 0, locked: false })).toBe("new");
    expect(bandOf({ state: "new", mastery: 0.6, locked: false })).toBe("nearly");
    expect(bandOf({ state: "learning", mastery: 0.3, locked: false })).toBe("learning");
    expect(bandOf({ state: "learning", mastery: 0.65, locked: false })).toBe("nearly");
  });
});
