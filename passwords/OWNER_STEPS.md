# Promptly Passwords: what's left for you

The code is on the `passwords` branch, in `C:\Projects\Promptly\.worktrees\passwords`. Nothing's been pushed or merged, and no release has been cut.

**Don't put real passwords in it yet.** Work through steps 1 to 8 first. The Preview badge and the onboarding warning stay on until you turn them off in Admin → Passwords.

## 1. Read the report

Read [REPORT.md](REPORT.md), mainly "What wasn't tested" and "What wasn't built". Those two lists are the real state of this. [SECURITY.md](SECURITY.md) says what the design does and doesn't defend against.

## 2. Decide on push, merge and release

- Push the branch and merge when you're happy. Nothing here does that for you.
- `main` has moved on since this branch started: it's at v0.29.0 or later. An earlier dry-run merge conflicted only in `CHANGELOG.md`, and `backend/app/mail/rules.py` merged automatically (both sides changed it). I didn't merge them in, so nothing here has been tested on top of them. Run the suites again after merging.
- Cut a release with `scripts/release.ps1 <version>`. A minor version fits (`0.30.0` if `main` hasn't moved again).
- **Check the migrations at merge.** Passwords adds `0254_passwords_core` on top of `0253`, then `0255_passwords_hardening`. The memory upgrade work (not on `main` when I checked) adds `0255_memory_lifecycle`, also on top of `0253`. Whichever merges second has to point its `down_revision` at the other's head, or there are two heads and the backend won't boot cleanly. Two files will also be numbered `0255`, which is harmless but confusing. Run `alembic heads` after merging. It should print one line.
- Rebuild `backend`, `arq-worker` and `mail-worker` together.
- Download files: `frontend/public/downloads/` holds the Windows installer and the extension zips from this build. They're unsigned, so see step 3 before offering them to anyone.
- The test stack is `passwords/stack/docker-compose.yml`, plus `docker-compose.full.yml` for the whole main e2e suite.
- Build the Android APK with `android/build-release.ps1`. I didn't run this, because it uses your signing key. The arm64 release APK grew about 15.5% (14,552,956 bytes unsigned, was 12,597,451).

## 3. Store accounts and signing

I can't do any of these for you.

| What | What you need to do | Until then |
|---|---|---|
| Chrome Web Store | Developer account and listing. Upload the Chrome zip. Use `passwords/extension/PERMISSIONS.md` for the permissions form. | Load unpacked only |
| Firefox AMO | Developer account and signing key. Sign the Firefox zip. | Temporary add-on only, gone on restart |
| Edge Add-ons | Optional. Same Chrome zip. | Edge can install from the Chrome Web Store |
| Windows code signing | A certificate, then sign the installer | SmartScreen warns on the installer |
| Tauri updater | Make an updater key. Fill in `pubkey` and `endpoints` in `passwords/desktop/src-tauri/tauri.conf.json`. | Both are empty, so the Windows app can't update itself |
| Rules pack key | Below | The extension accepts no pack signed for release |

**The rules pack key.** Run this once, and keep the file out of the repo:

```bash
node rules/sign-pack.mjs --new-key C:\somewhere-safe\promptly-pack-key.jwk.json
```

Run it from `passwords/extension`. Paste the public key it prints into `RELEASE_PUBLIC_KEY` in `src/rules-key.ts`. Then sign each time `rules/pack.json` changes:

```bash
node rules/sign-pack.mjs --key C:\somewhere-safe\promptly-pack-key.jwk.json
```

`rules/test-key.jwk.json` is a throwaway key that only test builds trust. It isn't in release builds, and it has no value.

**Android and Play.**
- `REQUEST_INSTALL_PACKAGES` and `HIDE_OVERLAY_WINDOWS` are in the manifest. Play asks for a reason for the first, and it may not accept it, so a Play build may have to drop the updater.
- `privileged_apps.json` comes from Google's Credential Manager samples. Read its terms before a Play release.

**Extension.** Decide whether `clipboardRead` stays as an optional permission. It's only asked for if someone ticks "Don't clear the clipboard if I've copied something else since". Dropping it makes a store review simpler.

## 4. Real-device checks

Everything below needs hardware, a real browser or a real site, which I couldn't use.

### Android: a real phone

Set it up first: Settings → Passwords and accounts, pick Promptly as the autofill service and the Credential Manager provider, and in Chrome set Autofill to "using another service".

- Chrome autofill: an ordinary login fills, including on a long form you've scrolled. This is the biggest gap, because Chrome on the emulator was blocked by its terms screen (and I'm not allowed to accept those).
- A login saved for `https://nas.example:5001` is now suggested on `nas.example` in Chrome, since Chrome doesn't tell autofill the port (D91). Two logins on `zyx.` and `abc.` of one domain: each site shows only its own, and saving a new password on one doesn't change the other.
- App autofill in a few real apps.
- A banking app that signs in through its own WebView: expect the "showing a web page" question unless the site's saved on that login.
- A real passkey on a real site through Credential Manager, both creating and signing in. It asks for your passkey PIN now, not a fingerprint (D86). Check the PIN box comes up ready to type with the number keyboard, Done signs in, and five wrong PINs lock the vault and say so.
- Fingerprint unlock with a real sensor, and what happens after you add a new finger (it should ask for the master password).
- Join a phone by QR, both ways, with a real camera.
- Join another phone to Wi-Fi from the QR.
- An alert on a locked phone: a new-device request, an invitation and an emergency request, after up to 30 minutes, and with battery saver on.
- The import, export and attachment pickers, including Drive as a location.
- Time a vault made on a low-end phone: calibration should stay near a second, and unlock shouldn't feel broken.
- Share a vault with someone on the web, and check the safety words match on both.
- Turn on an overlay app (a screen dimmer, a chat head), and check the unlock and fill screens hide it or refuse the tap.
- Install an update through the in-app updater.
- Add an emergency contact with them beside you, and compare the words on both screens.
- A real emailed code on a real site in Chrome, then the same with mail from another sender: no code should show.
- Change a throwaway account's password from the Security check, with Chrome set up.
- A real password-protected Bitwarden export, a KeePass file you really use, and a real export from each manager you've got an account with.

