# Third-party material in Promptly Passwords

Promptly is MIT. Only permissive sources are used here. No code was copied from Bitwarden, KeePassXC or other GPL projects; their docs were read for ideas only.

## Libraries (npm, pinned)

| Package | Version | Licence | Used for |
|---|---|---|---|
| hash-wasm | 4.12.0 | MIT | Argon2id |
| @noble/curves | 2.4.0 | MIT | X25519, Ed25519 |
| @noble/hashes | ^2.4.0 (already in Promptly) | MIT | Cross-check of Argon2id in tests |
| jsqr | 1.4.0 | Apache-2.0 | QR decoding |
| qrcode | 1.5.4 | MIT | QR encoding (recovery kit, Wi-Fi) |
| @zxcvbn-ts/core, language-common, language-en | 4.2.0, 4.1.3, 4.1.1 | MIT | Strength meter |
| tldts | 7.4.19 | MIT | Public Suffix List matching |
| fflate | 0.8.3 | MIT | Reading `.1pux` and other zip imports |

## Data

| Data | Licence | Attribution |
|---|---|---|
| EFF Large Wordlist | CC BY 3.0 US | Electronic Frontier Foundation, https://www.eff.org/dice. `frontend/src/passwords/core/eff_large_wordlist.json` is the list reformatted as JSON. |
| Have I Been Pwned breach data (breach alerts) | CC BY 4.0 | Troy Hunt's Have I Been Pwned, https://haveibeenpwned.com. Credited with a link in the Security check's Breaches section, and in each alert. Fetched at run time with the admin's key, not bundled. |

## Windows app (`passwords/desktop/`)

No third-party source was copied. A licence scan of all 333 cargo packages found no GPL.

- Rust: tauri 2.12.5 and tauri-build, its global-shortcut, single-instance and updater plugins (Apache-2.0 OR MIT); reqwest, tokio, serde, windows, zeroize (MIT or Apache-2.0); RustCrypto aes-gcm, argon2, hkdf, hmac, sha1, sha2 (MIT or Apache-2.0); x25519-dalek, ed25519-dalek (BSD-3-Clause); unicode-normalization (MIT or Apache-2.0).
- Transitive, unmodified, MPL-2.0: cssparser, cssparser-macros, dtoa-short, selectors, option-ext.
- JS: `@tauri-apps/api` 2.12.4 (Apache-2.0 OR MIT). Dev only: selenium-webdriver (Apache-2.0).

## Android

- ZXing core 3.5.3 (Apache-2.0), for QR codes. argon2kt (MIT) and BouncyCastle (MIT), for key stretching, and BouncyCastle for KeePass's ciphers. See `android/app/build.gradle.kts` for exact versions.
- `android/app/src/main/assets/apps.json`: Google's list of browsers for Credential Manager (Apache-2.0, from the Credential Manager samples). Check its terms before a Play release.
- The Android importers (`ImportFormats.kt`, `Kdbx.kt`, `SafeXml.kt`, `SafeZip.kt`) were written from `importers.ts` and `kdbx.ts`, the formats' public documentation and the zip and KDBX specifications. No code from KeePassXC, KeePassDX, Bitwarden or pykeepass.

## Web, core and extension

- Apple `password-manager-resources` rules and change-password URLs (MIT), at the commit in `frontend/src/passwords/core/data/APPLE-COMMIT.txt`.
- `@noble/ciphers`, `@noble/hashes`, `@noble/curves` (MIT).
- EFF large wordlist (CC BY 4.0 per EFF's site notice; EFF's page says CC BY 3.0 US on older copies, so credit is given either way).
- 2FA Directory data by 2factorauth (MIT for code, CC BY 4.0 for data, shown with credit in Security check), and Passkeys Directory.
- `jsqr` (Apache-2.0), `qrcode` (MIT).

Dev only: `@simplewebauthn/server` (MIT), `selenium-webdriver` (Apache-2.0), `web-ext` (MPL-2.0), `pykeepass` for test fixtures (GPL-3.0: `frontend/src/passwords/core/testing/fixture.kdbx`, and `android/app/src/test/cross/import-fixtures/*.kdbx` by `make-kdbx-fixtures.py`, which runs it in a throwaway container. Used only to make files in tests, not linked, shipped or copied from).
