// What a hostile server can try, against the real client. The server here reads and changes
// whatever it likes in its answers. Plan 13.9: these started as proofs that each attack worked.
import { describe, expect, it } from "vitest";

import { ApiError, VaultApi } from "./api";
import { b64u, fromB64u, randomBytes } from "./bytes";
import { aad, openSealed, sealTo } from "./format";
import { decryptItem, deriveRootRaw, encryptItem, grantInput, sealField } from "./keys";
import { homeInput } from "./ownership";
import { newBody } from "./model";
import { aesKey, ed25519Public, ed25519Sign, KDF_FLOOR, x25519Public } from "./primitives";
import { MemoryStore } from "./store";
import { KeyChangedError, VaultClient, WrongPasswordError } from "./vault";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ALICE = "11111111-1111-4111-8111-111111111111";
const MASTER = "correct horse battery staple 7!";

// IndexedDB getAll() returns records in key order.
class IdbOrderStore extends MemoryStore {
  async getVaults() {
    return (await super.getVaults()).sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
  }
}

function server(userId = ALICE) {
  const api: any = new VaultApi("http://evil", () => "t", (() => { throw new Error("no net"); }) as any);
  const s: any = {
    account: null, vaults: new Map(), items: new Map(), rev: new Map(), members: new Map(), emergency: [], wrapped: [],
    userKeys: new Map(), sessionAccountId: null, rotations: [], approverPub: null, payload: null, status: "pending", authKeys: [],
  };
  const out = () => ({
    token: "t", expires_at: new Date(Date.now() + 1e6).toISOString(), account_id: s.sessionAccountId ?? s.account.account_id,
    wrapped_keyset: s.account.wrapped_keyset, kdf: s.account.kdf, salt: s.account.salt, x25519_pub: s.account.x25519_pub,
    ed25519_pub: s.account.ed25519_pub, kit_confirmed: false, kit_checked_at: null, user_id: userId,
  });
  api.prelogin = async () => ({
    user_id: userId, exists: !!s.account, wrapped_keyset: s.account?.wrapped_keyset ?? null, account_id: s.account?.account_id ?? null, kdf: s.account?.kdf ?? null, salt: s.account?.salt ?? null,
    min_kdf: { alg: "argon2id", m: 65536, t: 3, p: 1 }, preview: false, enabled: true, server_time: new Date().toISOString(),
  });
  api.createAccount = async (b: any) => {
    s.account = b;
    s.vaults.set(b.personal_vault_id, {
      id: b.personal_vault_id, kind: "personal", revision: 0, generation: 1, name: b.personal_vault_name, role: "manage",
      wrapped_key: b.personal_vault_grant.wrapped_key, signature: b.personal_vault_grant.signature, granted_by: userId, member_generation: 1, accepted: true, member_count: 1,
    });
    return out();
  };
  api.createSession = async (auth: string) => { s.authKeys.push(auth); return out(); };
  api.endSession = async () => undefined;
  api.rekey = async (b: any) => { s.account = { ...s.account, kdf: b.new_kdf, salt: b.new_salt, wrapped_keyset: b.new_wrapped_keyset }; };
  api.vaults = async () => [...s.vaults.values()].map((v: any) => ({ ...v }));
  api.createVault = async (b: any) => {
    s.vaults.set(b.id, { id: b.id, kind: "shared", revision: 0, generation: 1, name: b.name, role: "manage", wrapped_key: b.grant.wrapped_key, signature: b.grant.signature, granted_by: userId, member_generation: 1, accepted: true, member_count: 1 });
    s.members.set(b.id, [{ user_id: userId, username: "alice", x25519_pub: s.account.x25519_pub, ed25519_pub: s.account.ed25519_pub, accepted: true, role: "manage" }]);
  };
  api.changes = async (id: string, since: number) => {
    const v = s.vaults.get(id);
    const items = [...s.items.values()].filter((i: any) => i.vaultId === id && i.revision > since).map(({ vaultId, ...r }: any) => r);
    return { revision: v.revision, generation: v.generation, items, more: false };
  };
  api.removeMember = async (id: string, uid: string) => {
    s.members.set(id, (s.members.get(id) ?? []).filter((m: any) => m.user_id !== uid));
  };
  api.writeItems = async (id: string, writes: any[], generation?: number) => {
    const v = s.vaults.get(id);
    if (generation !== undefined && generation !== v.generation) throw new ApiError(409, "new key");
    v.revision += 1;
    const applied: string[] = [];
    const conflicts: any[] = [];
    for (const w of writes) {
      const row = s.items.get(w.id);
      if (row && row.revision > (w.base_revision ?? 0)) { conflicts.push({ id: w.id, reason: "changed", revision: row.revision, blob: row.blob, deleted: row.deleted }); continue; }
      s.items.set(w.id, { id: w.id, vaultId: id, revision: v.revision, blob: w.blob, deleted: !!w.deleted, purged: !w.blob, updated_at: new Date().toISOString() });
      applied.push(w.id);
    }
    return { revision: v.revision, applied, conflicts };
  };
  api.versions = async () => [];
  api.members = async (id: string) => s.members.get(id) ?? [];
  api.addMember = async (id: string, b: any) => {
    const k = s.userKeys.get(b.user_id);
    s.members.set(id, [...(s.members.get(id) ?? []), { user_id: b.user_id, username: k.username, x25519_pub: k.x25519_pub, ed25519_pub: k.ed25519_pub, grant: b.grant, role: b.role, accepted: false }]);
  };
  api.rotate = async (id: string, b: any) => {
    s.rotations.push(b);
    const v = s.vaults.get(id);
    v.generation += 1;
    v.revision += 1;
    v.name = b.name;
    const mine = b.members.find((m: any) => m.user_id === userId);
    v.wrapped_key = mine.grant.wrapped_key;
    v.signature = mine.grant.signature;
    v.member_generation = v.generation;
    for (const m of b.members) {
      const row = (s.members.get(id) ?? []).find((x: any) => x.user_id === m.user_id);
      if (row) row.grant = m.grant;
    }
    for (const i of b.items) { const row = s.items.get(i.id); row.blob = i.blob; row.revision = v.revision; }
  };
  api.userKeys = async (id: string) => {
    const k = s.userKeys.get(id);
    if (!k) throw new Error("no such user");
    return { user_id: id, username: k.username ?? id, x25519_pub: k.x25519_pub, ed25519_pub: k.ed25519_pub };
  };
  api.request = async (method: string, path: string, body: any) => {
    if (method === "GET" && path === "/emergency") return s.emergency;
    if (method === "POST" && path === "/emergency") { s.emergency.push({ id: "real", grantor_id: userId, grantor: "alice", grantee_id: body.grantee_id, grantee: "contact", wait_days: body.wait_days, state: "accepted", requested_at: null, opens_at: null, wrapped: {}, opened_vaults: [] }); return {}; }
    if (method === "PUT" && /\/emergency\/.*\/wrap/.test(path)) { s.wrapped.push(body); return {}; }
    throw new Error(`unhandled ${method} ${path}`);
  };
  api.deviceRequestCreate = async () => ({ id: "req-1", code: "ABC", poll_secret: "p", expires_at: "" });
  api.deviceRequestPoll = async () => ({ status: s.status, approver_pub: s.approverPub, payload: s.payload });
  return { api, s };
}

