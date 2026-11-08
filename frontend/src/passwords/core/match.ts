// Which saved logins belong to a page (plan 6.2). The rules, and why, are in
// passwords/DECISIONS.md (D89 to D93). In short:
//  - Each item has a match setting (`body.match`), and each address can override it.
//    Nothing set means Auto.
//  - Auto: the same host first. Another host on the same domain counts too, unless the
//    vault says that host is a separate service: the page's host has a login of its own,
//    or the vault has logins for more than one host there. Then it's listed apart, under
//    "Other logins for <domain>". A site's own sign-in host (the domain itself, www.,
//    login., accounts., auth. and so on) still counts for the whole domain.
//  - A saved address with no port matches its host on any port. One with a port matches
//    that port only. Another host only ever matches on the default port, or the saved one.
//  - An IP address or a single name (http://nas) only ever matches itself.
//  - A saved https login never fills on http unless someone confirms it.
// Android's Match.kt is a port of this file; match-vectors.json keeps the two together.
import { getDomain, getHostname } from "tldts";

import SHARED from "./data/shared-credentials.json";
import type { Item, LoginUrl, UrlMatch } from "./model";

export function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    // An app's id isn't a website: android://com.acme.app must not match acme.app.
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return getHostname(url)?.toLowerCase() ?? null;
  }
}

export function baseDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true })?.toLowerCase() ?? null;
}

type SharedGroup = { shared?: string[]; from?: string[]; to?: string[]; fromDomainsAreObsoleted?: boolean };

/** domain -> every domain it shares credentials with. */
const GROUPS: Map<string, Set<string>> = (() => {
  const out = new Map<string, Set<string>>();
  const link = (a: string[], b: string[]) => {
    for (const x of a) {
      const set = out.get(x) ?? new Set<string>();
      for (const y of b) if (y !== x) set.add(y);
      out.set(x, set);
    }
  };
  for (const g of SHARED as SharedGroup[]) {
    if (g.shared) link(g.shared, g.shared);
    if (g.from && g.to) {
      link(g.from, g.to);
      if (!g.fromDomainsAreObsoleted) link(g.to, g.from);
    }
  }
  return out;
})();

export function sharedWith(domain: string): Set<string> {
  return GROUPS.get(domain) ?? new Set();
}

/** How a match came about, best first in RANK. `anyport` is the right host on a port the
 *  saved address didn't name. `sibling` is another host on the same domain that the vault
 *  says is a separate service: it's offered apart, under "Other logins for <domain>". */
export type MatchKind = "exact" | "host" | "regex" | "prefix" | "anyport" | "base" | "shared" | "sibling";

/** The choices for a whole item, in the order the editors show them. */
export const ITEM_MATCHES: { value: UrlMatch; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "This host first. Other hosts on the same domain too, unless they have logins of their own." },
  { value: "base", label: "Same domain", hint: "Any host on the same domain, like Bitwarden's default." },
  { value: "host", label: "Exact host", hint: "Only this host, on any port if the address has none." },
  { value: "port", label: "Exact host and port", hint: "Only this host, and only on this port." },
  { value: "prefix", label: "Starts with", hint: "Only pages whose address starts with this one." },
  { value: "never", label: "Never", hint: "Never offered on a website. Search for it to fill by hand." },
];

/** Per address: the item's setting unless the address has its own. */
export const URL_MATCHES: { value: UrlMatch | ""; label: string }[] = [
  { value: "", label: "As the login" },
  ...ITEM_MATCHES.map(({ value, label }) => ({ value, label })),
  { value: "exact", label: "Exact address" },
  { value: "regex", label: "Regular expression" },
];

const KNOWN: ReadonlySet<string> = new Set(["auto", "base", "host", "port", "prefix", "exact", "regex", "never"]);

/** The rule one address follows. Something this version doesn't know, from a newer client,
 *  gets the strictest host rule rather than a looser one. */
export function modeOf(saved: LoginUrl, itemMatch?: UrlMatch | null): UrlMatch {
  const m = saved.match ?? itemMatch ?? "auto";
  return KNOWN.has(m) ? m : "port";
}

/** A saved address as the web reads it, or null if it isn't a website. */
function parseSaved(url: string): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname ? u : null;
  } catch {
    return null;
  }
}

/** www.example.com and example.com are one site to Auto. Not www.github.io and github.io,
 *  which belong to different people: the www. only goes when the domain stays the same. */
export function hostKey(host: string): string {
  if (!host.startsWith("www.")) return host;
  const rest = host.slice(4);
  const b = baseDomain(rest);
  return b !== null && b === baseDomain(host) ? rest : host;
}

/** Where a site usually signs everyone in. A login saved there is for the whole domain. */
const SIGN_IN = new Set(["login", "logon", "signin", "sign-in", "account", "accounts", "auth", "sso", "id", "identity", "idp", "secure", "passport"]);

