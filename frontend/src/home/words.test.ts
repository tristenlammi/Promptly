import { describe, expect, it } from "vitest";

import type { HomeEntity } from "@/api/home";

import { looseDevices } from "./SortSheet";
import { addedLine, countWords, musicSummary, noteLine, sameRoom, stateWords } from "./words";

const entity = (over: Partial<HomeEntity>): HomeEntity => ({ id: "light.a", box_id: "b1", domain: "light", name: "A", state: "on", online: true, can_switch: true, careful: false, ...over });

describe("what Home says", () => {
  it("sums up what a brand brought in one line, by room", () => {
    // The owner's Hue bridge: one lamp, already in the room Hue knows it by.
    expect(addedLine("Philips Hue", [{ n: 1, kind: "light", room: "Lounge Room" }])).toBe("Added Philips Hue: 1 light in Lounge Room.");
    expect(addedLine("Philips Hue", [{ n: 4, kind: "light", room: "Kitchen" }, { n: 2, kind: "light", room: "Lounge Room" }, { n: 1, kind: "switch", room: "" }])).toBe(
      "Added Philips Hue: 4 lights in Kitchen, 2 lights in Lounge Room and 1 plug or switch with no room yet.",
    );
    expect(addedLine("Google Cast", [{ n: 3, kind: "media_player", room: "" }])).toBe("Added Google Cast: 3 speakers and TVs with no room yet.");
    // Nothing to show yet (it's still arriving): no numbers made up.
    expect(addedLine("Shelly", [])).toBe("Added Shelly. What it brings will show on your Home page in a moment.");
    expect(countWords("teapot", 2)).toBe("2 devices");
  });

  it("says once what had joined on its own", () => {
    expect(noteLine({ n: 3, what: "speakers", brands: ["Google Cast"] })).toBe(
      "3 speakers (Google Cast) that appeared on their own are waiting under Add a device → Found on your network. Nothing joins your home unless you add it.",
    );
    expect(noteLine({ n: 1, what: "devices", brands: [] })).toContain("1 device that appeared on its own is waiting");
  });

  it("only calls two rooms the same when the name is the same", () => {
    expect(sameRoom("Lounge Room", "lounge  room")).toBe(true);
    expect(sameRoom("Lounge Room", "LoungeRoom")).toBe(true);
    expect(sameRoom("Lounge Room", "Living Room")).toBe(false);
    expect(sameRoom("", "")).toBe(false);
  });

  it("calls an idle speaker not playing, not off", () => {
    const speaker = entity({ id: "media_player.kitchen", domain: "media_player", name: "Kitchen Speaker", can_switch: false });
    expect(stateWords({ ...speaker, state: "off" })).toBe("Not playing");
    expect(stateWords({ ...speaker, state: "idle" })).toBe("Not playing");
    expect(stateWords({ ...speaker, state: "playing", x: { title: "Morning Mix" } })).toBe("Playing · Morning Mix");
    expect(stateWords({ ...speaker, state: "paused" })).toBe("Paused");
    expect(stateWords({ ...speaker, state: "unavailable" })).toBe("Not responding");
  });
});

describe("sorting into rooms", () => {
  it("lists each device with no room once, however many parts it has", () => {
    const loose = looseDevices([
      entity({ id: "sensor.plug_power", domain: "sensor", name: "Plug power", dev: "d1" }),
      entity({ id: "switch.plug", domain: "switch", name: "Desk plug", dev: "d1" }),
      entity({ id: "media_player.kitchen", domain: "media_player", name: "Kitchen Speaker", dev: "d2" }),
      entity({ id: "light.lamp", name: "Lamp", dev: "d3", area: "lounge" }),
      entity({ id: "input_boolean.guest", domain: "input_boolean", name: "Guest mode" }),
    ]);
    expect(loose.map((l) => [l.name, l.entities])).toEqual([
      ["Desk plug", ["sensor.plug_power", "switch.plug"]],
      ["Guest mode", ["input_boolean.guest"]],
      ["Kitchen Speaker", ["media_player.kitchen"]],
    ]);
  });

  it("says which speakers can play music by name", () => {
    expect(musicSummary([], 0)).toBe("This home has no speakers yet. Add one with Add a device on your Home page.");
    expect(musicSummary([], 2)).toContain("None of this home's speakers can play music by name yet");
    expect(musicSummary(["Lounge"], 1)).toBe("Plays on: Lounge.");
    expect(musicSummary(["Study", "Lounge"], 2)).toBe("Plays on: Lounge and Study.");
    expect(musicSummary(["Study", "Lounge", "Kitchen"], 4)).toBe("Plays on: Kitchen, Lounge and Study. Your other speakers can still be paused, skipped and turned up or down.");
  });
});