function persona(username: string) {
  const x = randomBytes(32);
  const e = randomBytes(32);
  return { x, e, username, keys: { x25519_pub: b64u(x25519Public(x)), ed25519_pub: b64u(ed25519Public(e)), username } };
}

async function vaultKeyVia(p: { x: Uint8Array }, vaultId: string, memberId: string, wrapped: string) {
  return openSealed(p.x, fromB64u(wrapped), aad(vaultId, "", `vault_key:${memberId}`));
}

async function fresh(store: any = new MemoryStore()) {
  const { api, s } = server();
  const c = new VaultClient(api, store);
  const { secretKey } = await c.setup(MASTER);
  return { api, s, c, secretKey, store };
}


describe("a hostile server", () => {
  it("can't make up an emergency contact and be handed the vault keys", async () => {
    const { s, c } = await fresh();
    const vid = await c.personalVaultId();
    await c.saveNew(vid, newBody("login", "Bank", { password: "hunter2-secret" }));
    await c.sync();
    const evil = persona("nobody");
    const fake = "99999999-9999-4999-8999-999999999999";
    s.userKeys.set(fake, evil.keys);
    s.emergency = [{ id: "e1", grantor_id: ALICE, grantor: "alice", grantee_id: fake, grantee: "nobody", wait_days: 90, state: "accepted", requested_at: null, opens_at: null, wrapped: {}, opened_vaults: [] }];
    await c.sync();
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
  });

  it("seals to a contact the person chose, and stops if that contact's keys change", async () => {
    const { s, c } = await fresh();
    const contact = persona("carol");
    const cid = "33333333-3333-4333-8333-333333333333";
    s.userKeys.set(cid, contact.keys);
    await c.emergencyInvite(cid, 3);
    // Named, and marked accepted by the server, but those keys are only the server's word so far.
    // It could as easily be the server's own, and it would then hold every key. Nothing goes.
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    await c.markVerified(cid);
    await c.refreshEmergency();
    expect(s.wrapped).toHaveLength(1);
    expect(s.wrapped[0].grants).toHaveLength(1);

    // Same person, new keys: the server's swapped them in. Nothing more goes out.
    s.wrapped.length = 0;
    s.userKeys.set(cid, persona("carol").keys);
    const v = s.vaults.get(await c.personalVaultId());
    v.generation += 1;
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
  });

  it("\"they match\" is about the words that were on screen, not whatever the server says next", async () => {
    const { s, c } = await fresh();
    const cid = "44444444-4444-4444-8444-444444444444";
    const real = persona("dana").keys;
    s.userKeys.set(cid, real);
    const shown = await c.identityWordsFor(cid);
    s.userKeys.set(cid, persona("dana").keys);
    await expect(c.markVerified(cid, shown)).rejects.toThrow(/changed/);
    expect((await c.trustEntries())[cid]?.verified).toBeFalsy();
    s.userKeys.set(cid, real);
    await c.markVerified(cid, shown);
    expect((await c.trustEntries())[cid]?.verified).toBe(true);
  });

  it("can't get a new vault key sealed to someone else when a member's removed", async () => {
    const { s, c } = await fresh();
    const vid = await c.createSharedVault("Team");
    const bob = persona("bob");
    const bobId = "22222222-2222-4222-8222-222222222222";
    const carolId = "33333333-3333-4333-8333-333333333333";
    s.userKeys.set(bobId, bob.keys);
    s.userKeys.set(carolId, persona("carol").keys);
    await c.addMember(vid, bobId, "edit");
    await c.addMember(vid, carolId, "edit");

    // A pinned member's key swapped in the list.
    const bobRow = s.members.get(vid).find((m: any) => m.user_id === bobId);
    const honest = bobRow.x25519_pub;
    bobRow.x25519_pub = persona("evil").keys.x25519_pub;
    await expect(c.removeMembers(vid, [carolId])).rejects.toBeInstanceOf(KeyChangedError);
    expect(s.rotations).toEqual([]);
    bobRow.x25519_pub = honest;

    // Somebody slipped into the list, with no say from anyone.
    const evil = persona("newcomer");
    const evilId = "66666666-6666-4666-8666-666666666666";
    s.members.get(vid).push({ user_id: evilId, username: "newcomer", x25519_pub: evil.keys.x25519_pub, ed25519_pub: evil.keys.ed25519_pub });
    await expect(c.removeMembers(vid, [carolId])).rejects.toThrow(/Check who gets the new key/);
    expect(s.rotations).toEqual([]);
    // It's named, for the person to decide.
    expect((await c.rotationPlan(vid, [carolId])).find((p) => p.userId === evilId)?.known).toBe(false);
  });

  it("can't plant a vault as your personal one, or swap the real one's key", async () => {
    const { s, c } = await fresh(new IdbOrderStore());
    const realId = await c.personalVaultId();
    const me = (await c.store.getAccount())!;
    const evil = persona("alice");
    const fake = "00000000-0000-4000-8000-00000000abcd";
    s.userKeys.set(fake, evil.keys);
    const phantom = "00000000-0000-4000-8000-000000000001";
    const K = randomBytes(32);
    const wrapped = await sealTo(fromB64u(me.x25519Pub), K, aad(phantom, "", `vault_key:${ALICE}`));
    const sig = ed25519Sign(evil.e, grantInput(phantom, ALICE, 1, wrapped));
    s.vaults.set(phantom, { id: phantom, kind: "personal", revision: 0, generation: 1, name: await sealField(await aesKey(K), phantom, "name", "Personal"), role: "manage", wrapped_key: b64u(wrapped), signature: b64u(sig), granted_by: fake, member_generation: 1, accepted: true, member_count: 1 });
    await c.sync();
    expect(await c.personalVaultId()).toBe(realId);
    // Nothing from it opens, and new saves go to the real one.
    s.items.set("planted", { id: "planted", vaultId: phantom, revision: 1, blob: "x", deleted: false, purged: false, updated_at: new Date().toISOString() });
    s.vaults.get(phantom).revision = 1;
    await c.sync();
    expect(c.allItems({ includeSystem: true }).some((i) => i.vaultId === phantom)).toBe(false);

    // And the real one's grant replaced outright with one the server signed.
    const K2 = randomBytes(32);
    const w2 = await sealTo(fromB64u(me.x25519Pub), K2, aad(realId, "", `vault_key:${ALICE}`));
    const v = s.vaults.get(realId);
    Object.assign(v, { wrapped_key: b64u(w2), signature: b64u(ed25519Sign(evil.e, grantInput(realId, ALICE, 2, w2))), granted_by: fake, member_generation: 2, generation: 2 });
    const r = await c.sync();
    expect(r.rollback).toContain(realId);
    expect(await c.personalVaultId()).toBe(realId);
    const saved = await c.saveNew(realId, newBody("login", "After", { password: "secret-3" }));
    await c.sync();
    const row = s.items.get(saved.id);
    if (row?.blob) await expect(decryptItem(await aesKey(K2), realId, saved.id, fromB64u(row.blob))).rejects.toBeTruthy();
  });

  it("can't open a shared vault for you just by saying you accepted it", async () => {
    const { s, c } = await fresh();
    const me = (await c.store.getAccount())!;
    const inviter = persona("dana");
    const did = "77777777-7777-4777-8777-777777777777";
    s.userKeys.set(did, inviter.keys);
    const vid = "88888888-8888-4888-8888-888888888888";
    const K = randomBytes(32);
    const wrapped = await sealTo(fromB64u(me.x25519Pub), K, aad(vid, "", `vault_key:${ALICE}`));
    s.vaults.set(vid, { id: vid, kind: "shared", revision: 0, generation: 1, name: await sealField(await aesKey(K), vid, "name", "Shared"), role: "view", wrapped_key: b64u(wrapped), signature: b64u(ed25519Sign(inviter.e, grantInput(vid, ALICE, 1, wrapped))), granted_by: did, member_generation: 1, accepted: true, member_count: 2 });
    await c.sync();
    expect((await c.trustEntries())[did]).toBeUndefined();
    expect((await c.vaults()).find((v) => v.id === vid)?.displayName).toBe("(can't open)");

    // The person accepts: now it opens, on the keys they were shown.
    api_accept(s, c);
    await c.acceptVault(vid);
    expect((await c.vaults()).find((v) => v.id === vid)?.displayName).toBe("Shared");
    expect((await c.trustEntries())[did]?.ed25519).toBe(inviter.keys.ed25519_pub);
  });

  it("can't bring back an old vault key after someone's removed", async () => {
    const { s, c } = await fresh();
    const vid = await c.createSharedVault("Team");
    const mallory = persona("mallory");
    const mid = "44444444-4444-4444-8444-444444444444";
    s.userKeys.set(mid, mallory.keys);
    await c.addMember(vid, mid, "edit");
    const m = s.members.get(vid).find((x: any) => x.user_id === mid);
    const K1 = await vaultKeyVia(mallory, vid, mid, m.grant.wrapped_key);
    const oldGrant = { wrapped_key: s.vaults.get(vid).wrapped_key, signature: s.vaults.get(vid).signature, name: s.vaults.get(vid).name };
    await c.removeMembers(vid, [mid]);
    const v = s.vaults.get(vid);
    Object.assign(v, { ...oldGrant, member_generation: 1, generation: 1, revision: v.revision + 5 });
    const r = await c.sync();
    expect(r.rollback).toContain(vid);
    const after = await c.saveNew(vid, newBody("login", "After removal", { password: "for-remaining-members" }));
    await c.sync();
    const row = s.items.get(after.id);
    if (row?.blob) await expect(decryptItem(await aesKey(K1), vid, after.id, fromB64u(row.blob))).rejects.toBeTruthy();
  });

  it("can't serve an older copy of an item, whatever revision it claims", async () => {
    const { s, c } = await fresh();
    const vid = await c.personalVaultId();
    const it1 = await c.saveNew(vid, newBody("login", "Mail", { password: "old-compromised" }));
    await c.sync();
    const oldBlob = s.items.get(it1.id).blob;
    await c.update(it1.id, { ...c.get(it1.id)!.body, password: "new-strong" });
    await c.sync();
    const v = s.vaults.get(vid);
    v.revision += 100;
    s.items.get(it1.id).blob = oldBlob;
    s.items.get(it1.id).revision = v.revision;
    const r = await c.sync();
    expect(r.rollback).toContain(vid);
    expect(c.get(it1.id)!.body.password).toBe("new-strong");
  });

  it("can't wipe a device by claiming a different account", async () => {
    const { s, c, store } = await fresh();
    const vid = await c.createSharedVault("Team");
    const bobId = "22222222-2222-4222-8222-222222222222";
    s.userKeys.set(bobId, persona("bob").keys);
    await c.addMember(vid, bobId, "edit");
    await c.lock();
    s.sessionAccountId = "deadbeef-dead-4ead-8ead-deadbeefdead";
    await expect(c.unlock(MASTER)).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await store.getMeta("trust")).toHaveProperty(bobId);
    expect((await store.getVaults()).length).toBeGreaterThan(0);
    s.sessionAccountId = null;
    await c.unlock(MASTER);
    expect(c.unlocked).toBe(true);
    expect((await c.trustEntries())[bobId]).toBeTruthy();
  });

  it("can't get a password guess out of a Secret Key it made up", async () => {
    const { s, api } = await fresh();
    const d = new VaultClient(api, new MemoryStore());
    const join = await d.requestDevice("phone");
    const forged = randomBytes(16);
    const devicePub: Uint8Array = (join as any).pub;
    const sealed = await sealTo(devicePub, new TextEncoder().encode(JSON.stringify({ secret_key: b64u(forged), account_id: "x" })), aad(join.id, "", "device_join"));
    s.status = "approved";
    s.payload = b64u(sealed);
    s.approverPub = null;
    await join.poll().catch(() => undefined);
    s.account = { ...s.account, kdf: KDF_FLOOR };
    const before = s.authKeys.length;
    await expect(d.unlock(MASTER, forged)).rejects.toBeInstanceOf(WrongPasswordError);
    // Nothing derived from the password left the device.
    expect(s.authKeys.length).toBe(before);
    void deriveRootRaw;
  });

  it("can't switch the local check off by leaving a field out", async () => {
    const { s, api, secretKey } = await fresh();
    const d = new VaultClient(api, new MemoryStore());
    const real = api.prelogin;
    api.prelogin = async () => ({ ...(await real()), wrapped_keyset: null });
    const before = s.authKeys.length;
    await expect(d.unlock(MASTER, secretKey)).rejects.toThrow(/didn't send/);
    expect(s.authKeys.length).toBe(before);
    api.prelogin = real;
  });

  it("can't lower key settings through a session answer", async () => {
    const { s, c } = await fresh();
    await c.upgradeKdf(MASTER, { alg: "argon2id", m: 131072, t: 3, p: 1 });
    await c.lock();
    const real = c.api.createSession;
    c.api.createSession = async (a: string) => ({ ...(await real(a)), kdf: { alg: "argon2id", m: 65536, t: 3, p: 1 } });
    await expect(c.unlock(MASTER)).rejects.toThrow(/weaker/);
    c.api.createSession = real;
    void s;
  });

  it("can't get weaker key settings accepted", async () => {
    const { s, c, secretKey } = await fresh();
    await c.upgradeKdf(MASTER, { alg: "argon2id", m: 131072, t: 3, p: 1 });
    await c.lock();
    s.account = { ...s.account, kdf: { alg: "argon2id", m: 65536, t: 3, p: 1 } };
    await expect(c.unlock(MASTER)).rejects.toThrow(/weaker/);
    void secretKey;
  });

  it("a device that missed a key change moves its edits to the new key, with nobody hostile", async () => {
    const { s, api, c, secretKey } = await fresh();
    const vid = await c.createSharedVault("Team");
    const mallory = persona("mallory");
    const mid = "44444444-4444-4444-8444-444444444444";
    s.userKeys.set(mid, mallory.keys);
    await c.addMember(vid, mid, "edit");
    const K1 = await vaultKeyVia(mallory, vid, mid, s.members.get(vid).find((x: any) => x.user_id === mid).grant.wrapped_key);
    await c.sync();
    const c2 = new VaultClient(api, new MemoryStore());
    await c2.unlock(MASTER, secretKey);
    const offline = await c2.saveNew(vid, newBody("login", "Added offline", { password: "written-before-seeing-rotation" }));
    await c.removeMembers(vid, [mid]);
    await c2.sync();
    const row = s.items.get(offline.id);
    expect(row).toBeTruthy();
    await expect(decryptItem(await aesKey(K1), vid, offline.id, fromB64u(row.blob))).rejects.toBeTruthy();
    await c.sync();
    expect(c.get(offline.id)?.body.password).toBe("written-before-seeing-rotation");
  });

  it("a member's junk blob doesn't stop them being rotated out", async () => {
    const { s, c } = await fresh();
    const vid = await c.createSharedVault("Team");
    const mid = "44444444-4444-4444-8444-444444444444";
    s.userKeys.set(mid, persona("mallory").keys);
    await c.addMember(vid, mid, "edit");
    await c.saveNew(vid, newBody("login", "Real", { password: "real" }));
    await c.sync();
    const v = s.vaults.get(vid);
    v.revision += 1;
    s.items.set("poison", { id: "11111111-aaaa-4aaa-8aaa-111111111111", vaultId: vid, revision: v.revision, blob: b64u(randomBytes(200)), deleted: false, purged: false, updated_at: new Date().toISOString() });
    await c.sync();
    const list = await c.removeMembers(vid, [mid]);
    expect(list.map((i) => i.body.title)).toEqual(["Real"]);
    expect(s.rotations).toHaveLength(1);
    expect(s.rotations[0].items.map((i: any) => i.id)).not.toContain("11111111-aaaa-4aaa-8aaa-111111111111");
  });
});

