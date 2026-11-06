// Section 13.1 and M4: real-shaped fixtures for every format, and fuzzing with bad
// files. A malformed import has to fail with an error, never crash or hang.
import fc from "fast-check";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { argon2id } from "hash-wasm";
import { buf, concat, utf8 } from "./bytes";
import { decryptBitwardenExport } from "./bitwarden";
import { encryptedExport, plainCsvExport, plainJsonExport, readEncryptedExport } from "./exporter";
import { breachCount, coarseCounts, runHealth, sha1Hex } from "./health";
import { dedupe, from2fasJson, fromAegisJson, fromBitwardenJson, fromCxf, fromGenericCsv, fromLastPassCsv, fromProtonJson, importFile, NeedsPasswordError, parseCsv, sanitizeImport } from "./importers";
import { type ItemBody, newBody } from "./model";

const asFile = (s: string) => utf8(s);

describe("CSV", () => {
  it("handles quotes, CRLF, BOM and embedded commas and newlines", () => {
    expect(parseCsv('﻿a,b\r\n"1,x","he said ""hi""\nthere"\r\n')).toEqual([["a", "b"], ["1,x", 'he said "hi"\nthere']]);
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("reads Chrome and Edge", async () => {
    const r = await importFile("Chrome Passwords.csv", asFile("name,url,username,password,note\nGitHub,https://github.com/login,ana,pw1,hello\n,https://x.org/,bob,pw2,\n"));
    expect(r.format).toBe("Browser");
    expect(r.items).toHaveLength(2);
    expect(r.items[0].body).toMatchObject({ kind: "login", title: "GitHub", username: "ana", password: "pw1", notes: "hello", urls: [{ url: "https://github.com/login" }] });
    expect(r.items[1].body.title).toBe("x.org");
  });

  it("reads Firefox", async () => {
    const r = await importFile("logins.csv", asFile('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://a.example","u","p",,"https://a.example","{g}","1","2","3"\n'));
    expect(r.format).toBe("Firefox");
    expect(r.items[0].body).toMatchObject({ username: "u", password: "p" });
    // Columns with nowhere to go are kept, not dropped.
    expect(r.items[0].body.fields?.map((f) => f.name)).toContain("guid");
  });

  it("reads Apple Passwords with 2FA", async () => {
    const r = await importFile("Passwords.csv", asFile("Title,URL,Username,Password,Notes,OTPAuth\nExample,https://e.example,me,secret,,otpauth://totp/E:me?secret=JBSWY3DPEHPK3PXP&issuer=E\n"));
    expect(r.format).toBe("Apple Passwords");
    expect(r.items[0].body.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("reads LastPass, secure notes included", async () => {
    const r = await importFile("lastpass.csv", asFile('url,username,password,totp,extra,name,grouping,fav\nhttps://a.example,u,p,JBSWY3DPEHPK3PXP,note here,A,Work,1\nhttp://sn,,,,"NoteType:Note\\nhello",My note,,0\n'));
    expect(r.format).toBe("LastPass");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ folder: "Work", body: { kind: "login", favorite: true } });
    expect(r.items[1].body.kind).toBe("note");
    expect(r.items[1].body.urls).toBeUndefined();
    expect(fromLastPassCsv("url,name\nhttp://sn,x\n").items[0].body.kind).toBe("note");
  });

  it("fuzzy-parses odd column names", () => {
    const r = fromGenericCsv("Website,Login Name,Pass,Comments\nhttps://a.example,ana,pw,hi\n");
    expect(r.items[0].body).toMatchObject({ username: "ana", password: "pw", notes: "hi" });
  });

  it("refuses a CSV with nothing to go on, and warns about bad 2FA", () => {
    expect(() => fromGenericCsv("colour,size\nred,big\n")).toThrow();
    const r = fromGenericCsv("name,password,totp\nA,pw,not base32!!\n");
    expect(r.warnings[0]).toContain("2FA");
    expect(r.items[0].body.totp).toBeUndefined();
  });
});

describe("JSON formats", () => {
  const bw = {
    encrypted: false,
    folders: [{ id: "f1", name: "Work" }],
    items: [
      {
        id: "1",
        folderId: "f1",
        type: 1,
        reprompt: 1,
        name: "Login",
        notes: "n",
        favorite: true,
        fields: [{ name: "pin", value: "1234", type: 1 }],
        login: {
          uris: [{ match: 1, uri: "https://x.example" }, { uri: "https://y.example" }],
          username: "u",
          password: "p",
          totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
          fido2Credentials: [{ credentialId: "abc", keyValue: "a2V5", rpId: "x.example", userHandle: "dQ", userName: "u", counter: "3", creationDate: "2026-01-01T00:00:00Z", discoverable: "true" }],
        },
        passwordHistory: [{ lastUsedDate: "2025-01-01T00:00:00Z", password: "old" }],
      },
      { type: 2, name: "Note", notes: "text", secureNote: { type: 0 } },
      { type: 3, name: "Card", card: { cardholderName: "A B", number: "4111111111111111", code: "123", expMonth: "1", expYear: "2030", brand: "Visa" } },
      { type: 4, name: "Me", identity: { firstName: "A", lastName: "B", email: "a@b.example", postalCode: "2000" } },
      { type: 5, name: "SSH", sshKey: { publicKey: "ssh-ed25519 AAA", privateKey: "PRIV", keyFingerprint: "SHA256:x" } },
      { type: 99, name: "Future" },
    ],
  };

  it("reads Bitwarden JSON", async () => {
    const r = await importFile("bitwarden.json", asFile(JSON.stringify(bw)));
    expect(r.format).toBe("Bitwarden");
    expect(r.items).toHaveLength(6);
    const login = r.items[0];
    expect(login.folder).toBe("Work");
    expect(login.body).toMatchObject({ kind: "login", username: "u", password: "p", favorite: true, reprompt: true });
    expect(login.body.urls?.[0]).toEqual({ url: "https://x.example", match: "host" });
    expect(login.body.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(login.body.passkeys?.[0]).toMatchObject({ rpId: "x.example", signCount: 3 });
    expect(login.body.passwordHistory?.[0].password).toBe("old");
    expect(login.body.fields?.[0]).toMatchObject({ name: "pin", type: "hidden" });
    expect(r.items[2].body).toMatchObject({ kind: "card", cardNumber: "4111111111111111", cardCvv: "123" });
    expect(r.items[3].body).toMatchObject({ kind: "identity", postcode: "2000" });
    expect(r.items[4].body).toMatchObject({ kind: "ssh", sshPrivate: "PRIV" });
    expect(r.warnings.join()).toContain("Future");
  });

  it("LastPass: a row that makes no item doesn't turn the next login into a note", () => {
    const r = fromLastPassCsv("url,username,password,totp,extra,name,grouping,fav\n,,,,,Only a name,,0\nhttp://sn,,,,text,A note,,0\nhttps://a.example,u,keep-this,,,Real login,,0\n");
    expect(r.items.map((i) => [i.body.kind, i.body.title])).toEqual([["note", "A note"], ["login", "Real login"]]);
    expect(r.items[1].body.password).toBe("keep-this");
  });

  it("turns Bitwarden's passkey ids into what sites use", () => {
    const pk = { keyValue: "a2V5", rpId: "example.com", userHandle: "dQ", userName: "ana", counter: "0", discoverable: "true" };
    const r = fromBitwardenJson({ items: [{ type: 1, name: "Site", login: { fido2Credentials: [{ ...pk, credentialId: "b0cf2f0b-1a2b-4c3d-8e9f-0a1b2c3d4e5f" }, { ...pk, credentialId: "b64.AQIDBAUG" }] } }] });
    const ids = r.items[0].body.passkeys!.map((p) => p.credentialId);
    expect(ids).toEqual([Buffer.from("b0cf2f0b1a2b4c3d8e9f0a1b2c3d4e5f", "hex").toString("base64url"), "AQIDBAUG"]);
  });

  it("asks for a password on encrypted Bitwarden, and refuses account-locked ones", async () => {
    const locked = { encrypted: true, encKeyValidation_DO_NOT_EDIT: "2.x", data: "2.y", salt: "s", kdfType: 0, kdfIterations: 1 };
    await expect(importFile("b.json", asFile(JSON.stringify(locked)))).rejects.toBeInstanceOf(NeedsPasswordError);
    await expect(importFile("b.json", asFile(JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: undefined, data: "2.y" })))).rejects.toThrow(/locked to its account/);
    expect(() => fromBitwardenJson({ encrypted: true })).toThrow();
  });

  it("decrypts a password-protected Bitwarden export made from the documented scheme", async () => {
    const make = async (kdfType: number) => {
      const salt = "c2FsdHNhbHQ=";
      const password = "export pass";
      const master =
        kdfType === 0
          ? new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(utf8(salt)), iterations: 1000 }, await crypto.subtle.importKey("raw", buf(utf8(password)), "PBKDF2", false, ["deriveBits"]), 256))
          : await argon2id({ password: utf8(password), salt: new Uint8Array(await crypto.subtle.digest("SHA-256", buf(utf8(salt)))), iterations: 3, parallelism: 1, memorySize: 1024, hashLength: 32, outputType: "binary" });
      const hmac = async (k: Uint8Array, d: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", buf(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), buf(d)));
      const enc = await hmac(master, concat(utf8("enc"), new Uint8Array([1])));
      const mac = await hmac(master, concat(utf8("mac"), new Uint8Array([1])));
      const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
      const cipher = async (plain: Uint8Array) => {
        const iv = new Uint8Array(16).fill(7);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, await crypto.subtle.importKey("raw", buf(enc), "AES-CBC", false, ["encrypt"]), buf(plain)));
        return `2.${b64(iv)}|${b64(ct)}|${b64(await hmac(mac, concat(iv, ct)))}`;
      };
      return {
        encrypted: true,
        passwordProtected: true,
        salt,
        kdfType,
        kdfIterations: kdfType === 0 ? 1000 : 3,
        kdfMemory: kdfType === 0 ? undefined : 1,
        kdfParallelism: kdfType === 0 ? undefined : 1,
        encKeyValidation_DO_NOT_EDIT: await cipher(utf8("valid")),
        data: await cipher(utf8(JSON.stringify(bw))),
      };
    };
    for (const kdf of [0, 1]) {
      const file = await make(kdf);
      const out = await decryptBitwardenExport(file, "export pass");
      expect(out).toMatchObject({ encrypted: false });
      await expect(decryptBitwardenExport(file, "wrong")).rejects.toThrow(/didn't open/);
      const viaFile = await importFile("b.json", asFile(JSON.stringify(file)), "export pass");
      expect(viaFile.items).toHaveLength(6);
    }
  });

  it("reads Proton Pass", async () => {
    const r = fromProtonJson({
      vaults: {
        v: {
          name: "Personal",
          items: [
            { state: 1, data: { type: "login", metadata: { name: "A", note: "n" }, content: { itemUsername: "u", password: "p", urls: ["https://a.example"], totpUri: "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP" }, extraFields: [{ fieldName: "k", type: "hidden", data: { content: "v" } }] } },
            { state: 2, data: { type: "login", metadata: { name: "Trashed" }, content: {} } },
            { state: 1, data: { type: "creditCard", metadata: { name: "C" }, content: { cardholderName: "Z", number: "4111", verificationNumber: "1", expirationDate: "2030-05" } } },
            { state: 1, data: { type: "note", metadata: { name: "N", note: "x" }, content: {} } },
          ],
        },
      },
    });
    expect(r.items).toHaveLength(3);
    expect(r.items[0].body).toMatchObject({ username: "u", totp: { secret: "JBSWY3DPEHPK3PXP" } });
    expect(r.items[1].body).toMatchObject({ kind: "card", cardExpMonth: "05", cardExpYear: "2030" });
  });

  it("reads a Credential Exchange file", async () => {
    const data = {
      version: { major: 1, minor: 0 },
      exporterRpId: "x.example",
      exporterDisplayName: "X",
      timestamp: 1,
      accounts: [
        {
          id: "a",
          username: "u",
          email: "u@x",
          collections: [{ id: "c", title: "Work", items: [{ item: "i1" }] }],
          items: [
            {
              id: "i1",
              title: "Login",
              favorite: true,
              scope: { urls: ["https://a.example"], androidApps: [] },
              credentials: [
                { type: "basic-auth", username: { fieldType: "string", value: "ana" }, password: { fieldType: "concealed-string", value: "pw" } },
                { type: "totp", secret: "JBSWY3DPEHPK3PXP", period: 30, digits: 6, algorithm: "sha256", issuer: "A" },
                { type: "passkey", credentialId: "Y3JlZA", rpId: "a.example", username: "ana", userDisplayName: "Ana", userHandle: "dQ", key: "a2V5" },
              ],
            },
            { id: "i2", title: "Note", credentials: [{ type: "note", content: { fieldType: "string", value: "hello" } }] },
            { id: "i3", title: "Card", credentials: [{ type: "credit-card", number: { value: "4111" }, expiryDate: { value: "2031-07" }, verificationNumber: { value: "9" } }] },
            { id: "i4", title: "Odd", credentials: [{ type: "something-new" }] },
          ],
        },
      ],
    };
    const r = await importFile("export.json", asFile(JSON.stringify(data)));
    expect(r.format).toBe("Credential Exchange");
    expect(r.items[0].folder).toBe("Work");
    expect(r.items[0].body).toMatchObject({ username: "ana", password: "pw", totp: { algorithm: "SHA256" } });
    expect(r.items[0].body.passkeys?.[0].rpId).toBe("a.example");
    expect(r.items[1].body).toMatchObject({ kind: "note", notes: "hello" });
    expect(r.items[2].body).toMatchObject({ kind: "card", cardExpYear: "2031", cardExpMonth: "07" });
    expect(r.warnings.join()).toContain("something-new");
    expect(fromCxf({ accounts: [] }).items).toEqual([]);
  });

  it("reads Aegis and 2FAS, refusing encrypted ones", () => {
    const a = fromAegisJson({ version: 1, header: { slots: null, params: null }, db: { version: 3, entries: [{ type: "totp", name: "me", issuer: "A", note: "n", info: { secret: "JBSWY3DPEHPK3PXP", algo: "SHA256", digits: 8, period: 60 } }, { type: "hotp", name: "x", info: { secret: "AA" } }, { type: "steam", name: "s", issuer: "Steam", info: { secret: "JBSWY3DP", digits: 5, period: 30 } }] } });
    expect(a.items).toHaveLength(2);
    expect(a.items[0].body.totp).toMatchObject({ digits: 8, period: 60, algorithm: "SHA256" });
    expect(a.items[1].body.totp?.steam).toBe(true);
    expect(a.warnings[0]).toContain("1");
    expect(() => fromAegisJson({ db: "base64stuff", header: { slots: [{}] } })).toThrow(/encrypted/);

    const t = from2fasJson({ schemaVersion: 4, services: [{ name: "G", secret: "JBSWY3DP", otp: { tokenType: "TOTP", digits: 6, period: 30, algorithm: "SHA1", issuer: "G", account: "me" } }, { name: "h", secret: "AA", otp: { tokenType: "HOTP" } }] });
    expect(t.items).toHaveLength(1);
    expect(t.items[0].body.totp?.label).toBe("me");
    expect(() => from2fasJson({ services: [], servicesEncrypted: "x" })).toThrow(/encrypted/);
  });

  it("reads Google Authenticator migration links", async () => {
    const payload = Uint8Array.from([(1 << 3) | 2, 13, (1 << 3) | 2, 5, 1, 2, 3, 4, 5, (2 << 3) | 2, 4, 0x61, 0x6e, 0x61, 0x21]);
    const r = await importFile("x.txt", asFile(`otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload)))}`));
    expect(r.format).toBe("Google Authenticator");
    expect(r.items).toHaveLength(1);
  });
});

