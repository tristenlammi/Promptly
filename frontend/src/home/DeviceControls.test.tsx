import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Home, HomeEntity } from "@/api/home";

import { ClimateControls, MediaControls, VacuumControls } from "./DeviceControls";
import { byKind, can, groupable, isTile, lit, stepTemp, tapSwitches, unitOf, ventOf, zonesOf } from "./kinds";
import { countWords, fanWord, modeWord, stateWords } from "./words";

const entity = (over: Partial<HomeEntity>): HomeEntity => ({ id: "light.a", box_id: "b1", domain: "light", name: "A", state: "on", online: true, can_switch: false, careful: false, ...over });

// An AirTouch 5 as the box sends it: one unit, a zone per room, a vent per zone.
const AC = entity({ id: "climate.ac_0", domain: "climate", name: "AC 0", state: "cool", dev: "d-ac", x: { target: 23, cur: 26, min: 16, max: 30, step: 1, modes: ["off", "auto", "cool", "dry", "fan_only", "heat"], fans: ["low", "medium", "high", "auto", "intelligent_auto"], fan: "auto", last: "cool", can: ["temp", "fan", "off", "on"], sys: "climate.ac_0" } });
const BED = entity({ id: "climate.bedroom", domain: "climate", name: "Bedroom", state: "fan_only", area: "bed", dev: "d-bed", x: { target: 22, cur: 24, min: 16, max: 30, step: 1, modes: ["off", "fan_only"], can: ["temp", "off", "on"], sys: "climate.ac_0", zone: true } });
const STUDY = entity({ id: "climate.study", domain: "climate", name: "Study", state: "off", dev: "d-study", x: { modes: ["off", "fan_only"], can: ["temp", "off", "on"], sys: "climate.ac_0", zone: true } });
const BED_VENT = entity({ id: "cover.bedroom_damper", domain: "cover", cls: "damper", name: "Bedroom Damper", state: "open", dev: "d-bed", x: { pos: 60, can: ["open", "close", "pos"] } });
const STUDY_VENT = entity({ id: "cover.study_damper", domain: "cover", cls: "damper", name: "Study Damper", state: "closed", dev: "d-study", x: { pos: 0, can: ["open", "close", "pos"] } });
const HEATER = entity({ id: "climate.heater", domain: "climate", name: "Heater", state: "off", x: { target: 20, modes: ["off", "heat"], can: ["temp"] } });
// A WiiM speaker playing, another idle, and a TV.
const KITCHEN = entity({ id: "media_player.kitchen", domain: "media_player", cls: "speaker", name: "Kitchen", state: "playing", x: { vol: 30, muted: false, title: "Song", artist: "Band", src: "Wi-Fi", srcs: ["Wi-Fi", "Line In"], members: ["media_player.kitchen", "media_player.lounge"], can: ["pause", "vol", "mute", "next", "src", "stop", "play", "group"] } });
const LOUNGE = entity({ id: "media_player.lounge", domain: "media_player", cls: "speaker", name: "Lounge", state: "idle", x: { vol: 20, can: ["pause", "vol", "play", "group"] } });
const TV = entity({ id: "media_player.tv", domain: "media_player", cls: "tv", name: "TV", state: "off", x: { vol: 10, srcs: ["HDMI 1"], can: ["on", "off", "vol", "src"] } });
const ROBOT = entity({ id: "vacuum.robot", domain: "vacuum", name: "Robot", state: "docked", x: { bat: 90, can: ["start", "dock", "pause"] } });
const ALL = [AC, BED, STUDY, BED_VENT, STUDY_VENT, HEATER, KITCHEN, LOUNGE, TV, ROBOT];
const HOME: Home = { id: "h1", name: "Home", role: "owner", can_manage: true, members: [], rev: 1, boxes: [], areas: [{ id: "bed", name: "Main bedroom" }], entities: ALL };

const draw = (el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);
const noop = () => undefined;

