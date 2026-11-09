/**
 * Shopping lists by aisle (N2.2), as the server does it (``backend/app/notes/
 * aisles.py``): Meal Plan's food list says which aisle an item is in, the
 * note's store order (``list_opts.aisle_order``) says which aisle comes
 * first. Here only so the screen shows the right place at once; the server's
 * answer replaces it on the next refresh.
 */
import FOODS from "@/items/kinds/mealplan/foods.json";
import { aisleFor } from "@/items/kinds/mealplan/foods";

import type { Note, NoteItem } from "./types";

export const AISLE_NAMES = FOODS.aisles as Record<string, string>;
export const DEFAULT_ORDER = Object.keys(AISLE_NAMES);

export function aisleName(key: string | null | undefined): string {
  return AISLE_NAMES[key ?? "other"] ?? AISLE_NAMES.other ?? "Other";
}

export function aisleOf(text: string): string {
  return text.trim() ? aisleFor(text) : "other";
}

export function keptByAisle(note: Pick<Note, "list_opts" | "kind">): boolean {
  return note.kind === "list" && !!note.list_opts.aisles;
}

export function orderOf(note: Pick<Note, "list_opts">): string[] {
  const raw = note.list_opts.aisle_order;
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_ORDER;
  const out = [...new Set(raw.filter((a) => a in AISLE_NAMES))];
  return [...out, ...DEFAULT_ORDER.filter((a) => !out.includes(a))];
}

const pos = (i: NoteItem) => i.position ?? 0;

/** Every item in store order, then A–Z; children under their parent (with its aisle). */
export function sortByAisle(items: NoteItem[], order: string[]): NoteItem[] {
  const rank = new Map(order.map((a, n) => [a, n]));
  const r = (a: string | null | undefined) => rank.get(a ?? "other") ?? order.length;
  const byPos = [...items].sort((a, b) => pos(a) - pos(b));
  const tops = byPos.filter((i) => !i.parent_id).map((i) => ({ ...i, aisle: i.aisle ?? aisleOf(i.text) }));
  const top = new Map(tops.map((t) => [t.id, t]));
  tops.sort((a, b) => r(a.aisle) - r(b.aisle) || a.text.localeCompare(b.text, undefined, { sensitivity: "base" }) || pos(a) - pos(b));
  const kids = (id: string) => byPos.filter((i) => i.parent_id === id).map((k) => ({ ...k, aisle: top.get(id)?.aisle ?? k.aisle }));
  const out = tops.flatMap((t) => [t, ...kids(t.id)]);
  const seen = new Set(out.map((i) => i.id));
  return [...out, ...byPos.filter((i) => !seen.has(i.id))].map((i, n) => ({ ...i, position: n + 1 }));
}

/** Where a new top-level item in ``aisle`` goes: a position, and its aisle. */
export function placeByAisle(items: NoteItem[], aisle: string, order: string[]): number {
  const rank = new Map(order.map((a, n) => [a, n]));
  const mine = rank.get(aisle) ?? order.length;
  const byPos = [...items].sort((a, b) => pos(a) - pos(b));
  if (!byPos.length) return 1;
  let last: NoteItem | null = null;
  for (const t of byPos.filter((i) => !i.parent_id)) {
    if ((rank.get(t.aisle ?? aisleOf(t.text)) ?? order.length) <= mine) {
      const group = byPos.filter((i) => i.id === t.id || i.parent_id === t.id);
      last = group[group.length - 1];
    }
  }
  if (!last) return pos(byPos[0]) - 1;
  const at = byPos.findIndex((i) => i.id === last!.id);
  const next = byPos[at + 1];
  return next ? (pos(last) + pos(next)) / 2 : pos(last) + 1;
}
