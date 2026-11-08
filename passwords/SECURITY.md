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
| Malicious website | **Partly** | Origin and gesture rules, and an isolated extension frame. On Chromium an inline click counts only if the browser reported the frame visible for 300 ms before the press. On Firefox the inline menu and save bar never fill or save: a click there opens the toolbar panel with that login or question at the top, and the panel fills or saves on one more click, which it only takes from a person who's moved to it. Values go only into boxes at least 10x10 that are on screen and on top at their centre. An independent review broke the first version of these. They raise the bar and aren't a proof. |
| Malicious mail content | **Mostly** | Codes are shown as text, offered only when the sender's domain matches the page, and fill on a click. AI has no path to the vault. A sender's domain is only the From header, with no DKIM or SPF check, so a forged From on a real site's domain can offer a sign-in link to that site, which could sign someone into an attacker's account. A link always asks first. |
| Prompt injection in Chat | **Holds** | The vault has no chat tools that read or write secrets. A test asserts this. |
| Lost phone or laptop, locked | **Holds** | Encrypted local cache. OS-backed key wrapping. Auto-lock. Remote device removal stops future sync, not what's already on the device, which stays encrypted. |
| Lost laptop, browser set to Never lock | **Does not hold** | Never is the owner's choice, and warned about when it's made. The key to the vault stays on the computer, so whoever gets into that browser or its files has the vault and can sign in with its passkeys. Removing the device locks it the next time it reaches the server, which a thief can avoid by staying offline. Choosing Never asks for no password, as in Bitwarden, so anyone at a browser that's unlocked can turn it on and keep access until the next Lock. |
| The extension's lock timing | **Partly** | "When the browser closes" depends on the browser really stopping. If it stays running in the background with no windows, the vault stays unlocked. Lock on sleep notices a sleep of over 3 minutes on Firefox, which doesn't report a locked screen, so a shorter one goes unseen. |
| Removed member of a shared vault | **Partly** | Vault key and item keys are rotated. What they already saw can't be unseen, so the app lists the passwords to change. |
| Trusted contact, with the server on their side | **Does not hold** | Emergency keys are sealed to them in advance, and the wait is kept by the server, so someone who runs the server and is your contact could skip the wait. Pick someone you'd trust with it all. |
| Secure Send link posted through Rooms or Mail | **Partly** | The link holds the key and passes through the server this way, and the screen warns about it. With a password, the server can still try guessing it offline, at the cost of the key stretching. Without one, it can just open it. Copying the link somewhere end-to-end encrypted avoids this. Chat tools and @promptly never see the key part of a link. |
| Compromised server shipping malicious web JS | **Does not hold for the web vault** | Inherent to any web client: the next page load could steal the master password. **Holds for the extension, Android and Windows clients**, which never load code from the server. A cautious user should unlock only in those clients. |
| Malware on an unlocked device | **Out of scope** | It can read memory and watch the keyboard. |

## A hostile server against a good client

A review that ran the real client against a hostile server found that the first version trusted the server about who your contacts were, who'd signed a key, who the members were, and which key generation was current. Those are fixed: `frontend/src/passwords/core/hostile.test.ts` holds each attack, and they must fail. The rule now is that decisions about trust are made by you on your own devices, and kept encrypted in your personal vault where the server can't change them.

| Trick | Defence |
|---|---|
| Send weak KDF parameters to make a captured `auth_key` easier to attack | Clients refuse anything below the floor, or below what they've already seen. |
| Send huge KDF parameters to hang a client | Clients refuse anything above the ceiling. |
| Swap blobs between items or vaults | AAD binds each blob to vault, item and field. |
| List a made-up emergency contact | Keys are only ever sealed to a contact you named on one of your own devices, on the keys you saw then. |
| Offer a vault key it knows, as a vault of yours or a shared one | Your own vault's grant must be signed by you. A vault from anyone else stays shut until you accept it, and what the server says about acceptance doesn't count. A signer you've never dealt with gets a prompt, not silent trust. |
| Replace someone's public key when sharing | Trust on first use, with safety words to compare, and a warning on change or when a known name turns up under other keys. **A first contact can be intercepted unless people compare words.** |
| Change the member list so a new vault key goes to someone else | Every recipient goes through the same check. A changed key stops it, and anyone you haven't dealt with is shown to you first. |
| Bring back an old vault key after someone's removed | Clients remember the highest key generation seen per vault, including across your devices, and refuse a lower one. |
| Serve an old copy of an item | Each item carries a counter inside the encryption, and a lower one is refused. |
| Hand a new device a Secret Key of its own, to learn something about the master password | The client opens the keyset locally before anything derived from the password is sent. |
| Claim a different account, to wipe a device's trust and unsynced edits | Nothing's wiped unless the new keyset really opens. |
| Swap device approval keys in the middle | Both sides show words derived from both public keys, and the QR route binds the new device's key out of band. |
| Roll back a vault to an old state | Clients remember the highest revision they've seen, and warn on a lower one. |

