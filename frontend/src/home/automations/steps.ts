import type { Home, HomeEntity } from "@/api/home";
import type { AutomationRun, FlowNode } from "@/api/homeAutomations";

/**
 * The steps of a home automation, in words. One place says what each kind of
 * step is called, what a device can be asked to do in one, and how a step
 * reads on the canvas and in the list ("Turn on Floor lamp").
 */

export type StepKind = "home.device" | "home.lights" | "home.music" | "flow.delay" | "control.home_state" | "control.time";

export const STEP_KINDS: { kind: StepKind; name: string; about: string }[] = [
  { kind: "home.device", name: "A device", about: "Turn a light, plug, fan, scene or speaker on, off or to a setting." },
  { kind: "home.lights", name: "A room's lights", about: "All the lights in one room, on or off." },
  { kind: "home.music", name: "Play music", about: "A kind of music, or something you pick, on one speaker." },
  { kind: "flow.delay", name: "Wait", about: "Pause before the next step." },
  { kind: "control.home_state", name: "Only if a device…", about: "Carry on one way if a device is on, another if it's off." },
  { kind: "control.time", name: "Only at certain times", about: "Carry on one way inside these hours, another outside." },
];

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Devices a step may switch: the everyday ones, never a lock, door or alarm. */
export const SWITCHED = ["light", "switch", "input_boolean", "fan", "scene", "media_player"];

export function canBeStep(e: HomeEntity): boolean {
  return SWITCHED.includes(e.domain) && !e.careful;
}

export const COLOURS: { name: string; value: Record<string, unknown> }[] = [
  { name: "Warm white", value: { k: 2700 } },
  { name: "Soft white", value: { k: 3000 } },
  { name: "White", value: { k: 4000 } },
  { name: "Cool white", value: { k: 5500 } },
  { name: "Daylight", value: { k: 6500 } },
  { name: "Red", value: { rgb: [255, 0, 0] } },
  { name: "Orange", value: { rgb: [255, 130, 0] } },
  { name: "Yellow", value: { rgb: [255, 220, 0] } },
  { name: "Green", value: { rgb: [0, 200, 60] } },
  { name: "Blue", value: { rgb: [0, 80, 255] } },
  { name: "Purple", value: { rgb: [150, 50, 255] } },
  { name: "Pink", value: { rgb: [255, 100, 180] } },
];

export function colourName(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "";
  const hit = COLOURS.find((c) => JSON.stringify({ k: c.value.k, rgb: c.value.rgb }) === JSON.stringify({ k: value.k, rgb: value.rgb }));
  return hit?.name ?? "";
}

/** What a device can be asked to do in a step. ``needs``: the value it takes. */
export interface ActionChoice {
  action: string;
  name: string;
  needs?: "light" | "percent" | "preset";
  value?: unknown;
}

export function actionsFor(e: HomeEntity | undefined): ActionChoice[] {
  if (!e) return [];
  const can = e.x?.can;
  const able = (word: string) => !can || can.includes(word);
  if (e.domain === "scene") return [{ action: "run", name: "Switch it on" }];
  if (e.domain === "light") {
    return [
      { action: "turn_on", name: "Turn on" },
      { action: "turn_off", name: "Turn off" },
      { action: "set", name: "Set brightness or colour", needs: "light" },
      { action: "toggle", name: "Switch (on if off, off if on)" },
    ];
  }
  if (e.domain === "fan") {
    return [
      { action: "turn_on", name: "Turn on" },
      { action: "turn_off", name: "Turn off" },
      ...(able("speed") ? [{ action: "speed", name: "Set speed", needs: "percent" as const }] : []),
    ];
  }
  if (e.domain === "media_player") {
    const out: ActionChoice[] = [];
    if (able("play")) out.push({ action: "play", name: "Play" });
    if (able("pause")) out.push({ action: "pause", name: "Pause" });
    if (able("stop")) out.push({ action: "stop", name: "Stop" });
    if (able("next")) out.push({ action: "next", name: "Next song" });
    if (able("prev")) out.push({ action: "prev", name: "Previous song" });
    if (able("vol")) out.push({ action: "volume", name: "Set volume", needs: "percent" });
    if (able("mute")) out.push({ action: "mute", name: "Mute", value: true }, { action: "mute", name: "Unmute", value: false });
    if (can?.includes("preset")) out.push({ action: "preset", name: "Play a saved preset", needs: "preset" });
    return out;
  }
  return [
    { action: "turn_on", name: "Turn on" },
    { action: "turn_off", name: "Turn off" },
    { action: "toggle", name: "Switch (on if off, off if on)" },
  ];
}

function entityOf(home: Home | undefined, data: Record<string, unknown>): HomeEntity | undefined {
  return home?.entities.find((e) => e.id === data.entity && e.box_id === data.box);
}

