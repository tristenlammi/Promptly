// Security check, computed on the device. The only thing that leaves is the first
// five characters of a password's SHA-1, through your server, with padded replies.
import { hex } from "./bytes";
import { hostOf, baseDomain } from "./match";
import type { Item } from "./model";
import { strengthOf } from "./strength";

export type HealthIssue = "weak" | "reused" | "old" | "breached" | "http" | "no2fa" | "has_passkey_option";
export type HealthReport = {
  weak: Item[];
  reused: { items: Item[] }[];
  old: Item[];
  http: Item[];
  breached: { item: Item; count: number }[];
  no2fa: { item: Item; doc?: string }[];
  /** No 2FA saved here, on a site the directory says nothing about. */
  noTotp: Item[];
  noPasskey: Item[];
  checked: number;
};

const OLD_MS = 365 * 24 * 3600 * 1000;

export async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>);
  return hex(new Uint8Array(d)).toUpperCase();
}

/** Range lookup: the server (and HIBP) only ever see the first five characters.
 *  Padding entries come back with a count of 0 and are ignored. */
export async function breachCount(password: string, range: (prefix: string) => Promise<string>): Promise<number> {
  const h = await sha1Hex(password);
  const text = await range(h.slice(0, 5));
  const suffix = h.slice(5);
  for (const line of text.split(/\r?\n/)) {
    const [s, c] = line.trim().split(":");
    if (s === suffix) return Number(c) || 0;
  }
  return 0;
}

export type TwoFaDirectory = Record<string, { documentation?: string; methods?: string[] }>;

export function supports2fa(host: string, dir: TwoFaDirectory): { doc?: string } | null {
  const d = baseDomain(host) ?? host;
  const e = dir[d] ?? dir[host];
  return e ? { doc: e.documentation } : null;
}

export async function runHealth(
  items: Item[],
  opts: {
    range?: (prefix: string) => Promise<string>;
    twofa?: TwoFaDirectory;
    passkeys?: Record<string, unknown>;
    onProgress?: (done: number, total: number) => void;
    now?: number;
  } = {},
): Promise<HealthReport> {
  const now = opts.now ?? Date.now();
  const logins = items.filter((i) => i.body.kind === "login" && i.body.password && !i.deleted && !i.body.archived);
  const report: HealthReport = { weak: [], reused: [], old: [], http: [], breached: [], no2fa: [], noTotp: [], noPasskey: [], checked: logins.length };

  const byPassword = new Map<string, Item[]>();
  for (const i of logins) {
    const pw = i.body.password!;
    byPassword.set(pw, [...(byPassword.get(pw) ?? []), i]);
  }
  for (const group of byPassword.values()) {
    if (group.length > 1) report.reused.push({ items: group });
  }

  let done = 0;
  const strength = new Map<string, number>();
  for (const i of logins) {
    const pw = i.body.password!;
    let s = strength.get(pw);
    if (s === undefined) {
      s = (await strengthOf(pw, [i.body.username ?? "", i.body.title])).score;
      strength.set(pw, s);
    }
    if (s <= 1) report.weak.push(i);
    const changed = i.body.passwordChangedAt ?? i.body.createdAt;
    if (changed && now - new Date(changed).getTime() > OLD_MS) report.old.push(i);
    if ((i.body.urls ?? []).some((u) => u.url.startsWith("http://") && !/^http:\/\/(localhost|127\.|192\.168\.|10\.|\[?::1)/.test(u.url))) report.http.push(i);
    const host = hostOf(i.body.urls?.[0]?.url ?? "");
    if (!i.body.totp) {
      const hit = host && opts.twofa ? supports2fa(host, opts.twofa) : null;
      if (hit) report.no2fa.push({ item: i, doc: hit.doc });
      else report.noTotp.push(i);
    }
    if (host && !i.body.passkeys?.length && opts.passkeys) {
      if (opts.passkeys[baseDomain(host) ?? host]) report.noPasskey.push(i);
    }
    opts.onProgress?.(++done, logins.length);
  }

  if (opts.range) {
    const seen = new Map<string, number>();
    for (const i of logins) {
      const pw = i.body.password!;
      let c = seen.get(pw);
      if (c === undefined) {
        c = await breachCount(pw, opts.range);
        seen.set(pw, c);
      }
      if (c > 0) report.breached.push({ item: i, count: c });
    }
  }
  return report;
}

export function coarseCounts(r: HealthReport): { weak: number; reused: number; breached: number; old: number } {
  return { weak: r.weak.length, reused: r.reused.reduce((n, g) => n + g.items.length, 0), breached: r.breached.length, old: r.old.length };
}
