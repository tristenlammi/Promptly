import type { Concept, Unit } from "@/api/study";

/*
 * Where each concept sits on the map. Pure, so it can be tested.
 *
 * Units stack top to bottom. Inside a unit a concept sits one row below the
 * deepest thing it depends on in that unit, so ideas that build on each
 * other run downwards and ideas that don't depend on each other sit side by
 * side. A row that holds one concept leans left or right in turn, which
 * makes the route wind like a path instead of a list.
 */

export const ROW_H = 132;
export const UNIT_HEAD_H = 76;
export const UNIT_GAP = 28;
export const UNIT_PAD_BOTTOM = 12;

export interface MapNode {
  id: string;
  unitId: string;
  /** Centre, as a fraction of the map's width (0..1). */
  x: number;
  /** Centre, px from the top of the map. */
  y: number;
  row: number;
}

export interface MapEdge {
  from: string;
  to: string;
  /** The idea at ``to`` was added for a gap, or ``from`` was. */
  gap: boolean;
  /** Both ends are done. */
  done: boolean;
}

export interface MapUnit {
  id: string;
  top: number;
  height: number;
}

export interface MapLayout {
  nodes: MapNode[];
  byId: Record<string, MapNode>;
  edges: MapEdge[];
  units: MapUnit[];
  height: number;
}

export const isDone = (c: Pick<Concept, "state">) => c.state === "mastered" || c.state === "known";

/** Rows of concept ids for one unit: each concept below what it needs. */
export function unitRows(concepts: Concept[], maxCols: number): string[][] {
  const sorted = [...concepts].sort((a, b) => a.position - b.position);
  const inUnit = new Set(sorted.map((c) => c.id));
  const depth = new Map<string, number>();
  const byId = new Map(sorted.map((c) => [c.id, c]));
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a loop should never arrive; don't hang on one
    visiting.add(id);
    let d = 0;
    for (const p of byId.get(id)?.prereqs ?? []) if (inUnit.has(p) && p !== id) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const layers: string[][] = [];
  for (const c of sorted) {
    const d = depthOf(c.id);
    (layers[d] ??= []).push(c.id);
  }
  // A layer wider than the screen allows wraps onto further rows.
  const rows: string[][] = [];
  for (const layer of layers) {
    if (!layer) continue;
    for (let i = 0; i < layer.length; i += maxCols) rows.push(layer.slice(i, i + maxCols));
  }
  return rows;
}

/** x for the ``i``th of ``n`` in a row; a lone concept leans to one side in turn. */
export function rowX(i: number, n: number, lone: number): number {
  if (n === 1) return [0.5, 0.68, 0.5, 0.32][lone % 4];
  const margin = n === 2 ? 0.27 : 0.18;
  return margin + (i * (1 - 2 * margin)) / (n - 1);
}

export function layoutMap(units: Unit[], maxCols = 3): MapLayout {
  const nodes: MapNode[] = [];
  const outUnits: MapUnit[] = [];
  const all: Concept[] = [];
  let y = 0;
  let lone = 0;
  let row = 0;
  for (const unit of [...units].sort((a, b) => a.position - b.position)) {
    const top = y;
    y += UNIT_HEAD_H;
    const rows = unitRows(unit.concepts, maxCols);
    for (const ids of rows) {
      ids.forEach((id, i) => {
        nodes.push({ id, unitId: unit.id, x: rowX(i, ids.length, lone), y: y + ROW_H / 2, row });
      });
      if (ids.length === 1) lone += 1;
      y += ROW_H;
      row += 1;
    }
    y += UNIT_PAD_BOTTOM;
    outUnits.push({ id: unit.id, top, height: y - top });
    y += UNIT_GAP;
    all.push(...unit.concepts);
  }
  const byId: Record<string, MapNode> = {};
  for (const n of nodes) byId[n.id] = n;
  const concept = new Map(all.map((c) => [c.id, c]));
  const edges: MapEdge[] = [];
  for (const c of all) {
    for (const p of c.prereqs) {
      const from = concept.get(p);
      if (!from || !byId[p] || !byId[c.id] || p === c.id) continue;
      edges.push({ from: p, to: c.id, gap: c.origin === "gap" || from.origin === "gap", done: isDone(from) && isDone(c) });
    }
  }
  return { nodes, byId, edges, units: outUnits, height: Math.max(0, y - UNIT_GAP) };
}

/** A smooth line from one concept down (or across) to the next, in the
 *  map's own units: x 0..100, y px. */
export function edgePath(a: MapNode, b: MapNode): string {
  const ax = a.x * 100;
  const bx = b.x * 100;
  if (Math.abs(a.y - b.y) < 1) return `M ${ax} ${a.y} L ${bx} ${b.y}`;
  const mid = (a.y + b.y) / 2;
  return `M ${ax} ${a.y} C ${ax} ${mid}, ${bx} ${mid}, ${bx} ${b.y}`;
}

export type Band = "known" | "mastered" | "nearly" | "learning" | "new" | "locked";

/** How a concept is drawn. */
export function bandOf(c: Pick<Concept, "state" | "mastery" | "locked">): Band {
  if (c.state === "known") return "known";
  if (c.state === "mastered") return "mastered";
  if (c.locked) return "locked";
  if (c.state === "new" && c.mastery <= 0) return "new";
  return c.mastery >= 0.6 ? "nearly" : "learning";
}

export const BAND_WORDS: Record<Band, string> = {
  known: "You already knew this",
  mastered: "Learned",
  nearly: "Nearly there",
  learning: "Still learning",
  new: "Not started",
  locked: "Comes later",
};
