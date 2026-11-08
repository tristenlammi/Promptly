// The passkey PIN: asked before every passkey sign-in and every new passkey, on every client
// (DECISIONS D-PIN-1). One per account, synced: only a verifier is kept, inside a system item
// in the personal vault, so the server sees an encrypted item like any other. It's a check that
// the person is there and means it while the vault is unlocked. It isn't encryption: nothing is
// sealed under it. Wrong tries are counted on each device, where no web page can reach the count.
import { b64u, fromB64u, randomBytes, utf8 } from "./bytes";
import type { Item } from "./model";
import { argon2, checkKdf, hkdf, KDF_FLOOR, type KdfParams } from "./primitives";
import type { VaultClient } from "./vault";

export const PIN_MIN = 4;
export const PIN_MAX = 12;
/** Wrong PINs in a row before the vault locks and needs the master password. */
export const PIN_TRIES = 5;
/** The system item's title. Its kind is "prefs", so every client already hides it. */
export const PIN_TITLE = "passkey-pin";
/** Where each device counts wrong tries. Never synced. */
export const PIN_TRIES_META = "passkey_pin_tries";
const INFO = "promptly-pw/v1/passkey-pin";

export type PinVerifier = { v: 1; kdf: KdfParams; salt: string; check: string; setAt: string };

/** Ones people pick first. Runs, repeats and patterns are caught by the rules below. */
const COMMON = new Set(["2580", "0852", "8520", "0258", "1004", "2000", "6969", "1122", "2468", "1357", "5683", "1998", "1999", "2001", "1984"]);

/** Why a PIN can't be used, or null if it can. */
export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)) return `Use ${PIN_MIN} to ${PIN_MAX} digits.`;
  if (COMMON.has(pin) || isRun(pin) || isRepeat(pin)) return "That PIN is too easy to guess. Try another.";
  return null;
}

/** 1234, 6789, 8901, 4321, 0987: each digit one up, or one down, from the last. */
function isRun(pin: string): boolean {
  const d = [...pin].map(Number);
  const steps = new Set(d.slice(1).map((x, i) => (x - d[i] + 10) % 10));
  return steps.size === 1 && (steps.has(1) || steps.has(9));
}

/** 0000, 1212, 123123, 4545: a shorter group said again and again. */
function isRepeat(pin: string): boolean {
  for (let n = 1; n <= pin.length / 2; n++) {
    if (pin.length % n === 0 && pin.slice(0, n).repeat(pin.length / n) === pin) return true;
  }
  return false;
}

async function checkValue(pin: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  const stretched = await argon2(utf8(pin), salt, kdf);
  try {
    return await hkdf(stretched, salt, INFO);
  } finally {
    stretched.fill(0);
  }
}

export async function makePinVerifier(pin: string, opts: { kdf?: KdfParams; salt?: Uint8Array; now?: Date } = {}): Promise<PinVerifier> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const kdf = opts.kdf ?? KDF_FLOOR;
  checkKdf(kdf);
  const salt = opts.salt ?? randomBytes(16);
  return { v: 1, kdf: { ...kdf }, salt: b64u(salt), check: b64u(await checkValue(pin, salt, kdf)), setAt: (opts.now ?? new Date()).toISOString() };
}

/** Only what this code wrote. Anything else counts as no PIN, never as a match. */
export function readPinVerifier(raw: unknown): PinVerifier | null {
  const o = raw as Partial<PinVerifier> | null;
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.salt !== "string" || typeof o.check !== "string" || typeof o.setAt !== "string") return null;
  const k = o.kdf as KdfParams | undefined;
  if (!k || typeof k !== "object") return null;
  try {
    checkKdf(k);
    if (fromB64u(o.salt).length < 16 || fromB64u(o.check).length !== 32) return null;
  } catch {
    return null;
  }
  return { v: 1, kdf: { alg: "argon2id", m: k.m, t: k.t, p: k.p }, salt: o.salt, check: o.check, setAt: o.setAt };
}

