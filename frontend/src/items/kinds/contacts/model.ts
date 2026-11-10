import { mapsSearchLink } from "@/maps/links";
/*
 * Contacts — pure logic shared by the views: names, sort letters, dates
 * (next occurrence, age), the keep-in-touch rhythm, search, duplicates and
 * links. Mirrors backend/app/items/kinds/contacts/logic.py so the screen and
 * the assistant agree.
 */
import { addDays, daysBetween, safeHref, todayISO, uid } from "@/items/ui";

import { RECIPROCAL, type Contact, type ContactsData, type Group, type Labeled, type Settings } from "./types";

// ------------------------------------------------------------------ names

export function displayName(c: Contact, order: Settings["name_order"] = "first_last"): string {
  const first = [c.first, c.middle].filter(Boolean).join(" ");
  let name = order === "last_first" && first && c.last ? `${c.last}, ${first}` : [first, c.last].filter(Boolean).join(" ");
  if (c.suffix && name) name = `${name} ${c.suffix}`;
  if (name) return name;
  if (c.nickname) return c.nickname;
  if (c.company) return c.company;
  if (c.emails[0]) return c.emails[0].value;
  if (c.phones[0]) return c.phones[0].value;
  return "No name";
}

export function shortName(c: Contact): string {
  return c.nickname || c.first || displayName(c);
}

/** Initials for the avatar: first + last, else the first two letters. */
export function initials(c: Contact): string {
  const a = (c.first || "").trim();
  const b = (c.last || "").trim();
  if (a || b) return ((a[0] || "") + (b[0] || "")).toUpperCase() || "?";
  const shown = displayName(c);
  // Nothing to go on yet (a new contact): a "?" rather than "NN" for "No name".
  if (shown === "No name") return "?";
  const n = shown.replace(/[^\p{L}\p{N} ]/gu, "").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (n.slice(0, 2) || "?").toUpperCase();
}

export const AVATAR_COLORS = ["#3B7DD8", "#E2725B", "#4F8A8B", "#7B6CD9", "#C08B2C", "#3E8E5A", "#C2557A", "#8A6F5A", "#2C9CC8", "#D9506A"];

