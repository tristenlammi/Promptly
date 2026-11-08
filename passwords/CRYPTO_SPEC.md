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

Every edit sets `seq = max(prev.seq, next.seq) + 1` in the body, and a merge takes the larger plus one. A client refuses a body with a lower `seq` than its own copy: the revision is the server's word, and this isn't.

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

Clients verify `signature` using the grantor's identity key from their own trust book, before opening the sealed box. A hostile server knows every public key and can seal anything to anyone, but it can't sign as someone you've chosen to trust. A personal vault's grant must be signed by its owner. A signer who isn't in the trust book means the vault stays shut, with a prompt.

Identity keys are trust-on-first-use, with safety words to compare (section 7). A changed key shows a warning and is not silently accepted.

### Trust book

A system item of kind `trust` in the personal vault, in the same format as any item, so it syncs and the server can't read or alter it. Its body carries three fields:

```
trustBook = {
  people:      { user_id: { x25519, ed25519, firstSeen, verified?, username? } },
  accepted:    [ vault_id ],   // shared vaults this person chose to open
  contacts:    [ user_id ],    // emergency contacts named now (kept for older clients)
  generations: { vault_id: n } // highest vault key generation seen
}
trustState = {                 // beside trustBook: older clients rebuild trustBook and would drop new fields
  contacts: { user_id: n },    // odd = named, even = removed; the higher number wins on merge
  made:     [ vault_id ],      // vaults this person made themselves; only grows
  shared:   [ vault_id ]       // of those, ones they've ever added someone to; only grows
}
homeSig = b64u(Ed25519(identity, signing_input("personal_vault", [user_id, vault_id])))
          // vault_id is the vault this item is in
```

Merging: `people`, `accepted` and `generations` as before (union, highest generation). Contact counters take the highest per person; a contact in a plain `contacts` list with no counter counts as 1 (named). Naming someone moves an even counter to the next odd one; removing moves an odd one to the next even one. So a removal on one device isn't undone by another device's older list.

### Your own vault

What the server calls a vault (`kind: "personal"` or `"shared"`) is never trusted. A shared vault you made has a grant signed by you, and every member holds its key, so "self-signed and called personal" doesn't make a vault yours. Each device keeps its own list of vaults it knows are yours (`own_vaults`, local only):

1. The device that made the account pins the vault it made.
2. A device from before this rule pins, once, the vault it last saved to (`personal_vault`), or else the one self-signed vault it already had cached as personal, if there was exactly one.
3. Any device adds a self-signed vault holding a trust item whose `homeSig` verifies under your own identity key for that vault's id. No member or server can make one, and it can't be moved: it names the vault. Every device with a pinned vault writes it on its next sync if it's missing.

Trust items are read only from pinned vaults, and written only to them. A pinned vault the server calls anything else, or another self-signed vault the server calls personal once one is pinned, is a rollback warning; the pinned one stays yours and the other is treated as shared. A device with nothing pinned yet (new, before any of your devices has signed) saves new items to the one vault called personal, as before, but reads no trust book from it, writes none to it, and seals no emergency keys.

`homeSig` is a new signed statement, not a change to any existing blob, grant or signature, so older clients read and keep it (an unknown body field) and the format stays 1. Binding `kind` into the grant signature instead would have needed every vault re-granted and a server change.

Rules every client follows:

- A person's keys are remembered only when they act: accepting an invitation, adding a member, naming a contact, marking safety words as checked. Never from a background sync.
- A vault opens only if it's self-granted or in `accepted`. The server's own flag doesn't count.
- Emergency keys are sealed only to someone named by their contact counter, only while their live keys match what's remembered and their words have been compared, and only for your pinned vault plus vaults in `made` and not in `shared`. A member count from the server doesn't count.
- Every recipient of a rotation goes through the same check, and your own key comes from your keyset, not the list.
- A lower `member_generation` than the highest seen is refused and warned about.

### Removing someone

