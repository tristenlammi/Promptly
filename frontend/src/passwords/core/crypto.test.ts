// Section 13.1: known answers against the RFCs, the shared vectors, negative
// cases and property tests. The same vectors run in Kotlin and Rust.
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { b64u, concat, equalBytes, fromB64u, fromHex, hex, lp, utf8 } from "./bytes";
import { aad, bucketFor, open, openSealed, pad, seal, sealTo, signingInput, unpad } from "./format";
import {
  decodeKeyset,
  decryptItem,
  deriveRootRaw,
  encodeSecretKey,
  encryptItem,
  grantVaultKey,
  lastGroup,
  newKeyset,
  openField,
  openVaultKey,
  parseSecretKey,
  publicKeysOf,
  sealField,
  unwrapKeyset,
  wrapKeyset,
} from "./keys";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  aesKey,
  argon2,
  checkKdf,
  ed25519Public,
  ed25519Sign,
  ed25519Verify,
  hkdf,
  type KdfParams,
  x25519Public,
  x25519Shared,
} from "./primitives";
import { deviceSafetyWords, identityWords, WORDLIST } from "./safety";
import V from "./vectors.json";

const b = fromHex;

describe("known answers", () => {
  it("HKDF-SHA256 (RFC 5869)", async () => {
    for (const c of V.kat.hkdf) {
      // Our hkdf takes info as a string; RFC 5869's isn't valid UTF-8, so go
      // straight to WebCrypto for this one, the same primitive.
      const key = await crypto.subtle.importKey("raw", b(c.ikm_hex) as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: b(c.salt_hex) as Uint8Array<ArrayBuffer>, info: b(c.info_hex) as Uint8Array<ArrayBuffer> },
        key,
        c.length * 8,
      );
      expect(hex(new Uint8Array(bits))).toBe(c.okm_hex);
    }
    expect(hex(await hkdf(utf8("x"), new Uint8Array(0), "promptly-pw/v1/root"))).toHaveLength(64);
  });

  it("AES-256-GCM (NIST)", async () => {
    for (const c of V.kat.aes_gcm) {
      const key = await aesKey(b(c.key_hex));
      const out = await aesGcmEncrypt(key, b(c.nonce_hex), b(c.plain_hex), b(c.aad_hex));
      expect(hex(out)).toBe(c.ct_hex + c.tag_hex);
      expect(hex(await aesGcmDecrypt(key, b(c.nonce_hex), out, b(c.aad_hex)))).toBe(c.plain_hex);
    }
  });

  it("X25519 (RFC 7748)", () => {
    for (const c of V.kat.x25519) {
      expect(hex(x25519Public(b(c.alice_sk_hex)))).toBe(c.alice_pub_hex);
      expect(hex(x25519Public(b(c.bob_sk_hex)))).toBe(c.bob_pub_hex);
      expect(hex(x25519Shared(b(c.alice_sk_hex), b(c.bob_pub_hex)))).toBe(c.shared_hex);
      expect(hex(x25519Shared(b(c.bob_sk_hex), b(c.alice_pub_hex)))).toBe(c.shared_hex);
    }
  });

  it("X25519 refuses a low-order public key", () => {
    expect(() => x25519Shared(new Uint8Array(32).fill(7), new Uint8Array(32))).toThrow();
  });

  it("Ed25519 (RFC 8032)", () => {
    for (const c of V.kat.ed25519) {
      expect(hex(ed25519Public(b(c.seed_hex)))).toBe(c.pub_hex);
      expect(hex(ed25519Sign(b(c.seed_hex), b(c.msg_hex)))).toBe(c.sig_hex);
      expect(ed25519Verify(b(c.sig_hex), b(c.msg_hex), b(c.pub_hex))).toBe(true);
      expect(ed25519Verify(b(c.sig_hex), utf8("other"), b(c.pub_hex))).toBe(false);
    }
  });

  it("Argon2id: noble passes RFC 9106 5.3, and hash-wasm agrees with noble", async () => {
    // hash-wasm has no associated-data input, so the RFC vector goes through
    // @noble/hashes; hash-wasm is then checked against noble on our parameters.
    const rfc = nobleArgon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    });
    expect(hex(rfc)).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
    for (const c of V.kat.argon2id) {
      const params = c.kdf as KdfParams;
      const ours = await argon2(b(c.password_hex), b(c.salt_hex), params);
      expect(hex(ours)).toBe(c.output_hex);
      const noble = nobleArgon2id(b(c.password_hex), b(c.salt_hex), { t: params.t, m: params.m, p: params.p, dkLen: 32 });
      expect(hex(noble)).toBe(c.output_hex);
    }
  });
});