export function avatarColor(c: Contact): string {
  if (c.color) return c.color;
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Lower-case, accents gone, punctuation to spaces. */
export function fold(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.+_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function sortKey(c: Contact, by: Settings["sort_by"]): string {
  const primary = by === "last" ? c.last || c.first : c.first || c.last;
  const secondary = by === "last" ? c.first : c.last;
  return fold(`${primary || displayName(c)} ${secondary || ""}`);
}

/** The A–Z letter a contact files under ("#" for digits and symbols). */
export function letterOf(c: Contact, by: Settings["sort_by"]): string {
  const k = sortKey(c, by);
  const ch = k[0]?.toUpperCase() ?? "#";
  return /[A-Z]/.test(ch) ? ch : /\p{L}/u.test(ch) ? ch : "#";
}

export function sortContacts(list: Contact[], by: Settings["sort_by"]): Contact[] {
  const keyed = list.map((c) => [sortKey(c, by), c] as const);
  keyed.sort((a, b) => {
    const la = /^[a-z]/.test(a[0]) ? 0 : /^\p{L}/u.test(a[0]) ? 1 : 2;
    const lb = /^[a-z]/.test(b[0]) ? 0 : /^\p{L}/u.test(b[0]) ? 1 : 2;
    return la - lb || a[0].localeCompare(b[0]);
  });
  return keyed.map((k) => k[1]);
}

export function workLine(c: Contact): string {
  const role = [c.title, c.department].filter(Boolean).join(", ");
  return [role, c.company].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ keys
//
// Phone numbers are compared as full international (E.164) numbers, read in
// the person's country (mirrors logic.py). Extensions are kept apart.

/** code → [calling code, trunk prefix, names, time-zone prefixes] */
export const COUNTRIES: Record<string, [string, string, string[], string[]]> = {
  AU: ["61", "0", ["australia"], ["Australia/"]],
  NZ: ["64", "0", ["new zealand", "aotearoa"], ["Pacific/Auckland", "Pacific/Chatham", "NZ"]],
  GB: ["44", "0", ["united kingdom", "uk", "england", "scotland", "wales", "northern ireland", "great britain", "britain"], ["Europe/London", "GB"]],
  IE: ["353", "0", ["ireland"], ["Europe/Dublin"]],
  CA: ["1", "1", ["canada"], ["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax", "America/St_Johns", "America/Regina", "America/Montreal", "Canada/"]],
  US: ["1", "1", ["united states", "usa", "us", "america", "united states of america"], ["America/", "US/"]],
  IN: ["91", "0", ["india"], ["Asia/Kolkata", "Asia/Calcutta"]],
  SG: ["65", "", ["singapore"], ["Asia/Singapore"]],
  MY: ["60", "0", ["malaysia"], ["Asia/Kuala_Lumpur"]],
  PH: ["63", "0", ["philippines"], ["Asia/Manila"]],
  ID: ["62", "0", ["indonesia"], ["Asia/Jakarta"]],
  HK: ["852", "", ["hong kong"], ["Asia/Hong_Kong"]],
  JP: ["81", "0", ["japan"], ["Asia/Tokyo"]],
  KR: ["82", "0", ["south korea", "korea"], ["Asia/Seoul"]],
  CN: ["86", "0", ["china"], ["Asia/Shanghai"]],
  ZA: ["27", "0", ["south africa"], ["Africa/Johannesburg"]],
  DE: ["49", "0", ["germany", "deutschland"], ["Europe/Berlin"]],
  FR: ["33", "0", ["france"], ["Europe/Paris"]],
  ES: ["34", "", ["spain", "españa"], ["Europe/Madrid"]],
  IT: ["39", "", ["italy", "italia"], ["Europe/Rome"]],
  NL: ["31", "0", ["netherlands", "holland"], ["Europe/Amsterdam"]],
  BE: ["32", "0", ["belgium"], ["Europe/Brussels"]],
  CH: ["41", "0", ["switzerland"], ["Europe/Zurich"]],
  AT: ["43", "0", ["austria"], ["Europe/Vienna"]],
  SE: ["46", "0", ["sweden"], ["Europe/Stockholm"]],
  NO: ["47", "", ["norway"], ["Europe/Oslo"]],
  DK: ["45", "", ["denmark"], ["Europe/Copenhagen"]],
  FI: ["358", "0", ["finland"], ["Europe/Helsinki"]],
  PL: ["48", "", ["poland"], ["Europe/Warsaw"]],
  PT: ["351", "", ["portugal"], ["Europe/Lisbon"]],
  BR: ["55", "0", ["brazil", "brasil"], ["America/Sao_Paulo"]],
  MX: ["52", "", ["mexico"], ["America/Mexico_City"]],
  AR: ["54", "0", ["argentina"], ["America/Argentina/"]],
  AE: ["971", "0", ["united arab emirates", "uae"], ["Asia/Dubai"]],
  IL: ["972", "0", ["israel"], ["Asia/Jerusalem"]],
};
export const DEFAULT_COUNTRY = "AU";

export const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia", NZ: "New Zealand", GB: "United Kingdom", IE: "Ireland", CA: "Canada", US: "United States", IN: "India",
  SG: "Singapore", MY: "Malaysia", PH: "Philippines", ID: "Indonesia", HK: "Hong Kong", JP: "Japan", KR: "South Korea",
  CN: "China", ZA: "South Africa", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium",
  CH: "Switzerland", AT: "Austria", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", PL: "Poland", PT: "Portugal",
  BR: "Brazil", MX: "Mexico", AR: "Argentina", AE: "United Arab Emirates", IL: "Israel",
};

export function countryFromLocation(location: string | null | undefined): string | null {
  const loc = fold(location || "");
  if (!loc) return null;
  let best: [number, string] | null = null;
  for (const [code, [, , names]] of Object.entries(COUNTRIES))
    for (const n of names) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu");
      for (const m of loc.matchAll(re)) if (!best || (m.index ?? 0) > best[0]) best = [m.index ?? 0, code];
    }
  return best?.[1] ?? null;
}

export function countryFromTz(tz: string | null | undefined): string | null {
  if (!tz) return null;
  let best: [number, string] | null = null;
  for (const [code, [, , , zones]] of Object.entries(COUNTRIES))
    for (const z of zones) if ((tz === z || (z.endsWith("/") && tz.startsWith(z))) && (!best || z.length > best[0])) best = [z.length, code];
  return best?.[1] ?? null;
}

/** The country national numbers are read in: the file's setting, else the
 *  person's Promptly location, else their time zone, else Australia. */
export function homeCountry(settings: Partial<Settings> | undefined, userSettings?: Record<string, unknown> | null): string {
  const s = settings?.phone_country || "";
  if (s && COUNTRIES[s]) return s;
  const loc = typeof userSettings?.location === "string" ? (userSettings.location as string) : null;
  let tz: string | null = null;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = null;
  }
  return countryFromLocation(loc) ?? countryFromTz(tz) ?? DEFAULT_COUNTRY;
}

