import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Home, HomeEntity } from "@/api/home";

import { Board } from "./Board";
import {
  added,
  changed,
  DEFAULT,
  gone,
  itemsOf,
  MAX_ITEMS,
  MAX_WIDGETS,
  move,
  nameOf,
  newId,
  nextSize,
  nudge,
  pickable,
  resized,
  restRooms,
  roomsOf,
  sizesOf,
  speakerFor,
  startingLayout,
  tidy,
  without,
  type Widget,
} from "./layout";
import { groupSwitches } from "./widgets";

const entity = (over: Partial<HomeEntity>): HomeEntity => ({ id: "light.a", box_id: "b1", domain: "light", name: "A", state: "on", online: true, can_switch: true, careful: false, ...over });

const LAMP = entity({ id: "light.lamp", name: "Lamp", state: "on", bri: 40, area: "lounge", x: { modes: ["brightness"] } });
const STRIP = entity({ id: "light.strip", name: "Strip", state: "off", area: "lounge", x: { modes: ["onoff"] } });
const KETTLE = entity({ id: "switch.kettle", domain: "switch", name: "Kettle", state: "off", area: "kitchen" });
const TEMP = entity({ id: "sensor.temp", domain: "sensor", name: "Temperature", state: "21.5", unit: "°C", cls: "temperature", area: "lounge", can_switch: false });
const COSY = entity({ id: "scene.cosy", domain: "scene", name: "Cosy", state: "", area: "lounge", can_switch: false });
const MOVIE = entity({ id: "scene.movie", domain: "scene", name: "Movie night", state: "", area: "lounge", can_switch: false });
const SPEAKER = entity({ id: "media_player.kitchen", domain: "media_player", cls: "speaker", name: "Kitchen speaker", state: "playing", area: "kitchen", can_switch: false, x: { vol: 30, title: "A song", artist: "A band", can: ["pause", "play", "next", "prev", "vol"] } });
const STUDY = entity({ id: "media_player.study", domain: "media_player", cls: "speaker", name: "Study speaker", state: "idle", can_switch: false, x: { vol: 10, can: ["play", "vol"] } });
const TV = entity({ id: "media_player.tv", domain: "media_player", cls: "tv", name: "TV", state: "off", area: "lounge", can_switch: false });
const DOOR = entity({ id: "lock.front", domain: "lock", name: "Front door", state: "locked", can_switch: false, careful: true });
const GARAGE = entity({ id: "cover.garage", domain: "cover", cls: "garage", name: "Garage", state: "closed", can_switch: false, careful: true, x: { pos: 0, can: ["open", "close", "pos"] } });
const AC = entity({ id: "climate.ac", domain: "climate", name: "Air con", state: "cool", area: "lounge", can_switch: false, x: { target: 23, cur: 26 } });
const ALL = [LAMP, STRIP, KETTLE, TEMP, COSY, MOVIE, SPEAKER, STUDY, TV, DOOR, GARAGE, AC];
const HOME: Home = {
  id: "h1", name: "Home", role: "member", can_manage: false, members: [], rev: 1, boxes: [],
  // The order set under Rooms: kitchen first. "Hall" has nothing in it.
  areas: [{ id: "kitchen", name: "Kitchen" }, { id: "lounge", name: "Lounge" }, { id: "hall", name: "Hall" }],
  entities: ALL,
};
const k = (e: HomeEntity) => `${e.box_id}/${e.id}`;
const w = (over: Partial<Widget> & Pick<Widget, "type">): Widget => ({ id: over.id ?? newId(), size: "m", ...over });