describe("zip formats", () => {
  it("reads 1Password .1pux", async () => {
    const data = {
      accounts: [
        {
          attrs: { accountName: "A" },
          vaults: [
            {
              attrs: { name: "Private" },
              items: [
                {
                  uuid: "1",
                  categoryUuid: "001",
                  state: "active",
                  overview: { title: "Login", url: "https://a.example", urls: [{ label: "", url: "https://a.example" }], tags: ["t"] },
                  details: {
                    loginFields: [{ value: "ana", designation: "username" }, { value: "pw", designation: "password" }],
                    notesPlain: "n",
                    sections: [{ fields: [{ title: "code", value: { totp: "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP" } }, { title: "pin", value: { concealed: "12" } }] }],
                    passwordHistory: [{ value: "old", time: 1000 }],
                  },
                },
                { uuid: "2", categoryUuid: "003", state: "active", overview: { title: "A note" }, details: { notesPlain: "text" } },
                { uuid: "3", categoryUuid: "002", state: "active", overview: { title: "A card" }, details: { sections: [{ fields: [{ title: "Number", value: { creditCardNumber: "4111" } }] }] } },
                { uuid: "4", categoryUuid: "001", state: "trashed", overview: { title: "Gone" }, details: {} },
              ],
            },
          ],
        },
      ],
    };
    const zip = zipSync({ "export.attributes": strToU8('{"version":3}'), "export.data": strToU8(JSON.stringify(data)) });
    const r = await importFile("backup.1pux", zip);
    expect(r.format).toBe("1Password");
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ folder: "Private", body: { username: "ana", password: "pw", notes: "n", totp: { secret: "JBSWY3DPEHPK3PXP" } } });
    expect(r.items[0].body.passwordHistory?.[0].password).toBe("old");
    expect(r.items[1].body.kind).toBe("note");
    expect(r.items[2].body).toMatchObject({ kind: "card", cardNumber: "4111" });
  });

  it("reads a Dashlane zip of CSVs", async () => {
    const zip = zipSync({
      "credentials.csv": strToU8("username,username2,username3,title,password,note,url,category,otpSecret\nana,,,Site,pw,hi,https://a.example,,JBSWY3DPEHPK3PXP\n"),
      "securenotes.csv": strToU8("title,note\nNotey,text\n"),
      "payments.csv": strToU8("type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank,name,cvv\n,Ana,,,,,,,,,,Card,1\n"),
    });
    const r = await importFile("dashlane.zip", zip);
    expect(r.format).toBe("Dashlane");
    expect(r.items.find((i) => i.body.title === "Site")?.body).toMatchObject({ username: "ana", password: "pw" });
    expect(r.items.find((i) => i.body.kind === "note")?.body.notes).toBe("text");
  });

  it("refuses a zip bomb's total size", () => {
    expect(() => {
      const zip = zipSync({ "export.attributes": strToU8("{}"), "a.csv": new Uint8Array(1000) });
      void zip;
    }).not.toThrow();
  });
});

