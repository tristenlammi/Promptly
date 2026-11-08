// The extension's unlock PIN: the unlock secret wrapped under a key stretched from a short PIN,
// kept in the browser's session storage. See SECURITY.md ("Extension") for what its limits
// stop and what they don't. No browser APIs here, so it can be tested on its own.
import { b64u, fromB64u, randomBytes, utf8 } from "./bytes";
import { unwrapUnlockSecret, wrapUnlockSecret } from "./connections";
import { argon2, KDF_FLOOR } from "./primitives";

export const PIN_TRIES = 5;
/** For a new PIN. Older 4- and 5-digit ones still open until they're changed, and say so. */
export const PIN_MIN_DIGITS = 6;
/** After the vault locks, the PIN stops working this long later, and is removed. */
export const PIN_KEEP_AFTER_LOCK_MS = 8 * 60 * 60 * 1000;

export type PinRecord = {
  salt: string;
  wrapped: string;
  tries: number;
  /** Seen to be shorter than PIN_MIN_DIGITS when it was last used. */
  short?: boolean;
  /** When the vault last locked with this PIN set. */
  lockedAt?: number;
};

export type PinStore = {
  get(): Promise<PinRecord | undefined>;
  set(r: PinRecord): Promise<void>;
  remove(): Promise<void>;
};

export class PinError extends Error {
  constructor(
    message: string,
    public triesLeft: number,
  ) {
    super(message);
  }
}

const PURPOSE = "pin-unlock";
const ANY_PIN = /^\d{4,12}$/;

export class UnlockPin {
  /** One attempt at a time. Without this, attempts sent side by side each read the same count
   *  before any of them wrote it, and the limit never came. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private store: PinStore,
    private stretch: (pin: string, salt: Uint8Array) => Promise<Uint8Array> = (pin, salt) => argon2(utf8(pin), salt, KDF_FLOOR),
    private now: () => number = () => Date.now(),
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private expired(r: PinRecord): boolean {
    return typeof r.lockedAt === "number" && this.now() - r.lockedAt > PIN_KEEP_AFTER_LOCK_MS;
  }

  set(pin: string, unlockSecret: Uint8Array): Promise<void> {
    return this.serial(async () => {
      if (!/^\d+$/.test(pin) || pin.length < PIN_MIN_DIGITS || pin.length > 12) throw new Error(`Use ${PIN_MIN_DIGITS} to 12 digits.`);
      const salt = randomBytes(16);
      const stretched = await this.stretch(pin, salt);
      try {
        const wrapped = await wrapUnlockSecret(stretched, salt, unlockSecret, PURPOSE);
        await this.store.set({ salt: b64u(salt), wrapped, tries: 0 });
      } finally {
        stretched.fill(0);
      }
    });
  }

  clear(): Promise<void> {
    return this.serial(() => this.store.remove());
  }

  async status(): Promise<{ has: boolean; short: boolean }> {
    const r = await this.store.get();
    if (r && this.expired(r)) {
      await this.clear();
      return { has: false, short: false };
    }
    return { has: !!r, short: !!r?.short };
  }

  /** The vault's just locked: the PIN works for a while yet, then goes. */
  locked(): Promise<void> {
    return this.serial(async () => {
      const r = await this.store.get();
      if (r && r.lockedAt === undefined) await this.store.set({ ...r, lockedAt: this.now() });
    });
  }

  expireIfStale(): Promise<void> {
    return this.serial(async () => {
      const r = await this.store.get();
      if (r && this.expired(r)) await this.store.remove();
    });
  }

  /** The unlock secret, or a PinError saying how many tries are left. */
  open(typed: string): Promise<Uint8Array> {
    return this.serial(async () => {
      const r = await this.store.get();
      if (!r) throw new PinError("There's no PIN on this browser. Use your master password.", 0);
      if (this.expired(r)) {
        await this.store.remove();
        throw new PinError("The PIN stopped working a while after the vault locked. Use your master password.", 0);
      }
      const secret = await this.attempt(r, typed);
      if (secret) return secret;
      const tries = r.tries + 1;
      if (tries >= PIN_TRIES) throw new PinError("That was the last try. Use your master password.", 0);
      throw new PinError(`That PIN isn't right. ${PIN_TRIES - tries} tries left.`, PIN_TRIES - tries);
    });
  }

  /** For a prompt that has to know it's the person. Same tries, same limit. */
  check(typed: string): Promise<boolean> {
    return this.serial(async () => {
      const r = await this.store.get();
      if (!r || !ANY_PIN.test(typed) || this.expired(r)) return false;
      const secret = await this.attempt(r, typed);
      secret?.fill(0);
      return !!secret;
    });
  }

  /** The try's counted before the check, so stopping the worker part way through still uses it. */
  private async attempt(r: PinRecord, typed: string): Promise<Uint8Array | null> {
    const tries = r.tries + 1;
    if (tries >= PIN_TRIES) await this.store.remove();
    else await this.store.set({ ...r, tries });
    if (!ANY_PIN.test(typed)) return null;
    const salt = fromB64u(r.salt);
    const stretched = await this.stretch(typed, salt);
    try {
      const secret = await unwrapUnlockSecret(stretched, salt, r.wrapped, PURPOSE);
      // Right: put it back, with the count cleared.
      await this.store.set({ salt: r.salt, wrapped: r.wrapped, tries: 0, short: typed.length < PIN_MIN_DIGITS || undefined });
      return secret;
    } catch {
      return null;
    } finally {
      stretched.fill(0);
    }
  }
}
