// The real client against the real API on the isolated stack:
//   PW_STACK_URL=http://localhost:8092 npx vitest run src/passwords/core/integration.test.ts
// Includes the canary test (plan 13.2): distinctive strings in every field, then a
// search of the database dump, logs, Redis, uploads and a real backup for any of them.
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ApiError, VaultApi } from "./api";
import { b64u, fromB64u, randomBytes } from "./bytes";
import { type ItemBody, newBody } from "./model";
import { uploadAttachment } from "./attachments";
import { createSend, openSend, parseSendLink, sendMeta } from "./send";
import { MemoryStore } from "./store";
import { BACKEND, BASE_URL, dockerText, makeUsers, stackEnabled, type TestUser } from "./testing/stack";
import { KeyChangedError, VaultClient, WrongPasswordError } from "./vault";

const MASTER = "correct horse battery staple 7!";

function client(user: TestUser, store = new MemoryStore(), fetcher?: typeof fetch) {
  const api = new VaultApi(BASE_URL, () => user.token, fetcher);
  return new VaultClient(api, store);
}

/** Account creation is rate limited per address, and other suites may be running. */
async function ready(user: TestUser) {
  for (let tries = 0; ; tries++) {
    const c = client(user);
    try {
      const { secretKey } = await c.setup(MASTER);
      return { c, secretKey };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || tries > 4) throw e;
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}

async function second(user: TestUser, secretKey: Uint8Array, fetcher?: typeof fetch) {
  const c = client(user, new MemoryStore(), fetcher);
  await c.unlock(MASTER, secretKey);
  return c;
}

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!stackEnabled)("vault client against the stack", () => {
  let alice: TestUser;
  let bob: TestUser;
  beforeAll(() => {
    [alice, bob] = makeUsers("alice", "bob");
  });

  it("travel mode takes a vault off the device, and brings it back with the master password", async () => {
    const [u] = makeUsers("travel");
    const store = new MemoryStore();
    const c = client(u, store);
    await c.setup(MASTER);
    const vaultId = await c.createSharedVault("Trip");
    await c.saveNew(vaultId, newBody("login", "Secret stuff", { password: "travel-pw" }));
    const keep = await c.saveNew(await c.personalVaultId(), newBody("login", "Everyday", { password: "x" }));
    await c.sync();

    await c.setTravelHidden([vaultId]);
    expect(c.allItems().map((i) => i.body.title)).toEqual(["Everyday"]);
    // It's gone from the local copy too, and stays gone through a sync.
    expect(await store.getItems(vaultId)).toEqual([]);
    await c.sync();
    expect(await store.getItems(vaultId)).toEqual([]);
    expect(c.get(keep.id)?.body.title).toBe("Everyday");
    expect(JSON.stringify([...store.items.values()])).not.toContain("travel-pw");

    await expect(c.endTravel("not the password")).rejects.toThrow(WrongPasswordError);
    expect(c.allItems()).toHaveLength(1);
    await c.endTravel(MASTER);
    expect(c.allItems().map((i) => i.body.title).sort()).toEqual(["Everyday", "Secret stuff"]);
  });

  it("emergency grants open only for the contact, and rotate away", async () => {
    const [g, h] = makeUsers("grantor", "grantee");
    const { c: grantor } = await ready(g);
    const { c: grantee } = await ready(h);
    await grantor.saveNew(await grantor.personalVaultId(), newBody("login", "Rainy day", { password: "rainy-pw" }));
    await grantor.sync();
    await grantor.markVerified(h.id);
    await grantor.emergencyInvite(h.id, 1);
    const [row] = await grantee.emergencyList();
    expect(row.state).toBe("invited");
    await grantee.emergencyAct(row.id, "accept");
    await grantor.refreshEmergency();
    expect((await grantee.emergencyList())[0].state).toBe("ready");
    await grantee.emergencyAct(row.id, "request");
    dockerText(["exec", "-i", BACKEND, "python"], `
import asyncio, uuid
from datetime import timedelta
import app.db_models
from app.database import SessionLocal
from app.passwords.models import PwEmergency
async def main():
    async with SessionLocal() as db:
        r = await db.get(PwEmergency, uuid.UUID("${row.id}"))
        r.requested_at = r.requested_at - timedelta(days=2)
        await db.commit()
asyncio.run(main())
`);
    await grantee.emergencyOpen(row.id);
    expect(grantee.allItems().map((i) => i.body.password)).toContain("rainy-pw");
    // Their own vault's still their own.
    const theirs = await grantee.personalVaultId();
    expect((await grantee.vaults()).find((v) => v.id === theirs)?.role).toBe("manage");

    const [opened] = await grantor.emergencyList();
    await grantor.emergencyEnd(opened);
    await grantee.sync();
    expect(grantee.allItems().map((i) => i.body.password)).not.toContain("rainy-pw");
    // And the grantor's vault still opens, under its new key.
    await grantor.sync();
    expect(grantor.allItems().map((i) => i.body.password)).toContain("rainy-pw");
  });

  it("a Send opens with its key, and with its password, and the server's proof can't open it", async () => {
    const [u] = makeUsers("sendcore");
    const { c } = await ready(u);
    const payload = { kind: "text", title: "t", text: "send-secret" } as const;
    const { id, link } = await createSend(c.api, BASE_URL, payload, { days: 1, views: 3, password: "swordfish" });
    const parsed = parseSendLink(new URL(link).pathname, new URL(link).hash)!;
    expect(parsed.id).toBe(id);
    const anon = new VaultApi(BASE_URL, () => null);
    const meta = await sendMeta(anon, id);
    expect(meta.has_password).toBe(true);
    await expect(openSend(anon, id, parsed.key, meta, "wrong")).rejects.toThrow();
    const opened = await openSend(anon, id, parsed.key, meta, "swordfish");
    expect(opened.payload).toEqual(payload);
    expect(opened.viewsLeft).toBe(2);
    // The right password without the key opens nothing.
    await expect(openSend(anon, id, b64u(randomBytes(32)), meta, "swordfish")).rejects.toThrow();
  });

  it("someone's changed keys shut only their vault, and don't lock you out of yours", async () => {
    const [ua, ub] = makeUsers("lockouta", "lockoutb");
    const a = await ready(ua);
    const b = await ready(ub);
    const shared = await a.c.createSharedVault("Theirs");
    await a.c.saveNew(shared, newBody("login", "Shared login", { password: "x" }));
    await a.c.sync();
    await a.c.addMember(shared, ub.id, "view");
    await b.c.acceptVault(shared);
    await b.c.sync();
    await b.c.saveNew(await b.c.personalVaultId(), newBody("login", "My own", { password: "y" }));
    await b.c.sync();
    expect(b.c.allItems().map((i) => i.body.title).sort()).toEqual(["My own", "Shared login"]);

    // What Bob's device remembers about Alice no longer matches what the server says.
    const trust = await b.c.trustEntries();
    trust[ua.id].ed25519 = b64u(randomBytes(32));
    await b.c.store.setMeta("trust", trust);
    await b.c.lock();
    await b.c.unlock(MASTER);
    expect(b.c.allItems().map((i) => i.body.title)).toEqual(["My own"]);
    expect([...b.c.keyChanges.keys()]).toEqual([shared]);

    await b.c.acceptChangedKey(ua.id);
    await b.c.reload();
    expect(b.c.keyChanges.size).toBe(0);
    expect(b.c.allItems().map((i) => i.body.title).sort()).toEqual(["My own", "Shared login"]);
  });

  it("a new Secret Key: the old one stops working everywhere, and the vault's intact", async () => {
    const [u] = makeUsers("rotate");
    const { c, secretKey } = await ready(u);
    await c.saveNew(await c.personalVaultId(), newBody("login", "Kept", { password: "kept" }));
    await c.sync();
    const fresh = await c.rotateSecretKey(MASTER);
    expect(b64u(fresh)).not.toBe(b64u(secretKey));
    expect(await c.checkPassword(MASTER)).toBe(true);

    await expect(second(u, secretKey)).rejects.toBeTruthy();
    const other = await second(u, fresh);
    expect(other.allItems().map((i) => i.body.password)).toEqual(["kept"]);
    await c.lock();
    await c.unlock(MASTER);
    expect(c.allItems().map((i) => i.body.password)).toEqual(["kept"]);
  });

  it("stretching can go up, and never below what the server asks for", async () => {
    const [u] = makeUsers("kdfup");
    const { c, secretKey } = await ready(u);
    const account = (await c.store.getAccount())!;
    expect(account.kdf.m).toBeGreaterThanOrEqual(65536);
    await c.upgradeKdf(MASTER, { ...account.kdf, m: account.kdf.m * 2 });
    expect((await c.store.getAccount())!.kdf.m).toBe(account.kdf.m * 2);
    const other = await second(u, secretKey);
    expect(other.unlocked).toBe(true);
    // The server's minimum wins over a lower request.
    c.minKdf = { alg: "argon2id", m: account.kdf.m * 3, t: 4, p: 1 };
    expect(c.kdfBelowMinimum(await c.store.getAccount() as { kdf: typeof account.kdf })).toBe(true);
    await c.changePassword(MASTER, MASTER);
    const now = (await c.store.getAccount())!.kdf;
    expect(now.m).toBe(account.kdf.m * 3);
    expect(now.t).toBe(4);
  }, 180_000);

  it("sets up, syncs to a second device, and unlocks", async () => {
    const [u] = makeUsers("sync");
    const { c, secretKey } = await ready(u);
    const vaultId = await c.personalVaultId();
    const item = await c.saveNew(vaultId, newBody("login", "Example", { username: "ana", password: "s3cret", urls: [{ url: "https://example.com" }] }));
    const r = await c.sync();
    expect(r.pushed).toBe(1);

    const d2 = await second(u, secretKey);
    expect(d2.get(item.id)?.body.password).toBe("s3cret");
    expect(d2.search("exam").map((i) => i.id)).toEqual([item.id]);
    expect(d2.search("s3cret")).toEqual([]); // Search never looks at secrets.
    expect((await d2.vaults())[0].displayName).toBe("Personal");

    await d2.update(item.id, { ...d2.get(item.id)!.body, password: "changed" });
    await d2.sync();
    await c.sync();
    expect(c.get(item.id)?.body.password).toBe("changed");
    expect(c.get(item.id)?.body.passwordHistory?.[0].password).toBe("s3cret");

    const versions = await c.versions(item.id);
    expect(versions[0].body.password).toBe("s3cret");
  });

  it("refuses the wrong password and the wrong Secret Key", async () => {
    const [u] = makeUsers("wrong");
    const { secretKey } = await ready(u);
    const c = client(u);
    await expect(c.unlock("not it", secretKey)).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(c.unlock(MASTER, randomBytes(16))).rejects.toBeInstanceOf(WrongPasswordError);
    expect(c.unlocked).toBe(false);
  });

  it("works with no server: offline unlock, offline edits, queue flushes later", async () => {
    const [u] = makeUsers("offline");
    const { c, secretKey } = await ready(u);
    const vid = await c.personalVaultId();
    const before = await c.saveNew(vid, newBody("login", "Before outage", { password: "one" }));
    await c.sync();

    // A device with its own copy, then the network goes away.
    let down = false;
    const flaky: typeof fetch = (input, init) => (down ? Promise.reject(new TypeError("down")) : fetch(input, init));
    const store = new MemoryStore();
    const d2 = client(u, store, flaky);
    await d2.unlock(MASTER, secretKey);
    expect(d2.get(before.id)?.body.title).toBe("Before outage");
    await d2.lock();

    down = true;
    const unlocked = await d2.unlock(MASTER);
    expect(unlocked.offline).toBe(true);
    expect(d2.get(before.id)?.body.password).toBe("one");
    const added = await d2.saveNew(vid, newBody("login", "Made offline", { password: "two" }));
    await d2.update(before.id, { ...d2.get(before.id)!.body, password: "three" });
    expect((await d2.sync()).offline).toBe(true);

    down = false;
    // Offline unlock has no session yet: re-prove on reconnect.
    await d2.lock();
    await d2.unlock(MASTER);
    expect((await d2.store.getItem(added.id))?.dirty).toBeFalsy();
    await c.sync();
    expect(c.get(added.id)?.body.title).toBe("Made offline");
    expect(c.get(before.id)?.body.password).toBe("three");
  });

  it("offline with a wrong password still fails", async () => {
    const [u] = makeUsers("offwrong");
    const { secretKey } = await ready(u);
    let down = false;
    const flaky: typeof fetch = (input, init) => (down ? Promise.reject(new TypeError("down")) : fetch(input, init));
    const d2 = client(u, new MemoryStore(), flaky);
    await d2.unlock(MASTER, secretKey);
    await d2.lock();
    down = true;
    await expect(d2.unlock("nope")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("merges different fields edited on two devices, and keeps both when they clash", async () => {
    const [u] = makeUsers("conflict");
    const { c: a, secretKey } = await ready(u);
    const vid = await a.personalVaultId();
    const item = await a.saveNew(vid, newBody("login", "Shared", { username: "ana", password: "base", notes: "n0" }));
    await a.sync();
    const b = await second(u, secretKey);

    // Different fields: both land.
    await a.update(item.id, { ...a.get(item.id)!.body, username: "ana2" });
    await b.update(item.id, { ...b.get(item.id)!.body, notes: "from b" });
    await a.sync();
    const r = await b.sync();
    expect(r.conflicts).toBe(1);
    await a.sync();
    expect(a.get(item.id)?.body.username).toBe("ana2");
    expect(a.get(item.id)?.body.notes).toBe("from b");
    expect(a.get(item.id)?.body.conflicts).toBeUndefined();

    // The same field: nothing is lost, and it's flagged to pick from.
    await a.update(item.id, { ...a.get(item.id)!.body, password: "from-a" });
    await b.sync();
    await b.update(item.id, { ...b.get(item.id)!.body, password: "from-b" });
    await a.sync();
    await b.sync();
    await a.sync();
    const merged = a.get(item.id)!.body;
    const all = [merged.password, ...(merged.conflicts ?? []).map((x) => (x.body as ItemBody).password)];
    expect(all).toContain("from-a");
    expect(all).toContain("from-b");
    expect(b.get(item.id)?.body.conflicts?.length ?? 0).toBeGreaterThan(0);
  });

  it("trash, restore and purge reach other devices", async () => {
    const [u] = makeUsers("trash");
    const { c: a, secretKey } = await ready(u);
    const vid = await a.personalVaultId();
    const item = await a.saveNew(vid, newBody("note", "Secret note", { notes: "x" }));
    await a.sync();
    const b = await second(u, secretKey);

    await a.trashItem(item.id);
    await a.sync();
    await b.sync();
    expect(b.allItems().find((i) => i.id === item.id)).toBeUndefined();
    expect(b.trash().map((i) => i.id)).toContain(item.id);

    await b.restoreItem(item.id);
    await b.sync();
    await a.sync();
    expect(a.allItems().find((i) => i.id === item.id)).toBeTruthy();

    await a.purgeItem(item.id);
    await a.sync();
    await b.sync();
    expect(b.get(item.id)).toBeUndefined();
    expect((await b.store.getItem(item.id))?.blob ?? null).toBeNull();
  });

  it("changing the master password re-wraps without touching items", async () => {
    const [u] = makeUsers("rekey");
    const { c, secretKey } = await ready(u);
    const vid = await c.personalVaultId();
    const item = await c.saveNew(vid, newBody("login", "Keep me", { password: "p" }));
    await c.sync();
    await c.changePassword(MASTER, "a whole new master password");
    await c.lock();
    await expect(c.unlock(MASTER)).rejects.toBeInstanceOf(WrongPasswordError);
    await c.unlock("a whole new master password");
    expect(c.get(item.id)?.body.title).toBe("Keep me");
    const d2 = client(u);
    await d2.unlock("a whole new master password", secretKey);
    expect(d2.get(item.id)?.body.password).toBe("p");
  });

  it("refuses KDF parameters a hostile server sends", async () => {
    const [u] = makeUsers("kdf");
    const { secretKey } = await ready(u);
    const hostile: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith("/api/passwords/account") && (!init?.method || init.method === "GET")) {
        const body = await res.json();
        body.kdf = { alg: "argon2id", m: 8, t: 1, p: 1 };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return res;
    };
    const c = client(u, new MemoryStore(), hostile);
    await expect(c.unlock(MASTER, secretKey)).rejects.toThrow(/KDF/);
  });

  it("notices a server rolling a vault back", async () => {
    const [u] = makeUsers("rollback");
    const { c, secretKey } = await ready(u);
    const vid = await c.personalVaultId();
    await c.saveNew(vid, newBody("note", "one"));
    await c.sync();
    await c.saveNew(vid, newBody("note", "two"));
    await c.sync();
    let lie = false;
    const hostile: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (lie && String(input).endsWith("/api/passwords/vaults") && (!init?.method || init.method === "GET")) {
        const body = await res.json();
        for (const v of body) v.revision = 1;
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return res;
    };
    const d = client(u, new MemoryStore(), hostile);
    await d.unlock(MASTER, secretKey);
    lie = true;
    const r = await d.sync();
    expect(r.rollback).toEqual([vid]);
  });

  it("device approval moves the Secret Key with matching words, and the server sees neither", async () => {
    const [u] = makeUsers("devapproval");
    const { c: existing, secretKey } = await ready(u);
    const fresh = client(u);
    const join = await fresh.requestDevice("New laptop");
    expect((await join.poll()).status).toBe("pending");

    const [req] = await existing.api.deviceRequests();
    expect(req.id).toBe(join.id);
    const { words } = await existing.beginApproval(req.id, req.device_pub);
    const seen = await join.poll();
    expect(seen.words).toEqual(words);
    await existing.finishApproval(req.id, req.device_pub);
    const done = await join.poll();
    expect(done.status).toBe("approved");
    expect(b64u(done.secretKey!)).toBe(b64u(secretKey));
    await fresh.unlock(MASTER);
    expect(fresh.unlocked).toBe(true);
    await fresh.lock();
  });

  it("device approval with a swapped key shows different words", async () => {
    const [u] = makeUsers("mitm");
    const { c: existing } = await ready(u);
    // A hostile server gives the approver a key of its own instead of the new device's.
    const fresh = client(u);
    const join = await fresh.requestDevice("Laptop");
    const [req] = await existing.api.deviceRequests();
    const attacker = b64u(randomBytes(32));
    const { deviceSafetyWords } = await import("./safety");
    const approverSide = await deviceSafetyWords(fromB64u(attacker), randomBytes(32));
    const honest = await existing.beginApproval(req.id, req.device_pub);
    expect(approverSide).not.toEqual(honest.words);
    expect((await join.poll()).words).toEqual(honest.words);
  });

  it("shares a vault, and removing someone rotates the key and lists what to change", async () => {
    const a = await ready(alice);
    const b = await ready(bob);
    const shared = await a.c.createSharedVault("Family");
    const item = await a.c.saveNew(shared, newBody("login", "Netflix", { username: "fam", password: "tv-pass" }));
    await a.c.saveNew(shared, newBody("note", "Wifi notes", { notes: "n" }));
    await a.c.update(item.id, { ...a.c.get(item.id)!.body, password: "tv-pass-2" });
    await a.c.sync();

    await a.c.addMember(shared, bob.id, "edit");
    await b.c.sync();
    const invited = (await b.c.vaults()).find((v) => v.id === shared)!;
    // Nothing opens on an invitation alone.
    expect(invited.displayName).toBe("(can't open)");
    expect(invited.accepted).toBe(false);
    await b.c.acceptVault(shared);
    await b.c.sync();
    expect(b.c.get(item.id)?.body.password).toBe("tv-pass-2");

    // Both can edit.
    await b.c.update(item.id, { ...b.c.get(item.id)!.body, notes: "bob was here" });
    await b.c.sync();
    await a.c.sync();
    expect(a.c.get(item.id)?.body.notes).toBe("bob was here");

    const change = await a.c.removeMembers(shared, [bob.id]);
    expect(change.map((i) => i.body.title)).toEqual(["Netflix"]);
    await b.c.sync();
    expect((await b.c.vaults()).find((v) => v.id === shared)).toBeUndefined();
    expect(b.c.get(item.id)).toBeUndefined();
    // Alice carries on under the new key, and old versions still open.
    await a.c.sync();
    expect(a.c.get(item.id)?.body.password).toBe("tv-pass-2");
    expect((await a.c.versions(item.id)).length).toBeGreaterThan(0);
    const again = await second(alice, a.secretKey);
    expect(again.get(item.id)?.body.password).toBe("tv-pass-2");
  });

  it("a forged vault key from the server is refused, and a changed key warns", async () => {
    const [ua, ub, mallory] = makeUsers("forgea", "forgeb", "forgem");
    const a = await ready(ua);
    const b = await ready(ub);
    const m = await ready(mallory);
    const shared = await a.c.createSharedVault("Real");
    await a.c.addMember(shared, ub.id, "view");
    await b.c.acceptVault(shared);
    expect((await b.c.vaults()).find((v) => v.id === shared)?.displayName).toBe("Real");

    // The server swaps in a grant signed by someone else, claiming to be Alice.
    const forged = await m.c.createSharedVault("Forged");
    const forgedRow = (await m.c.store.getVaults()).find((v) => v.id === forged)!;
    const hostile: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith("/api/passwords/vaults") && (!init?.method || init.method === "GET")) {
        const body = await res.json();
        for (const v of body) {
          if (v.id === shared) {
            v.wrapped_key = forgedRow.wrappedKey;
            v.signature = forgedRow.signature;
          }
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return res;
    };
    const d = client(ub, new MemoryStore(), hostile);
    await d.unlock(MASTER, b.secretKey);
    expect((await d.vaults()).find((v) => v.id === shared)?.displayName).toBe("(can't open)");

    // Keys that change after first contact stop sharing until they're looked at.
    const trust = await a.c.trustEntries();
    trust[ub.id].ed25519 = b64u(randomBytes(32));
    await a.c.store.setMeta("trust", trust);
    const other = await a.c.createSharedVault("Another");
    await expect(a.c.addMember(other, ub.id, "view")).rejects.toBeInstanceOf(KeyChangedError);
    await a.c.acceptChangedKey(ub.id);
    await a.c.addMember(other, ub.id, "view");
  });

  it("safety words match across two people", async () => {
    const [ua, ub] = makeUsers("wa", "wb");
    const a = await ready(ua);
    const b = await ready(ub);
    expect(await a.c.identityWordsFor(ub.id)).toEqual(await b.c.myIdentityWords());
    expect(await b.c.identityWordsFor(ua.id)).toEqual(await a.c.myIdentityWords());
  });
});

// Long enough to be unmistakable anywhere; hex so encodings don't hide it.
const CANARY = "PWCANARY7f3a9c1e";

function canaries(): ItemBody {
  const f = (name: string) => `${CANARY}_${name}`;
  return newBody("login", f("title"), {
    username: f("username"),
    password: f("password"),
    notes: f("notes"),
    tags: [f("tag")],
    urls: [{ url: `https://${CANARY.toLowerCase()}-url.example.com/login` }],
    fields: [{ name: f("fieldname"), value: f("fieldvalue"), type: "hidden" }],
    totp: { secret: "JBSWY3DPEHPK3PXP", issuer: f("issuer") },
    cardNumber: f("card"),
    firstName: f("first"),
    email: `${CANARY.toLowerCase()}@example.com`,
    documentNumber: f("document"),
    apiKey: f("apikey"),
    wifiPassword: f("wifi"),
    sshPrivate: f("ssh"),
  });
}

function assertNoCanary(where: string, text: string) {
  const lower = text.toLowerCase();
  expect(lower.includes(CANARY.toLowerCase()), `canary found in ${where}`).toBe(false);
}

describe.skipIf(!stackEnabled)("canary: the server can't read", () => {
  it("no plaintext anywhere on the server after a full round", async () => {
    const [u, v] = makeUsers("canarya", "canaryb");
    const a = await ready(u);
    const b = await ready(v);
    const vid = await a.c.personalVaultId();
    const shared = await a.c.createSharedVault(`${CANARY}_vaultname`);
    const body = canaries();
    const i1 = await a.c.saveNew(vid, body);
    const i2 = await a.c.saveNew(shared, { ...body, title: `${CANARY}_sharedtitle` });
    await a.c.saveNew(vid, newBody("folder", `${CANARY}_folder`));
    await a.c.saveNew(vid, newBody("bookmark", `${CANARY}_bookmark`, { bookmark: { parent: "root:bar", pos: 1, url: `https://${CANARY}.example.com/bookmark` } }));
    await a.c.saveNew(vid, newBody("site_rule", `${CANARY}_rule`, { rule: { host: `${CANARY}.example.com`, username: "#u" } }));
    await a.c.sync();
    await a.c.update(i1.id, { ...a.c.get(i1.id)!.body, password: `${CANARY}_password2` });
    await a.c.addMember(shared, v.id, "edit");
    await b.c.acceptVault(shared);
    await a.c.sync();
    await b.c.sync();
    expect(b.c.get(i2.id)?.body.title).toBe(`${CANARY}_sharedtitle`);
    expect(a.c.get(i1.id)?.body.notes).toBe(`${CANARY}_notes`);

    // Also a wrong-key attempt, an export note and a device request, to exercise those paths.
    await expect(client(u).unlock(`${CANARY}_wrongmaster`, a.secretKey)).rejects.toBeTruthy();
    await a.c.api.noteExport();
    await a.c.requestDevice("laptop");

    // Sharing beyond a vault: a Send with a password, an attachment, emergency access.
    const sent = await createSend(a.c.api, BASE_URL, { kind: "text", title: `${CANARY}_sendtitle`, text: `${CANARY}_sendtext` }, { days: 1, views: 2, password: `${CANARY}_sendpass` });
    expect(sent.link).not.toContain(CANARY);
    const attached = new Blob([`${CANARY}_attachment`]);
    await a.c.sync();
    const ref = await uploadAttachment(a.c.api, vid, i1.id, { name: `${CANARY}_file.txt`, size: attached.size, slice: (x, y) => attached.slice(x, y) });
    await a.c.update(i1.id, { ...a.c.get(i1.id)!.body, attachments: [ref] });
    await a.c.markVerified(v.id);
    await a.c.emergencyInvite(v.id, 3);
    await b.c.emergencyAct((await b.c.emergencyList())[0].id, "accept");
    await a.c.refreshEmergency();
    await a.c.setTravelHidden([]);
    await a.c.sync();

    // 1. The whole database, as text and with binary columns.
    const dump = dockerText(["exec", "PromptlyPw-Postgres", "pg_dump", "-U", "promptly", "-d", "promptly", "--inserts"]);
    expect(dump.length).toBeGreaterThan(10000);
    expect(dump).toContain("pw_items");
    assertNoCanary("pg_dump", dump);
    // bytea shows as hex in a dump, so look for the hex of the canary as well.
    const canaryHex = Buffer.from(CANARY).toString("hex");
    expect(dump.toLowerCase().includes(canaryHex), "canary hex in pg_dump").toBe(false);

    // 2. Every service's logs.
    for (const name of [BACKEND, "PromptlyPw-Nginx", "PromptlyPw-ArqWorker", "PromptlyPw-MailWorker", "PromptlyPw-Postgres"]) {
      const logs = execText(["logs", name]);
      assertNoCanary(`logs of ${name}`, logs);
      expect(logs).not.toContain(b64u(a.secretKey));
    }

    // 3. Redis: every key and every string value.
    const keys = dockerText(["exec", "PromptlyPw-Redis", "redis-cli", "--scan"]);
    assertNoCanary("redis keys", keys);
    const dumpRedis = dockerText(["exec", "PromptlyPw-Redis", "sh", "-c", "redis-cli --scan | while read k; do redis-cli --raw dump \"$k\" 2>/dev/null; done"]);
    assertNoCanary("redis values", dumpRedis);

    // 4. The uploads folder.
    const grep = dockerText(["exec", BACKEND, "sh", "-c", `grep -rIl ${CANARY} /app/uploads /app/backups 2>/dev/null | head -5; echo done`]);
    expect(grep.trim()).toBe("done");

    // 5. A real backup, made the way the server makes them. It's pg_dump's compressed
    // format, so a plain search would find nothing whatever was in it: read it back as SQL,
    // and prove the search works with a marker planted in an ordinary column first.
    const MARK = "PWPOSITIVEMARK9d2b";
    dockerText(["exec", "PromptlyPw-Postgres", "psql", "-U", "promptly", "-d", "promptly", "-c", `INSERT INTO pw_activity (id, user_id, event, at) VALUES (gen_random_uuid(), '${u.id}', '${MARK}', now())`]);
    const made = dockerText(
      ["exec", "-i", BACKEND, "python"],
      `
import asyncio
import app.db_models
from app.backups import service
async def main():
    run = await service.run_backup("manual")
    print("BACKUP", run.status, run.filename)
asyncio.run(main())
`,
    );
    const line = made.split(/\r?\n/).find((l) => l.startsWith("BACKUP "));
    expect(line, made).toContain("BACKUP ok ");
    const file = line!.split(" ")[2];
    const sql = dockerText(["exec", BACKEND, "sh", "-c", `pg_restore -f - /app/backups/${file}`]);
    expect(sql, "the search must be able to see into a backup").toContain(MARK);
    expect(sql).toContain("pw_items");
    assertNoCanary("backup file", sql);
    expect(sql.toLowerCase().includes(canaryHex), "canary hex in backup").toBe(false);
    dockerText(["exec", "PromptlyPw-Postgres", "psql", "-U", "promptly", "-d", "promptly", "-c", `DELETE FROM pw_activity WHERE event = '${MARK}'`]);
    dockerText(["exec", BACKEND, "rm", "-f", `/app/backups/${file}`]);

    // 6. Push payloads. Anything the server sends a device is built from its own words.
    const pushed = dump.split("\n").filter((l) => l.includes("INSERT INTO public.notifications"));
    assertNoCanary("notifications", pushed.join("\n"));
  });
});

describe.skipIf(!stackEnabled)("canary: what the client sends", () => {
  it("no plaintext, key or master password in any request, for a full round", async () => {
    const [u] = makeUsers("canaryreq");
    const sent: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const body = init?.body;
      const text = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder("latin1").decode(body) : "";
      sent.push(`${String(input)} ${JSON.stringify(init?.headers ?? {})} ${text}`);
      return fetch(input, init);
    };
    const store = new MemoryStore();
    const c = client(u, store, recording);
    const master = `${CANARY}_master`;
    // Waits out the rate limit a busy test run can hit, as ready() does.
    const { secretKey } = await (async () => {
      for (let tries = 0; ; tries++) {
        try {
          return await c.setup(master);
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 429 || tries > 4) throw e;
          await new Promise((r) => setTimeout(r, 20_000));
        }
      }
    })();
    const vid = await c.personalVaultId();
    const item = await c.saveNew(vid, canaries());
    await c.sync();
    await c.update(item.id, { ...c.get(item.id)!.body, notes: `${CANARY}_notes2` });
    const shared = await c.createSharedVault(`${CANARY}_vault`);
    await c.saveNew(shared, { ...canaries(), title: `${CANARY}_shared` });
    await c.sync();
    await createSend(c.api, BASE_URL, { kind: "text", title: `${CANARY}_s`, text: `${CANARY}_t` }, { days: 1, views: 1, password: `${CANARY}_p` });
    await c.lock();
    await c.unlock(master, secretKey);
    await c.sync();

    expect(sent.length).toBeGreaterThan(10);
    const all = sent.join("\n");
    assertNoCanary("requests", all);
    expect(all.toLowerCase().includes(Buffer.from(CANARY).toString("hex"))).toBe(false);
    expect(all.includes(Buffer.from(CANARY).toString("base64").slice(0, 16))).toBe(false);
    expect(all).not.toContain(b64u(secretKey));
  });
});

function execText(args: string[]): string {
  // ``docker logs`` writes the container's stderr to its own stderr.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("docker", args, { encoding: "latin1", maxBuffer: 1024 * 1024 * 1024 });
  return `${r.stdout}\n${r.stderr}`;
}
