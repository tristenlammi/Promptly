// Regenerates vectors.json from fixed inputs. It only writes with GEN_VECTORS=1:
//   GEN_VECTORS=1 npx vitest run src/passwords/core/vectors.gen.test.ts
// The committed file is what every language tests against, so regenerating it is
// a format change and needs a CRYPTO_SPEC.md change and a version bump.
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";

import { concat, fromHex, hex, lp, utf8 } from "./bytes";
import { aad, pad, sealToWith, sealWithNonce, signingInput } from "./format";
import { decodeKeyset, deriveRootRaw, encodeKeyset, encodeSecretKey, publicKeysOf } from "./keys";
import { aesKey, argon2, ed25519Sign, type KdfParams } from "./primitives";
import { deviceSafetyWords, identityWords } from "./safety";
import { totpCode } from "./totp";

const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const seq = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255);

const FLOOR: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1 };

it("writes vectors.json", async () => {
  if (!process.env.GEN_VECTORS) return;

  const accountId = "11111111-1111-4111-8111-111111111111";
  const vaultId = "22222222-2222-4222-8222-222222222222";
  const itemId = "33333333-3333-4333-8333-333333333333";
  const userId = "44444444-4444-4444-8444-444444444444";

  const roots = [];
  for (const c of [
    { password: "correct horse battery staple", sk: seq(16), salt: seq(16, 0x80), kdf: FLOOR },
    // NFKC folds U+FB01 (fi ligature) and U+2460 (circled 1): must match the plain spelling below.
    { password: "ﬁnal①", sk: seq(16), salt: seq(16, 0x80), kdf: FLOOR },
    { password: "final1", sk: seq(16), salt: seq(16, 0x80), kdf: FLOOR },
    { password: "pässwörd 🔑", sk: seq(16, 0x40), salt: seq(16, 0x20), kdf: { alg: "argon2id", m: 131072, t: 3, p: 2 } as KdfParams },
  ]) {
    const { unlock, auth } = await deriveRootRaw(c.password, c.sk, c.salt, c.kdf);
    roots.push({
      password: c.password,
      secret_key_hex: hex(c.sk),
      salt_hex: hex(c.salt),
      kdf: c.kdf,
      unlock_hex: hex(unlock),
      auth_hex: hex(auth),
    });
  }

  const key32 = seq(32);
  const k = await aesKey(key32);

  const seals = [];
  for (const c of [
    { scope: accountId, item: "", field: "keyset", plain: seq(65), nonce: seq(12, 1) },
    { scope: vaultId, item: itemId, field: "item_key", plain: seq(32, 9), nonce: seq(12, 2) },
    { scope: vaultId, item: itemId, field: "body", plain: pad(utf8('{"type":"login"}')), nonce: seq(12, 3) },
    { scope: vaultId, item: "", field: "name", plain: new Uint8Array(0), nonce: seq(12, 4) },
  ]) {
    const blob = await sealWithNonce(k, c.nonce, c.plain, aad(c.scope, c.item, c.field));
    seals.push({
      key_hex: hex(key32),
      scope: c.scope,
      item: c.item,
      field: c.field,
      nonce_hex: hex(c.nonce),
      plain_hex: hex(c.plain),
      aad_hex: hex(aad(c.scope, c.item, c.field)),
      blob_hex: hex(blob),
    });
  }

  const recipientSk = seq(32, 0x10);
  const ephSk = seq(32, 0x30);
  const recipientPub = publicKeysOf({ x25519: recipientSk, ed25519: seq(32, 0x50) }).x25519;
  const sealedPlain = seq(32, 0x70);
  const sealedAad = aad(vaultId, "", `vault_key:${userId}`);
  const sealedBlob = await sealToWith(ephSk, seq(12, 5), recipientPub, sealedPlain, sealedAad);

  const edSeed = seq(32, 0x50);
  const edPub = publicKeysOf({ x25519: recipientSk, ed25519: edSeed }).ed25519;
  const sigInput = signingInput("vault_key", [vaultId, userId, "1", sealedBlob]);
  const signature = ed25519Sign(edSeed, sigInput);
  // "This vault is my own" (CRYPTO_SPEC.md section 6), written inside the person's own vault.
  const homeInput = signingInput("personal_vault", [userId, vaultId]);
  const homeSig = ed25519Sign(edSeed, homeInput);

  // A full item blob with deterministic nonces, built by hand from the spec's
  // layout so other languages can decrypt it.
  const vaultKey = seq(32, 0xa0);
  const vk = await aesKey(vaultKey);
  const itemKey = seq(32, 0xc0);
  const ik = await aesKey(itemKey);
  const itemBody = { type: "login", title: "Example", urls: ["https://example.com"], username: "ana", password: "s3cret" };
  const wrappedItemKey = await sealWithNonce(vk, seq(12, 6), itemKey, aad(vaultId, itemId, "item_key"));
  const bodyBlob = await sealWithNonce(ik, seq(12, 7), pad(utf8(JSON.stringify(itemBody))), aad(vaultId, itemId, "body"));
  const itemBlob = concat(new Uint8Array([1]), lp(wrappedItemKey), bodyBlob);

  const keyset = decodeKeyset(concat(new Uint8Array([1]), recipientSk, edSeed));

  const vectors = {
    format: 1,
    note: "Consumed by the TypeScript, Kotlin and Rust test suites. See passwords/CRYPTO_SPEC.md.",
    kat: {
      // RFC 5869 appendix A.1
      hkdf: [
        {
          source: "RFC 5869 A.1",
          ikm_hex: "0b".repeat(22),
          salt_hex: "000102030405060708090a0b0c",
          info_hex: "f0f1f2f3f4f5f6f7f8f9",
          length: 42,
          okm_hex: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        },
      ],
      // NIST SP 800-38D test vectors as listed in the GCM spec, cases 14 and 16.
      aes_gcm: [
        {
          source: "GCM spec test case 14",
          key_hex: "00".repeat(32),
          nonce_hex: "00".repeat(12),
          aad_hex: "",
          plain_hex: "00".repeat(16),
          ct_hex: "cea7403d4d606b6e074ec5d3baf39d18",
          tag_hex: "d0d1c8a799996bf0265b98b5d48ab919",
        },
        {
          source: "GCM spec test case 16",
          key_hex: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
          nonce_hex: "cafebabefacedbaddecaf888",
          aad_hex: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
          plain_hex: "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
          ct_hex: "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
          tag_hex: "76fc6ece0f4e1768cddf8853bb2d551b",
        },
      ],
      // RFC 7748 section 6.1
      x25519: [
        {
          source: "RFC 7748 6.1",
          alice_sk_hex: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
          alice_pub_hex: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
          bob_sk_hex: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
          bob_pub_hex: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
          shared_hex: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
        },
      ],
      // RFC 8032 section 7.1 test 2
      ed25519: [
        {
          source: "RFC 8032 7.1 TEST 2",
          seed_hex: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
          pub_hex: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
          msg_hex: "72",
          sig_hex:
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        },
      ],
      // RFC 6238 appendix B.
      totp: [
        ...[59, 1111111109, 20000000000].flatMap((time, i) => [
          { source: "RFC 6238 B", algorithm: "SHA1", secret_ascii: "12345678901234567890", digits: 8, period: 30, time, code: ["94287082", "07081804", "65353130"][i] },
          { source: "RFC 6238 B", algorithm: "SHA256", secret_ascii: "12345678901234567890123456789012", digits: 8, period: 30, time, code: ["46119246", "68084774", "77737706"][i] },
          {
            source: "RFC 6238 B",
            algorithm: "SHA512",
            secret_ascii: "1234567890123456789012345678901234567890123456789012345678901234",
            digits: 8,
            period: 30,
            time,
            code: ["90693936", "25091201", "47863826"][i],
          },
        ]),
      ],
      steam: [{ source: "generated", secret_base64: btoa("12345678901234567890"), time: 59, code: await totpCode({ secret: btoa("12345678901234567890"), steam: true }, 59_000) }],
      argon2id: [
        {
          source: "generated; cross-checked against @noble/hashes in crypto.test.ts",
          password_hex: hex(utf8("password")),
          salt_hex: hex(utf8("somesaltsomesalt")),
          kdf: FLOOR,
          output_hex: hex(await argon2(utf8("password"), utf8("somesaltsomesalt"), FLOOR)),
        },
      ],
    },
    secret_key_note: "Secret Key text form, CRYPTO_SPEC.md section 5",
    secret_key: await Promise.all(
      [seq(16), fill(16, 0), fill(16, 255), seq(16, 0x77)].map(async (raw) => ({ raw_hex: hex(raw), encoded: await encodeSecretKey(raw) })),
    ),
    padding: [0, 1, 251, 252, 253, 508, 509, 1000, 1048572, 1048573, 1310716, 1310717].map((len) => ({ len, padded: pad(new Uint8Array(len)).length })),
    root: roots,
    seal: seals,
    sealed_box: [
      {
        recipient_sk_hex: hex(recipientSk),
        recipient_pub_hex: hex(recipientPub),
        eph_sk_hex: hex(ephSk),
        nonce_hex: hex(seq(12, 5)),
        plain_hex: hex(sealedPlain),
        scope: vaultId,
        item: "",
        field: `vault_key:${userId}`,
        blob_hex: hex(sealedBlob),
      },
    ],
    signature: [
      {
        seed_hex: hex(edSeed),
        pub_hex: hex(edPub),
        purpose: "vault_key",
        fields: [vaultId, userId, "1", { hex: hex(sealedBlob) }],
        input_hex: hex(sigInput),
        sig_hex: hex(signature),
      },
      {
        seed_hex: hex(edSeed),
        pub_hex: hex(edPub),
        purpose: "personal_vault",
        fields: [userId, vaultId],
        input_hex: hex(homeInput),
        sig_hex: hex(homeSig),
      },
    ],
    keyset: { encoded_hex: hex(encodeKeyset(keyset)), x25519_pub_hex: hex(recipientPub), ed25519_pub_hex: hex(edPub) },
    item: [
      {
        vault_key_hex: hex(vaultKey),
        vault_id: vaultId,
        item_id: itemId,
        blob_hex: hex(itemBlob),
        body: itemBody,
      },
    ],
    safety_words: [
      {
        kind: "device",
        new_device_pub_hex: hex(fromHex("11".repeat(32))),
        approver_pub_hex: hex(fromHex("22".repeat(32))),
        words: await deviceSafetyWords(fromHex("11".repeat(32)), fromHex("22".repeat(32))),
      },
      {
        kind: "identity",
        user_id: userId,
        x25519_pub_hex: hex(recipientPub),
        ed25519_pub_hex: hex(edPub),
        words: await identityWords(userId, recipientPub, edPub),
      },
    ],
    // Every one of these must fail to decrypt or parse.
    negative: [
      { why: "flipped ciphertext bit", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(flip(fromHex(seals[1].blob_hex), 30)) },
      { why: "flipped tag bit", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(flip(fromHex(seals[1].blob_hex), fromHex(seals[1].blob_hex).length - 1)) },
      { why: "flipped nonce bit", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(flip(fromHex(seals[1].blob_hex), 3)) },
      { why: "blob moved to another item", key_hex: hex(key32), scope: vaultId, item: "55555555-5555-4555-8555-555555555555", field: "item_key", blob_hex: seals[1].blob_hex },
      { why: "blob moved to another vault", key_hex: hex(key32), scope: accountId, item: itemId, field: "item_key", blob_hex: seals[1].blob_hex },
      { why: "blob moved to another field", key_hex: hex(key32), scope: vaultId, item: itemId, field: "body", blob_hex: seals[1].blob_hex },
      { why: "wrong key", key_hex: hex(seq(32, 1)), scope: vaultId, item: itemId, field: "item_key", blob_hex: seals[1].blob_hex },
      { why: "older format version", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(setByte(fromHex(seals[1].blob_hex), 0, 0)) },
      { why: "newer format version", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(setByte(fromHex(seals[1].blob_hex), 0, 2)) },
      { why: "unknown algorithm", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: hex(setByte(fromHex(seals[1].blob_hex), 1, 9)) },
      { why: "truncated", key_hex: hex(key32), scope: vaultId, item: itemId, field: "item_key", blob_hex: seals[1].blob_hex.slice(0, 40) },
    ],
    kdf_rejected: [
      { alg: "argon2id", m: 32768, t: 3, p: 1 },
      { alg: "argon2id", m: 65536, t: 2, p: 1 },
      { alg: "argon2id", m: 65536, t: 3, p: 0 },
      { alg: "argon2i", m: 65536, t: 3, p: 1 },
      { alg: "argon2id", m: 8388608, t: 3, p: 1 },
      { alg: "argon2id", m: 65536, t: 100, p: 1 },
      { alg: "argon2id", m: 65536, t: 3, p: 64 },
    ],
  };
  fs.writeFileSync(path.join(__dirname, "vectors.json"), JSON.stringify(vectors, null, 1) + "\n");
});

function flip(b: Uint8Array, at: number): Uint8Array {
  const c = b.slice();
  c[at] ^= 1;
  return c;
}

function setByte(b: Uint8Array, at: number, v: number): Uint8Array {
  const c = b.slice();
  c[at] = v;
  return c;
}
