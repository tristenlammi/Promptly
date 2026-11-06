# Promptly Passwords: build plan

Status: written 2026-11-06 against v0.28.0 (Alembic head `0253_mail_folder_labels`, Android 1.4.4 / versionCode 17).
Owner: Tristen. Audience: the Claude session that builds this.

The goal is Promptly's own end-to-end-encrypted password manager, with its own clients on the web, Chrome-family browsers, Firefox, Android and Windows, and iOS later. It must be better than Bitwarden where that can be measured, and do things Bitwarden can't because it lives inside Promptly.

---

## 0. Read this first

### 0.1 How to run this build

Build the whole plan in one run, milestone by milestone (section 14). Keep going without asking, except at the **hard stops** in 0.4. Make reasonable decisions yourself and log them in `passwords/DECISIONS.md`. Facts marked **[verify]** came from secondary sources or memory, so check the primary docs before you rely on them. If one turns out wrong, change the design and log it. Don't force the plan onto a false fact.

### 0.2 Repo rules for this build

`CLAUDE.md` still applies, with these exceptions the owner chose for this work:

- **Work on a `passwords` branch, not `main`.** Use a git worktree so concurrent sessions on `main` aren't disturbed. Prefer the desktop app's worktree for the session. Otherwise use `C:\Projects\Promptly\.worktrees\passwords`, excluded through `.git/info/exclude`. Never work outside `C:\Projects\Promptly`.
- **Commit to the `passwords` branch at each milestone** with `git add <paths>`, never `-A`. **Don't push and don't merge to `main` until the owner says so.** Don't run `scripts/release.*` on the branch; the release happens at merge.
- Gitignored files don't appear in a worktree, so copy `.env` for local use and never commit it. Copy this plan to `passwords/PLAN.md` on the branch and add `!passwords/*.md` to `.gitignore`. All other docs in `passwords/` are tracked the same way.
- Add a `CHANGELOG.md` `[Unreleased]` line as each feature lands.
- Never stage `Promptly-play-*.aab`. They're in the repo root and aren't gitignored.

**Isolated test stack.** The dev stack's containers have fixed names (`Promptly-*`) and share one database. A branch migration applied there would break `main` images, because Alembic can't find the revision. So run a separate stack:

- Use a compose override with its own project name, container names, volumes and port (`:8092`). It needs nginx, frontend, backend, arq-worker, mail-worker, postgres and redis at minimum.
- Check `e2e/lib/stack.ts`, which runs `docker exec` into a named container, and make the name configurable. `E2E_BASE_URL` already selects the instance.

**Migrations.** The next number is `0254_`, and ids must be 32 characters or fewer. `main` may add migrations meanwhile, so check for two heads before any merge.

**Standing safety rules:**

- Never read, enter or test with the owner's real passwords, real vault data or real accounts.
- Don't read or echo `.env` secrets, the Android keystore or `keystore.properties`. `android/build-release.ps1` may use the signing key; never print it.
- Don't touch the owner's documents, mail or Photos data.
- Test credentials go only into local dev hosts.
- Never submit a login form on a public website. The public-site corpus in 13.4 reads the page only.
- Never accept Chrome's first-run terms on the emulator.
- Never run two pytest runs on the same database. Never run pytest with `app.main` preloaded.
- Rebuild `backend`, `arq-worker` and `mail-worker` together, one image build at a time.
- After editing `vite.config.ts`, run `cd frontend && npx tsc -b tsconfig.node.json --force`.

**Licence.** Promptly is MIT and the repo is public. Bitwarden's clients and KeePassXC-Browser are GPL-family, so **don't copy code from them**. Read their docs for ideas only. Permissive sources are fine, with attribution in `passwords/THIRD_PARTY.md`.

### 0.3 What "done" means

Done means all of these:

1. Every Must and Should feature in section 4 is built on web, Chromium, Firefox, Android and Windows.
2. Section 13's test suites pass on the real browsers available, and the whole existing Promptly e2e and pytest suites still pass.
3. `passwords/REPORT.md` says exactly what was tested, how, and what was **not** tested, with no rounding up.

**Done doesn't mean safe for real passwords.** That needs the owner's real-phone checks, a real-browser trial on low-value accounts, and ideally an independent security review (section 15). The app must say so during the trial: show a "Preview" badge and a warning at onboarding until the owner turns it off in admin.

### 0.4 Hard stops

These need the owner. **Don't wait at them.** Build everything around them, then list them all at the end in `passwords/OWNER_STEPS.md`.

| Item | Why it needs the owner |
|---|---|
| Chrome Web Store listing | Developer account and fee. Chrome on Windows won't normally install off-store extensions **[verify]**, so until then it's "Load unpacked". |
| Firefox add-on signing | Mozilla (AMO) API key. Firefox release builds need signed add-ons **[verify]**. Self-distribution stays possible once signed. |
| Edge Add-ons listing | Optional. Edge can install from the Chrome Web Store. |
| Windows code signing | Certificate. Without it, SmartScreen warns on install. |
| Installing new system software | Visual Studio build tools, Edge or Firefox if missing. Ask at the end; meanwhile build the other parts. |
| Real-phone and real-site testing | Agent can't do this. Write a precise checklist. |
| iOS | Needs a Mac or a Mac build service, and a paid Apple developer account. Design only for now. |

Tools confirmed present: rustc and cargo 1.96, node 24, Temurin 17, Android SDK API 37, Gradle, AVD `PromptlyTest`. `dotnet` isn't installed. The MSVC linker hasn't been checked; check it at M9.

---

## 1. What "better than Bitwarden" means

These are targets that can be checked, not slogans.

| Area | Target |
|---|---|
| Server breach | A stolen database and backups can't be brute-forced even with a weak master password, thanks to the two-secret design in 3.2. |
| Metadata | The server can't see titles, URLs, usernames, folders, tags or item types. It sees only opaque blobs, sizes (bucketed) and timestamps. |
| Autofill quality | At least 95% correct on the fixture corpus (13.4), plus local per-site "teach it once" fixes and a signed rules pack. |
| Autofill safety | Passes every published DOM-clickjacking variant in the test suite. No fill without a user gesture by default. Exact-origin rules by default for iframes. |
| Multi-step sign-in | Email-first flows, password-next flows, TOTP screens and split OTP boxes all work in one continuous path. |
| Speed | Popup opens in under 150 ms. Search over 5,000 items takes under 50 ms. Delta sync of one change takes under 1 s. |
| Self-host survival | Works fully offline on every device if the server is down. Warns about missing recovery kits and stale backups. |
| Suite features | Section 5. No standalone password manager can do these. |

