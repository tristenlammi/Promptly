# Android client (M8): notes

Written during the build. Decisions, what was checked and how, and the limits. Code is in `android/app/src/main/java/org/promptly/sync/passwords/`.

## Layout

| Where | What |
|---|---|
| `passwords/core/` | Pure JVM, no Android imports. The Kotlin twin of `frontend/src/passwords/core`: `Bytes`, `Primitives`, `Format`, `Keys` (and safety words), `Model`, `Match`, `Totp`, `Generator`, `Passkeys`, `Store`, `VaultApi`, `VaultClient`. |
| `passwords/Pw.kt` | The one client for the process, SQLite offline copy, Keystore seal, settings, auto-lock. Every surface goes through it. |
| `passwords/Biometrics.kt`, `Clip.kt`, `Surfaces.kt` | Biometric wrap, sensitive clipboard, Chrome setup, Quick Settings tile, SMS User Consent. |
| `passwords/ui/` | Native Compose: `PasswordsActivity` (connect, join, unlock), `Items.kt` (list, view, editor), `Tools.kt` (bar, generator, 2FA, trash, devices, settings), `Common.kt`. |
| `passwords/autofill/` | `PromptlyAutofillService`, `FormParser`, `AutofillIndex`, `Trust.kt` (browser allowlist, asset links), `AutofillAuthActivity`, `AutofillSaveActivity`. |
| `passwords/credentials/` | `PromptlyCredentialProviderService`, `CredentialActivity`. |
| `org/promptly/sync/Updater.kt` | Downloads an update, checks its SHA-256 and signer, then hands it to Android's installer. |
| `src/debug`, `src/release` `DebugHooks.kt` | Debug-only test seams. The release twin is empty. |
| `android/pwtestapp/` | Test app, never shipped, debug variants only. `plain` is any app; `browser` stands in for an allowlisted browser through the debug hook. |

## Decisions

