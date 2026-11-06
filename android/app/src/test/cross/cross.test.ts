// The web client's side of the cross-device test: the real TypeScript vault client on the
// same server as the Kotlin one. Each step reads what the other side wrote to a state file.
// Steps: A sets up and writes every kind; B reads what Android wrote and changes things;
// C checks the merge after a conflict made on both sides. Driven by CrossDeviceTest.kt.
import fs from "node:fs";

import { ApiError, VaultApi } from "../../../../../frontend/src/passwords/core/api";
import { downloadAttachment, uploadAttachment } from "../../../../../frontend/src/passwords/core/attachments";
import { decryptBitwardenExport } from "../../../../../frontend/src/passwords/core/bitwarden";
import { encryptedExport, plainCsvExport, plainJsonExport, readEncryptedExport } from "../../../../../frontend/src/passwords/core/exporter";
import { coarseCounts, runHealth } from "../../../../../frontend/src/passwords/core/health";
import { dedupe, fromBitwardenJson, fromGenericCsv, importFile } from "../../../../../frontend/src/passwords/core/importers";
import { openSend, sendMeta } from "../../../../../frontend/src/passwords/core/send";
import { strengthOf } from "../../../../../frontend/src/passwords/core/strength";
import { b64u, fromB64u, utf8 } from "../../../../../frontend/src/passwords/core/bytes";
import { editDistance, hostOf, lookalikeOf, matchUrl, skeleton } from "../../../../../frontend/src/passwords/core/match";
import { newBody } from "../../../../../frontend/src/passwords/core/model";
import { getAssertion, makeCredential } from "../../../../../frontend/src/passwords/core/passkey";
import { MemoryStore } from "../../../../../frontend/src/passwords/core/store";
import { totpCode } from "../../../../../frontend/src/passwords/core/totp";
import { VaultClient } from "../../../../../frontend/src/passwords/core/vault";

declare const it: (name: string, fn: () => Promise<void>) => void;
declare const expect: (v: unknown) => { toBe(x: unknown): void; toEqual(x: unknown): void; toBeTruthy(): void };

const BASE = process.env.PW_STACK_URL!;
const FILE = process.env.PW_CROSS_FILE!;
const STEP = process.env.PW_CROSS_STEP!;
const MASTER = "correct horse battery staple 7!";

type State = Record<string, any>;
const read = (): State => JSON.parse(fs.readFileSync(FILE, "utf8"));
const write = (s: State) => fs.writeFileSync(FILE, JSON.stringify(s, null, 1));

/** Other suites share this stack and its rate limits: wait those out. */
const patientFetch: typeof fetch = async (input, init) => {
  for (let tries = 0; ; tries++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || tries >= 6) return res;
    const wait = Number(res.headers.get("Retry-After")) || 30;
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
  }
};

function client(token: string) {
  return new VaultClient(new VaultApi(BASE, () => token, patientFetch), new MemoryStore());
}

/** Several suites share this stack, and account creation has a rate limit: wait it out. */
async function setupRetrying(c: VaultClient): Promise<Uint8Array> {
  for (;;) {
    try {
      return (await c.setup(MASTER)).secretKey;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429) throw e;
      await new Promise((r) => setTimeout(r, ((e.retryAfter ?? 30) + 1) * 1000));
    }
  }
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function patternBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let v = seed;
  for (let i = 0; i < n; i++) {
    v = (v * 31 + 7) & 255;
    out[i] = v;
  }
  return out;
}

const asFile = (name: string, bytes: Uint8Array, type?: string) => ({
  name,
  type,
  size: bytes.length,
  slice: (a: number, b: number) => new Blob([bytes.subarray(a, b) as Uint8Array<ArrayBuffer>]),
});