export function phoneDigits(v: string): string {
  return (v || "").replace(/\D/g, "");
}

const EXT_RE = /\s*(?:;\s*ext\s*=\s*|(?<![a-z])ext(?:ension)?\.?\s*:?\s*|(?<![a-z])x\.?\s*|#\s*|[,;]\s*)(\d{1,8})\s*$/i;

/** ``[+E164, extension]``; the number is "" when it isn't a full number. */
export function phoneParts(value: string, country: string = DEFAULT_COUNTRY): [string, string] {
  let s = (value || "").trim().replace(/^tel:/i, "");
  let ext = "";
  const m = EXT_RE.exec(s);
  if (m && /\d/.test(s.slice(0, m.index))) {
    ext = m[1];
    s = s.slice(0, m.index);
  }
  const digits = phoneDigits(s);
  if (!digits) return ["", ext];
  const [cc, trunk] = COUNTRIES[country] ?? COUNTRIES[DEFAULT_COUNTRY];
  let full: string;
  if (s.trimStart().startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (cc === "1" && digits.startsWith("011")) full = digits.slice(3);
  else {
    let nsn: string;
    if (trunk && digits.startsWith(trunk)) nsn = digits.slice(trunk.length);
    else if (trunk === "0" && digits.length < 9) return ["", ext];
    else nsn = digits;
    full = cc + nsn;
  }
  if (full.length < 10 || full.length > 15) return ["", ext];
  return ["+" + full, ext];
}

/** The full number (+ extension) two contacts must share to be the same. */
export function phoneKey(v: string, country: string = DEFAULT_COUNTRY): string {
  const [num, ext] = phoneParts(v, country);
  return num ? (ext ? `${num}x${ext}` : num) : "";
}

export function emailKey(v: string): string {
  const s = (v || "").trim().toLowerCase();
  return s.includes("@") ? s : "";
}

export function nameKey(c: Pick<Contact, "first" | "last">): string {
  return c.first && c.last ? fold(`${c.first} ${c.last}`) : "";
}

/** Keys only the same person shares: an email, a full phone number. */
export function strongKeys(c: Pick<Contact, "emails" | "phones">, country: string): Set<string> {
  const out = new Set<string>();
  for (const e of c.emails ?? []) {
    const k = emailKey(e.value);
    if (k) out.add(`e:${k}`);
  }
  for (const p of c.phones ?? []) {
    const k = phoneKey(p.value, country);
    if (k) out.add(`p:${k}`);
  }
  return out;
}

/** A number or email on this many contacts is a shared one (a family landline). */
export const SHARED_AT = 3;

// ------------------------------------------------------------------ dates

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function monthDay(s: string): { year: number | null; month: number; day: number } {
  if (s.startsWith("--")) return { year: null, month: Number(s.slice(2, 4)), day: Number(s.slice(5, 7)) };
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)), day: Number(s.slice(8, 10)) };
}