Non-goals: enterprise SSO key connectors, SCIM, org policy suites, and a browser-independent app for Linux or macOS. Tauri may make those cheap later, but they're untested here.

---

## 2. Threat model

Write this up in full as `passwords/SECURITY.md`. Summary:

| Attacker | Must hold? | How |
|---|---|---|
| Stolen DB dump, backup or off-site restic copy | **Yes** | Ciphertext only. Two-secret KDF. |
| Promptly session stolen (web XSS elsewhere, stolen cookie) | **Yes, unless the vault is unlocked in that browser** | Isolated vault page (3.6), and a vault auth key is required for ciphertext. |
| Server admin who is curious | **Yes** | E2E. Admin sees nothing and can't reset into a vault. |
| Malicious website | **Yes** | Origin rules, gesture rules, anti-clickjacking, isolated UI. No secrets in the page's JS world until the fill. |
| Malicious mail content | **Yes** | Mail codes are data only, on explicit click. AI has no path to the vault. |
| Prompt injection in Chat | **Yes** | The vault has **no** chat tools that read or write secrets. |
| Lost phone or laptop | **Yes, when locked** | Encrypted local cache. OS-backed key wrapping. Remote device removal. Auto-lock. |
| Member removed from a shared vault | **Partly** | Key rotated. Anything they already saw can't be unseen, so prompt to change those passwords. |
| Compromised server shipping malicious web JS | **No for the web vault, yes for store extension, Android and Windows clients** | Inherent to any web client. Document it plainly. Native clients and the extension never load code from the server. |
| Malware on an unlocked device | **No** | Out of scope. Document it. |

---

## 3. Cryptography and identity

Write the exact format in `passwords/CRYPTO_SPEC.md`, with cross-platform test vectors in `frontend/src/passwords/core/vectors.json`. TypeScript, Kotlin and Rust tests must all consume the same vectors. **No home-made primitives.** Only platform crypto and audited libraries.

### 3.1 Primitives

| Purpose | Choice | Web and extension | Android | Windows (Rust, if needed) |
|---|---|---|---|---|
| AEAD | AES-256-GCM, random 96-bit nonce, per-item keys so no key sees enough messages for nonce risk | WebCrypto | `javax.crypto` | `aes-gcm` |
| KDF | Argon2id | Audited WASM such as `hash-wasm`, evaluate `@noble/hashes` speed | Native Argon2 library via Gradle, or BouncyCastle if fast enough | `argon2` |
| Expansion | HKDF-SHA256 | WebCrypto | BouncyCastle or `javax.crypto` HMAC | `hkdf` |
| Key agreement | X25519 | `@noble/curves` | BouncyCastle (minSdk is 29, and platform X25519 needs newer) | `x25519-dalek` |
| Signatures | Ed25519 | `@noble/curves` | BouncyCastle | `ed25519-dalek` |
| Random | OS CSPRNG | `crypto.getRandomValues` | `SecureRandom` | `getrandom` |

`@noble/hashes` is already a dependency. Pin exact versions of everything, and commit lockfiles.

### 3.2 Key hierarchy: two secrets

Master password **plus** a 128-bit random **Secret Key**, generated on the client. The Secret Key never reaches the server, and is stored on each device (wrapped by OS keystore or browser storage) and in the recovery kit. This is the main difference from Bitwarden: the database alone can't be brute-forced however weak the master password is.

```
pw_stretched = Argon2id(NFKC(master password), salt, m, t, p)
ikm          = HKDF(pw_stretched || secret_key, "promptly-pw/v1/root")
unlock_key   = HKDF(ikm, "unlock")      wraps account keyset, never leaves the device
auth_key     = HKDF(ikm, "auth")        sent to server, which stores only a salted hash

account keyset (random): X25519 + Ed25519, plus personal vault key wrapped to it
vault_key (random, per vault): wrapped per member via X25519 sealed box
item_key  (random, per item):  wrapped by vault_key
```

- Defaults: Argon2id at **64 MiB, t=3, p=1** as a floor. Calibrate upward on setup if the device is quick. Store parameters per account so they can be raised later. Check against current OWASP and RFC 9106 guidance **[verify]**.
- Every encrypted blob is bound to its context through AAD: `{format_version, account_id or vault_id, item_id, field}`. A server can't swap blobs between items without detection.
- Every format has a version byte. Add a rotation path for master password change, Secret Key rotation and KDF upgrade. Master password change re-wraps only, so it's fast.

**The master password is separate from the Promptly login password**, deliberately:
- Promptly's login password reaches the server (bcrypt), so it can't protect E2E data.
- SSO users may not even know their login password (`auth/models.py:20` and `auth/oidc.py`).
- All existing step-up checks are password-based and unusable for those users, so vault operations don't use them. Proof of the vault's `auth_key` is the step-up.

### 3.3 Server authentication

A vault request needs **both**:
- A Promptly identity: a bearer JWT on the web, or a device token for extension, Android and Windows.
- A vault session, issued after proving `auth_key`. Short-lived and revocable.

This means a stolen Promptly session can't download ciphertext.

**Device tokens** are new, not app passwords. App passwords are Basic auth, survive "sign out everywhere", and have scopes capped at 16 characters. Device tokens are opaque and random, stored hashed, scoped to `vault` (with a separate `mail_codes` scope, see 5.1), listed in Account → Devices and in Passwords → Devices, revocable, and revoked by "sign out everywhere".

Add a dependency such as `get_vault_device` in `backend/app/passwords/deps.py`. `get_current_user` is bearer-only and blocks on `must_change_password` (`auth/deps.py:125,140`). Handle `SINGLE_USER_MODE`, disabled users and `token_version`.

The extension calls the API through background fetches with host permissions, so **no CORS change is expected**. The origin list is exact-match, and the admin validator rejects extension schemes (`cors_dynamic.py`, `app_settings/router.py:62`). Confirm by test on both engines **[verify]**. The refresh cookie is `SameSite=strict` on `path=/api/auth`, so it's not an option for clients.

### 3.4 Adding a device

Three ways, all ending with the Secret Key on the device, and the server never seeing it:

1. **Approve from an existing unlocked device (default).** New device shows a code and generates an ephemeral X25519 key. The request appears on existing devices with a push via `notify_user`. Both show the same safety words, derived from the key exchange. On approval, keys travel encrypted to the ephemeral key.
2. **QR from an existing device.** Same exchange, carried by a QR.
3. **Recovery kit.** Type or scan the Secret Key, plus master password.

The extension's connection flow: enter the server URL, request that origin's host permission at runtime via `optional_host_permissions`, open `<server>/passwords/connect?code=…` in a tab, approve in the logged-in session, then device approval as above.