| # | Decision | Why |
|---|---|---|
| A1 | **Argon2: argon2kt 1.6.0 (JNI), BouncyCastle as a fallback.** At start, argon2kt must load and agree with BouncyCastle on a small input, or BouncyCastle is used. | Measured on the x86_64 emulator, 5 runs at the floor (64 MiB, t=3, p=1): argon2kt median 133 ms (129-151), BouncyCastle median 737 ms (712-835). VERIFY_NOTES 23's "check it" on 16 KB pages: every `.so` in the arm64 release APK, argon2kt's included, has LOAD alignment 0x4000, so it's fine. Not measured on a low-end phone: see the owner's checklist. |
| A2 | **Connecting: Basic with the stored app password, then the browser.** `auth/pairing_router.py` gives new pairings `upload, dav:read, maps, assistant`, so `/devices/register` (scope `assistant`) accepts them; no backend change. A phone paired before `assistant` existed gets a 403, and a phone that never paired has nothing to send: both use the connect flow (`/connect/start`, `<server>/passwords/connect?code=`, poll). | Both are in the plan. Tested: the 403 for an older scope list, in a JVM test against the stack; the Basic path through the real UI on the emulator. **The browser leg isn't tested end to end, because that would open Chrome, which stays unaccepted.** |
| A3 | **A Keystore-sealed autofill index exists, and holds titles and usernames.** No passwords, TOTP or card data. Key: `setUnlockedDeviceRequired(true)`. A setting ("Show account names in autofill while locked", on by default) drops the labels. | The plan asks for per-login gated datasets and answers with no unlock and no network. That can't be done without something readable while the vault is locked. **This is a deliberate weakening of "nothing readable while locked" on the device itself.** A thief with an unlocked phone and a locked vault sees which accounts have logins, not their passwords. The server sees nothing. Say so in `SECURITY.md`. |
| A4 | **Every suggestion is gated, unlocked or not.** Picking one opens `AutofillAuthActivity`, which returns the values straight away when unlocked and not reprompt. | Secrets never sit in `system_server` before someone picks. One path to test. |
| A5 | **The match is re-checked after the pick**, against the decrypted item. | The index can be stale. |
| A6 | **App logins:** `androidapp://<package>?cert=<b64u sha256>`, saved with `match: "never"`. | A package name is also a valid hostname (`com.example.app`), and `matchUrl` in `match.ts` would otherwise treat it as one on a web client. `"never"` makes web clients skip it. Readers keep it because unknown URLs are kept. |
| A7 | **A non-browser app's `webDomain` is never believed**, whatever it claims. It only gets a login linked to its package and certificate, or one whose site's asset links name it. Otherwise "Search Passwords" with a warning and "Fill and remember". | Plan section 9. Tested with a WebView in the plain test app. |
| A8 | **Browser allowlist: Google's `apps.json`, bundled, `release` signatures only, minus four non-browsers** (`com.google.android.gms`, `com.fido.fido2client`, `com.oplus.credential`, `com.citrix.Receiver`). The same list, release signatures only, goes to `CallingAppInfo.getOrigin`. Fetched 2026-11-06, 73 entries. No refresh from the server yet. | `userdebug` entries are keys that sign development builds. VERIFY_NOTES 15 suggests a signed copy refreshed from the server: the file ships inside the signed APK, so an update refreshes it. A live refresh isn't built. |
| A9 | **Package visibility: `<queries>` for launchable apps and https browsers, not `QUERY_ALL_PACKAGES`.** | Signing certificates need visibility, and this is enough for any app with an icon. An app with no launcher icon reads as having no certificate, so it gets nothing. |
| A10 | **Passkeys in native apps need asset links on every use**, fail closed if unreachable (a cached yes is kept). Privileged browsers: their origin is taken, and the origin-to-RP check skipped per VERIFY_NOTES 15. | Plan section 9. |
| A11 | **Where there's no biometric, signing a passkey asks for the master password.** | The plan says a biometric; many phones and this emulator's default image have none. Never skips the check. |
| A12 | **Updater fails closed.** A manifest with no valid `sha256` offers no update. The APK downloads in the app, the hash is checked while streaming, and the signer must match this app's. New permission: `REQUEST_INSTALL_PACKAGES`. | The old code opened a browser at the URL. Android enforces the signature too; the check gives a clear error first. |
| A13 | **Launcher is an `activity-alias`, `org.promptly.app.PasswordsLauncher`, on by default**, and in the Choose apps picker. `ChooseAppsActivity.isOn` now reads the manifest default rather than treating "never changed" as off. | The picker disables components: an alias lets it hide the icon without disabling autofill's screens. Unlike the web apps it's on by default, because it's where autofill is set up. |
| A14 | **`gen_suite.py`:** a `NATIVE` list writes icon, colour and picker row, but no TWA launcher. Its outputs were written by hand to match: the icon by the generator's own Pillow code in the `PromptlyPw-Backend` container, since Pillow isn't on the host. The generator itself wasn't re-run. | The plan notes the precedent. |
| A15 | **Lock runs off the main thread and waits for a running sync.** `Pw.unlocked` goes false at once. | Sync holds the keys it's using. Zeroing them mid-push could upload something encrypted under zeroes. |
| A16 | **Expiry is checked at every use**, not only by timer. | Android's timer doesn't tick in deep sleep. |
| A17 | **A revoked device** can still open its encrypted copy offline with the master password. Online, a 401 on the device token offers "Connect this phone again", keeping the Secret Key and the copy. | Wiping on 401 would also wipe on "sign out everywhere". A revoked phone holding ciphertext and a master password was never something the server could stop. Say so in `SECURITY.md`. |
| A18 | **Strength is a small port of zxcvbn's approach, not zxcvbn.** `core/Security.kt`: an embedded list of common passwords, names and cities, the EFF words, your own inputs, l33t, reversal, sequences, keyboard runs, repeats, years and dates, with zxcvbn's minimum-guesses search and its score thresholds. | Real zxcvbn's dictionaries are far bigger than this APK should carry. Its weak/not-weak answer was compared with the web client's on a fixed list of 30: 28 of 30 at first, then 30 of 30 after adding the words the two misses showed (`mypassword`, `london`) plus some other names and cities. So the second number is tuned on that list, and it isn't an independent score. It can call a password built on a word it doesn't know Fair where zxcvbn says Weak. |
| A19 | **Alert polling needs no vault session.** `AlertSeal` holds the device token under a Keystore key with no unlocked-device requirement, so WorkManager can read it on a locked phone. `GET /alerts` returns three counts. Nothing about the vault is read or shown. | A push service isn't on the plan for a locked app. It costs a device token readable while the phone's locked: that token can't open a vault, it needs the master password and Secret Key as well. |
| A20 | **Attachment preview stays in memory.** Images and text only. Anything else is saved through the system picker, where the person chooses the place. | A decrypted temp file would outlive the view. |
| A21 | **Travel mode deletes the local items of a hidden vault, and asks for the master password to bring them back.** The trust book's still in the local store while its vault is hidden. If your own vault is hidden, trust decisions made meanwhile are held locally and written to the book after you're back. | A hidden vault leaves nothing to find on the device. |
| A22 | **A new grant is checked before it replaces the one that works.** Goes further than `vault.ts`: when a vault's generation or wrapped key changes, the grant has to verify before the row's overwritten, and the highest generation is only recorded after that. | Otherwise a forged generation 999 would leave the vault refusing its real key for good. |
| A23 | **Only your own vault's `trust` items count, and all of them.** Goes further than `vault.ts`: see "For `vault.ts`" below. | Anyone who can write to a shared vault can put an item of that kind there. Two offline devices can each make one. |
| A24 | **The approval holds its own `devicePub`.** `Approval` carries the request id and key the words came from, `finishApproval` takes only that, and Devices throws an approval away if a refresh no longer agrees with it. | Sealing to the latest list entry let a server show one key's words and get the Secret Key sealed to another. |
| A25 | **An invitation has no name until it's accepted.** It shows who the server says it's from and their safety words. The name's sealed under a key nobody's trusted yet, so "(can't open)" isn't a bug. | No trust on first use, so a stranger's grant isn't verified, and a name from it would be the server's choice. |