describe("a member of a shared vault, with the server", () => {
  it("can't plant a trust book there, naming themselves a contact", async () => {
    const { s, c } = await fresh();
    const me = (await c.store.getAccount())!;
    const inviter = persona("dana");
    const did = "77777777-7777-4777-8777-777777777777";
    s.userKeys.set(did, inviter.keys);
    const vid = "88888888-8888-4888-8888-888888888888";
    const K = randomBytes(32);
    const wrapped = await sealTo(fromB64u(me.x25519Pub), K, aad(vid, "", `vault_key:${ALICE}`));
    s.vaults.set(vid, { id: vid, kind: "shared", revision: 1, generation: 1, name: await sealField(await aesKey(K), vid, "name", "Shared"), role: "view", wrapped_key: b64u(wrapped), signature: b64u(ed25519Sign(inviter.e, grantInput(vid, ALICE, 1, wrapped))), granted_by: did, member_generation: 1, accepted: true, member_count: 2 });
    (c.api as any).acceptVault = async () => undefined;
    await c.acceptVault(vid);

    const itemId = "99999999-aaaa-4aaa-8aaa-999999999999";
    const planted = newBody("trust", "trust-book", { trustBook: { people: {}, accepted: [], contacts: [did], generations: {} } });
    const blob = await encryptItem(await aesKey(K), vid, itemId, planted);
    s.items.set(itemId, { id: itemId, vaultId: vid, revision: 1, blob: b64u(blob), deleted: false, purged: false, updated_at: new Date().toISOString() });
    await c.sync();
    await c.lock();
    await c.unlock(MASTER);
    s.emergency = [{ id: "e2", grantor_id: ALICE, grantor: "alice", grantee_id: did, grantee: "dana", wait_days: 1, state: "accepted", requested_at: null, opens_at: null, wrapped: {}, opened_vaults: [] }];
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
  });

  it("a forged new key can't lock a vault for good", async () => {
    const { s, c } = await fresh();
    const vid = await c.createSharedVault("Mine");
    await c.saveNew(vid, newBody("login", "Kept", { password: "kept" }));
    await c.sync();
    const v = s.vaults.get(vid);
    const good = { wrapped_key: v.wrapped_key, signature: v.signature, member_generation: v.member_generation, generation: v.generation };
    Object.assign(v, { wrapped_key: b64u(randomBytes(94)), signature: b64u(randomBytes(64)), member_generation: 999, generation: 999 });
    const r = await c.sync();
    expect(r.rollback).toContain(vid);
    expect(c.allItems().map((i) => i.body.password)).toContain("kept");
    Object.assign(v, good);
    await c.sync();
    await c.lock();
    await c.unlock(MASTER);
    expect(c.allItems().map((i) => i.body.password)).toContain("kept");
  });

  it("leaving your own vault off the list doesn't delete it here", async () => {
    const { s, c } = await fresh();
    const vid = await c.personalVaultId();
    await c.saveNew(vid, newBody("login", "Mine", { password: "mine" }));
    await c.sync();
    const row = s.vaults.get(vid);
    s.vaults.delete(vid);
    const r = await c.sync();
    expect(r.rollback).toContain(vid);
    expect(c.allItems().map((i) => i.body.password)).toContain("mine");
    s.vaults.set(vid, row);
  });
});

