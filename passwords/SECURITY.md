# Promptly Passwords: threat model

What this protects against, what it doesn't, and how. Written for someone deciding whether to trust it. `CRYPTO_SPEC.md` has the exact formats.

**Status:** this is a preview build. It has had automated tests and AI-assisted review only. It has not had an independent human security audit.

## What's on the server

Opaque blobs, the size of each blob (padded into buckets), timestamps, revision numbers, which user belongs to which vault, public keys, device names you gave, and activity events (device added, vault shared, export) with no item names.

Not on the server: titles, URLs, usernames, passwords, notes, folders, tags, item types, the master password, the Secret Key.

Two things you can turn on are exceptions, and each says so first:

- **Expiry reminders.** For each item you choose: its id, a short label such as "Passport", its expiry date and how many weeks ahead to remind you. They're in `pw_reminders` and in your Calendar and Tasks, in plain text. The label never holds a run of three or more digits or any of the item's secrets: the device strips them, and the server strips digits again.
- **Breach alerts.** Your account's email address, your Mail accounts' addresses, and the names and dates of the breaches each is in. Your server sends the addresses to Have I Been Pwned about once a day, so HIBP sees them and your server's address. An admin can read the list. Which of your logins a breach touches is worked out on your device.

## Attackers

| Attacker | Result | How |
|---|---|---|
| Stolen database dump, backup or off-site restic copy | **Holds** | Ciphertext only. Guessing the master password also needs the 128-bit Secret Key, which was never on the server, so even a weak master password can't be brute-forced from the database alone. |
| Stolen Promptly session (cookie, XSS in another part of the app) | **Holds unless the vault is unlocked in that browser** | Vault endpoints need a vault session, issued only after proving `auth_key`. The vault runs on its own page with its own CSP, and the main bundle never imports vault crypto. See "Web vault" below for what remains. |
| Curious server admin | **Holds, within the limits below** | End-to-end encryption. Admin can't read, can't reset into a vault, can only destroy it. An admin who goes further and changes what the server says is covered in "A hostile server against a good client", with what it can still do. A review on 2026-11-08 found one way such a server, with a member of a shared vault you'd made, could have got your own vault's key; that's fixed. |
| Malicious website | **Partly** | Origin and gesture rules, and an isolated extension frame. On Chromium an inline click counts only if the browser reported the frame visible for 300 ms before the press. On Firefox the inline menu and save bar never fill or save: a click there opens the toolbar panel with that login or question at the top, and the panel fills or saves on one more click, which it only takes from a person who's moved to it. Values go only into boxes at least 10x10 that are on screen and on top at their centre. An independent review broke the first version of these. They raise the bar and aren't a proof. |
| Malicious mail content | **Mostly** | Codes are shown as text, offered only when the sender's domain matches the page, and fill on a click. AI has no path to the vault. A sender's domain is only the From header, with no DKIM or SPF check, so a forged From on a real site's domain can offer a sign-in link to that site, which could sign someone into an attacker's account. A link always asks first. |
| Prompt injection in Chat | **Holds** | The vault has no chat tools that read or write secrets. A test asserts this. |
| Lost phone or laptop, locked | **Holds** | Encrypted local cache. OS-backed key wrapping. Auto-lock. Remote device removal stops future sync, not what's already on the device, which stays encrypted. |
| Lost laptop, browser set to Never lock | **Does not hold** | Never is the owner's choice, and warned about when it's made. The key to the vault stays on the computer, so whoever gets into that browser or its files has the vault. Signing in with its passkeys also takes the passkey PIN, with five guesses before the vault locks (D88), but someone who can read the browser's files can take the passkeys' keys without it. Removing the device locks it the next time it reaches the server, which a thief can avoid by staying offline. Choosing Never asks for no password, as in Bitwarden, so anyone at a browser that's unlocked can turn it on and keep access until the next Lock. |
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
| Call a shared vault you made "personal", so a trust book a member wrote in it counts as yours | Which vault is yours is kept on your devices, not taken from what the server calls it. A new device learns it from a statement signed with your identity key inside that vault, which no member or server can make. Trust books are read only from that vault, and another vault turning "personal" is warned about and treated as shared. |
| Say you're alone in a vault, so other members' logins go to your emergency contact | Emergency keys cover your own vault, and vaults you made and have never added anyone to, as recorded on your devices. The server's member count isn't used. |
| Bring back an emergency contact you removed, from another device's older list | A removal is recorded so that it wins over any device's older list. Naming them again is the only way back. |

