# Promptly Passwords: build report

This says what was built, what was tested and how, and what wasn't. It's written for the owner, and numbers are given as they came out.

## Where it stands

**It's built and works in test, but it isn't ready for real passwords.** The code is on the `passwords` branch, not pushed and not merged. No release was cut. The Preview badge and the onboarding warning stay on until you turn them off.

Against the plan's definition of done (section 0.3):

| Requirement | Result |
|---|---|
| Every Must and Should feature on web, Chromium, Firefox, Android and Windows | **Mostly.** A few are partial or differ by platform: see [What wasn't built](#what-wasnt-built) |
| Section 13 suites pass on the real browsers available | **Yes, with two exceptions.** Four WebKit tests passed only on a rerun, and the autofill target isn't met on pages it hadn't seen |
| The existing Promptly e2e and pytest suites still pass | Yes on this branch: e2e 174 passed, 1 skipped, with Maps stubbed. Backend pytest: 2487 passed, 31 skipped, none failed, including 29 mail tests that were skipped |
| This report says what was and wasn't tested | This file |

Three things matter most:

1. **Autofill on pages it hasn't seen is well short of the target.** The target was 95% with no false fills. Three blind sets scored 68.3%, 63.3% and 90.0%, and the last two had false fills.
2. **A lot needs a real device.** Android Chrome autofill and most of the Windows desktop integration have never run. Your Google passkey sign-in is the only real-site use.
3. **No human has audited it.** AI reviews found real, serious bugs, including three critical ones in the crypto. That suggests more are there.

## What was built

| Area | Web | Extension (Chromium, Firefox) | Android | Windows |
|---|---|---|---|---|
| Items, folders, tags, history, reprompt | Yes | Yes | Yes | Yes |
| Generators, strength meter | Yes | Yes | Yes, with a smaller strength port (A18) | Yes |
| 2FA codes | Yes | Yes | Yes | Yes. Codes are typed or copied by auto-type |
| Autofill | None: the web page doesn't fill, by design | Yes. Firefox fills from the toolbar only (D49) | Yes, autofill service | Auto-type |
| Passkeys | Listed only, plus vault unlock by passkey | Create and use on both | Create and use through Credential Manager | Listed only |
| Sharing, Secure Send, emergency access | Yes | Yes, on the vault page | Yes | Yes |
| Security check | Yes | Yes, on the vault page | Yes | Yes |
| Import and export | Yes | Yes, on the vault page | Yes, with the differences listed in `ANDROID_NOTES.md` | Yes |
| Promptly features: Mail codes, security emails, change helper, plus-addresses, documents | Yes, where they apply | Yes | Yes | Yes, where they apply. No Mail code filling |
| Device approval | Yes, with push | Yes, badge while unlocked | Yes, alert by a 30-minute poll | Yes, 20-second poll while unlocked |

**Added during the build at your request, not in the plan:**

- Bookmark sync across browsers (D62, `BOOKMARKS.md`).
- A five-section toolbar panel (D64).
- Passkey offers, and a passkey window with no click when a saved passkey matches (D66, D71).
- A lock setting for each browser, up to Never (D75).
- User verification from an unlocked vault plus a click (D74).

D74 and D75 knowingly weaken what the plan asked for. `SECURITY.md` says how.

## What was tested

Everything ran against the isolated stack on `:8092`, with throwaway accounts. No real passwords, vault data or accounts were used in any test.

### Last run

The last full pass ran at commit `12899df`. It found one real bug, in the Chromium clipboard, and one test that needed changing for Firefox (see below). Both were fixed in `1535c51`, and the suites that fix can affect were rerun there. Each row says which commit it ran at.

| Suite | How | Result |
|---|---|---|
| Vault core unit | Vitest in Node (at `12899df`) | 248 passed, 24 skipped. The 24 need the stack and are the next row |
| Core against the stack, including the canary test | Vitest (at `12899df`) | Integration 22 passed, restore 1 passed |
| TypeScript and frontend build | `tsc`, `npm run build` (at `12899df`, the build again at `1535c51`) | Clean |
| Extension on real Chrome 156 | Playwright through DevTools (at `1535c51`) | 225 passed, no reruns. At `12899df` it was 197 passed, 1 failed and 27 not run: the clipboard bug below |
| Lock setting on real Chrome and Helium | `lock-choice.spec.ts`, with real browser restarts (at `1535c51`) | 15 of 15 on each. Chrome's 15 are part of the 225 |
| Extension on real Firefox 159 | Selenium, geckodriver (at `1535c51`) | 23 of 23. At `12899df` it was 22 of 23: the test change below |
| Web vault on real Firefox 159 | Selenium, geckodriver (at `12899df`) | 4 of 4 |
| Web vault, Chromium and WebKit | Playwright (at `12899df`) | First run 79 passed, 4 failed, 3 skipped. All four were on WebKit and passed when rerun one at a time |
| Windows app | `tauri-driver` and WebView2 driver, Hello mocked (at `12899df`) | 23 of 23 |
| Windows Rust | `cargo test`, `clippy` (at `12899df`) | 99 passed, clippy clean |
| Main Promptly e2e | `npx playwright test`, Maps stubbed (at `12899df`) | 174 passed, 1 skipped, no reruns, in 10.0 minutes |
| Backend pytest, whole | Full run (at `d3c5a34`, backend unchanged since) | 2487 passed, 31 skipped, 0 failed, in 36:59 |
| Android JVM | Gradle, against the stack (at `0690722`) | 302 of 302 |
| Android instrumented | AVD `PromptlyTest`, API 36, x86_64 (at `39daf37`, no Android app code changed since) | 142 run, 0 failed, 139 exercised, 3 skipped by the script. Those 3 ran on their own, next two rows |
| Android biometric | Real Keystore key and system prompt, emulated fingerprint | 2 of 2 |
| Android SMS consent | Real Play services sheet, `adb emu sms send` | 1 of 1 |
| Android release build with R8 | Emulator build signed with a throwaway key, driven by adb | Passed, see below |
| Android lint | `lintVitalRelease` (at `39daf37`) | Passes. `lintDebug` has 12 errors, all in older code outside Passwords |
| Release files | Extension build, `web-ext lint`, published downloads (at `1535c51`). Installer and frontend image (at `12899df`; the fix doesn't touch the installer's code) | All built. `web-ext lint` 0 errors, 4 warnings. Installer 2,827,454 bytes, extension zips 1,556,297 and 1,555,592 bytes. The installer was built, never installed |

**The clipboard bug the last pass found.** On Chromium, a copied 2FA code could never arrive, or the timed clear of a copied secret could fail to happen, while the extension believed the write had worked. The hidden page doing the write closed straight away, and that appears to lose it. A secret left on the clipboard past its time is the part that matters. It's in the extension's existing code, not from the lock changes: the test also failed when I put `0690722`'s code back, though that same code had passed in its own full run, so it depends on timing. Now the page stays open 300 ms (D76). With that, the code arrived in 4 runs of 4 and the full suite passed. The cause inside Chromium is inferred from behaviour, and a pause lowers the risk without ruling it out. Firefox doesn't use that page. This fix hasn't had an independent review.

**The Firefox test change.** The failing test asked for the lock's result from the vault tab that the lock reloads, so the answer didn't get back. It started failing after the review fixes, which send the reload before the lock finishes. The app was doing what it should. The test now waits for the locked screen, then asks.

**The four WebKit failures.** They timed out under load: `connections.spec.ts:225`, `gaps.spec.ts:171`, `mainapp.spec.ts:33` and `sharing.spec.ts:161`. The same four failed at `0690722` and `12899df`, and each time passed when rerun one at a time. The run before those, at `35f803b`, had a different failing set, with `xss.spec.ts:27` failing twice in a row there and passing since. I treated these as WebKit on Windows being slow and didn't find a root cause. So that XSS test on WebKit has a mixed record, though it passes every time on Chromium.

**The Android release build check.** On that R8 build: pairing link, connect, create a vault, add a login, lock and unlock, an inline autofill chip into the test app, a password through Credential Manager, a passkey refused with no asset links, the Wi-Fi QR, the Security check, a shared vault and a Send. No crashes were logged. My script needed fixing for screens added since it was written, so it took several attempts, and none of the failures were in the app. It's a smoke test of the common path, on x86_64. Nothing has run on arm64, which is what phones use.

**The 3 skipped web tests.** Two need Chromium's virtual authenticator and don't apply on WebKit. Offline navigation can't be driven in Playwright WebKit on Windows, so offline isn't tested on WebKit.

### Autofill

Scored by the corpus harness, against forms written from scratch. **The blind figures are the honest ones.**

| Set | Browser | Score | Positives | Negatives | False fills |
|---|---|---|---|---|---|
| Tuned corpus, 161 fixtures, after tuning on them | Chromium, WebKit, Firefox | 161/161 on each | 134/134 | 27/27 | 0 |
| Blind set 1, first run | Chromium | 41/60, 68.3% | 29/48 | 12/12 | 1 honeypot flag |
| Blind set 2, first run | Chromium | 38/60, 63.3% | 29/48 | 9/12 | 4 |
| Blind set 3, first run | Chromium | 54/60, 90.0% | 44/48 | 10/12 | 3 |

- The target of 95% with no false fills **isn't met blind**.
- Each set was written fresh and scored once before anyone read its failures. Blind runs were on Chromium only.
- Fixes made after set 3 aren't reflected in its score. Those spent sets later scored 58/60 and 55/60 (sets 1 and 2), but those are tuned numbers now, so they say little.
- A false fill here means the classifier offered to fill a form it shouldn't, or chose a honeypot. It's scored by the classifier, and the fill guards still apply on top.

**Public sites, read-only.** 112 login pages were loaded and classified, with nothing typed, clicked or submitted, and no page contents saved.

| Outcome | Pages |
|---|---|
| Found the form | 51 |
| Missed it (`accounts.zoho.com`) | 1 |
| Text only | 4 |
| No form on the page | 18 |
| Blocked the automated browser | 35 |
| Errors | 3 |

It's a smoke test, and a third of the pages told us nothing. It did find one real bug no fixture had (D34).

### Security checks

- **Canary test (13.2).** Distinctive strings in every field, then a search of the Postgres dump, service logs, Redis keys and values, uploads, stored notifications and a real backup file. No hits, at `12899df`. Push payloads as sent weren't captured; the search covers the stored notification rows.
- **Backup restore.** A restored dump unlocks after a new `SECRET_KEY` (test, at `12899df`).
- **Hostile pages (13.5).** Clickjacking variants, hidden fields, cross-origin frames, origin confusion, fake messages, prototype tampering and RP ID spoofing, all in the extension suite. XSS probes in every field are in `xss.spec.ts`, with the WebKit note above.
- **Disk scan.** Nothing typed into the vault was found in plain text in the browser profile on Chrome. The Windows scan found WebView2 writing the Secret Key to `Web Data`, which was fixed (D27).
- **Passkeys.** Checked by a separate library, `@simplewebauthn/server`, on both engines.
- **Mutation checks.** Android only: 25 in the second round, of which 22 were caught first time, 1 exposed a gap that was then closed, and 2 can't be caught because they change nothing. It's a check of those tests, not of the code. The rest of the code wasn't mutation-tested.
- **Static checks.** Secret scan of 335 files found nothing. Licences are fine. `web-ext lint` gives 0 errors and 4 warnings (`UNSAFE_VAR_ASSIGNMENT`). The bundle check found no vault crypto in 223 main chunks. CSP was checked on real response headers.
- **`npm audit`.** 27 production advisories (16 high) in the main app's existing dependencies. The vault's chunks don't include them.

### Performance

With 5,000 items. Core figures at `12899df`, extension figures at `1535c51`:

| Measure | Result |
|---|---|
| First push | 4825 ms |
| First pull | 1435 ms |
| Unlock after KDF | 794 ms in the core test, 1750 ms in the extension |
| Search | 0.6 to 2.6 ms in the core test. 1.8 ms median through the extension's background. 4 to 243 ms over 5 searches on the extension's vault page |
| Delta sync | 26 ms |
| Popup, worker running | Search box 64 ms, this site's row 111 ms |
| Popup, first open after the worker was killed | Search box 232 ms, this site's row 287 ms |
| Heap | 78 MB in the core test, 66 MB in the extension |
| Import of 5,000 items into the extension | 12732 ms |

The Android dataset response has no measured figure at 5,000 items. Android answers from a local index, and its tests only check that suggestions arrive. Measure this on a real phone.

### Reviews

Fresh-context AI reviews were given the code rather than my conclusions. **They don't replace a human audit.**

| Round | Scope | Found | Outcome |
|---|---|---|---|
| 1 | Crypto | 3 critical, 5 high, others | 1–9, 12 and 14 fixed, 15 partly fixed. 10, 11, 13 and 16 are documented in `SECURITY.md` rather than fixed |
| 1 | Backend authorisation | 2 high, 5 medium, 8 low | All fixed, except the two listed below |
| 1 | Extension and autofill | 4 high, others | Fixed |
| 1 | Android | 4 high, others | Fixed |
| 2 | Extension and web | 1 high (a Firefox passkey answer could reach the wrong document), 4 medium, 6 low | All fixed (D68) |
| 2 | Android | 1 high (emergency keys could go to a server-supplied key, also on web), 5 medium, lows | All fixed (D69, D73) |
| 3 | Lock setting and passkey verification, `0690722` | No critical or high. 3 medium, 1 low-medium, 4 low, 1 unconfirmed, 1 doc error | 6 fixed, 3 documented in `SECURITY.md`, doc error fixed. Details below |

**Round 3 in detail.** Findings came from reading the code, and I checked each against the code before acting.

| Finding | Severity | Outcome |
|---|---|---|
| Changing the master password or keys in the vault tab left the background with a stale secret, and an open tab could then stay unlocked with no timer | Medium | Fixed: the background gets the new secret, and every lock tells open pages |
| Lock in the vault tab waited on the server before telling the background | Medium | Fixed: the background hears first, and the keys go at once |
| After a Hello unlock, the vault page ignored later locks | Medium | Fixed. **The Hello path has no test**, since Hello in the extension needs the desktop host |
| A vault reset elsewhere didn't remove Never's secret, and turning Passwords off only sometimes locked | Low-medium | Fixed. The reset has a test. **Turning Passwords off has none** |
| A page that fills on load could postpone the lock timer | Low | Fixed |
| A lock racing an unlock could leave the secret on disk | Low | Fixed by reading the code. **No test**, since it needs close timing |
| Never can be chosen with no password | Low | Left as it is, as in Bitwarden. In `SECURITY.md` |
| A sleep under 3 minutes goes unseen on Firefox | Low | Left. In `SECURITY.md` |
| "When the browser closes" fails if the browser stays running with no windows | Unconfirmed | Left. In `SECURITY.md` |
| `SECURITY.md` still said no window opens without a gesture | Doc error | Fixed |

The fixes themselves haven't been reviewed independently.

Left open from those reviews:

- `backend/app/mail/parse.py` has a regex that goes quadratic on hostile HTML. It's outside this work.
- Deleting a user can leave a shared vault with no manager.
- The trust merge's x25519 fix on web has no test of its own.
- Sharing stays trust on first use, and a trusted member working with a hostile server can still hand out a vault key they know (D53).

## What wasn't tested

**On real sites and devices**

- **Real sites:** the only real-site use is your own Google passkey sign-in, which you confirmed worked with the password typed, on the build before D74. The build where it needs no password hasn't been tried on Google. I couldn't test real sign-ins, because logging in to public sites is off limits for me.
- **Google's password step:** you reported that fill didn't work there. That's unresolved, and I don't have your Describe-this-form output.
- **Bookmarks in your browser:** you reported none showing, and that's also unresolved. Automated runs pass, on throwaway profiles.
- **Android on a real phone:** nothing has. Chrome autofill is the biggest gap, as Chrome on the emulator is blocked by its terms screen, which I'm not allowed to accept. WebView and a test app stand in. Also not run: a real camera, a real fingerprint sensor, any arm64 device, and real banking apps.
- **Store and signed installs:** every extension run used an unpacked build. The Windows installer was built but never installed.

**Windows, compiled but never run**

- Tray and menu clicks, and the real global shortcut.
- Real keystrokes from auto-type, including copying and typing 2FA codes.
- A real Hello prompt.
- The native host under a real browser.
- The ssh-agent pipe with a real SSH client.
- Start with Windows, the backup timer, and the updater.
- The installer installing, and the WebView2 download.
- Approving a device from another device.
- Saving files through a blob link.
- `window.confirm` inside WebView2, which travel mode and some deletes rely on.

**Android, compiled only** (more in `ANDROID_NOTES.md`)

- Credential Manager passkey paths when the vault locks mid-flow, and a passkey create meeting a lock.
- The "couldn't check, so no Trash button" branch.
- `ScopeConnect` being refused or timing out, and starting from a row other than Settings.
- The browser leg of adding a scope.
- Leaving an import during hashing.
- Bitwarden's costly KDF settings at real cost, and KDF ceilings at the ceiling.
- An http page in a real browser, and split code boxes from Mail.
- The helper's copy buttons, reprompt in the helper, and the hidden change buttons.
- Real iframe frame rules, the real save sheet, and a 100 MiB document.

**Two Android test oddities I couldn't fully explain**

- UiAutomator saw a stale tree in `aBrowserSignedInAsSomeoneElseChangesNothing`. The app was shown to be right, but the test tool's behaviour isn't understood all the way down.
- One early "server can't be reached" hasn't recurred and has no known cause.

**Browsers**

- Brave, Vivaldi and Opera aren't installed, so they're untested.
- Edge ran `extension.spec` only, 12 of 12, on earlier code. It wasn't rerun on the final code.
- Helium ran only the lock spec as a suite, through a throwaway profile. Your own Helium profile was never touched by tests.
- Blind autofill sets ran on Chromium only.
- Test builds differ from release builds in the ways D15 and D47 list. Filling on a release build is only smoke tested.

**Firefox's lock setting**

- Restarts are **simulated** with a test hook. Selenium can't restart Firefox on the same profile with a temporary add-on, so Never on Firefox hasn't been through a real restart.
- A temporary add-on is gone on restart anyway, so this needs a signed build.

**Importers**

- No real exports from any password manager. Fixtures are written from each format's documentation, and only the KDBX one comes from an independent library (`pykeepass`).

**Merge**

- `main` has moved on. Nothing here has been tested on top of it.
- The memory upgrade's `0255_memory_lifecycle` will clash with this branch's `0255_passwords_hardening`, as `OWNER_STEPS.md` explains.

## What wasn't built

**Partial against the plan**

- **Vault unlock by passkey** is web only, because an extension origin isn't a usable RP ID across browsers (D30).
- **Device approval push (5.4):** only the web gets a real push. Extension and Windows see a badge or a poll while unlocked, and Android polls every 30 minutes, so its alerts are late and go through battery rules.
- **Android strength meter** is a smaller port and can differ from zxcvbn (A18).
- **Change-password helper:** web and Windows offer Copy buttons, since they can't fill another site. On Android it works only where Android autofill reaches.
- **Web clipboard timer** dies with the tab.
- **Attachment streaming** goes straight to disk only on Chromium. Firefox and WebKit hold the whole file in memory (D60).
- **Bookmarks** need an unlocked vault, and aren't on Android or in the Windows backup.
- **Imported attachments** aren't in a Bitwarden export.
- **Firefox's on-page menu** doesn't fill or save, as Firefox has no trustworthy visibility check. The toolbar does it (D49).
- **Lookalike sites:** rows are removed rather than warned about (D49).
- **Custom ports:** a login saved with no port matches the default port only, so self-hosted services on other ports need their address edited (D51).
- **Android:** no "teach it once" and no live refresh of the browser allowlist. The other small gaps are in the "Not built" section of `ANDROID_NOTES.md`.
- **Never lock** is in the browser extension only. Web and Windows keep idle minutes.
- **Passkey verification** has no real check behind it apart from the unlock and the click. Windows Hello in that window would be stronger, and isn't built. Android still asks for a biometric.

**Not built by decision**

- Signed member rosters and keyset rotation (D53).
- Windows system-level passkey provider (plan tier L; needs package identity).
- Firefox for Android.
- iOS: design only, in `IOS_NOTES.md`.
- Any AI or chat access to the vault: left out on purpose, and confirmed by search.

## How to read these results

- **Backend pytest ran at `d3c5a34`.** The backend hasn't changed since, but the frontend and clients have.
- **29 mail tests were skipped** because they need a throwaway mail server. They're part of the 31 skipped.
- **Maps was a stub** in the main e2e run (D56), so Maps isn't really exercised there.
- **Photo-chat tests are order-sensitive** under load, as the plan warned. Rerun them alone before calling a failure real.
- **Rate limits are shared.** All test traffic goes through one nginx at 30 requests a second with a burst of 60, which caused some earlier test failures.
- **Argon2 timing** came from this desktop and an x86_64 emulator, not a low-end phone.
- **An independent stack.** Everything ran on the isolated test stack, not your running Promptly. Your real data was never touched.

## What's next

[OWNER_STEPS.md](OWNER_STEPS.md) has the order to work through. `SECURITY.md` says what the design protects against, including what Never lock gives up.
