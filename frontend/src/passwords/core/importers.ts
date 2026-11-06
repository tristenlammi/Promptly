// Bring passwords in from elsewhere. Everything is parsed here on the device; a file
// is never uploaded. Written from each format's public documentation and observed
// files, with no code from those projects. Every parser treats its input as hostile:
// size limits, no recursion without a bound, and nothing is executed or rendered.
import { strFromU8, unzipSync } from "fflate";

import { fromB64u, fromUtf8 } from "./bytes";
import { SYSTEM_KINDS, type CustomField, type ItemBody, type LoginUrl, newBody, type Passkey, type TotpConfig } from "./model";
import { parseMigrationUri, parseOtpauth } from "./totp";

export type Imported = { body: ItemBody; folder?: string };
export type ImportResult = { format: string; items: Imported[]; warnings: string[] };

export class NeedsPasswordError extends Error {
  constructor(public format: string) {
    super("This file is protected by a password");
  }
}

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ITEMS = 200_000;

// ---- CSV ---------------------------------------------------------------------

/** RFC 4180 with the usual messes: BOM, CRLF or LF, quotes in the middle of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > MAX_ITEMS) throw new Error("That file has too many rows");
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Synonyms for fuzzy columns, most specific first.
const COLUMNS: Record<string, string[]> = {
  title: ["name", "title", "item", "itemname", "account", "accountname", "site", "sitename", "service", "entry", "label", "group/title"],
  url: ["url", "website", "uri", "loginuri", "web", "address", "origin", "hostname", "host", "loginurl", "domain", "siteurl", "formactionorigin"],
  username: ["username", "user", "login", "loginname", "loginusername", "email", "emailaddress", "userid", "usernameemail"],
  password: ["password", "pass", "pwd", "passwd", "loginpassword", "secret"],
  otp: ["otpauth", "otp", "totp", "otpurl", "logintotp", "authenticator", "2fa", "twofactor", "onetimepassword", "verificationcode", "totpuri"],
  notes: ["notes", "note", "extra", "comments", "comment", "description"],
  folder: ["folder", "group", "grouping", "category", "vault"],
  tags: ["tags", "tag", "labels"],
  fav: ["favorite", "favourite", "fav", "starred"],
};

function columnsOf(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const n = header.map(norm);
  for (const [key, names] of Object.entries(COLUMNS)) {
    for (const name of names) {
      const at = n.indexOf(name.replace(/[^a-z0-9]/g, ""));
      if (at >= 0) {
        idx[key] = at;
        break;
      }
    }
  }
  return idx;
}

function cleanUrl(u: string): LoginUrl[] {
  const t = u.trim();
  if (!t || t === "http://sn" || t === "http://" || t === "https://") return [];
  return [{ url: t }];
}

function titleFrom(title: string | undefined, url: string | undefined, user: string | undefined): string {
  if (title?.trim()) return title.trim();
  if (url) {
    try {
      return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    } catch {
      /* fall through */
    }
  }
  return user?.trim() || "Imported login";
}

function otpFrom(text: string | undefined, warnings: string[], name: string): TotpConfig | null {
  const t = text?.trim();
  if (!t) return null;
  try {
    if (t.startsWith("otpauth://") || t.startsWith("steam://")) return parseOtpauth(t);
    const secret = t.toUpperCase().replace(/\s/g, "");
    if (/^[A-Z2-7]+=*$/.test(secret)) return { secret };
    warnings.push(`${name}: its 2FA secret wasn't in a form we can read.`);
  } catch (e) {
    warnings.push(`${name}: ${(e as Error).message}`);
  }
  return null;
}