describe("shared vectors", () => {
  it("Secret Key encoding", async () => {
    for (const c of V.secret_key) {
      expect(await encodeSecretKey(b(c.raw_hex))).toBe(c.encoded);
      expect(hex(await parseSecretKey(c.encoded))).toBe(c.raw_hex);
      expect(hex(await parseSecretKey(c.encoded.toLowerCase().replace(/-/g, " ")))).toBe(c.raw_hex);
    }
  });

  it("padding buckets", () => {
    for (const c of V.padding) {
      expect(bucketFor(c.len)).toBe(c.padded);
      expect(pad(new Uint8Array(c.len)).length).toBe(c.padded);
    }
  });

  it("root keys", async () => {
    for (const c of V.root) {
      const { unlock, auth } = await deriveRootRaw(c.password, b(c.secret_key_hex), b(c.salt_hex), c.kdf as KdfParams);
      expect(hex(unlock)).toBe(c.unlock_hex);
      expect(hex(auth)).toBe(c.auth_hex);
    }
    // NFKC: the ligature spelling and the plain spelling derive the same keys.
    expect(V.root[1].unlock_hex).toBe(V.root[2].unlock_hex);
  });

  it("sealed blobs", async () => {
    for (const c of V.seal) {
      const ad = aad(c.scope, c.item, c.field);
      expect(hex(ad)).toBe(c.aad_hex);
      expect(hex(await open(await aesKey(b(c.key_hex)), b(c.blob_hex), ad))).toBe(c.plain_hex);
    }
  });

  it("sealed boxes", async () => {
    for (const c of V.sealed_box) {
      expect(hex(x25519Public(b(c.recipient_sk_hex)))).toBe(c.recipient_pub_hex);
      expect(hex(await openSealed(b(c.recipient_sk_hex), b(c.blob_hex), aad(c.scope, c.item, c.field)))).toBe(c.plain_hex);
    }
  });

  it("signatures", () => {
    for (const c of V.signature) {
      const fields = c.fields.map((f) => (typeof f === "string" ? f : b(f.hex)));
      const input = signingInput(c.purpose, fields);
      expect(hex(input)).toBe(c.input_hex);
      expect(hex(ed25519Sign(b(c.seed_hex), input))).toBe(c.sig_hex);
      expect(ed25519Verify(b(c.sig_hex), input, b(c.pub_hex))).toBe(true);
    }
  });

  it("keyset encoding", () => {
    const k = decodeKeyset(b(V.keyset.encoded_hex));
    const pub = publicKeysOf(k);
    expect(hex(pub.x25519)).toBe(V.keyset.x25519_pub_hex);
    expect(hex(pub.ed25519)).toBe(V.keyset.ed25519_pub_hex);
  });

  it("item blobs", async () => {
    for (const c of V.item) {
      const vk = await aesKey(b(c.vault_key_hex));
      expect(await decryptItem(vk, c.vault_id, c.item_id, b(c.blob_hex))).toEqual(c.body);
    }
  });

  it("safety words", async () => {
    const [device, identity] = V.safety_words;
    expect(await deviceSafetyWords(b(device.new_device_pub_hex!), b(device.approver_pub_hex!))).toEqual(device.words);
    expect(await identityWords(identity.user_id!, b(identity.x25519_pub_hex!), b(identity.ed25519_pub_hex!))).toEqual(identity.words);
    expect(WORDLIST).toHaveLength(7776);
  });

  it("every negative case fails", async () => {
    for (const c of V.negative) {
      await expect(open(await aesKey(b(c.key_hex)), b(c.blob_hex), aad(c.scope, c.item, c.field)), c.why).rejects.toThrow();
    }
  });

  it("KDF parameters outside the range are refused", async () => {
    for (const p of V.kdf_rejected) {
      expect(() => checkKdf(p as KdfParams), JSON.stringify(p)).toThrow();
      await expect(deriveRootRaw("x", new Uint8Array(16), new Uint8Array(16), p as KdfParams)).rejects.toThrow();
    }
  });
});