`DELETE /vaults/{id}/members/{user}` first, which cuts access at once and flags the vault as needing a new key. Then the rotation below, with `remove_user_ids` empty. Items nobody can read are purged, so junk from a member can't block it.

Removing a member creates a new generation: new vault key, new item keys, every item and retained version re-encrypted by a remaining manager, then uploaded as one batch. See `SECURITY.md` for what that can't undo.

## 7. Safety words

Words come from the EFF large wordlist (7776 words, index order from the file). `word(i) = list[u16(digest[2i..2i+2]) mod 7776]`.

- **Device approval:** `SHA-256("promptly-pw/v1/device-words" || 0x00 || lp(new_device_pub) || lp(approver_pub))`, first 5 words (about 64 bits).
- **Identity:** `SHA-256("promptly-pw/v1/identity-words" || 0x00 || lp(user_id) || lp(x25519_pub) || lp(ed25519_pub))`, first 6 words.

## 8. Adding a device

1. The new device generates an ephemeral X25519 key `D` and posts `D_pub` with a short code.
2. An unlocked device fetches the request and generates an ephemeral key `A`. Both sides compute the words from `(D_pub, A_pub)`. The approver posts `A_pub` first; the new device then shows the same words.
3. Once the person confirms the words match, the approver posts `sealed_to(D_pub, payload, aad(request_id, "", "device_payload"))`. The payload is JSON with the Secret Key and account id. Sealed boxes are anonymous, so this payload proves nothing by itself; see the next step.
4. The new device opens it, and asks for the master password as usual. Before anything derived from that password is sent, it unwraps `wrapped_keyset` (from prelogin) locally. A Secret Key a server made up can't open it, so a forged payload gets nothing. The server only ever saw public keys and an opaque blob.

A QR on the new device's screen carries `pwdev:<request id>:<D_pub>`, which the approver compares with the server's copy, so `D_pub` is bound out of band. The recovery kit path types or scans the Secret Key directly.

## 9. Attachments

A random `attachment_key` per attachment, recorded inside the item's body.

```
chunk_i = symmetric(attachment_key, plain_chunk_i, aad(vault_id, item_id, "att:" || attachment_id || ":" || i || ":" || total))
```

Each plain chunk is a 4-byte big-endian length, then up to 1 MiB of plaintext, with the last one padded to the full size. `total` in the AAD stops truncation; a chunk can't move position.

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

`vectors.json` has RFC known answers (HKDF, AES-GCM, X25519, Ed25519, Argon2id), and our own formats generated from fixed inputs: Secret Key text, padding, root keys, blobs, sealed boxes, signatures (a vault key grant, and the `personal_vault` statement), keysets, item blobs, safety words, and a list of negative cases that must fail. Regenerate only with a format change. The `personal_vault` vector was added on 2026-11-08; regenerating left every other vector byte for byte as it was.

## 13. Browser sync

Open tabs, sent tabs, history and the reading list (SYNC.md). An addition, not a change: nothing above is different.

```
sync_key = HKDF(personal_vault_key, utf8(personal_vault_id), "promptly-pw/v1/browser-sync", 32)
blob     = symmetric(sync_key, pad(json(record)), aad(personal_vault_id, kind || ":" || device || ":" || slot, "browser-sync"))
```

- `personal_vault_key` is the raw key of the current generation of this person's own personal vault, never a shared vault's.
- `kind` is `tabs`, `history`, `reading` or `sent`. `device` is the device id the server stores with the record (the publishing browser for tabs and history, the receiving device for sent), or empty for the reading list. `slot` is empty for tabs, `YYYY-MM-DD` for a history day, and the record's own id for reading and sent.
- Records are JSON with `"v": 1`; readers check the shape and refuse anything else, and only `http` and `https` addresses are used.
- `frontend/src/passwords/core/browsersync.test.ts` and the Android `BrowserSyncTest.kt` open the same fixed sent-tab blob.