/** Whether a login saved at `saved` is for the whole of `page`'s domain, not one service on it:
 *  it's the domain itself, a host above the page, or a sign-in host above the page. */
function domainWide(saved: string, page: string, base: string): boolean {
  if (saved === base || page.endsWith(`.${saved}`)) return true;
  const dot = saved.indexOf(".");
  if (dot < 0) return false;
  const label = saved.slice(0, dot);
  const rest = saved.slice(dot + 1);
  return SIGN_IN.has(label) && (rest === page || page.endsWith(`.${rest}`)) && (rest === base || rest.endsWith(`.${base}`));
}

/** What the rest of the vault says about this page, for Auto. `exactHere`: some login is
 *  saved for this very host and port. `hostsUnderBase`: how many hosts on the page's domain
 *  have logins. With none given, a login is judged alone, as if it were the only one. */
export type PageContext = { exactHere: boolean; hostsUnderBase: number };

const ALONE: PageContext = { exactHere: false, hostsUnderBase: 1 };

/** The same port: a saved address with no port means the page's default one. */
function samePort(saved: URL, page: URL): boolean {
  return saved.port === page.port;
}

export function pageContext(entries: Iterable<{ url: string; mode: UrlMatch }>, pageUrl: string): PageContext {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return ALONE;
  }
  const pageHost = page.hostname.toLowerCase();
  const pageKey = hostKey(pageHost);
  const pageBase = baseDomain(pageHost);
  let exactHere = false;
  const hosts = new Set<string>();
  for (const e of entries) {
    if (e.mode === "never" || e.mode === "regex") continue;
    const s = parseSaved(e.url);
    if (!s) continue;
    const h = s.hostname.toLowerCase();
    const k = hostKey(h);
    if (k === pageKey && samePort(s, page)) exactHere = true;
    if (pageBase && (h === pageBase || h.endsWith(`.${pageBase}`)) && baseDomain(h) === pageBase) hosts.add(k);
  }
  return { exactHere, hostsUnderBase: hosts.size };
}

/** Every address of every login that could be offered, with the rule it follows. */
export function webEntries(items: Item[]): { url: string; mode: UrlMatch }[] {
  const out: { url: string; mode: UrlMatch }[] = [];
  for (const item of items) {
    if (item.deleted || item.body.archived || item.body.kind !== "login") continue;
    for (const u of item.body.urls ?? []) out.push({ url: u.url, mode: modeOf(u, item.body.match) });
  }
  return out;
}

const SAFE_REGEX_LEN = 200;

/** A user's own regex, kept away from catastrophic patterns by shape and size. It has to
 *  match from the start of the address and take in the whole origin, so "example.com" can't
 *  match example.com.evil.test or evil.test/?example.com. */
function regexMatches(pattern: string, page: URL): boolean {
  if (pattern.length > SAFE_REGEX_LEN) return false;
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) return false;
  // A repeated choice can blow up too: (a|aa)+. Android refuses the same.
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return false;
  try {
    const m = new RegExp(pattern).exec(page.href);
    return !!m && m.index === 0 && m[0].length >= page.origin.length;
  } catch {
    return false;
  }
}

/** Same origin first: a plain string prefix lets https://bank.example match
 *  https://bank.example.evil.test. */
function prefixMatches(saved: string, page: URL): boolean {
  try {
    const s = new URL(saved.includes("://") ? saved : `https://${saved}`);
    return s.origin === page.origin && page.href.startsWith(s.href);
  } catch {
    return false;
  }
}

export type MatchOptions = { itemMatch?: UrlMatch | null; ctx?: PageContext };

export function matchUrl(saved: LoginUrl, pageUrl: string, opts: MatchOptions = {}): MatchKind | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  // Never about:blank, data:, file: or a browser's own pages.
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;
  if (page.username || page.password) return null;
  const mode = modeOf(saved, opts.itemMatch);
  if (mode === "never") return null;
  if (mode === "regex") return regexMatches(saved.url, page) ? "regex" : null;
  if (mode === "exact") return normalize(saved.url) === normalize(pageUrl) ? "exact" : null;
  if (mode === "prefix") return prefixMatches(saved.url, page) ? "prefix" : null;

  const s = parseSaved(saved.url);
  if (!s) return null;
  const ctx = opts.ctx ?? ALONE;
  const savedHost = s.hostname.toLowerCase();
  const pageHost = page.hostname.toLowerCase();
  const auto = mode === "auto";
  const savedKey = auto ? hostKey(savedHost) : savedHost;
  const pageKey = auto ? hostKey(pageHost) : pageHost;
  const portOk = samePort(s, page);

  if (savedKey === pageKey) {
    if (portOk) return "host";
    // The same machine on a port the address didn't name (D91). Not for "port", and
    // in Auto it steps aside for a login saved for this very port.
    if (s.port !== "" || mode === "port") return null;
    return auto && ctx.exactHere ? "sibling" : "anyport";
  }
  if (mode === "host" || mode === "port") return null;
  // Another host: on the saved port, or the default one. IP addresses and single names have
  // no domain, so they stop here.
  if (!portOk) return null;
  const savedBase = baseDomain(savedHost);
  const pageBase = baseDomain(pageHost);
  if (!savedBase || !pageBase) return null;
  if (savedBase === pageBase) {
    if (!auto) return "base";
    if (ctx.exactHere) return "sibling";
    if (domainWide(savedKey, pageKey, savedBase)) return "base";
    return ctx.hostsUnderBase <= 1 ? "base" : "sibling";
  }
  if (sharedWith(savedBase).has(pageBase)) return "shared";
  return null;
}