Don't reuse the QR pairing endpoint (`auth/pairing_router.py`), since it issues broad app passwords. Android already has a stored app password for the suite; the vault registers its own device token on top.

### 3.5 Unlock methods

| Method | Where | Notes |
|---|---|---|
| Master password | Everywhere | Always available. |
| Biometric | Android | Keystore key, `setUserAuthenticationRequired`, invalidated on biometric enrolment. |
| Windows Hello | Windows app, and the extension through native messaging | Stage the extension bridge after the desktop app. |
| Passkey with PRF | Web, extension | Chrome and Firefox on Windows look workable. Support varies by authenticator and OS, and Safari reports conflict **[verify]**. Offer it only after a live capability test passes; never make it the only way in. |
| Short PIN | Extension, desktop | Local, session-scoped, wiped after 5 failures. Off by default. |

Lock rules: idle timer (default 15 min), lock on system sleep and browser close by default, per-device setting. Unlocked keys are in memory only. In the extension use `storage.session` with access level set to trusted contexts **[verify in both engines]**.

### 3.6 The web vault is an isolated page

XSS anywhere in the main SPA must not reach an unlocked vault. Promptly renders mail, notes, item-store apps and AI output on the same origin. So:

- Separate Vite entry `frontend/passwords.html`, a **full-page navigation**, not an SPA route in the main bundle.
- Sidebar links do a hard navigation. The main bundle never imports vault crypto.
- Its own response headers: a stricter CSP (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `frame-ancestors 'none'`, no YouTube, no `blob:` scripts), `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Permissions-Policy` with `camera=(self)` for QR scanning.
- The global CSP at `nginx/nginx.conf:234` has **no** `'wasm-unsafe-eval'`, and `camera=()` is set at `:195` and `:278`. Don't weaken the global one; add a location for `/passwords` in nginx and `frontend/nginx.spa.conf`, and check that the headers actually reach the browser.
- Keys in memory only. Wrapped copies in IndexedDB under a separate DB name. Use non-extractable WebCrypto keys where possible.
- Optional: document how to serve it from a separate hostname for maximum isolation. A same-origin popup attack remains possible; note this in `SECURITY.md`.

### 3.7 Sync and storage

- Item = opaque blob. Delta sync via a per-vault revision: `GET /changes?since=rev`.
- Conflict rule: per-field merge where the client can do it, otherwise keep both and show "Conflict: pick one". Never silently lose data. Keep encrypted version history (last 20 versions per item, including password history).
- Pad blobs to buckets to hide size.
- Tombstones and an encrypted 30-day Trash of its own. The existing `trash` app stores plaintext names and can't be used.
- Every client keeps an encrypted offline copy, with an offline edit queue. Web: IndexedDB. Extension: IndexedDB in extension origin. Android: file or Room. Windows: app data file.
- The service worker never caches `/api/` (`sw.ts:89`). Keep it that way. If the vault page is available offline, make sure the navigation fallback serves `passwords.html` and not the main shell.

### 3.8 Recovery

- **Recovery kit:** printable PDF generated client-side (Secret Key, QR, server URL, space to write the master password). Onboarding can't finish until the user confirms saving it and proves it by typing the last group of the Secret Key.
- **Lost both master password and kit:** the vault is gone. Say so before creation, in plain words. **Admin can't recover it.** "Reset vault" requires Promptly login plus MFA plus typed confirmation, and destroys the data.
- **Optional trusted recovery contact:** see Emergency access.
- **Recovery test reminder:** every 6 months, "Do you still have your kit?".

### 3.9 Things that must never happen

Add tests for each:

- Secrets, keys, decrypted content or `auth_key` in server logs, error reports, push payloads, analytics, URLs or query strings.
- Any plaintext vault field in the DB, backups, chat context, memory extraction, search index or Drive index.
- A chat tool or AI feature that can read or change vault data. `backend/app/secrets` (automation credentials) stays separate and must not bridge to the vault.
- Reuse of `encrypt_secret` (`auth/utils.py:218`) for vault content, since the server can decrypt it.

---

## 4. Feature list

**M** = Must, **S** = Should. Both are in this build. **L** = Later: leave design room, don't build. Promptly-exclusive features are in section 5.

### Item types

| Feature | Tier |
|---|---|
| Login: many URLs, username, password, TOTP, passkeys, custom fields, notes, attachments | M |
| Secure note, Credit card, Identity (name, address, phone, for form fill) | M |
| Standalone 2FA code, standalone passkey | M |
| API key, Wi-Fi (shows a join QR), SSH key, bank account, licence/ID document with expiry | S |
| Folders, tags, favourites, archive, custom icons (favicon proxied through the server without identifying the user, off by default per-vault) | M |
| Password history per item, item version history and restore | M |
| Duplicate detection and merge | S |
| Reprompt: require the master password or biometric again for chosen items | M |
| Encrypted attachments: chunked streaming, resumable, size limit configurable, stored under `/app/uploads/...` so off-site backup picks them up (`backups/offsite.py:52`) | S |

### Generators

| Feature | Tier |
|---|---|
| Random passwords, passphrases (EFF large wordlist), PIN | M |
| Site-aware rules from Apple's `password-manager-resources` **[verify licence]** | M |
| Username generator | S |
| Strength meter (`zxcvbn-ts`), local only | M |

### 2FA codes

| Feature | Tier |
|---|---|
| TOTP per RFC 6238: SHA-1/256/512, 6–8 digits, custom period | M |
| Steam Guard format | S |
| Add by QR on the current tab (extension), camera (Android), image paste or upload (web, Windows), or `otpauth://` link | M |
| Copy the code automatically after autofill; fill it on the 2FA page directly | M |
| Import Google Authenticator migration QR (`otpauth-migration://`), Aegis, 2FAS | S |
| Clock drift warning using server time | S |
| HOTP | L |

There's no QR library in the frontend, and `BarcodeDetector` is missing on Firefox and Safari. Vendor a pinned JS decoder such as `jsQR` or a ZXing port.

### Passkeys

| Feature | Tier |
|---|---|
| Create, store and use in the extension (Chrome-family and Firefox) | M |
| Create, store and use on Android 14+ via Credential Manager | M |
| Sync across all clients | M |
| Fallback to the browser or hardware key at any time | M |
| Windows system-level provider (plugin API, 1Password and Bitwarden named as partners; availability unclear) | L, unless M9 finds it generally available **[verify]** |
| PRF extension served to sites | L |
| Vault unlock using a passkey (see 3.5) | S |

### Sharing

