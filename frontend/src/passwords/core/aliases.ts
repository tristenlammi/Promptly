// Aliases on a domain you own: shop.k7m2@yourdomain.com, one for each login.
//
// The server makes the random part and keeps the address, because Mail needs it to
// route mail. What it never gets is the login's site or name: the word that starts
// the alias is chosen here (a random word by default), and the check for "mail from
// a sender unlike the site" runs here, against the item's own websites.
import type { VaultApi } from "./api";
import { randomInt } from "./bytes";
import { baseDomain, hostOf, sharedWith } from "./match";
import type { Item } from "./model";
import { WORDLIST } from "./safety";

export type WordStyle = "word" | "site" | "custom" | "none";
export type AliasDomain = {
  id: string;
  domain: string;
  account_id: string;
  account_email: string;
  word_style: WordStyle;
  random_len: number;
  separator: "." | "-" | "_";
  off_folder_id: string | null;
  status: "new" | "checking" | "ok" | "failed";
  status_detail: string;
  checked_at: string | null;
  send_as: "unknown" | "ok" | "rewritten" | "refused";
  send_as_detail: string;
  aliases: number;
};
export type AliasSender = { domain: string; count: number; last_at: string; unlike: boolean };
export type Alias = {
  id: string;
  address: string;
  domain_id: string;
  domain: string;
  account_id: string;
  item_id: string | null;
  enabled: boolean;
  disabled_at: string | null;
  created_at: string;
  baseline: string;
  allowed_senders: string[];
  flagged_at: string | null;
  flagged_sender: string;
  count: number;
  last_at: string | null;
  senders: AliasSender[];
  send_as: AliasDomain["send_as"];
  send_as_text: string;
};
export type MailFolderRow = { id: string; name: string; path: string; role: string };

export function aliasApi(api: VaultApi) {
  return {
    accounts: () => api.request<{ id: string; email: string }[]>("GET", "/aliases/accounts"),
    domains: () => api.request<AliasDomain[]>("GET", "/aliases/domains"),
    addDomain: (domain: string, account_id: string) => api.request<AliasDomain>("POST", "/aliases/domains", { domain, account_id }),
    editDomain: (id: string, patch: Partial<Pick<AliasDomain, "account_id" | "word_style" | "random_len" | "separator" | "off_folder_id">> & { off_to_trash?: boolean }) =>
      api.request<AliasDomain>("PATCH", `/aliases/domains/${id}`, patch),
    removeDomain: (id: string) => api.request<void>("DELETE", `/aliases/domains/${id}`),
    check: (id: string) => api.request<AliasDomain>("POST", `/aliases/domains/${id}/check`),
    folders: (id: string) => api.request<MailFolderRow[]>("GET", `/aliases/domains/${id}/folders`),
    list: () => api.request<Alias[]>("GET", "/aliases"),
    make: (domain_id: string, word: string, item_id?: string | null) => api.request<Alias>("POST", "/aliases", { domain_id, word, item_id: item_id ?? null }),
    edit: (id: string, patch: { enabled?: boolean; item_id?: string; unlink?: boolean }) => api.request<Alias>("PATCH", `/aliases/${id}`, patch),
    allow: (id: string, sender: string) => api.request<Alias>("POST", `/aliases/${id}/allow`, { sender }),
    remove: (id: string) => api.request<void>("DELETE", `/aliases/${id}`),
  };
}

/** What the server would keep of a word anyway. */
export function cleanWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
}

/** "https://www.shop.example.co.uk/login" -> "shop". */
export function siteWord(url: string): string {
  const host = hostOf(url);
  if (!host) return "";
  return cleanWord((baseDomain(host) ?? host).split(".")[0]);
}

export function randomWord(): string {
  for (let i = 0; i < 20; i++) {
    const w = cleanWord(WORDLIST[randomInt(WORDLIST.length)]);
    if (w.length >= 3 && w.length <= 9) return w;
  }
  return "mail";
}

/** The word an alias starts with. A random word gives nothing away to anyone who
 *  sees the address; the site's name is easier to read but tells the server too. */
export function aliasWord(style: WordStyle, from: { url?: string; custom?: string } = {}): string {
  if (style === "none") return "";
  if (style === "custom") return cleanWord(from.custom ?? "") || randomWord();
  if (style === "site") return siteWord(from.url ?? "") || randomWord();
  return randomWord();
}

function brand(domain: string): string {
  const d = domain.toLowerCase().replace(/^@/, "");
  return (baseDomain(d) ?? d).split(".")[0];
}

/** Same rule as the server's: amazonses.com mails for amazon.com, and a sub-domain
 *  for its parent. Loose on purpose; a miss is a flag someone can clear. */
export function sameBusiness(a: string, b: string): boolean {
  const ba = baseDomain(a.toLowerCase());
  const bb = baseDomain(b.toLowerCase());
  if (ba && bb && (ba === bb || sharedWith(ba).has(bb))) return true;
  const [x, y] = [brand(a), brand(b)].sort((p, q) => p.length - q.length);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.includes(x));
}

export type AliasWarning = { sender: string; count: number; lastAt: string };

/** Senders that don't look like the site this alias is for: a sign it was sold or
 *  leaked. With the login at hand it's judged against the login's websites, here.
 *  Without it, the server's guess (the first sender the alias heard from) is used. */
export function aliasWarnings(alias: Alias, item?: Item | null): AliasWarning[] {
  const sites = (item?.body.urls ?? []).map((u) => hostOf(u.url)).filter((h): h is string => !!h);
  const allowed = alias.allowed_senders;
  return alias.senders
    .filter((s) => s.domain && s.domain !== alias.domain)
    .filter((s) => !allowed.some((ok) => sameBusiness(s.domain, ok)))
    .filter((s) => (sites.length ? !sites.some((site) => sameBusiness(s.domain, site)) : s.unlike))
    .map((s) => ({ sender: s.domain, count: s.count, lastAt: s.last_at }));
}

export function aliasesFor(aliases: Alias[], itemId: string): Alias[] {
  return aliases.filter((a) => a.item_id === itemId);
}

/** Has the setup check finished, one way or the other? */
export function checkSettled(d: AliasDomain): boolean {
  return d.status !== "checking";
}
