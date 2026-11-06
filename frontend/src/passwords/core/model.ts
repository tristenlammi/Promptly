// What's inside an item's encrypted body. The server never sees any of this.
// Readers keep fields they don't know, so an older client can't destroy a newer
// client's data (CRYPTO_SPEC.md section 4).

export type UrlMatch = "base" | "host" | "exact" | "prefix" | "regex" | "never";
export type LoginUrl = { url: string; match?: UrlMatch };
export type CustomField = { name: string; value: string; type: "text" | "hidden" | "boolean" };
export type HistoryEntry = { password: string; at: string };
export type AttachmentRef = { id: string; name: string; size: number; key: string; chunks: number; mime?: string };

export type TotpConfig = {
  secret: string; // base32
  algorithm?: "SHA1" | "SHA256" | "SHA512";
  digits?: number;
  period?: number;
  steam?: boolean;
  issuer?: string;
  label?: string;
};

/** A passkey's private key is portable, so any client can use it, iOS later included. */
export type Passkey = {
  credentialId: string; // base64url
  rpId: string;
  rpName?: string;
  userHandle: string; // base64url
  userName: string;
  userDisplayName?: string;
  key: string; // base64url PKCS#8 for ES256
  alg: -7;
  signCount: number;
  createdAt: string;
  lastUsedAt?: string;
  discoverable: boolean;
};

export type ItemKind =
  | "login"
  | "note"
  | "card"
  | "identity"
  | "totp"
  | "passkey"
  | "apikey"
  | "wifi"
  | "ssh"
  | "bank"
  | "document"
  // Kept in the vault but not shown as items.
  | "folder"
  | "site_rule"
  | "trust"
  | "prefs"
  | "send"
  | "bookmark";

export const SYSTEM_KINDS: readonly ItemKind[] = ["folder", "site_rule", "trust", "prefs", "send", "bookmark"];

export type ItemBody = {
  v: 1;
  kind: ItemKind;
  title: string;
  favorite?: boolean;
  archived?: boolean;
  folderId?: string | null;
  tags?: string[];
  notes?: string;
  /** Goes up with every edit, inside the encryption. A server serving an older copy shows up
   *  as a lower number, even if it lies about the revision. */
  seq?: number;
  /** System item: who this person trusts, in the personal vault so it syncs and can't be
   *  changed or wiped by a server. */
  trustBook?: TrustBook;
  /** A new password waiting on the site saying yes, so a failed change can't lose it. */
  pendingPassword?: string;
  /** System item: one browser bookmark or folder (a folder has no url). See BOOKMARKS.md. */
  bookmark?: { parent: string; pos: number; url?: string };
  /** A record of a Secure Send made from here; its link is in notes. */
  sendId?: string;
  fields?: CustomField[];
  reprompt?: boolean;
  /** Use a favicon proxied through this server for this item. Off unless chosen. */
  icon?: boolean;
  createdAt: string;
  updatedAt: string;
  attachments?: AttachmentRef[];
  /** Keep-both result of a merge that couldn't be done field by field. */
  conflicts?: { at: string; body: Record<string, unknown> }[];

  // login
  urls?: LoginUrl[];
  username?: string;
  password?: string;
  passwordHistory?: HistoryEntry[];
  totp?: TotpConfig | null;
  passkeys?: Passkey[];
  autofillOnLoad?: boolean;
  passwordChangedAt?: string;

  // card
  cardholder?: string;
  cardNumber?: string;
  cardBrand?: string;
  cardExpMonth?: string;
  cardExpYear?: string;
  cardCvv?: string;

  // identity
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;

  // apikey
  apiKey?: string;
  apiSecret?: string;
  // wifi
  ssid?: string;
  wifiPassword?: string;
  wifiSecurity?: "WPA" | "WEP" | "nopass";
  // ssh
  sshPublic?: string;
  sshPrivate?: string;
  sshFingerprint?: string;
  // bank
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  routingNumber?: string;
  iban?: string;
  swift?: string;
  // document
  documentType?: string;
  documentNumber?: string;
  expiresOn?: string;
  remindExpiry?: boolean;

  // folder
  parentId?: string | null;
  // site_rule
  rule?: SiteRule;
  // trust
  trust?: Record<string, TrustEntry>;
  // prefs
  prefs?: Record<string, unknown>;

  [key: string]: unknown;
};

export type SiteRule = {
  host: string;
  username?: string;
  password?: string;
  submit?: string;
  otp?: string;
  never?: boolean;
};

