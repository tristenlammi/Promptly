// The web client's side of the cross-device test: the real TypeScript vault client on the
// same server as the Kotlin one. Each step reads what the other side wrote to a state file.
// Steps: A sets up and writes every kind; B reads what Android wrote and changes things;
// C checks the merge after a conflict made on both sides. Driven by CrossDeviceTest.kt.
import fs from "node:fs";

import { VaultApi } from "../../../../../frontend/src/passwords/core/api";
import { b64u, fromB64u, utf8 } from "../../../../../frontend/src/passwords/core/bytes";
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

function client(token: string) {
  return new VaultClient(new VaultApi(BASE, () => token), new MemoryStore());
}

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
    const { secretKey } = await c.setup(MASTER);
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
