// Which vaults are really this person's, and who their emergency contacts are, decided on
// their own devices. The server's word on either doesn't count. See CRYPTO_SPEC.md section 6
// ("Your own vault") and SECURITY.md.
import { b64u, fromB64u } from "./bytes";
import { signingInput } from "./format";
import { ed25519Sign, ed25519Verify } from "./primitives";

/** The statement "this vault is my own": signed with the identity key, so a server or a member
 *  of some other vault can't make it, and bound to the vault's id, so it can't be moved. */
export const homeInput = (userId: string, vaultId: string): Uint8Array => signingInput("personal_vault", [userId, vaultId]);

export const signHome = (ed25519Seed: Uint8Array, userId: string, vaultId: string): string => b64u(ed25519Sign(ed25519Seed, homeInput(userId, vaultId)));

export function verifyHome(sig: unknown, userId: string, vaultId: string, ed25519Pub: Uint8Array): boolean {
  if (typeof sig !== "string" || !sig) return false;
  try {
    return ed25519Verify(fromB64u(sig), homeInput(userId, vaultId), ed25519Pub);
  } catch {
    return false;
  }
}

/** Synced next to the trust book, in the same item. It sits beside `trustBook` rather than in
 *  it, because older clients rebuild `trustBook` from the fields they know and would drop it. */
export type TrustState = {
  /** Per emergency contact: odd means named, even means removed. The higher number wins, so a
   *  removal on one device isn't undone by another device's older list. */
  contacts?: Record<string, number>;
  /** Vaults this person made themselves. Only grows. */
  made?: string[];
  /** Of those, the ones they've ever added someone to. Only grows. */
  shared?: string[];
};

export function mergeCounters(...maps: (Record<string, number> | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) {
    for (const [k, n] of Object.entries(m ?? {})) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = Math.max(out[k] ?? 0, Math.floor(n));
    }
  }
  return out;
}

/** A contact from a plain list with no counter is an old entry: named, once. */
export function withListed(state: Record<string, number>, listed: string[]): Record<string, number> {
  const out = { ...state };
  for (const id of listed) if (!(id in out)) out[id] = 1;
  return out;
}

export const isNamed = (state: Record<string, number>, id: string): boolean => (state[id] ?? 0) % 2 === 1;

export const named = (state: Record<string, number>): string[] => Object.keys(state).filter((id) => isNamed(state, id));

export function nameContact(state: Record<string, number>, id: string): void {
  const n = state[id] ?? 0;
  if (n % 2 === 0) state[id] = n + 1;
}

export function removeContact(state: Record<string, number>, id: string): void {
  const n = state[id] ?? 1;
  state[id] = n % 2 === 1 ? n + 1 : n;
}
