# Promptly Passwords: crypto specification (format 1)

This is the exact format. Every client (TypeScript, Kotlin, Rust, later Swift) must match it byte for byte, and must pass `frontend/src/passwords/core/vectors.json`. Changing anything here means a new format version, new vectors and a migration path.

No home-made primitives. Only the ones in section 2.

## 1. Notation

- `||` is concatenation. Integers are big-endian.
- `lp(x)` is a u16 big-endian length followed by the bytes of `x`. Strings are UTF-8. A field over 65535 bytes is an error, never truncated.
- `HKDF(ikm, salt, info, L)` is HKDF-SHA256 (RFC 5869). "Empty" means a zero-length salt.

## 2. Primitives

| Purpose | Choice | Notes |
|---|---|---|
| AEAD | AES-256-GCM | 96-bit random nonce, 128-bit tag. Per-item keys keep message counts per key far below nonce-collision risk. |
| KDF | Argon2id v1.3 | 32-byte output, 16-byte salt. |
| Expansion | HKDF-SHA256 | |
| Key agreement | X25519 | Refuse an all-zero shared secret. |
| Signatures | Ed25519 | RFC 8032, seed form. |
| Hash | SHA-256 | Safety words, checksums. |
| Random | OS CSPRNG | |

### KDF limits

Every client refuses parameters outside this range, whatever the server says, so a hostile server can neither weaken nor hang the unlock:

| | Floor | Ceiling |
|---|---|---|
| `m` (KiB) | 65536 | 4194304 |
| `t` | 3 | 32 |
| `p` | 1 | 8 |

Floor rationale (checked against OWASP and RFC 9106 on 2026-11-06): RFC 9106's second recommended option is t=3, p=4, m=64 MiB. Ours differs only in p=1, chosen deliberately because WASM clients are single-threaded. It's well above every OWASP minimum. Parameters are stored per account and can only be raised by the client.

## 3. Blobs

### AAD

```
aad(scope, item, field) = "PWAD" || 0x01 || lp(scope) || lp(item) || lp(field)
```

`scope` is the account id or vault id. `item` is the item id, or empty. `field` names the slot. A server can't move a blob between items, vaults or fields without decryption failing.

### Symmetric blob (`alg` 1)

```
0x01 (format) || 0x01 (alg) || nonce(12) || ciphertext || tag(16)
```

### Sealed box (`alg` 2), anonymous public-key encryption

```
eph_sk   = 32 random bytes; eph_pub = X25519(eph_sk, base)
key      = HKDF(X25519(eph_sk, recipient_pub), eph_pub || recipient_pub, "promptly-pw/v1/seal", 32)
blob     = 0x01 || 0x02 || eph_pub(32) || nonce(12) || ciphertext || tag(16)
```

A sealed box says nothing about who sent it, so anything needing a sender is also signed (section 6).

Parsers refuse any other format or alg byte. There's no fallback path, so a version can't be rolled back.

### Padding

Item bodies and named fields are padded before encryption:

```
padded = u32(len(data)) || data || zeroes, to bucket size
bucket = smallest power of two >= len+4, at least 256, up to 1 MiB;
         above 1 MiB, the next multiple of 256 KiB
```

`unpad` refuses non-zero padding or a length that doesn't fit.

## 4. Item blob

```
item_blob = 0x01 || lp(wrapped_item_key) || body_blob
wrapped_item_key = symmetric(vault_key, item_key,      aad(vault_id, item_id, "item_key"))
body_blob        = symmetric(item_key,  pad(json(body)), aad(vault_id, item_id, "body"))
```

`item_key` is random per item. Item ids and vault ids are UUIDv4 chosen by the client, so items can be created offline. The body's JSON schema is in `frontend/src/passwords/core/model.ts`. Readers keep unknown fields so an older client doesn't destroy a newer client's data.

