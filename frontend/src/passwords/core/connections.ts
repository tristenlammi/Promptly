// Where the vault meets the rest of Promptly, on the client's side: the server hands
// over what it can see (mail, say), and these compare it with the vault here, so the
// server never learns which sites you have logins for.
import { b64u, fromB64u, randomBytes, utf8 } from "./bytes";
import quirks from "./data/change-password-URLs.json";
import { aad, open, seal } from "./format";
import { baseDomain, hostOf, lookalikeOf, sharedWith } from "./match";
import { type AttachmentRef, type HistoryEntry, type Item, type ItemBody, touch } from "./model";
import { aesKey, argon2, hkdf, KDF_FLOOR } from "./primitives";

// ---- Mail codes ----------------------------------------------------------------------

export type MailCode = { id: string; from_name: string; from_domain: string; at: string; code: string | null; link: string | null };
export type RankedCode = MailCode & {
  /** The sender belongs to this site. Others are shown lower, with a warning. */
  matches: boolean;
  /** The sender's domain looks like a site you have a login for, without being it. */
  lookalike: string | null;
  agoSeconds: number;
};

function related(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return sharedWith(a).has(b);
}

export function rankMailCodes(codes: MailCode[], pageUrl: string, savedDomains: Iterable<string>, now = Date.now()): RankedCode[] {
  const page = hostOf(pageUrl);
  const pageBase = page ? baseDomain(page) : null;
  const saved = [...savedDomains];
  const ranked = codes.map((c) => {
    const sender = baseDomain(c.from_domain);
    const matches = related(sender, pageBase);
    return { ...c, matches, lookalike: matches ? null : lookalikeOf(c.from_domain, saved), agoSeconds: Math.max(0, Math.round((now - new Date(c.at).getTime()) / 1000)) };
  });
  return ranked.sort((a, b) => Number(b.matches) - Number(a.matches) || a.agoSeconds - b.agoSeconds);
}

