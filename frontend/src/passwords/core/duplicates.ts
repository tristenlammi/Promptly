// Finding logins saved more than once (DECISIONS D133 to D136). All of it runs here, on the
// device, against the decrypted vault: the server never learns which logins look alike, and
// what someone says about a group ("Not a duplicate") is kept inside their personal vault.
//
// Two kinds of match, both within one vault and one site:
//  - "sure": the same username (ignoring case and spaces). Almost always one login saved twice.
//  - "likely": the same password, with different usernames or none. Often one account saved
//    under an email and a handle, but it can be two accounts, so it's only ever suggested.
// "The same site" follows the vault's own matching rules (match.ts, D89 to D94): a login is on
// the other's site if it would be offered there as that site's own, judged as if the domain had
// more than one service on it, so zyx.example.org and abc.example.org stay apart while
// www.example.com, example.com and login.example.com come together.
import { sha256 } from "@noble/hashes/sha2.js";

import { b64u, randomBytes, utf8 } from "./bytes";
import { baseDomain, hostKey, hostOf, isPrimary, matchUrl, type PageContext, sharedWith } from "./match";
import { type AttachmentRef, type CustomField, type HistoryEntry, type Item, type ItemBody, type LoginUrl, newBody, touch, type UrlMatch } from "./model";

export type DupeKind = "sure" | "likely";
/** Why a "likely" group was suggested. */
export type DupeReason = "username" | "password" | "password-no-username";

export type DupeGroup = {
  /** Stable while the same logins are in it. */
  key: string;
  kind: DupeKind;
  reason: DupeReason;
  vaultId: string;
  /** The site, as people know it: the host without www., from the first login's address. */
  site: string;
  /** Newest first. */
  items: Item[];
};