| Feature | Tier |
|---|---|
| Multiple vaults: personal plus shared | M |
| Share a vault with Promptly users, roles view / edit / manage | M |
| Fingerprint safety words for identity keys, trust on first use, warn on change | M |
| Removal rotates vault key and lists passwords to change | M |
| Hide password (fill-only) role, clearly labelled as not secure against a determined member | S |
| Secure Send (see 5.5) | S |
| Emergency access (see 5.9) | S |

### Health dashboard ("Security check")

All computed on the client.

| Feature | Tier |
|---|---|
| Weak, reused, old passwords | M |
| Breached passwords via HIBP Pwned Passwords range API, k-anonymity, `Add-Padding: true`, through a server proxy so providers see the server's IP; confirm it's still keyless **[verify]** | M |
| Sites that support 2FA or passkeys but aren't set up (`2fa.directory`, `passkeys.directory`, cached list) **[verify]** | S |
| `http://` logins, and logins with no 2FA | M |
| Email breach monitoring (HIBP paid API key set by admin) | L |

### Import and export

All parsed on the client. Files are never uploaded.

| Source | Tier |
|---|---|
| Chrome, Edge, Firefox, Google Password Manager CSV | M |
| Bitwarden JSON (including password-protected) | M |
| 1Password `.1pux`, LastPass CSV, Dashlane, Proton Pass, Apple Passwords CSV, KeePass XML/KDBX | S |
| FIDO CXF JSON (v1.0 Proposed Standard, March 2026 errata) | S |
| CXP protocol | L |
| Encrypted export (password-protected), and plaintext CSV/JSON behind a typed warning | M |

Import shows a preview, removes duplicates, and fuzzy-parses bad columns. Offer to delete the old browser's passwords with instructions.

### Security and privacy settings

Auto-lock controls, clipboard clear after 30 s (mark sensitive on Android, exclude from history on Windows), screenshot blocking on Android (`FLAG_SECURE`), device list with revoke, account activity log (device added, shared, export) visible to the user, travel mode (hide chosen vaults from a device until back; S), and admin policy (minimum KDF, feature off; no access to data).

---

## 5. What it can do because it's Promptly

These are the reasons to build this instead of using Bitwarden. All are opt-in where privacy is affected. **Server-visible data is called out.**

### 5.1 Email codes and magic links from Promptly Mail (S, top priority of this section)

A sign-in page asks for a code you were just emailed. The fill menu offers "Code from email: 482913 (from Netflix, 40 s ago)". One click fills it, without leaving the page.

- New endpoint scoped `mail_codes`, separate from `vault`. It returns recent likely codes from `MailMessage` for that user only (`mail/models.py:65-100`, `_my_account_ids` at `mail/router.py:80`). Exclude trash, spam and drafts as `chat/tools/mail.py:52-80` does.
- Client sends the page's domain, compared with the sender's domain with the Public Suffix List. The client decides, so the vault's domain list never goes to the server. The page's domain does, when the user clicks. Show "no match" senders with a warning, not as a top suggestion.
- Code extraction is plain heuristics, no AI. Window: 10 minutes. Mail content is untrusted, so it's rendered as text and never auto-fills.
- Magic links: "Open sign-in link from <sender>", with lookalike-domain checks.

### 5.2 One Android app (M)

Passwords is native in the existing `org.promptly.app` APK, with its own launcher icon. There's no second install. Autofill is on after one guided setup, and any Promptly member can get it from their own server.

### 5.3 Family and team sharing with real accounts (M)

Share with people already on your Promptly, chosen through `UserPicker` and `/api/auth/users/directory`. Use a `CalMember`-style member table. Don't use `UserGroup`: it's admin-only, and Calendar doesn't use it either. Invitations arrive as a push and a Rooms DM card. A household "Family" vault is suggested at setup when other accounts exist.

### 5.4 Approve new devices with a push (M)

"Your laptop wants to join your vault. Approve?" with safety words, through `notify_user` (`notifications/dispatch.py:141`). Add a category column and migration, plus a toggle in `NotificationsPanel`. Push content contains no vault data.

### 5.5 Secure Send through Rooms and Mail (S)

Send a password or file with expiry and a view limit. E2E, key in the URL fragment (never reaches the server), public page at `/s/…`, works for people with no account. "Send in Rooms" and "Send by Mail" post the link. Sending the secret as plaintext into Rooms or Mail is impossible by design.

### 5.6 Self-host survival guide (M)

No SaaS password manager needs this, and yours does:
- Warnings in Passwords: recovery kit not confirmed, no off-site backup configured (`backups/offsite.py`), last backup too old, server unreachable for N days.
- A scheduled, encrypted local backup file on Windows and an encrypted export reminder on Android.
- Clear offline behaviour: every device keeps working during an outage, including when the password you need is the one for the server.
- Backups already include new tables through `pg_dump` (`backups/service.py:137`). **Add a test** that a restored dump can be unlocked, and that rotating `SECRET_KEY` doesn't affect the vault.
- "Export my library" walks Drive only (`files/library_export.py`). Add a client-side vault export step to it, with no server plaintext.

### 5.7 Today and Ctrl+K (S)

- **Today card:** "3 passwords need attention". Today has no keys, so the vault page posts **coarse counts only**, opt-in, with the leak explained. Never names. Add through `today/hub.py` and `HubCards.tsx`.
- **Ctrl+K:** "Open Passwords" in `PLACES` (`lib/paletteCommands.ts:195`). Item names can't be searched from the main app, by design. Inside the vault page there's its own palette.

### 5.8 Security-email watch (S)

Promptly Mail sees "your password was changed" and "new sign-in" emails. The client fetches recent sender domains and subjects matching those phrases, and matches them locally against the vault. "Instagram says your password changed. Was that you?" with Change password as the next step.

### 5.9 Emergency access with real notifications (S)

Name a trusted Promptly user and a wait period. They request access; you get push and email (existing SMTP transport) and can refuse. After the wait, they get your vault key, wrapped to them in advance. Without a refusal it opens; a clear warning explains this.

### 5.10 Change-password helper (S)

For one weak or breached login: open the site's change page (`/.well-known/change-password`, or the `password-manager-resources` URL list), fill the current password, generate a site-suitable new one, and save with history. A rotation queue works through the list. It's user-driven at each step, not an AI bot.

### 5.11 Plus-address sign-ups with Mail labels (S)

The generator offers `me+shop@…`, and Promptly Mail automatically files messages sent to that address under a label via a rule. It's an easy way to see who leaked or sold an address. Only works where the provider supports plus-addressing.

### 5.12 Documents with expiry (S)

Move a passport or licence scan from Files into the vault as an encrypted attachment, with an offer to delete the original. An optional Calendar reminder for expiry uses generic wording ("Document expires soon") because Calendar is server-readable. Tell the user this.

