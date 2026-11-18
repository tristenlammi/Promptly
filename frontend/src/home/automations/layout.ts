/**
 * Laying a flow out, top to bottom: the "When" at the top, each step under
 * the one before it, a check's Yes to the left and its No to the right.
 * Steps that aren't joined on sit in a row underneath.
 */

interface Placed {
  id: string;
  type?: string;
  position: { x: number; y: number };
}

interface Joined {
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export const COLUMN = 300;
export const ROW = 130;

const ORDER: Record<string, number> = { true: 0, "": 1, false: 2 };

export function tidy<N extends Placed>(nodes: N[], edges: Joined[]): N[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string, string[]>();
  for (const e of [...edges].sort((a, b) => ORDER[a.sourceHandle ?? ""] - ORDER[b.sourceHandle ?? ""])) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  }
  const start = nodes.find((n) => (n.type ?? "").startsWith("trigger."));
  const depth = new Map<string, number>();
  const column = new Map<string, number>();
  let next = 0;

  // How far down each step is: under the lowest thing that leads to it.
  const sink = (id: string, d: number, trail: Set<string>) => {
    if (trail.has(id)) return; // a loop: the server refuses it; don't hang on it
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    const here = new Set(trail).add(id);
    for (const k of kids.get(id) ?? []) sink(k, d + 1, here);
  };
  // Left to right: a step sits over the middle of what follows it.
  const spread = (id: string, trail: Set<string>): number => {
    if (column.has(id)) return column.get(id)!;
    column.set(id, next); // a place to stand while its own steps are placed
    const below = (kids.get(id) ?? []).filter((k) => !trail.has(k) && !column.has(k));
    if (below.length === 0) {
      column.set(id, next);
      next += 1;
      return column.get(id)!;
    }
    const here = new Set(trail).add(id);
    const xs = below.map((k) => spread(k, here));
    column.set(id, (Math.min(...xs) + Math.max(...xs)) / 2);
    return column.get(id)!;
  };

  if (start) {
    sink(start.id, 0, new Set());
    spread(start.id, new Set());
  }
  const centre = start ? column.get(start.id) ?? 0 : 0;
  const lowest = Math.max(-1, ...depth.values());
  let loose = 0;
  return nodes.map((n) => {
    if (depth.has(n.id)) {
      return { ...n, position: { x: Math.round(((column.get(n.id) ?? 0) - centre) * COLUMN), y: (depth.get(n.id) ?? 0) * ROW } };
    }
    const at = { x: Math.round((loose - centre) * COLUMN), y: (lowest + 2) * ROW };
    loose += 1;
    return { ...n, position: at };
  });
}
