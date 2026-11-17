import type { Home, HomeEntity } from "@/api/home";

import { isScene, isTile, keyOf } from "../kinds";
import { isReading } from "../words";

/**
 * A person's own layout of a home's page: a list of widgets, in order, each
 * with a size. Plain functions, no drawing.
 *
 * - ``device``: one device (``key``). Small is its tile; bigger shows its main
 *   control (a light's brightness, a speaker's playback).
 * - ``room``: a room as the page always showed it (``area``; "" is "not in a
 *   room yet").
 * - ``scenes``: scene buttons (``items``).
 * - ``group``: devices picked by hand, with one switch for them all (``items``,
 *   ``title``). "Favourites" is a group.
 * - ``music``: what's playing, with a choice of speaker (``key`` remembers it).
 * - ``rest``: every room that has no widget of its own, so a room made later
 *   still shows up.
 *
 * Nobody has a saved layout until they customise: until then the page is
 * ``rest`` alone, which is the page as it always was.
 */

export type WidgetType = "device" | "room" | "scenes" | "group" | "music" | "rest";
export type WidgetSize = "s" | "m" | "l";

export interface Widget {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  title?: string;
  key?: string;
  area?: string;
  items?: string[];
}

export const MAX_WIDGETS = 60;
export const MAX_ITEMS = 40;

const TYPES: WidgetType[] = ["device", "room", "scenes", "group", "music", "rest"];

/** The sizes a kind of widget can be, smallest first. */
export function sizesOf(w: Pick<Widget, "type" | "items">): WidgetSize[] {
  if (w.type === "device") return ["s", "m", "l"];
  if (w.type === "scenes") return (w.items?.length ?? 0) <= 1 ? ["s", "m", "l"] : ["m", "l"];
  if (w.type === "rest") return ["l"];
  return ["m", "l"];
}

export const SIZE_WORDS: Record<WidgetSize, string> = { s: "Small", m: "Medium", l: "Large" };

/** The next size up, round to the smallest after the biggest. */
export function nextSize(w: Widget): WidgetSize {
  const all = sizesOf(w);
  return all[(all.indexOf(w.size) + 1) % all.length] ?? all[0];
}

