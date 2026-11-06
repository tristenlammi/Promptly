// Which saved logins belong to a page (plan 6.2). Public Suffix List base-domain
// match by default, per-URL options, shared-credential site groups, and the rule
// that a saved https login never fills on http unless someone confirms it.
import { getDomain, getHostname } from "tldts";

import SHARED from "./data/shared-credentials.json";
import type { Item, LoginUrl, UrlMatch } from "./model";

export function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
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

export type MatchKind = "exact" | "host" | "base" | "shared" | "regex" | "prefix";

const SAFE_REGEX_LEN = 200;

/** A user's own regex, kept away from catastrophic patterns by shape and size. */
function regexMatches(pattern: string, url: string): boolean {
  if (pattern.length > SAFE_REGEX_LEN) return false;
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) return false;
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
}

export function matchUrl(saved: LoginUrl, pageUrl: string): MatchKind | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  // Never about:blank, data:, file: or a browser's own pages.
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;
  if (page.username || page.password) return null;
  const mode: UrlMatch = saved.match ?? "base";
  if (mode === "never") return null;
  if (mode === "regex") return regexMatches(saved.url, pageUrl) ? "regex" : null;
  if (mode === "exact") return normalize(saved.url) === normalize(pageUrl) ? "exact" : null;
  if (mode === "prefix") return pageUrl.startsWith(saved.url) ? "prefix" : null;

  const savedHost = hostOf(saved.url);
  const pageHost = page.hostname.toLowerCase();
  if (!savedHost) return null;
  // IP addresses and single-label hosts only ever match exactly.
  const savedBase = baseDomain(savedHost);
  const pageBase = baseDomain(pageHost);
  if (savedHost === pageHost) return portsMatch(saved.url, page) ? "host" : null;
  if (mode === "host") return null;
  if (!savedBase || !pageBase) return null;
  if (savedBase === pageBase) return "base";
  if (sharedWith(savedBase).has(pageBase)) return "shared";
  return null;
}

function portsMatch(savedUrl: string, page: URL): boolean {
  try {
    const u = new URL(savedUrl.includes("://") ? savedUrl : `https://${savedUrl}`);
    // A saved port must match. No saved port means any standard one.
    return !u.port || u.port === page.port;
  } catch {
    return true;
  }
}

function normalize(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/$/, "")}${x.search}`;
  } catch {
    return u;
  }
}

const RANK: Record<MatchKind, number> = { exact: 0, host: 1, regex: 2, prefix: 2, base: 3, shared: 4 };

export type Candidate = { item: Item; kind: MatchKind; downgrade: boolean };

/** Best matches first: exact host, then recently used. ``downgrade`` is a saved
 *  https login on an http page, which only fills after a confirmation. */
export function matchItems(items: Item[], pageUrl: string, recent: Record<string, number> = {}): Candidate[] {
  const out: Candidate[] = [];
  let scheme = "";
  try {
    scheme = new URL(pageUrl).protocol;
  } catch {
    return [];
  }
  for (const item of items) {
    if (item.deleted || item.body.archived || item.body.kind !== "login") continue;
    let best: MatchKind | null = null;
    let savedHttps = false;
    for (const u of item.body.urls ?? []) {
      const k = matchUrl(u, pageUrl);
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