What it can still do, stated plainly:

- **Withhold or destroy.** It can hide new changes from a device, or delete or tombstone anything. Encryption can't stop that, which is why exports and more than one device matter. A forged delete can remove an item from a device's copy.
- **A member working with the server.** Grants aren't checked against a signed member list, so someone you've already accepted keys from, if they also control the server, could give you a vault key they know for a vault they're in. Items have no author signature either, so a view-only member working with the server can forge items in that vault.
- **Safety words are a finite comparison.** Device approval words are about 2^64 of search, which is a lot in the 15 minutes a request lasts, but not a proof. The QR route doesn't have this limit.
- **Your identity keys don't rotate.** A new Secret Key or master password re-wraps them. Someone with your old kit, your old password and an old copy of your wrapped keyset still has the same private keys. If those keys may have leaked, make a new vault and move across.
- **A fresh device starts from what the server gives it** until it has synced your personal vault, though that vault's grant must be signed by you.
- **Forged history.** The member list and activity log are server-reported.
- **What leaves through the server.** A breach check sends the first 20 bits of each password's SHA-1 hash through your server to the breach service; a hostile server could log those. An icon fetch tells it the site's name at that moment. Neither goes to the logs, but neither is hidden from a server that's looking.

## Stolen sign-in

- A stolen Promptly session or device token can read the wrapped keyset, which needs the master password and the Secret Key together to be any use. It can't get a vault session, and can't download items.
- It could set up a vault if the account has none. You get a push when one's set up, and when one's reset.
- A stolen device token can only remove itself.

## Web vault

The vault page is a separate full-page navigation with a stricter CSP than the rest of Promptly (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `frame-ancestors 'none'`). XSS elsewhere in the main app can't reach unlocked keys, because the keys only exist inside that page's memory.

Limits we accept and state plainly:

- It's still the same origin as the main app. Script running in a main-app tab could `window.open('/passwords')`. COOP (`same-origin`) severs the opener link in supporting browsers, so it can't reach into the opened page, but it could navigate a tab, or draw a convincing fake unlock page of its own. **A fake unlock page on the same origin can phish the master password.** It still wouldn't have the Secret Key unless it can also read the IndexedDB copy, which is same-origin. Serving the vault from its own hostname closes this; see the README section on that.
- Same-origin scripts can read and delete the IndexedDB store. It holds ciphertext and the Secret Key under a browser-held device key. That key can't be exported by script, but as far as we know browsers keep its bytes in the profile files, and same-origin script can simply use it. So on the web and in extensions, a copied browser profile should be assumed to give up the Secret Key, leaving the master password as the protection. Android and Windows use OS-backed wrapping.
- Browser extensions with access to the page can read anything on it.

## Extension

- Unlocked keys live in the background context's memory or in `storage.session`, whose default access level is trusted contexts only in both Chrome and Firefox. Content scripts can't read it; a test checks this. `storage.local` is readable by content scripts in Firefox with no way to restrict it, so it never holds keys, only ciphertext. With **Never** chosen, and only then, the unlock secret is also in the extension's IndexedDB, sealed under the same device key as the Secret Key. That key is a non-extractable WebCrypto key in the same browser profile, so the seal stops scripts and casual reads, and not someone with the profile's files. It's removed when the vault's locked, when the choice changes, or when the server turns the device away. The choice lives only in this browser and never syncs, so no other device or server can turn it on.
- No remote code. The extension never loads code from the server.
- A content script runs in a page's process. Treat it as less trusted than the background. Secrets reach it only at fill time and only for fields it has checked.
- Inline UI runs in an extension iframe the page can't read. Each published DOM-clickjacking variant has a test. These checks raise the bar; they're not a proof. As the researcher says, there's no simple complete protection. The safest setting is to fill only from the toolbar popup, offered as "on click" mode. Each click is judged inside our frame by IntersectionObserver v2, which only Chromium has. On Firefox a click in the menu fills nothing: it opens the toolbar panel with that login at the top, and the fill is one more click there (D78). A page that tricks someone into clicking a hidden menu gets the panel opened, with the site login of its choosing at the top, and nothing more. It could then try to get the next click onto the panel, as the second half of a double click; for 10 seconds after a page opens the panel, a click there counts only once the panel's been up for half a second and the pointer has moved, or focus has moved by keyboard, since it opened (D79). Someone who sees the panel and clicks Fill on purpose still fills, which is the same as using the toolbar button. Firefox 140 to 148 can't open the panel from the menu, so the menu says to click the toolbar button. The menu has to have been in view for 300 ms before a click counts. It was 500 ms, and was cut at the owner's request because ordinary clicks were refused (D77): that's less margin against a page that gets someone clicking fast where the menu is about to appear.
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

## Windows app

