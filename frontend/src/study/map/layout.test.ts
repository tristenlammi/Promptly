import { describe, expect, it } from "vitest";

import type { Concept, Unit } from "@/api/study";

import { bandOf, edgePath, layoutMap, ROW_H, rowX, UNIT_HEAD_H, unitRows } from "./layout";

function c(id: string, position: number, prereqs: string[] = [], extra: Partial<Concept> = {}): Concept {
  return {
    id, unit_id: "u", position, title: id, summary: "", objectives: [], nature: "principle", prereqs, mastery: 0, state: "new", locked: false,
    origin: "planned", reason: "", gap_for: null, steps_done: 0, sources: [], last_seen_at: null, mastered_at: null, ...extra,
  };
}
const unit = (id: string, position: number, concepts: Concept[]): Unit => ({ id, position, title: id, summary: "", concepts });

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

  it("draws a line for every prerequisite, across units too", () => {
    expect(m.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b", "b>d", "b>e"]);
  });

  it("marks lines to a gap concept, and lines between finished concepts", () => {
    const g = layoutMap([
      unit("u", 1, [c("a", 1, [], { state: "mastered" }), c("g", 1.5, ["a"], { origin: "gap", gap_for: "b" }), c("b", 2, ["a", "g"], { state: "known" })]),
    ]);
    const by = Object.fromEntries(g.edges.map((e) => [`${e.from}>${e.to}`, e]));
    expect(by["a>g"].gap).toBe(true);
    expect(by["g>b"].gap).toBe(true);
    expect(by["a>b"]).toMatchObject({ gap: false, done: true });
    // The gap concept sits between the two.
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
  it("a lone concept leans from side to side so the route winds", () => {
    expect(new Set([0, 1, 2, 3].map((i) => rowX(0, 1, i))).size).toBeGreaterThan(1);
    expect(rowX(0, 2, 0)).toBeLessThan(rowX(1, 2, 0));
    expect(rowX(2, 3, 0)).toBeLessThanOrEqual(0.85);
  });

  it("edgePath is a curve down, or a straight line across", () => {
    expect(edgePath({ id: "a", unitId: "u", x: 0.5, y: 10, row: 0 }, { id: "b", unitId: "u", x: 0.2, y: 110, row: 1 })).toBe("M 50 10 C 50 60, 20 60, 20 110");
    expect(edgePath({ id: "a", unitId: "u", x: 0.2, y: 10, row: 0 }, { id: "b", unitId: "u", x: 0.8, y: 10, row: 0 })).toBe("M 20 10 L 80 10");
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
