// "Accounts you have": the server finds sites in your own mail, and this compares them
// with the vault here, on the device. Which sites you have logins for never goes to the
// server, and nor does what you decide about a row: that's kept in the vault, encrypted.
import { changePageUrl } from "./connections";
import { baseDomain, hostOf, sharedWith } from "./match";
import { type Item, type ItemBody, newBody } from "./model";

export type EvidenceKind = "reset" | "signin" | "security" | "verify" | "welcome" | "subscription" | "receipt";

export type DeletionHelp = { url?: string | null; email?: string | null; difficulty?: string | null; name?: string | null };

export type MailSite = {
  domain: string;
  name: string;
  address: string;
  account_id: string;
  kinds: EvidenceKind[];
  first_seen: string;
  last_seen: string;
  /** "account_id/thread_key", for /mail?open=… */
  open: string | null;
  deletion: DeletionHelp | null;
};

export type MailSites = { mail: boolean; complete: boolean; sites: MailSite[] };

/** What this person said about a site, kept in their personal vault. */
export type SiteState = { state: "hidden" | "deleting" | "gone"; at: string };
export type AccountPrefs = { sites: Record<string, SiteState> };

/** The prefs item's title: one per personal vault. */
export const ACCOUNT_PREFS = "mail-accounts";

export function readPrefs(items: Item[], personalVaultId: string | null): { item: Item | null; prefs: AccountPrefs } {
  const item = items.find((i) => !i.deleted && i.body.kind === "prefs" && i.body.title === ACCOUNT_PREFS && (!personalVaultId || i.vaultId === personalVaultId)) ?? null;
  const raw = (item?.body.prefs as { sites?: unknown } | undefined)?.sites;
  const sites: Record<string, SiteState> = {};
  if (raw && typeof raw === "object") {
    for (const [domain, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as Partial<SiteState> | null;
      if (s && (s.state === "hidden" || s.state === "deleting" || s.state === "gone") && typeof s.at === "string") sites[domain] = { state: s.state, at: s.at };
    }
  }
  return { item, prefs: { sites } };
}

export function withSiteState(prefs: AccountPrefs, domain: string, state: SiteState["state"] | null, at = new Date().toISOString()): AccountPrefs {
  const sites = { ...prefs.sites };
  if (state) sites[domain] = { state, at };
  else delete sites[domain];
  return { sites };
}

/** The body to save, keeping anything else a newer client put in the item. */
export function prefsBody(prev: ItemBody | null, prefs: AccountPrefs): ItemBody {
  const base = prev ?? newBody("prefs", ACCOUNT_PREFS);
  return { ...base, prefs: { ...((base.prefs as Record<string, unknown>) ?? {}), sites: prefs.sites } };
}

/** Every site the vault has a login for, as base domains: its addresses, and the sites
 *  of its passkeys. Archived logins count; they're still yours. */
export function vaultDomains(items: Item[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (item.deleted || item.body.kind !== "login") continue;
    for (const u of item.body.urls ?? []) {
      const host = hostOf(u.url);
      const base = host ? baseDomain(host) : null;
      if (base) out.add(base);
    }
    for (const p of item.body.passkeys ?? []) {
      const base = p.rpId ? baseDomain(p.rpId.toLowerCase()) : null;
      if (base) out.add(base);
    }
  }
  return out;
}

export function inVault(domain: string, have: Set<string>): boolean {
  const base = baseDomain(domain.toLowerCase());
  if (!base) return false;
  if (have.has(base)) return true;
  for (const other of sharedWith(base)) if (have.has(other)) return true;
  return false;
}

export type AccountRow = {
  /** The site's base domain, by the real Public Suffix List. */
  domain: string;
  /** Mail sites that share this domain, newest first: one per mailbox. */
  sites: MailSite[];
  kinds: EvidenceKind[];
  firstSeen: string;
  lastSeen: string;
  state: SiteState | null;
};

const ORDER: EvidenceKind[] = ["reset", "signin", "security", "verify", "welcome", "subscription", "receipt"];

/** The list to show: sites from mail with no login in the vault, minus those marked
 *  "not an account" or gone. Ones being deleted stay, marked, until they're gone. */
export function accountsNotInVault(list: MailSite[], items: Item[], prefs: AccountPrefs): AccountRow[] {
  const have = vaultDomains(items);
  const rows = new Map<string, AccountRow>();
  for (const site of list) {
    const domain = baseDomain(site.domain.toLowerCase());
    if (!domain || inVault(domain, have)) continue;
    const state = prefs.sites[domain] ?? null;
    if (state && state.state !== "deleting") continue;
    const row = rows.get(domain) ?? { domain, sites: [], kinds: [], firstSeen: site.first_seen, lastSeen: site.last_seen, state };
    row.sites.push(site);
    for (const k of site.kinds) if (!row.kinds.includes(k)) row.kinds.push(k);
    if (site.first_seen < row.firstSeen) row.firstSeen = site.first_seen;
    if (site.last_seen > row.lastSeen) row.lastSeen = site.last_seen;
    rows.set(domain, row);
  }
  for (const row of rows.values()) {
    row.kinds.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    row.sites.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  }
  // Being deleted first, then what was seen most recently.
  return [...rows.values()].sort((a, b) => Number(b.state?.state === "deleting") - Number(a.state?.state === "deleting") || b.lastSeen.localeCompare(a.lastSeen));
}

export const KIND_TEXT: Record<EvidenceKind, string> = {
  reset: "password reset",
  signin: "sign-in alert",
  security: "account change",
  verify: "email check",
  welcome: "welcome",
  subscription: "subscription",
  receipt: "receipt",
};

/** A new login for this site, with the address the site has. */
export function loginFor(row: AccountRow): ItemBody {
  const site = row.sites[0];
  const name = row.domain.split(".")[0];
  return newBody("login", name.charAt(0).toUpperCase() + name.slice(1), { urls: [{ url: `https://${row.domain}` }], username: site?.address ?? "" });
}

export type DeletionLinks = {
  /** A page known to delete the account, from JustDeleteMe's list. */
  known: string | null;
  difficulty: string | null;
  /** Where account settings usually are: the site's known change-password page, or its
   *  /.well-known/change-password, which goes to the change-password page, usually
   *  inside account settings. */
  settings: string;
};

export function deletionLinks(row: AccountRow): DeletionLinks {
  const help = row.sites.find((s) => s.deletion)?.deletion ?? null;
  const known = help?.url && /^https:\/\//i.test(help.url) ? help.url : null;
  const settings = changePageUrl(newBody("login", row.domain, { urls: [{ url: `https://${row.domain}` }] })) ?? `https://${row.domain}/.well-known/change-password`;
  return { known, difficulty: help?.difficulty ?? null, settings };
}

export type DeletionEmail = { to: string; subject: string; body: string; from: string; guessed: boolean };

/** A data deletion request, ready to check and send from the mailbox the site writes to.
 *  It only opens as a draft: nothing is ever sent without the person pressing Send. */
export function deletionEmail(row: AccountRow): DeletionEmail {
  const site = row.sites[0];
  const help = row.sites.find((s) => s.deletion?.email)?.deletion;
  const to = help?.email ?? `privacy@${row.domain}`;
  const address = site?.address ?? "";
  const body = [
    "Hello,",
    `Please delete my account with ${row.domain} and all personal data you hold about me. The account uses the email address ${address}.`,
    "I'm asking under the data protection law that applies to me, such as the right to erasure in Article 17 of the GDPR.",
    "Please confirm once the account and data have been deleted. If you need to check it's me, reply to this email.",
    "Thank you.",
  ].join("\n\n");
  return { to, subject: `Request to delete my account and personal data (${address})`, body, from: site?.account_id ?? "", guessed: !help?.email };
}

/** A link that opens Promptly Mail with this as a new draft. The draft rides in the part
 *  after #, which the browser never sends to the server. */
export function composeHref(baseUrl: string, mail: DeletionEmail): string {
  const hash = new URLSearchParams({ to: mail.to, subject: mail.subject, body: mail.body, ...(mail.from ? { from: mail.from } : {}) });
  return `${baseUrl.replace(/\/$/, "")}/mail?compose=1#${hash.toString()}`;
}

export function openHref(baseUrl: string, open: string | null): string | null {
  return open && /^[0-9a-f-]{36}\/[0-9a-zA-Z_-]{1,40}$/.test(open) ? `${baseUrl.replace(/\/$/, "")}/mail?open=${open}` : null;
}