- Windows Hello is a gate, not a crypto boundary. The unlock secret is wrapped with DPAPI, which any program running as you can ask to unwrap; Hello just asks for you first.
- The same goes for the device token and the backup password, both DPAPI-wrapped.
- The browser's native host checks the caller's extension id and that a browser started it. That raises the bar for other programs running as you. It doesn't stop them.
- Auto-type checks the window's title before each key, and refuses its own windows and elevated ones. It can't tell a look-alike window with a matching title.

## Connections to the rest of Promptly

- Mail codes and security emails are read from what the server already has. The vault's sites never go to the server, because the client does the matching.
- What's in an email is untrusted. Codes are shown as text and fill on a click. A sign-in link is offered only if it's https and goes to the sender's own domain, and not at all from a look-alike of a site you have.
- Mail codes in an extension are off until you turn them on.
- A Calendar reminder for a document says "Document expires soon", because Calendar isn't end-to-end encrypted.
- A short PIN is weaker than the master password. It only exists until the app or browser closes, and five wrong tries wipe it.
- Travel mode takes a vault off the device. It's still on your server, and your master password brings it back, so it only helps if you don't do that in front of whoever's asking.

## Android

- The autofill index, sealed with a Keystore key, holds titles and usernames so a locked phone can offer logins and ask for a fingerprint. No passwords are in it, and a setting drops the names. While the vault's open, some of this sits in plain memory.
- A removed device stops syncing, and can still open what it already has with the master password.
- Decrypted strings can't be wiped from Java memory until they're collected.
- What the browser or app reports about a form is all the service has. Fields it can't see as hidden can't be refused.

## Emergency contacts and safety words

Emergency access seals every key to your own vaults to your contact's public key. Before, that key was simply whichever one the server gave at the time, which let a hostile server name itself and collect them with no wait. Now nothing's sealed to a contact until a person has compared safety words with them and said they match. It's synced in the encrypted trust book, so it holds across devices.

Sharing a vault still works on trust on first use, as the plan says: the words are offered, not required, and a key that changes afterwards is flagged. So a hostile server that lies at the first share can get that one shared vault's key, unless someone compares the words. It's worth comparing them for anything that matters.

## Passkeys and user verification

A passkey tells a site whether the person proved who they are, and sites take a yes as a whole sign-in, with no password and no second step. The extension says yes for an unlocked vault and a click in the passkey window, as other password managers do. That's weaker than the fingerprint or PIN a site is imagining: the proof is that the vault was unlocked, however long ago the person's lock setting allows, and with Never lock it isn't proof of anything beyond having the browser. Someone at an unlocked browser can sign in to those sites. A site that says it doesn't want verification is told no. An item marked to ask for the master password still asks first. A click in the window is always needed: nothing is signed silently.

## Passkey offers

A page that asks for a sign-in passkey with no click behind it, as many do on load, gets our window only if this vault's unlocked and holds a passkey for that exact request, it's the top page, and that tab hasn't done this in the last 30 seconds. So only a site someone already has a passkey for can open one, and not repeatedly. The window opening is something the page could notice, from losing focus, so such a site can tell a passkey's here. Making a new passkey still takes a click.

Otherwise, a page's quiet or no-click passkey request registers an offer, which opens nothing. A page can make as many as it likes, but only for its own real origin, with what's kept checked and capped, at most four per tab and 64 in all, and it learns nothing unless a person chooses a passkey. An answer goes only to the document that asked: a navigation closes the window and drops the offer, and the answer carries a value only that document's content script holds. The panel and the Chromium menu show only this site's passkey names, where the page can't read them. Choosing one opens the same window as any sign-in, which names the origin, asks for the master password or PIN where the site wants that, and is the only thing that signs. The badge tells the person a passkey matches, and not the page. A site can see when its own request is answered, as with any passkey.

## Bookmarks

Bookmarks are encrypted items like any other, and only ones in your own vault count, so a member of a shared vault can't plant one in your browsers. Only `http` and `https` addresses are taken from the vault, so a bad item can't add a `javascript:` bookmark. A server can withhold, roll back or mark deleted these items as with any other. A rollback shows the usual warning, and a run that would empty one side, or delete a lot, stops and asks. The count of deletions runs over a day, so a hostile server can only take the 25, or 20%, a day it could also get from a person deleting that many, and they can be restored from "Recently deleted". It can't change what a bookmark points to. Each browser keeps a salted hash of each bookmark's fields on disk, next to the plain copy the browser itself keeps. Your bookmarks are readable on any device while the browser has them: this protects them on the server only.

## Passkeys in the extension

A page can detect the wrapper: `navigator.credentials.get.toString()` isn't native, and on Chromium a stack trace shows the extension id. Without a gesture, the extension opens no window unless the vault's unlocked and holds a passkey for that site (D71). So such a site can notice the window, and at most every 30 seconds it can open it. One click in it then signs in, because an unlocked vault and a click count as user verification (D74). Nobody typing anything is part of what that choice gives up.
