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
