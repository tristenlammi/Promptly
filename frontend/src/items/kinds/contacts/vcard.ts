/*
 * vCard (.vcf) — read 2.1 / 3.0 / 4.0 and write 3.0 / 4.0. Pure: strings in,
 * plain objects out, no DOM, so it can be checked on its own
 * (``vcardSelfCheck``).
 *
 * Reading handles line folding, quoted-printable (with soft line breaks and
 * a CHARSET), several cards in one file, TYPE params in every spelling
 * (``TYPE=CELL,VOICE``, ``TYPE=cell;TYPE=pref``, 2.1's bare ``;CELL``),
 * Apple's ``itemN.`` groups with ``X-ABLABEL`` custom labels, and birthdays
 * as ``1990-03-15``, ``19900315``, ``--0315``, ``--03-15``, a date-time, or
 * Apple's ``1604-…`` "no year".
 */
import { clampImport, relationFromLabel, type ImportContact } from "./importing";
import { DEFAULT_COUNTRY, displayName, parseDateInput, phoneParts } from "./model";
import type { Contact, Group, Labeled } from "./types";

// ------------------------------------------------------------------ lines

export interface VProp {
  group: string;
  name: string;
  params: Record<string, string[]>;
  value: string; // raw (still escaped), already QP-decoded
}

function headOf(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') q = !q;
    else if (ch === ":" && !q) return line.slice(0, i);
  }
  return line;
}

const isQP = (line: string) => /(^|;)\s*(ENCODING=)?QUOTED-PRINTABLE\s*(;|$)/i.test(headOf(line));