async function verifyEs256(spki: Uint8Array, signed: Uint8Array, derSig: Uint8Array): Promise<boolean> {
  // DER back to r||s for WebCrypto.
  const part = (b: Uint8Array, at: number): [Uint8Array, number] => {
    const n = b[at + 1];
    const v = b.subarray(at + 2, at + 2 + n);
    return [v[0] === 0 ? v.subarray(1) : v, at + 2 + n];
  };
  const [r, next] = part(derSig, 2);
  const [s] = part(derSig, next);
  const rs = new Uint8Array(64);
  rs.set(r, 32 - r.length);
  rs.set(s, 64 - s.length);
  const key = await crypto.subtle.importKey("spki", spki as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rs as Uint8Array<ArrayBuffer>, signed as Uint8Array<ArrayBuffer>);
}

async function expectRejects(f: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await f();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

it(`step ${STEP}`, async () => {
  const state = read();
  if (STEP === "A") {
    const c = client(state.token);
    const secretKey = await setupRetrying(c);
    const vault = await c.personalVaultId();
    const made = await makeCredential({
      rpId: "cross.example",
      rpName: "Cross",
      userHandle: b64u(utf8("ts-user")),
      userName: "ts@cross.example",
      challenge: b64u(utf8("reg")),
      origin: "https://cross.example",
      crossOrigin: false,
      uv: true,
      discoverable: true,
    });
    const bodies = {
      login: newBody("login", "TS login", {
        username: "ana",
        password: "ts-Pässword-🔑",
        urls: [{ url: "https://ts.example/login" }, { url: "https://other.example", match: "host" }],
        totp: { secret: "JBSWY3DPEHPK3PXP", period: 30, digits: 6, algorithm: "SHA1", issuer: "TS" },
        fields: [{ name: "pin", value: "1234", type: "hidden" }],
        tags: ["work", "tag two"],
        favorite: true,
        notes: "multi\nline\nnote",
        fromTheFuture: { nested: [1, 2.5, "x", null, { a: true }] },
      }),
      note: newBody("note", "TS note", { notes: "secure note text" }),
      card: newBody("card", "TS card", { cardholder: "Ana", cardNumber: "4111111111111111", cardBrand: "Visa", cardExpMonth: "07", cardExpYear: "2031", cardCvv: "123" }),
      identity: newBody("identity", "TS identity", { firstName: "Ana", lastName: "Silva", email: "ana@ts.example", phone: "+61", address1: "1 Road", city: "Perth", state: "WA", postcode: "6000", country: "AU" }),
      totp: newBody("totp", "TS 2FA", { username: "ana", totp: { secret: "GEZDGNBVGY3TQOJQ", issuer: "TS" } }),
      passkey: newBody("passkey", "Cross", { username: "ts@cross.example", urls: [{ url: "https://cross.example" }], passkeys: [made.passkey] }),
      apikey: newBody("apikey", "TS key", { apiKey: "key-123", apiSecret: "secret-456" }),
      wifi: newBody("wifi", "TS wifi", { ssid: "HomeNet", wifiPassword: "wifi-pass", wifiSecurity: "WPA" }),
      ssh: newBody("ssh", "TS ssh", { sshPublic: "ssh-ed25519 AAA", sshPrivate: "-----BEGIN-----", sshFingerprint: "SHA256:x" }),
      bank: newBody("bank", "TS bank", { bankName: "Bank", accountName: "Ana", accountNumber: "111", routingNumber: "222", iban: "AU00", swift: "ABC" }),
      document: newBody("document", "TS document", { documentType: "Passport", documentNumber: "P123", expiresOn: "2031-01-01" }),
    };
    const ids: Record<string, string> = {};
    const saved: Record<string, unknown> = {};
    for (const [k, body] of Object.entries(bodies)) {
      const item = await c.saveNew(vault, body);
      ids[k] = item.id;
      saved[k] = item.body;
    }
    const conflict = await c.saveNew(vault, newBody("login", "Conflict me", { username: "c", password: "base-password", notes: "base" }));
    const r = await c.sync();
    expect(r.pushed).toBe(12);
    write({
      ...state,
      secretKey: b64u(secretKey),
      ids,
      saved,
      conflictId: conflict.id,
      totpAt: { time: 1_700_000_000_000, code: await totpCode({ secret: "JBSWY3DPEHPK3PXP", period: 30, digits: 6, algorithm: "SHA1" }, 1_700_000_000_000) },
      tsPublicKey: made.publicKey,
      tsCredentialId: made.credentialId,
    });
    return;
  }

  // ---- Steps that manage their own clients ----

  if (STEP === "att1") {
    const c = client(state.token);
    const secretKey = await setupRetrying(c);
    const vault = await c.personalVaultId();
    const item = await c.saveNew(vault, newBody("note", "With files", { notes: "n" }));
    await c.sync();
    const big = patternBytes(2_500_000, 11);
    const small = patternBytes(1234, 22);
    const r1 = await uploadAttachment(c.api, vault, item.id, asFile("big.bin", big, "application/octet-stream"));
    const r2 = await uploadAttachment(c.api, vault, item.id, asFile("small.txt", small, "text/plain"));
    await c.update(item.id, { ...c.get(item.id)!.body, attachments: [r1, r2] });
    await c.sync();
    write({ ...state, secretKey: b64u(secretKey), vault, itemId: item.id, bigSha: await sha256Hex(big), smallSha: await sha256Hex(small) });
    return;
  }
  if (STEP === "att2") {
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    const item = c.get(state.itemId)!;
    const list = item.body.attachments ?? [];
    expect(list.map((a) => a.name).sort()).toEqual(["big.bin", "from-android.bin"]);
    const fromAndroid = list.find((a) => a.name === "from-android.bin")!;
    expect(fromAndroid.mime).toBe("application/x-test");
    expect(fromAndroid.size).toBe(state.androidSize);
    const got = await downloadAttachment(c.api, state.vault, item.id, fromAndroid);
    expect(await sha256Hex(got)).toBe(state.androidSha);
    // What Android deleted is gone from the server too.
    let gone = false;
    try {
      await c.api.attachmentGet(state.vault, state.deletedId, 0);
    } catch (e) {
      gone = e instanceof ApiError && e.status === 404;
    }
    expect(gone).toBe(true);
    return;
  }

  if (STEP === "sh1") {
    const c = client(state.alice);
    const secretKey = await setupRetrying(c);
    const vault = await c.createSharedVault("TS shared");
    await c.saveNew(vault, newBody("login", "Shared login", { username: "both", password: "shared-Pass-1!", urls: [{ url: "https://shared.example" }] }));
    await c.sync();
    await c.addMember(vault, state.bobId, "edit");
    write({ ...state, aliceKey: b64u(secretKey), aliceId: c.userId, tsVault: vault, aliceWords: await c.myIdentityWords() });
    return;
  }
  if (STEP === "sh2") {
    const c = client(state.alice);
    await c.unlock(MASTER, fromB64u(state.aliceKey));
    // Android's edit and Android's new item, in a vault TS made.
    const items = c.allItems().filter((i) => i.vaultId === state.tsVault);
    expect(items.find((i) => i.body.title === "Shared login")!.body.password).toBe("edited-by-android");
    expect(items.find((i) => i.body.title === "Added by Android")!.body.username).toBe("kt");
    // A vault Android made, invited as fill only. Its name opens here, and so do its items.
    const vaults = await c.vaults();
    const kt = vaults.find((v) => v.id === state.ktVault)!;
    // Nobody's trusted until the person says so: no name yet.
    expect(kt.displayName).toBe("(can't open)");
    expect(kt.accepted).toBe(false);
    expect(kt.role).toBe("fill");
    await c.acceptVault(state.ktVault);
    expect((await c.vaults()).find((v) => v.id === state.ktVault)!.displayName).toBe("KT shared");
    const inKt = c.allItems().find((i) => i.vaultId === state.ktVault)!;
    expect(inKt.body.password).toBe("kt-Vault-1!");
    expect(c.canReveal(state.ktVault)).toBe(false);
    expect(c.exportable().some((i) => i.vaultId === state.ktVault)).toBe(false);
    const bobWords = await c.identityWordsFor(state.bobId);
    // Remove Android's user: a new vault key, and the list of passwords to change.
    const toChange = await c.removeMembers(state.tsVault, [state.bobId]);
    expect(toChange.map((i) => i.body.title).sort()).toEqual(["Added by Android", "Shared login"]);
    write({ ...read(), bobWordsSeenByAlice: bobWords });
    return;
  }
  if (STEP === "sh3") {
    const c = client(state.alice);
    await c.unlock(MASTER, fromB64u(state.aliceKey));
    // Android removed Alice from its vault, with rotation.
    expect((await c.vaults()).some((v) => v.id === state.ktVault)).toBe(false);
    expect(c.allItems().some((i) => i.vaultId === state.ktVault)).toBe(false);
    return;
  }

  // What Android wrote for folders, icons, Sends and a merge, in the shapes the web vault reads.
  if (STEP === "fin") {
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    const all = c.allItems({ includeSystem: true });
    const kept = c.get(state.keptFolder)!;
    expect(kept.body.kind).toBe("folder");
    expect(kept.body.title).toBe("After");
    expect(all.filter((i) => i.body.kind === "folder").map((i) => i.id)).toEqual([state.keptFolder]);
    expect(c.get(state.inside)!.body.folderId ?? null).toBe(null);
    expect(c.get(state.inside)!.body.tags).toEqual(["work"]);
    expect(c.get(state.staying)!.body.folderId).toBe(state.keptFolder);
    const prefs = all.filter((i) => i.body.kind === "prefs" && i.body.title === "vault-prefs");
    expect(prefs.length).toBe(1);
    expect(prefs[0].vaultId).toBe(state.vault);
    expect(prefs[0].body.icon).toBe(true);
    const send = all.filter((i) => i.body.kind === "send");
    expect(send.length).toBe(1);
    expect(send[0].body.title).toBe("Named");
    expect(send[0].body.notes).toBe(state.sendLink);
    expect(send[0].body.sendId).toBe(state.sendId);
    const merged = c.get(state.newer)!;
    expect(merged.body.password).toBe("pw-newer");
    expect((merged.body.passwordHistory ?? []).map((h) => h.password)).toEqual(["pw-older"]);
    expect(c.allItems({ includeDeleted: true }).find((i) => i.id === state.older)!.deleted).toBe(true);
    const moved = merged.body.attachments!.find((a) => a.name === "moved.bin")!;
    expect(await sha256Hex(await downloadAttachment(c.api, state.vault, merged.id, moved))).toBe(state.movedSha);
    return;
  }

  // One list of which address matches which page, read by both clients.
  if (STEP === "match") {
    const v = JSON.parse(fs.readFileSync(new URL("./match-vectors.json", import.meta.url), "utf8")) as { match: any[]; host: any[]; lookalike: any[]; lookalikeVault: string[]; editDistance: any[]; skeleton: any[] };
    const wrong: string[] = [];
    for (const c of v.match) {
      const got = matchUrl({ url: c.url, match: c.mode }, c.page);
      if (got !== c.want) wrong.push(`${c.url} (${c.mode ?? "base"}) on ${c.page}: ${got}, wanted ${c.want}`);
    }
    for (const c of v.host) {
      const got = hostOf(c.url);
      if (got !== c.want) wrong.push(`hostOf ${c.url}: ${got}, wanted ${c.want}`);
    }
    for (const c of v.lookalike) {
      const got = lookalikeOf(c.page, c.saved ?? v.lookalikeVault);
      if (got !== c.want) wrong.push(`lookalikeOf ${c.page}: ${got}, wanted ${c.want}`);
    }
    for (const c of v.editDistance) {
      const got = editDistance(c.a, c.b);
      if (got !== c.want) wrong.push(`editDistance ${c.a}, ${c.b}: ${got}, wanted ${c.want}`);
    }
    for (const c of v.skeleton) {
      if (skeleton(c.a) !== skeleton(c.b)) wrong.push(`skeleton ${c.a}: ${skeleton(c.a)}, ${c.b}: ${skeleton(c.b)}`);
    }
    expect(wrong).toEqual([]);
    return;
  }

  // The trust book and seq, between the two clients on one account.
  if (STEP === "bk1") {
    const c = client(state.alice);
    const secretKey = await setupRetrying(c);
    const bob = client(state.bob);
    await setupRetrying(bob);
    const carol = client(state.carol);
    await setupRetrying(carol);
    const vault = await c.createSharedVault("TS team");
    await c.addMember(vault, state.bobId, "edit");
    await c.markVerified(state.bobId);
    // An invitation from Carol, accepted here. Android shouldn't have to ask again.
    const fromCarol = await carol.createSharedVault("From Carol");
    await carol.addMember(fromCarol, c.userId!, "view");
    await c.sync();
    await c.acceptVault(fromCarol);
    const item = await c.saveNew(await c.personalVaultId(), newBody("login", "Seq item", { password: "seq-1" }));
    await c.update(item.id, { ...c.get(item.id)!.body, password: "seq-2" });
    await c.sync();
    write({ ...state, aliceKey: b64u(secretKey), aliceId: c.userId, carolId: carol.userId, tsVault: vault, fromCarol, seqItem: item.id });
    return;
  }
  if (STEP === "bk2") {
    const c = client(state.alice);
    await c.unlock(MASTER, fromB64u(state.aliceKey));
    // What Android decided, with no prompt here.
    const trust = await c.trustEntries();
    expect(trust[state.danId]?.ed25519).toBe(state.danEd);
    expect(trust[state.bobId]?.verified).toBe(true);
    const ktVault = (await c.vaults()).find((v) => v.id === state.ktVault)!;
    expect(ktVault.displayName).toBe("KT team");
    const body = c.get(state.seqItem)!.body;
    expect(body.password).toBe("seq-android");
    expect(body.seq).toBe(state.androidSeq);
    const edited = await c.update(state.seqItem, { ...body, notes: "from ts" });
    expect(edited.body.seq).toBe(state.androidSeq + 1);
    await c.sync();
    return;
  }

  if (STEP === "tx1") {
    const c = client(state.token);
    const secretKey = await setupRetrying(c);
    const vault = await c.personalVaultId();
    await c.saveNew(vault, newBody("login", "Weak one", { username: "w", password: "password", urls: [{ url: "http://insecure.example/login" }] }));
    await c.saveNew(vault, newBody("login", "Reused A", { username: "a", password: "kX9!vQ2#mL7$pR4z", urls: [{ url: "https://a.example" }] }));
    await c.saveNew(vault, newBody("login", "Reused B", { username: "b", password: "kX9!vQ2#mL7$pR4z", urls: [{ url: "https://b.example" }], totp: { secret: "JBSWY3DPEHPK3PXP" } }));
    await c.saveNew(vault, newBody("note", "A note", { notes: "formula =1+1, \"quoted\"" }));
    await c.sync();
    const items = c.exportable();
    const health = await runHealth(c.allItems());
    const scores: Record<string, number> = {};
    for (const pw of state.strengthList as string[]) scores[pw] = (await strengthOf(pw)).score;
    const csvCases: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(state.csvFixtures as Record<string, string>)) {
      const r = await importFile(name, utf8(text));
      csvCases[name] = { format: r.format, warnings: r.warnings, items: r.items.map((i) => ({ folder: i.folder ?? null, body: i.body })) };
    }
    const bw = fromBitwardenJson(JSON.parse(state.bitwardenFixture));
    const opened = fromBitwardenJson(await decryptBitwardenExport(JSON.parse(state.bitwardenProtected), "bw-file-password"));
    const dup = dedupe(fromGenericCsv(state.dedupeFixture).items, []);
    write({
      ...state,
      secretKey: b64u(secretKey),
      health: { checked: health.checked, reused: health.reused.reduce((n, g) => n + g.items.length, 0), http: health.http.length, old: health.old.length, weak: health.weak.length, coarse: coarseCounts(health) },
      scores,
      csvCases,
      bw: { warnings: bw.warnings, items: bw.items.map((i) => ({ folder: i.folder ?? null, body: i.body })) },
      bwOpened: opened.items.map((i) => i.body.title),
      dupFresh: dup.fresh.length,
      dupCount: dup.duplicates,
      plainCsv: plainCsvExport(items),
      plainJsonItems: JSON.parse(plainJsonExport(items)).items.length,
      tsEncrypted: await encryptedExport(items, "ts-export-password"),
    });
    return;
  }
  if (STEP === "tx2") {
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    // Android's encrypted export opens here.
    const r = await readEncryptedExport(JSON.parse(state.ktEncrypted), "kt-export-password");
    expect(r.items.map((i) => i.body.title).sort()).toEqual(["A note", "Reused A", "Reused B", "Weak one"]);
    expect(r.items.find((i) => i.body.title === "Weak one")!.body.password).toBe("password");
    await expectRejects(() => readEncryptedExport(JSON.parse(state.ktEncrypted), "wrong"));
    // Android's Sends open here, with and without a password.
    const open = async (link: string, password?: string) => {
      const u = new URL(link);
      const id = u.pathname.split("/").pop()!;
      const anon = new VaultApi(BASE, () => null);
      return openSend(anon, id, u.hash.slice(1), await sendMeta(anon, id), password);
    };
    const plain = await open(state.ktSend);
    expect(plain.payload).toEqual({ kind: "text", title: "From Android", text: "send text \u{1F511}" });
    const protectedOne = await open(state.ktSendPw, "send-password");
    expect(protectedOne.payload).toEqual({ kind: "text", title: "With a password", text: "secret text" });
    expect(protectedOne.viewsLeft).toBe(1);
    await expectRejects(() => open(state.ktSendPw, "wrong-password"));
    const file = await open(state.ktSendFile);
    expect(file.payload.kind).toBe("file");
    if (file.payload.kind === "file") {
      expect(file.payload.name).toBe("note.txt");
      expect(atob(file.payload.data)).toBe("file body");
    }
    return;
  }

  if (STEP === "qr1") {
    // A joining device on the web client, for Android's scanner to check.
    const c = client(state.token);
    const secretKey = await setupRetrying(c);
    const other = client(state.token);
    const join = await other.requestDevice("TS phone");
    write({ ...state, secretKey: b64u(secretKey), qrText: join.qrText, requestId: join.id, joinPub: join.qrText.split(":")[2] });
    return;
  }
  if (STEP === "qr2") {
    // A joining device on Android: the web scanner's own regex accepts its text.
    const m = /^pwdev:([0-9a-f-]{36}):([A-Za-z0-9_-]+)$/.exec(state.androidQr);
    expect(m).toBeTruthy();
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    const found = (await c.api.deviceRequests()).find((r) => r.id === m![1])!;
    expect(found.device_pub).toBe(m![2]);
    const approval = await c.beginApproval(found.id, found.device_pub);
    expect(approval.words).toEqual(state.androidWordsCheck ?? approval.words);
    await c.finishApproval(found.id, found.device_pub);
    write({ ...read(), tsApprovalWords: approval.words });
    return;
  }

  if (STEP === "rot1") {
    // The web client rotates the Secret Key; Android has to notice it's been rotated out.
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    const fresh = await c.rotateSecretKey(MASTER);
    write({ ...read(), rotatedKey: b64u(fresh) });
    return;
  }
  if (STEP === "rot2") {
    // Android rotated it: the web client opens with Android's new key, and not the old one.
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.ktRotated));
    expect(c.unlocked).toBe(true);
    const old = client(state.token);
    await expectRejects(() => old.unlock(MASTER, fromB64u(state.rotatedKey)));
    return;
  }
  if (STEP === "kdf") {
    // A vault Android made at a raised setting opens here.
    const c = client(state.token);
    await c.unlock(MASTER, fromB64u(state.secretKey));
    expect((await c.store.getAccount())!.kdf.m).toBe(state.expectM);
    expect(c.get(state.itemId)!.body.title).toBe("Raised");
    return;
  }

  const c = client(state.token);
  await c.unlock(MASTER, fromB64u(state.secretKey));

  if (STEP === "B") {
    // Android's edit of a TS item, with TS's unknown field intact.
    const login = c.get(state.ids.login)!;
    expect(login.body.password).toBe("android-new-password");
    expect(login.body.passwordHistory![0].password).toBe("ts-Pässword-🔑");
    expect(login.body.fromTheFuture).toEqual({ nested: [1, 2.5, "x", null, { a: true }] });
    expect(login.body.title).toBe("TS login");
    expect((await c.versions(login.id))[0].body.password).toBe("ts-Pässword-🔑");

    // Android's own items of every kind.
    for (const [k, id] of Object.entries(state.androidIds as Record<string, string>)) {
      const got = c.get(id)!;
      expect(got.body.kind).toBe(k);
      expect(JSON.parse(JSON.stringify(got.body))).toEqual(state.androidSaved[k]);
    }
    expect(c.get(state.androidIds.login)!.body.androidFuture).toEqual({ k: [true, null] });
    expect(c.search("android login").map((i) => i.id)).toEqual([state.androidIds.login]);

    // Android's passkey signs here, and Android's assertion verifies here.
    const pk = c.get(state.androidIds.passkey)!.body.passkeys![0];
    const a = await getAssertion({ passkey: pk, challenge: b64u(utf8("from-ts")), origin: "https://android.example", crossOrigin: false, uv: true });
    const signed = concat(fromB64u(a.authenticatorData), new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64u(a.clientDataJSON) as Uint8Array<ArrayBuffer>)));
    expect(await verifyEs256(fromB64u(state.androidPublicKey), signed, fromB64u(a.signature))).toBe(true);
    const k = state.androidAssertion;
    const signedK = concat(fromB64u(k.authenticatorData), new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64u(k.clientDataJSON) as Uint8Array<ArrayBuffer>)));
    expect(await verifyEs256(fromB64u(state.androidPublicKey), signedK, fromB64u(k.signature))).toBe(true);

    // Android's trash and purge reached here.
    expect(c.get(state.androidTrashed)!.deleted).toBe(true);
    expect(c.get(state.androidPurged)).toBe(undefined);

    // A change made here while Android is offline with its own change to the same item.
    const conflict = c.get(state.conflictId)!;
    await c.update(conflict.id, { ...conflict.body, password: "ts-password", title: "Conflict renamed by TS" });
    await c.sync();
    return;
  }

  if (STEP === "C") {
    const merged = c.get(state.conflictId)!;
    // Both changed the password: the server's stands, and Android's is kept whole.
    expect(merged.body.password).toBe("ts-password");
    expect(merged.body.title).toBe("Conflict renamed by TS"); // only TS changed it
    expect(merged.body.notes).toBe("android-note"); // only Android changed it
    expect(merged.body.conflicts!.length).toBe(1);
    expect(merged.body.conflicts![0].body.password).toBe("android-password");
    // Two changes to different fields: no conflict recorded.
    const clean = c.get(state.cleanMergeId)!;
    expect(clean.body.username).toBe("ts-user-2");
    expect(clean.body.notes).toBe("android-only");
    expect(clean.body.conflicts).toBe(undefined);
    return;
  }

  throw new Error(`Unknown step ${STEP}`);
});