### 5.13 Lookalike and new-site warnings (M)

Before filling on a domain close to one in your vault, warn: homoglyphs, punycode, edit distance. Phishing protection that's built into filling. Done on the client.

### 5.14 Promptly's own login (S)

Offer to save the Promptly login and 2FA during onboarding. Warn clearly about keeping the kit, because this is the one credential you need to reach the server.

### 5.15 Deliberately not built

- AI access to vault contents, in any form. A Chat tool that just opens the Passwords page by name is fine; nothing further.
- Server-side search of vault names.
- Bridging to automation secrets.
- An AI that drives sites by itself to change passwords.

---

## 6. The autofill engine

This is the owner's main requirement ("auto fill WELL"), so spend real effort here. It's shared TypeScript in `frontend/src/passwords/core/autofill/`, with no DOM framework. The Android side reuses the matching concepts in Kotlin; `AssistStructure` is a different input.

### 6.1 Finding fields

Score every input using many signals; never rely on a single attribute:
- `type`, `autocomplete`, `name`, `id`, labels, `aria-*`, placeholder, nearby text, form action, button text, and page title.
- Multi-language keywords (at least English, Spanish, French, German, Portuguese, Italian, Dutch, Japanese, Chinese, Korean, Russian, Arabic).
- Visibility, size, position, `disabled`, tab order.

Classify the form as one of: sign-in, email-first, password-next, sign-up, change-password (current, new, confirm), OTP, card, identity, search or newsletter (ignore).

Handle:
- Open and closed Shadow DOM. `chrome.dom.openOrClosedShadowRoot` where available **[verify in Firefox]**.
- Same- and cross-origin iframes, `all_frames: true`.
- SPAs, with a budgeted `MutationObserver`, and route changes.
- Fields inserted late, modals, and tabs.
- Split OTP boxes, including paste-only ones. `autocomplete="one-time-code"`. Masked inputs.
- React, Vue, Angular and Svelte: use the native value setter plus realistic `focus`, `keydown`, `input`, `keyup`, `change` and `blur`. Verify the framework's state changed, since a filled-looking box can be empty to the app. Retry by typing per character if it wasn't accepted.
- Readonly-until-focus inputs, and pages that blank fields on load.

### 6.2 Site matching

- Public Suffix List (`tldts`) base-domain match by default, per-URL options: host, exact, prefix, regex, never.
- Shared-credential site groups from `password-manager-resources`.
- Android package names through Digital Asset Links.
- Never fill a saved `https` login on `http`, unless explicitly confirmed.
- Show best matches first: exact host, then recently used.

### 6.3 Flow across pages

Keep per-tab state (encrypted, session only) so a sign-in continues across pages: username, then password, then 2FA code, with the same item preselected. After login: "2FA code copied" if the next page has no detected field.

### 6.4 Saving and updating

- Catch submits via `submit`, button clicks, `fetch`/XHR success heuristics, navigation, and form disappearance. Don't prompt on failed logins where it can be detected.
- Offer Save, Update or Never for this site. Handle the username on one page and password on the next. Detect sign-up versus sign-in, and generated-password sign-ups: keep the generated password **pending** so a failed submit can't lose it.

### 6.5 Learning

- **Teach it once:** "Wrong field? Pick the username, password and submit." Stored as an encrypted per-user site rule that syncs.
- **Signed rules pack:** a curated JSON shipped in the extension and updatable through extension and app releases. Remote rules are signed; never executable code.
- **"Report this form" (local copy only):** creates a sanitised description of a form's structure, no values, for the owner to review. **No telemetry.**

### 6.6 Security rules

Bake these in and test each (13.5):

- **User gesture required by default.** Click, keyboard shortcut or menu. "Fill on page load" is opt-in per item, and only for exact host, top-level, HTTPS.
- **Inline UI in an isolated extension iframe** (web-accessible resource), so the page can't read or restyle its inside. Host element in the top layer (`popover`), appended last.
- **Anti-clickjacking** covering every published DOM-based variant (extension element opacity, parent or body opacity, overlays with `pointer-events: none`, Popover API tricks, cursor tricks):
  - Before acting: check computed opacity up the ancestor chain, `elementsFromPoint` at the click location, position and size stability, and IntersectionObserver v2 visibility if available.
  - Minimum dwell of about 400 ms between the menu showing and accepting a click. `isTrusted` events only. Any failure downgrades to "Open popup to fill".
  - Cards and identity data **never** fill from inline UI on a single click. They always need the popup or a confirm.
  - Write-up of the research: Marek Tóth, DEF CON 33. Read it, then test more than this summary lists.
- **No secrets in the page until the fill**, and only into the visible fields the user chose. Never hidden or off-screen fields.
- **Iframes:** fill only if the frame's origin matches the item. Same-site different host or a cross-site iframe needs explicit confirmation showing the frame's real origin.
- **Passkey wrapper:** `navigator.credentials` override runs in the MAIN world, since that's the only route **[verify]**, but all trust decisions, RP ID validation and origin checks are in the isolated world. Honour `Permissions-Policy`. Keep native fallback. Chrome and Firefox differ on how the page reaches the extension, so bridge via content script and `postMessage` with strict validation.
- **Site access:** default to all-sites autofill after a clear explanation, and offer "on click" mode. It's the researcher's recommended mitigation, so it should be a first-class setting.

---

## 7. Browser extension

Directory: `passwords/extension/`.

- MV3 for both. Use WXT if it's still maintained, otherwise Vite plus a small manifest generator **[verify]**. Firefox MV3 background differs from Chrome's service worker, so handle both **[verify]**. Expect the Chrome worker to be killed at any time: all state must survive it.
- Extension CSP allows `wasm-unsafe-eval` for Argon2. No remote code, ever.
- **Targets:** Chrome, Edge, Brave, Vivaldi, Opera, Arc (Chromium builds), Firefox desktop. Firefox for Android is S if easy. Safari is L.
- **Surfaces:**
  - Popup: search, current-site matches, TOTP with countdown, generator, add item.
  - Inline menu on fields.
  - Side panel (`sidePanel` / `sidebar_action`) for browsing and editing.
  - Context menu, badge with match count.
  - Keyboard: fill last used, open menu, generate. All rebindable.
  - Full vault page opened inside the extension.
- **Permissions:** the smallest set that works, each justified in `passwords/extension/PERMISSIONS.md` for store review.
- **Offline:** vault works from the local encrypted copy.
- **Native messaging:** to the Windows app for Hello unlock (S).
- **Packaging:** `npm run build:chrome`, `build:firefox`, zips ready for store upload, plus `web-ext lint`.