## Security notes, for `SECURITY.md`

### The locked-vault autofill index

- **What it holds:** for each login, card and identity: its id, kind, title, username, URLs and match rules, and whether it has a TOTP or a reprompt. No passwords, TOTP secrets, card numbers or notes.
- **How it's protected:** a file sealed under an Android Keystore AES key made with `setUnlockedDeviceRequired(true)`. It can be read only while the phone is unlocked, and only by this app. It isn't sent anywhere. It's rebuilt when the vault changes while unlocked, and a vault that's shut (not accepted, or a changed key) isn't in it.
- **Why it exists:** the plan asks for per-login suggestions with no unlock and no network, which needs something readable while the vault's locked. **This is a deliberate weakening of "nothing readable while locked", on the device itself.** A setting ("Show account names in autofill while locked", on by default) drops titles and usernames. URLs and ids stay, since matching needs them.
- **What a suggestion can do:** it can't fill anything itself. Every dataset is gated by `AutofillAuthActivity`, which needs an unlocked vault and re-checks the match against the decrypted item. So a stale or tampered index can show a wrong name, and can't fill a wrong site.
- **What it gives away:** someone with the phone unlocked and the vault locked can see which sites have logins, and with the setting on, the usernames. So can code running as this app. Neither gets a password. The server sees nothing. Forensic access to a locked phone doesn't get it as far as the Keystore's unlocked-device binding holds on that hardware. That hasn't been tested against a real extraction.

### A revoked device

- **Online:** a 401 on the device token shows "Connect this phone again", keeping the Secret Key and the encrypted copy. Nothing is wiped by a server's answer, since a wipe on 401 would let a server, or a brief outage in auth, destroy unsynced edits.
- **Offline:** a revoked device can still open its encrypted copy with the master password, because that needs no server. Revoking stops future sync and sessions. It doesn't reach back into a copy already on the device. **Someone who has the phone and the master password can read what was there when it last synced.** If the phone is lost, change the passwords that matter, and rotate the Secret Key if the master password might be known too.
- **Rotated out:** after a Secret Key rotation elsewhere, the local unwrap fails before anything's sent. If the server's salt differs from the one this phone saw, it says the password or key was changed on another device, and offers to join again.
- **Forget this device** clears the Secret Key and every cached blob, and is the only thing here that removes the copy.

### What the crypto review's fixes cover on Android

Mirrors `vault.ts` and `hostile.test.ts`. `HostileTest.kt` runs each attack through the real `VaultClient` and `VaultApi`, against an OkHttp interceptor that speaks the API and lies.

