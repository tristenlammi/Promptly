import type { HomeEntity } from "@/api/home";

/** What a device is doing, in plain words. */
export function stateWords(e: HomeEntity): string {
  if (!e.online) return "Offline";
  const s = e.state;
  if (s === "unavailable" || s === "unknown" || s === "") return "Not responding";
  if (e.domain === "sensor") return e.unit ? `${s} ${e.unit}` : s;
  if (e.domain === "binary_sensor") {
    const on = s === "on";
    if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return on ? "Open" : "Closed";
    if (e.cls === "motion" || e.cls === "occupancy" || e.cls === "presence") return on ? "Movement" : "Clear";
    if (e.cls === "moisture") return on ? "Wet" : "Dry";
    if (e.cls === "smoke" || e.cls === "gas" || e.cls === "carbon_monoxide") return on ? "Detected" : "Clear";
    if (e.cls === "battery") return on ? "Low" : "Fine";
    return on ? "On" : "Off";
  }
  if (e.domain === "light" && s === "on" && typeof e.bri === "number" && e.bri > 0 && e.bri < 100) return `On · ${e.bri}%`;
  if (e.domain === "climate" && typeof e.x?.target === "number") return `${s === "off" ? "Off" : s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ")} · ${e.x.target}°`;
  if (e.domain === "cover" && typeof e.x?.pos === "number" && e.x.pos > 0 && e.x.pos < 100) return `${e.x.pos}% open`;
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

/** Readings (a temperature, a door, a battery) sit in a row under a room's tiles, not as tiles. */
export function isReading(e: HomeEntity): boolean {
  return e.domain === "sensor" || e.domain === "binary_sensor";
}

const READING_ORDER = ["temperature", "humidity", "motion", "occupancy", "presence", "door", "window", "opening", "garage_door", "moisture", "smoke", "gas", "carbon_monoxide", "illuminance", "power", "energy", "battery"];

/** Temperature first, batteries last, the rest by name. */
export function byReading(a: HomeEntity, b: HomeEntity): number {
  const rank = (e: HomeEntity) => {
    const i = READING_ORDER.indexOf(e.cls ?? "");
    return i < 0 ? READING_ORDER.length - 1.5 : i;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}
