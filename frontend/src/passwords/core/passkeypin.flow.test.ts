// The extension's passkey window and background (passwords/extension/src/passkeys.ts), driven the
// way the window drives them, with a stand-in vault and browser. What's checked: a PIN is chosen
// the first time, asked every time after, five wrong lock the vault, and the site hears "verified"
// only after a right one.
import { beforeAll, describe, expect, it } from "vitest";

import { fromB64u } from "./bytes";
import { isSystem, type Item, type ItemBody } from "./model";
import { clearPinTries, PIN_TITLE, pinTries } from "./passkeypin";
import { MemoryStore } from "./store";

/** The extension's own file. Loaded by a path tsc doesn't follow, since the frontend's build has no
 *  `chrome` types. */
const PASSKEYS = "../../../../passwords/extension/src/passkeys";
type Sender = { tab?: { id: number }; frameId?: number; url?: string; origin?: string };
type Guard = { store: MemoryStore; lockOut: () => Promise<void> };
type Handle = (msg: never, sender: Sender, client: () => never, isThePerson: () => Promise<boolean>, offersChanged?: () => void, guard?: Guard) => Promise<unknown>;
let handlePasskey: Handle;
const opened: string[] = [];

beforeAll(async () => {
  const listeners = { addListener: () => undefined };
  const session = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
    windows: {
      create: async (o: { url: string }) => {
        opened.push(o.url);
        return { id: opened.length };
      },
      remove: async () => undefined,
      onRemoved: listeners,
    },
    tabs: { onRemoved: listeners, get: async () => null },
    webNavigation: { onCommitted: listeners },
    storage: {
      session: {
        get: async (k: string) => ({ [k]: session.get(k) }),
        set: async (o: Record<string, unknown>) => Object.entries(o).forEach(([k, v]) => session.set(k, v)),
      },
    },
  };
  ({ handlePasskey } = (await import(/* @vite-ignore */ PASSKEYS)) as { handlePasskey: Handle });
});

/** Just enough of VaultClient for the passkey code. */
class FakeVault {
  unlocked = true;
  items = new Map<string, Item>();
  allItems(o: { includeSystem?: boolean } = {}) {
    return [...this.items.values()].filter((i) => !i.deleted && (o.includeSystem || !isSystem(i.body)));
  }
  get(id: string) {
    return this.items.get(id);
  }
  async personalVaultId() {
    return "personal";
  }
  async saveNew(vaultId: string, body: ItemBody) {
    const it: Item = { id: crypto.randomUUID(), vaultId, revision: 0, deleted: false, updatedAt: body.updatedAt, body };
    this.items.set(it.id, it);
    return it;
  }
  async update(id: string, body: ItemBody) {
    const it = { ...this.items.get(id)!, body };
    this.items.set(id, it);
    return it;
  }
  async sync() {
    return {};
  }
}

const SITE: Sender = { tab: { id: 7 }, frameId: 0, url: "https://example.com/login", origin: "https://example.com" };
const notThePerson = async () => false;

function rig() {
  const vault = new FakeVault();
  const store = new MemoryStore();
  let lockedOut = 0;
  const guard = {
    store,
    lockOut: async () => {
      lockedOut++;
      vault.unlocked = false;
    },
  };
  const send = (msg: Record<string, unknown>, sender: Sender) => handlePasskey(msg as never, sender, () => vault as never, notThePerson, () => undefined, guard) as Promise<Record<string, unknown>>;
  /** A page's request, and the window that opens for it. */
  const ask = async (op: "get" | "create", options: Record<string, unknown>) => {
    const before = opened.length;
    const result = send({ t: "pkRequest", op, options }, SITE);
    await expect.poll(() => opened.length).toBe(before + 1);
    const win: Sender = { url: opened[opened.length - 1] };
    const id = new URL(win.url!).searchParams.get("id");
    const window = (m: Record<string, unknown>) => send({ ...m, id }, win);
    return { result, window };
  };
  return { vault, store, guard, ask, send, lockedOuts: () => lockedOut };
}

const create = { rp: { id: "example.com" }, user: { id: "dQ", name: "ana@example.com" }, challenge: "Y2hhbGxlbmdl", algs: [-7], exclude: [], residentKey: "required", userVerification: "preferred" };
const get = { rpId: "example.com", challenge: "c2lnbg", allow: [], userVerification: "preferred" };
const uvFlag = (authData: string) => (fromB64u(authData)[32] & 0x04) !== 0;