- A vault opens only if it's your own, self-granted, or in `trustBook.accepted`. The server's `accepted` flag doesn't count. No pinning from sync or from viewing words.
- A "personal" vault is your own only if you granted it. Your personal vault's id is pinned. If it stops being self-granted, or vanishes from the list, the old row stays and a warning shows.
- Emergency keys go only to someone in `trustBook.contacts`, only if their live keys match the pin, and only for your own vault and self-granted vaults with one member.
- Rotation: every grantee is checked against the pin, unknown members need the person to confirm from a shown list, your own key comes from your keyset, access is cut before the key changes, and an unreadable item is purged rather than aborting.
- The highest `member_generation` per vault is kept. Lower is refused. `generation` goes with each write. Dirty items are re-encrypted when it rises.
- `seq` inside the encrypted body: a lower one on pull is refused.
- Unlock opens `wrapped_keyset` from prelogin before `auth_key` is sent, and refuses lower KDF settings than it's seen. KDF only goes up.
- A different `account_id` doesn't wipe the store unless the new keyset opens.

### For `vault.ts`

Found while porting. Not changed, since `frontend/` isn't mine to edit:

1. **`trustItem()` takes the first `trust` item from any vault.** A member of an accepted shared vault can write one. Before your own book exists, or once it's later in the map's order, theirs gets merged as a union: they can add themselves to `contacts`, and a vault to `accepted`. Android reads only your own vault (`aTrustBookPlantedInASharedVaultIsIgnored`). I didn't run this attack against the web client, so it's from reading the code.
2. **`mergeBodies` compares `seq` like any other field.** Local edited twice and server once gives three different values, which is reported as a conflict with nothing really in conflict. Android leaves `seq` out of the comparison, and out of `strip`.
3. **`mergeTrustBook` in `sync` only runs on reaching a non-personal vault,** and a device with no shared vault doesn't pick up the book until then. A later `saveTrustBook` can then overwrite what other devices wrote. Android merges at the end of a sync that didn't get to it.
4. **Two devices that both create a `trust` item offline** leave two. `vault.ts` reads one. Android unions them.

## Differences from `vault.ts`

- Same sync, same three-way merge, same rollback check; the JVM tests run them against the stack. Differences are mechanical: synchronous, a `SecretKeeper` interface in place of IndexedDB's non-extractable key, and `lock()` as in A15.
- `CRYPTO_SPEC.md` section 8 says the device payload carries `A_pub`. `vault.ts` doesn't send it, and neither does this. Worth fixing the one or the other.
- The extension's passkey item shape is used exactly, including `kind: "passkey"` for a new one.

## Chromium's behaviour on the emulator

A WebView gives no form at all on an `http` page, which matches "HTTP sites need a Chrome flag" in VERIFY_NOTES 14. So the http-downgrade confirm screen is tested by opening the sheet directly, and the real path needs a browser that passes http forms along.

## Not built

- **Import:** only browser CSVs (Chrome, Edge, Firefox, Google, Apple), Bitwarden JSON and Promptly's own exports. The screen sends people to the web vault for 1Password, KeePass, LastPass-specific fields, Dashlane, Proton and CXF. Google's migration file isn't read.
- **Secure Send:** create, copy, list and delete, for text and a file. Opening someone's Send link goes to the web page.
- **Emergency access:** see, refuse, accept, open once it's due, and end. Naming a new contact is on the web vault, though the Android client has `emergencyInvite` and the decision syncs through the trust book.
- **Attachments:** preview is images and text. Other types are saved and opened elsewhere.
- **Autofill:** "teach it once" isn't here. Live refresh of the allowlist (A8) isn't either. The suggestion cap is 8 logins, then Search.
- `QR from an existing device` in the sense of 3.4: the web client doesn't have one either. Kit QR, 2FA QR, device-join QR and Wi-Fi QR are built.
- The people list comes from `GET /people`, capped at 500 by the server and with no search on the phone.

## Follow-ups outside `android/`

These weren't touched, as asked:

- `passwords/THIRD_PARTY.md`: add `com.google.zxing:core` 3.5.3 (Apache-2.0), `org.bouncycastle:bcprov-jdk18on` 1.86 (MIT-style), `com.lambdapioneer.argon2kt:argon2kt` 1.6.0 (MIT), `com.google.android.gms:play-services-auth-api-phone` 18.3.1, `androidx.credentials`, `androidx.biometric`, `androidx.autofill`, and Google's `apps.json` (`android/app/src/main/assets/passwords/privileged_apps.json`, from https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json, fetched 2026-11-06; check whether its terms allow bundling).
- `passwords/SECURITY.md`: the section above.
- `CHANGELOG.md`: an `[Unreleased]` line for M8.
- `passwords/DECISIONS.md`: M8 row and a pointer here.

