import { describe, expect, it } from "vitest";

import type { Home, HomeEntity } from "@/api/home";

import { tidy } from "./layout";
import { actionsFor, agoWords, canBeStep, clock, daysWords, fromSchedule, runWords, stepWords, toSchedule, waitWords } from "./steps";

const e = (more: Partial<HomeEntity>): HomeEntity => ({ id: "light.lamp", box_id: "b1", domain: "light", name: "Floor lamp", state: "off", online: true, can_switch: true, careful: false, ...more });
const lamp = e({});
const speaker = e({ id: "media_player.k", domain: "media_player", name: "Kitchen speaker", x: { can: ["play", "pause", "vol", "preset"] } });
const door = e({ id: "binary_sensor.door", domain: "binary_sensor", name: "Front door", cls: "door" });
const lock = e({ id: "lock.front", domain: "lock", name: "Front lock", careful: true });
const home = { id: "h", name: "Home", role: "owner", members: [], rev: 0, boxes: [], areas: [{ id: "kitchen", name: "Kitchen" }], entities: [lamp, speaker, door, lock] } as unknown as Home;
const node = (type: string, data: Record<string, unknown>) => ({ id: "n", type, position: { x: 0, y: 0 }, data });

describe("a step in words", () => {
  it("says what each step does, with the device's name as it is now", () => {
    expect(stepWords(node("home.device", { box: "b1", entity: "light.lamp", name: "Old name", action: "turn_on" }), home).line).toBe("Turn on Floor lamp");
    expect(stepWords(node("home.device", { box: "b1", entity: "light.lamp", action: "set", value: { bri: 30, k: 2700 } }), home).line).toBe("Set Floor lamp to 30%, warm white");
    expect(stepWords(node("home.device", { box: "b1", entity: "media_player.k", action: "volume", value: 25 }), home).line).toBe("Kitchen speaker: volume 25");
    expect(stepWords(node("home.device", { box: "b1", entity: "media_player.k", action: "mute", value: false }), home).line).toBe("Unmute Kitchen speaker");
    expect(stepWords(node("home.lights", { box: "b1", area: "kitchen", on: false }), home).line).toBe("Turn off the Kitchen lights");
    expect(stepWords(node("home.music", { box: "b1", entity: "media_player.k", query: "jazz" }), home).line).toBe("Play some jazz on Kitchen speaker");
    expect(stepWords(node("home.music", { box: "b1", entity: "media_player.k", query: "" }), home).line).toBe("Play some music on Kitchen speaker");
    expect(stepWords(node("home.music", { box: "b1", entity: "media_player.k", uri: "x://album/1", label: "Kind of Blue by Miles Davis" }), home).line).toBe("Play Kind of Blue by Miles Davis on Kitchen speaker");
    expect(stepWords(node("flow.delay", { seconds: 90 }), home).line).toBe("Wait 90 seconds");
    expect(stepWords(node("flow.delay", { seconds: 600 }), home).line).toBe("Wait 10 minutes");
  });

  it("says how it starts and what a check asks", () => {
    expect(stepWords(node("trigger.manual", {}), home).line).toMatch(/Someone asks/);
    expect(stepWords(node("trigger.schedule", toSchedule({ time: "06:30", days: [0, 1, 2, 3, 4] })), home).line).toBe("It's 6:30 am, weekdays");
    expect(stepWords(node("trigger.schedule", toSchedule({ time: "19:05", days: [] })), home).line).toBe("It's 7:05 pm, every day");
    expect(stepWords(node("trigger.home_state", { box: "b1", entity: "binary_sensor.door", state: "on" }), home).line).toBe("Front door opens");
    expect(stepWords(node("trigger.home_state", { box: "b1", entity: "media_player.k", state: "off" }), home).line).toBe("Kitchen speaker stops playing");
    expect(stepWords(node("control.home_state", { box: "b1", entity: "media_player.k", state: "on" }), home).line).toBe("Kitchen speaker is playing");
    expect(stepWords(node("control.time", { start: "22:00", end: "06:00", days: [5, 6] }), home).line).toBe("It's between 10:00 pm and 6:00 am, weekends");
  });

  it("marks a step that isn't filled in, and keeps a gone device's old name", () => {
    expect(stepWords(node("home.device", { box: "", entity: "" }), home)).toMatchObject({ line: "Pick a device", unset: true });
    expect(stepWords(node("home.music", { entity: "" }), home).unset).toBe(true);
    expect(stepWords(node("home.device", { box: "b1", entity: "light.gone", name: "Hall light", action: "turn_off" }), home).line).toBe("Turn off Hall light");
  });
});