---

## 8. Web vault

Isolated entry (3.6). Route `/passwords`. Uses Promptly's look: tokens in `index.css:31-112`, accent `#D97757`, `lucide-react`, toasts. Must work at phone width.

Screens: onboarding (explain, create master password with strength meter, recovery kit, import, install extension, set up Android), unlock, All items with folders/tags/search, item view and editor, generator, 2FA codes view, Security check, Shared vaults and members, Sends, Trash, Devices (approve, revoke), Activity, Import/Export, Settings, keyboard palette.

Wiring into Promptly (Mail is the model; see the map in section 12).

The main app gets only: launcher tile, sidebar entry, Ctrl+K place, Today card and Devices list, none with secrets.

---

## 9. Android

In `android/app` (Kotlin, Compose, Material 3, `org.promptly.sync` namespace, `org.promptly.app` id, minSdk 29, target 37). Bump `versionCode` and `versionName` in `android/app/build.gradle.kts`.

- **Native UI, not a TWA.** Secrets don't pass through Chrome. Add a launcher activity with the Passwords icon. Note `:app` has no launcher of its own and `:suite` launchers are generated by `android/gen_suite.py`, which needs Pillow and expects the repo at `/w`. Hand-editing the generated manifest to match the generator has precedent; keep both in step.
- **`AutofillService`:**
  - Parse `AssistStructure`. Match by `webDomain` in browsers, and by package + signing certificate through Digital Asset Links in apps.
  - Inline suggestions on API 30+, with dropdown fallback.
  - Authentication-gated datasets: choosing one opens biometric unlock.
  - `SaveInfo` for save and update.
  - 2FA code copied or offered after login.
  - Refuse to trust `webDomain` from unknown packages: keep an allowlist of browsers with their signing certs.
- **Chrome:** native third-party autofill needs the user to enable "Autofill using another service" in Chrome and pick the provider in system settings. Check the exact versions and any later permission change **[verify; Chrome 131/135 timeline conflicts, Norton page mentions Chrome 142]**. Onboarding guides through this, deep linking where possible. Also cover Firefox, Edge, Samsung Internet **[verify]**.
- **`CredentialProviderService`** (Android 14+): passwords and passkeys through Credential Manager, per the two-phase flow in the official docs. `PendingIntent` needs `FLAG_MUTABLE`, not `FLAG_ONE_SHOT`. Validate request JSON and asset links, biometric prompt before signing. Check the current Jetpack version **[verify]**.
- **Do not use an Accessibility service.** It's a Play policy risk and a security risk.
- **Security:**
  - Keystore-wrapped keys (see `Store.kt:98-127`), `FLAG_SECURE` on secret screens, `allowBackup="false"` (already set), `ClipDescription.EXTRA_IS_SENSITIVE`.
  - Pinned KDF parameters and vectors tested in JVM tests.
- **QR:** `play-services-code-scanner` already exists (`MainActivity.kt:244`).
- **Other surfaces:** Quick Settings tile (S), share-target to add from a URL (S), SMS User Consent API for codes without SMS permissions (S) **[verify]**, autofill for Secure Send links (L).
- **Testing:** `android/app/src/test` has one Robolectric test and `androidTest` doesn't exist. Create instrumented tests (13.6).
- **Release:** `.\android\build-release.ps1` from the repo root. It copies the APK and `Promptly.json` to `frontend/public/downloads/`. Don't print signing details. Don't build a Play bundle unless asked. Note the updater compares `version_code` but doesn't verify `sha256` (`Api.kt:198-206`). Fix that as part of this work, because this app now holds passwords.

---

## 10. Windows

Directory: `passwords/desktop/`. Tauri 2 with the same vault UI from `frontend/src/passwords`, in WebView2.

- **Windows Hello unlock**, with the key wrapped by DPAPI or a Hello-derived key. Check the right Windows API **[verify]**.
- **Tray icon, start with Windows (optional).**
- **Global quick search:** Ctrl+Shift+Space overlay, type to find, Enter to copy or auto-type.
- **Auto-type into native apps:** `SendInput`, explicit gesture only, confirm the target window's title against the item's saved title. It's the only autofill path for non-browser apps.
- **Clipboard:** set the Windows flags that exclude content from clipboard history and cloud sync **[verify]**. Clear after 30 s.
- **Native messaging host** for extension Hello unlock, with strict allowed-origins and a caller check.
- **Local encrypted backup** on schedule (5.6).
- **SSH agent** on `\\.\pipe\openssh-ssh-agent` with per-use approval (S).
- **Windows passkey provider** (L, see section 4).
- **Packaging:** NSIS or MSI. Tauri updater with its own update key (owner holds it; hard stop). Unsigned means SmartScreen warns. Serve from `/downloads` on your server, like the APK, and add to `frontend/public/downloads`, which is already in `globIgnores`. Consider file size against tracking binaries in git; if it's over about 25 MB, ask at the end.

Linux and macOS may build, but stay out of scope and untested.

---

## 11. iOS: design only

Don't build it. Make sure nothing blocks it:

- `CRYPTO_SPEC.md` and vectors are language-neutral.
- The API has no web-only assumptions.
- Passkey data is portable.
- `passwords/IOS_NOTES.md`: `ASCredentialProviderExtension`, AutoFill passkeys, Secure Enclave wrap, what's needed (Mac or cloud Mac, Apple account), and the size of the job.

---

## 12. Backend and integration map

New module `backend/app/passwords/` (`models.py`, `router.py`, `deps.py`, `service.py`, `mail_codes.py`). Everything mounted at `/api/passwords/*`.

### Tables (migration `0254_passwords_core` and on)

| Table | Holds (all crypto material opaque) |
|---|---|
| `pw_accounts` | user_id, KDF params, salt, auth_key salted hash, wrapped keyset, public keys, format version |
| `pw_devices` | user_id, name, platform, token hash, scope, last seen, revoked_at |
| `pw_device_requests` | ephemeral public key, code, status, expiry, encrypted payload |
| `pw_vaults` | id, kind (personal/shared), revision, encrypted name |
| `pw_vault_members` | vault_id, user_id, role, wrapped vault key |
| `pw_items` | id, vault_id, revision, blob, size bucket, deleted_at, updated_at |
| `pw_item_versions` | item_id, revision, blob (capped per item) |
| `pw_changes` | vault_id, revision, item_id |
| `pw_attachments` | item_id, chunks, blob path, size |
| `pw_sends` | id, blob, expiry, views left, password verifier, disabled_at |
| `pw_emergency` | grantor, grantee, wrapped key, wait period, state |
| `pw_activity` | user_id, event, device_id, when. No item names. |
| `pw_health` | user_id, coarse counts (opt-in) |