## What was run, 2026-11-06

Final code, on AVD `PromptlyTest` (API 36, Google Play image, x86_64) and the `:8092` stack.

- **JVM:** `gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest "-Dpw.stack=http://localhost:8092"`: 133 tests, 0 failed. CoreTest 54, HostileTest 29, StackTests 24, VectorsTest 18, plus the 8 CarTemplatesTest that were already there. StackTests drive the TypeScript client through vitest for attachments, sharing, the trust book and `seq`, export and import, Send, QR and Secret Key rotation.
- **Instrumented:** `android/run-passwords-tests.ps1`: 56 tests, 56 OK on the last full run. 3 of those are skipped by that script (BiometricE2ETest 2, SmsConsentTest 1, which need their own runs), so 53 exercised: AutofillE2ETest 20, CredentialManagerE2ETest 5, DeviceCryptoTest 11, VaultUiTest 11, FeaturesUiTest 6.
- **Flakes seen on the way:** autofill suggestions missed in 4 of 6 full or class runs before the lookup was made to ask again, and in none of the 3 since. Each run lost 1 or 2 of the 20, and not the same ones. The system log shows `onShown` on those runs, so the chip was there and UiAutomator couldn't see its window. The harness now hides the keyboard and asks again. That's a change to the test, not the app. One full run failed the sharing story because leftover alerts from the run before bundled together in the shade, so forgetting the device now clears posted alerts.
- **"The server can't be reached":** `againstTheRealStack` now waits out 429s, and captures the window, `api.lastProblem` and the log on that message. It didn't happen in the 5 full runs that reached that test since, and neither did a 429 there, so the one earlier failure is still unexplained. The message now carries the method, path and status or exception when it does happen.
- `android/run-biometric-test.ps1`: 2 of 2, real Keystore key, real system prompt, emulated fingerprint. The test no longer insists on seeing the "Use fingerprint" button, since the host's touches can answer first.
- SmsConsentTest with `-e pwSms 1` and `adb emu sms send`: 1 of 1, through the real Play services sheet.
- **Release build with R8** on the emulator, throwaway key, driven by adb: pairing link, connect, create a vault, add a login, lock, unlock, inline autofill, a password through Credential Manager, a passkey refused without asset links. Then the Wi-Fi QR, Security check, a shared vault and a Send. The log shows `AlertsWorker` finishing with `SUCCESS` in that build.
- **Mutation check on HostileTest:** 24 checks in `VaultClient` weakened one at a time. 20 were caught first time. The other 4 showed tests that were too weak (one mutation also had to be rewritten to compile), so those tests were tightened, and all 4 are now caught. It's a check of these tests, not proof of the code.
- **KDF calibration** on this emulator gave m=131072 to 262144, t=3, p=1 between runs, depending on what else the machine was doing. It's never under the floor or the server's minimum.
- **Lint:** `lintVitalRelease` passes. `lintDebug` fails on 12 errors, all in older code (`CarApp`, `PhoneActions`, `Crashes`), none in Passwords.
- **Size:** arm64 release, unsigned: 14,312,348 bytes against 12,597,451 shipped: +1,714,897, +13.6%.

### Verified only on the JVM, not on a screen

- The approval being thrown away when the list changes: `stillMatches` and the sealing are tested; the Devices screen's handling of it is only compiled.
- A changed-recipient warning in the rotation dialog, and the "Change the key" prompt: the client's behaviour is tested, and the screen shows the plain "Only you will have the new key." case on the emulator.
- Secret Key rotation and KDF upgrade from Settings: the client's tested, including being rotated out on screen. The Settings buttons themselves aren't tapped by a test.
- Scanning a device QR: `requestForQr` and its refusals are tested. The camera scanner needs a real phone.
- CSV export, Send of a file, attachment save through the picker, and emergency open and end buttons: compiled, with the client code under them tested.

### Owner's real-phone checklist, added to the earlier one

- Join a phone by QR, both ways, with a real camera.
- Join another phone to Wi-Fi from the QR.
- An alert on a locked phone: a new-device request, an invitation and an emergency request, after up to 30 minutes, and with battery saver on.
- The import, export and attachment pickers, including Drive as a location.
- Time a vault made on a low-end phone: calibration should stay near a second, and unlock shouldn't feel broken.
- Share a vault with someone on the web, and check the safety words match on both.