/** A sign-in link is only offered when it goes where the sender is. */
export function linkIsSafe(c: Pick<MailCode, "link" | "from_domain">): boolean {
  if (!c.link) return false;
  let url: URL;
  try {
    url = new URL(c.link);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return related(baseDomain(url.hostname), baseDomain(c.from_domain));
}

export function agoText(seconds: number): string {
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

// ---- Security emails -----------------------------------------------------------------

export type SecurityEvent = { id: string; kind: "password_changed" | "new_signin"; from_name: string; from_domain: string; subject: string; at: string };
export type SecurityAlert = { event: SecurityEvent; item: Item; text: string };

export function savedDomainsOf(items: Item[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) {
    for (const u of i.body.urls ?? []) {
      const h = hostOf(u.url);
      const b = h ? baseDomain(h) : null;
      if (b) out.add(b);
    }
  }
  return out;
}

export function securityAlerts(events: SecurityEvent[], items: Item[]): SecurityAlert[] {
  const out: SecurityAlert[] = [];
  for (const event of events) {
    const sender = baseDomain(event.from_domain);
    const item = items.find((i) => i.body.kind === "login" && (i.body.urls ?? []).some((u) => {
      const h = hostOf(u.url);
      return related(h ? baseDomain(h) : null, sender);
    }));
    if (!item) continue;
    const who = event.from_name || event.from_domain;
    const what = event.kind === "password_changed" ? "your password changed" : "there was a new sign-in";
    out.push({ event, item, text: `${who} says ${what}. Was that you?` });
  }
  return out;
}

// ---- Change password -----------------------------------------------------------------

const CHANGE_URLS = quirks as Record<string, string>;

/** The site's own change-password page, as far as anyone's written down. */
export function changePageUrl(body: ItemBody): string | null {
  for (const u of body.urls ?? []) {
    const host = hostOf(u.url);
    if (!host || !/^https?:/i.test(u.url)) continue;
    const base = baseDomain(host);
    const known = CHANGE_URLS[host] ?? (base ? CHANGE_URLS[base] : undefined);
    if (known) return known;
    return `https://${host}/.well-known/change-password`;
  }
  return null;
}

/** Saved before the site's told, so a failed change can't lose the new one. */
export function withPending(body: ItemBody, password: string): ItemBody {
  return touch(body, { ...body, pendingPassword: password });
}

/** It worked: the new one's the password, and the old one goes to history. */
export function commitPending(body: ItemBody): ItemBody {
  if (!body.pendingPassword) return body;
  const { pendingPassword, ...rest } = body;
  return touch(body, { ...rest, password: pendingPassword });
}

/** Into the history, not away: "no" can be a mistake, and the site may have taken it. */
export function dropPending(body: ItemBody): ItemBody {
  const { pendingPassword, ...rest } = body;
  const passwordHistory = pendingPassword && pendingPassword !== body.password ? [{ password: pendingPassword, at: new Date().toISOString() }, ...(body.passwordHistory ?? [])].slice(0, 20) : body.passwordHistory;
  return touch(body, { ...rest, passwordHistory });
}

// ---- Duplicates ----------------------------------------------------------------------

const sites = (b: ItemBody) => (b.urls ?? []).map((u) => { const h = hostOf(u.url); return h ? baseDomain(h) : null; }).filter(Boolean) as string[];

/** Same site, same username: almost always the same login saved twice. */
export function findDuplicates(items: Item[]): Item[][] {
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    if (i.body.kind !== "login" || !i.body.username) continue;
    for (const site of new Set(sites(i.body))) {
      const key = `${i.vaultId}|${site}|${i.body.username.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
  }
  const seen = new Set<string>();
  const out: Item[][] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const key = g.map((i) => i.id).sort().join();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Keeps the newest as the main one, and nothing else is thrown away: other passwords
 *  go to history, and other URLs, notes, 2FA, passkeys and fields come across. */
/** An attachment's chunks are bound to the item they were uploaded on, so one on a dropped copy
 *  can't just be listed on the kept item: `moves` says which to seal again under it first. */
export function mergeDuplicates(group: Item[]): { keep: Item; body: ItemBody; drop: Item[]; moves: { from: Item; ref: AttachmentRef }[] } {
  const order = [...group].sort((a, b) => b.body.updatedAt.localeCompare(a.body.updatedAt));
  const keep = order[0];
  const drop = order.slice(1);
  const body: ItemBody = { ...keep.body };
  const history: HistoryEntry[] = [];
  const seenUrls = new Set((body.urls ?? []).map((u) => u.url));
  const urls = [...(body.urls ?? [])];
  const notes: string[] = body.notes ? [body.notes] : [];
  const fields = [...(body.fields ?? [])];
  const passkeys = [...(body.passkeys ?? [])];
  const attachments = [...(body.attachments ?? [])];
  const moves: { from: Item; ref: AttachmentRef }[] = [];
  // Someone who asked for the master password on any copy still wants that on what's left.
  if (drop.some((d) => d.body.reprompt)) body.reprompt = true;
  for (const d of drop) {
    if (d.body.password && d.body.password !== body.password && !history.some((h) => h.password === d.body.password)) history.push({ password: d.body.password, at: d.body.updatedAt });
    if (d.body.pendingPassword && d.body.pendingPassword !== body.password && !history.some((h) => h.password === d.body.pendingPassword)) history.push({ password: d.body.pendingPassword, at: new Date().toISOString() });
    for (const u of d.body.urls ?? []) if (!seenUrls.has(u.url)) { seenUrls.add(u.url); urls.push(u); }
    if (d.body.notes && !notes.includes(d.body.notes)) notes.push(d.body.notes);
    for (const f of d.body.fields ?? []) if (!fields.some((x) => x.name === f.name && x.value === f.value)) fields.push(f);
    for (const p of d.body.passkeys ?? []) if (!passkeys.some((x) => x.credentialId === p.credentialId)) passkeys.push(p);
    for (const a of d.body.attachments ?? []) if (!attachments.some((x) => x.id === a.id) && !moves.some((m) => m.ref.id === a.id)) moves.push({ from: d, ref: a });
    if (!body.totp && d.body.totp) body.totp = d.body.totp;
  }
  // What's being merged in comes first, as the copies are about to go. Older history fills the rest.
  for (const h of [...(body.passwordHistory ?? []), ...drop.flatMap((d) => d.body.passwordHistory ?? [])]) if (!history.some((x) => x.password === h.password)) history.push(h);
  return { keep, drop, moves, body: touch(keep.body, { ...body, urls, notes: notes.join("\n\n") || undefined, fields, passkeys, attachments, passwordHistory: history.slice(0, 20) }) };
}

// ---- Clock ---------------------------------------------------------------------------

/** Codes run on the clock. Beyond half a period, they start being refused. */
export function clockDriftText(offsetMs: number): string | null {
  const s = Math.round(Math.abs(offsetMs) / 1000);
  if (s < 30) return null;
  const how = s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`;
  return `This device's clock is ${how} ${offsetMs > 0 ? "behind" : "ahead of"} your server. 2FA codes may be refused until it's set right.`;
}

// ---- Unlock with a short PIN, or a passkey ----------------------------------------------

/** A PIN or passkey output wraps the unlock secret, on this device. Never the only way
 *  in: the master password always works, and this is just a shorter way back. */
export async function wrapUnlockSecret(wrappingInput: Uint8Array, salt: Uint8Array, secret: Uint8Array, purpose: string): Promise<string> {
  const key = await aesKey(await hkdf(wrappingInput, salt, `promptly-pw/v1/${purpose}`));
  return b64u(await seal(key, secret, aad("local", "", purpose)));
}

export async function unwrapUnlockSecret(wrappingInput: Uint8Array, salt: Uint8Array, wrapped: string, purpose: string): Promise<Uint8Array> {
  const key = await aesKey(await hkdf(wrappingInput, salt, `promptly-pw/v1/${purpose}`));
  return open(key, fromB64u(wrapped), aad("local", "", purpose));
}

const PIN_TRIES = 5;

/** A short PIN, held only in this process's memory: closing the app loses it, and five
 *  wrong tries wipe it. It's weaker than the master password, and off unless set. */
export function memoryPin() {
  let rec: { salt: Uint8Array; wrapped: string; tries: number } | null = null;
  return {
    has: () => rec !== null,
    clear: () => {
      rec = null;
    },
    set: async (pin: string, secret: Uint8Array) => {
      if (!/^\d{4,12}$/.test(pin)) throw new Error("Use 4 to 12 digits.");
      const salt = randomBytes(16);
      const stretched = await argon2(utf8(pin), salt, KDF_FLOOR);
      rec = { salt, wrapped: await wrapUnlockSecret(stretched, salt, secret, "pin-unlock"), tries: 0 };
      stretched.fill(0);
    },
    open: async (pin: string): Promise<Uint8Array> => {
      if (!rec) throw new Error("There's no PIN set. Use your master password.");
      const stretched = await argon2(utf8(pin), rec.salt, KDF_FLOOR);
      try {
        const secret = await unwrapUnlockSecret(stretched, rec.salt, rec.wrapped, "pin-unlock");
        rec.tries = 0;
        return secret;
      } catch {
        rec.tries += 1;
        if (rec.tries >= PIN_TRIES) {
          rec = null;
          throw new Error("That was the last try. Use your master password.");
        }
        throw new Error(`That PIN isn't right. ${PIN_TRIES - rec.tries} tries left.`);
      } finally {
        stretched.fill(0);
      }
    },
  };
}

export type PasskeyUnlock = { credentialId: string; salt: string; prfSalt: string; wrapped: string };

const rpId = () => location.hostname;

function prfOutput(cred: PublicKeyCredential | null): Uint8Array | null {
  const out = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first;
  return out ? new Uint8Array(out) : null;
}

/** A live test, not a guess from the browser's name: makes a real passkey, then asks for
 *  its PRF. Returns null if this browser and authenticator can't do it. */
export async function createPasskeyUnlock(userId: string, secret: Uint8Array): Promise<PasskeyUnlock | null> {
  if (!window.PublicKeyCredential || !navigator.credentials) return null;
  const prfSalt = randomBytes(32);
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId(), name: "Promptly Passwords" },
      user: { id: utf8(userId) as BufferSource, name: "Vault unlock", displayName: "Vault unlock" },
      challenge: randomBytes(32) as BufferSource,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) return null;
  const ext = created.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  if (!ext.prf?.enabled) return null;
  const id = new Uint8Array(created.rawId);
  const output = prfOutput(created) ?? (await getPrf(id, prfSalt));
  if (!output) return null;
  const salt = randomBytes(16);
  return { credentialId: b64u(id), salt: b64u(salt), prfSalt: b64u(prfSalt), wrapped: await wrapUnlockSecret(output, salt, secret, "passkey-unlock") };
}

async function getPrf(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array | null> {
  const got = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: randomBytes(32) as BufferSource,
      allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
      userVerification: "required",
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  return prfOutput(got);
}

export async function openPasskeyUnlock(u: PasskeyUnlock): Promise<Uint8Array> {
  const output = await getPrf(fromB64u(u.credentialId), fromB64u(u.prfSalt));
  if (!output) throw new Error("This passkey didn't answer. Use your master password.");
  return unwrapUnlockSecret(output, fromB64u(u.salt), u.wrapped, "passkey-unlock");
}