### Rules

- Rate-limit `auth_key` proof attempts strictly (like `login` in `config.py:174-214`). Note nginx's 30 r/s and the default 900/min per IP, so bulk sync uses delta batches.
- Enforce blob size caps. Body limit is `client_max_body_size 100M`, so large attachments must chunk.
- User deletion cascades. Removing a member rotates keys.
- Add a logging filter test: nothing from `/api/passwords` request bodies reaches logs.

### Touchpoints

From the code map at v0.28.0. Line numbers will drift; confirm them.

| What | Where |
|---|---|
| Router mount | `backend/app/main.py:676-695` (pattern) |
| Models for Alembic | `backend/app/db_models.py:74-106` (pattern) |
| Background loops (sweep expired Sends and requests) | `main.py` lifespan `:94-96`, cancel tuple `:154-166` |
| Lazy routes and gate | `frontend/src/App.tsx:275-292,685-688`. Sidebar link is a hard navigation. |
| PWA manifest | `frontend/public/mail.webmanifest` pattern. Selection: `frontend/nginx.spa.conf:6-13`, `sw.ts:66-75`, `hooks/useDrivePwaManifest.ts:59-63`, `lib/installPrompt.ts:101` |
| Install page | `items/InstallAppsPage.tsx:63-67,94` |
| Sidebar app | `items/navApps.ts:24-29` |
| Icons | `frontend/scripts/gen-item-icons.cjs:19-38`, then `node scripts/gen-item-icons.cjs passwords` from `frontend/` |
| Android launcher | `android/gen_suite.py:11-31`, but this one's native, see section 9 |
| Ctrl+K | `lib/paletteCommands.ts:195` |
| Today | `today/hub.py:568-575`, `components/today/HubCards.tsx`, `pages/TodayPage.tsx:122,175` |
| Push | `notifications/dispatch.py:87-103,141`, column in `notifications/models.py:94-133`, toggle `components/account/NotificationsPanel.tsx:323` |
| Service worker | `globIgnores` in `vite.config.ts`, because new chunks are precached by default. `.wasm` isn't in the precache glob, so add it for offline unlock. |
| Devices UI | `components/account/DevicesPanel.tsx` |
| Admin | feature toggle, Preview badge off-switch, policy |

Known gaps in Mail's wiring, so don't copy them: `nginx.spa.conf:56` omits `mail` from its manifest regex, `sw.ts:304,309` omits it from the push-click scope list, and Mail isn't in `PLACES`.

### Shared code layout

```
frontend/src/passwords/core/       Crypto, vault model, sync, TOTP, generators, importers, autofill. No React.
frontend/src/passwords/ui/         React vault UI.
frontend/passwords.html            Isolated entry.
passwords/extension/               Imports core by path alias.
passwords/desktop/                 Tauri; uses the UI.
passwords/test-sites/              Fixture forms (13.4).
passwords/*.md                     PLAN, CRYPTO_SPEC, SECURITY, DECISIONS, REPORT, OWNER_STEPS, THIRD_PARTY, IOS_NOTES.
```

Core lives under `frontend/` because the frontend image's Docker context is that folder. Confirm against `docker-compose.yml`.

---

## 13. Testing

Write tests with each feature. Report honestly in `REPORT.md`.

### 13.1 Crypto

- Vectors pass identically in TS, Kotlin and Rust.
- Known-answer tests for Argon2id, AES-GCM, HKDF, X25519, Ed25519, against RFCs where they exist.
- Negative tests: tampered ciphertext, swapped AAD, wrong key, rollback of version, blob moved between items.
- Property tests on format encode and decode. Fuzz importers with malformed files.

### 13.2 Server can't read

**The canary test.** Create items using distinctive canary strings in every field. Then search the whole Postgres dump, all logs, Redis keys, the uploads folder, push payloads, and a real backup file. Zero hits, or the build fails. Also run the matching test: server-side code paths never receive canaries.

### 13.3 Backend

Follow `backend/tests/conftest.py`, the client pattern in `tests/test_device_pairing.py:14-30`, unique `TEST_DATABASE_URL` per run. Cover: authorisation across users on every endpoint, removed members, revoked devices, sign-out-everywhere, rate limits, sync conflicts, cascade delete, backup restore unlock, and `SECRET_KEY` rotation.

### 13.4 Autofill corpus

`passwords/test-sites/` serves on several local origins (ports and `*.localhost` names) for cross-origin testing. At least **100 fixtures** written from scratch to reproduce patterns in the wild: email-first, Google-like and Microsoft-like multi-step, modals, Shadow DOM (open and closed), iframes (same-site, cross-origin, nested), React, Vue, Angular and Svelte controlled inputs, split OTP, change-password, sign-up, hidden honeypots, multi-language, delayed rendering, and search and newsletter forms that must not trigger. Each has expected classification and outcome. Target at least 95%, no false fills on negative cases. Print results per browser.

**Public-site read-only check.** Load a list of about 100 public login pages, run only the classifier, record what it found, don't type or submit anything. Treat it as a smoke test, since sites change. Don't save third-party page contents in the repo. Note failures in `REPORT.md`.

### 13.5 Adversarial browser suite

Hostile fixture pages for:
- Every DOM clickjacking variant.
- Hidden and off-screen fields. Cross-origin iframe stealing. Autofill-then-read scripts.
- Origin confusion: subdomains, punycode, `user@host` URLs, data URLs, about:blank frames, `http` downgrade.
- Fake extension messages via `postMessage`. MAIN-world prototype tampering. Passkey RP ID spoofing, and `Permissions-Policy`.
- XSS probes in every field in the vault UI. Malicious imports. Malicious mail for codes.

Each must fail safely.

### 13.6 Per-platform matrix

| Target | How | Notes |
|---|---|---|
| Web vault, Chromium, Firefox, WebKit | Separate Playwright config, e.g. `e2e/passwords.config.ts`, with three projects. Main suite stays Chromium only. | Run offline and PWA checks with service workers **on**. The main config blocks them. Pace API use (`workers: 1`, 30 r/s). |
| Extension, Chromium | Playwright `launchPersistentContext` with `--load-extension`, and new headless or headed | Chrome-branded builds may ignore `--load-extension` **[verify]**, so use Playwright's Chromium |
| Extension, Edge | Playwright `channel: "msedge"` if installed | |
| Extension, Brave, Vivaldi, Opera | Only if already installed. Otherwise "not tested" in the report; they share the Chromium engine. | |
| Extension, Firefox | Selenium + geckodriver with `installAddon(path, true)` | Playwright support for Firefox extensions is weak or unclear. Share fixtures and expectations across both drivers. |
| Android | JVM tests plus `androidTest` on AVD `PromptlyTest` (`-s emulator-5554`), using UI Automator and a small test app with sign-in forms and a WebView | Chrome on the emulator is blocked by terms acceptance. That part goes to the owner's checklist. |
| Windows | Rust unit tests. `tauri-driver` with WebView2 driver for UI. Mock Hello. | Hello, tray and auto-type with real apps: manual checklist where automation can't reach. |
| Cross-device | Create on web, edit in extension and Android, conflict while offline, share to `e2e_bob`, revoke | All clients against the same test server |

