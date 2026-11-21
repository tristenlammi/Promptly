import type { Concept, Unit } from "@/api/study";

/*
 * Where each concept sits on the map, and how the lines run. Pure, so it can
 * be tested.
 *
 * Units stack top to bottom. Inside a unit a concept sits one row below the
 * deepest thing it depends on in that unit. Across a row, a concept sits
 * under what it builds on (under the middle of them when there are several),
 * so a chain of ideas runs straight down and a line rarely has to cross
 * another.
 *
 * Lines are drawn only inside a unit, and only where they say something: a
 * line that another route already implies (a → c when a → b → c is there) is
 * left out. A line runs down from a stop, turns in the clear band between two
 * rows, and comes down into the next stop from straight above, so it never
 * runs through a name. A line that has to pass a row on its way gets its own
 * gap in that row.
 */

export const ROW_H = 148;
/** A stop's centre line, below the top of its row. */
const ROW_Y = 70;
/** Above a stop's centre line: where lines turn, and where they arrive. */
const BAND_UP = 56;
const ARRIVE_UP = 38;
const LEAVE_DOWN = 20;
export const UNIT_HEAD_H = 68;
export const UNIT_GAP = 28;
export const UNIT_PAD_BOTTOM = 12;

export interface MapNode {
  id: string;
  unitId: string;
  /** Centre, as a fraction of the map's width (0..1). */
  x: number;
  /** Centre line, px from the top of the map. */
  y: number;
  row: number;
}

export interface MapPoint {
  x: number;
  y: number;
  /** A place a line passes through in a row, not a stop. */
  pass: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  /** The idea at ``to`` was added for a gap, or ``from`` was. */
  gap: boolean;
  /** Both ends are done. */
  done: boolean;
  /** The stops at each end, and any rows passed on the way. */
  points: MapPoint[];
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

/** The lines worth drawing inside one unit, as [from, to]: every in-unit
 *  prerequisite that points up the page, less the ones another route implies. */
export function unitLinks(concepts: Concept[], rowOf: Map<string, number>): [string, string][] {
  const sorted = [...concepts].sort((a, b) => a.position - b.position);
  const ups = new Map<string, string[]>();
  for (const c of sorted) {
    const mine = rowOf.get(c.id) ?? 0;
    ups.set(
      c.id,
      [...new Set(c.prereqs)].filter((p) => p !== c.id && rowOf.has(p) && (rowOf.get(p) ?? 0) < mine)
    );
  }
  const above = new Map<string, Set<string>>();
  const aboveOf = (id: string): Set<string> => {
    const known = above.get(id);
    if (known) return known;
    const set = new Set<string>();
    above.set(id, set); // rows only go up, so this cannot loop
    for (const p of ups.get(id) ?? []) {
      set.add(p);
      for (const q of aboveOf(p)) set.add(q);
    }
    return set;
  };
  const out: [string, string][] = [];
  for (const c of sorted) {
    const mine = ups.get(c.id) ?? [];
    for (const p of mine) if (!mine.some((q) => q !== p && aboveOf(q).has(p))) out.push([p, c.id]);
  }
  return out;
}

export interface RowItem {
  id: string;
  /** A line passing through the row, not a stop. */
  pass: boolean;
  order: number;
  /** What it hangs from in the row above. */
  from: RowItem[];
  want: number;
  x: number;
}

const gapBetween = (a: RowItem, b: RowItem, col: number) => (a.pass && b.pass ? 0.05 : a.pass || b.pass ? col / 2 : col);

/** Set ``x`` for one row, left to right in the order given: as near to each
 *  item's ``want`` as the others allow, never closer than they may sit. */
export function placeRow(items: RowItem[], col: number): void {
  const n = items.length;
  if (!n) return;
  const off: number[] = [0];
  for (let i = 1; i < n; i += 1) off[i] = off[i - 1] + gapBetween(items[i - 1], items[i], col);
  // Least total move with the order kept: pool neighbours that would cross.
  const blocks: { sum: number; count: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    blocks.push({ sum: items[i].want - off[i], count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.count <= b.sum / b.count) break;
      a.sum += b.sum;
      a.count += b.count;
      blocks.pop();
    }
  }
  const q: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.count; k += 1) q.push(b.sum / b.count);
  // Keep everything on the map.
  const lo = (i: number) => (items[i].pass ? 0.04 : col / 2) - off[i];
  const hi = (i: number) => (items[i].pass ? 0.96 : 1 - col / 2) - off[i];
  for (let i = 0; i < n; i += 1) q[i] = Math.max(q[i], lo(i), i ? q[i - 1] : -Infinity);
  for (let i = n - 1; i >= 0; i -= 1) q[i] = Math.min(q[i], hi(i), i < n - 1 ? q[i + 1] : Infinity);
  items.forEach((it, i) => {
    it.x = Math.round((q[i] + off[i]) * 10000) / 10000;
  });
}