Named values (a vault's name, folder lists) are `symmetric(key, pad(json(value)), aad(scope, "", field))`, base64url-encoded.

## 5. Key hierarchy

```
pw_stretched = Argon2id(NFKC(master password), salt, m, t, p)         32 bytes
ikm          = HKDF(pw_stretched || secret_key, empty, "promptly-pw/v1/root",   32)
unlock_key   = HKDF(ikm,                       empty, "promptly-pw/v1/unlock", 32)
auth_key     = HKDF(ikm,                       empty, "promptly-pw/v1/auth",   32)
```

- `secret_key` is 16 random bytes, generated on the client, never sent to the server.
- `unlock_key` wraps the keyset and never leaves the device.
- `auth_key` is sent to the server, which stores `salt` and `HMAC-SHA256(salt, auth_key)`. It reveals nothing about `unlock_key` (independent HKDF outputs).

### Secret Key text form

```
PWK1-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX
```

26 Crockford base32 characters encode the 128 bits (with 2 zero pad bits), then 2 check characters: the first 10 bits of `SHA-256("promptly-pw/v1/sk" || raw)`. Parsers ignore case, spaces and dashes, and read `O` as `0`, `I`/`L` as `1`. A wrong check is an error. "Prove you saved it" means typing the last group.

### Keyset

```
keyset_plain = 0x01 || x25519_sk(32) || ed25519_seed(32)
wrapped      = symmetric(unlock_key, keyset_plain, aad(account_id, "", "keyset"))
```

The account id is a UUIDv4 chosen by the client at setup.

### Master password change

Generate a new salt, derive new keys, re-wrap the keyset, upload the new verifier and wrapped keyset together, with the old `auth_key` as proof. Vault keys don't change. Same path for Secret Key rotation and a KDF upgrade.

## 6. Vault keys and members

```
vault_key = 32 random bytes per vault, per generation
wrapped   = sealed_to(member.x25519_pub, vault_key, aad(vault_id, "", "vault_key:" || member_user_id))
signature = Ed25519(grantor, signing_input("vault_key", [vault_id, member_user_id, decimal(generation), wrapped]))
signing_input(purpose, fields) = "promptly-pw/v1/sig" || 0x00 || lp(purpose) || lp(field)...
```

Clients verify `signature` using the grantor's identity key from their local trust store, before opening the sealed box. A hostile server knows every public key and can seal anything to anyone, but it can't sign. A personal vault is self-signed.

Identity keys are trust-on-first-use, with safety words to compare (section 7). A changed key shows a warning and is not silently accepted.

Removing a member creates a new generation: new vault key, new item keys, every item and retained version re-encrypted by a remaining manager, then uploaded as one batch. See `SECURITY.md` for what that can't undo.

## 7. Safety words

Words come from the EFF large wordlist (7776 words, index order from the file). `word(i) = list[u16(digest[2i..2i+2]) mod 7776]`.

- **Device approval:** `SHA-256("promptly-pw/v1/device-words" || 0x00 || lp(new_device_pub) || lp(approver_pub))`, first 5 words (about 64 bits).
- **Identity:** `SHA-256("promptly-pw/v1/identity-words" || 0x00 || lp(user_id) || lp(x25519_pub) || lp(ed25519_pub))`, first 6 words.

## 8. Adding a device

1. The new device generates an ephemeral X25519 key `D` and posts `D_pub` with a short code.
2. An unlocked device fetches the request and generates an ephemeral key `A`. Both sides compute the words from `(D_pub, A_pub)`. The approver posts `A_pub` first; the new device then shows the same words.
3. Once the person confirms the words match, the approver posts `sealed_to(D_pub, payload, aad(request_id, "", "device_payload"))`. The payload is JSON with the Secret Key and account id, plus `A_pub` so the receiver can check it.
4. The new device opens it, and asks for the master password as usual. The server only ever saw public keys and an opaque blob.

A QR carries the same exchange with no server hop for `D_pub`. The recovery kit path types or scans the Secret Key directly.

## 9. Attachments

A random `attachment_key` per attachment, recorded inside the item's body.

```
chunk_i = symmetric(attachment_key, plain_chunk_i, aad(vault_id, item_id, "att:" || attachment_id || ":" || i || ":" || total))
```

Chunks are 1 MiB of plaintext, with the last one padded to 1 MiB. `total` in the AAD stops truncation; a chunk can't move position.

## 10. Secure Send

A random 32-byte `send_key` in the URL fragment, which browsers don't send to servers. Posting the link through Rooms or Mail does pass it through the server; the screen warns about this, and a password keeps it closed anyway.

```
# Without a password, mix is empty. With one:
stretched = Argon2id(NFKC(password), salt)     # salt: random 16 bytes; 64 MiB, t=3, p=1
proof     = HKDF(stretched, salt, "promptly-pw/v1/send-auth", 32)
mix       = HKDF(stretched, salt, "promptly-pw/v1/send-mix", 32)

enc_key   = HKDF(send_key, mix, "promptly-pw/v1/send", 32)
blob      = symmetric(enc_key, pad(json(payload)), aad(send_id, "", "send"))
```

The server stores `HMAC-SHA256(salt, proof)` and checks it before handing over the blob. `proof` and `mix` are separate HKDF outputs, so what the server sees can't open anything: a stolen database alone can't open a password-protected Send, and neither can the link alone.

## 11. Encrypted export

```
PWEXPORT1 file = JSON { "format": "promptly-pw-export", "version": 1, "kdf": {...}, "salt": b64u, "data": b64u(blob) }
key  = HKDF(Argon2id(NFKC(export password), salt, m, t, p), empty, "promptly-pw/v1/export", 32)
blob = symmetric(key, json(payload), aad("export", "", "payload"))
```

Same KDF limits as section 2.

## 12. Vectors

`vectors.json` has RFC known answers (HKDF, AES-GCM, X25519, Ed25519, Argon2id), and our own formats generated from fixed inputs: Secret Key text, padding, root keys, blobs, sealed boxes, signatures, keysets, item blobs, safety words, and a list of negative cases that must fail. Regenerate only with a format change.
