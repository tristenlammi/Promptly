/**
 * Suggestions for a "where" field (Calendar's Location and anything else that
 * takes a place as text): your saved P Maps places, Contacts that have an
 * address, and P Maps search (addresses and the businesses OpenStreetMap
 * knows). Pure functions, so the merging and the keyboard are unit-tested
 * (src/lib/locationSuggest.test.ts); the field itself is
 * components/maps/LocationInput.tsx.
 */

export type SuggestionKind = "home" | "work" | "favourite" | "list" | "contact" | "recent" | "business" | "address" | "place";

export interface LocationSuggestion {
  /** Stable within one list (React key, option id). */
  key: string;
  kind: SuggestionKind;
  name: string;
  /** A short address under the name; null when there isn't one. */
  address: string | null;
  lat?: number;
  lon?: number;
}

/** A saved P Maps place (``GET /api/maps/places``). */
export interface SavedPlaceLike {
  id: string;
  kind: "home" | "work" | "favourite" | "list";
  name: string;
  address?: string | null;
  list_name?: string | null;
  lat: number;
  lon: number;
}

/** A person from ``/api/people/search?details=1``: the first address on your own contact card. */
export interface ContactLike {
  key: string;
  name: string;
  contact: { address?: string } | null;
}

/** One row from ``GET /api/maps/search``. */
export interface SearchRowLike {
  kind: string;
  id?: string;
  name: string;
  address?: string | null;
  category?: string | null;
  lat: number;
  lon: number;
}

/** Every typed word appears somewhere in the fields (the server's ``_matches``). */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
}

/** Your saved places that match, Home and Work first. */
export function fromSavedPlaces(places: SavedPlaceLike[], query: string): LocationSuggestion[] {
  const order = { home: 0, work: 1, favourite: 2, list: 3 } as const;
  return places
    .filter((p) => matches(query, p.name, p.address, p.list_name, p.kind === "home" || p.kind === "work" ? p.kind : null))
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((p) => ({ key: `saved:${p.id}`, kind: p.kind, name: p.name, address: p.address?.trim() || null, lat: p.lat, lon: p.lon }));
}

/** Contacts with an address on their card. The server already matched the name. */
export function fromContacts(people: ContactLike[]): LocationSuggestion[] {
  return people
    .filter((p) => !!p.contact?.address?.trim())
    .map((p) => ({ key: `contact:${p.key}`, kind: "contact" as const, name: p.name, address: p.contact!.address!.trim() }));
}

/** P Maps search rows: a named place with an OSM category is a business. */
export function fromSearch(rows: SearchRowLike[]): LocationSuggestion[] {
  return rows
    .filter((r) => r.kind !== "pin" && r.name)
    .map((r, i) => {
      const kind: SuggestionKind =
        r.kind === "home" || r.kind === "work" || r.kind === "favourite" || r.kind === "list" || r.kind === "contact" || r.kind === "recent" || r.kind === "address"
          ? r.kind
          : r.category
            ? "business"
            : "place";
      return { key: r.id ? `saved:${r.id}` : `search:${i}:${r.lat},${r.lon}`, kind, name: r.name, address: r.address?.trim() || null, lat: r.lat, lon: r.lon };
    });
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * One list: saved places, then contacts, then the map — each place once.
 * Map search already returns your saved places and contacts (``find_places``
 * merges them), so its copies are dropped by id, by contact name, by the same
 * spot (within ~10 m) or by the same name and address.
 */
export function mergeSuggestions(saved: LocationSuggestion[], contacts: LocationSuggestion[], search: LocationSuggestion[], limit = 8): LocationSuggestion[] {
  const out: LocationSuggestion[] = [];
  const keys = new Set<string>();
  const spots = new Set<string>();
  const labels = new Set<string>();
  const contactNames = new Set(contacts.map((c) => norm(c.name)));
  const add = (s: LocationSuggestion) => {
    const spot = s.lat != null && s.lon != null ? `${s.lat.toFixed(4)},${s.lon.toFixed(4)}` : null;
    const label = `${norm(s.name)}|${norm(s.address)}`;
    if (keys.has(s.key) || (spot && spots.has(spot)) || labels.has(label)) return;
    if (s.kind === "contact" && s.key.startsWith("search:") && contactNames.has(norm(s.name))) return;
    keys.add(s.key);
    if (spot) spots.add(spot);
    labels.add(label);
    out.push(s);
  };
  [...saved, ...contacts, ...search].forEach(add);
  return out.slice(0, limit);
}

/** What goes in the field: "Name, short address", or just the address when
 *  the name is the address (or the start of it). */
export function locationText(s: Pick<LocationSuggestion, "name" | "address">): string {
  const name = s.name.trim();
  const address = (s.address ?? "").trim();
  if (!address) return name;
  if (!name) return address;
  const n = norm(name);
  const a = norm(address);
  if (a === n || a.startsWith(`${n} `)) return address;
  if (n.startsWith(`${a} `) || n === a) return name;
  return `${name}, ${address}`;
}

/** The highlighted row after a key: -1 is the typed text itself (Enter keeps it). */
export function moveActive(key: "ArrowDown" | "ArrowUp", active: number, count: number): number {
  if (count <= 0) return -1;
  if (key === "ArrowDown") return active + 1 >= count ? -1 : active + 1;
  return active - 1 < -1 ? count - 1 : active - 1;
}

/** What a key does in the field while suggestions are showing. */
export type KeyAction =
  | { type: "move"; active: number }
  | { type: "pick"; index: number }
  | { type: "close" }
  | { type: "none" };

export function keyAction(key: string, active: number, count: number, open: boolean): KeyAction {
  if (!open || count === 0) return { type: "none" };
  if (key === "ArrowDown" || key === "ArrowUp") return { type: "move", active: moveActive(key, active, count) };
  if (key === "Escape") return { type: "close" };
  if (key === "Enter") return active >= 0 && active < count ? { type: "pick", index: active } : { type: "close" };
  return { type: "none" };
}

/** Where to look near: your location when you've already allowed it, else Home. */
export function nearFrom(here: { lat: number; lon: number } | null, places: SavedPlaceLike[] | undefined): { lat: number; lon: number } | null {
  if (here) return here;
  const home = places?.find((p) => p.kind === "home");
  return home ? { lat: home.lat, lon: home.lon } : null;
}