export async function pinMatches(v: PinVerifier, typed: string): Promise<boolean> {
  if (!/^\d{1,64}$/.test(typed)) return false;
  const got = await checkValue(typed, fromB64u(v.salt), v.kdf);
  const want = fromB64u(v.check);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/** The personal vault's only: a member of a shared vault could plant one anywhere else. Two
 *  devices can each set one while offline, and then the newest counts. */
export function pinItemsOf(items: Item[], personalVaultId: string): Item[] {
  return items
    .filter((i) => i.vaultId === personalVaultId && !i.deleted && i.body.kind === "prefs" && i.body.title === PIN_TITLE && readPinVerifier(i.body.passkeyPin))
    .sort((a, b) => String((b.body.passkeyPin as PinVerifier).setAt).localeCompare(String((a.body.passkeyPin as PinVerifier).setAt)));
}

export function pinVerifierOf(items: Item[], personalVaultId: string): PinVerifier | null {
  const top = pinItemsOf(items, personalVaultId)[0];
  return top ? readPinVerifier(top.body.passkeyPin) : null;
}

export async function passkeyPinOf(client: VaultClient): Promise<PinVerifier | null> {
  if (!client.unlocked) return null;
  const personal = await client.personalVaultId().catch(() => null);
  return personal ? pinVerifierOf(client.allItems({ includeSystem: true }), personal) : null;
}

/** Saves a new verifier over the old one, and syncs if it can. Checking who's asking is the caller's job. */
export async function savePasskeyPin(client: VaultClient, v: PinVerifier): Promise<void> {
  const personal = await client.personalVaultId();
  const [first, ...rest] = pinItemsOf(client.allItems({ includeSystem: true }), personal);
  if (first) await client.update(first.id, { ...first.body, passkeyPin: v });
  else await client.saveNew(personal, { v: 1, kind: "prefs", title: PIN_TITLE, createdAt: v.setAt, updatedAt: v.setAt, passkeyPin: v });
  // Copies from two offline devices: one is enough.
  for (const old of rest) await client.update(old.id, { ...old.body, passkeyPin: v });
  await client.sync().catch(() => undefined);
}

// ---- Counting wrong tries -------------------------------------------------------------

export type MetaStore = {
  getMeta<T>(key: string): Promise<T | undefined | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
};

export async function pinTries(store: MetaStore): Promise<number> {
  const n = await store.getMeta<number>(PIN_TRIES_META);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(n, PIN_TRIES) : 0;
}

/** Five wrong in a row: until the master password is typed, nothing shorter unlocks here. */
export async function lockedOutByPin(store: MetaStore): Promise<boolean> {
  return (await pinTries(store)) >= PIN_TRIES;
}

export async function clearPinTries(store: MetaStore): Promise<void> {
  await store.deleteMeta(PIN_TRIES_META);
}

export type PinCheck = { ok: true } | { ok: false; left: number };

let queue: Promise<unknown> = Promise.resolve();

/** Counts the try before checking it, so stopping the check halfway can't save a guess, and
 *  takes one at a time. A right PIN puts the count back to nought. `left: 0` means locked out:
 *  the caller locks the vault. */
export function checkPasskeyPin(store: MetaStore, v: PinVerifier, typed: string): Promise<PinCheck> {
  const run = queue.then(async (): Promise<PinCheck> => {
    const before = await pinTries(store);
    if (before >= PIN_TRIES) return { ok: false, left: 0 };
    await store.setMeta(PIN_TRIES_META, before + 1);
    if (await pinMatches(v, typed)) {
      await clearPinTries(store);
      return { ok: true };
    }
    return { ok: false, left: PIN_TRIES - (before + 1) };
  });
  queue = run.catch(() => undefined);
  return run;
}

export const PIN_LOCKED_TEXT = "Five wrong passkey PINs in a row, so your vault is locked. Unlock it with your master password.";