export function fromGenericCsv(text: string, format = "CSV"): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 1) return { format, items: [], warnings: ["That file is empty."] };
  const idx = columnsOf(rows[0]);
  const warnings: string[] = [];
  if (idx.password === undefined && idx.username === undefined && idx.url === undefined) {
    throw new Error("We couldn't find a password, username or website column in that file.");
  }
  const items: Imported[] = [];
  rows.slice(1).forEach((r, line) => {
    if (r.every((c) => !c.trim())) return;
    const get = (k: string) => (idx[k] !== undefined ? r[idx[k]] ?? "" : "");
    const url = get("url");
    const username = get("username");
    const password = get("password");
    const title = titleFrom(get("title"), url, username);
    if (!password && !username && !url && !get("notes")) {
      warnings.push(`Line ${line + 2}: nothing usable, skipped.`);
      return;
    }
    const totp = otpFrom(get("otp"), warnings, title);
    // Everything else in the row is kept as a field rather than dropped.
    const known = new Set(Object.values(idx));
    const fields: CustomField[] = [];
    rows[0].forEach((h, i) => {
      if (!known.has(i) && r[i]?.trim()) fields.push({ name: h.trim() || `Column ${i + 1}`, value: r[i], type: "text" });
    });
    const body = newBody("login", title, {
      username: username || undefined,
      password: password || undefined,
      urls: cleanUrl(url),
      notes: get("notes") || undefined,
      totp,
      tags: get("tags") ? get("tags").split(/[;,]/).map((t) => t.trim()).filter(Boolean) : undefined,
      favorite: /^(1|true|yes)$/i.test(get("fav")) || undefined,
      fields: fields.length ? fields : undefined,
    });
    items.push({ body: prune(body), folder: get("folder") || undefined });
  });
  return { format, items, warnings };
}

/** LastPass marks secure notes with url http://sn and a "NoteType:" body. */
export function fromLastPassCsv(text: string): ImportResult {
  const result = fromGenericCsv(text, "LastPass");
  const rows = parseCsv(text);
  const idx = columnsOf(rows[0]);
  const noted = new Set<number>();
  rows.slice(1).forEach((r, i) => {
    if ((r[idx.url] ?? "").trim() === "http://sn") noted.add(i);
  });
  let at = 0;
  rows.slice(1).forEach((r, i) => {
    if (r.every((c) => !c.trim())) return;
    if (noted.has(i) && result.items[at]) {
      const b = result.items[at].body;
      result.items[at].body = prune(newBody("note", b.title, { notes: b.notes, tags: b.tags, fields: b.fields }));
    }
    at++;
  });
  return result;
}

function prune(b: ItemBody): ItemBody {
  const out = { ...b } as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete out[k];
  }
  return out as ItemBody;
}

// ---- Bitwarden JSON (plain; the encrypted form lives in bitwarden.ts) ------------

type Any = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);

export function fromBitwardenJson(data: Any): ImportResult {
  if (data.encrypted === true) throw new NeedsPasswordError("Bitwarden");
  const warnings: string[] = [];
  const folders = new Map(arr(data.folders).map((f) => [str(f.id), str(f.name)]));
  const items: Imported[] = [];
  for (const it of arr(data.items)) {
    const title = str(it.name) ?? "Imported item";
    const folder = folders.get(str(it.folderId)) ?? undefined;
    const base = {
      notes: str(it.notes),
      favorite: it.favorite === true || undefined,
      reprompt: it.reprompt === 1 || undefined,
      fields: arr(it.fields)
        .map((f): CustomField => ({ name: str(f.name) ?? "Field", value: String(f.value ?? ""), type: f.type === 1 ? "hidden" : f.type === 2 ? "boolean" : "text" }))
        .filter((f) => f.value),
    };
    const type = Number(it.type);
    if (type === 1) {
      const l = (it.login ?? {}) as Any;
      const passkeys: Passkey[] = [];
      for (const pk of arr(l.fido2Credentials)) {
        // Bitwarden's key is a PKCS#8 ES256 private key, base64url.
        if (str(pk.keyValue) && str(pk.rpId) && str(pk.credentialId)) {
          passkeys.push({
            credentialId: str(pk.credentialId)!,
            rpId: str(pk.rpId)!,
            rpName: str(pk.rpName),
            userHandle: str(pk.userHandle) ?? "",
            userName: str(pk.userName) ?? "",
            userDisplayName: str(pk.userDisplayName),
            key: str(pk.keyValue)!,
            alg: -7,
            signCount: Number(pk.counter ?? 0),
            createdAt: str(pk.creationDate) ?? new Date().toISOString(),
            discoverable: pk.discoverable !== "false",
          });
        }
      }
      items.push({
        folder,
        body: prune(
          newBody("login", title, {
            ...base,
            username: str(l.username),
            password: str(l.password),
            urls: arr(l.uris).map((u) => ({ url: String(u.uri ?? ""), match: bwMatch(u.match) })).filter((u) => u.url),
            totp: otpFrom(str(l.totp), warnings, title),
            passkeys: passkeys.length ? passkeys : undefined,
            passwordHistory: arr(it.passwordHistory)
              .map((h) => ({ password: String(h.password ?? ""), at: str(h.lastUsedDate) ?? new Date(0).toISOString() }))
              .filter((h) => h.password),
          }),
        ),
      });
    } else if (type === 2) {
      items.push({ folder, body: prune(newBody("note", title, base)) });
    } else if (type === 3) {
      const c = (it.card ?? {}) as Any;
      items.push({
        folder,
        body: prune(
          newBody("card", title, {
            ...base,
            cardholder: str(c.cardholderName),
            cardNumber: str(c.number),
            cardBrand: str(c.brand),
            cardExpMonth: str(c.expMonth),
            cardExpYear: str(c.expYear),
            cardCvv: str(c.code),
          }),
        ),
      });
    } else if (type === 4) {
      const d = (it.identity ?? {}) as Any;
      items.push({
        folder,
        body: prune(
          newBody("identity", title, {
            ...base,
            firstName: str(d.firstName),
            middleName: str(d.middleName),
            lastName: str(d.lastName),
            email: str(d.email),
            phone: str(d.phone),
            company: str(d.company),
            address1: str(d.address1),
            address2: str(d.address2),
            city: str(d.city),
            state: str(d.state),
            postcode: str(d.postalCode),
            country: str(d.country),
          }),
        ),
      });
    } else if (type === 5) {
      const k = (it.sshKey ?? {}) as Any;
      items.push({
        folder,
        body: prune(newBody("ssh", title, { ...base, sshPublic: str(k.publicKey), sshPrivate: str(k.privateKey), sshFingerprint: str(k.keyFingerprint) })),
      });
    } else {
      warnings.push(`${title}: a kind of item we don't know, kept as a note.`);
      items.push({ folder, body: prune(newBody("note", title, { ...base, notes: base.notes ?? JSON.stringify(it) })) });
    }
  }
  return { format: "Bitwarden", items, warnings };
}