function on(year: number, month: number, day: number): string {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The next time this month/day comes round (today counts). */
export function nextOccurrence(s: string, today: string = todayISO()): string {
  const { month, day } = monthDay(s);
  const y = Number(today.slice(0, 4));
  const occ = on(y, month, day);
  return occ < today ? on(y + 1, month, day) : occ;
}

export function yearsOn(s: string, occ: string): number | null {
  const { year } = monthDay(s);
  const y = Number(occ.slice(0, 4));
  return year === null || year > y ? null : y - year;
}

export function ageOf(birthday: string | null, today: string = todayISO()): number | null {
  if (!birthday) return null;
  const { year, month, day } = monthDay(birthday);
  const y = Number(today.slice(0, 4));
  if (year === null || year > y) return null;
  return y - year - (today >= on(y, month, day) ? 0 : 1);
}

export function validDate(s: string): boolean {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const year = m[1] === "-" ? 2000 : Number(m[1]);
  if (year < 1) return false;
  const max = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= max;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "3 Mar 1990" / "3 Mar" for a stored date. */
export function fmtDate(s: string | null, { year = true }: { year?: boolean } = {}): string {
  if (!s) return "";
  const { year: y, month, day } = monthDay(s);
  const d = new Date(y ?? 2000, month - 1, day);
  return d.toLocaleDateString(undefined, y !== null && year ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}

/** Read a typed date ("1990-03-15", "15/03/1990", "15 March", "--03-15") → stored form, or null. */
export function parseDateInput(raw: string, dayFirst = true): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let out: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) out = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) out = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^--(\d{2})-?(\d{2})$/.exec(s))) out = `--${m[1]}-${m[2]}`;
  else if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [day, month] = dayFirst ? [a, b] : [b, a];
    let year = m[3] ? Number(m[3]) : null;
    if (year !== null && year < 100) year += year > Number(todayISO().slice(2, 4)) ? 1900 : 2000;
    out = year && year > 0 ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : `--${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  } else {
    const words = s.match(/[a-z]+|\d+/g) ?? [];
    const mi = words.findIndex((w) => MONTHS.includes(w.slice(0, 3)));
    const nums = words.filter((w) => /^\d+$/.test(w));
    if (mi >= 0 && nums.length) {
      const month = MONTHS.indexOf(words[mi].slice(0, 3)) + 1;
      const day = nums.find((n) => n.length <= 2);
      const year = nums.find((n) => n.length === 4);
      if (day) out = year ? `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}` : `--${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }
  if (out && /^(1604|0000)-/.test(out)) out = `--${out.slice(5)}`;
  return out && validDate(out) ? out : null;
}

export interface UpcomingDate {
  contact: Contact;
  kind: "birthday" | "anniversary" | "other";
  label: string;
  date: string; // the next occurrence
  inDays: number;
  turns: number | null; // age they turn / years since
  dateId: string | null;
}