What it can still do, stated plainly:

- **Withhold or destroy.** It can hide new changes from a device, or delete or tombstone anything. Encryption can't stop that, which is why exports and more than one device matter. A forged delete can remove an item from a device's copy.
- **A member working with the server.** Grants aren't checked against a signed member list, so someone you've already accepted keys from, if they also control the server, could give you a vault key they know for a vault they're in. Items have no author signature either, so a view-only member working with the server can forge items in that vault.
- **Safety words are a finite comparison.** Device approval words are about 2^64 of search, which is a lot in the 15 minutes a request lasts, but not a proof. The QR route doesn't have this limit.
- **Your identity keys don't rotate.** A new Secret Key or master password re-wraps them. Someone with your old kit, your old password and an old copy of your wrapped keyset still has the same private keys. If those keys may have leaked, make a new vault and move across.
- **A fresh device starts from what the server gives it** until it has synced your personal vault, though that vault's grant must be signed by you. It knows which vault is yours once it finds the signed statement in it, which every updated device writes on its next sync. A new device set up before any of your devices has done that saves new items to the one vault the server calls personal, as before, but reads no trust book from it and seals nothing from it until it's sure. A server that hides your real vault from a new device at that moment could get those new items into a shared vault you made.
- **Pause your unlock.** Ten wrong unlock tries pause unlocking on the account for 15 minutes, wherever they come from, so someone with a stolen Promptly session or device token can keep a vault's unlock paused. You get a push when it happens. Wrong tries from one address are also limited per person and address.
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
- Site rules (a site's "never fill" choice, or which boxes to fill) are taken only from your own vault. A member of a shared vault can't plant one to stop a site filling or aim a fill at another box.
- The menu can be used by keyboard. A page can move focus into it while someone's typing, so a key press counts only once a row has had focus for half a second, and not after letters were typed into the menu.
- Inline UI runs in an extension iframe the page can't read. Each published DOM-clickjacking variant has a test. These checks raise the bar; they're not a proof. As the researcher says, there's no simple complete protection. The safest setting is to fill only from the toolbar popup, offered as "on click" mode. Each click is judged inside our frame by IntersectionObserver v2, which only Chromium has. On Firefox a click in the menu fills nothing: it opens the toolbar panel with that login at the top, and the fill is one more click there (D78). A page that tricks someone into clicking a hidden menu gets the panel opened, with the site login of its choosing at the top, and nothing more. It could then try to get the next click onto the panel, as the second half of a double click; for 10 seconds after a page opens the panel, a click there counts only once the panel's been up for half a second and the pointer has moved, or focus has moved by keyboard, since it opened (D79). Someone who sees the panel and clicks Fill on purpose still fills, which is the same as using the toolbar button. Firefox 140 to 148 can't open the panel from the menu, so the menu says to click the toolbar button. The menu has to have been in view for 300 ms before a click counts. It was 500 ms, and was cut at the owner's request because ordinary clicks were refused (D77): that's less margin against a page that gets someone clicking fast where the menu is about to appear.
- Which logins a page gets (D89 to D94). A login is offered on its own host, and on other hosts of the same registrable domain unless the vault shows they're separate services; those are listed apart, and filled only when picked. **A login saved with no port is offered on every port of its host** (D91). That's weaker than before for a host where different people run services on different ports: save the port, or choose Exact host and port, to keep a login to one. Updating a saved password and filling on page load still need the exact host and port. IP addresses and single names only ever match themselves. A lookalike of a saved site is never offered a login; the panel and menu now say so, naming the real site.
- A login's address set to match by pattern is a regular expression you wrote. A dot in it that isn't escaped matches any character, so a careless pattern can match a look-alike site.
- Passkey wrapper: runs in the page's MAIN world because that's the only way to intercept `navigator.credentials`. The page can tamper with anything there, so all trust decisions happen in the isolated world.

## Android

- `AutofillService` trusts `webDomain` only from known browsers, verified by signing certificate. Apps are matched by package plus signing certificate through Digital Asset Links.
- `webDomain` carries no port, so autofill can't tell `nas.home:5001` from `nas.home`. Logins saved for any port of that host are offered there, each picked by hand, and the save screen only updates a login saved for exactly that host (D91, D92).
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
- Auto-type checks the window's title before each key, and refuses its own windows and elevated ones. It can't tell a look-alike window with a matching title. It types tabs and line breaks that are in an item's values.
- The app's own pages can only call the vault API on the server it's connected to, and the request path is refused if it holds anything but plain printable characters, so a path can't be bent out of the vault API after it's checked. The window only navigates to the app's own pages, on no port.
- Not fixed, stated plainly: the DPAPI-wrapped files in `%LOCALAPPDATA%\org.promptly.passwords` have the folder's default permissions, so another program running as you, even a low-integrity one, may be able to read and unwrap them without Hello. The SSH approval box takes focus and could take a "y" typed for something else. A request forwarded from another machine looks the same as a local one in that box. Another program running as you could start a pipe with the agent's name first.

## Connections to the rest of Promptly

- Mail codes and security emails are read from what the server already has. The vault's sites never go to the server, because the client does the matching.
- What's in an email is untrusted. Codes are shown as text and fill on a click. A sign-in link is offered only if it's https and goes to the sender's own domain, and not at all from a look-alike of a site you have.
- Mail codes in an extension are off until you turn them on.
- A reminder added from the move-from-Files screen, or from Android, says "Document expires soon", because Calendar isn't end-to-end encrypted. "Remind me" on an item uses the label you see, such as "Passport expires", and the date. See "What's on the server".
- The extension's unlock PIN is weaker than the master password. A new one has 6 to 12 digits; an older shorter one keeps working until it's changed, and the settings say to change it. It lasts until the browser closes, or 8 hours after the vault locks, whichever comes first. Five wrong tries in the extension remove it, and tries are taken one at a time, so sending many at once doesn't get round that. What the limit doesn't stop: the PIN's record (the unlock secret, wrapped under a key stretched from the PIN) sits in the browser's session storage, and someone at the computer who opens the extension's developer tools can copy it, then guess offline with no limit. Six digits is a million guesses at the cost of the key stretching each, which takes hours to days on one ordinary computer, not years. So the PIN protects against someone trying it at the unlock screen, not against someone who can use your unlocked computer for a minute. Locking the screen when you step away matters more than the PIN. The Windows app's PIN is held only in the app's memory, with the same 6 digits and five tries, and goes when the app closes.
- A copied secret is cleared from the clipboard after the time you chose, and the clear is tried again if the browser refuses it. It can't reach copies the system keeps elsewhere: Windows clipboard history (Win+V) and cloud clipboard, and clipboard managers, keep their own. Turn those off if that matters.
- The HIBP key is Fernet-encrypted with the server's `SECRET_KEY`, like the SMTP password, so the server can read it. Anyone with the database and that key can use your HIBP plan. It's kept outside the Passwords code, which never uses server-side encryption.
- A breach alert's push shows the breach, what it exposed, and your address with all but its first letter hidden.
- Travel mode takes a vault off the device. It's still on your server, and your master password brings it back, so it only helps if you don't do that in front of whoever's asking.

## Android

- The autofill index, sealed with a Keystore key, holds titles and usernames so a locked phone can offer logins and ask for a fingerprint. No passwords are in it, and a setting drops the names. While the vault's open, some of this sits in plain memory.
- A removed device stops syncing, and can still open what it already has with the master password.
- Decrypted strings can't be wiped from Java memory until they're collected.
- What the browser or app reports about a form is all the service has. Fields it can't see as hidden can't be refused.
- Saving from an app updates an existing login only when the app's signing certificate matches the one saved with it. A login imported with no certificate is never offered as "this app", so a sideloaded app with the same package name can't overwrite its password.
- Open from the 2026-11-08 review, in the passkey code another branch is changing: the passkey list answers any app with the passkey names for a site before that app's asset links are checked, so an app can tell whether you have a passkey for a site; for an ordinary app, the request's own `clientDataHash` is used rather than one made here, when VERIFY_NOTES 15 says that's only for a browser with a privileged origin; asset links are accepted from the base domain as well as the exact one; and the passkey sheet doesn't show a browser's origin. None of these lets an app use a passkey for a site that hasn't listed it.
- If the phone can't make a Keystore key that needs the phone unlocked (no screen lock, usually), the device key is made without that requirement, without saying so.
- Not confirmed: the stock AOSP browser entry (`com.android.browser`) in the privileged browser list comes from Google's list. If its certificate is the public AOSP test key, anyone could sign an app with that name and have it trusted to name websites. Worth checking, and removing it costs little.
- The share sheet can start a new login with a web address filled in from another app. It's still a new login the person saves on purpose. Same-site and plain-http pages can ask "Update this login?" with no warning that the page isn't https.

## Emergency contacts and safety words

Emergency access seals the keys to your own vault, and to vaults you made and have never added anyone to, to your contact's public key. Which vaults those are is recorded on your devices; a vault you once shared stays out even after the others leave. Before, that key was simply whichever one the server gave at the time, which let a hostile server name itself and collect them with no wait. Now nothing's sealed to a contact until a person has compared safety words with them and said they match. It's synced in the encrypted trust book, so it holds across devices.

Sharing a vault still works on trust on first use, as the plan says: the words are offered, not required, and a key that changes afterwards is flagged. So a hostile server that lies at the first share can get that one shared vault's key, unless someone compares the words. It's worth comparing them for anything that matters.

## Passkeys and user verification

A passkey tells a site whether the person proved who they are, and sites take a yes as a whole sign-in, with no password and no second step. Every passkey sign-in and every new passkey asks for a passkey PIN first, in the extension's own passkey window or Android's sheet, and the site hears yes only after a right one (D86). Five wrong in a row lock the vault, and then only the master password opens it (D88).

What the PIN protects against: someone at a computer or phone where the vault is unlocked, including with the browser set to Never lock, signing in to your sites with your passkeys without knowing the PIN. They get five guesses, then need the master password. A page can't see the PIN, type it, or answer for the window: the window belongs to the extension, and the background takes answers only from it. Nor can a page reset the count, which is kept where pages and content scripts can't reach.

What it doesn't protect against: it's a check that the person is there and means it while the vault is unlocked, not encryption. Nothing is sealed under it, and the passkeys' keys are in memory whenever the vault's unlocked. Malware on the device, or anyone who can read the extension's or app's memory, doesn't need it. Only a verifier is stored, inside the encrypted vault, but a short PIN is easy to guess offline from that verifier for anyone who already has the vault key, so it adds nothing once the vault itself is open to them. The count is per device, so a thief with two unlocked devices gets five guesses on each. Until a PIN is chosen, anyone at an unlocked vault can choose it, the first time a passkey is used. An item marked to ask for the master password still asks, after the PIN. A site that says it doesn't want verification is told it happened anyway, since it did.

## Passkey offers

A page that asks for a sign-in passkey with no click behind it, as many do on load, gets our window only if this vault's unlocked and holds a passkey for that exact request, it's the top page, and that tab hasn't done this in the last 30 seconds. So only a site someone already has a passkey for can open one, and not repeatedly. The window opening is something the page could notice, from losing focus, so such a site can tell a passkey's here. Making a new passkey still takes a click.

Otherwise, a page's quiet or no-click passkey request registers an offer, which opens nothing. A page can make as many as it likes, but only for its own real origin, with what's kept checked and capped, at most four per tab and 64 in all, and it learns nothing unless a person chooses a passkey. An answer goes only to the document that asked: a navigation closes the window and drops the offer, and the answer carries a value only that document's content script holds. The panel and the Chromium menu show only this site's passkey names, where the page can't read them. Choosing one opens the same window as any sign-in, which names the origin, asks for the passkey PIN, and is the only thing that signs. The badge tells the person a passkey matches, and not the page. A site can see when its own request is answered, as with any passkey.

## Bookmarks

Bookmarks are encrypted items like any other, and only ones in your own vault count, so a member of a shared vault can't plant one in your browsers. Only `http` and `https` addresses are taken from the vault, so a bad item can't add a `javascript:` bookmark. A server can withhold, roll back or mark deleted these items as with any other. A rollback shows the usual warning, and a run that would empty one side, or delete a lot, stops and asks. The count of deletions runs over a day, so a hostile server can only take the 25, or 20%, a day it could also get from a person deleting that many, and they can be restored from "Recently deleted". It can't change what a bookmark points to. Each browser keeps a salted hash of each bookmark's fields on disk, next to the plain copy the browser itself keeps. Your bookmarks are readable on any device while the browser has them: this protects them on the server only.

## Passkeys in the extension

A page can detect the wrapper: `navigator.credentials.get.toString()` isn't native, and on Chromium a stack trace shows the extension id. Without a gesture, the extension opens no window unless the vault's unlocked and holds a passkey for that site (D71). So such a site can notice the window, and at most every 30 seconds it can open it. It then needs the passkey PIN typed in it to sign in (D86), so the window opening tells such a site only that a passkey is here.

## Accounts from your mail

"Accounts not in your vault" is worked out in two halves.

- **The server** reads your own mail, which it already holds, for signs of an account, and keeps a list per mailbox: the site, the address it wrote to, first and last dates, what kind of mail it was, and a link to the latest one. It only does this for people who have set up a vault, and only from their own mailboxes. This list says nothing the mail didn't, but it is a tidy summary of where you have accounts, so someone who gets the database gets that too, as they'd get the mail.
- **Your device** compares the list with the vault, and keeps what you decide (not an account, deleting, gone) in the vault, encrypted. The server never learns which sites you have logins for, or which rows you hid.
- **The deletion request** is a draft in Mail, so the server sees it as it sees any draft you write, and a site you send it to learns you want to leave. The draft's text travels in the part of the link after `#`, which isn't sent to the server or kept in its logs. Nothing is sent without you pressing Send.
- **What's in an email is untrusted.** A forged welcome email can add a site to the list. The worst it does is show a row you can hide. Links from the list go to the site's own domain, its account settings, or your own Mail.

## Find stray passwords

Security check can look for passwords and other secrets left in plain text in your own Mail, Files and Photos (D107 to D114).

**What's read.** Your server reads what it already holds: the text of your mail (not Trash or Spam), the text of your own files as Drive's search index has it (or a small text file such as a `.env` straight from disk), and the words read out of your own photos. Nothing shared with you, and nobody else's. The vault isn't read: the server can't. Nothing goes to an AI model, and the patterns are plain rules in `backend/app/passwords/stray.py`.

**What's kept.** Where something was found (which message or file), what kind of thing it is, and how many, in `pw_stray_findings`. Not the secret, not a hash of it, and not the masked preview, which is worked out again from the source each time you look. A stolen database dump shows which of your messages and files hold something that looks like a secret. It already holds those messages and files, so that's no new exposure. Logs get counts only.

**What leaves the server.** The list shows a masked hint, such as `pa••••rd`: four characters of an 8-character or longer secret. The whole secret comes back only when you open one finding, with `no-store`, so the browser doesn't cache it. Saving it makes a vault item that's encrypted on your device like any other. A 2FA setup QR in a photo is read on your device, not the server.

**When it runs.** When you press "Find stray passwords", and once an hour for everyone with a vault, reading only what's new since last time. It's on for every vault owner without asking, since it reads nothing the server doesn't already hold.

**Devices.** A browser extension, phone or Windows app sees mail findings only if it was connected with codes from Mail turned on. That consent used to give one-time codes, sign-in links and security-mail subjects. **It now also gives passwords found in your mail**, which is more than it did before.

**Acting on one.** "Move the original to Trash" moves that message to its mailbox's Trash, or that file or photo to Files' Trash. It can be got back from there until the Trash is emptied. A copy may still exist elsewhere: a sent message in the recipient's mailbox, another mail app's cache, a backup. Changing the password is the only sure fix for one that's been sitting in plain text.

**Limits.** It's pattern matching. It misses passwords written in an unusual way, in images with no readable text, in mail attachments, and in files Drive hasn't read the text of. It can also flag something that isn't a secret, which is what Ignore is for.

## Aliases on your own domain

An alias like `shop.k7m2@yourdomain.com` reaches you through a catch-all at your mail provider. Promptly Mail then sorts it. So some of this has to live on the server in plain text, and that's weaker than the rest of the vault:

- **The server keeps every alias address**, which domain and mailbox it belongs to, whether it's on, and when it was turned off. Mail needs the address to know which alias an email was for.
- **It keeps the vault item's id** that each alias is linked to. The id is opaque: the server can't read the item, so it doesn't learn the site's address or the login's name from it.
- **It keeps which sender domains mailed each alias**, with counts and dates, and the first sender an alias heard from. Mail was already on the server, but this ties it to an alias and an item id. Put together, someone with the database can usually guess which sites you have accounts at, from who mails each alias. Plain logins don't give the server that.
- **The word at the start** is a random word by default. If you choose "the site's name", the address itself names the site, for the server and for anyone who sees the address.
- **The leak flag is a guess.** It compares the sender's domain on the From line, which can be forged, with the first sender (on the server) or the login's own websites (in the vault, which the server never sees). It isn't checked against DKIM or SPF. A mismatch can be a newsletter service; a match can be a forgery.
- **Turning an alias off doesn't refuse mail.** A mail client can't. The sender sees it delivered, your provider stores it, and Promptly moves it to Trash or your chosen folder once it sees it. Another mail app may show it first, and while the mail-worker is stopped it stays in your Inbox.
- **Forgetting an alias doesn't stop its mail.** The catch-all still delivers it. Anyone can also make up addresses on your domain and reach you; mail to an address Promptly didn't make is left alone and not counted.
- **Replying from an alias** puts the alias on the From line and the Message-ID. The envelope sender stays your mailbox's own address, because that's what your provider lets you send as, so a recipient who looks at the hidden headers (Return-Path, Received) can usually see your real address. Some providers rewrite the From line or refuse; the setup check finds out and Mail says so.
- **The setup check** sends one test email from your mailbox to a random address on the domain, then moves it to Trash. It can run once a minute per domain, since the domain is whatever was typed.
- **Turning an alias on or off from Mail** needs only your Promptly sign-in, not the vault, like Mail's own rules. Making aliases, setting up domains and seeing what each alias got need the vault unlocked, and a connected device needs the mail scope to see the counts.
- **In the extension**, a new alias fills only into frames of the top page's own site. An address isn't a secret, but a third-party frame has no use for it.