function bwMatch(m: unknown): LoginUrl["match"] {
  return ({ 0: "base", 1: "host", 2: "prefix", 3: "exact", 4: "regex", 5: "never" } as Record<string, LoginUrl["match"]>)[String(m)] ?? undefined;
}

// ---- 1Password .1pux ------------------------------------------------------------

export function from1pux(zip: Uint8Array): ImportResult {
  const files = safeUnzip(zip);
  const raw = files["export.data"];
  if (!raw) throw new Error("That .1pux has no export.data");
  const data = JSON.parse(strFromU8(raw)) as Any;
  const items: Imported[] = [];
  const warnings: string[] = [];
  for (const account of arr(data.accounts)) {
    for (const vault of arr(account.vaults)) {
      const folder = str((vault.attrs as Any)?.name);
      for (const it of arr(vault.items)) {
        if (it.state === "trashed") continue;
        const ov = (it.overview ?? {}) as Any;
        const d = (it.details ?? {}) as Any;
        const title = str(ov.title) ?? "Imported item";
        const fields: CustomField[] = [];
        let totp: TotpConfig | null = null;
        const loginFields = arr(d.loginFields);
        const username = str(loginFields.find((f) => f.designation === "username")?.value);
        const password = str(loginFields.find((f) => f.designation === "password")?.value);
        for (const sec of arr(d.sections)) {
          for (const f of arr(sec.fields)) {
            const v = (f.value ?? {}) as Any;
            const name = str(f.title) ?? str(f.id) ?? "Field";
            if (typeof v.totp === "string") {
              totp = totp ?? otpFrom(v.totp, warnings, title);
              continue;
            }
            if (typeof v.concealed === "string") fields.push({ name, value: v.concealed, type: "hidden" });
            else if (typeof v.string === "string") fields.push({ name, value: v.string, type: "text" });
            else if (typeof v.url === "string") fields.push({ name, value: v.url, type: "text" });
            else if (typeof v.email === "object" && v.email && typeof (v.email as Any).email_address === "string") fields.push({ name, value: String((v.email as Any).email_address), type: "text" });
            else if (typeof v.phone === "string") fields.push({ name, value: v.phone, type: "text" });
            else if (typeof v.creditCardNumber === "string") fields.push({ name: "cardNumber", value: v.creditCardNumber, type: "hidden" });
            else if (typeof v.creditCardType === "string") fields.push({ name: "cardBrand", value: v.creditCardType, type: "text" });
            else if (typeof v.monthYear === "number") fields.push({ name: "expiry", value: String(v.monthYear), type: "text" });
          }
        }
        const urls = arr(ov.urls).map((u) => ({ url: String(u.url ?? "") })).filter((u) => u.url);
        if (!urls.length && str(ov.url)) urls.push({ url: str(ov.url)! });
        const tags = Array.isArray(ov.tags) ? (ov.tags as string[]) : undefined;
        const common = { notes: str(d.notesPlain), tags, archived: it.state === "archived" || undefined, fields: fields.length ? fields : undefined };
        // Only category 001 is documented. The rest go by what's in them.
        const card = fields.find((f) => f.name === "cardNumber");
        if (it.categoryUuid === "001" || username || password) {
          const history = arr(d.passwordHistory).map((h) => ({ password: String(h.value ?? ""), at: new Date(Number(h.time ?? 0) * 1000).toISOString() })).filter((h) => h.password);
          items.push({ folder, body: prune(newBody("login", title, { ...common, username, password, urls, totp, passwordHistory: history })) });
        } else if (card) {
          items.push({ folder, body: prune(newBody("card", title, { ...common, fields: fields.filter((f) => f !== card) , cardNumber: card.value })) });
        } else {
          items.push({ folder, body: prune(newBody("note", title, common)) });
        }
      }
    }
  }
  return { format: "1Password", items, warnings };
}