export function upcomingDates(data: ContactsData, days: number, today: string = todayISO()): UpcomingDate[] {
  const end = addDays(today, days);
  const out: UpcomingDate[] = [];
  for (const c of data.contacts) {
    if (c.birthday) {
      const occ = nextOccurrence(c.birthday, today);
      if (occ <= end) out.push({ contact: c, kind: "birthday", label: "Birthday", date: occ, inDays: daysBetween(today, occ), turns: yearsOn(c.birthday, occ), dateId: null });
    }
    for (const d of c.dates) {
      const occ = nextOccurrence(d.date, today);
      if (occ <= end)
        out.push({
          contact: c,
          kind: d.kind,
          label: d.label || (d.kind === "anniversary" ? "Anniversary" : "Date"),
          date: occ,
          inDays: daysBetween(today, occ),
          turns: yearsOn(d.date, occ),
          dateId: d.id,
        });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || displayName(a.contact).localeCompare(displayName(b.contact)));
}

export function inDaysLabel(n: number): string {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return `In ${n} days`;
  if (n < 14) return "Next week";
  return `In ${Math.round(n / 7)} weeks`;
}

// ------------------------------------------------------------ keep in touch

export function lastContacted(c: Contact): string | null {
  let best: string | null = null;
  for (const i of c.interactions) if (!best || i.date > best) best = i.date;
  return best;
}

/** When they're next due a catch-up (null: no rhythm). Never contacted = due today. */
export function dueOn(c: Contact, today: string = todayISO()): string | null {
  if (!c.cadence_days) return null;
  const last = lastContacted(c);
  let due = last ? addDays(last, c.cadence_days) : today;
  if (c.snoozed_until && c.snoozed_until > due) due = c.snoozed_until;
  return due;
}

export interface Reconnect {
  contact: Contact;
  due: string;
  overdue: number; // days (≥ 0)
  last: string | null;
}

export function reconnectList(data: ContactsData, withinDays = 0, today: string = todayISO()): Reconnect[] {
  const horizon = addDays(today, withinDays);
  const out: Reconnect[] = [];
  for (const c of data.contacts) {
    const due = dueOn(c, today);
    if (!due || due > horizon) continue;
    out.push({ contact: c, due, overdue: Math.max(0, daysBetween(due, today)), last: lastContacted(c) });
  }
  return out.sort(
    (a, b) => a.due.localeCompare(b.due) || Number(b.contact.favorite) - Number(a.contact.favorite) || displayName(a.contact).localeCompare(displayName(b.contact)),
  );
}

export const CADENCES: { days: number; label: string }[] = [
  { days: 7, label: "Every week" },
  { days: 14, label: "Every 2 weeks" },
  { days: 30, label: "Every month" },
  { days: 60, label: "Every 2 months" },
  { days: 90, label: "Every 3 months" },
  { days: 180, label: "Every 6 months" },
  { days: 365, label: "Every year" },
];

export function cadenceLabel(days: number | null): string {
  if (!days) return "No rhythm";
  return CADENCES.find((c) => c.days === days)?.label ?? `Every ${days} days`;
}

export function agoLabel(day: string | null, today: string = todayISO()): string {
  if (!day) return "Never";
  const n = daysBetween(day, today);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  if (n < 730) return `${Math.round(n / 30.4)} months ago`;
  return `${Math.round(n / 365)} years ago`;
}

// ----------------------------------------------------------------- search

/** One folded string per contact with everything searchable in it. */
export function haystack(c: Contact, groups: Map<string, string>, byId: Map<string, Contact>): string {
  const rel = c.relationships.map((r) => `${r.type} ${r.label} ${r.contact_id && byId.get(r.contact_id) ? displayName(byId.get(r.contact_id)!) : r.name}`);
  return fold(
    [
      c.prefix, c.first, c.middle, c.last, c.suffix, c.nickname, c.phonetic_first, c.phonetic_last,
      c.company, c.title, c.department, c.pronouns,
      ...c.emails.map((e) => e.value),
      ...c.addresses.map((a) => `${a.street} ${a.city} ${a.region} ${a.postcode} ${a.country}`),
      ...c.websites.map((w) => w.value),
      ...c.tags,
      ...c.groups.map((g) => groups.get(g) ?? ""),
      ...rel,
      c.met_how, c.met_where, c.notes,
      ...c.remember.map((n) => n.text),
      ...c.topics.map((n) => n.text),
      ...c.gifts.map((n) => n.text),
    ].join(" "),
  );
}

function within1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
      i += 2;
      j += 2;
    } else if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export interface SearchIndex {
  ids: string[];
  text: Map<string, string>;
  words: Map<string, string[]>;
  phones: Map<string, string[]>;
}

export function buildIndex(data: ContactsData): SearchIndex {
  const groups = new Map(data.groups.map((g) => [g.id, g.name]));
  const byId = new Map(data.contacts.map((c) => [c.id, c]));
  const text = new Map<string, string>();
  const words = new Map<string, string[]>();
  const phones = new Map<string, string[]>();
  for (const c of data.contacts) {
    const t = haystack(c, groups, byId);
    text.set(c.id, t);
    words.set(c.id, t.split(" "));
    phones.set(c.id, c.phones.map((p) => phoneDigits(p.value)));
  }
  return { ids: data.contacts.map((c) => c.id), text, words, phones };
}