function called(home: Home | undefined, data: Record<string, unknown>, fallback: string): string {
  return entityOf(home, data)?.name ?? (String(data.name ?? "") || fallback);
}

export function waitWords(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function daysWords(days: number[] | undefined | null): string {
  const set = [...new Set(days ?? [])].filter((d) => d >= 0 && d <= 6).sort();
  if (set.length === 0 || set.length === 7) return "every day";
  if (set.join() === "0,1,2,3,4") return "weekdays";
  if (set.join() === "5,6") return "weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}

/** "07:00" → "7:00 am". */
export function clock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return hhmm ?? "";
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "am" : "pm"}`;
}

/** A schedule start, as the form holds it. */
export interface TimeStart {
  time: string;
  days: number[];
}

export function toSchedule(start: TimeStart): Record<string, unknown> {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start.time) ?? ["", "7", "00"];
  const days = [...new Set(start.days)].filter((d) => d >= 0 && d <= 6).sort();
  const every = days.length === 0 || days.length === 7;
  return {
    frequency: every ? "daily" : "weekly",
    hour: Number(m[1]),
    minute: Number(m[2]),
    weekdays: every ? null : days,
    weekday: every ? null : days[0],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
  };
}

export function fromSchedule(data: Record<string, unknown>): TimeStart {
  const hour = typeof data.hour === "number" ? data.hour : 7;
  const minute = typeof data.minute === "number" ? data.minute : 0;
  const days = data.frequency === "weekly" ? ((data.weekdays as number[] | null) ?? (typeof data.weekday === "number" ? [data.weekday] : [])) : [];
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, days };
}

function stateWords(state: unknown, e: HomeEntity | undefined): [string, string] {
  // What "on" and "off" are called for this kind of device.
  if (e?.domain === "media_player") return ["is playing", "isn't playing"];
  if (e?.domain === "binary_sensor" && (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door")) return ["is open", "is closed"];
  if (e?.domain === "binary_sensor" && (e.cls === "motion" || e.cls === "occupancy" || e.cls === "presence")) return ["sees someone", "sees nobody"];
  if (e?.domain === "cover") return ["is open", "is closed"];
  if (e?.domain === "lock") return ["is unlocked", "is locked"];
  void state;
  return ["is on", "is off"];
}

/** The same, as a change that starts an automation ("opens", "turns off"). */
export function changeChoice(e: HomeEntity | undefined): { on: string; off: string } {
  if (e?.domain === "media_player") return { on: "starts playing", off: "stops playing" };
  if (e?.domain === "cover" || (e?.domain === "binary_sensor" && ["door", "window", "opening", "garage_door"].includes(e.cls ?? ""))) return { on: "opens", off: "closes" };
  if (e?.domain === "binary_sensor" && ["motion", "occupancy", "presence"].includes(e.cls ?? "")) return { on: "sees someone", off: "stops seeing anyone" };
  if (e?.domain === "lock") return { on: "is unlocked", off: "is locked" };
  return { on: "turns on", off: "turns off" };
}

export function stateChoice(e: HomeEntity | undefined): { on: string; off: string } {
  const [on, off] = stateWords("on", e);
  return { on, off };
}

/** How a step reads: ``[what it is, the sentence]``. */
export function stepWords(node: FlowNode, home?: Home): { title: string; line: string; unset: boolean } {
  const d = node.data ?? {};
  switch (node.type) {
    case "trigger.manual":
      return { title: "When", line: "Someone asks: a phrase, or the Run button", unset: false };
    case "trigger.schedule": {
      const s = fromSchedule(d);
      return { title: "When", line: `It's ${clock(s.time)}, ${daysWords(s.days)}`, unset: false };
    }
    case "trigger.home_state": {
      const e = entityOf(home, d);
      if (!d.entity) return { title: "When", line: "Pick the device that starts it", unset: true };
      const { on, off } = changeChoice(e);
      return { title: "When", line: `${called(home, d, "A device")} ${d.state === "off" ? off : on}`, unset: false };
    }
    case "home.device": {
      if (!d.entity) return { title: "Device", line: "Pick a device", unset: true };
      const e = entityOf(home, d);
      const name = called(home, d, "A device");
      const value = d.value as Record<string, unknown> | number | boolean | null | undefined;
      const say: Record<string, string> = {
        turn_on: `Turn on ${name}`,
        turn_off: `Turn off ${name}`,
        toggle: `Switch ${name}`,
        run: `Switch on ${name}`,
        play: `Play on ${name}`,
        pause: `Pause ${name}`,
        stop: `Stop ${name}`,
        next: `Next song on ${name}`,
        prev: `Previous song on ${name}`,
        volume: `${name}: volume ${value ?? ""}`,
        mute: `${value === false ? "Unmute" : "Mute"} ${name}`,
        speed: `${name}: speed ${value ?? ""}%`,
        preset: `${name}: play preset ${value ?? ""}`,
      };
      if (d.action === "set" && value && typeof value === "object") {
        const bits = [typeof value.bri === "number" ? `${value.bri}%` : "", colourName(value).toLowerCase()].filter(Boolean);
        return { title: e?.domain === "light" ? "Light" : "Device", line: `Set ${name} to ${bits.join(", ") || "…"}`, unset: bits.length === 0 };
      }
      return { title: e?.domain === "media_player" ? "Speaker" : e?.domain === "scene" ? "Scene" : e?.domain === "light" ? "Light" : "Device", line: say[String(d.action)] ?? name, unset: false };
    }
    case "home.lights": {
      if (!d.area) return { title: "Room lights", line: "Pick a room", unset: true };
      const room = home?.areas.find((a) => a.id === d.area)?.name ?? (String(d.name ?? "") || "A room");
      return { title: "Room lights", line: `Turn ${d.on === false ? "off" : "on"} the ${room} lights`, unset: false };
    }
    case "home.music": {
      if (!d.entity) return { title: "Music", line: "Pick a speaker", unset: true };
      const where = called(home, d, "a speaker");
      const what = d.uri ? String(d.label || "what you picked") : String(d.query ?? "").trim() ? `some ${String(d.query).trim()}` : "some music";
      return { title: "Music", line: `Play ${what} on ${where}`, unset: false };
    }
    case "flow.delay":
      return { title: "Wait", line: `Wait ${waitWords(Number(d.seconds ?? 5))}`, unset: false };
    case "control.home_state": {
      if (!d.entity) return { title: "Only if", line: "Pick a device to check", unset: true };
      const { on, off } = stateChoice(entityOf(home, d));
      return { title: "Only if", line: `${called(home, d, "A device")} ${d.state === "off" ? off : on}`, unset: false };
    }
    case "control.time":
      return { title: "Only if", line: `It's between ${clock(String(d.start ?? "18:00"))} and ${clock(String(d.end ?? "23:00"))}, ${daysWords(d.days as number[])}`, unset: false };
    default:
      return { title: "Step", line: node.type, unset: false };
  }
}

