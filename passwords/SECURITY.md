# Promptly Passwords: threat model

What this protects against, what it doesn't, and how. Written for someone deciding whether to trust it. `CRYPTO_SPEC.md` has the exact formats.

**Status:** this is a preview build. It has had automated tests and AI-assisted review only. It has not had an independent human security audit.

## What's on the server

Opaque blobs, the size of each blob (padded into buckets), timestamps, revision numbers, which user belongs to which vault, public keys, device names you gave, and activity events (device added, vault shared, export) with no item names.

Not on the server: titles, URLs, usernames, passwords, notes, folders, tags, item types, the master password, the Secret Key.

## Attackers

| Attacker | Result | How |
|---|---|---|
| Stolen database dump, backup or off-site restic copy | **Holds** | Ciphertext only. Guessing the master password also needs the 128-bit Secret Key, which was never on the server, so even a weak master password can't be brute-forced from the database alone. |
| Stolen Promptly session (cookie, XSS in another part of the app) | **Holds unless the vault is unlocked in that browser** | Vault endpoints need a vault session, issued only after proving `auth_key`. The vault runs on its own page with its own CSP, and the main bundle never imports vault crypto. See "Web vault" below for what remains. |
| Curious server admin | **Holds** | End-to-end encryption. Admin can't read, can't reset into a vault, can only destroy it. |
| Malicious website | **Holds** | Origin rules, gesture rules, anti-clickjacking checks, extension UI in an isolated iframe, no secret in the page before a fill, and only into visible fields the user chose. |
| Malicious mail content | **Holds** | Mail codes are shown as text and only filled on an explicit click. AI has no path to the vault. |
| Prompt injection in Chat | **Holds** | The vault has no chat tools that read or write secrets. A test asserts this. |
| Lost phone or laptop, locked | **Holds** | Encrypted local cache. OS-backed key wrapping. Auto-lock. Remote device removal stops future sync, not what's already on the device, which stays encrypted. |
| Removed member of a shared vault | **Partly** | Vault key and item keys are rotated. What they already saw can't be unseen, so the app lists the passwords to change. |
| Compromised server shipping malicious web JS | **Does not hold for the web vault** | Inherent to any web client: the next page load could steal the master password. **Holds for the extension, Android and Windows clients**, which never load code from the server. A cautious user should unlock only in those clients. |
| Malware on an unlocked device | **Out of scope** | It can read memory and watch the keyboard. |

## A hostile server against a good client

Beyond reading data, a malicious server could try to:

| Trick | Defence |
|---|---|
| Send weak KDF parameters to make a captured `auth_key` easier to attack | Clients refuse anything below the floor. |
| Send huge KDF parameters to hang a client | Clients refuse anything above the ceiling. |
| Swap blobs between items or vaults | AAD binds each blob to vault, item and field. |
| Replace a vault key with one it knows | Grants are signed by a member's identity key, verified against the client's trust store. |
| Replace someone's public key when sharing | Trust on first use, with safety words to compare, and a warning on change. **A first contact can be intercepted unless people compare words.** |
| Swap device approval keys in the middle | Both sides show words derived from both public keys. |
| Roll back a vault to an old state | Clients remember the highest revision they've seen, and warn on a lower one. **A server can still withhold new changes from a device** without detection, and a brand-new device has nothing to compare against. |
| Forge activity or hide members | Not defended. The member list and activity log are server-reported, though a member the server adds gets no key without a signed grant. |

## Web vault

The vault page is a separate full-page navigation with a stricter CSP than the rest of Promptly (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `frame-ancestors 'none'`). XSS elsewhere in the main app can't reach unlocked keys, because the keys only exist inside that page's memory.

Limits we accept and state plainly:

- It's still the same origin as the main app. Script running in a main-app tab could `window.open('/passwords')`. COOP (`same-origin`) severs the opener link in supporting browsers, so it can't reach into the opened page, but it could navigate a tab, or draw a convincing fake unlock page of its own. **A fake unlock page on the same origin can phish the master password.** It still wouldn't have the Secret Key unless it can also read the IndexedDB copy, which is same-origin. Serving the vault from its own hostname closes this; see the README section on that.
- Same-origin scripts can read and delete the IndexedDB store. It holds only ciphertext and the device's wrapped Secret Key, which needs the master password or platform-held key to be useful.
- Browser extensions with access to the page can read anything on it.

## Extension

- Unlocked keys live in the background context's memory or in `storage.session`, whose default access level is trusted contexts only in both Chrome and Firefox. Content scripts can't read it; a test checks this. `storage.local` is readable by content scripts in Firefox with no way to restrict it, so it never holds keys, only ciphertext.
- No remote code. The extension never loads code from the server.
- A content script runs in a page's process. Treat it as less trusted than the background. Secrets reach it only at fill time and only for fields it has checked.
- Inline UI runs in an extension iframe the page can't read. Each published DOM-clickjacking variant has a test. These checks raise the bar; they're not a proof. As the researcher says, there's no simple complete protection. The safest setting is to fill only from the toolbar popup, offered as "on click" mode.
- Passkey wrapper: runs in the page's MAIN world because that's the only way to intercept `navigator.credentials`. The page can tamper with anything there, so all trust decisions happen in the isolated world.

## Android

- `AutofillService` trusts `webDomain` only from known browsers, verified by signing certificate. Apps are matched by package plus signing certificate through Digital Asset Links.
- No Accessibility service, by design.
- Keystore-wrapped keys, biometric gate, invalidated when biometrics change. `FLAG_SECURE` on secret screens. `allowBackup="false"`.

## Windows

- **Windows Hello here is a convenience gate, not a cryptographic boundary.** The unlock secret is wrapped with DPAPI (bound to the Windows user), and Hello confirms presence. Same-user malware can use DPAPI directly. Microsoft documents no stable secret from Hello, so we don't pretend to have one.
- Auto-type uses `SendInput` after an explicit gesture, checks the target window's title against the item's saved title, and can still type into the wrong thing if a window changes focus at that moment.

## What a removed feature can't protect

- Anything you've filled into a page belongs to that page.
- A shared vault's "fill-only" role hides passwords in the UI. It's not secure against a determined member, since their client holds the key, and the app says so.
- Emergency access opens automatically after the wait period if you don't refuse it. That's the point, and the risk.

## Recovery

If you lose both the master password and the recovery kit, the vault is gone. Nobody can recover it, including the admin. "Reset vault" destroys the data.

## Things that must never happen (tested)

- Secrets, keys, decrypted content or `auth_key` in server logs, error reports, push payloads, analytics, URLs or query strings.
- A plaintext vault field in the database, backups, chat context, memory extraction, search index or Drive index.
- A chat tool or AI feature that reads or changes vault data.
- `encrypt_secret` used for vault content (the server could decrypt it).
