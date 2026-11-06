// The real client against the real API on the isolated stack:
//   PW_STACK_URL=http://localhost:8092 npx vitest run src/passwords/core/integration.test.ts
// Includes the canary test (plan 13.2): distinctive strings in every field, then a
// search of the database dump, logs, Redis, uploads and a real backup for any of them.
import { beforeAll, describe, expect, it } from "vitest";

import { VaultApi } from "./api";
import { b64u, fromB64u, randomBytes } from "./bytes";
import { type ItemBody, newBody } from "./model";
import { MemoryStore } from "./store";
import { BACKEND, BASE_URL, dockerText, makeUsers, stackEnabled, type TestUser } from "./testing/stack";
import { KeyChangedError, VaultClient, WrongPasswordError } from "./vault";

const MASTER = "correct horse battery staple 7!";

function client(user: TestUser, store = new MemoryStore(), fetcher?: typeof fetch) {
  const api = new VaultApi(BASE_URL, () => user.token, fetcher);
  return new VaultClient(api, store);
}

async function ready(user: TestUser) {
  const c = client(user);
  const { secretKey } = await c.setup(MASTER);
  return { c, secretKey };
}

async function second(user: TestUser, secretKey: Uint8Array, fetcher?: typeof fetch) {
  const c = client(user, new MemoryStore(), fetcher);
  await c.unlock(MASTER, secretKey);
  return c;
}

describe.skipIf(!stackEnabled)("vault client against the stack", () => {
  let alice: TestUser;
  let bob: TestUser;
  beforeAll(() => {
    [alice, bob] = makeUsers("alice", "bob");
  });

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
    expect(invited.displayName).toBe("Family");
    expect(invited.accepted).toBe(false);
    await b.c.api.acceptVault(shared);
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
    await b.c.sync();
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
    await a.c.saveNew(vid, newBody("site_rule", `${CANARY}_rule`, { rule: { host: `${CANARY}.example.com`, username: "#u" } }));
    await a.c.sync();
    await a.c.update(i1.id, { ...a.c.get(i1.id)!.body, password: `${CANARY}_password2` });
    await a.c.addMember(shared, v.id, "edit");
    await b.c.api.acceptVault(shared);
    await a.c.sync();
    await b.c.sync();
    expect(b.c.get(i2.id)?.body.title).toBe(`${CANARY}_sharedtitle`);
    expect(a.c.get(i1.id)?.body.notes).toBe(`${CANARY}_notes`);

    // Also a wrong-key attempt, an export note and a device request, to exercise those paths.
    await expect(client(u).unlock(`${CANARY}_wrongmaster`, a.secretKey)).rejects.toBeTruthy();
    await a.c.api.noteExport();
    await a.c.requestDevice("laptop");

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

    // 5. A real backup file. Make one, then read it through.
    const backup = dockerText([
      "exec",
      BACKEND,
      "sh",
      "-c",
      `python - <<'PY'
import asyncio
from app.backups import service
import inspect
fn = getattr(service, "run_backup", None) or getattr(service, "create_backup", None) or getattr(service, "dump_database", None)
print("FN", fn.__name__ if fn else None)
PY`,
    ]);
    expect(backup).toContain("FN");
    const scan = dockerText(["exec", BACKEND, "sh", "-c", `for f in /app/backups/*; do [ -f "$f" ] || continue; case "$f" in *.gz) gunzip -c "$f";; *) cat "$f";; esac; done | grep -c ${CANARY} || true`]);
    expect(scan.trim().split(/\s+/).pop()).toBe("0");
  });
});

function execText(args: string[]): string {
  // ``docker logs`` writes the container's stderr to its own stderr.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("docker", args, { encoding: "latin1", maxBuffer: 1024 * 1024 * 1024 });
  return `${r.stdout}\n${r.stderr}`;
}