export type TrustEntry = { x25519: string; ed25519: string; firstSeen: string; verified?: boolean; username?: string };

/** Decisions only this person's clients can make. Nothing here comes from the server. */
export type TrustBook = {
  people: Record<string, TrustEntry>;
  /** Vaults someone else gave a key to, which this person chose to open. */
  accepted: string[];
  /** Who they chose as an emergency contact. Keys are sealed to nobody else. */
  contacts: string[];
  /** The highest key generation seen per vault, so an old key can't be brought back. */
  generations: Record<string, number>;
  personalVaultId?: string;
};

export type Item = { id: string; vaultId: string; revision: number; deleted: boolean; updatedAt: string; body: ItemBody };

export function isSystem(body: ItemBody): boolean {
  return SYSTEM_KINDS.includes(body.kind);
}

export function newBody(kind: ItemKind, title: string, extra: Partial<ItemBody> = {}): ItemBody {
  const at = new Date().toISOString();
  return { v: 1, kind, title, createdAt: at, updatedAt: at, ...extra };
}

/** On save: note an old password in the history, and when it changed. */
export function touch(prev: ItemBody | null, next: ItemBody): ItemBody {
  const at = new Date().toISOString();
  const out: ItemBody = { ...next, updatedAt: at, seq: Math.max(prev?.seq ?? 0, next.seq ?? 0) + 1 };
  if (prev && prev.password && prev.password !== next.password) {
    out.passwordHistory = [{ password: prev.password, at }, ...(prev.passwordHistory ?? [])].slice(0, 20);
    out.passwordChangedAt = at;
  } else if (!prev && next.password) {
    out.passwordChangedAt = at;
  }
  return out;
}

const SEARCHED: (keyof ItemBody)[] = ["title", "username", "notes", "email", "cardholder", "ssid", "bankName", "documentType", "firstName", "lastName", "company"];

/** What search looks through, lowercased. Never secrets: not passwords, card
 *  numbers or keys, so a search can't be used to test a guess. */
export function searchText(body: ItemBody): string {
  const parts: string[] = [];
  for (const k of SEARCHED) {
    const v = body[k];
    if (typeof v === "string") parts.push(v);
  }
  for (const u of body.urls ?? []) parts.push(u.url);
  for (const t of body.tags ?? []) parts.push(t);
  for (const f of body.fields ?? []) {
    parts.push(f.name);
    if (f.type !== "hidden") parts.push(f.value);
  }
  return parts.join("\n").toLowerCase();
}

/** Three-way merge, field by field: whatever only one side changed is kept. A
 *  field both sides changed differently can't be decided here, so the server's
 *  version stands and the local one is kept whole as a conflict to pick from.
 *  Nothing is ever dropped. */
export function mergeBodies(base: ItemBody | null, local: ItemBody, server: ItemBody): { body: ItemBody; conflicted: boolean } {
  const out: Record<string, unknown> = { ...server };
  let conflicted = base === null && !sameValue(strip(local), strip(server));
  if (base) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(server)]);
    for (const key of keys) {
      if (key === "updatedAt" || key === "conflicts" || key === "seq") continue;
      const b = base[key];
      const l = local[key];
      const s = server[key];
      if (sameValue(l, s) || sameValue(l, b)) continue; // server's stands
      if (sameValue(s, b)) {
        if (l === undefined) delete out[key];
        else out[key] = l;
        continue;
      }
      conflicted = true;
    }
  }
  const conflicts = [...(server.conflicts ?? []), ...(local.conflicts ?? [])];
  if (conflicted) conflicts.push({ at: new Date().toISOString(), body: strip(local) });
  const body = out as ItemBody;
  body.updatedAt = new Date().toISOString();
  if (conflicts.length) body.conflicts = dedupeConflicts(conflicts);
  else delete body.conflicts;
  if (typeof server.password === "string" && typeof body.password === "string" && server.password !== body.password) {
    body.passwordHistory = [{ password: server.password, at: body.updatedAt }, ...(body.passwordHistory ?? [])].slice(0, 20);
  }
  return { body, conflicted };
}

function strip(b: ItemBody): Record<string, unknown> {
  const { updatedAt: _u, conflicts: _c, seq: _s, ...rest } = b;
  return rest;
}

function dedupeConflicts(list: { at: string; body: Record<string, unknown> }[]) {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = stable(c.body);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
