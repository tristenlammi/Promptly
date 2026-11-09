import { describe, expect, it } from "vitest";

import {
  fromContacts,
  fromSavedPlaces,
  fromSearch,
  keyAction,
  locationText,
  matches,
  mergeSuggestions,
  moveActive,
  nearFrom,
  type SavedPlaceLike,
} from "./locationSuggest";

const places: SavedPlaceLike[] = [
  { id: "f1", kind: "favourite", name: "Oil King Baringa", address: "3 Main Dr, Baringa QLD 4551", lat: -26.81, lon: 153.08 },
  { id: "h1", kind: "home", name: "Home", address: "12 Gum St, Caloundra QLD 4551", lat: -26.8, lon: 153.12 },
  { id: "w1", kind: "work", name: "Work", address: "1 Office Rd, Maroochydore QLD 4558", lat: -26.65, lon: 153.09 },
  { id: "l1", kind: "list", name: "Cafe Bloom", address: null, list_name: "Places to try", lat: -26.7, lon: 153.1 },
];

describe("matching", () => {
  it("needs every word, anywhere, any case", () => {
    expect(matches("oil baringa", "Oil King Baringa")).toBe(true);
    expect(matches("oil caloundra", "Oil King Baringa")).toBe(false);
    expect(matches("", "anything")).toBe(false);
  });

  it("finds saved places by name, address, list and by home / work", () => {
    expect(fromSavedPlaces(places, "oil king").map((s) => s.name)).toEqual(["Oil King Baringa"]);
    expect(fromSavedPlaces(places, "gum st").map((s) => s.kind)).toEqual(["home"]);
    expect(fromSavedPlaces(places, "home").map((s) => s.kind)).toEqual(["home"]);
    expect(fromSavedPlaces(places, "places to try").map((s) => s.name)).toEqual(["Cafe Bloom"]);
  });

  it("puts Home and Work ahead of favourites", () => {
    expect(fromSavedPlaces(places, "qld").map((s) => s.kind)).toEqual(["home", "work", "favourite"]);
  });
});

describe("sources", () => {
  it("keeps only contacts that have an address", () => {
    const got = fromContacts([
      { key: "c:1", name: "Sam", contact: { address: "5 Beach Pde, Kings Beach" } },
      { key: "c:2", name: "Alex", contact: { address: "" } },
      { key: "u:3", name: "Jo", contact: null },
    ]);
    expect(got).toEqual([{ key: "contact:c:1", kind: "contact", name: "Sam", address: "5 Beach Pde, Kings Beach" }]);
  });

  it("calls a named place with an OSM category a business, and keeps addresses", () => {
    const got = fromSearch([
      { kind: "place", name: "Bunnings Caloundra", address: "Caloundra West QLD 4551", category: "hardware", lat: -26.79, lon: 153.07 },
      { kind: "address", name: "64 Example Street", address: "Caloundra QLD 4551", lat: -26.8, lon: 153.13 },
      { kind: "place", name: "Caloundra", address: "QLD", category: null, lat: -26.8, lon: 153.13 },
      { kind: "pin", name: "Dropped pin", lat: 0, lon: 0 },
    ]);
    expect(got.map((s) => s.kind)).toEqual(["business", "address", "place"]);
  });
});