export function layoutMap(units: Unit[], maxCols = 3): MapLayout {
  const nodes: MapNode[] = [];
  const outUnits: MapUnit[] = [];
  const edges: MapEdge[] = [];
  const col = 1 / maxCols;
  let y = 0;
  let row = 0;
  for (const unit of [...units].sort((a, b) => a.position - b.position)) {
    const top = y;
    y += UNIT_HEAD_H;
    const rows = unitRows(unit.concepts, maxCols);
    const concept = new Map(unit.concepts.map((c) => [c.id, c]));
    const rowOf = new Map<string, number>();
    rows.forEach((ids, r) => ids.forEach((id) => rowOf.set(id, r)));
    const base = y;
    const yOf = (r: number) => base + r * ROW_H + ROW_Y;

    const items: RowItem[][] = rows.map((ids) => ids.map((id, i) => ({ id, pass: false, order: i, from: [], want: NaN, x: 0 })));
    const stop = new Map(items.flat().map((it) => [it.id, it]));
    const routes: { from: string; to: string; via: RowItem[] }[] = [];
    for (const [from, to] of unitLinks(unit.concepts, rowOf)) {
      const a = stop.get(from);
      const b = stop.get(to);
      if (!a || !b) continue;
      const via: RowItem[] = [a];
      for (let r = (rowOf.get(from) ?? 0) + 1; r < (rowOf.get(to) ?? 0); r += 1) {
        const pass: RowItem = { id: `${from}>${to}@${r}`, pass: true, order: items[r].length, from: [via[via.length - 1]], want: NaN, x: 0 };
        items[r].push(pass);
        via.push(pass);
      }
      b.from.push(via[via.length - 1]);
      via.push(b);
      routes.push({ from, to, via });
    }

    for (const line of items) {
      const free = line.filter((it) => !it.from.length);
      free.forEach((it, i) => {
        it.want = (i + 0.5) / free.length;
      });
      for (const it of line) if (it.from.length) it.want = it.from.reduce((s, p) => s + p.x, 0) / it.from.length;
      line.sort((a, b) => a.want - b.want || a.order - b.order);
      placeRow(line, col);
    }

    rows.forEach((ids, r) => {
      for (const id of ids) nodes.push({ id, unitId: unit.id, x: stop.get(id)?.x ?? 0.5, y: yOf(r), row: row + r });
    });
    for (const { from, to, via } of routes) {
      const a = concept.get(from);
      const b = concept.get(to);
      if (!a || !b) continue;
      const first = rowOf.get(from) ?? 0;
      edges.push({
        from,
        to,
        gap: a.origin === "gap" || b.origin === "gap",
        done: isDone(a) && isDone(b),
        points: via.map((it, i) => ({ x: it.x, y: yOf(first + i), pass: it.pass })),
      });
    }

    row += rows.length;
    y += rows.length * ROW_H + UNIT_PAD_BOTTOM;
    outUnits.push({ id: unit.id, top, height: y - top });
    y += UNIT_GAP;
  }
  const byId: Record<string, MapNode> = {};
  for (const n of nodes) byId[n.id] = n;
  return { nodes, byId, edges, units: outUnits, height: Math.max(0, y - UNIT_GAP) };
}

const num = (v: number) => String(Math.round(v * 100) / 100);

/** A line along ``points`` in the map's own units (x 0..100, y px): straight
 *  down, with a rounded turn in the band above each row where it changes column. */
export function routePath(points: MapPoint[]): string {
  if (points.length < 2) return "";
  let x = points[0].x * 100;
  let d = `M ${num(x)} ${num(points[0].y + LEAVE_DOWN)}`;
  for (const p of points.slice(1)) {
    const to = p.x * 100;
    const band = p.y - BAND_UP;
    const dx = to - x;
    if (Math.abs(dx) > 0.05) {
      const rx = Math.min(1.6, Math.abs(dx) / 2) * Math.sign(dx);
      d += ` V ${num(band - 9)} Q ${num(x)} ${num(band)} ${num(x + rx)} ${num(band)} H ${num(to - rx)} Q ${num(to)} ${num(band)} ${num(to)} ${num(band + 9)}`;
      x = to;
    }
  }
  return `${d} V ${num(points[points.length - 1].y - ARRIVE_UP)}`;
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
