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

## Differences from `vault.ts`

- Same sync, same three-way merge, same rollback check; the JVM tests run them against the stack. Differences are mechanical: synchronous, a `SecretKeeper` interface in place of IndexedDB's non-extractable key, and `lock()` as in A15.
- `CRYPTO_SPEC.md` section 8 says the device payload carries `A_pub`. `vault.ts` doesn't send it, and neither does this. Worth fixing the one or the other.
- The extension's passkey item shape is used exactly, including `kind: "passkey"` for a new one.

## Chromium's behaviour on the emulator

A WebView gives no form at all on an `http` page, which matches "HTTP sites need a Chrome flag" in VERIFY_NOTES 14. So the http-downgrade confirm screen is tested by opening the sheet directly, and the real path needs a browser that passes http forms along.

## Not built

- From section 4, on Android only: import and export, Security check, attachments (view or upload; a count and a pointer to the web vault show), sharing UI (invites can be accepted; shared vaults sync and read), Wi-Fi join QR, zxcvbn (the generator shows bits of entropy from its options; there's no meter on typed passwords), item-level "Teach it once" site rules, plus-address helper.
- `QR from an existing device` in the sense of 3.4: the web client doesn't have one either. Kit QR and 2FA QR are built.
- Live refresh of the allowlist (A8).
- Pick-from-index when a vault is big: the suggestion cap is 8 logins, then Search.

## Follow-ups outside `android/`

These weren't touched, as asked:

- `passwords/THIRD_PARTY.md`: add `org.bouncycastle:bcprov-jdk18on` 1.86 (MIT-style), `com.lambdapioneer.argon2kt:argon2kt` 1.6.0 (MIT), `com.google.android.gms:play-services-auth-api-phone` 18.3.1, `androidx.credentials`, `androidx.biometric`, `androidx.autofill`, and Google's `apps.json` (`android/app/src/main/assets/passwords/privileged_apps.json`, from https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json, fetched 2026-11-06; check whether its terms allow bundling).
- `passwords/SECURITY.md`: A3 and A17.
- `CHANGELOG.md`: an `[Unreleased]` line for M8.
- `passwords/DECISIONS.md`: M8 row and a pointer here.

## What was run, 2026-11-06

- `gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest "-Dpw.stack=http://localhost:8092"`: 82 tests, 0 failed. VectorsTest 18, CoreTest 44, StackTests 12, plus the 8 CarTemplatesTest that were already there. `StackTests` includes the cross-device test, which drives the real TypeScript client by vitest (`app/src/test/cross/`).
- `android/run-passwords-tests.ps1` on AVD `PromptlyTest` (API 36, Google Play image, x86_64): 50 tests. AutofillE2ETest 20, CredentialManagerE2ETest 5, DeviceCryptoTest 11, VaultUiTest 11 all ran. BiometricE2ETest 2 and SmsConsentTest 1 skip themselves in this run, needing a host to touch the sensor or send the SMS. Last whole run: 46 of 47 passed; `againstTheRealStack` failed. Run alone 3 times after that: 2 passed, 1 failed. The failures were a 429 from the shared :8092 stack in the one I checked (backend log: `POST /api/passwords/account -> 429`, while other agents were using it); the other was "server can't be reached" and wasn't investigated further.
- `android/run-biometric-test.ps1`: 2 of 2, real Keystore key, real system prompt, emulated fingerprint: enrol, unlock, fill behind a fingerprint, and a second finger enrolled kills the key.
- SmsConsentTest with `-e pwSms 1` and `adb emu sms send`: 1 of 1, through the real Play services sheet.
- Release build with R8 on the emulator, signed with a throwaway key, driven by adb: pair by link, connect, create a vault, add a login, lock, unlock, inline autofill, a password through Credential Manager, a passkey refused with no asset links. Passed. A script in the session scratchpad, not in the repo.
- Measured: fill request answered in 3 to 104 ms in the logs (small vaults); 5,000 items: index load and arrange 126 ms, web match median 297 us (worst 2158 us), app match median 357 us (worst 8829 us).
- `gradlew :app:lintDebug` fails on 12 errors, all in code from before this work (`CarApp`, `PhoneActions`, `Crashes`). None in Passwords. `lintVitalRelease`, which release builds run, passes.

One earlier lint crash (`lintVitalAnalyzeRelease`) happened while sources were being edited during the build, and didn't come back.