/** "Ana@Example.com " and "ana@example.com" are one username; "tristen.lammi" and "tristenlammi" aren't. */
export function normalizeUsername(u: string | undefined | null): string {
  return (u ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

// ---- The same site ---------------------------------------------------------------------

/** Judged as if the domain had other services on it, and nothing saved for the page itself:
 *  another host only counts when it signs in for the whole domain (D89). */
const NOT_ALONE: PageContext = { exactHere: false, hostsUnderBase: 2 };

type Entry = { saved: LoginUrl; page: string; itemMatch: UrlMatch };

/** "Never" is about filling, not about which site a login is for. */
const forSite = (m: UrlMatch | undefined): UrlMatch | undefined => (m === "never" ? "auto" : m);

function entriesOf(item: Item): Entry[] {
  const out: Entry[] = [];
  const itemMatch = forSite(item.body.match) ?? "auto";
  for (const u of item.body.urls ?? []) {
    // A regular expression is a pattern, not a page: there's no site in it to compare.
    if ((u.match ?? item.body.match) === "regex") continue;
    const host = hostOf(u.url);
    if (!host) continue;
    out.push({ saved: { url: u.url, match: forSite(u.match) }, page: u.url.includes("://") ? u.url : `https://${u.url}`, itemMatch });
  }
  return out;
}

/** Where to look for others on the same site: the registrable domain, or the host for an IP
 *  address or a single name, and any domain that shares sign-ins with it. */
function bucketsOf(e: Entry): string[] {
  const host = hostOf(e.saved.url)!;
  const base = baseDomain(host);
  return base ? [base, ...sharedWith(base)] : [host];
}

function entryMatches(a: Entry, b: Entry): boolean {
  const k = matchUrl(a.saved, b.page, { itemMatch: a.itemMatch, ctx: NOT_ALONE });
  return k !== null && isPrimary(k);
}

/** Whether two logins are for the same site, by the vault's own rules, in either direction. */
export function sameSite(a: Item, b: Item): boolean {
  const ea = entriesOf(a);
  const eb = entriesOf(b);
  return ea.some((x) => eb.some((y) => entryMatches(x, y) || entryMatches(y, x)));
}

/** The site's name for a heading: www.kickstarter.com is "kickstarter.com". */
export function siteLabel(item: Item): string {
  for (const u of item.body.urls ?? []) {
    const h = hostOf(u.url);
    if (h) return hostKey(h);
  }
  return item.body.title;
}

/** Every host a login is saved for, as a heading or fingerprint would show them. */
export function hostsOf(body: ItemBody): string[] {
  const out: string[] = [];
  for (const u of body.urls ?? []) {
    const h = hostOf(u.url);
    if (h && !out.includes(hostKey(h))) out.push(hostKey(h));
  }
  return out;
}

// ---- Not a duplicate -------------------------------------------------------------------

/** The system item's title, kind "prefs", in the personal vault. Every client hides prefs items. */
export const DUPES_PREFS = "duplicates";

/** Two logins someone said aren't the same. `fps` fingerprint each one's site, username and
 *  password at the time, so the decision lapses when any of those change. The fingerprint is
 *  salted per entry and stays inside the encrypted vault. */
export type NotDuplicate = { ids: [string, string]; fps: [string, string]; salt: string; at: string };
export type DupePrefs = { pairs: NotDuplicate[] };

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function fingerprint(item: Item, salt: string): string {
  const b = item.body;
  const data = JSON.stringify(["promptly-dupes-fp", salt, item.id, hostsOf(b).sort(), normalizeUsername(b.username), b.password ?? ""]);
  return b64u(sha256(utf8(data))).slice(0, 22);
}

function parsePairs(raw: unknown): NotDuplicate[] {
  if (!Array.isArray(raw)) return [];
  const out: NotDuplicate[] = [];
  for (const r of raw) {
    const p = r as Partial<NotDuplicate> | null;
    if (!p || !Array.isArray(p.ids) || !Array.isArray(p.fps) || p.ids.length !== 2 || p.fps.length !== 2) continue;
    if (![...p.ids, ...p.fps].every((x) => typeof x === "string") || typeof p.salt !== "string") continue;
    out.push({ ids: [p.ids[0], p.ids[1]], fps: [p.fps[0], p.fps[1]], salt: p.salt, at: typeof p.at === "string" ? p.at : "" });
  }
  return out;
}

function pairsIn(body: ItemBody | Record<string, unknown>): NotDuplicate[] {
  return parsePairs((body.prefs as { notDuplicates?: unknown } | undefined)?.notDuplicates);
}

/** Read from the personal vault only: a shared vault's member mustn't be able to hide a group
 *  from you. Two devices that each made the item, or a sync conflict on it, are read together. */
export function readDupePrefs(items: Item[], personalVaultId: string | null): { item: Item | null; prefs: DupePrefs } {
  const mine = items
    .filter((i) => !i.deleted && i.body.kind === "prefs" && i.body.title === DUPES_PREFS && (personalVaultId === null || i.vaultId === personalVaultId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const pairs: NotDuplicate[] = [];
  for (const i of mine) {
    for (const p of [...pairsIn(i.body), ...(i.body.conflicts ?? []).flatMap((c) => pairsIn(c.body))]) {
      const k = `${pairKey(p.ids[0], p.ids[1])}|${p.fps.join()}|${p.salt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push(p);
    }
  }
  return { item: mine[0] ?? null, prefs: { pairs } };
}

/** Whether a stored "not a duplicate" still holds for these two, as they are now. */
function holds(p: NotDuplicate, a: Item, b: Item): boolean {
  const [x, y] = p.ids[0] === a.id ? [a, b] : [b, a];
  return p.ids[0] === x.id && p.ids[1] === y.id && fingerprint(x, p.salt) === p.fps[0] && fingerprint(y, p.salt) === p.fps[1];
}

/** Every pair in the group, marked as not the same. */
export function withNotDuplicate(prefs: DupePrefs, group: Item[], at = new Date().toISOString()): DupePrefs {
  const pairs = [...prefs.pairs];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const salt = b64u(randomBytes(12));
      const [a, b] = [group[i], group[j]];
      pairs.push({ ids: [a.id, b.id], fps: [fingerprint(a, salt), fingerprint(b, salt)], salt, at });
    }
  }
  return { pairs };
}

/** Takes back what `withNotDuplicate` added for this group (for Undo, or "Suggest again"). */
export function withoutNotDuplicate(prefs: DupePrefs, ids: string[]): DupePrefs {
  const set = new Set(ids);
  return { pairs: prefs.pairs.filter((p) => !(set.has(p.ids[0]) && set.has(p.ids[1]))) };
}

/** Drops decisions that no longer mean anything: a login deleted for good, or one whose site,
 *  username or password has changed since. A login in Trash keeps its decisions. */
export function prunePairs(prefs: DupePrefs, all: Map<string, Item>): DupePrefs {
  return {
    pairs: prefs.pairs.filter((p) => {
      const a = all.get(p.ids[0]);
      const b = all.get(p.ids[1]);
      return !!a && !!b && holds(p, a, b);
    }),
  };
}

/** How many decisions still hold, for "Suggest them again". */
export function liveDecisions(prefs: DupePrefs, all: Map<string, Item>): number {
  return prunePairs(prefs, all).pairs.length;
}

/** The body to save, keeping anything else a newer client put in the item. */
export function dupePrefsBody(prev: ItemBody | null, prefs: DupePrefs): ItemBody {
  const base = prev ?? newBody("prefs", DUPES_PREFS);
  return { ...base, prefs: { ...((base.prefs as Record<string, unknown>) ?? {}), notDuplicates: prefs.pairs } };
}

// ---- Finding them ----------------------------------------------------------------------

class Groups {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    while (p !== (this.parent.get(p) ?? p)) p = this.parent.get(p) ?? p;
    this.parent.set(x, p);
    return p;
  }
  join(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const newestFirst = (a: Item, b: Item) => b.body.updatedAt.localeCompare(a.body.updatedAt) || a.id.localeCompare(b.id);

/** Every group of logins that look like one saved more than once, sure ones first. `prefs`
 *  holds what the person said isn't a duplicate; pairs it covers aren't linked. */
export function findDuplicateGroups(items: Item[], prefs: DupePrefs = { pairs: [] }): DupeGroup[] {
  const logins = items.filter((i) => !i.deleted && i.body.kind === "login");
  // Put each login's addresses in buckets, so only logins that could share a site are compared.
  const entries = new Map<string, Entry[]>();
  const buckets = new Map<string, Set<Item>>();
  for (const i of logins) {
    const es = entriesOf(i);
    if (!es.length) continue;
    entries.set(i.id, es);
    for (const e of es) {
      for (const b of bucketsOf(e)) {
        const key = `${i.vaultId}|${b}`;
        const set = buckets.get(key) ?? new Set<Item>();
        set.add(i);
        buckets.set(key, set);
      }
    }
  }

  const dismissed = new Map<string, NotDuplicate[]>();
  for (const p of prefs.pairs) {
    const k = pairKey(p.ids[0], p.ids[1]);
    dismissed.set(k, [...(dismissed.get(k) ?? []), p]);
  }

  const sure = new Groups();
  const likely = new Groups();
  const sureIds = new Set<string>();
  const likelyIds = new Set<string>();
  const checked = new Set<string>();
  for (const set of buckets.values()) {
    if (set.size < 2) continue;
    const list = [...set];
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = list[x];
        const b = list[y];
        const k = pairKey(a.id, b.id);
        if (checked.has(k)) continue;
        checked.add(k);
        const ua = normalizeUsername(a.body.username);
        const ub = normalizeUsername(b.body.username);
        const sameUser = !!ua && ua === ub;
        const samePassword = !!a.body.password && a.body.password === b.body.password;
        if (!sameUser && !samePassword) continue;
        const ea = entries.get(a.id)!;
        const eb = entries.get(b.id)!;
        if (!ea.some((p) => eb.some((q) => entryMatches(p, q) || entryMatches(q, p)))) continue;
        if ((dismissed.get(k) ?? []).some((p) => holds(p, a, b))) continue;
        if (sameUser) {
          sure.join(a.id, b.id);
          sureIds.add(a.id).add(b.id);
        } else {
          likely.join(a.id, b.id);
          likelyIds.add(a.id).add(b.id);
        }
      }
    }
  }

  const byId = new Map(logins.map((i) => [i.id, i]));
  const collect = (g: Groups, ids: Set<string>, kind: DupeKind): DupeGroup[] => {
    const parts = new Map<string, Item[]>();
    for (const id of ids) {
      const root = g.find(id);
      parts.set(root, [...(parts.get(root) ?? []), byId.get(id)!]);
    }
    const out: DupeGroup[] = [];
    for (const members of parts.values()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort(newestFirst);
      const names = sorted.map((i) => normalizeUsername(i.body.username));
      const reason: DupeReason = kind === "sure" ? "username" : names.some((n) => !n) ? "password-no-username" : "password";
      out.push({
        key: `${kind}:${sorted.map((i) => i.id).sort().join(",")}`,
        kind,
        reason,
        vaultId: sorted[0].vaultId,
        site: siteLabel(sorted[sorted.length - 1]),
        items: sorted,
      });
    }
    return out.sort((a, b) => a.site.localeCompare(b.site) || a.key.localeCompare(b.key));
  };
  return [...collect(sure, sureIds, "sure"), ...collect(likely, likelyIds, "likely")];
}

/** Same site, same username: the sure ones, as plain lists. */
export function findDuplicates(items: Item[]): Item[][] {
  return findDuplicateGroups(items)
    .filter((g) => g.kind === "sure")
    .map((g) => g.items);
}

// ---- Merging ---------------------------------------------------------------------------

const OTHER_USERNAME = "Other username";
const OTHER_TOTP = "Other 2FA secret";

/** Keeps one as the main login (`keepId`, or the newest), and nothing else is thrown away:
 *  other passwords go to its history, other usernames and 2FA secrets become fields, and other
 *  URLs, notes, fields, tags and passkeys come across. An attachment's chunks are bound to the
 *  item they were uploaded on, so one on a dropped copy can't just be listed on the kept item:
 *  `moves` says which to seal again under it first. */
export function mergeDuplicates(group: Item[], keepId?: string): { keep: Item; body: ItemBody; drop: Item[]; moves: { from: Item; ref: AttachmentRef }[] } {
  const order = [...group].sort((a, b) => b.body.updatedAt.localeCompare(a.body.updatedAt));
  const keep = order.find((i) => i.id === keepId) ?? order[0];
  const drop = order.filter((i) => i !== keep);
  const body: ItemBody = { ...keep.body };
  const history: HistoryEntry[] = [];
  const seenUrls = new Set((body.urls ?? []).map((u) => u.url));
  const urls = [...(body.urls ?? [])];
  const notes: string[] = body.notes ? [body.notes] : [];
  const fields: CustomField[] = [...(body.fields ?? [])];
  const tags = [...(body.tags ?? [])];
  const passkeys = [...(body.passkeys ?? [])];
  const attachments = [...(body.attachments ?? [])];
  const moves: { from: Item; ref: AttachmentRef }[] = [];
  const addField = (f: CustomField) => {
    if (!fields.some((x) => x.name === f.name && x.value === f.value)) fields.push(f);
  };
  // Someone who asked for the master password on any copy still wants that on what's left.
  if (drop.some((d) => d.body.reprompt)) body.reprompt = true;
  if (drop.some((d) => d.body.favorite)) body.favorite = true;
  for (const d of drop) {
    if (d.body.password && d.body.password !== body.password && !history.some((h) => h.password === d.body.password)) history.push({ password: d.body.password, at: d.body.updatedAt });
    if (d.body.pendingPassword && d.body.pendingPassword !== body.password && !history.some((h) => h.password === d.body.pendingPassword)) history.push({ password: d.body.pendingPassword, at: new Date().toISOString() });
    const theirs = d.body.username?.trim();
    if (theirs && normalizeUsername(theirs) !== normalizeUsername(body.username)) {
      if (!body.username?.trim()) body.username = theirs;
      else addField({ name: OTHER_USERNAME, value: theirs, type: "text" });
    }
    for (const u of d.body.urls ?? []) if (!seenUrls.has(u.url)) { seenUrls.add(u.url); urls.push(u); }
    if (d.body.notes && !notes.includes(d.body.notes)) notes.push(d.body.notes);
    for (const f of d.body.fields ?? []) addField(f);
    for (const t of d.body.tags ?? []) if (!tags.includes(t)) tags.push(t);
    for (const p of d.body.passkeys ?? []) if (!passkeys.some((x) => x.credentialId === p.credentialId)) passkeys.push(p);
    for (const a of d.body.attachments ?? []) if (!attachments.some((x) => x.id === a.id) && !moves.some((m) => m.ref.id === a.id)) moves.push({ from: d, ref: a });
    if (d.body.totp) {
      if (!body.totp) body.totp = d.body.totp;
      else if (d.body.totp.secret !== body.totp.secret) addField({ name: OTHER_TOTP, value: d.body.totp.secret, type: "hidden" });
    }
  }
  // What's being merged in comes first, as the copies are about to go. Older history fills the rest.
  for (const h of [...(body.passwordHistory ?? []), ...drop.flatMap((d) => d.body.passwordHistory ?? [])]) if (!history.some((x) => x.password === h.password)) history.push(h);
  return {
    keep,
    drop,
    moves,
    body: touch(keep.body, { ...body, urls, notes: notes.join("\n\n") || undefined, fields, tags: tags.length ? tags : body.tags, passkeys, attachments, passwordHistory: history.slice(0, 20) }),
  };
}
