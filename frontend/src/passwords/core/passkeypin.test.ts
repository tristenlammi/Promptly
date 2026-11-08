import { describe, expect, it } from "vitest";

import { b64u } from "./bytes";
import { type Item, newBody } from "./model";
import { checkPasskeyPin, clearPinTries, lockedOutByPin, makePinVerifier, PIN_TRIES, PIN_TRIES_META, pinMatches, pinProblem, pinTries, pinVerifierOf, readPinVerifier } from "./passkeypin";
import { MemoryStore } from "./store";

const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);
/** The same vector is in the Android test (PasskeyPinTest.kt), so both clients agree. */
const VECTOR = { pin: "4821", salt: b64u(SALT), check: "Cgg9Re5GWzCmi3T5Cv_TDZ93PDwlrkzb_RPe4_w-A9M" };

describe("passkey PIN rules", () => {
  it("takes 4 to 12 digits", () => {
    expect(pinProblem("4821")).toBeNull();
    expect(pinProblem("482913")).toBeNull();
    expect(pinProblem("482913570264")).toBeNull();
    expect(pinProblem("482")).toMatch("4 to 12");
    expect(pinProblem("4829135702641")).toMatch("4 to 12");
    expect(pinProblem("48a1")).toMatch("4 to 12");
    expect(pinProblem(" 4821")).toMatch("4 to 12");
    expect(pinProblem("")).toMatch("4 to 12");
  });

  it("refuses the obvious ones", () => {
    for (const p of ["0000", "1111", "999999", "1234", "123456", "1234567890", "4321", "9876", "8901", "0987", "1212", "4545", "123123", "2580", "1122", "6969"]) {
      expect(pinProblem(p), p).toMatch("too easy");
    }
    for (const p of ["1235", "2468013", "7391", "1221", "0901"]) expect(pinProblem(p), p).toBeNull();
  });
});

describe("passkey PIN verifier", () => {
  it("matches only the PIN it was made from, and keeps nothing readable", async () => {
    const v = await makePinVerifier("4821");
    expect(JSON.stringify(v)).not.toContain("4821");
    expect(v.kdf).toEqual({ alg: "argon2id", m: 65536, t: 3, p: 1 });
    expect(await pinMatches(v, "4821")).toBe(true);
    expect(await pinMatches(v, "4822")).toBe(false);
    expect(await pinMatches(v, "04821")).toBe(false);
    expect(await pinMatches(v, "")).toBe(false);
    const again = await makePinVerifier("4821");
    expect(again.salt).not.toBe(v.salt);
    expect(again.check).not.toBe(v.check);
  });

  it("won't make one for a weak PIN", async () => {
    await expect(makePinVerifier("1234")).rejects.toThrow("too easy");
  });

  it("gives the fixed vector, shared with Android", async () => {
    const v = await makePinVerifier(VECTOR.pin, { salt: SALT, now: new Date("2026-11-08T00:00:00.000Z") });
    expect(v.salt).toBe(VECTOR.salt);
    expect(v.check).toBe(VECTOR.check);
  });

  it("reads only well-formed records, inside the KDF limits", async () => {
    const v = await makePinVerifier("4821");
    expect(readPinVerifier(v)).toEqual(v);
    expect(readPinVerifier(null)).toBeNull();
    expect(readPinVerifier({ ...v, v: 2 })).toBeNull();
    expect(readPinVerifier({ ...v, kdf: { alg: "argon2id", m: 1024, t: 1, p: 1 } })).toBeNull();
    expect(readPinVerifier({ ...v, kdf: { alg: "argon2id", m: 1 << 30, t: 3, p: 1 } })).toBeNull();
    expect(readPinVerifier({ ...v, check: "AAAA" })).toBeNull();
  });

  it("is taken from the personal vault only, newest first, and never from the trash", async () => {
    const older = await makePinVerifier("4821", { now: new Date("2026-01-01T00:00:00Z") });
    const newer = await makePinVerifier("7391", { now: new Date("2026-02-01T00:00:00Z") });
    const planted = await makePinVerifier("5550", { now: new Date("2026-03-01T00:00:00Z") });
    const row = (vaultId: string, passkeyPin: unknown, deleted = false): Item => {
      const body = newBody("prefs", "passkey-pin", { passkeyPin });
      return { id: crypto.randomUUID(), vaultId, revision: 1, deleted, updatedAt: body.updatedAt, body };
    };
    const items = [row("mine", older), row("mine", newer), row("shared", planted), row("mine", planted, true)];
    expect(pinVerifierOf(items, "mine")?.check).toBe(newer.check);
    expect(pinVerifierOf(items, "nobody")).toBeNull();
  });
});

describe("passkey PIN tries", () => {
  it("counts wrong tries, resets on a right one, and locks out at five", async () => {
    const store = new MemoryStore();
    const v = await makePinVerifier("4821");
    expect(await checkPasskeyPin(store, v, "0001")).toEqual({ ok: false, left: 4 });
    expect(await checkPasskeyPin(store, v, "0002")).toEqual({ ok: false, left: 3 });
    expect(await pinTries(store)).toBe(2);
    expect(await checkPasskeyPin(store, v, "4821")).toEqual({ ok: true });
    expect(await pinTries(store)).toBe(0);
    for (const left of [4, 3, 2, 1]) expect(await checkPasskeyPin(store, v, "0000")).toEqual({ ok: false, left });
    expect(await lockedOutByPin(store)).toBe(false);
    expect(await checkPasskeyPin(store, v, "0000")).toEqual({ ok: false, left: 0 });
    expect(await lockedOutByPin(store)).toBe(true);
    // Locked out, even the right PIN does nothing until the master password clears it.
    expect(await checkPasskeyPin(store, v, "4821")).toEqual({ ok: false, left: 0 });
    await clearPinTries(store);
    expect(await checkPasskeyPin(store, v, "4821")).toEqual({ ok: true });
  });

  it("can't be talked past the limit by guesses sent at once", async () => {
    const store = new MemoryStore();
    const v = await makePinVerifier("4821");
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => checkPasskeyPin(store, v, String(1000 + i))));
    expect(all.filter((r) => !r.ok && r.left === 0).length).toBe(4);
    expect(await pinTries(store)).toBe(PIN_TRIES);
  });

  it("treats a junk count as none, and a huge one as locked out", async () => {
    const store = new MemoryStore();
    await store.setMeta(PIN_TRIES_META, "lots");
    expect(await pinTries(store)).toBe(0);
    await store.setMeta(PIN_TRIES_META, 99);
    expect(await lockedOutByPin(store)).toBe(true);
  });
});