/** Physical lines → logical lines (folding and QP soft breaks undone). */
export function unfold(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    const last = out.length - 1;
    if (last >= 0 && isQP(out[last]) && out[last].endsWith("=")) {
      out[last] = out[last].slice(0, -1) + line;
      continue;
    }
    if (last >= 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[last] += line.slice(1);
      continue;
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (ch === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function decodeQP(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === "=" && i === value.length - 1) {
      /* stray soft break */
    } else {
      const enc = new TextEncoder().encode(ch);
      enc.forEach((b) => bytes.push(b));
    }
  }
  const arr = new Uint8Array(bytes);
  try {
    return new TextDecoder(charset || "utf-8").decode(arr);
  } catch {
    return new TextDecoder("utf-8").decode(arr);
  }
}

export function parseLine(line: string): VProp | null {
  const head = headOf(line);
  if (head === line) return null;
  let value = line.slice(head.length + 1);
  const parts = splitOutsideQuotes(head, ";");
  const full = parts.shift()!.trim();
  const dot = full.lastIndexOf(".");
  const group = dot >= 0 ? full.slice(0, dot).toLowerCase() : "";
  const name = (dot >= 0 ? full.slice(dot + 1) : full).toUpperCase();
  const params: Record<string, string[]> = {};
  for (const p of parts) {
    if (!p.trim()) continue;
    const eq = p.indexOf("=");
    const key = eq >= 0 ? p.slice(0, eq).trim().toUpperCase() : "TYPE";
    const raw = eq >= 0 ? p.slice(eq + 1) : p;
    // Bare 2.1 encodings: ";QUOTED-PRINTABLE", ";BASE64".
    if (eq < 0 && /^(quoted-printable|base64|b|8bit|7bit)$/i.test(raw.trim())) {
      params.ENCODING = [raw.trim().toLowerCase()];
      continue;
    }
    const vals = splitOutsideQuotes(raw, ",").map((v) => v.trim().replace(/^"|"$/g, ""));
    params[key] = [...(params[key] ?? []), ...vals.map((v) => (key === "TYPE" ? v.toLowerCase() : v))];
  }
  const enc = params.ENCODING?.[0]?.toLowerCase();
  if (enc === "quoted-printable") value = decodeQP(value, params.CHARSET?.[0] ?? "utf-8");
  return { group, name, params, value };
}

/** Split on an unescaped separator, then undo the escapes. */
export function splitValue(value: string, sep = ";"): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const n = value[i + 1];
      cur += n === "n" || n === "N" ? "\n" : n;
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const text = (v: string) => splitValue(v, "\u0000")[0].trim();

// ------------------------------------------------------------------ cards

const IGNORED_TYPES = new Set(["pref", "voice", "internet", "x400", "msg", "text", "pcs", "isdn", "bbs", "modem", "car", "video", "dom", "intl", "postal", "parcel"]);

function cleanLabel(raw: string): string {
  const s = raw.replace(/^_\$!<|>!\$_$/g, "").trim();
  const l = s.toLowerCase();
  const known: Record<string, string> = {
    mobile: "mobile", cell: "mobile", home: "home", work: "work", main: "main", other: "other", iphone: "iPhone",
    homepage: "website", "home fax": "home fax", "work fax": "work fax", pager: "pager", anniversary: "Anniversary",
    school: "school", personal: "personal",
  };
  return known[l] ?? s;
}

function typeLabel(p: VProp, groupLabels: Map<string, string>): string {
  const custom = p.group ? groupLabels.get(p.group) : undefined;
  if (custom) return cleanLabel(custom);
  const types = (p.params.TYPE ?? []).map((t) => t.toLowerCase()).filter((t) => !IGNORED_TYPES.has(t) && !t.startsWith("x-") || t === "x-mobile");
  if (types.includes("fax")) return types.includes("work") ? "work fax" : types.includes("home") ? "home fax" : "fax";
  if (types.includes("cell") || types.includes("mobile") || types.includes("x-mobile")) return "mobile";
  if (types.includes("iphone")) return "iPhone";
  for (const t of ["work", "home", "main", "pager", "other", "school"]) if (types.includes(t)) return t;
  return types[0] ? cleanLabel(types[0]) : "";
}

function vDate(p: VProp): string | null {
  if ((p.params.VALUE ?? []).some((v) => v.toLowerCase() === "text")) return null;
  let v = text(p.value);
  if (/^\d{4}-?\d{2}-?\d{2}T/i.test(v)) v = v.split(/T/i)[0];
  const omitYear = p.params["X-APPLE-OMIT-YEAR"]?.[0];
  if (omitYear && v.startsWith(omitYear)) v = `--${v.slice(omitYear.length).replace(/^-/, "")}`;
  if (/^--\d{4}$/.test(v)) v = `--${v.slice(2, 4)}-${v.slice(4)}`;
  return parseDateInput(v);
}

const REL_V4: Record<string, string> = {
  "co-worker": "colleague", colleague: "colleague", spouse: "spouse", sweetheart: "partner", partner: "partner",
  child: "child", parent: "parent", sibling: "sibling", friend: "friend", kin: "relative", acquaintance: "other",
  "co-resident": "other", neighbor: "other", contact: "other", met: "other", crush: "other", date: "partner",
  muse: "other", agent: "other", emergency: "other",
};

function cardToContact(props: VProp[]): ImportContact | null {
  const kind = props.find((p) => p.name === "KIND" || p.name === "X-ADDRESSBOOKSERVER-KIND");
  if (kind && /group|org/i.test(text(kind.value)) && kind.name !== "KIND") return null;
  if (kind && /^group$/i.test(text(kind.value))) return null;
  const labels = new Map<string, string>();
  for (const p of props) if (p.name === "X-ABLABEL" && p.group) labels.set(p.group, text(p.value));
  const c: ImportContact = { phones: [], emails: [], addresses: [], websites: [], dates: [], relationships: [], tags: [], groups: [] };
  const notes: string[] = [];
  let fn = "";
  for (const p of props) {
    const v = p.value;
    switch (p.name) {
      case "FN":
        fn = text(v);
        break;
      case "N": {
        const [last = "", first = "", middle = "", prefix = "", suffix = ""] = splitValue(v).map((x) => x.replace(/,/g, " ").trim());
        Object.assign(c, { last, first, middle, prefix, suffix });
        break;
      }
      case "NICKNAME":
        c.nickname = splitValue(v, ",")[0]?.trim() ?? "";
        break;
      case "ORG": {
        const [company = "", ...dept] = splitValue(v);
        c.company = company.trim();
        c.department = dept.filter(Boolean).join(", ").trim();
        break;
      }
      case "TITLE":
        c.title = text(v);
        break;
      case "ROLE":
        if (!c.title) c.title = text(v);
        break;
      case "TEL": {
        // 4.0 URIs carry the extension as ";ext=12" — show it the way people write it.
        const num = text(v).replace(/^tel:/i, "").replace(/;ext=(\d+)/i, " ext. $1").trim();
        if (num) c.phones!.push({ label: typeLabel(p, labels), value: num });
        break;
      }
      case "UID": {
        const u = text(v);
        if (u) c.uid = u;
        break;
      }
      case "PHOTO":
      case "LOGO": {
        if (p.name === "LOGO" && c.photo) break;
        const raw = v.trim();
        const enc = (p.params.ENCODING?.[0] ?? "").toLowerCase();
        if (/^data:image\//i.test(raw)) c.photo = raw.replace(/\s+/g, "");
        else if (enc === "b" || enc === "base64") {
          const t = (p.params.TYPE ?? []).find((x) => /^(image\/)?(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(x)) ?? "jpeg";
          const mime = t.includes("/") ? t.toLowerCase() : `image/${t.toLowerCase().replace("jpg", "jpeg")}`;
          c.photo = `data:${mime};base64,${raw.replace(/\s+/g, "")}`;
        }
        // A photo by URL (https://…) isn't fetched: imports work offline and don't call out.
        break;
      }
      case "EMAIL": {
        const e = text(v).replace(/^mailto:/i, "");
        if (e) c.emails!.push({ label: typeLabel(p, labels) || "", value: e });
        break;
      }
      case "ADR": {
        const [pobox = "", ext = "", street = "", city = "", region = "", postcode = "", country = ""] = splitValue(v).map((x) => x.trim());
        const streetLine = [ext, street, pobox ? `PO Box ${pobox.replace(/^po box\s*/i, "")}` : ""].filter(Boolean).join(", ");
        c.addresses!.push({ label: typeLabel(p, labels), street: streetLine, city, region, postcode, country });
        break;
      }
      case "URL":
      case "X-SOCIALPROFILE":
      case "IMPP": {
        const u = text(v);
        if (!u) break;
        const social = p.name === "X-SOCIALPROFILE" ? (p.params.TYPE?.[0] ?? "") : "";
        const label = social ? cleanLabel(social) : p.name === "IMPP" ? (u.split(":")[0] || "chat") : typeLabel(p, labels);
        c.websites!.push({ label: label.charAt(0).toUpperCase() + label.slice(1), value: u });
        break;
      }
      case "BDAY": {
        const d = vDate(p);
        if (d) c.birthday = d;
        else if (text(v)) notes.push(`Birthday: ${text(v)}`);
        break;
      }
      case "ANNIVERSARY":
      case "X-ANNIVERSARY":
      case "X-MS-ANNIVERSARY": {
        const d = vDate(p);
        if (d) c.dates!.push({ label: "Anniversary", date: d, kind: "anniversary" });
        break;
      }
      case "X-ABDATE": {
        const d = vDate(p);
        if (!d) break;
        const label = cleanLabel(labels.get(p.group) ?? "Date");
        c.dates!.push({ label, date: d, kind: /anniversary/i.test(label) ? "anniversary" : "other" });
        break;
      }
      case "NOTE":
        if (text(v)) notes.push(text(v));
        break;
      case "CATEGORIES":
        for (const t of splitValue(v, ",").map((x) => x.trim()).filter(Boolean)) {
          if (/^(mycontacts|my contacts|\* mycontacts)$/i.test(t)) continue;
          if (/^(starred|\* starred|favorites|favourites)$/i.test(t)) c.favorite = true;
          else c.tags!.push(t.replace(/^\* /, ""));
        }
        break;
      case "X-PHONETIC-FIRST-NAME":
        c.phonetic_first = text(v);
        break;
      case "X-PHONETIC-LAST-NAME":
        c.phonetic_last = text(v);
        break;
      case "PRONOUNS":
      case "X-PRONOUNS":
        c.pronouns = text(v);
        break;
      case "RELATED": {
        const name = text(v);
        if (!name || /^urn:|^https?:|^mailto:/i.test(name)) break;
        const t = (p.params.TYPE ?? []).find((x) => REL_V4[x]) ?? "";
        const rel = t ? { type: REL_V4[t] as never, label: "" } : relationFromLabel(labels.get(p.group) ?? "other");
        c.relationships!.push({ ...rel, name });
        break;
      }
      case "X-ABRELATEDNAMES": {
        const name = text(v);
        if (name) c.relationships!.push({ ...relationFromLabel(labels.get(p.group) ?? (p.params.TYPE?.[0] ?? "other")), name });
        break;
      }
      case "X-SPOUSE":
      case "X-MS-SPOUSE":
      case "X-EVOLUTION-SPOUSE":
        if (text(v)) c.relationships!.push({ type: "spouse", label: "", name: text(v) });
        break;
      case "X-MS-CHILD":
      case "X-CHILD":
        if (text(v)) c.relationships!.push({ type: "child", label: "", name: text(v) });
        break;
      default:
        break;
    }
  }
  if (!c.first && !c.last && fn) c.full_name = fn;
  if (notes.length) c.notes = notes.join("\n\n");
  return clampImport(c);
}

/** Every card in a .vcf file. */
export function parseVCards(input: string): ImportContact[] {
  const out: ImportContact[] = [];
  let depth = 0;
  let props: VProp[] = [];
  for (const line of unfold(input)) {
    const up = line.trim().toUpperCase();
    if (up === "BEGIN:VCARD") {
      depth++;
      if (depth === 1) props = [];
      continue;
    }
    if (up === "END:VCARD") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const c = cardToContact(props);
        if (c) out.push(c);
      }
      continue;
    }
    if (depth !== 1) continue; // AGENT cards and stray lines
    const p = parseLine(line);
    if (p) props.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ write

function esc(s: string): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

const encoder = new TextEncoder();

/** Fold at 75 octets without splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
      limit = 74; // the continuation's leading space counts
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function telType(label: string, v4: boolean): string | null {
  const l = label.toLowerCase();
  const map: Record<string, string> = {
    mobile: "cell", cell: "cell", iphone: "cell", home: "home", work: "work", main: "voice", pager: "pager",
    fax: "fax", "home fax": "home,fax", "work fax": "work,fax", other: "voice",
  };
  const t = map[l];
  if (!t) return null;
  return v4 ? t : t.toUpperCase();
}

function simpleType(label: string, v4: boolean): string | null {
  const l = label.toLowerCase();
  const t = ({ home: "home", personal: "home", work: "work", other: "other" } as Record<string, string>)[l];
  if (!t) return null;
  return v4 ? t : t.toUpperCase();
}

/** A date property: 4.0 basic form (``--MMDD`` without a year); 3.0 uses
 *  Apple's convention for "no year" (``1604-MM-DD`` + ``X-APPLE-OMIT-YEAR``),
 *  which iOS, macOS and Google read. */
function dateProp(name: string, s: string, v4: boolean): string {
  if (s.startsWith("--")) return v4 ? `${name}:--${s.slice(2, 4)}${s.slice(5, 7)}` : `${name};X-APPLE-OMIT-YEAR=1604:1604-${s.slice(2)}`;
  return v4 ? `${name}:${s.replace(/-/g, "")}` : `${name}:${s}`;
}

/** A vCard 4.0 TEL: a ``tel:`` URI (with ``;ext=``) when the number reads
 *  as a full one, else the number as written (text) — never mangled. */
function telValue(value: string, country: string): { param: string; value: string } {
  const [num, ext] = phoneParts(value, country);
  if (num) return { param: ";VALUE=uri", value: `tel:${num}${ext ? `;ext=${ext}` : ""}` };
  return { param: ";VALUE=text", value: esc(value) };
}

function photoProp(photo: string, v4: boolean): string | null {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(photo);
  if (!m) return null;
  return v4 ? `PHOTO:${photo}` : `PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`;
}

function rev(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Contacts → one .vcf text (CRLF, folded). */
export function toVCards(
  contacts: Contact[],
  groups: Group[],
  version: "3.0" | "4.0" = "3.0",
  byId?: Map<string, Contact>,
  country: string = DEFAULT_COUNTRY,
): string {
  const v4 = version === "4.0";
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const cards: string[] = [];
  for (const c of contacts) {
    const lines: string[] = ["BEGIN:VCARD", `VERSION:${version}`];
    let item = 0;
    const custom = (prop: string, value: string, label: string) => {
      item += 1;
      lines.push(`item${item}.${prop}:${value}`, `item${item}.X-ABLABEL:${esc(label)}`);
    };
    if (v4) lines.push("KIND:individual");
    // The card's own UID when it came with one (so the other app re-matches
    // it), else ours — either way a re-import here finds the same person.
    lines.push(`UID:${esc(c.uid || `promptly-${c.id}`)}`);
    lines.push(`FN:${esc(displayName(c))}`);
    lines.push(`N:${[c.last, c.first, c.middle, c.prefix, c.suffix].map(esc).join(";")}`);
    if (c.nickname) lines.push(`NICKNAME:${esc(c.nickname)}`);
    if (c.phonetic_first) lines.push(`X-PHONETIC-FIRST-NAME:${esc(c.phonetic_first)}`);
    if (c.phonetic_last) lines.push(`X-PHONETIC-LAST-NAME:${esc(c.phonetic_last)}`);
    if (v4 && c.pronouns) lines.push(`PRONOUNS:${esc(c.pronouns)}`);
    if (c.company || c.department) lines.push(`ORG:${esc(c.company)}${c.department ? `;${esc(c.department)}` : ""}`);
    if (c.title) lines.push(`TITLE:${esc(c.title)}`);
    c.phones.forEach((p: Labeled, i) => {
      const t = telType(p.label, v4);
      const pref = i === 0 ? (v4 ? ";PREF=1" : ",PREF") : "";
      const tv = v4 ? telValue(p.value, country) : { param: "", value: esc(p.value) };
      if (t || !p.label) lines.push(`TEL${tv.param};TYPE=${t ?? (v4 ? "voice" : "VOICE")}${pref}:${tv.value}`);
      else custom(`TEL${tv.param}`, tv.value, p.label);
    });
    c.emails.forEach((e, i) => {
      const t = simpleType(e.label, v4);
      if (e.label && !t) {
        custom("EMAIL", esc(e.value), e.label);
        return;
      }
      const types = v4 ? [t] : ["INTERNET", t, i === 0 ? "PREF" : null];
      const typeParam = types.filter(Boolean).join(",");
      const params = `${typeParam ? `;TYPE=${typeParam}` : ""}${v4 && i === 0 ? ";PREF=1" : ""}`;
      lines.push(`EMAIL${params}:${esc(e.value)}`);
    });
    for (const a of c.addresses) {
      const value = ["", "", a.street, a.city, a.region, a.postcode, a.country].map(esc).join(";");
      const t = simpleType(a.label, v4);
      if (t || !a.label) lines.push(`ADR${t ? `;TYPE=${t}` : ""}:${value}`);
      else custom("ADR", value, a.label);
    }
    for (const w of c.websites) {
      if (!w.label || /^(website|homepage|home page)$/i.test(w.label)) lines.push(`URL:${esc(w.value)}`);
      else custom("URL", esc(w.value), w.label);
    }
    if (c.birthday) lines.push(dateProp("BDAY", c.birthday, v4));
    let anniversaryDone = false;
    for (const d of c.dates) {
      if (d.kind === "anniversary" && !anniversaryDone && /^anniversary$/i.test(d.label || "anniversary")) {
        anniversaryDone = true;
        lines.push(dateProp(v4 ? "ANNIVERSARY" : "X-ANNIVERSARY", d.date, v4));
      } else {
        // Apple's X-ABDATE is always the dashed 3.0 form.
        const [prop, value] = dateProp("X-ABDATE", d.date, false).split(/:(.*)/s);
        custom(prop, value, d.label || (d.kind === "anniversary" ? "Anniversary" : "Other"));
      }
    }
    for (const r of c.relationships) {
      const other = r.contact_id ? byId?.get(r.contact_id) : undefined;
      const name = other ? displayName(other) : r.name;
      if (!name) continue;
      if (v4) {
        const t = ({ partner: "sweetheart", spouse: "spouse", child: "child", parent: "parent", sibling: "sibling", friend: "friend", colleague: "co-worker", relative: "kin" } as Record<string, string>)[r.type];
        lines.push(`RELATED;VALUE=text${t ? `;TYPE=${t}` : ""}:${esc(name)}`);
      } else {
        const label = r.label || ({ partner: "_$!<Partner>!$_", spouse: "_$!<Spouse>!$_", child: "_$!<Child>!$_", parent: "_$!<Parent>!$_", sibling: "_$!<Sibling>!$_", friend: "_$!<Friend>!$_", manager: "_$!<Manager>!$_", report: "_$!<Assistant>!$_" } as Record<string, string>)[r.type] || r.type;
        custom("X-ABRELATEDNAMES", esc(name), label);
      }
    }
    const cats = [...c.tags, ...c.groups.map((g) => gname.get(g) ?? "").filter(Boolean)];
    if (cats.length) lines.push(`CATEGORIES:${cats.map(esc).join(",")}`);
    const noteBits = [c.notes];
    if (c.met_how || c.met_where) noteBits.push(`How we met: ${[c.met_how, c.met_where, c.met_date].filter(Boolean).join(" · ")}`);
    const note = noteBits.filter(Boolean).join("\n\n");
    if (note) lines.push(`NOTE:${esc(note)}`);
    if (c.photo) {
      const ph = photoProp(c.photo, v4);
      if (ph) lines.push(ph);
    }
    const r = rev(c.updated_at);
    if (r) lines.push(`REV:${r}`);
    lines.push("END:VCARD");
    cards.push(lines.map(foldLine).join("\r\n"));
  }
  return cards.join("\r\n") + (cards.length ? "\r\n" : "");
}

// ------------------------------------------------------------- self-check

/**
 * A quick check of the reader and writer (no test runner in the frontend).
 * Returns the failures — an empty list means all good. In dev it's on
 * ``window.__contactsVcardSelfCheck``.
 */
export function vcardSelfCheck(): string[] {
  const fails: string[] = [];
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const sample = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Rivera;Sam;Q.;Dr;Jr.",
    "FN:Dr Sam Q. Rivera Jr.",
    "ORG:Atlassian;Product",
    "TITLE:Product Manager",
    "TEL;TYPE=CELL,VOICE,PREF:+61 400 123 456",
    "TEL;TYPE=work;TYPE=fax:02 9999 0000",
    "item1.TEL:0411 000 111",
    "item1.X-ABLABEL:_$!<Other>!$_",
    "item2.TEL:0422 000 222",
    "item2.X-ABLABEL:Studio",
    "EMAIL;TYPE=INTERNET,WORK:sam@atlassian.com",
    "ADR;TYPE=HOME:;;1 Long Street\\, Unit 4;Sydney;NSW;2000;Australia",
    "BDAY:--0315",
    "item3.X-ABDATE:2016-11-20",
    "item3.X-ABLABEL:_$!<Anniversary>!$_",
    "item4.X-ABRELATEDNAMES:Mia",
    "item4.X-ABLABEL:_$!<Daughter>!$_",
    "CATEGORIES:myContacts,Friends,Climbing",
    "NOTE:Line one\\nLine two with a very long note that has to be folded acro",
    " ss two physical lines.",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:2.1",
    "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;",
    "TEL;CELL:0400111222",
    "NOTE;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 =",
    "au lait",
    "BDAY:19800102",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:Ana Lima",
    "BDAY;X-APPLE-OMIT-YEAR=1604:1604-07-04",
    "ANNIVERSARY:20100605",
    "RELATED;TYPE=spouse;VALUE=text:João",
    "PRONOUNS:she/her",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "X-ADDRESSBOOKSERVER-KIND:group",
    "FN:A group",
    "END:VCARD",
  ].join("\r\n");
  const got = parseVCards(sample);
  eq("cards", got.length, 3);
  const [a, b, c] = got;
  eq("name", [a?.prefix, a?.first, a?.middle, a?.last, a?.suffix], ["Dr", "Sam", "Q.", "Rivera", "Jr."]);
  eq("org", [a?.company, a?.department, a?.title], ["Atlassian", "Product", "Product Manager"]);
  eq("phones", a?.phones?.map((p) => [p.label, p.value]), [["mobile", "+61 400 123 456"], ["work fax", "02 9999 0000"], ["other", "0411 000 111"], ["Studio", "0422 000 222"]]);
  eq("email", a?.emails?.[0], { label: "work", value: "sam@atlassian.com" });
  eq("adr", a?.addresses?.[0]?.street, "1 Long Street, Unit 4");
  eq("bday --MMDD", a?.birthday, "--03-15");
  eq("abdate", a?.dates?.[0], { label: "Anniversary", date: "2016-11-20", kind: "anniversary" });
  eq("related", a?.relationships?.[0], { type: "child", name: "Mia", label: "Daughter" });
  eq("tags", a?.tags, ["Friends", "Climbing"]);
  eq("folded note", a?.notes, "Line one\nLine two with a very long note that has to be folded across two physical lines.");
  eq("qp name", [b?.first, b?.last], ["Jürgen", "Müller"]);
  eq("qp soft break", b?.notes, "Café au lait");
  eq("2.1 bare type", b?.phones?.[0]?.label, "mobile");
  eq("bday basic", b?.birthday, "1980-01-02");
  eq("fn only", c?.full_name, "Ana Lima");
  eq("apple omit year", c?.birthday, "--07-04");
  eq("v4 anniversary", c?.dates?.[0]?.date, "2010-06-05");
  eq("v4 related", c?.relationships?.[0], { type: "spouse", name: "João", label: "" });
  eq("pronouns", c?.pronouns, "she/her");
  // Round trip through the writer, both versions.
  const contact: Contact = {
    id: "x1", prefix: "", first: "Zoë", middle: "", last: "O'Neil; Jr", suffix: "", nickname: "Zo", pronouns: "they/them",
    promptly_user_id: "",
    promptly_username: "",
    phonetic_first: "", phonetic_last: "", company: "Acme, Inc.", title: "CTO", department: "", birthday: "--02-29",
    phones: [{ label: "mobile", value: "+44 7700 900123" }, { label: "Boat", value: "123" }],
    emails: [{ label: "work", value: "zo@acme.test" }], addresses: [], websites: [{ label: "LinkedIn", value: "https://linkedin.com/in/zo" }],
    dates: [{ id: "d1", label: "Anniversary", date: "2012-05-01", kind: "anniversary", remind: true }],
    met_how: "", met_where: "", met_date: null, relationships: [{ id: "r", type: "partner", contact_id: null, name: "Kai", label: "" }],
    tags: ["vip"], groups: [], notes: "Ünïcode ".repeat(30), favorite: false, color: null, created_at: "", updated_at: "2026-10-31T10:00:00Z",
    interactions: [], cadence_days: null, snoozed_until: null, gifts: [], remember: [], topics: [],
    photo: "data:image/jpeg;base64," + "QUJD".repeat(40), uid: "", import_ref: "",
  };
  contact.phones.push({ label: "work", value: "(02) 9999 0000 ext. 12" });
  for (const v of ["3.0", "4.0"] as const) {
    const out = toVCards([contact], [], v);
    if (out.split("\r\n").some((l) => encoder.encode(l).length > 75)) fails.push(`${v}: a line is over 75 octets`);
    const back = parseVCards(out)[0];
    eq(`${v} name`, [back?.first, back?.last, back?.nickname], ["Zoë", "O'Neil; Jr", "Zo"]);
    eq(`${v} company`, back?.company, "Acme, Inc.");
    eq(`${v} bday`, back?.birthday, "--02-29");
    eq(`${v} custom label`, back?.phones?.[1], { label: "Boat", value: "123" });
    eq(`${v} website`, back?.websites?.[0]?.label, "LinkedIn");
    eq(`${v} anniversary`, back?.dates?.[0]?.date, "2012-05-01");
    eq(`${v} partner`, back?.relationships?.[0]?.name, "Kai");
    eq(`${v} note`, back?.notes, contact.notes.trim());
    eq(`${v} photo`, back?.photo, contact.photo);
    eq(`${v} uid`, back?.uid, "promptly-x1");
    eq(`${v} extension kept`, back?.phones?.[2]?.value, v === "4.0" ? "+61299990000 ext. 12" : "(02) 9999 0000 ext. 12");
  }
  const v3 = toVCards([contact], [], "3.0");
  if (!v3.includes("BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29")) fails.push("3.0 no-year birthday isn't Apple's 1604 form");
  const v4 = toVCards([contact], [], "4.0", undefined, "AU");
  if (!v4.includes("tel:+61299990000;ext=12")) fails.push("4.0 tel URI lost the extension");
  return fails;
}
