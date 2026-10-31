/*
 * The shape importers produce — exactly the ``add_contacts`` action's
 * ``ContactIn`` (backend actions.py) — plus the clamp that keeps a batch
 * inside the server's limits so one odd card can't fail a whole import.
 */
import type { Address, Labeled, RelType } from "./types";
import { REL_TYPES } from "./types";
import { normalizeWebsite, validDate } from "./model";

export interface ImportContact {
  full_name?: string;
  prefix?: string;
  first?: string;
  middle?: string;
  last?: string;
  suffix?: string;
  nickname?: string;
  pronouns?: string;
  phonetic_first?: string;
  phonetic_last?: string;
  company?: string;
  title?: string;
  department?: string;
  phones?: Labeled[];
  emails?: Labeled[];
  addresses?: Address[];
  websites?: Labeled[];
  birthday?: string | null;
  dates?: { label: string; date: string; kind: "anniversary" | "other" }[];
  met_how?: string;
  met_where?: string;
  met_date?: string | null;
  relationships?: { type: RelType; name: string; label: string }[];
  tags?: string[];
  groups?: string[];
  notes?: string;
  favorite?: boolean;
  /** The card's UID (vCard) — re-imports match on it. */
  uid?: string;
  /** Any image data URL as read; shrunk to a small JPEG before sending. */
  photo?: string | null;
  /** "<import id>:<row>", set when the import runs. */
  import_ref?: string;
}

const LIMITS: Record<string, number> = {
  full_name: 300,
  prefix: 40,
  first: 100,
  middle: 100,
  last: 100,
  suffix: 40,
  nickname: 100,
  pronouns: 40,
  phonetic_first: 100,
  phonetic_last: 100,
  company: 160,
  title: 160,
  department: 160,
  met_how: 500,
  met_where: 200,
  notes: 20_000,
};

const cut = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);

function labeled(list: Labeled[] | undefined, max: number): Labeled[] {
  const seen = new Set<string>();
  const out: Labeled[] = [];
  for (const x of list ?? []) {
    const value = cut(x.value, 320);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push({ label: cut(x.label, 40), value });
  }
  return out.slice(0, max);
}

/** Clean one imported contact to the server's limits; null when there's nobody there. */
export function clampImport(c: ImportContact): ImportContact | null {
  const out: ImportContact = {};
  for (const [k, n] of Object.entries(LIMITS)) {
    const v = cut((c as Record<string, string | undefined>)[k], n);
    if (v) (out as Record<string, string>)[k] = v;
  }
  out.phones = labeled(c.phones, 20);
  out.emails = labeled(c.emails, 20);
  // Links that aren't web links (skype:, xmpp:…) are kept as a note instead.
  const odd: string[] = [];
  out.websites = labeled(
    (c.websites ?? []).flatMap((w) => {
      const value = normalizeWebsite(w.label, w.value);
      if (value) return [{ label: w.label, value }];
      if (w.value.trim()) odd.push(`${w.label || "Link"}: ${w.value.trim()}`);
      return [];
    }),
    20,
  );
  if (odd.length) out.notes = [out.notes, odd.join("\n")].filter(Boolean).join("\n\n").slice(0, 20_000);
  if (c.uid?.trim()) out.uid = c.uid.trim().slice(0, 200);
  if (c.photo && /^data:image\/[a-z0-9.+-]+;base64,/i.test(c.photo)) out.photo = c.photo;
  out.addresses = (c.addresses ?? [])
    .map((a) => ({
      label: cut(a.label, 40),
      street: cut(a.street, 300),
      city: cut(a.city, 120),
      region: cut(a.region, 120),
      postcode: cut(a.postcode, 30),
      country: cut(a.country, 80),
    }))
    .filter((a) => a.street || a.city || a.region || a.postcode || a.country)
    .slice(0, 10);
  if (c.birthday && validDate(c.birthday)) out.birthday = c.birthday;
  if (c.met_date && /^\d{4}-\d{2}-\d{2}$/.test(c.met_date) && validDate(c.met_date)) out.met_date = c.met_date;
  out.dates = (c.dates ?? []).filter((d) => validDate(d.date)).map((d) => ({ ...d, label: cut(d.label, 60) })).slice(0, 30);
  out.relationships = (c.relationships ?? [])
    .filter((r) => r.name.trim())
    .map((r) => ({ type: REL_TYPES.includes(r.type) ? r.type : "other", name: cut(r.name, 120), label: cut(r.label, 40) }))
    .slice(0, 50);
  const tagSeen = new Set<string>();
  out.tags = (c.tags ?? [])
    .map((t) => cut(t, 40))
    .filter((t) => t && !tagSeen.has(t.toLowerCase()) && tagSeen.add(t.toLowerCase()))
    .slice(0, 50);
  out.groups = [...new Set((c.groups ?? []).map((g) => cut(g, 60)).filter(Boolean))].slice(0, 50);
  if (c.favorite) out.favorite = true;
  const named = out.first || out.last || out.nickname || out.company || out.full_name;
  if (!named && !out.emails.length && !out.phones.length) return null;
  return out;
}

export function importName(c: ImportContact): string {
  return (
    [c.prefix, c.first, c.middle, c.last, c.suffix].filter(Boolean).join(" ") ||
    c.full_name ||
    c.nickname ||
    c.company ||
    c.emails?.[0]?.value ||
    c.phones?.[0]?.value ||
    "No name"
  );
}

/** Map a free-form relation label ("Spouse", "_$!<Mother>!$_", "daughter") to a type + label. */
export function relationFromLabel(raw: string): { type: RelType; label: string } {
  const s = raw.replace(/^_\$!<|>!\$_$/g, "").trim();
  const l = s.toLowerCase();
  const table: [RegExp, RelType][] = [
    [/^(spouse|husband|wife)$/, "spouse"],
    [/^(partner|boyfriend|girlfriend|domestic.?partner|fianc[eé]+)$/, "partner"],
    [/^(child|son|daughter|kid)$/, "child"],
    [/^(parent|mother|father|mom|mum|dad)$/, "parent"],
    [/^(sibling|brother|sister)$/, "sibling"],
    [/^friend$/, "friend"],
    [/^(colleague|co-?worker)$/, "colleague"],
    [/^(manager|boss)$/, "manager"],
    [/^(assistant|report|direct report)$/, "report"],
    [/^(relative|cousin|aunt|uncle|niece|nephew|grand.*)$/, "relative"],
  ];
  for (const [re, t] of table) if (re.test(l)) return { type: t, label: ["spouse", "partner", "child", "parent", "sibling", "friend", "colleague", "manager", "report", "relative"].includes(l) ? "" : s };
  return { type: "other", label: s };
}