describe("a layout", () => {
  it("is, until it's customised, the page as it always was: every room in the Rooms order, no room last", () => {
    expect(DEFAULT).toEqual([{ id: "rest", type: "rest", size: "l" }]);
    expect(restRooms(HOME, DEFAULT).map((r) => r.name)).toEqual(["Kitchen", "Lounge", "Not in a room yet"]);
    expect(roomsOf(HOME).find((r) => r.id === "")!.list.map((e) => e.name)).toEqual(["Study speaker", "Front door", "Garage"]);
  });

  it("starts customising from the same page: a widget a room, then everything else", () => {
    const start = startingLayout(HOME);
    expect(start.map((x) => [x.type, x.area, x.size])).toEqual([["room", "kitchen", "l"], ["room", "lounge", "l"], ["rest", undefined, "l"]]);
    expect(new Set(start.map((x) => x.id)).size).toBe(3);
    // Everything else now holds only what has no widget: here, what isn't in a room.
    expect(restRooms(HOME, start).map((r) => r.id)).toEqual([""]);
    // A room made later shows up there by itself.
    const later: Home = { ...HOME, areas: [...HOME.areas, { id: "shed", name: "Shed" }], entities: [...ALL, entity({ id: "light.shed", name: "Shed light", area: "shed" })] };
    expect(restRooms(later, start).map((r) => r.name)).toEqual(["Shed", "Not in a room yet"]);
  });

  it("moves, sizes, adds and removes without touching the layout it was given", () => {
    const a = w({ id: "a", type: "device", size: "s", key: k(LAMP) });
    const b = w({ id: "b", type: "room", size: "l", area: "lounge" });
    const c = w({ id: "c", type: "rest", size: "l" });
    const list = [a, b, c];
    expect(move(list, "c", "a").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(move(list, "a", "c").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(move(list, "a", "a")).toBe(list);
    expect(move(list, "nope", "a")).toBe(list);
    expect(nudge(list, "b", -1).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(nudge(list, "a", -1)).toBe(list);
    expect(nudge(list, "c", 1)).toBe(list);
    expect(without(list, "b").map((x) => x.id)).toEqual(["a", "c"]);
    expect(resized(list, "a")[0].size).toBe("m");
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(list[0].size).toBe("s");
    // A new widget goes before "everything else", so it isn't lost under every room.
    const more = added(list, { type: "music", size: "m" });
    expect(more.map((x) => x.type)).toEqual(["device", "room", "music", "rest"]);
    expect(new Set(more.map((x) => x.id)).size).toBe(4);
    expect(added([a], { type: "music", size: "m" }).map((x) => x.type)).toEqual(["device", "music"]);
    // ...and a full page takes no more.
    const full = Array.from({ length: MAX_WIDGETS }, (_, i) => w({ id: `w${i}`, type: "device" }));
    expect(added(full, { type: "music", size: "m" })).toBe(full);
  });

  it("gives each kind the sizes that make sense for it", () => {
    expect(sizesOf({ type: "device" })).toEqual(["s", "m", "l"]);
    expect(sizesOf({ type: "room" })).toEqual(["m", "l"]);
    expect(sizesOf({ type: "rest" })).toEqual(["l"]);
    expect(sizesOf({ type: "scenes", items: ["x"] })).toEqual(["s", "m", "l"]);
    expect(sizesOf({ type: "scenes", items: ["x", "y"] })).toEqual(["m", "l"]);
    expect(nextSize(w({ type: "device", size: "l" }))).toBe("s");
    expect(nextSize(w({ type: "room", size: "m" }))).toBe("l");
    expect(nextSize(w({ type: "rest", size: "l" }))).toBe("l");
    // One scene as a small button, then a second is ticked: it can't stay small.
    const one = w({ id: "s", type: "scenes", size: "s", items: [k(COSY)] });
    expect(changed([one], "s", { items: [k(COSY), k(MOVIE)] })[0].size).toBe("m");
    expect(changed([one], "s", { title: "Evening" })[0]).toMatchObject({ size: "s", title: "Evening" });
  });

  it("draws nothing it doesn't know from what the server kept", () => {
    expect(tidy(null)).toBeNull();
    expect(tidy(undefined)).toBeNull();
    expect(tidy("nope")).toBeNull();
    expect(tidy([])).toEqual([]);
    const got = tidy([
      { id: "a", type: "device", size: "s", key: "b1/light.lamp", title: "Lamp", html: "<b>" },
      { id: "a", type: "music", size: "m" }, // the same id again
      { id: "b", type: "clock", size: "s" }, // a kind there isn't (a newer or older app)
      { id: "c", type: "rest", size: "s" }, // a size it can't be
      { id: "d", type: "room", size: "huge", area: "lounge" },
      { id: "e", type: "group", size: "m", items: ["x", 3, null, "y"], title: 7 },
      { type: "music", size: "m" },
      null,
      "x",
    ]);
    expect(got).toEqual([
      { id: "a", type: "device", size: "s", key: "b1/light.lamp", title: "Lamp" },
      { id: "c", type: "rest", size: "l" },
      { id: "d", type: "room", size: "m", area: "lounge" },
      { id: "e", type: "group", size: "m", items: ["x", "y"] },
    ]);
    expect(tidy(Array.from({ length: 80 }, (_, i) => ({ id: `w${i}`, type: "music", size: "m" })))!.length).toBe(MAX_WIDGETS);
    expect(tidy([{ id: "g", type: "group", size: "m", items: Array.from({ length: 90 }, (_, i) => `k${i}`) }])![0].items!.length).toBe(MAX_ITEMS);
  });

  it("knows when what a widget shows has left the home, and never says so while the home has nothing to show yet", () => {
    const lamp = w({ type: "device", key: k(LAMP), title: "Lamp" });
    const old = w({ type: "device", key: "b1/light.sold", title: "Old lamp" });
    const elsewhere = w({ type: "device", key: "another-box/light.lamp", title: "Theirs" });
    expect(gone(HOME, lamp)).toBe(false);
    expect(gone(HOME, old)).toBe(true);
    expect(gone(HOME, elsewhere)).toBe(true);
    expect(nameOf(HOME, old)).toBe("Old lamp");
    expect(nameOf(HOME, lamp)).toBe("Lamp");
    expect(gone(HOME, w({ type: "room", area: "lounge" }))).toBe(false);
    expect(gone(HOME, w({ type: "room", area: "" }))).toBe(false);
    expect(gone(HOME, w({ type: "room", area: "hall" }))).toBe(false); // empty, not gone
    expect(gone(HOME, w({ type: "room", area: "attic", title: "Attic" }))).toBe(true);
    expect(nameOf(HOME, w({ type: "room", area: "attic", title: "Attic" }))).toBe("Attic");
    expect(gone(HOME, w({ type: "group", items: ["b1/light.sold"] }))).toBe(true);
    expect(gone(HOME, w({ type: "group", items: ["b1/light.sold", k(LAMP)] }))).toBe(false);
    expect(gone(HOME, w({ type: "group", items: [] }))).toBe(false);
    expect(gone(HOME, w({ type: "music" }))).toBe(false);
    expect(gone(HOME, w({ type: "rest" }))).toBe(false);
    // Its box is still starting: nothing is "gone".
    const starting: Home = { ...HOME, areas: [], entities: [] };
    for (const one of [lamp, old, w({ type: "room", area: "attic" }), w({ type: "group", items: ["b1/light.sold"] })]) expect(gone(starting, one)).toBe(false);
  });

  it("keeps a group's devices in the order picked, and its one switch away from anything that asks first", () => {
    const g = w({ type: "group", items: [k(KETTLE), "b1/light.sold", k(LAMP), k(DOOR), k(GARAGE), k(TEMP)] });
    const list = itemsOf(HOME, g);
    expect(list.map((e) => e.name)).toEqual(["Kettle", "Lamp", "Front door", "Garage", "Temperature"]);
    expect(groupSwitches(list).map((e) => e.name)).toEqual(["Kettle", "Lamp"]);
    expect(groupSwitches([entity({ careful: true }), entity({ online: false }), entity({ state: "unavailable" })])).toEqual([]);
  });

  it("offers devices and readings to pick, never scenes; and music the speakers, never the TV", () => {
    const names = pickable(HOME).map((e) => e.name);
    expect(names).toContain("Temperature");
    expect(names).toContain("Front door");
    expect(names).not.toContain("Cosy");
    expect(speakerFor(HOME, {})?.name).toBe("Kitchen speaker"); // the one that's playing
    expect(speakerFor(HOME, { key: k(STUDY) })?.name).toBe("Study speaker"); // the one picked
    expect(speakerFor(HOME, { key: "b1/media_player.sold" })?.name).toBe("Kitchen speaker");
    expect(speakerFor({ entities: [TV] }, {})).toBeNull();
  });
});

describe("the page", () => {
  const draw = (widgets: Widget[] | null, home: Home = HOME) => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(["home", "layout", home.id], widgets);
    return renderToStaticMarkup(<QueryClientProvider client={qc}><Board home={home} onOpen={() => undefined} onSort={() => undefined} /></QueryClientProvider>);
  };
  const order = (html: string, ...words: string[]) => words.map((x) => html.indexOf(x));
  const rising = (at: number[]) => at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]));

  it("shows someone who never customised exactly the rooms they had", () => {
    const html = draw(null);
    expect(rising(order(html, 'aria-label="Kitchen"', 'aria-label="Lounge"', 'aria-label="Not in a room yet"'))).toBe(true);
    expect(html).toContain("All lights on"); // the lounge's two lights
    expect(html).toContain("Lounge scenes");
    expect(html).toContain("Lounge readings");
    expect(html).not.toContain("Customising your page"); // only once the header's button is pressed
    expect(html).not.toContain("no longer in this home");
  });

  it("draws their own order, and each room only once", () => {
    const html = draw([
      w({ id: "m", type: "music" }),
      w({ id: "l", type: "room", size: "l", area: "lounge" }),
      w({ id: "d", type: "device", size: "m", key: k(LAMP) }),
      w({ id: "r", type: "rest", size: "l" }),
    ]);
    expect(rising(order(html, 'aria-label="Music"', 'aria-label="Lounge"', 'aria-label="Kitchen"', 'aria-label="Not in a room yet"'))).toBe(true);
    expect(html.split('<section aria-label="Lounge"').length - 1).toBe(1);
    // The lamp at medium size has its brightness under it; music shows what's playing and its buttons.
    expect(html).toContain("Brightness");
    expect(html).toContain("A song");
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-label="Speaker"'); // two speakers: a choice
    expect(html).not.toContain(">TV</option>"); // not a speaker to pick
  });

  it("keeps a lock and a garage door as tiles that open their controls, whatever size they're given", () => {
    const html = draw([w({ id: "a", type: "device", size: "l", key: k(DOOR) }), w({ id: "b", type: "device", size: "l", key: k(GARAGE) })]);
    expect(html).toContain('aria-label="Front door, Locked"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("How far open");
    // ...and a group's one switch isn't offered when only one thing in it can be switched.
    const group = draw([w({ id: "g", type: "group", title: "By the door", items: [k(DOOR), k(GARAGE), k(KETTLE)] })]);
    expect(group).toContain('aria-label="By the door"');
    expect(group).not.toContain("Everything in By the door");
  });

  it("says when a widget's device is no longer in this home, with a way to take it off", () => {
    const html = draw([w({ id: "x", type: "device", size: "s", key: "another-box/light.lamp", title: "Old lamp" }), w({ id: "y", type: "room", size: "l", area: "attic", title: "Attic" })]);
    expect(html).toContain("Old lamp");
    expect(html).toContain("This device is no longer in this home.");
    expect(html).toContain("This room is no longer in this home.");
    expect(html.split(">Remove<").length - 1).toBe(2);
    // While the home's box is starting there's nothing to say.
    expect(draw([w({ id: "x", type: "device", size: "s", key: k(LAMP) })], { ...HOME, areas: [], entities: [] })).not.toContain("no longer");
  });

  it("an air con widget reads out the room, and a reading its value", () => {
    const html = draw([w({ id: "a", type: "device", size: "m", key: k(AC) }), w({ id: "t", type: "device", size: "m", key: k(TEMP) })]);
    expect(html).toContain("26 degrees now");
    expect(html).toContain("set to 23°");
    expect(html).toContain("21.5 °C");
  });

  it("a page with everything taken off says so instead of showing nothing", () => {
    expect(draw([])).toContain("Your page has nothing on it");
  });
});