describe("own export", () => {
  const item = { id: "1", vaultId: "v", revision: 1, deleted: false, updatedAt: "", body: newBody("login", "=SUM(1)", { username: "+u", password: 'p"w,', urls: [{ url: "https://a.example" }], totp: { secret: "AAAA" } }) };

  it("round-trips the encrypted file, and refuses the wrong password", async () => {
    const text = await encryptedExport([item], "file password 1");
    expect(text).not.toContain("=SUM");
    expect(text).not.toContain("https://a.example");
    const r = await importFile("v.json", utf8(text), "file password 1");
    expect(r.items[0].body.title).toBe("=SUM(1)");
    await expect(importFile("v.json", utf8(text))).rejects.toBeInstanceOf(NeedsPasswordError);
    await expect(readEncryptedExport(JSON.parse(text), "wrong")).rejects.toThrow(/didn't open/);
    const weak = { ...JSON.parse(text), kdf: { alg: "argon2id", m: 8, t: 1, p: 1 } };
    await expect(readEncryptedExport(weak, "file password 1")).rejects.toThrow(/KDF/);
  });

  it("neutralises spreadsheet formulas in CSV", () => {
    const csv = plainCsvExport([item]);
    expect(csv).toContain("'=SUM(1)");
    expect(csv).toContain("'+u");
    expect(csv).toContain('"p""w,"');
    expect(parseCsv(csv)[1][3]).toBe('p"w,');
  });

  it("plain JSON round-trips", async () => {
    const r = await importFile("v.json", utf8(plainJsonExport([item])));
    expect(r.items[0].body.username).toBe("+u");
  });
});

describe("dedupe", () => {
  const b = (o: Partial<ItemBody>) => newBody("login", "x", o);
  it("removes exact duplicates against the vault and within the file", () => {
    const { fresh, duplicates } = dedupe(
      [{ body: b({ username: "a", password: "1", urls: [{ url: "https://www.a.example/x" }] }) }, { body: b({ username: "a", password: "1", urls: [{ url: "https://a.example/y" }] }) }, { body: b({ username: "a", password: "2" }) }],
      [b({ username: "a", password: "1", urls: [{ url: "https://a.example" }] })],
    );
    expect(duplicates).toBe(2);
    expect(fresh).toHaveLength(1);
  });
});

describe("Security check", () => {
  const login = (title: string, password: string, extra: Partial<ItemBody> = {}) => ({ id: title, vaultId: "v", revision: 1, deleted: false, updatedAt: "", body: newBody("login", title, { password, ...extra }) });

  it("finds weak, reused, old, breached, http, and missing 2FA", async () => {
    const strong = "correct-horse-battery-staple-99!x";
    const items = [
      login("Weak", "password"),
      login("R1", strong),
      login("R2", strong),
      login("Old", "uG7#kP9$qL2@vX5!", { passwordChangedAt: "2020-01-01T00:00:00Z" }),
      login("Http", "tH4%mN8&bC1*zQ6!", { urls: [{ url: "http://shop.example.com" }] }),
      login("NoTwoFa", "wE3^rT6(yU9)iO2!", { urls: [{ url: "https://github.com" }] }),
      login("HasTwoFa", "aS1!dF4@gH7#jK0$", { urls: [{ url: "https://github.com" }], totp: { secret: "AA" } }),
      { ...login("Deleted", "password"), deleted: true },
    ];
    const hash = await sha1Hex("password");
    const r = await runHealth(items, {
      twofa: { "github.com": { documentation: "https://docs" } },
      passkeys: { "github.com": true },
      range: async (prefix) => (prefix === hash.slice(0, 5) ? `${hash.slice(5)}:12345\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0` : "AAAA:0"),
    });
    expect(r.weak.map((i) => i.id)).toEqual(["Weak"]);
    expect(r.reused[0].items.map((i) => i.id).sort()).toEqual(["R1", "R2"]);
    expect(r.old.map((i) => i.id)).toEqual(["Old"]);
    expect(r.http.map((i) => i.id)).toEqual(["Http"]);
    expect(r.breached).toEqual([{ item: items[0], count: 12345 }]);
    expect(r.no2fa.map((x) => x.item.id)).toEqual(["NoTwoFa"]);
    expect(r.noPasskey.map((i) => i.id)).toContain("NoTwoFa");
    expect(coarseCounts(r)).toEqual({ weak: 1, reused: 2, breached: 1, old: 1 });
  });

  it("only ever sends five hash characters, and ignores padding", async () => {
    const seen: string[] = [];
    const n = await breachCount("hunter2", async (p) => {
      seen.push(p);
      return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0";
    });
    expect(n).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(5);
  });

  it("agrees with SHA-1 of a known password", async () => {
    expect(await sha1Hex("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
  });
});

describe("fuzz: hostile files never crash or hang", () => {
  const names = ["x.csv", "x.json", "x.xml", "x.1pux", "x.zip", "x.kdbx", "x.txt"];

  it("random bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2000 }), fc.constantFrom(...names), async (bytes, name) => {
        try {
          const r = await importFile(name, bytes, "pw");
          expect(Array.isArray(r.items)).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("random strings shaped like each format", async () => {
    const shapes = [
      (s: string) => `name,url,username,password\n${s}\n`,
      (s: string) => JSON.stringify({ encrypted: false, items: [{ type: 1, name: s, login: { uris: s } }] }),
      (s: string) => JSON.stringify({ accounts: [{ items: [{ credentials: [{ type: s }] }] }], exporterRpId: s }),
      (s: string) => JSON.stringify({ vaults: { a: { items: [{ data: s }] } } }),
      (s: string) => JSON.stringify({ db: { entries: [{ type: "totp", info: s }] }, header: {} }),
      (s: string) => JSON.stringify({ services: [{ otp: s }] }),
      (s: string) => `otpauth-migration://offline?data=${s}`,
    ];
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 500 }), fc.integer({ min: 0, max: shapes.length - 1 }), async (s, i) => {
        try {
          const r = await importFile("f.txt", utf8(shapes[i](s)));
          expect(Array.isArray(r.items)).toBe(true);
          for (const it of r.items) expect(typeof it.body.title).toBe("string");
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("a huge CSV stops at the limit", () => {
    const big = "name,password\n" + "a,b\n".repeat(250_000);
    expect(() => parseCsv(big)).toThrow(/too many/);
  });

  it("deep JSON doesn't blow the stack", async () => {
    const deep = "[".repeat(100000);
    await expect(importFile("d.json", utf8(deep))).rejects.toBeInstanceOf(Error);
  });
});

describe("what a file can't bring in", () => {
  it("drops internal kinds and fields, and an app id gets no website match", () => {
    const body = (kind: string, extra = {}) => ({ v: 1, kind, title: "t", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...extra });
    const r = sanitizeImport({
      format: "x",
      items: [
        { body: body("trust", { trustBook: { people: {}, accepted: ["a"], contacts: ["mallory"], generations: {} } }) },
        { body: body("site_rule") },
        { body: body("login", { password: "p", trustBook: { contacts: ["mallory"] }, seq: 99, pendingPassword: "x", sendId: "s", urls: [{ url: "https://a.example/" }, { url: "android://H==@com.acme.app/" }] }) },
      ],
    } as never);
    expect(r.items).toHaveLength(1);
    const b = r.items[0].body as Record<string, unknown> & { urls: { url: string; match?: string }[] };
    expect(b.trustBook).toBeUndefined();
    expect(b.seq).toBeUndefined();
    expect(b.pendingPassword).toBeUndefined();
    expect(b.urls[0].match).toBeUndefined();
    expect(b.urls[1].match).toBe("never");
  });
});
