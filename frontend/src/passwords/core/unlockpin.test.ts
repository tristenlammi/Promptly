import { describe, expect, it } from "vitest";

import { fromB64u, randomBytes } from "./bytes";
import { wrapUnlockSecret } from "./connections";
import { hkdf } from "./primitives";
import { PIN_KEEP_AFTER_LOCK_MS, PIN_TRIES, PinError, type PinRecord, UnlockPin } from "./unlockpin";

// Argon2 is the real thing elsewhere; here a fast stand-in keeps the tests quick.
const fastStretch = async (pin: string, salt: Uint8Array) => hkdf(new TextEncoder().encode(pin), salt, "test-stretch");

function setup() {
  let rec: PinRecord | undefined;
  let t = 1_000_000;
  const store = { get: async () => (rec ? { ...rec } : undefined), set: async (r: PinRecord) => void (rec = { ...r }), remove: async () => void (rec = undefined) };
  const pin = new UnlockPin(store, fastStretch, () => t);
  return { pin, peek: () => rec, put: (r: PinRecord) => void (rec = r), advance: (ms: number) => void (t += ms) };
}

describe("the extension's unlock PIN", () => {
  it("opens with the right PIN and counts wrong ones", async () => {
    const { pin, peek } = setup();
    const secret = randomBytes(64);
    await pin.set("246813", secret);
    await expect(pin.open("000000")).rejects.toThrow(/4 tries left/);
    expect(peek()?.tries).toBe(1);
    expect(Array.from(await pin.open("246813"))).toEqual(Array.from(secret));
    expect(peek()?.tries).toBe(0);
  });

  it("new PINs need 6 or more digits", async () => {
    const { pin } = setup();
    await expect(pin.set("1234", randomBytes(64))).rejects.toThrow(/6 to 12/);
    await expect(pin.set("12345a", randomBytes(64))).rejects.toThrow(/6 to 12/);
    await pin.set("123456", randomBytes(64));
  });

  it("can't skip the limit with attempts sent side by side", async () => {
    const { pin, peek } = setup();
    await pin.set("246813", randomBytes(64));
    const guesses = Array.from({ length: 20 }, (_, i) => String(100000 + i));
    const results = await Promise.allSettled(guesses.map((g) => pin.open(g)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // Five were checked, and the PIN's gone: the real one doesn't open it now.
    expect(peek()).toBeUndefined();
    await expect(pin.open("246813")).rejects.toThrow(/no PIN/);
    const lefts = results.map((r) => ((r as PromiseRejectedResult).reason as PinError).triesLeft);
    expect(lefts.slice(0, PIN_TRIES)).toEqual([4, 3, 2, 1, 0]);
  });

  it("a passkey check shares the same tries", async () => {
    const { pin, peek } = setup();
    await pin.set("246813", randomBytes(64));
    const checks = await Promise.all(Array.from({ length: 10 }, (_, i) => pin.check(String(900000 + i))));
    expect(checks.every((x) => !x)).toBe(true);
    expect(peek()).toBeUndefined();
  });

  it("an older short PIN still opens, and says it should be changed", async () => {
    const { pin, put } = setup();
    // As an older version made it: a 4-digit PIN.
    const helper = setup();
    const secret = randomBytes(64);
    await helper.pin.set("123456", secret);
    const made = helper.peek()!;
    // Wrapped under "1234" by hand, as the old code allowed.
    const salt = fromB64u(made.salt);
    put({ salt: made.salt, wrapped: await wrapUnlockSecret(await fastStretch("1234", salt), salt, secret, "pin-unlock"), tries: 0 });
    expect((await pin.status()).short).toBe(false);
    expect(Array.from(await pin.open("1234"))).toEqual(Array.from(secret));
    expect(await pin.status()).toEqual({ has: true, short: true });
  });

  it("stops working a while after the vault locks", async () => {
    const { pin, peek, advance } = setup();
    await pin.set("246813", randomBytes(64));
    await pin.locked();
    advance(PIN_KEEP_AFTER_LOCK_MS - 1000);
    expect((await pin.status()).has).toBe(true);
    advance(2000);
    await pin.expireIfStale();
    expect(peek()).toBeUndefined();
  });

  it("a use after the time's up is refused, even before it's tidied away", async () => {
    const { pin, advance } = setup();
    await pin.set("246813", randomBytes(64));
    await pin.locked();
    advance(PIN_KEEP_AFTER_LOCK_MS + 1);
    await expect(pin.open("246813")).rejects.toThrow(/stopped working/);
  });
});
