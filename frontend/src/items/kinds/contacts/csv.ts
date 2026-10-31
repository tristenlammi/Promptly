/*
 * CSV — read Google Contacts (new and old exports), Outlook and simple
 * "Name, Email, Phone" sheets; write Google Contacts CSV. Pure.
 */
import { clampImport, relationFromLabel, type ImportContact } from "./importing";
import { displayName, parseDateInput } from "./model";
import type { Contact, Group } from "./types";

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes, BOM, ; or tab separators. */
export function parseCSV(input: string): string[][] {
  const textIn = input.replace(/^﻿/, "");
  const firstLine = textIn.slice(0, textIn.indexOf("\n") >= 0 ? textIn.indexOf("\n") : undefined);
  const counts = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i];
    if (q) {
      if (ch === '"') {
        if (textIn[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") q = true;
    else if (ch === sep) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && textIn[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const multi = (v: string) => v.split(/\s*:::\s*/).map((x) => x.trim()).filter(Boolean);
const label = (v: string) => v.replace(/^\*\s*/, "").trim().toLowerCase().replace(/^cell$/, "mobile");

export type CsvFormat = "google" | "outlook" | "generic";

export function detectFormat(headers: string[]): CsvFormat {
  const h = headers.map((x) => x.trim().toLowerCase());
  if (h.some((x) => /^(e-mail|phone|address|organization|website|relation|event) \d+ - /.test(x)) || h.includes("labels") || h.includes("group membership")) return "google";
  if (h.includes("e-mail address") || h.includes("business phone") || h.includes("mobile phone") || h.includes("job title")) return "outlook";
  return "generic";
}

function googleRow(get: (k: string) => string, headers: string[], row: string[]): ImportContact {
  const c: ImportContact = {
    first: get("first name") || get("given name"),
    middle: get("middle name") || get("additional name"),
    last: get("last name") || get("family name"),
    prefix: get("name prefix"),
    suffix: get("name suffix"),
    nickname: get("nickname"),
    phonetic_first: get("phonetic first name") || get("given name yomi"),
    phonetic_last: get("phonetic last name") || get("family name yomi"),
    company: get("organization name"),
    title: get("organization title"),
    department: get("organization department"),
    notes: get("notes"),
    phones: [],
    emails: [],
    addresses: [],
    websites: [],
    dates: [],
    relationships: [],
    tags: [],
  };
  if (!c.first && !c.last && get("name")) c.full_name = get("name");
  const bd = get("birthday");
  if (bd) c.birthday = parseDateInput(bd.replace(/^ --/, "--"), false);
  for (const t of multi(get("labels") || get("group membership"))) {
    const tag = t.replace(/^\*\s*/, "");
    if (/^mycontacts$|^my contacts$/i.test(tag)) continue;
    if (/^starred$/i.test(tag)) c.favorite = true;
    else c.tags!.push(tag);
  }
  // Numbered columns: "Phone 2 - Value", "Organization 1 - Name"…
  const groups = new Map<string, Record<string, string>>();
  headers.forEach((h, i) => {
    const m = /^(e-mail|phone|address|website|relation|event|organization|custom field) (\d+) - (.+)$/i.exec(h.trim());
    if (!m || !row[i]?.trim()) return;
    const key = `${m[1].toLowerCase()} ${m[2]}`;
    const g = groups.get(key) ?? {};
    g[m[3].trim().toLowerCase()] = row[i].trim();
    groups.set(key, g);
  });
  for (const [key, g] of groups) {
    const kind = key.replace(/ \d+$/, "");
    const lab = label(g.label ?? g.type ?? "");
    if (kind === "e-mail") for (const v of multi(g.value ?? "")) c.emails!.push({ label: lab, value: v });
    else if (kind === "phone") for (const v of multi(g.value ?? "")) c.phones!.push({ label: lab, value: v });
    else if (kind === "website") for (const v of multi(g.value ?? "")) c.websites!.push({ label: lab ? lab[0].toUpperCase() + lab.slice(1) : "", value: v });
    else if (kind === "address") {
      const street = [g["extended address"], g.street, g["po box"] ? `PO Box ${g["po box"]}` : ""].filter(Boolean).join(", ");
      if (street || g.city || g.region || g["postal code"] || g.country)
        c.addresses!.push({ label: lab, street, city: g.city ?? "", region: g.region ?? "", postcode: g["postal code"] ?? "", country: g.country ?? "" });
      else if (g.formatted) c.addresses!.push({ label: lab, street: g.formatted.replace(/\n/g, ", "), city: "", region: "", postcode: "", country: "" });
    } else if (kind === "relation") {
      for (const v of multi(g.value ?? "")) c.relationships!.push({ ...relationFromLabel(g.label ?? g.type ?? "other"), name: v });
    } else if (kind === "event") {
      const d = parseDateInput((g.value ?? "").replace(/^ --/, "--"), false);
      if (d) c.dates!.push({ label: (g.label ?? g.type ?? "").replace(/^\*\s*/, "") || "Date", date: d, kind: /anniversary/i.test(g.label ?? g.type ?? "") ? "anniversary" : "other" });
    } else if (kind === "organization") {
      c.company = c.company || g.name || "";
      c.title = c.title || g.title || "";
      c.department = c.department || g.department || "";
    } else if (kind === "custom field" && g.value) {
      c.notes = [c.notes, `${g.label ?? "Note"}: ${g.value}`].filter(Boolean).join("\n");
    }
  }
  return c;
}

/** How numeric dates are written in this file ("03/04/1990"). */
export type DateOrder = "dmy" | "mdy" | "ambiguous" | "none";

/** Day-first if any first part is over 12, month-first if any second part
 *  is; "ambiguous" when every date could be read either way. */
export function detectDateOrder(values: string[]): DateOrder {
  let seen = false;
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?\s*$/.exec(v);
    if (!m) continue;
    seen = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (!seen) return "none";
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  return "ambiguous";
}

/** Countries that usually write the month first (03/04 = March 4). */
export const MONTH_FIRST_COUNTRIES = new Set(["US", "PH", "CA"]);

function outlookRow(get: (k: string) => string, dayFirst: boolean): ImportContact {
  const phones: [string, string][] = [
    ["mobile phone", "mobile"], ["home phone", "home"], ["home phone 2", "home"], ["business phone", "work"],
    ["business phone 2", "work"], ["primary phone", "main"], ["company main phone", "main"], ["other phone", "other"],
    ["pager", "pager"], ["business fax", "work fax"], ["home fax", "home fax"], ["car phone", "car"],
  ];
  const addr = (prefix: string, lab: string) => ({
    label: lab,
    street: [get(`${prefix} street`), get(`${prefix} street 2`), get(`${prefix} street 3`)].filter(Boolean).join(", "),
    city: get(`${prefix} city`),
    region: get(`${prefix} state`),
    postcode: get(`${prefix} postal code`),
    country: get(`${prefix} country/region`) || get(`${prefix} country`),
  });
  const date = (v: string) => (v && !/^0\/0\/00$/.test(v) ? parseDateInput(v, dayFirst) : null);
  const c: ImportContact = {
    prefix: get("title"),
    first: get("first name"),
    middle: get("middle name"),
    last: get("last name"),
    suffix: get("suffix"),
    nickname: get("nickname"),
    phonetic_first: get("given yomi"),
    phonetic_last: get("surname yomi"),
    company: get("company"),
    title: get("job title"),
    department: get("department"),
    notes: get("notes"),
    emails: ["e-mail address", "e-mail 2 address", "e-mail 3 address"].map((k, i) => ({ label: i === 0 ? "" : "other", value: get(k) })),
    phones: phones.map(([k, l]) => ({ label: l, value: get(k) })),
    addresses: [addr("home", "home"), addr("business", "work"), addr("other", "other")],
    websites: [get("web page") && { label: "", value: get("web page") }, get("personal web page") && { label: "personal", value: get("personal web page") }].filter(Boolean) as { label: string; value: string }[],
    birthday: date(get("birthday")),
    dates: [],
    relationships: [],
    tags: get("categories").split(/[;,]/).map((t) => t.trim()).filter(Boolean),
  };
  const ann = date(get("anniversary"));
  if (ann) c.dates!.push({ label: "Anniversary", date: ann, kind: "anniversary" });
  if (get("spouse")) c.relationships!.push({ type: "spouse", label: "", name: get("spouse") });
  for (const kid of get("children").split(/[;,]/).map((x) => x.trim()).filter(Boolean)) c.relationships!.push({ type: "child", label: "", name: kid });
  if (get("manager's name")) c.relationships!.push({ type: "manager", label: "", name: get("manager's name") });
  return c;
}

const GENERIC: Record<string, string[]> = {
  full_name: ["name", "full name", "display name", "contact name", "fullname"],
  first: ["first name", "first", "given name", "firstname", "forename"],
  last: ["last name", "last", "surname", "family name", "lastname"],
  middle: ["middle name", "middle"],
  nickname: ["nickname", "nick"],
  company: ["company", "organization", "organisation", "employer", "company name", "org"],
  title: ["job title", "title", "position", "role"],
  department: ["department", "dept"],
  email: ["email", "e-mail", "email address", "e-mail address", "mail", "work email", "personal email"],
  phone: ["phone", "mobile", "cell", "telephone", "phone number", "mobile phone", "tel", "work phone", "home phone"],
  birthday: ["birthday", "date of birth", "dob", "birth date", "birthdate"],
  notes: ["notes", "note", "comments", "comment"],
  tags: ["tags", "labels", "categories", "groups", "group", "tag"],
  website: ["website", "url", "web", "web page", "homepage", "linkedin"],
  street: ["address", "street", "street address", "address 1"],
  city: ["city", "town", "suburb"],
  region: ["state", "region", "province", "county"],
  postcode: ["zip", "zip code", "postcode", "postal code", "post code"],
  country: ["country", "country/region"],
  met_how: ["how we met", "met", "source"],
};

function genericRow(headers: string[], row: string[], dayFirst: boolean): ImportContact {
  const h = headers.map((x) => x.trim().toLowerCase());
  const pick = (field: string) => {
    const names = GENERIC[field];
    const out: { header: string; value: string }[] = [];
    h.forEach((name, i) => {
      if (names.includes(name) && row[i]?.trim()) out.push({ header: name, value: row[i].trim() });
    });
    return out;
  };
  const one = (f: string) => pick(f)[0]?.value ?? "";
  const c: ImportContact = {
    first: one("first"),
    last: one("last"),
    middle: one("middle"),
    nickname: one("nickname"),
    company: one("company"),
    title: one("title"),
    department: one("department"),
    notes: one("notes"),
    met_how: one("met_how"),
    emails: pick("email").flatMap((e) => e.value.split(/[;,\s]+/).filter((x) => x.includes("@")).map((v) => ({ label: /work/.test(e.header) ? "work" : "", value: v }))),
    phones: pick("phone").map((p) => ({ label: /mobile|cell/.test(p.header) ? "mobile" : /work/.test(p.header) ? "work" : /home/.test(p.header) ? "home" : "", value: p.value })),
    websites: pick("website").map((w) => ({ label: w.header === "linkedin" ? "LinkedIn" : "", value: w.value })),
    addresses: [{ label: "", street: one("street"), city: one("city"), region: one("region"), postcode: one("postcode"), country: one("country") }],
    birthday: one("birthday") ? parseDateInput(one("birthday"), dayFirst) : null,
    tags: pick("tags").flatMap((t) => t.value.split(/[;,|]/).map((x) => x.trim()).filter(Boolean)),
  };
  if (!c.first && !c.last) c.full_name = one("full_name");
  return c;
}

export interface CsvResult {
  contacts: ImportContact[];
  format: CsvFormat;
  skipped: number;
  /** What the file's numeric dates look like… */
  dateOrder: DateOrder;
  /** …and how they were read. */
  dayFirst: boolean;
}

/**
 * Read a CSV. Numeric dates (Outlook writes them in the exporting PC's
 * locale) are read day-first or month-first from the file itself when it
 * shows which (a first part over 12 → day-first); otherwise ``dayFirst``
 * (the caller asks the person, or uses their country) decides.
 */
export function csvToContacts(input: string, { dayFirst }: { dayFirst?: boolean } = {}): CsvResult {
  const rows = parseCSV(input);
  if (rows.length < 2) return { contacts: [], format: "generic", skipped: 0, dateOrder: "none", dayFirst: dayFirst ?? true };
  const headers = rows[0];
  const format = detectFormat(headers);
  const index = new Map(headers.map((h, i) => [h.trim().toLowerCase(), i]));
  const dateCols = (format === "outlook" ? ["birthday", "anniversary"] : format === "generic" ? GENERIC.birthday : [])
    .map((k) => index.get(k))
    .filter((i): i is number => i !== undefined);
  const dateOrder = detectDateOrder(rows.slice(1).flatMap((r) => dateCols.map((i) => r[i] ?? "")));
  const df = dateOrder === "dmy" ? true : dateOrder === "mdy" ? false : dayFirst ?? true;
  const out: ImportContact[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (k: string) => (index.has(k) ? (row[index.get(k)!] ?? "").trim() : "");
    const raw = format === "google" ? googleRow(get, headers, row) : format === "outlook" ? outlookRow(get, df) : genericRow(headers, row, df);
    const c = clampImport(raw);
    if (c) out.push(c);
    else skipped += 1;
  }
  return { contacts: out, format, skipped, dateOrder, dayFirst: df };
}

// ------------------------------------------------------------------ write

function cell(v: string): string {
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function googleDate(s: string | null): string {
  if (!s) return "";
  return s.startsWith("--") ? ` ${s}` : s; // Google writes year-less dates as " --MM-DD"
}

/** Contacts → a Google Contacts CSV (imports into Google, Outlook and most apps). */
export function toGoogleCSV(contacts: Contact[], groups: Group[], byId?: Map<string, Contact>): string {
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const n = (k: keyof Contact) => Math.max(1, ...contacts.map((c) => (c[k] as unknown[]).length));
  const [ne, np, na, nw, nr, nd] = [n("emails"), n("phones"), n("addresses"), n("websites"), n("relationships"), n("dates")];
  const headers = [
    "First Name", "Middle Name", "Last Name", "Phonetic First Name", "Phonetic Last Name", "Name Prefix", "Name Suffix",
    "Nickname", "Organization Name", "Organization Title", "Organization Department", "Birthday", "Notes", "Labels",
  ];
  for (let i = 1; i <= ne; i++) headers.push(`E-mail ${i} - Label`, `E-mail ${i} - Value`);
  for (let i = 1; i <= np; i++) headers.push(`Phone ${i} - Label`, `Phone ${i} - Value`);
  for (let i = 1; i <= na; i++) headers.push(`Address ${i} - Label`, `Address ${i} - Street`, `Address ${i} - City`, `Address ${i} - Region`, `Address ${i} - Postal Code`, `Address ${i} - Country`);
  for (let i = 1; i <= nw; i++) headers.push(`Website ${i} - Label`, `Website ${i} - Value`);
  for (let i = 1; i <= nr; i++) headers.push(`Relation ${i} - Label`, `Relation ${i} - Value`);
  for (let i = 1; i <= nd; i++) headers.push(`Event ${i} - Label`, `Event ${i} - Value`);
  const lines = [headers.map(cell).join(",")];
  for (const c of contacts) {
    const labels = ["* myContacts", ...(c.favorite ? ["* starred"] : []), ...c.tags, ...c.groups.map((g) => gname.get(g) ?? "").filter(Boolean)];
    const row = [
      c.first, c.middle, c.last, c.phonetic_first, c.phonetic_last, c.prefix, c.suffix, c.nickname, c.company, c.title, c.department,
      googleDate(c.birthday), c.notes, labels.join(" ::: "),
    ];
    for (let i = 0; i < ne; i++) row.push(c.emails[i]?.label ?? "", c.emails[i]?.value ?? "");
    for (let i = 0; i < np; i++) row.push(c.phones[i]?.label ? c.phones[i].label[0].toUpperCase() + c.phones[i].label.slice(1) : "", c.phones[i]?.value ?? "");
    for (let i = 0; i < na; i++) {
      const a = c.addresses[i];
      row.push(a?.label ?? "", a?.street ?? "", a?.city ?? "", a?.region ?? "", a?.postcode ?? "", a?.country ?? "");
    }
    for (let i = 0; i < nw; i++) row.push(c.websites[i]?.label ?? "", c.websites[i]?.value ?? "");
    for (let i = 0; i < nr; i++) {
      const r = c.relationships[i];
      const other = r?.contact_id ? byId?.get(r.contact_id) : undefined;
      row.push(r ? r.label || r.type : "", r ? (other ? displayName(other) : r.name) : "");
    }
    for (let i = 0; i < nd; i++) row.push(c.dates[i]?.label ?? "", googleDate(c.dates[i]?.date ?? null));
    lines.push(row.map((v) => cell(v ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** A quick check of the CSV reader (see ``vcardSelfCheck``). */
export function csvSelfCheck(): string[] {
  const fails: string[] = [];
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const google = [
    "First Name,Last Name,Birthday,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Notes,Relation 1 - Label,Relation 1 - Value",
    'Sam,Rivera, --03-15,* myContacts ::: Friends ::: * starred,* Work,sam@a.com ::: sam@b.com,Mobile,+61 400 1,"Line 1\nLine ""2""",Spouse,Jo',
  ].join("\n");
  const g = csvToContacts(google);
  eq("google format", g.format, "google");
  eq("google name", [g.contacts[0]?.first, g.contacts[0]?.last], ["Sam", "Rivera"]);
  eq("google bday", g.contacts[0]?.birthday, "--03-15");
  eq("google labels", [g.contacts[0]?.tags, g.contacts[0]?.favorite], [["Friends"], true]);
  eq("google emails", g.contacts[0]?.emails?.map((e) => e.value), ["sam@a.com", "sam@b.com"]);
  eq("google note", g.contacts[0]?.notes, 'Line 1\nLine "2"');
  eq("google relation", g.contacts[0]?.relationships?.[0]?.type, "spouse");
  const outlook = "First Name,Last Name,E-mail Address,Mobile Phone,Business Phone,Job Title,Company,Birthday,Title\nAna,Lima,ana@x.com,0400,02 9000,CTO,Acme,3/15/1990,Dr\n";
  const o = csvToContacts(outlook);
  eq("outlook format", o.format, "outlook");
  eq("outlook fields", [o.contacts[0]?.prefix, o.contacts[0]?.title, o.contacts[0]?.birthday, o.contacts[0]?.phones?.length], ["Dr", "CTO", "1990-03-15", 2]);
  // An Australian Outlook writes day-first: one 15/03 in the file settles it for every row.
  const au = csvToContacts("First Name,Birthday\nA,15/03/1990\nB,04/05/1985\n");
  eq("day-first file", [au.dateOrder, au.contacts[1]?.birthday], ["dmy", "1985-05-04"]);
  const amb = csvToContacts("First Name,Birthday\nA,04/05/1985\n", { dayFirst: false });
  eq("ambiguous, month-first chosen", [amb.dateOrder, amb.contacts[0]?.birthday], ["ambiguous", "1985-04-05"]);
  const generic = csvToContacts("Name;Email;Phone\nKai Moana;kai@x.com;021 555\n;;\n");
  eq("generic", [generic.format, generic.contacts[0]?.full_name, generic.contacts[0]?.emails?.[0]?.value, generic.contacts.length], ["generic", "Kai Moana", "kai@x.com", 1]);
  return fails;
}