/** Does contact ``id`` match ``query``? Every word must hit (prefix, substring, or one typo). */
export function matches(index: SearchIndex, id: string, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  if (!/[^\d\s()+.-]/.test(query)) {
    const qd = phoneDigits(query);
    if (qd.length >= 3) {
      const forms = [qd, qd.replace(/^0+/, "")].filter(Boolean);
      return (index.phones.get(id) ?? []).some((p) => forms.some((f) => p.includes(f)));
    }
  }
  const text = index.text.get(id) ?? "";
  const words = index.words.get(id) ?? [];
  return q.split(" ").every((t) => {
    if (text.includes(t)) return true;
    if (t.length < 4) return false;
    return words.some((w) => within1(t, w.length > t.length + 1 ? w.slice(0, t.length) : w));
  });
}

// ------------------------------------------------------------- duplicates

export interface DupeGroup {
  ids: string[];
  reasons: string[];
  /** Every link is an email / full phone / card — safe for "merge all". */
  strong: boolean;
}

const pair = (a: string, b: string) => [a, b].sort().join("|");

/** Mirrors logic.duplicate_groups: shared email / full phone / card UID, or
 *  (unless ``strongOnly``) the same first + last name. Numbers and emails on
 *  more than two people are shared ones and ignored. */
export function duplicateGroups(data: ContactsData, country: string = DEFAULT_COUNTRY, { strongOnly = false }: { strongOnly?: boolean } = {}): DupeGroup[] {
  const ruled = new Set(data.settings.not_duplicates);
  const buckets = new Map<string, string[]>();
  for (const c of data.contacts) {
    const keys = strongKeys(c, country);
    if ((c.uid || "").trim()) keys.add(`u:${c.uid.trim().toLowerCase()}`);
    const nk = strongOnly ? "" : nameKey(c);
    if (nk) keys.add(`n:${nk}`);
    for (const k of keys) buckets.set(k, [...(buckets.get(k) ?? []), c.id]);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const reasons = new Map<string, Set<string>>();
  const WHY: Record<string, string> = { e: "same email", p: "same phone", n: "same name", u: "same card" };
  for (const [key, ids] of buckets) {
    const kind = key.split(":")[0];
    const cap = kind === "e" || kind === "p" ? SHARED_AT - 1 : 10;
    if (ids.length < 2 || ids.length > cap) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const p = pair(ids[i], ids[j]);
        if (ruled.has(p)) continue;
        const ra = find(ids[i]);
        const rb = find(ids[j]);
        if (ra !== rb) parent.set(ra, rb);
        if (!reasons.has(p)) reasons.set(p, new Set());
        reasons.get(p)!.add(WHY[kind]);
      }
  }
  const clusters = new Map<string, string[]>();
  for (const c of data.contacts) if (parent.has(c.id)) clusters.set(find(c.id), [...(clusters.get(find(c.id)) ?? []), c.id]);
  const out: DupeGroup[] = [];
  for (const ids of clusters.values()) {
    if (ids.length < 2) continue;
    const why = new Set<string>();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) reasons.get(pair(ids[i], ids[j]))?.forEach((r) => why.add(r));
    out.push({ ids, reasons: [...why].sort(), strong: !why.has("same name") });
  }
  return out;
}

export function ruleOutPairs(ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(pair(ids[i], ids[j]));
  return out;
}

/**
 * Who in the book an import would surely be (mirrors logic.DupeIndex): a
 * card UID, an email or a full phone number — never a name — counting only
 * the people already there, and ignoring numbers/emails shared by 3+.
 */
export class DupeIndex {
  private keys = new Map<string, string>();
  private names = new Map<string, string>();
  constructor(
    contacts: Contact[],
    private country: string,
  ) {
    const owners = new Map<string, Set<string>>();
    const add = (k: string, id: string) => owners.set(k, (owners.get(k) ?? new Set()).add(id));
    for (const c of contacts) {
      for (const k of strongKeys(c, country)) add(k, c.id);
      if ((c.uid || "").trim()) add(`u:${c.uid.trim().toLowerCase()}`, c.id);
      add(`u:promptly-${c.id}`.toLowerCase(), c.id);
      const nk = nameKey(c);
      if (nk && !this.names.has(nk)) this.names.set(nk, c.id);
    }
    for (const [k, ids] of owners) if (ids.size < SHARED_AT || k.startsWith("u:")) this.keys.set(k, [...ids][0]);
  }
  match(cand: { uid?: string; emails?: Labeled[]; phones?: Labeled[] }): { id: string; why: string } | null {
    const uid = (cand.uid || "").trim().toLowerCase();
    if (uid && this.keys.has(`u:${uid}`)) return { id: this.keys.get(`u:${uid}`)!, why: "same card" };
    for (const k of [...strongKeys({ emails: cand.emails ?? [], phones: cand.phones ?? [] }, this.country)].sort())
      if (this.keys.has(k)) return { id: this.keys.get(k)!, why: k.startsWith("e:") ? "same email" : "same phone" };
    return null;
  }
  nameMatch(cand: { first?: string; last?: string }): string | null {
    const nk = cand.first && cand.last ? nameKey({ first: cand.first, last: cand.last }) : "";
    return (nk && this.names.get(nk)) || null;
  }
}