describe("what a step may hold", () => {
  it("never a lock, and only what the device says it can do", () => {
    expect(canBeStep(lamp)).toBe(true);
    expect(canBeStep(lock)).toBe(false);
    expect(canBeStep(door)).toBe(false);
    expect(actionsFor(speaker).map((a) => a.name)).toEqual(["Play", "Pause", "Set volume", "Play a saved preset"]);
    expect(actionsFor(lamp).map((a) => a.action)).toEqual(["turn_on", "turn_off", "set", "toggle"]);
    expect(actionsFor(e({ domain: "scene" })).map((a) => a.action)).toEqual(["run"]);
  });
});

describe("times and days", () => {
  it("round-trips a schedule", () => {
    expect(toSchedule({ time: "07:00", days: [] })).toMatchObject({ frequency: "daily", hour: 7, minute: 0, weekdays: null });
    expect(toSchedule({ time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] })).toMatchObject({ frequency: "daily" });
    const weekly = toSchedule({ time: "18:45", days: [5, 2] });
    expect(weekly).toMatchObject({ frequency: "weekly", hour: 18, minute: 45, weekdays: [2, 5] });
    expect(fromSchedule(weekly)).toEqual({ time: "18:45", days: [2, 5] });
    expect(fromSchedule({ frequency: "daily", hour: 6, minute: 5 })).toEqual({ time: "06:05", days: [] });
  });

  it("says them plainly", () => {
    expect(clock("00:05")).toBe("12:05 am");
    expect(clock("12:00")).toBe("12:00 pm");
    expect(daysWords([1, 3])).toBe("Tue, Thu");
    expect(waitWords(1)).toBe("1 second");
    expect(waitWords(60)).toBe("1 minute");
    const now = new Date("2026-11-18T10:00:00Z");
    expect(agoWords(new Date("2026-11-18T09:59:40Z"), now)).toBe("just now");
    expect(agoWords(new Date("2026-11-18T07:00:00Z"), now)).toBe("3 hours ago");
    expect(agoWords(new Date("2026-11-17T09:00:00Z"), now)).toBe("yesterday");
    expect(runWords(null)).toEqual({ words: "Hasn't run yet", tone: "quiet" });
    expect(runWords({ id: "r", status: "warning", trigger: "phrase", started_at: null, finished_at: null, error: null })).toEqual({ words: "Part of it didn't work asked for", tone: "warn" });
  });
});

describe("laying a flow out", () => {
  const n = (id: string, type = "home.device") => ({ id, type, position: { x: 99, y: 99 } });

  it("puts each step under the one before it", () => {
    const out = tidy([n("t", "trigger.manual"), n("a"), n("b")], [{ source: "t", target: "a" }, { source: "a", target: "b" }]);
    expect(out.map((x) => x.position)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 130 }, { x: 0, y: 260 }]);
  });

  it("puts a check's Yes to the left of its No, and loose steps underneath", () => {
    const out = tidy(
      [n("t", "trigger.manual"), n("c", "control.time"), n("no"), n("yes"), n("loose")],
      [{ source: "t", target: "c" }, { source: "c", target: "no", sourceHandle: "false" }, { source: "c", target: "yes", sourceHandle: "true" }],
    );
    const at = Object.fromEntries(out.map((x) => [x.id, x.position]));
    expect(at.yes.x).toBeLessThan(at.no.x);
    expect(at.yes.y).toBe(260);
    expect(at.c.x).toBe((at.yes.x + at.no.x) / 2);
    expect(at.t.x).toBe(0);
    expect(at.loose.y).toBeGreaterThan(at.yes.y);
  });

  it("doesn't hang on a loop", () => {
    const out = tidy([n("t", "trigger.manual"), n("a"), n("b")], [{ source: "t", target: "a" }, { source: "a", target: "b" }, { source: "b", target: "a" }]);
    expect(out).toHaveLength(3);
  });
});