function api_accept(s: any, c: VaultClient) {
  (c.api as any).acceptVault = async () => undefined;
  void s;
}

// The 2026-11-08 review (F1, F2, F6): a shared vault you made has a grant you signed, and every
// member holds its key. A server that calls it "personal" mustn't make it count as yours.
describe("a member of a shared vault you made, with the server", () => {
  const MALLORY = "55555555-5555-4555-8555-555555555555";
  const CAROL = "33333333-3333-4333-8333-333333333333";

  async function plantedTeam() {
    const f = await fresh();
    const { s, c } = f;
    const realId = await c.personalVaultId();
    await c.saveNew(realId, newBody("login", "Bank", { password: "hunter2-secret" }));
    const vid = await c.createSharedVault("Team");
    const mallory = persona("mallory");
    s.userKeys.set(MALLORY, mallory.keys);
    await c.addMember(vid, MALLORY, "edit");
    await c.sync();
    const K = await vaultKeyVia(mallory, vid, MALLORY, s.members.get(vid).find((m: any) => m.user_id === MALLORY).grant.wrapped_key);
    // Mallory writes a trust book into the vault she's in, naming herself checked and a contact,
    // with a "this is my own vault" statement she signed herself.
    const itemId = "99999999-bbbb-4bbb-8bbb-999999999999";
    const planted = newBody("trust", "trust-book", {
      trustBook: { people: { [MALLORY]: { x25519: mallory.keys.x25519_pub, ed25519: mallory.keys.ed25519_pub, firstSeen: "", verified: true, username: "mallory" } }, accepted: [], contacts: [MALLORY], generations: {} },
      trustState: { contacts: { [MALLORY]: 99 }, made: [], shared: [] },
      homeSig: b64u(ed25519Sign(mallory.e, homeInput(ALICE, vid))),
    });
    const v = s.vaults.get(vid);
    v.revision += 1;
    const plantedBlob = b64u(await encryptItem(await aesKey(K), vid, itemId, planted));
    s.items.set(itemId, { id: itemId, vaultId: vid, revision: v.revision, blob: plantedBlob, deleted: false, purged: false, updated_at: new Date().toISOString() });
    // The server calls it personal, and makes up an accepted emergency row for her.
    v.kind = "personal";
    s.emergency = [{ id: "e9", grantor_id: ALICE, grantor: "alice", grantee_id: MALLORY, grantee: "mallory", wait_days: 1, state: "accepted", requested_at: null, opens_at: null, wrapped: {}, opened_vaults: [] }];
    return { ...f, realId, vid, mallory, K, itemId, plantedBlob };
  }

  it("can't get your vault keys sealed to her by calling it your personal vault", async () => {
    const { s, c, realId, vid, itemId, plantedBlob } = await plantedTeam();
    const r = await c.sync();
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    expect(r.rollback).toContain(vid);
    expect((await c.trustEntries())[MALLORY]?.verified).toBeFalsy();
    expect(await c.personalVaultId()).toBe(realId);
    // And after a lock and unlock, from the offline copy.
    await c.lock();
    await c.unlock(MASTER);
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    expect(await c.personalVaultId()).toBe(realId);
    // Her trust book was never written over with the real one, where she could read it.
    expect(s.items.get(itemId).blob).toBe(plantedBlob);
    expect(c.isOwn(vid)).toBe(false);
  });

  it("can't do it on your other device either, even with the labels swapped", async () => {
    const { s, c, api, secretKey, realId, vid } = await plantedTeam();
    await c.sync();
    // The real one called shared, the shared one called personal.
    s.vaults.get(realId).kind = "shared";
    const c2 = new VaultClient(api, new MemoryStore());
    await c2.unlock(MASTER, secretKey);
    await c2.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    expect(await c2.personalVaultId()).toBe(realId);
    expect(c2.isOwn(vid)).toBe(false);
    expect((await c2.trustEntries())[MALLORY]?.verified).toBeFalsy();
    const saved = await c2.saveNew(await c2.personalVaultId(), newBody("login", "From the phone", { password: "phone-secret" }));
    await c2.sync();
    expect(s.items.get(saved.id)?.vaultId).toBe(realId);
    void c;
  });

  it("a device from before this fix keeps its own vault, and doesn't fall for it", async () => {
    const { s, c, store, realId } = await plantedTeam();
    // As an older version left it: no pinned list, just the vault it saved to.
    await store.deleteMeta("own_vaults");
    await c.lock();
    await c.unlock(MASTER);
    await c.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    expect(await c.personalVaultId()).toBe(realId);
    expect(await store.getMeta("own_vaults")).toEqual([realId]);
  });

  it("can't get another member's logins sealed to your contact by saying you're alone in the vault", async () => {
    const { s, c } = await fresh();
    const carol = persona("carol");
    s.userKeys.set(CAROL, carol.keys);
    const team = await c.createSharedVault("Team");
    const bobId = "22222222-2222-4222-8222-222222222222";
    s.userKeys.set(bobId, persona("bob").keys);
    await c.addMember(team, bobId, "edit");
    const solo = await c.createSharedVault("Just me");
    await c.sync();
    s.vaults.get(team).member_count = 1;
    await c.emergencyInvite(CAROL, 3);
    await c.markVerified(CAROL);
    await c.sync();
    await c.refreshEmergency();
    const sealed = s.wrapped.flatMap((w: any) => w.grants.map((g: any) => g.vault_id));
    expect(sealed).toContain(await c.personalVaultId());
    expect(sealed).toContain(solo);
    expect(sealed).not.toContain(team);
  });

  it("a removed emergency contact stays removed, whatever your other devices remember", async () => {
    const { s, c, api, secretKey } = await fresh();
    s.userKeys.set(CAROL, persona("carol").keys);
    const real = api.request;
    api.request = async (m: string, p: string, b: any) => (m === "DELETE" ? {} : real(m, p, b));
    await c.emergencyInvite(CAROL, 3);
    await c.markVerified(CAROL);
    await c.sync();
    const c2 = new VaultClient(api, new MemoryStore());
    await c2.unlock(MASTER, secretKey);
    const dana = "77777777-7777-4777-8777-777777777777";
    const erin = "88888888-8888-4888-8888-888888888888";
    s.userKeys.set(dana, persona("dana").keys);
    s.userKeys.set(erin, persona("erin").keys);
    await c2.markVerified(dana);
    expect(await c2.store.getMeta("trust_contacts")).toContain(CAROL);
    const row = s.emergency[0];
    await c.emergencyEnd(row);
    s.emergency = [];
    // The other device saves its trust book from its older list, as it would after any change.
    await c2.markVerified(erin);
    await c2.sync();
    await c.sync();
    // The server brings the row back, and both devices are asked to seal.
    s.wrapped.length = 0;
    s.emergency = [{ ...row, state: "accepted", wrapped: {} }];
    await c.refreshEmergency();
    await c2.refreshEmergency();
    expect(s.wrapped).toEqual([]);
    // Naming her again is the person's own act, and works.
    await c2.emergencyInvite(CAROL, 3);
    await c2.sync();
    await c.sync();
    await c.refreshEmergency();
    expect(s.wrapped.length).toBeGreaterThan(0);
  });

  it("a bookmark deleted on one device isn't brought back by another that only moved it, but an edit still wins", async () => {
    const { api, c, secretKey } = await fresh();
    const vid = await c.personalVaultId();
    const moved = await c.saveNew(vid, newBody("bookmark", "Moved", { bookmark: { parent: "root:bar", pos: 1024, url: "https://moved.example/" } }));
    const renamed = await c.saveNew(vid, newBody("bookmark", "Renamed", { bookmark: { parent: "root:bar", pos: 2048, url: "https://renamed.example/" } }));
    const other = await c.saveNew(vid, newBody("bookmark", "Other way", { bookmark: { parent: "root:bar", pos: 3072, url: "https://other.example/" } }));
    await c.sync();
    const c2 = new VaultClient(api, new MemoryStore());
    await c2.unlock(MASTER, secretKey);
    await c2.sync();
    // One device deletes two; the other, not having heard, reorders one and renames the other.
    await c.trashItem(moved.id);
    await c.trashItem(renamed.id);
    await c.sync();
    await c2.update(moved.id, { ...c2.get(moved.id)!.body, bookmark: { parent: "root:other", pos: 512, url: "https://moved.example/" } });
    await c2.update(renamed.id, { ...c2.get(renamed.id)!.body, title: "Renamed here" });
    // And the other way round: the move reaches the server first, then the delete meets it.
    await c2.update(other.id, { ...c2.get(other.id)!.body, bookmark: { parent: "root:bar", pos: 256, url: "https://other.example/" } });
    await c2.sync();
    await c.sync();
    await c.trashItem(other.id).catch(() => undefined);
    await c2.update(other.id, { ...c2.get(other.id)!.body, bookmark: { parent: "root:bar", pos: 128, url: "https://other.example/" } });
    await c2.sync();
    await c.sync();
    await c2.sync();
    await c.sync();
    for (const d of [c, c2]) {
      expect(d.get(moved.id)?.deleted).toBe(true);
      expect(d.get(other.id)?.deleted).toBe(true);
      expect(d.get(renamed.id)?.deleted).toBe(false);
      expect(d.get(renamed.id)?.body.title).toBe("Renamed here");
    }
  });
});