describe("every kind of device", () => {
  it("knows a ducted air con's zones from its unit, and a zone's vent", () => {
    expect(zonesOf(ALL, AC).map((z) => z.id)).toEqual(["climate.bedroom", "climate.study"]);
    expect(unitOf(ALL, BED)?.id).toBe("climate.ac_0");
    expect(unitOf(ALL, HEATER)).toBeNull();
    expect(zonesOf(ALL, HEATER)).toEqual([]);
    expect(ventOf(ALL, BED)?.id).toBe("cover.bedroom_damper");
    // A vent is part of its zone, not a tile of its own. An ordinary blind still is.
    expect(isTile(BED_VENT, ALL)).toBe(false);
    expect(isTile(entity({ id: "cover.blind", domain: "cover", cls: "blind", dev: "d-x" }), ALL)).toBe(true);
    expect(isTile(entity({ id: "scene.movie", domain: "scene" }), ALL)).toBe(false);
    expect(isTile(entity({ id: "sensor.t", domain: "sensor" }), ALL)).toBe(false);
    expect(isTile(entity({ id: "lawn_mower.back", domain: "lawn_mower" }), ALL)).toBe(true);
  });

  it("puts lights first, a unit before its zones, and what it doesn't know last", () => {
    const mower = entity({ id: "lawn_mower.back", domain: "lawn_mower", name: "Mower" });
    const lamp = entity({ id: "light.lamp", name: "Lamp" });
    expect([mower, ROBOT, STUDY, KITCHEN, BED, AC, lamp].sort(byKind).map((e) => e.name)).toEqual(["Lamp", "AC 0", "Bedroom", "Study", "Kitchen", "Robot", "Mower"]);
  });

  it("says what each is doing in plain words", () => {
    expect(stateWords(AC)).toBe("Cool · 23°");
    expect(stateWords({ ...AC, x: { ...AC.x, act: "cooling" } })).toBe("Cooling to 23°");
    expect(stateWords({ ...AC, state: "off" })).toBe("Off");
    expect(stateWords({ ...AC, state: "fan_only" })).toBe("Fan");
    expect(stateWords(BED)).toBe("On · 22°"); // a zone is on or off, never "Fan only"
    expect(stateWords(STUDY)).toBe("Off");
    expect(stateWords(ROBOT)).toBe("Docked · 90%");
    expect(stateWords({ ...ROBOT, state: "returning" })).toBe("Going home");
    expect(stateWords(TV)).toBe("Off");
    expect(stateWords({ ...TV, state: "idle" })).toBe("On");
    expect(stateWords(KITCHEN)).toBe("Playing · Song");
    // A kind with no controls yet: what it says, tidied; a bare timestamp says nothing.
    expect(stateWords(entity({ id: "lawn_mower.back", domain: "lawn_mower", state: "docked" }))).toBe("Docked");
    expect(stateWords(entity({ id: "alarm_control_panel.house", domain: "alarm_control_panel", state: "armed_away" }))).toBe("Armed away");
    expect(stateWords(entity({ id: "scene.x", domain: "whatever", state: "2026-11-16T10:00:00+00:00" }))).toBe("");
    expect([modeWord("fan_only"), modeWord("heat_cool"), fanWord("intelligent_auto"), fanWord("diffuse"), fanWord("Level 3")]).toEqual(["Fan", "Auto", "Smart auto", "Quiet", "Level 3"]);
    expect(stateWords(entity({ id: "sensor.gas", domain: "sensor", state: "0.028316846592", unit: "m³" }))).toBe("0.028 m³");
    expect(stateWords(entity({ id: "sensor.t", domain: "sensor", state: "21.5", unit: "°C" }))).toBe("21.5 °C");
    expect(stateWords(entity({ id: "sensor.mode", domain: "sensor", state: "eco" }))).toBe("Eco");
    expect(countWords("climate", 3)).toBe("3 air con and heaters");
    expect(countWords("vacuum", 1)).toBe("1 robot vacuum");
  });

  it("lights a tile for what is running, and lets a tap switch a zone but not a whole air con", () => {
    expect([lit(AC), lit(STUDY), lit(KITCHEN), lit(LOUNGE), lit(TV), lit({ ...TV, state: "idle" }), lit(ROBOT), lit({ ...ROBOT, state: "cleaning" })]).toEqual([true, false, true, false, false, true, false, true]);
    expect([tapSwitches(BED), tapSwitches(AC), tapSwitches(KITCHEN), tapSwitches(entity({ can_switch: true }))]).toEqual([true, false, false, true]);
  });

  it("only offers what a device says it can do", () => {
    expect([can(KITCHEN, "next"), can(KITCHEN, "prev"), can(TV, "play")]).toEqual([true, false, false]);
    expect(can(entity({ domain: "media_player", x: {} }), "next")).toBe(true); // an older box doesn't say
    expect(groupable(ALL, KITCHEN).map((o) => o.id)).toEqual(["media_player.lounge"]); // not the TV, not itself
    expect(groupable(ALL, TV)).toEqual([]);
    expect([stepTemp(AC.x!, 23, 1), stepTemp(AC.x!, 30, 1), stepTemp(AC.x!, 16, -1), stepTemp({ step: 0.5 }, 20, -1), stepTemp({}, 20, 1)]).toEqual([24, 30, 16, 19.5, 20.5]);
  });

  it("draws an air con: modes, temperature, fan, and its zones with a switch each", () => {
    const html = draw(<ClimateControls home={HOME} e={AC} dead={false} busy={false} go={noop} onOpen={noop} />);
    for (const word of ["Off", "Auto", "Cool", "Dry", "Fan", "Heat", "Set to", "23°", "26° in the room now", "Smart auto", "Zones", "Bedroom", "Study", "Main bedroom"]) expect(html).toContain(word);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Cool</);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Bedroom zone"/);
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Study zone"/);
    expect(html).not.toContain("Turn on (");
    // Off: one button brings back the way it was, by name.
    expect(draw(<ClimateControls home={HOME} e={{ ...AC, state: "off" }} dead={false} busy={false} go={noop} onOpen={noop} />)).toContain("Turn on (Cool, as it was)");
    // A plain heater: no fan, no zones.
    const heater = draw(<ClimateControls home={HOME} e={HEATER} dead={false} busy={false} go={noop} onOpen={noop} />);
    expect(heater).toContain("Heat");
    expect(heater).not.toContain("Zones");
    expect(heater).not.toContain(">Fan<");
  });

  it("draws a zone: on and off, its temperature, its vent and its unit", () => {
    const html = draw(<ClimateControls home={HOME} e={BED} dead={false} busy={false} go={noop} onOpen={noop} />);
    for (const word of [">On<", ">Off<", "22°", "Its vent is 60% open", "Part of AC 0", "Cool · 23°"]) expect(html).toContain(word);
    expect(html).not.toContain("Mode");
    // A zone with no temperature of its own: the vent is what you set.
    const study = draw(<ClimateControls home={HOME} e={STUDY} dead={false} busy={false} go={noop} onOpen={noop} />);
    expect(study).toContain("How far its vent is open");
    expect(study).not.toContain("Set to");
    // On, but the unit is off: say why nothing is happening.
    expect(draw(<ClimateControls home={{ ...HOME, entities: [{ ...AC, state: "off" }, BED] }} e={BED} dead={false} busy={false} go={noop} onOpen={noop} />)).toContain("The air con is off, so nothing is blowing here yet");
  });

  it("draws a speaker with what it can do, and a TV with a power button", () => {
    const html = draw(<MediaControls home={HOME} e={KITCHEN} dead={false} busy={false} go={noop} />);
    for (const word of ["Song", "Band", "From Wi-Fi", 'aria-label="Pause"', 'aria-label="Next"', "Volume", 'aria-label="Mute"', "Playing from", "Line In", "Play together with", "Lounge"]) expect(html).toContain(word);
    expect(html).not.toContain('aria-label="Previous"'); // it didn't say it can
    expect(html).not.toContain(">On<"); // a speaker with no power button
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Play together with Lounge"/);
    const tv = draw(<MediaControls home={HOME} e={TV} dead={false} busy={false} go={noop} />);
    for (const word of [">On<", ">Off<", "Input", "HDMI 1", "Volume"]) expect(tv).toContain(word);
    expect(tv).not.toContain('aria-label="Play"');
    expect(tv).not.toContain("Play together with");
    // From an older box, which doesn't say what it can do: play, pause and volume, as before.
    const old = draw(<MediaControls home={HOME} e={{ ...KITCHEN, state: "paused", x: { vol: 30, title: "Song" } }} dead={false} busy={false} go={noop} />);
    expect(old).toContain('aria-label="Play"');
    expect(old).not.toContain('aria-label="Next"');
  });

  it("draws a vacuum's buttons for where it is", () => {
    const docked = draw(<VacuumControls e={ROBOT} dead={false} busy={false} go={noop} />);
    expect(docked).toContain("Start cleaning");
    expect(docked).toContain("Battery 90%");
    expect(docked).not.toContain("Send home");
    const out = draw(<VacuumControls e={{ ...ROBOT, state: "cleaning" }} dead={false} busy={false} go={noop} />);
    expect(out).toContain("Pause");
    expect(out).toContain("Send home");
    expect(out).not.toContain("Find it"); // it didn't say it can
  });
});