describe("passkey PIN, in the extension's passkey window", () => {
  it("asks for one to be chosen the first time, refuses a weak or mismatched one, then makes the passkey with UV", async () => {
    const r = rig();
    const { result, window } = await r.ask("create", create);
    expect(await window({ t: "pkPrompt" })).toMatchObject({ op: "create", unlocked: true, pin: "choose", triesLeft: 5 });
    expect(await window({ t: "pkAnswer", action: "create" })).toEqual({ error: "choose" });
    expect(await window({ t: "pkAnswer", action: "create", newPin: "1234", newPinAgain: "1234" })).toMatchObject({ error: "badPin", message: expect.stringContaining("too easy") });
    expect(await window({ t: "pkAnswer", action: "create", newPin: "482913", newPinAgain: "482914" })).toMatchObject({ error: "badPin", message: "Those two don't match." });
    expect(r.vault.items.size).toBe(0);
    expect(await window({ t: "pkAnswer", action: "create", pin: "482913", newPin: "482913", newPinAgain: "482913" })).toEqual({ done: true });
    const made = await result;
    expect(made.ok).toBe(true);
    expect(uvFlag((made.result as { authenticatorData: string }).authenticatorData)).toBe(true);
    // Kept as a verifier only, in the personal vault, hidden like other system items.
    const pinRow = r.vault.allItems({ includeSystem: true }).find((i) => i.body.title === PIN_TITLE)!;
    expect(pinRow.vaultId).toBe("personal");
    expect(pinRow.body.kind).toBe("prefs");
    expect(JSON.stringify(pinRow.body)).not.toContain("482913");
    expect(r.vault.allItems().some((i) => i.body.title === PIN_TITLE)).toBe(false);
  });

  it("asks for it on every sign-in, counts wrong ones, locks the vault at five, and signs only after a right one", async () => {
    const r = rig();
    await (async () => {
      const { result, window } = await r.ask("create", create);
      await window({ t: "pkAnswer", action: "create", pin: "482913", newPin: "482913", newPinAgain: "482913" });
      await result;
    })();

    const { result, window } = await r.ask("get", get);
    expect(await window({ t: "pkPrompt" })).toMatchObject({ op: "get", pin: "enter", triesLeft: 5, candidates: [expect.objectContaining({ userName: "ana@example.com" })] });
    const credentialId = ((await window({ t: "pkPrompt" })).candidates as { credentialId: string }[])[0].credentialId;
    // No PIN at all is refused, and isn't counted.
    expect(await window({ t: "pkAnswer", action: "use", credentialId })).toEqual({ error: "pin", left: 5 });
    for (const left of [4, 3, 2, 1]) expect(await window({ t: "pkAnswer", action: "use", credentialId, pin: "907153" })).toEqual({ error: "pin", left });
    expect(await window({ t: "pkPrompt" })).toMatchObject({ triesLeft: 1 });
    expect(await window({ t: "pkAnswer", action: "use", credentialId, pin: "907153" })).toEqual({ error: "pinLocked" });
    expect(r.lockedOuts()).toBe(1);
    expect(r.vault.unlocked).toBe(false);
    // Locked, the right PIN does nothing.
    expect(await window({ t: "pkAnswer", action: "use", credentialId, pin: "482913" })).toEqual({ error: "locked" });
    // The master password: what VaultClient.unlock does, and the request is still there.
    await clearPinTries(r.store);
    r.vault.unlocked = true;
    expect(await window({ t: "pkAnswer", action: "use", credentialId, pin: "482913" })).toEqual({ done: true });
    const signed = await result;
    expect(signed.ok).toBe(true);
    expect(uvFlag((signed.result as { authenticatorData: string }).authenticatorData)).toBe(true);
  });

  it("a right PIN puts the count back, and a new request starts where the last one left off", async () => {
    const r = rig();
    const made = await r.ask("create", create);
    await made.window({ t: "pkAnswer", action: "create", pin: "482913", newPin: "482913", newPinAgain: "482913" });
    await made.result;

    let { result, window } = await r.ask("get", get);
    const credentialId = ((await window({ t: "pkPrompt" })).candidates as { credentialId: string }[])[0].credentialId;
    await window({ t: "pkAnswer", action: "use", credentialId, pin: "907153" });
    await window({ t: "pkAnswer", action: "cancel" });
    expect((await result).ok).toBe(false);
    ({ result, window } = await r.ask("get", get));
    expect(await window({ t: "pkPrompt" })).toMatchObject({ triesLeft: 4 });
    expect(await window({ t: "pkAnswer", action: "use", credentialId, pin: "482913" })).toEqual({ done: true });
    expect(await pinTries(r.store)).toBe(0);
    await result;
  });

  it("only the passkey window can ask or answer, and telling a site it already has one takes no PIN", async () => {
    const r = rig();
    const made = await r.ask("create", create);
    await made.window({ t: "pkAnswer", action: "create", pin: "482913", newPin: "482913", newPinAgain: "482913" });
    const credentialId = ((await made.result).result as { credentialId: string }).credentialId;

    const { result, window } = await r.ask("create", { ...create, exclude: [{ id: credentialId }] });
    // The page itself, or anything but the window, gets nothing.
    expect(await r.send({ t: "pkPrompt", id: "x" }, SITE)).toBeNull();
    expect(await r.send({ t: "pkAnswer", action: "create", pin: "482913" }, SITE)).toBeNull();
    expect(await window({ t: "pkPrompt" })).toMatchObject({ alreadySaved: true });
    expect(await window({ t: "pkAnswer", action: "create" })).toEqual({ done: true });
    expect(await result).toMatchObject({ ok: false, name: "InvalidStateError" });
  });

  it("without somewhere to count, nothing is signed", async () => {
    const r = rig();
    const made = await r.ask("create", create);
    const id = new URL(opened[opened.length - 1]).searchParams.get("id");
    const unguarded = await handlePasskey({ t: "pkAnswer", id, action: "create", newPin: "482913", newPinAgain: "482913" } as never, { url: opened[opened.length - 1] } as never, () => r.vault as never, notThePerson);
    expect(unguarded).toEqual({ error: "locked" });
    await made.window({ t: "pkAnswer", action: "cancel" });
    await made.result;
  });
});