The sections called "Added to the owner's real-phone checklist" in [ANDROID_NOTES.md](ANDROID_NOTES.md) have the rest, in more detail.

### Windows

Work through [desktop/MANUAL_CHECKLIST.md](desktop/MANUAL_CHECKLIST.md). These have only been compiled, never run: tray and menu clicks, the real shortcut, real keystrokes from auto-type, a real Hello prompt, the native host under a real browser, a real ssh-agent pipe and SSH client, start with Windows, the backup timer firing on schedule, the updater, the installer installing, the WebView2 download, and approving from another device.

The checklist's install section needs a real install. Automated tests used the desktop runtime already on this machine.

### Browsers

- Install each extension for real, from its store or as a signed file, and use it on sites you actually sign in to. **Use low-value accounts only.**
- To try it now in Helium or Chrome: turn on developer mode on the extensions page, then "Load unpacked" and pick `passwords/extension/dist/chrome`. Reload it there after each new build.
- Check bookmark sync with a second browser, using a profile whose bookmarks you don't mind changing. Read [BOOKMARKS.md](BOOKMARKS.md) first. It's off until you turn it on.
- **Your Google passkey sign-in again, with the passkey PIN** (D86). Press Google's Continue, and Promptly's window should open with the PIN box ready to type in. The first time, it asks you to choose a PIN, twice. Type it and press Enter, and Google should sign you in with no password step, since it now hears you were verified. Then try once with a wrong PIN to see the count, and the right one after. Tell me if Google still asks for a password, or calls it a "2-Step Verification only security key".
- Google's password step: you saw no fill there. The menu under a box didn't open on a step that a page slides in and focuses itself, or on a box it focused before the extension was ready (D102), and that's fixed. I couldn't try it on Google itself, only on local pages built the same way. Try both the menu and the toolbar button there. If either still misses, "Describe this form" in the panel gives me what I need, with no secrets in it.
- Try the sign-in pages of the apps you run yourself (NAS, home automation, router, dashboards). Local pages in the style of twelve of them now fill. An app that puts its boxes inside several nested web components gets classified, but the fill guard still refuses those boxes (D106), so tell me which ones miss.
- Try tabs, sending a tab, history and the reading list between Chrome or Helium and Firefox ([SYNC.md](SYNC.md)). Each is off until you tick it in Settings, "Sync with this browser", and history is the one to think about first. Send a tab to your phone: the alert can take up to 30 minutes, and unlocking Passwords opens it. None of this has run against your real browsers or phone, and its e2e tests haven't run on the stack yet.
- Never lock on Firefox: restart with a signed build. Tests could only simulate the restart.
- On Firefox, click a login in the menu under a login box, and check the toolbar panel opens with it at the top and fills on one click. Then submit a new login and press "Save in the panel" on the bar. Tests can't see the real panel, only the same page opened in a tab. If the panel ignores a click you meant, say so: it waits for the pointer to move after a page opens it (D79). On Firefox before 149 it can't open by itself.
- On Chrome and Helium, copy a 2FA code and check that it arrives and then clears on time. The fix for lost clipboard writes is a timing pause (D76), so tell me if you ever see one fail.
- Brave, Vivaldi and Opera aren't on this machine, so they're untested. Edge ran an earlier version of the code, and only the main extension tests.
- Site matching (D89 to D94), on your own self-hosted services: each subdomain should offer only its own login, with the others under "Other logins for <domain>" in the toolbar panel. A login you saved with no port should fill on any port of that host. If a big site you use stops offering a login, edit it and pick Same domain under Match websites, and tell me which site.
- Filling on the release (non-test) extension build was only smoke tested, because the tests drive hooks that release builds don't have.