describe("merging", () => {
  const saved = fromSavedPlaces(places, "oil");
  const contacts = fromContacts([{ key: "c:1", name: "Oily Sam", contact: { address: "5 Beach Pde, Kings Beach" } }]);

  it("orders saved places, then contacts, then the map", () => {
    const search = fromSearch([{ kind: "place", name: "Oil Depot", address: "Kawana QLD", category: "fuel", lat: -26.7, lon: 153.12 }]);
    expect(mergeSuggestions(saved, contacts, search).map((s) => s.kind)).toEqual(["favourite", "contact", "business"]);
  });

  it("drops the map's copies of saved places and contacts (find_places merges them too)", () => {
    const search = fromSearch([
      // The same saved place, by id.
      { kind: "favourite", id: "f1", name: "Oil King Baringa", address: "3 Main Dr, Baringa QLD 4551", lat: -26.81, lon: 153.08 },
      // The same contact, geocoded by the server.
      { kind: "contact", name: "Oily Sam", address: "Home: 5 Beach Pde, Kings Beach", lat: -26.8, lon: 153.14 },
      // A recent at the very same spot as the saved place.
      { kind: "recent", name: "Oil King", address: null, lat: -26.81001, lon: 153.08001 },
      // Photon's own row for the same business, a few metres off.
      { kind: "place", name: "Oil King Baringa", address: "3 Main Dr, Baringa QLD 4551", category: "car_repair", lat: -26.8102, lon: 153.0803 },
      { kind: "place", name: "Something else", address: "Kawana", category: "shop", lat: -26.7, lon: 153.12 },
    ]);
    const merged = mergeSuggestions(saved, contacts, search);
    expect(merged.map((s) => s.name)).toEqual(["Oil King Baringa", "Oily Sam", "Something else"]);
    expect(merged[0].kind).toBe("favourite");
  });

  it("caps the list", () => {
    const many = fromSearch(Array.from({ length: 20 }, (_, i) => ({ kind: "address", name: `${i} Long St`, address: "Town", lat: -27 - i / 10, lon: 153 })));
    expect(mergeSuggestions([], [], many)).toHaveLength(8);
    expect(mergeSuggestions([], [], many, 5)).toHaveLength(5);
  });
});

describe("picked text", () => {
  it("is 'Name, short address'", () => {
    expect(locationText({ name: "Bunnings Caloundra", address: "Caloundra West QLD 4551" })).toBe("Bunnings Caloundra, Caloundra West QLD 4551");
    expect(locationText({ name: "Home", address: "12 Gum St, Caloundra QLD 4551" })).toBe("Home, 12 Gum St, Caloundra QLD 4551");
  });

  it("is just the address when the name is the address", () => {
    expect(locationText({ name: "12 Gum St", address: "12 Gum St, Caloundra QLD 4551" })).toBe("12 Gum St, Caloundra QLD 4551");
    expect(locationText({ name: "12 Gum St, Caloundra", address: "12 gum st caloundra" })).toBe("12 gum st caloundra");
  });

  it("is the name alone when there's no address", () => {
    expect(locationText({ name: "Cafe Bloom", address: null })).toBe("Cafe Bloom");
  });
});

describe("keyboard", () => {
  it("moves down and up through the list, wrapping through the typed text (-1)", () => {
    expect(moveActive("ArrowDown", -1, 3)).toBe(0);
    expect(moveActive("ArrowDown", 2, 3)).toBe(-1);
    expect(moveActive("ArrowUp", -1, 3)).toBe(2);
    expect(moveActive("ArrowUp", 0, 3)).toBe(-1);
    expect(moveActive("ArrowDown", -1, 0)).toBe(-1);
  });

  it("Enter picks the highlighted row, else just closes and keeps the text", () => {
    expect(keyAction("Enter", 1, 3, true)).toEqual({ type: "pick", index: 1 });
    expect(keyAction("Enter", -1, 3, true)).toEqual({ type: "close" });
  });

  it("Escape closes; keys do nothing while the list is closed or empty", () => {
    expect(keyAction("Escape", 0, 3, true)).toEqual({ type: "close" });
    expect(keyAction("Enter", 0, 3, false)).toEqual({ type: "none" });
    expect(keyAction("ArrowDown", -1, 0, true)).toEqual({ type: "none" });
    expect(keyAction("a", 0, 3, true)).toEqual({ type: "none" });
  });
});

describe("near", () => {
  it("uses your location when known, else Home, else nothing", () => {
    expect(nearFrom({ lat: 1, lon: 2 }, places)).toEqual({ lat: 1, lon: 2 });
    expect(nearFrom(null, places)).toEqual({ lat: -26.8, lon: 153.12 });
    expect(nearFrom(null, [])).toBeNull();
    expect(nearFrom(null, undefined)).toBeNull();
  });
});
