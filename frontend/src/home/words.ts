import type { BoxNote, HomeEntity } from "@/api/home";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/** An air con's modes and fan speeds, in plain words. */
export const MODE_WORDS: Record<string, string> = { off: "Off", heat: "Heat", cool: "Cool", heat_cool: "Auto", auto: "Auto", dry: "Dry", fan_only: "Fan" };
export const FAN_WORDS: Record<string, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", diffuse: "Quiet", focus: "Powerful", turbo: "Turbo", intelligent_auto: "Smart auto", on: "On", off: "Off", middle: "Medium", top: "Top" };
export const modeWord = (m: string) => MODE_WORDS[m] ?? cap(m);
export const fanWord = (m: string) => FAN_WORDS[m.toLowerCase()] ?? cap(m);
const DOING: Record<string, string> = { heating: "Heating", cooling: "Cooling", drying: "Drying", fan: "Fan", idle: "Idle", preheating: "Warming up", defrosting: "Defrosting" };
const VACUUM: Record<string, string> = { cleaning: "Cleaning", docked: "Docked", returning: "Going home", paused: "Paused", idle: "Stopped", error: "Needs attention" };

/** Air con in a line: "Cooling to 23°", "Cool · 23°", "Off"; a zone is just on or off. */
function climateWords(e: HomeEntity): string {
  const s = e.state;
  const to = typeof e.x?.target === "number" ? `${e.x.target}°` : "";
  if (s === "off") return "Off";
  if (e.x?.zone) return to ? `On · ${to}` : "On";
  const doing = e.x?.act && e.x.act !== "off" ? DOING[e.x.act] : undefined;
  if (doing && doing !== "Idle" && doing !== "Fan" && to) return `${doing} to ${to}`;
  return to && s !== "fan_only" ? `${modeWord(s)} · ${to}` : modeWord(s);
}

/** What a device is doing, in plain words. */
export function stateWords(e: HomeEntity): string {
  if (!e.online) return "Offline";
  const s = e.state;
  if (s === "unavailable" || s === "unknown" || s === "") return "Not responding";
  if (e.domain === "sensor") {
    // "0.028316846592 m³" is nobody's reading: three figures after the point at most.
    const n = /^-?\d+\.\d{4,}$/.test(s) ? String(Number(Number(s).toFixed(3))) : s;
    return e.unit ? `${n} ${e.unit}` : cap(n);
  }
  if (e.domain === "binary_sensor") {
    const on = s === "on";
    if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return on ? "Open" : "Closed";
    if (e.cls === "motion" || e.cls === "occupancy" || e.cls === "presence") return on ? "Movement" : "Clear";
    if (e.cls === "moisture") return on ? "Wet" : "Dry";
    if (e.cls === "smoke" || e.cls === "gas" || e.cls === "carbon_monoxide") return on ? "Detected" : "Clear";
    if (e.cls === "battery") return on ? "Low" : "Fine";
    if (e.cls === "connectivity") return on ? "Connected" : "Not connected";
    if (e.cls === "plug" || e.cls === "power") return on ? "On" : "Off";
    if (e.cls === "lock") return on ? "Unlocked" : "Locked";
    if (e.cls === "problem" || e.cls === "safety" || e.cls === "tamper") return on ? "Problem" : "Fine";
    return on ? "On" : "Off";
  }
  if (e.domain === "light" && s === "on" && typeof e.bri === "number" && e.bri > 0 && e.bri < 100) return `On · ${e.bri}%`;
  if (e.domain === "climate") return climateWords(e);
  if (e.domain === "vacuum") return `${VACUUM[s] ?? cap(s)}${typeof e.x?.bat === "number" && s === "docked" ? ` · ${Math.round(e.x.bat)}%` : ""}`;
  if (e.domain === "scene") return "Scene";
  if (e.domain === "cover" && typeof e.x?.pos === "number" && e.x.pos > 0 && e.x.pos < 100) return `${e.x.pos}% open`;
  if (e.domain === "media_player") {
    // A speaker is "off" when nothing is playing on it, not when it's unplugged.
    if (s === "playing") return e.x?.title ? `Playing · ${e.x.title}` : "Playing";
    if (s === "paused") return "Paused";
    if (s === "buffering") return "Starting…";
    if (e.cls === "tv" || e.cls === "receiver") return s === "off" || s === "standby" ? "Off" : "On";
    return "Not playing";
  }
  // A kind we have no controls for: what it says, tidied. A bare time means nothing to anyone.
  if (/^\d{4}-\d\d-\d\dT/.test(s)) return "";
  return cap(s);
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

const KINDS: Record<string, [string, string]> = {
  light: ["light", "lights"],
  switch: ["plug or switch", "plugs and switches"],
  input_boolean: ["switch", "switches"],
  fan: ["fan", "fans"],
  climate: ["air con or heater", "air con and heaters"],
  vacuum: ["robot vacuum", "robot vacuums"],
  humidifier: ["humidifier", "humidifiers"],
  valve: ["valve", "valves"],
  remote: ["remote", "remotes"],
  cover: ["blind or door", "blinds and doors"],
  lock: ["lock", "locks"],
  media_player: ["speaker or TV", "speakers and TVs"],
  sensor: ["sensor", "sensors"],
  binary_sensor: ["sensor", "sensors"],
};

/** "1 light", "3 speakers and TVs". */
export function countWords(kind: string, n: number): string {
  const [one, many] = KINDS[kind] ?? ["device", "devices"];
  return `${n} ${n === 1 ? one : many}`;
}

/** After a brand is added: "Added Philips Hue: 1 light in Lounge Room, 2 plugs and switches with no room yet." */
export function addedLine(brand: string, summary: { n: number; kind: string; room: string }[] | undefined): string {
  if (!summary || summary.length === 0) return `Added ${brand}. What it brings will show on your Home page in a moment.`;
  const parts = summary.map((s) => `${countWords(s.kind, s.n)} ${s.room ? `in ${s.room}` : "with no room yet"}`);
  const list = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Added ${brand}: ${list}.`;
}

/** The one-time line about things that had joined the home by themselves. */
export function noteLine(note: BoxNote): string {
  const what = note.n > 0 ? `${note.n} ${note.what === "speakers" ? (note.n === 1 ? "speaker" : "speakers") : note.n === 1 ? "device" : "devices"}` : note.brands.join(", ");
  const verb = note.n === 1 ? "is" : "are";
  const from = note.n > 0 && note.brands.length > 0 ? ` (${note.brands.join(", ")})` : "";
  return `${what}${from} that appeared on ${note.n === 1 ? "its" : "their"} own ${verb} waiting under Add a device → Found on your network. Nothing joins your home unless you add it.`;
}

/** Under Music: which of the home's speakers can be asked to play something by name. */
export function musicSummary(names: string[], speakers: number): string {
  if (speakers === 0) return "This home has no speakers yet. Add one with Add a device on your Home page.";
  if (names.length === 0) return "None of this home's speakers can play music by name yet. A speaker can take a minute to show up here after it's added.";
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const list = sorted.length <= 2 ? sorted.join(" and ") : `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
  return `Plays on: ${list}.${names.length < speakers ? " Your other speakers can still be paused, skipped and turned up or down." : ""}`;
}

/** Same room name? Ignores case and spacing only: "Lounge Room" is never "Living Room". */
export function sameRoom(a: string, b: string): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return flat(a) !== "" && flat(a) === flat(b);
}