Use `e2e_alice`, `e2e_bob` and `e2e_dana` from `seed/seed.py`. E2E sign-in uses minted tokens, so the master password flow gets its own test account or fixture.

### 13.7 Performance

Seed 5,000 items: measure unlock (after KDF), search, popup open, delta sync, Android dataset response (under 1 s; system timeouts apply **[verify]**), and memory.

### 13.8 Regression and static checks

- Whole `cd e2e && npx playwright test` and backend pytest (full run takes about 86 minutes; run at the end). A couple of photo tests are timing-sensitive under load; re-run them alone before calling them real.
- `tsc`, frontend build, `web-ext lint`, `cargo clippy`, Android lint.
- Dependency audit, licence check, and secret scan of the branch (including `MAPS_TRAFFIC_KEY`).
- Bundle check: main SPA chunks contain no vault crypto.
- CSP check: real response headers at `/passwords` and everywhere else.

### 13.9 Independent review pass

Before finishing, get adversarial reviews from fresh-context subagents, given the code rather than your conclusions, one each for crypto, extension and autofill, Android, backend authorisation. Fix what's real. Record findings and outcomes in `REPORT.md`. This doesn't replace a human audit.

---

## 14. Milestones

Each ends with passing tests and a branch commit. Don't start the next until the current one's tests pass, unless blocked by a hard stop.

| # | Milestone | Exit criteria |
|---|---|---|
| M0 | Setup: worktree, branch, isolated stack, `passwords/` docs, verify all **[verify]** items and log results | Stack up on `:8092`, `main` undisturbed |
| M1 | Crypto core and spec, vectors in TS | 13.1 passes in TS |
| M2 | Backend: tables, auth, devices, sync, sharing keys, activity | 13.3 passes, canary test passes with API-driven data |
| M3 | Web vault: isolated entry, CSP, onboarding, kit, items, generator, TOTP, search, offline, Promptly wiring | Three-browser Playwright passes |
| M4 | Import/export, Security check, breach proxy, Trash and history | Fuzz plus fixtures pass |
| M5 | Autofill engine and corpus (classifier first, no extension) | Corpus at least 95% in a test harness on Chromium and Firefox |
| M6 | Extension: connect, unlock, popup, inline, fill flow, save/update, TOTP, learning, side panel | Chromium and Firefox suites pass, adversarial suite passes |
| M7 | Passkeys in web model and extension | Local WebAuthn test site passes on both engines |
| M8 | Android: native vault, Autofill, Credential Manager, biometric, QR | `androidTest` passes, APK builds, updater hash check |
| M9 | Windows: Tauri app, Hello, quick search, auto-type, native messaging, backup | Rust tests and driver tests pass, installer builds (or hard stop logged) |
| M10 | Sharing UI, device approval push, Secure Send, emergency access | Cross-user e2e passes |
| M11 | Promptly-exclusive: email codes, security-email watch, change helper, plus-address, documents, Today, Ctrl+K, self-host warnings | Each has tests; server-visible data matches what section 5 says |
| M12 | Hardening: canary across everything, adversarial suite on all targets, performance, fresh-context reviews, whole regression | 13.x all done |
| M13 | Write `REPORT.md`, `OWNER_STEPS.md`, user guide, `IOS_NOTES.md`, memory update | Branch commit. Stop and report. **Don't merge or push.** |

If context runs out, resume from `passwords/DECISIONS.md` and the last milestone commit. Keep those two up to date as you go.

---

## 15. After the build: for the owner

The agent produces this as `OWNER_STEPS.md`. Expected contents:

1. Read `REPORT.md`, especially the "not tested" list.
2. Decide whether to push the branch, then merge and release (likely a minor version).
3. Set up store accounts and signing.
4. Real-device checks: Android Chrome and app autofill, passkeys, biometric; Windows Hello; real browsers.
5. **Trial with low-value accounts for a few weeks.** Autofill failures show up on real sites only, so use the "teach it" and report features to feed the rules pack.
6. Print the recovery kit and test recovery on a clean device **before** adding anything important.
7. Consider a paid independent security review before moving primary accounts or inviting family. The repo is public, so reviewers and anyone else can read it.
8. Remove the Preview badge only after 5–7.

---

## Sources

Used while writing this. Several are secondary, which is why **[verify]** items exist.

- Android Credential Manager provider: https://developer.android.com/identity/sign-in/credential-provider
- Chrome on Android third-party autofill: https://android-developers.googleblog.com/2024/10/chrome-3p-autofill-services.html and https://developers.googleblog.com/chrome-3p-autofill-services/
- Norton note on Chrome 142: https://support.norton.com/sp/en/us/home/current/solutions/v20251015074832768
- DOM-based extension clickjacking: https://thehackernews.com/2025/08/dom-based-extension-clickjacking.html and https://marektoth.com/blog/dom-based-extension-clickjacking/
- Windows plugin passkey managers: https://learn.microsoft.com/windows/apps/develop/security/third-party
- WebAuthn PRF: https://www.corbado.com/blog/passkeys-prf-webauthn and https://bugs.webkit.org/show_bug.cgi?id=311099
- Credential Exchange Format: https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html
- Extension test tooling: https://github.com/microsoft/playwright/issues/7297 and https://www.selenium.dev/selenium/docs/api/javascript/module-selenium-webdriver_firefox-Driver.html
- Extension passkey architecture: https://contributing.bitwarden.com/architecture/deep-dives/passkeys/implementations/provider/browser-extension (ideas only, see licence note) and https://scotthelme.co.uk/passkeys-permissions-policy-and-bug-hunting-in-1passwords-webauthn-wrapper/
- MDN WebAuthn in extensions: https://developer.mozilla.org/de/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api
- Pwned Passwords: https://www.troyhunt.com/understanding-have-i-been-pwneds-use-of-sha-1-and-k-anonymity/
- Argon2 guidance (secondary, confirm against RFC 9106 and OWASP): https://mojoauth.com/security-guides/argon2-vs-pbkdf2.md