## 5. Trial with low-value accounts for a few weeks

Autofill failures only really show up on real sites. On pages it had never seen, the classifier scored 68%, 63% and 90% on three blind sets, against a 95% target, and it did fill fields it shouldn't have (see the report). Expect misses and a few wrong offers.

Use "Teach it" when it misses, and put what you learn into the rules pack.

**If you choose Never lock in a browser.** Anyone who can open that browser on your computer can open the vault. It's convenient for a low-value trial, and worth rethinking before real passwords go in, especially on a laptop. See "Lost laptop" in [SECURITY.md](SECURITY.md). "When the browser closes" or a few hours keeps most of the convenience.

## 6. Test recovery before adding anything important

Print the recovery kit, then recover the vault on a clean device using only the kit and your master password. Do this **before** anything important goes in. If you lose both the kit and all your devices, nobody can get the vault back, by design.

If you add an emergency contact, compare safety words with them in person or on a call first. Their keys aren't sealed until you have.

Also restore a real backup of your server to a spare machine and check the vault unlocks. A test does this with a new `SECRET_KEY`, but your backup routine is what matters.

## 7. Consider a paid security review

Do this before moving primary accounts or inviting family. Fresh-context AI reviews found and fixed real, serious problems here, including three critical ones in the crypto review. That's good evidence there are more nobody has found, and it doesn't replace a human audit. The repo is public, so reviewers and anyone else can read it.

Point a reviewer at [CRYPTO_SPEC.md](CRYPTO_SPEC.md), [SECURITY.md](SECURITY.md), decision D53 in [DECISIONS.md](DECISIONS.md) and the review section of the report.

## 8. Turn off the Preview badge

Admin → Passwords → "Show the Preview warning". Do this only after steps 5 to 7.

## Aliases on your own domain

Built and tested against a throwaway GreenMail, never against a real provider. To try it:

1. Pick a subdomain you don't use, like `alias.yourdomain.com`. Using a subdomain leaves your main domain's mail alone.
2. At your mail provider, add the subdomain with a catch-all into a mailbox that's connected in Promptly Mail, and add the DNS records it asks for. `USER_GUIDE.md` has general notes for common providers.
3. In Passwords → Aliases, add the subdomain and run the check. It should say "Working" within a minute or two. If it says the provider changes or refuses the sender, replying from aliases won't work until you add the domain as a send-as address.
4. Make an alias for a low-value sign-up from the item editor and from the extension's Generator, and check that Mail shows the alias on its email, that turning it off sends new mail to Trash, and that a reply goes out from the alias.
5. After merge, run `cd e2e && npx playwright test --config passwords.config.ts aliases.spec.ts` on the stack. It wasn't run here.

## 9. Optional: breach alerts for email addresses

These need a paid Have I Been Pwned key. Without one, nothing is sent anywhere.

1. Go to https://haveibeenpwned.com/API/Key, sign in with your email, and choose a plan. Core 1 was US$4.39 a month for 10 checks a minute in November 2026, which covers hundreds of people checked once a day. Read the API's terms there.
2. Copy the key: 32 characters, 0-9 and a-f.
3. Admin, Passwords, "Breach alerts for email addresses": paste it and press Save key. It should show your plan's name. If it says it couldn't check, the next run tries again. If it says the key isn't valid, copy it again.
4. In Passwords, Security check, Breaches: turn it on for yourself. It shows the addresses it will send first. The first check runs within ten minutes.
5. Tell the people on your server it's there. It's off for each of them until they turn it on (D123).

**Tests to run once this branch is on the stack:** from `e2e/`, `npx playwright test -c passwords.config.ts passwords-tests/alerts.spec.ts`, and the changed test in `passwords-tests/gaps.spec.ts` ("a typed document can get its Calendar reminder too"). They set no HIBP key and never reach HIBP.

## Known follow-ups

- **Fill the list of account deletion pages.** "Delete account" in Security check can link straight to a site's deletion page from JustDeleteMe's list (MIT), but the data file ships empty because downloading it needed your go-ahead. To fill it, pick the latest commit of https://github.com/jdm-contrib/jdm and run `python backend/scripts/update_deletion_sites.py --commit <sha>`, then check `backend/app/passwords/data/deletion_sites.json` and commit it. Until then it links to the site's account settings instead.
- **Try "Accounts not in your vault" on your own mail.** It was only tested with made-up mail. See which of your sites it finds, which it misses and what it wrongly lists, and say which rules to change.

- Deleting a user can leave a shared vault with no manager. The backend review found it, and it's not fixed.
- `backend/app/mail/parse.py` has a regex that goes quadratic on hostile incoming HTML. The backend review found it, and it's outside this work, so it's not fixed.
- Android `lintDebug` reports 12 errors in older code (`CarApp`, `PhoneActions`, `Crashes`), none in Passwords. `lintVitalRelease` passes.
- `npm audit` lists 27 production advisories in the main app's existing dependencies (excalidraw, mermaid, dompurify and others). The bundle check shows none of them are in the vault's page, but they're still there for the main app.
- iOS is design only: see [IOS_NOTES.md](IOS_NOTES.md).
- From the 2026-11-08 review: once this is merged, open each of your devices (web vault, browser, phone, Windows) and let it sync once, so each marks your own vault; a device added before any of them has done that is weaker until it has. If you set a 4- or 5-digit PIN in the browser, set a 6-digit one. The Android passkey items in SECURITY.md are for the passkey-PIN branch. Check whether the `com.android.browser` certificate in `android/app/src/main/assets/passwords/privileged_apps.json` is the public AOSP test key; if it is, remove that entry.
- **Find stray passwords** (Security check) hasn't been run in a browser yet. Its e2e test, `e2e/passwords-tests/stray.spec.ts`, needs the stack: `cd e2e && npx playwright test -c passwords.config.ts passwords-tests/stray.spec.ts`. The first time you run it on your own data, it will list real secrets from your mail and files. Look for false alarms and anything it missed, and tell me. Once merged, the hourly pass starts reading new mail and files for everyone with a vault, without anyone pressing the button.
- Expiry reminders and the Breaches section are on web, the extension's vault page and Windows. Android still has only the older "Document expires soon" button, and no Breaches section.