let seq = 0;
/** A short id, different from every one in ``taken``. */
export function newId(taken: Iterable<string> = []): string {
  const have = new Set(taken);
  for (;;) {
    seq += 1;
    const id = `w${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 24);
    if (!have.has(id)) return id;
  }
}

/** The page as it comes: every room, as always. */
export const DEFAULT: Widget[] = [{ id: "rest", type: "rest", size: "l" }];

/** The rooms that have something in them, in the order set under Rooms; "" (no room yet) last. */
export function roomsOf(home: Pick<Home, "areas" | "entities">): { id: string; name: string; list: HomeEntity[] }[] {
  const known = new Map(home.areas.map((a) => [a.id, a]));
  const groups = new Map<string, HomeEntity[]>();
  for (const e of home.entities) {
    const key = e.area && known.has(e.area) ? e.area : "";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: { id: string; name: string; list: HomeEntity[] }[] = [];
  for (const a of home.areas) if (groups.has(a.id)) out.push({ id: a.id, name: a.name, list: groups.get(a.id)! });
  if (groups.has("")) out.push({ id: "", name: NO_ROOM, list: groups.get("")! });
  return out;
}

export const NO_ROOM = "Not in a room yet";

/**
 * What customising starts from when there's no saved layout: the same page,
 * one widget a room (so each can be moved, shrunk or taken off), then
 * "everything else" to catch rooms made later.
 */
export function startingLayout(home: Pick<Home, "areas" | "entities">): Widget[] {
  const out: Widget[] = [];
  for (const r of roomsOf(home)) {
    if (!r.id) continue; // "Not in a room yet" stays with everything else
    out.push({ id: newId(out.map((w) => w.id)), type: "room", size: "l", area: r.id, title: r.name });
  }
  out.push({ id: newId(out.map((w) => w.id)), type: "rest", size: "l" });
  return out.slice(0, MAX_WIDGETS);
}

/** The rooms "everything else" shows: those with no room widget of their own. */
export function restRooms(home: Pick<Home, "areas" | "entities">, widgets: Widget[]) {
  const placed = new Set(widgets.filter((w) => w.type === "room").map((w) => w.area ?? ""));
  return roomsOf(home).filter((r) => !placed.has(r.id));
}

/**
 * What came from the server, made safe to draw: unknown kinds dropped, sizes
 * put right, ids made unique. ``null`` (never customised) stays ``null``.
 */
export function tidy(raw: unknown): Widget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Widget[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const w = r as Record<string, unknown>;
    if (typeof w.id !== "string" || !TYPES.includes(w.type as WidgetType) || seen.has(w.id)) continue;
    const one: Widget = { id: w.id, type: w.type as WidgetType, size: "l" };
    if (typeof w.title === "string") one.title = w.title.slice(0, 60);
    if (typeof w.key === "string") one.key = w.key;
    if (typeof w.area === "string") one.area = w.area;
    if (Array.isArray(w.items)) one.items = w.items.filter((i): i is string => typeof i === "string").slice(0, MAX_ITEMS);
    const sizes = sizesOf(one);
    one.size = sizes.includes(w.size as WidgetSize) ? (w.size as WidgetSize) : sizes[0];
    seen.add(one.id);
    out.push(one);
    if (out.length >= MAX_WIDGETS) break;
  }
  return out;
}

/** ``id`` moved to where ``over`` is. */
export function move(widgets: Widget[], id: string, over: string): Widget[] {
  const from = widgets.findIndex((w) => w.id === id);
  const to = widgets.findIndex((w) => w.id === over);
  if (from < 0 || to < 0 || from === to) return widgets;
  const out = widgets.slice();
  const [w] = out.splice(from, 1);
  out.splice(to, 0, w);
  return out;
}

/** One place earlier (-1) or later (1). */
export function nudge(widgets: Widget[], id: string, dir: 1 | -1): Widget[] {
  const from = widgets.findIndex((w) => w.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= widgets.length) return widgets;
  return move(widgets, id, widgets[to].id);
}

export const without = (widgets: Widget[], id: string) => widgets.filter((w) => w.id !== id);

export function resized(widgets: Widget[], id: string): Widget[] {
  return widgets.map((w) => (w.id === id ? { ...w, size: nextSize(w) } : w));
}

/** A widget put last (before "everything else", so it isn't lost under every room). */
export function added(widgets: Widget[], w: Omit<Widget, "id">): Widget[] {
  if (widgets.length >= MAX_WIDGETS) return widgets;
  const one = { ...w, id: newId(widgets.map((x) => x.id)) };
  const rest = widgets.findIndex((x) => x.type === "rest");
  if (w.type === "rest" || rest < 0) return [...widgets, one];
  return [...widgets.slice(0, rest), one, ...widgets.slice(rest)];
}

export const changed = (widgets: Widget[], id: string, to: Partial<Widget>) =>
  widgets.map((w) => {
    if (w.id !== id) return w;
    const one = { ...w, ...to };
    const sizes = sizesOf(one);
    return sizes.includes(one.size) ? one : { ...one, size: sizes[0] };
  });

export const same = (a: Widget[], b: Widget[]) => JSON.stringify(a) === JSON.stringify(b);

// ---- what a widget points at

export const find = (home: Pick<Home, "entities">, key: string | undefined) => (key ? home.entities.find((e) => keyOf(e) === key) ?? null : null);

/** The widget's devices that are still in the home, in the order picked. */
export function itemsOf(home: Pick<Home, "entities">, w: Widget): HomeEntity[] {
  const by = new Map(home.entities.map((e) => [keyOf(e), e]));
  return (w.items ?? []).map((k) => by.get(k)).filter((e): e is HomeEntity => !!e);
}

/**
 * Whether what a widget points at is gone from the home. Never while the
 * home has nothing to show at all (its box is still starting, or was just
 * added): then nothing can be told apart from "not here yet".
 */
export function gone(home: Pick<Home, "areas" | "entities">, w: Widget): boolean {
  if (home.entities.length === 0) return false;
  if (w.type === "device") return !find(home, w.key);
  if (w.type === "room") return (w.area ?? "") !== "" && !home.areas.some((a) => a.id === w.area);
  if (w.type === "scenes" || w.type === "group") return (w.items?.length ?? 0) > 0 && itemsOf(home, w).length === 0;
  return false;
}

/** The speakers music can show: not TVs or receivers. */
export const speakersOf = (home: Pick<Home, "entities">) =>
  home.entities.filter((e) => e.domain === "media_player" && e.cls !== "tv" && e.cls !== "receiver").sort((a, b) => a.name.localeCompare(b.name));

/** The speaker a music widget shows: the one picked, else one that's playing, else the first. */
export function speakerFor(home: Pick<Home, "entities">, w: Pick<Widget, "key">): HomeEntity | null {
  const all = speakersOf(home);
  return all.find((e) => keyOf(e) === w.key) ?? all.find((e) => e.state === "playing") ?? all[0] ?? null;
}

/** What "add a device" offers: tiles and readings, never a scene or a zone's vent. */
export const pickable = (home: Pick<Home, "entities">) => home.entities.filter((e) => isTile(e, home.entities) || isReading(e));
export const scenesIn = (home: Pick<Home, "entities">) => home.entities.filter(isScene).sort((a, b) => a.name.localeCompare(b.name));

/** A widget's name, for its edit bar and for "no longer in this home". */
export function nameOf(home: Pick<Home, "areas" | "entities">, w: Widget): string {
  if (w.type === "device") return find(home, w.key)?.name ?? w.title ?? "A device";
  if (w.type === "room") return (w.area ?? "") === "" ? NO_ROOM : home.areas.find((a) => a.id === w.area)?.name ?? w.title ?? "A room";
  if (w.type === "scenes") return w.title || "Scenes";
  if (w.type === "group") return w.title || "Group";
  if (w.type === "music") return "Music";
  return "Everything else";
}