function safeUnzip(zip: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(zip, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_BYTES) throw new Error("That archive is too large");
      return !f.name.startsWith("files/");
    },
  });
}

// ---- Dashlane, Proton Pass ------------------------------------------------------

export function fromProtonJson(data: Any): ImportResult {
  const items: Imported[] = [];
  const warnings: string[] = [];
  const vaults = (data.vaults ?? {}) as Record<string, Any>;
  for (const vault of Object.values(vaults)) {
    const folder = str(vault.name);
    for (const it of arr(vault.items)) {
      if (it.state === 2) continue; // trashed
      const d = (it.data ?? {}) as Any;
      const meta = (d.metadata ?? {}) as Any;
      const c = (d.content ?? {}) as Any;
      const title = str(meta.name) ?? "Imported item";
      const notes = str(meta.note);
      const fields = arr(d.extraFields).map((f): CustomField => ({ name: str(f.fieldName) ?? "Field", value: String((f.data as Any)?.content ?? ""), type: f.type === "hidden" ? "hidden" : "text" }));
      const type = str(d.type);
      if (type === "login") {
        items.push({
          folder,
          body: prune(
            newBody("login", title, {
              notes,
              fields,
              username: str(c.itemUsername) ?? str(c.username) ?? str(c.itemEmail),
              password: str(c.password),
              urls: Array.isArray(c.urls) ? (c.urls as string[]).map((u) => ({ url: u })) : [],
              totp: otpFrom(str(c.totpUri), warnings, title),
            }),
          ),
        });
      } else if (type === "creditCard") {
        items.push({
          folder,
          body: prune(newBody("card", title, { notes, fields, cardholder: str(c.cardholderName), cardNumber: str(c.number), cardCvv: str(c.verificationNumber), cardExpMonth: str(c.expirationDate)?.slice(5, 7), cardExpYear: str(c.expirationDate)?.slice(0, 4) })),
        });
      } else if (type === "identity") {
        items.push({ folder, body: prune(newBody("identity", title, { notes, fields, firstName: str(c.firstName), lastName: str(c.lastName), email: str(c.email), phone: str(c.phoneNumber), address1: str(c.streetAddress), city: str(c.city), postcode: str(c.zipOrPostalCode), country: str(c.countryOrRegion) })) });
      } else {
        items.push({ folder, body: prune(newBody("note", title, { notes, fields })) });
      }
    }
  }
  return { format: "Proton Pass", items, warnings };
}