function normalize(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/$/, "")}${x.search}`;
  } catch {
    return u;
  }
}

export const RANK: Record<MatchKind, number> = { exact: 0, host: 1, regex: 2, prefix: 2, anyport: 3, base: 4, shared: 5, sibling: 6 };

/** A match that's offered as this site's, rather than listed apart. */
export const isPrimary = (kind: MatchKind) => kind !== "sibling";

/** A match good enough to update a saved password from this page, or fill it unasked:
 *  the same host and port, or the exact address. */
export const isExactKind = (kind: MatchKind) => kind === "host" || kind === "exact";

export type Candidate = { item: Item; kind: MatchKind; downgrade: boolean };

/** Best matches first: exact host, then recently used. ``downgrade`` is a saved
 *  https login on an http page, which only fills after a confirmation. Logins that Auto
 *  judges to be for another service on the domain come last, with kind "sibling". */
export function matchItems(items: Item[], pageUrl: string, recent: Record<string, number> = {}): Candidate[] {
  const out: Candidate[] = [];
  let scheme = "";
  try {
    scheme = new URL(pageUrl).protocol;
  } catch {
    return [];
  }
  const ctx = pageContext(webEntries(items), pageUrl);
  for (const item of items) {
    if (item.deleted || item.body.archived || item.body.kind !== "login") continue;
    let best: MatchKind | null = null;
    let savedHttps = false;
    for (const u of item.body.urls ?? []) {
      const k = matchUrl(u, pageUrl, { itemMatch: item.body.match, ctx });
      if (k && (best === null || RANK[k] < RANK[best])) {
        best = k;
        savedHttps = u.url.startsWith("https://") || !u.url.includes("://");
      }
    }
    if (best) out.push({ item, kind: best, downgrade: scheme === "http:" && savedHttps });
  }
  return out.sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || (recent[b.item.id] ?? 0) - (recent[a.item.id] ?? 0) || a.item.body.title.localeCompare(b.item.body.title),
  );
}

/** What "Other logins for ..." names: the page's domain, or its host if it has none. */
export function siteName(pageUrl: string): string {
  try {
    const h = new URL(pageUrl).hostname.toLowerCase();
    return baseDomain(h) ?? h;
  } catch {
    return "";
  }
}

// ---- Lookalike check (plan 5.13) ---------------------------------------------

/** Common homoglyphs, to a plain latin skeleton. */
const CONFUSABLE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ɡ: "g", ո: "n", ν: "v", ο: "o", α: "a", ι: "i",
  "0": "o", "1": "l", "|": "l", "5": "s", "3": "e", "7": "t", "$": "s",
};

export function skeleton(domain: string): string {
  let s = domain.normalize("NFKD").toLowerCase().replace(/[̀-ͯ]/g, "");
  s = s.replace(/rn/g, "m").replace(/vv/g, "w");
  return [...s].map((c) => CONFUSABLE[c] ?? c).join("").replace(/l/g, "i");
}

/** Damerau-Levenshtein: a swap of two neighbours counts as one edit. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The domain in your vault this page looks like but isn't, if any. */
export function lookalikeOf(pageHost: string, savedDomains: Iterable<string>): string | null {
  const page = baseDomain(pageHost.toLowerCase());
  if (!page) return null;
  const known = new Set<string>();
  for (const d of savedDomains) {
    const b = baseDomain(d.toLowerCase());
    if (b) known.add(b);
  }
  if (known.has(page)) return null;
  for (const k of known) if (sharedWith(k).has(page)) return null;
  const isPuny = page.includes("xn--");
  const pageName = page.split(".")[0];
  const pageSkel = skeleton(pageName);
  for (const k of known) {
    const name = k.split(".")[0];
    if (name.length < 4) continue;
    if (pageName === name) return k; // same name, different suffix: paypal.co vs paypal.com
    if (skeleton(name) === pageSkel) return k;
    const limit = name.length >= 8 ? 2 : 1;
    if (editDistance(pageName, name) <= limit) return k;
    if (pageName.includes(name) && /(^|[-.])(login|secure|account|verify|signin|auth|support|update)|(login|secure|account|verify|signin|auth|support|update)($|[-.])/.test(pageName)) return k;
    if (isPuny) return k;
  }
  return null;
}