// ------------------------------------------------------------------ edit

export function blankContact(defaults: Partial<Contact> = {}): Contact {
  const now = new Date().toISOString();
  return {
    id: uid("c"),
    promptly_user_id: "",
    promptly_username: "",
    prefix: "",
    first: "",
    middle: "",
    last: "",
    suffix: "",
    nickname: "",
    pronouns: "",
    phonetic_first: "",
    phonetic_last: "",
    company: "",
    title: "",
    department: "",
    phones: [],
    emails: [],
    addresses: [],
    websites: [],
    photo: null,
    uid: "",
    import_ref: "",
    birthday: null,
    dates: [],
    met_how: "",
    met_where: "",
    met_date: null,
    relationships: [],
    tags: [],
    groups: [],
    notes: "",
    favorite: false,
    color: null,
    created_at: now,
    updated_at: now,
    interactions: [],
    cadence_days: null,
    snoozed_until: null,
    gifts: [],
    remember: [],
    topics: [],
    ...defaults,
  };
}

export function hasIdentity(c: Pick<Contact, "first" | "last" | "nickname" | "company" | "emails" | "phones">): boolean {
  return !!(c.first || c.last || c.nickname || c.company || c.emails.some((e) => e.value) || c.phones.some((p) => p.value));
}

/** Link ``a`` → ``b`` as ``type`` and ``b`` → ``a`` as the reciprocal (in a
 *  draft). Make ``ids`` outside the mutator (it may be replayed). */
export function linkBothWays(
  d: ContactsData,
  aId: string,
  type: Contact["relationships"][number]["type"],
  bId: string,
  label: string,
  ids: { a: string; b: string },
): void {
  const a = d.contacts.find((c) => c.id === aId);
  const b = d.contacts.find((c) => c.id === bId);
  if (!a || !b || a.id === b.id) return;
  const back = {
    partner: "partner", spouse: "spouse", child: "parent", parent: "child", sibling: "sibling", friend: "friend",
    colleague: "colleague", manager: "report", report: "manager", relative: "relative", other: "other",
  }[type] as typeof type;
  if (!a.relationships.some((r) => r.contact_id === b.id && r.type === type))
    a.relationships.push({ id: freeId(a.relationships, ids.a), type, contact_id: b.id, name: "", label });
  if (!b.relationships.some((r) => r.contact_id === a.id && r.type === back))
    b.relationships.push({ id: freeId(b.relationships, ids.b), type: back, contact_id: a.id, name: "", label: "" });
}

/** ``want`` unless a list already has it (a replay on newer data). */
export function freeId(list: { id: string }[], want: string): string {
  if (!list.some((x) => x.id === want)) return want;
  let n = 2;
  while (list.some((x) => x.id === `${want}-${n}`)) n++;
  return `${want}-${n}`;
}

/** Remove ``me``'s relationship ``rel`` and only its matching back-link on
 *  the other person (same type pair), in a draft. */
export function unlinkRelationship(d: ContactsData, meId: string, rel: Pick<Contact["relationships"][number], "id" | "type" | "contact_id">): void {
  const me = d.contacts.find((x) => x.id === meId);
  if (!me) return;
  me.relationships = me.relationships.filter((x) => x.id !== rel.id);
  if (!rel.contact_id) return;
  const other = d.contacts.find((x) => x.id === rel.contact_id);
  if (!other) return;
  const back = RECIPROCAL[rel.type];
  // Keep the back-link if ``me`` still has another link of this type to them.
  if (me.relationships.some((x) => x.contact_id === other.id && x.type === rel.type)) return;
  const i = other.relationships.findIndex((x) => x.contact_id === meId && x.type === back);
  if (i >= 0) other.relationships.splice(i, 1);
}