/** Dashlane's zip of CSVs, or any one of them. */
export function fromDashlaneZip(zip: Uint8Array): ImportResult {
  const files = safeUnzip(zip);
  const items: Imported[] = [];
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(files)) {
    if (!name.endsWith(".csv")) continue;
    const text = strFromU8(raw);
    const rows = parseCsv(text);
    if (rows.length < 2) continue;
    const base = name.toLowerCase();
    if (base.includes("credential")) {
      const r = fromGenericCsv(text, "Dashlane");
      items.push(...r.items);
      warnings.push(...r.warnings);
    } else if (base.includes("securenote")) {
      const h = rows[0].map(norm);
      for (const row of rows.slice(1)) {
        const get = (k: string) => row[h.indexOf(k)] ?? "";
        items.push({ body: prune(newBody("note", get("title") || "Imported note", { notes: get("note") })) });
      }
    } else if (base.includes("payment")) {
      const h = rows[0].map(norm);
      for (const row of rows.slice(1)) {
        const get = (k: string) => row[h.indexOf(k)] ?? "";
        items.push({ body: prune(newBody("card", get("name") || "Imported card", { cardholder: get("accountname"), cardNumber: get("accountnumber"), cardCvv: get("cvv"), cardExpMonth: get("expirationmonth"), cardExpYear: get("expirationyear"), notes: get("note") })) });
      }
    } else if (base.includes("id")) {
      const h = rows[0].map(norm);
      for (const row of rows.slice(1)) {
        const get = (k: string) => row[h.indexOf(k)] ?? "";
        items.push({ body: prune(newBody("identity", [get("firstname"), get("lastname")].filter(Boolean).join(" ") || "Imported identity", { firstName: get("firstname"), lastName: get("lastname"), email: get("email"), phone: get("phonenumber"), address1: get("address"), city: get("city"), postcode: get("zip"), country: get("country") })) });
      }
    } else {
      warnings.push(`${name}: not something we can read yet.`);
    }
  }
  return { format: "Dashlane", items, warnings };
}

// ---- KeePass XML ------------------------------------------------------------------

/** KeePass 2 XML, from a parser with no entity support: we walk the tree by hand. */
export function fromKeepassXml(text: string): ImportResult {
  if (/<!ENTITY/i.test(text)) throw new Error("That XML defines its own entities, which we don't accept.");
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("That XML couldn't be read");
  const root = doc.querySelector("KeePassFile > Root");
  if (!root) throw new Error("That isn't a KeePass XML export");
  const items: Imported[] = [];
  const walk = (group: Element, path: string[], depth: number) => {
    if (depth > 64) throw new Error("Those groups nest too deeply");
    const name = child(group, "Name")?.textContent ?? "";
    const here = depth === 0 ? [] : [...path, name];
    for (const entry of childrenOf(group, "Entry")) {
      const strings = new Map<string, string>();
      for (const s of childrenOf(entry, "String")) {
        strings.set(child(s, "Key")?.textContent ?? "", child(s, "Value")?.textContent ?? "");
      }
      items.push(keepassItem(strings, here.join("/") || undefined));
    }
    for (const g of childrenOf(group, "Group")) walk(g, here, depth + 1);
  };
  for (const g of childrenOf(root, "Group")) walk(g, [], 0);
  return { format: "KeePass", items, warnings: [] };
}

export function keepassItem(strings: Map<string, string>, folder?: string): Imported {
  const take = (k: string) => {
    const v = strings.get(k);
    strings.delete(k);
    return v || undefined;
  };
  const title = take("Title") ?? "Imported login";
  const username = take("UserName");
  const password = take("Password");
  const url = take("URL");
  const notes = take("Notes");
  let totp: TotpConfig | null = null;
  const otp = take("otp");
  if (otp) totp = otpFrom(otp, [], title);
  const seed = take("TOTP Seed") ?? take("TimeOtp-Secret-Base32");
  if (!totp && seed) totp = { secret: seed.toUpperCase().replace(/\s/g, "") };
  const fields: CustomField[] = [...strings].filter(([, v]) => v).map(([name, value]) => ({ name, value, type: "text" as const }));
  return { folder, body: prune(newBody("login", title, { username, password, urls: url ? [{ url }] : [], notes, totp, fields })) };
}

function child(el: Element, tag: string): Element | undefined {
  return [...el.children].find((c) => c.tagName === tag);
}
function childrenOf(el: Element, tag: string): Element[] {
  return [...el.children].filter((c) => c.tagName === tag);
}

// ---- FIDO CXF ---------------------------------------------------------------------