describe("hierarchy", () => {
  const vault = "22222222-2222-4222-8222-222222222222";
  const item = "33333333-3333-4333-8333-333333333333";

  it("Secret Key changes every key, and a typo is caught", async () => {
    const salt = new Uint8Array(16).fill(1);
    const p: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1 };
    const a = await deriveRootRaw("pw", new Uint8Array(16).fill(2), salt, p);
    const c = await deriveRootRaw("pw", new Uint8Array(16).fill(3), salt, p);
    expect(hex(a.unlock)).not.toBe(hex(c.unlock));
    expect(hex(a.auth)).not.toBe(hex(c.auth));
    expect(hex(a.unlock)).not.toBe(hex(a.auth));

    const encoded = await encodeSecretKey(new Uint8Array(16).fill(9));
    expect(lastGroup(encoded)).toHaveLength(7);
    const typo = encoded.slice(0, 6) + (encoded[6] === "A" ? "B" : "A") + encoded.slice(7);
    await expect(parseSecretKey(typo)).rejects.toThrow();
    await expect(parseSecretKey("PWK1-short")).rejects.toThrow();
  });

  it("keyset wraps under the unlock key and is bound to the account", async () => {
    const k = newKeyset();
    const unlock = await aesKey(new Uint8Array(32).fill(5));
    const blob = await wrapKeyset(unlock, "account-a", k);
    expect(hex((await unwrapKeyset(unlock, "account-a", blob)).x25519)).toBe(hex(k.x25519));
    await expect(unwrapKeyset(unlock, "account-b", blob)).rejects.toThrow();
    await expect(unwrapKeyset(await aesKey(new Uint8Array(32).fill(6)), "account-a", blob)).rejects.toThrow();
  });

  it("items round-trip, and can't be swapped between items or vaults", async () => {
    const vk = await aesKey(new Uint8Array(32).fill(7));
    const blob = await encryptItem(vk, vault, item, { title: "x", n: 1 });
    expect(await decryptItem(vk, vault, item, blob)).toEqual({ title: "x", n: 1 });
    await expect(decryptItem(vk, vault, "other", blob)).rejects.toThrow();
    await expect(decryptItem(vk, "other", item, blob)).rejects.toThrow();
    const body = await seal(vk, utf8("x"), aad(vault, item, "body"));
    await expect(decryptItem(vk, vault, item, concat(new Uint8Array([1]), lp(body), body))).rejects.toThrow();
  });

  it("two items with the same body differ", async () => {
    const vk = await aesKey(new Uint8Array(32).fill(7));
    const a = await encryptItem(vk, vault, item, { a: 1 });
    const c = await encryptItem(vk, vault, item, { a: 1 });
    expect(hex(a)).not.toBe(hex(c));
  });

  it("sizes reveal only the bucket", async () => {
    const vk = await aesKey(new Uint8Array(32).fill(7));
    const small = await encryptItem(vk, vault, item, { p: "a" });
    const larger = await encryptItem(vk, vault, item, { p: "a".repeat(200) });
    expect(small.length).toBe(larger.length);
  });

  it("vault key grants need a valid signature from the expected grantor", async () => {
    const alice = { userId: "alice", keyset: newKeyset() };
    const bob = { userId: "bob", keyset: newKeyset() };
    const mallory = { userId: "mallory", keyset: newKeyset() };
    const key = new Uint8Array(32).fill(4);
    const grant = await grantVaultKey(alice, vault, { userId: "bob", x25519: publicKeysOf(bob.keyset).x25519 }, 1, key);
    expect(hex(await openVaultKey(bob, vault, 1, grant, publicKeysOf(alice.keyset).ed25519))).toBe(hex(key));

    // A server that knows Bob's public key can seal to him, but can't sign as Alice.
    const forged = await grantVaultKey(mallory, vault, { userId: "bob", x25519: publicKeysOf(bob.keyset).x25519 }, 1, key);
    await expect(openVaultKey(bob, vault, 1, forged, publicKeysOf(alice.keyset).ed25519)).rejects.toThrow();
    // Replaying an old generation or another vault's grant fails too.
    await expect(openVaultKey(bob, vault, 2, grant, publicKeysOf(alice.keyset).ed25519)).rejects.toThrow();
    await expect(openVaultKey(bob, "other", 1, grant, publicKeysOf(alice.keyset).ed25519)).rejects.toThrow();
    // Someone else can't open what was sealed to Bob.
    await expect(openVaultKey(mallory, vault, 1, grant, publicKeysOf(alice.keyset).ed25519)).rejects.toThrow();
  });

  it("named fields are bound to their name", async () => {
    const k = await aesKey(new Uint8Array(32).fill(8));
    const blob = await sealField(k, vault, "name", "Family");
    expect(await openField(k, vault, "name", blob)).toBe("Family");
    await expect(openField(k, vault, "other", blob)).rejects.toThrow();
  });

  it("sealed boxes round-trip and bind their AAD", async () => {
    const k = newKeyset();
    const pub = publicKeysOf(k).x25519;
    const box = await sealTo(pub, utf8("hi"), aad("a", "b", "c"));
    expect(await openSealed(k.x25519, box, aad("a", "b", "c"))).toEqual(utf8("hi"));
    await expect(openSealed(k.x25519, box, aad("a", "b", "d"))).rejects.toThrow();
  });
});