/** Remove contacts (in a draft); links to them become plain names. */
export function removeContacts(d: ContactsData, ids: Set<string>): void {
  const names = new Map(d.contacts.filter((c) => ids.has(c.id)).map((c) => [c.id, displayName(c)]));
  d.contacts = d.contacts.filter((c) => !ids.has(c.id));
  for (const c of d.contacts)
    for (const r of c.relationships)
      if (r.contact_id && ids.has(r.contact_id)) {
        r.name = r.name || names.get(r.contact_id) || "";
        r.contact_id = null;
      }
  d.settings.not_duplicates = d.settings.not_duplicates.filter((p) => !p.split("|").some((x) => ids.has(x)));
}

export function groupCounts(data: ContactsData): Map<string, number> {
  const m = new Map<string, number>(data.groups.map((g) => [g.id, 0]));
  for (const c of data.contacts) for (const g of c.groups) m.set(g, (m.get(g) ?? 0) + 1);
  return m;
}

export function tagCounts(data: ContactsData): [string, number][] {
  const m = new Map<string, [string, number]>();
  for (const c of data.contacts)
    for (const t of c.tags) {
      const k = t.toLowerCase();
      const cur = m.get(k);
      m.set(k, [cur?.[0] ?? t, (cur?.[1] ?? 0) + 1]);
    }
  return [...m.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function groupName(groups: Group[], id: string): string {
  return groups.find((g) => g.id === id)?.name ?? "";
}

// ------------------------------------------------------------------ links

export function telHref(v: string, country: string = DEFAULT_COUNTRY): string {
  const [num, ext] = phoneParts(v, country);
  if (num) return `tel:${num}${ext ? `,${ext}` : ""}`;
  return `tel:${v.replace(/[^\d+*#]/g, "")}`;
}

export function smsHref(v: string): string {
  return `sms:${v.replace(/[^\d+]/g, "")}`;
}

export function mapsHref(a: { street: string; city: string; region: string; postcode: string; country: string }): string {
  const q = [a.street, a.city, a.region, a.postcode, a.country].filter(Boolean).join(", ");
  return mapsSearchLink(q);
}

const HANDLE_SITES: Record<string, string> = {
  instagram: "https://instagram.com/", x: "https://x.com/", twitter: "https://x.com/", tiktok: "https://www.tiktok.com/@",
  github: "https://github.com/", threads: "https://www.threads.net/@", bluesky: "https://bsky.app/profile/",
  facebook: "https://facebook.com/", telegram: "https://t.me/",
};

/** A website / profile as a safe link (mirrors models.normalize_website):
 *  "@sam" + Instagram → instagram.com/sam; null for ``javascript:`` etc. */
export function normalizeWebsite(label: string, value: string): string | null {
  let v = (value || "").trim();
  if (!v) return null;
  if (v.startsWith("@") && v.length > 1 && !/\s/.test(v)) v = (HANDLE_SITES[(label || "").trim().toLowerCase()] ?? "https://x.com/") + v.slice(1);
  const low = v.toLowerCase();
  if (/^(https?:\/\/|mailto:|tel:)/.test(low)) return v.slice(0, 2000);
  if (low.includes("://") || /^(javascript|data|vbscript|file):/.test(low) || v.split("/")[0].includes(":")) return null;
  return `https://${v}`.slice(0, 2000);
}

/** Where a stored website points, or undefined when it isn't safe to open. */
export function webHref(label: string, v: string): string | undefined {
  return safeHref(normalizeWebsite(label, v) ?? undefined);
}

export function addressLines(a: { street: string; city: string; region: string; postcode: string; country: string }): string[] {
  return [a.street, [a.city, a.region, a.postcode].filter(Boolean).join(" "), a.country].filter(Boolean);
}

export const daysFrom = (a: string, b: string) => daysBetween(a, b);