export function fromCxf(data: Any): ImportResult {
  const items: Imported[] = [];
  const warnings: string[] = [];
  const ef = (v: unknown): string | undefined => {
    if (typeof v === "string") return v || undefined;
    if (v && typeof v === "object" && "value" in (v as Any)) {
      const x = (v as Any).value;
      return x === undefined || x === null || x === "" ? undefined : String(x);
    }
    return undefined;
  };
  for (const account of arr(data.accounts)) {
    const folders = new Map<string, string>();
    for (const c of arr(account.collections)) {
      for (const ref of arr(c.items)) folders.set(String(ref.item), String(c.title ?? ""));
    }
    for (const it of arr(account.items)) {
      const title = str(it.title) ?? "Imported item";
      const scope = (it.scope ?? {}) as Any;
      const urls = (Array.isArray(scope.urls) ? (scope.urls as string[]) : []).map((u) => ({ url: u }));
      const body: Partial<ItemBody> = { urls, favorite: it.favorite === true || undefined, tags: Array.isArray(it.tags) ? (it.tags as string[]) : undefined };
      const notes: string[] = [];
      let kind: ItemBody["kind"] = "login";
      const passkeys: Passkey[] = [];
      const fields: CustomField[] = [];
      for (const cr of arr(it.credentials)) {
        switch (cr.type) {
          case "basic-auth":
            body.username = ef(cr.username);
            body.password = ef(cr.password);
            break;
          case "totp":
            if (str(cr.secret)) {
              body.totp = {
                secret: String(cr.secret),
                period: Number(cr.period ?? 30),
                digits: Number(cr.digits ?? 6),
                algorithm: ({ sha1: "SHA1", sha256: "SHA256", sha512: "SHA512" } as Record<string, TotpConfig["algorithm"]>)[String(cr.algorithm)] ?? "SHA1",
                issuer: str(cr.issuer),
                label: str(cr.username),
              };
            }
            break;
          case "passkey":
            if (str(cr.key) && str(cr.rpId)) {
              passkeys.push({
                credentialId: String(cr.credentialId),
                rpId: String(cr.rpId),
                userHandle: String(cr.userHandle ?? ""),
                userName: String(cr.username ?? ""),
                userDisplayName: str(cr.userDisplayName),
                key: String(cr.key),
                alg: -7,
                signCount: 0,
                createdAt: new Date().toISOString(),
                discoverable: true,
              });
            }
            break;
          case "note":
            if (ef(cr.content)) notes.push(ef(cr.content)!);
            if (!body.username && !body.password) kind = "note";
            break;
          case "credit-card":
            kind = "card";
            body.cardNumber = ef(cr.number);
            body.cardholder = ef(cr.fullName);
            body.cardBrand = ef(cr.cardType);
            body.cardCvv = ef(cr.verificationNumber);
            if (ef(cr.expiryDate)) {
              const [y, m] = ef(cr.expiryDate)!.split("-");
              body.cardExpYear = y;
              body.cardExpMonth = m;
            }
            break;
          case "api-key":
            kind = "apikey";
            body.apiKey = ef(cr.key);
            break;
          case "wifi":
            kind = "wifi";
            body.ssid = ef(cr.ssid);
            body.wifiPassword = ef(cr.passphrase);
            break;
          case "ssh-key":
            kind = "ssh";
            body.sshPrivate = ef(cr.privateKey) ?? str(cr.privateKey);
            break;
          case "custom-fields":
            for (const f of arr(cr.fields)) {
              if (ef(f)) fields.push({ name: str(f.label) ?? "Field", value: ef(f)!, type: f.fieldType === "concealed-string" ? "hidden" : "text" });
            }
            break;
          default:
            warnings.push(`${title}: "${String(cr.type)}" isn't something we can import yet.`);
        }
      }
      if (passkeys.length) body.passkeys = passkeys;
      if (notes.length) body.notes = notes.join("\n\n");
      if (fields.length) body.fields = fields;
      items.push({ folder: folders.get(String(it.id)) || undefined, body: prune(newBody(kind, title, body)) });
    }
  }
  return { format: "Credential Exchange", items, warnings };
}

// ---- Authenticator apps ------------------------------------------------------------