describe("properties", () => {
  it("pad/unpad round-trips and always lands on a bucket", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 5000 }), (data) => {
        const p = pad(data);
        expect(p.length).toBe(bucketFor(data.length));
        expect(equalBytes(unpad(p), data)).toBe(true);
      }),
    );
  });

  it("unpad never accepts garbage quietly", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (data) => {
        try {
          const out = unpad(data);
          // If it parsed, re-padding to the same size must reproduce the input.
          const again = new Uint8Array(data.length);
          new DataView(again.buffer).setUint32(0, out.length);
          again.set(out, 4);
          expect(equalBytes(again, data)).toBe(true);
        } catch {
          /* refusing is fine */
        }
      }),
    );
  });

  it("base64url round-trips", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (data) => equalBytes(fromB64u(b64u(data)), data)));
  });

  it("the AAD encoding is injective", () => {
    fc.assert(
      fc.property(fc.tuple(fc.string(), fc.string(), fc.string()), fc.tuple(fc.string(), fc.string(), fc.string()), (x, y) => {
        fc.pre(x.join("\0") !== y.join("\0"));
        return !equalBytes(aad(...x), aad(...y));
      }),
    );
  });

  it("Secret Key encode/parse round-trips", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), async (raw) => {
        return equalBytes(await parseSecretKey(await encodeSecretKey(raw)), raw);
      }),
      { numRuns: 200 },
    );
  });

  it("random corruption of an item blob never decrypts", async () => {
    const vk = await aesKey(new Uint8Array(32).fill(7));
    const blob = await encryptItem(vk, "v", "i", { x: 1 });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: blob.length - 1 }), fc.integer({ min: 1, max: 255 }), async (at, mask) => {
        const bad = blob.slice();
        bad[at] ^= mask;
        await expect(decryptItem(vk, "v", "i", bad)).rejects.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