export function newStep(kind: StepKind, id: string, position: { x: number; y: number }): FlowNode {
  const data: Record<StepKind, Record<string, unknown>> = {
    "home.device": { box: "", entity: "", name: "", action: "turn_on", value: null },
    "home.lights": { box: "", area: "", name: "", on: true },
    "home.music": { box: "", entity: "", name: "", uri: "", label: "", query: "", shuffle: false, volume: null },
    "flow.delay": { seconds: 60 },
    "control.home_state": { box: "", entity: "", name: "", state: "on" },
    "control.time": { start: "18:00", end: "23:00", days: [] },
  };
  return { id, type: kind, position, data: data[kind] };
}

export function isCheck(type: string | undefined): boolean {
  return type === "control.home_state" || type === "control.time";
}

/** How a run went, in a few words, for the list. */
export function runWords(run: AutomationRun | null): { words: string; tone: "ok" | "warn" | "bad" | "quiet" } {
  if (!run) return { words: "Hasn't run yet", tone: "quiet" };
  const how: Record<string, string> = { manual: "run by hand", phrase: "asked for", schedule: "on time", device: "started by a device" };
  const when = run.started_at ? agoWords(new Date(run.started_at)) : "";
  const tail = [when, how[run.trigger]].filter(Boolean).join(", ");
  if (run.status === "success") return { words: `Worked ${tail}`.trim(), tone: "ok" };
  if (run.status === "warning") return { words: `Part of it didn't work ${tail}`.trim(), tone: "warn" };
  if (run.status === "failed") return { words: `Didn't work ${tail}`.trim(), tone: "bad" };
  return { words: "Running now", tone: "quiet" };
}

export function agoWords(then: Date, now: Date = new Date()): string {
  const mins = Math.round((now.getTime() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Devices grouped by room, for a picker. */
export function byRoom(home: Home, keep: (e: HomeEntity) => boolean): { room: string; list: HomeEntity[] }[] {
  const names = new Map(home.areas.map((a) => [a.id, a.name]));
  const groups = new Map<string, HomeEntity[]>();
  for (const e of home.entities) {
    if (!keep(e)) continue;
    const room = (e.area && names.get(e.area)) || "No room yet";
    groups.set(room, [...(groups.get(room) ?? []), e]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "No room yet" ? 1 : b === "No room yet" ? -1 : a.localeCompare(b)))
    .map(([room, list]) => ({ room, list: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}