export function fromAegisJson(data: Any): ImportResult {
  if (typeof data.db === "string" || (data.header && (data.header as Any).slots)) throw new Error("That Aegis export is encrypted. Export it without a password, import, then delete the file.");
  const db = (data.db ?? {}) as Any;
  const items: Imported[] = [];
  let skipped = 0;
  for (const e of arr(db.entries)) {
    const info = (e.info ?? {}) as Any;
    const type = str(e.type);
    if (type !== "totp" && type !== "steam") {
      skipped++;
      continue;
    }
    const name = [str(e.issuer), str(e.name)].filter(Boolean).join(": ") || "Imported code";
    items.push({
      body: prune(
        newBody("totp", name, {
          notes: str(e.note),
          favorite: e.favorite === true || undefined,
          totp: { secret: String(info.secret ?? ""), algorithm: ({ SHA1: "SHA1", SHA256: "SHA256", SHA512: "SHA512" } as Record<string, TotpConfig["algorithm"]>)[String(info.algo)] ?? "SHA1", digits: Number(info.digits ?? 6), period: Number(info.period ?? 30), steam: type === "steam" || undefined, issuer: str(e.issuer), label: str(e.name) },
        }),
      ),
    });
  }
  return { format: "Aegis", items, warnings: skipped ? [`${skipped} counter-based or other codes weren't imported.`] : [] };
}

export function from2fasJson(data: Any): ImportResult {
  if (data.servicesEncrypted || data.reference) throw new Error("That 2FAS backup is encrypted. Export it without a password, import, then delete the file.");
  const items: Imported[] = [];
  let skipped = 0;
  for (const s of arr(data.services)) {
    const otp = (s.otp ?? {}) as Any;
    const token = String(otp.tokenType ?? "TOTP").toUpperCase();
    if (token !== "TOTP" && token !== "STEAM") {
      skipped++;
      continue;
    }
    const title = str(s.name) ?? str(otp.issuer) ?? "Imported code";
    items.push({
      body: prune(
        newBody("totp", title, {
          totp: { secret: String(s.secret ?? ""), algorithm: ({ SHA1: "SHA1", SHA256: "SHA256", SHA512: "SHA512" } as Record<string, TotpConfig["algorithm"]>)[String(otp.algorithm)] ?? "SHA1", digits: Number(otp.digits ?? 6), period: Number(otp.period ?? 30), steam: token === "STEAM" || undefined, issuer: str(otp.issuer), label: str(otp.account) },
        }),
      ),
    });
  }
  return { format: "2FAS", items, warnings: skipped ? [`${skipped} counter-based codes weren't imported.`] : [] };
}

export function fromMigrationLinks(text: string): ImportResult {
  const items: Imported[] = [];
  let skipped = 0;
  for (const line of text.split(/\s+/).filter(Boolean)) {
    const { codes, skipped: s } = parseMigrationUri(line);
    skipped += s;
    for (const c of codes) items.push({ body: newBody("totp", [c.issuer, c.label].filter(Boolean).join(": ") || "Imported code", { totp: c }) });
  }
  return { format: "Google Authenticator", items, warnings: skipped ? [`${skipped} counter-based codes weren't imported.`] : [] };
}

// ---- Detection -----------------------------------------------------------------------

/** Work out what a file is and read it. Password-protected ones raise
 *  NeedsPasswordError so the UI can ask, then pass ``password`` on the next try. */
export async function importFile(name: string, bytes: Uint8Array, password?: string): Promise<ImportResult> {
  return sanitizeImport(await readFile(name, bytes, password));
}

/** A file can say anything. Internal kinds never come in from one, or it could plant a trust
 *  book naming someone an emergency contact, and an app's id gets no website match. */
