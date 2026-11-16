import type { HomeEntity } from "@/api/home";

import { isReading } from "./words";

/**
 * What kind of thing each device is, for the page: which ones are tiles,
 * which sit in a row, the order they come in, and how a ducted air con's
 * zones hang off their unit. Plain functions, no drawing.
 */

/** It says it can do this. A device that doesn't say what it can do is taken at its word. */
export function can(e: HomeEntity, what: string): boolean {
  const list = e.x?.can;
  return !Array.isArray(list) || list.includes(what);
}

export const keyOf = (e: HomeEntity) => `${e.box_id}/${e.id}`;

/** A scene is something to set going, not a device: a row of buttons under the room. */
export const isScene = (e: HomeEntity) => e.domain === "scene";

/** One zone of a ducted air con. */
export const isZone = (e: HomeEntity) => e.domain === "climate" && e.x?.zone === true;

/** The unit a zone belongs to. */
export function unitOf(all: HomeEntity[], zone: HomeEntity): HomeEntity | null {
  if (!isZone(zone) || !zone.x?.sys) return null;
  return all.find((u) => u.box_id === zone.box_id && u.id === zone.x!.sys) ?? null;
}

/** A unit's zones, by name. */
export function zonesOf(all: HomeEntity[], unit: HomeEntity): HomeEntity[] {
  if (unit.domain !== "climate" || isZone(unit)) return [];
  return all.filter((z) => isZone(z) && z.box_id === unit.box_id && z.x?.sys === unit.id).sort((a, b) => a.name.localeCompare(b.name));
}

/** The vent that goes with a zone (same device): shown inside the zone, never as its own tile. */
export function ventOf(all: HomeEntity[], zone: HomeEntity): HomeEntity | null {
  if (zone.domain !== "climate" || !zone.dev) return null;
  return all.find((c) => c.domain === "cover" && c.cls === "damper" && c.box_id === zone.box_id && c.dev === zone.dev) ?? null;
}

/** Shown as a tile. Not: readings and scenes (their own rows), or a zone's vent. */
export function isTile(e: HomeEntity, all: HomeEntity[]): boolean {
  if (isReading(e) || isScene(e)) return false;
  if (e.domain === "cover" && e.cls === "damper" && e.dev && all.some((c) => c.domain === "climate" && c.box_id === e.box_id && c.dev === e.dev)) return false;
  return true;
}

const ORDER = ["light", "climate", "media_player", "fan", "cover", "lock", "vacuum", "switch", "input_boolean", "humidifier", "valve", "remote"];

/** Lights first, then air con, speakers and TVs, and the rest; within a kind, a unit before its zones, then by name. */
export function byKind(a: HomeEntity, b: HomeEntity): number {
  const rank = (e: HomeEntity) => {
    const i = ORDER.indexOf(e.domain);
    return (i < 0 ? ORDER.length : i) * 2 + (isZone(e) ? 1 : 0);
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** "On" for the tile's look: lit, open, unlocked, playing, running. */
export function lit(e: HomeEntity): boolean {
  const s = e.state;
  if (e.domain === "cover" || e.domain === "valve") return s === "open" || s === "opening";
  if (e.domain === "lock") return s === "unlocked";
  if (e.domain === "climate") return s !== "off" && s !== "unavailable" && s !== "unknown";
  if (e.domain === "media_player") return e.cls === "tv" || e.cls === "receiver" ? !["off", "standby", "unavailable", "unknown"].includes(s) : s === "playing";
  if (e.domain === "vacuum") return s === "cleaning" || s === "returning";
  return s === "on";
}

/** A tap on the tile switches it (anything else opens its controls). A zone is a switch; a whole air con isn't. */
export function tapSwitches(e: HomeEntity): boolean {
  return e.can_switch || isZone(e);
}

/** The speakers this one could play together with. */
export function groupable(all: HomeEntity[], e: HomeEntity): HomeEntity[] {
  if (e.domain !== "media_player" || !Array.isArray(e.x?.can) || !e.x!.can!.includes("group")) return [];
  return all
    .filter((o) => o.domain === "media_player" && o.box_id === e.box_id && o.id !== e.id && !o.grp && Array.isArray(o.x?.can) && o.x!.can!.includes("group"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One step warmer or cooler, kept to what the device can be set to. */
export function stepTemp(x: NonNullable<HomeEntity["x"]>, from: number, dir: 1 | -1): number {
  const step = typeof x.step === "number" && x.step > 0 ? x.step : 0.5;
  let next = Math.round((from + dir * step) * 10) / 10;
  if (typeof x.min === "number") next = Math.max(x.min, next);
  if (typeof x.max === "number") next = Math.min(x.max, next);
  return next;
}
