// TOTP, generators, kit, merge. No server needed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode, parseMigrationUri, parseOtpauth, secondsLeft, toOtpauth, totpCode } from "./totp";
import {
  DEFAULT_PASSWORD,
  generateForRules,
  generateForSite,
  generatePassphrase,
  generatePassword,
  generatePin,
  generateUsername,
  parseRules,
  plusAddress,
  rulesForHost,
} from "./generator";
import { buildKitPdf, kitQrText, parseKitQr } from "./kit";
import { fromUtf8 } from "./bytes";
import { type ItemBody, mergeBodies, newBody, searchText, touch } from "./model";
import RULES from "./data/password-rules.json";
import V from "./vectors.json";

describe("TOTP", () => {
  it("passes RFC 6238 appendix B", async () => {
    for (const c of V.kat.totp) {
      const code = await totpCode(
        { secret: base32Encode(Uint8Array.from(c.secret_ascii, (x) => x.charCodeAt(0))), algorithm: c.algorithm as "SHA1", digits: c.digits, period: c.period },
        c.time * 1000,
      );
      expect(code).toBe(c.code);
    }
  });

  it("does Steam Guard's five characters from its alphabet", async () => {
    const code = await totpCode({ secret: btoa("12345678901234567890"), steam: true }, 59_000);
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
    expect(code).toBe(V.kat.steam[0].code);
  });

  it("counts down", () => {
    expect(secondsLeft({ secret: "AA" }, 0)).toBe(30);
    expect(secondsLeft({ secret: "AA" }, 29_000)).toBe(1);
    expect(secondsLeft({ secret: "AA", period: 60 }, 61_000)).toBe(59);
  });

  it("base32 round-trips, and refuses junk", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (d) => {
      expect(base32Decode(base32Encode(d))).toEqual(d);
    }));
    expect(() => base32Decode("not base32!")).toThrow();
    expect(() => base32Decode("")).toThrow();
  });

  it("reads otpauth links", () => {
    const c = parseOtpauth("otpauth://totp/GitHub:ana%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=45");
    expect(c).toMatchObject({ issuer: "GitHub", label: "ana@example.com", algorithm: "SHA256", digits: 8, period: 45, secret: "JBSWY3DPEHPK3PXP" });
    const again = parseOtpauth(toOtpauth(c));
    expect(again).toMatchObject({ issuer: "GitHub", label: "ana@example.com", digits: 8, period: 45 });
  });

  it("refuses bad otpauth links", () => {
    for (const bad of [
      "https://example.com",
      "otpauth://hotp/x?secret=JBSWY3DP&counter=1",
      "otpauth://totp/x",
      "otpauth://totp/x?secret=!!!",
      "otpauth://totp/x?secret=JBSWY3DP&digits=2",
      "otpauth://totp/x?secret=JBSWY3DP&algorithm=MD5",
      "not a url",
    ]) {
      expect(() => parseOtpauth(bad), bad).toThrow();
    }
  });

  it("reads a Google Authenticator migration QR", () => {
    // Hand-built protobuf: one TOTP entry and one HOTP entry.
    const td = new TextEncoder();
    const field = (n: number, bytes: Uint8Array) => [(n << 3) | 2, bytes.length, ...bytes];
    const varint = (n: number, v: number) => [(n << 3) | 0, v];
    const entry1 = Uint8Array.from([...field(1, Uint8Array.from([1, 2, 3, 4, 5])), ...field(2, td.encode("ACME:ana")), ...field(3, td.encode("ACME")), ...varint(4, 2), ...varint(5, 2), ...varint(6, 2)]);
    const entry2 = Uint8Array.from([...field(1, Uint8Array.from([9, 9])), ...field(2, td.encode("hotp")), ...varint(6, 1)]);
    const payload = Uint8Array.from([...field(1, entry1), ...field(1, entry2), ...varint(2, 1)]);
    const uri = `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload)))}`;
    const { codes, skipped } = parseMigrationUri(uri);
    expect(skipped).toBe(1);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ issuer: "ACME", label: "ana", algorithm: "SHA256", digits: 8, secret: base32Encode(Uint8Array.from([1, 2, 3, 4, 5])) });
  });

  it("survives malformed migration data", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
      try {
        parseMigrationUri(`otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }));
  });
});

describe("generators", () => {
  it("passwords honour the options", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ ...DEFAULT_PASSWORD, length: 16 });
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
      expect(p).not.toMatch(/[O0oIl1|]/);
    }
    expect(generatePassword({ length: 8, lower: false, upper: false, digits: true, symbols: false, avoidAmbiguous: false })).toMatch(/^\d{8}$/);
    expect(() => generatePassword({ length: 8, lower: false, upper: false, digits: false, symbols: false, avoidAmbiguous: false })).toThrow();
  });

  it("are not obviously biased", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      const c = generatePin(1);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.size).toBe(10);
    for (const n of counts.values()) expect(Math.abs(n - 2000)).toBeLessThan(250);
  });

  it("passphrases and usernames", () => {
    const p = generatePassphrase({ words: 5, separator: "-", capitalize: true, includeNumber: true });
    expect(p.split("-")).toHaveLength(5);
    expect(p).toMatch(/\d/);
    expect(generateUsername()).toMatch(/\./);
    expect(generateUsername("random")).toHaveLength(12);
    expect(generatePin(6)).toMatch(/^\d{6}$/);
  });

  it("plus addresses", () => {
    expect(plusAddress("me@x.com", "Big Shop!")).toBe("me+bigshop@x.com");
    expect(plusAddress("me+old@x.com", "new")).toBe("me+new@x.com");
    expect(() => plusAddress("nope", "x")).toThrow();
  });

  it("reads site rules", () => {
    const r = parseRules("minlength: 8; maxlength: 12; required: lower; required: upper; required: digit; allowed: [-_]; max-consecutive: 2;");
    expect(r).toMatchObject({ minLength: 8, maxLength: 12, maxConsecutive: 2 });
    expect(r.required).toHaveLength(3);
    for (let i = 0; i < 100; i++) {
      const p = generateForRules(r);
      expect(p.length).toBeGreaterThanOrEqual(8);
      expect(p.length).toBeLessThanOrEqual(12);
      expect(p).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).not.toMatch(/(.)\1\1/);
    }
  });

  it("uses Apple's quirks table for known sites, by base domain too", () => {
    const hits = ["american.com", "www.ana.co.jp", "ichunqiu.com"].map((h) => rulesForHost(h));
    expect(hits.some(Boolean)).toBe(true);
    expect(rulesForHost("no-such-site.invalid")).toBeNull();
    expect(generateForSite("no-such-site.invalid", { ...DEFAULT_PASSWORD, length: 14 })).toHaveLength(14);
  });

  it("every rule in the pack produces a password that keeps its rules", () => {
    const table = RULES as Record<string, { "password-rules": string }>;
    expect(Object.keys(table).length).toBeGreaterThan(100);
    for (const [site, entry] of Object.entries(table)) {
      const rules = parseRules(entry["password-rules"]);
      for (let i = 0; i < 5; i++) {
        const p = generateForRules(rules);
        if (rules.minLength) expect(p.length, site).toBeGreaterThanOrEqual(rules.minLength);
        if (rules.maxLength) expect(p.length, site).toBeLessThanOrEqual(rules.maxLength);
        for (const set of rules.required) expect([...p].some((c) => set.includes(c)), `${site} required`).toBe(true);
        if (rules.allowed) expect([...p].every((c) => rules.allowed.includes(c)), `${site} allowed`).toBe(true);
      }
    }
  });
});

describe("recovery kit", () => {
  const sk = "PWK1-ABCDEFG-HJKMNPQ-RSTVWXY-Z012345";

  it("makes a PDF that a real reader opens, with the key in it", async () => {
    const pdf = buildKitPdf({ secretKey: sk, serverUrl: "https://home.example.org", username: "ana", createdOn: "2026-11-06" });
    expect(fromUtf8(pdf.slice(0, 8))).toBe("%PDF-1.4");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: pdf.slice(), useWorkerFetch: false, useSystemFonts: false }).promise;
    expect(doc.numPages).toBe(1);
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    expect(text).toContain(sk);
    expect(text).toContain("home.example.org");
    expect(text).toContain("gone for good");
  });

  it("escapes PDF syntax in what it prints", () => {
    const pdf = buildKitPdf({ secretKey: sk, serverUrl: "https://x", username: "a) Tj (evil\\", createdOn: "d" });
    expect(fromUtf8(pdf)).not.toContain("(a) Tj (evil");
  });

  it("QR text round-trips", () => {
    const t = kitQrText("https://home.example.org:8443", sk, "ana b");
    expect(parseKitQr(t)).toEqual({ serverUrl: "https://home.example.org:8443", secretKey: sk, username: "ana b" });
    expect(parseKitQr("https://evil")).toBeNull();
    expect(parseKitQr("promptly-kit:1?sk=only")).toBeNull();
  });
});

describe("item model", () => {
  const base = (over: Partial<ItemBody> = {}) => ({ ...newBody("login", "T", { username: "u", password: "p", notes: "n" }), ...over });

  it("history records an old password on change", () => {
    const a = base();
    const b = touch(a, { ...a, password: "new" });
    expect(b.passwordHistory?.[0].password).toBe("p");
    expect(b.passwordChangedAt).toBeTruthy();
    const c = touch(b, { ...b, notes: "x" });
    expect(c.passwordHistory).toHaveLength(1);
    const many = Array.from({ length: 30 }).reduce<ItemBody>((acc, _, i) => touch(acc, { ...acc, password: `p${i}` }), a);
    expect(many.passwordHistory).toHaveLength(20);
  });

  it("search text has no secrets", () => {
    const b = newBody("login", "Title", { username: "user", password: "HUNTER2", cardNumber: "4111", apiKey: "KEYKEY", fields: [{ name: "pin", value: "SECRETFIELD", type: "hidden" }, { name: "plan", value: "gold", type: "text" }] });
    const t = searchText(b);
    expect(t).toContain("title");
    expect(t).toContain("gold");
    for (const s of ["hunter2", "4111", "keykey", "secretfield"]) expect(t).not.toContain(s);
  });

  it("merges by field and keeps both on a clash", () => {
    const b = base();
    const m1 = mergeBodies(b, { ...b, username: "local" }, { ...b, notes: "server" });
    expect(m1.conflicted).toBe(false);
    expect(m1.body).toMatchObject({ username: "local", notes: "server" });

    const m2 = mergeBodies(b, { ...b, password: "L" }, { ...b, password: "S" });
    expect(m2.conflicted).toBe(true);
    expect(m2.body.password).toBe("S");
    expect((m2.body.conflicts![0].body as ItemBody).password).toBe("L");

    // Same change on both sides is no conflict.
    const m3 = mergeBodies(b, { ...b, password: "X" }, { ...b, password: "X" });
    expect(m3.conflicted).toBe(false);
    expect(m3.body.conflicts).toBeUndefined();

    // A field removed locally stays removed when the server left it alone.
    const { notes: _n, ...noNotes } = b;
    const m4 = mergeBodies(b, noNotes as ItemBody, b);
    expect(m4.body.notes).toBeUndefined();

    // With no base, different content is kept both ways, never lost.
    const m5 = mergeBodies(null, { ...b, password: "L" }, { ...b, password: "S" });
    expect(m5.conflicted).toBe(true);
  });

  it("unknown fields survive a merge", () => {
    const b = { ...base(), futureField: 1 } as ItemBody;
    const m = mergeBodies(b, { ...b, username: "z" }, b);
    expect(m.body.futureField).toBe(1);
  });
});