export function sanitizeImport(r: ImportResult): ImportResult {
  const items = [];
  for (const it of r.items) {
    if (SYSTEM_KINDS.includes(it.body.kind)) continue;
    const { trustBook: _t, conflicts: _c, seq: _s, pendingPassword: _p, sendId: _d, ...rest } = it.body;
    const urls = rest.urls?.map((u) => (/^(https?:\/\/|[^:/]+(\.|$|:\d|\/))/i.test(u.url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u.url.replace(/^https?:\/\//i, "")) ? u : { ...u, match: "never" as const }));
    items.push({ ...it, body: { ...rest, ...(urls ? { urls } : {}) } as ItemBody });
  }
  return { ...r, items };
}

async function readFile(name: string, bytes: Uint8Array, password?: string): Promise<ImportResult> {
  if (bytes.length > MAX_BYTES) throw new Error("That file is too large");
  const lower = name.toLowerCase();

  if (bytes[0] === 0x03 && bytes[1] === 0xd9 && bytes[2] === 0xa2 && bytes[3] === 0x9a) {
    const { fromKdbx } = await import("./kdbx");
    if (!password) throw new NeedsPasswordError("KeePass");
    return fromKdbx(bytes, password);
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (lower.endsWith(".1pux") || isOnePux(bytes)) return from1pux(bytes);
    return fromDashlaneZip(bytes);
  }

  let text: string;
  try {
    text = fromUtf8(bytes);
  } catch {
    throw new Error("We can't read that file. Is it a password export?");
  }
  const trimmed = text.trimStart().replace(/^﻿/, "");

  if (trimmed.startsWith("otpauth-migration://")) return fromMigrationLinks(trimmed);
  if (trimmed.startsWith("<")) return fromKeepassXml(trimmed);

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: Any;
    try {
      data = JSON.parse(trimmed) as Any;
    } catch {
      throw new Error("That JSON file is damaged");
    }
    if (data.format === "promptly-pw-export") {
      const { readEncryptedExport } = await import("./exporter");
      if (!password) throw new NeedsPasswordError("Promptly");
      return readEncryptedExport(data, password);
    }
    if (data.format === "promptly-pw-plain") return { format: "Promptly", items: arr(data.items).map((body) => ({ body: body as unknown as ItemBody })), warnings: [] };
    if (data.encrypted === true && "encKeyValidation_DO_NOT_EDIT" in data) {
      if (!password) throw new NeedsPasswordError("Bitwarden");
      const { decryptBitwardenExport } = await import("./bitwarden");
      return fromBitwardenJson(await decryptBitwardenExport(data, password));
    }
    if (data.encrypted === true) throw new Error("That Bitwarden file is locked to its account. Export it as 'Password protected' or plain JSON instead.");
    if (Array.isArray(data.items) && (data.encrypted === false || Array.isArray(data.folders))) return fromBitwardenJson(data);
    if (Array.isArray(data.accounts) && data.exporterRpId !== undefined) return fromCxf(data);
    if (data.vaults && typeof data.vaults === "object") return fromProtonJson(data);
    if (data.db !== undefined && data.header !== undefined) return fromAegisJson(data);
    if (Array.isArray(data.services)) return from2fasJson(data);
    throw new Error("We don't recognise that JSON file.");
  }

  const header = (text.split(/\r?\n/, 1)[0] ?? "").toLowerCase();
  if (header.includes("grouping") && header.includes("extra")) return fromLastPassCsv(text);
  if (header.includes("httprealm") || header.includes("formactionorigin")) return fromGenericCsv(text, "Firefox");
  if (header.includes("otpauth") && header.includes("title")) return fromGenericCsv(text, "Apple Passwords");
  if (header.includes("name") && header.includes("url") && header.includes("username") && header.includes("password")) return fromGenericCsv(text, "Browser");
  return fromGenericCsv(text);
}

function isOnePux(zip: Uint8Array): boolean {
  try {
    return Object.keys(unzipSync(zip, { filter: (f) => f.name === "export.attributes" })).length > 0;
  } catch {
    return false;
  }
}

// ---- After reading ----------------------------------------------------------------------

function fingerprint(b: ItemBody): string {
  const host = (u?: string) => {
    if (!u) return "";
    try {
      return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };
  return JSON.stringify([b.kind, host(b.urls?.[0]?.url), b.username ?? "", b.password ?? "", b.cardNumber ?? "", b.kind === "note" ? `${b.title}|${b.notes ?? ""}` : "", b.totp?.secret ?? ""]);
}

/** Removes exact duplicates, inside the file and against what's already here. */
export function dedupe(items: Imported[], existing: ItemBody[]): { fresh: Imported[]; duplicates: number } {
  const seen = new Set(existing.map(fingerprint));
  const fresh: Imported[] = [];
  let duplicates = 0;
  for (const it of items) {
    const f = fingerprint(it.body);
    if (seen.has(f)) {
      duplicates++;
      continue;
    }
    seen.add(f);
    fresh.push(it);
  }
  return { fresh, duplicates };
}

/** "Delete the old copy" instructions shown after an import from a browser. */
export const AFTER_IMPORT: Record<string, string> = {
  Browser: "Your browser still has its copy. Once this looks right, remove it: Chrome or Edge, Settings → Passwords → delete them there; turn off offering to save passwords too.",
  Firefox: "Firefox still has its copy. Once this looks right: Settings → Privacy & Security → Saved Passwords → Remove All.",
};

export { fromB64u };
