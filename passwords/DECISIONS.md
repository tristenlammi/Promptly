# Decisions log

Decisions made during the build, and what the plan's **[verify]** items turned out to be. Full evidence and sources for the checks are in `VERIFY_NOTES.md`. If context runs out, resume from here and the last milestone commit.

## Progress

| Milestone | State |
|---|---|
| M0 Setup | done |
| M1 Crypto core | done |
| M2 Backend | done |
| M3 Web vault | done. Chromium, WebKit (offline skipped) by Playwright; Firefox by Selenium, see D11 |
| M4 Import/export etc. | done |
| M5 Autofill and corpus | done. 161 fixtures: Chromium 100%, WebKit 100%, Firefox 99.4%, after tuning on them. Hold-out set: see REPORT |
| M6 Extension | done. Chrome (real, D12) and Firefox (real) |
| M7 Passkeys | done. Verified by @simplewebauthn/server on both engines |

## [verify] results that changed the design

| Plan said | Found | What we do |
|---|---|---|
| `setAccessLevel` for `storage.session` in both engines | Not implemented in Firefox; Chrome takes an object. The default is already trusted-contexts-only in both. | Don't call it. E2E test that a content script can't read `storage.session`. Never put keys in `storage.local`. |
| `passkeys.directory` as a source | Run by 1Password, all rights reserved, no API. | Use `passkeys-api.2fa.directory/v1/*.json` (CC-BY-4.0) and `api.2fa.directory/v4/*.json` (MIT, attribution required when shown). |
| `chrome.dom.openOrClosedShadowRoot` in Firefox | Not on `browser.dom`. Firefox has `element.openOrClosedShadowRoot`. | Use both with fallback. |
| Windows passkey provider "availability unclear" | GA since Nov 2025, but needs package identity (MSIX or sparse). | Stays L: a plain Tauri NSIS install doesn't qualify. Extension passkeys cover Windows browsers. |
| Playwright `--load-extension` on Chrome-branded builds | Removed in 137. Playwright's Chromium keeps it; Playwright says Edge removed it too. | Extension E2E on Playwright Chromium. Edge tried once, reported honestly. |
| Selenium `installAddon` | Deprecated; use `installWebExtension(path, {permanent:false})`. | Use the new call. |
| Firefox MV3 background | No service worker; event page via `background.scripts`. | One background module that survives both lifecycles. |
| Windows Hello as key wrap | No documented stable secret. | DPAPI wrap plus user consent gate, documented as a convenience gate, not crypto. |
| HIBP through a server proxy | Keyless, no rate limit, padding supported; CORS allows direct. | Keep the proxy as the plan says, so the provider sees the server's IP. |
| Android autofill timeout | No documented figure. | Answer from a local index with no network or unlock. Measure and report. |
| Chrome 142 permission model | Norton's statement only; nothing from Google. | Use the documented setting, intent and content provider. Owner checklist covers real phones. |

## Build decisions

| # | Decision | Why |
|---|---|---|
| D1 | Isolated stack in `passwords/stack/` is its own compose project, not an override of the main file. Own images (`promptly-pw-backend:local`), own generated secrets in `passwords/stack/.env`. | An override can't remove `env_file: .env` or the `promptly-backend:local` tag, and rebuilding that tag would disturb `main`. Also means the owner's real secrets aren't used for test runs, so the copied `.env` the plan allowed was deleted from the worktree. |
| D2 | `backend/app` is bind-mounted in the isolated stack, and `frontend/dist` is served from the worktree. | Saves a 3 GB image build per change. A real image build happens before release checks. |
| D3 | Vitest (3.2.4) for vault core tests. | The repo had no unit runner for frontend. 3.x supports Vite 5. Runs in Node, with no stack. |
| D4 | Client-generated UUIDs for accounts, vaults and items. | AAD binds to them, so they must exist before the first encryption, and offline creation needs them. |
| D5 | Sealed boxes are signed by the grantor (added beyond the plan). | A sealed box alone lets a hostile server hand out a vault key it knows. |
| D6 | KDF ceiling as well as a floor (added beyond the plan). | A hostile server could otherwise hang clients with absurd parameters. |
| D7 | Argon2id floor 64 MiB, t=3, p=1. | Well above OWASP minimums. Same as RFC 9106's second option except p, because WASM is single-threaded. |
| D8 | `auth_key` verifier is HMAC-SHA256 with a random salt. No slow hash on the server. | `auth_key` is a 256-bit HKDF output, so a slow hash adds nothing. |
| D10 | No `pw_changes` table: delta sync reads `pw_items.revision` and keeps tombstones in `pw_items`. Added `pw_sessions`, `pw_connects`, `pw_settings`. | One less table to keep in step; the plan's table list was a guide. |
| D11 | Playwright's Firefox and full Chromium builds don't start on this machine (Windows "side-by-side configuration is incorrect"; only its headless shell and WebKit run). Installing runtimes is a hard stop, so: the web vault's Firefox tests run on the real installed Firefox (159) through Selenium and geckodriver, which is a stronger test anyway. | Listed in OWNER_STEPS. |
| D12 | Extension E2E runs on the real installed Chrome (156) through the DevTools `Extensions.loadUnpacked` call with `--enable-unsafe-extension-debugging`, because that build of Chrome ignores `--load-extension` (confirmed by the [verify] check) and Playwright's Chromium won't start here. Throwaway profile each run. | Tests the real browser. |
| D13 | A small manifest generator on esbuild instead of WXT, though WXT is maintained. | WXT is still 0.x with a large dependency tree; a password manager should ship as few moving parts as it can, and the two manifests are about 40 lines. |
| D14 | Extension pages and the background share one IndexedDB copy, so they tell each other when it changes (`sync` and `vaultChanged`) and re-read it. | Each holds its own decrypted index, and a pull in one wouldn't otherwise reach the other. |
| D15 | A test build differs from a release build in exactly: `host_permissions` granted up front (Chromium has no way to click its prompt), the popup can be aimed at another tab with `?tab=`, and Firefox's opens its own page on install (WebDriver can't navigate to one). | Listed so nobody assumes more. Firefox walks the real permission path, by Firefox's `extensions.webextOptionalPermissionPrompts` test pref. |
| D16 | Passkeys: conditional (autofill-style) `get` requests pass straight to the browser's own UI, and aren't offered in our inline menu. A modal `get` or a `create` shows our window, with the browser's own passkeys one click away. | Keeps a page from silently learning anything, and the wrapper small. A known limit: see REPORT. |
| D17 | User verification is reported true for passkeys when the vault's unlocked and the person confirmed in our window; items marked reprompt ask for the master password first. | Same model as other managers. Android asks for a biometric as the plan says. |
| D18 | The classifier gets its accuracy from the corpus it was tuned on, so that number flatters it. A second, separately written hold-out set gives the honest number, recorded before any fix is made from it. | See REPORT. |
| D19 | Hold-out history, kept as it happened. First blind run of `test-sites-holdout` (Chromium, before any fix): **41/60, 68.3%; positives 29/48; negatives 12/12; one honeypot flag**. I then read the failures, so that set is spent. After generic changes it scores 56/60 (93.3%), but that's a tuned number now, not a blind one. Harness changes made at the same time: a separate sign-up form on a two-panel page no longer counts as a honeypot hit unless it's the form chosen, and a name or company on a sign-up form no longer counts as an extra. A second set, written fresh by a new agent, gets scored once at M12 with no fixes after. | The gap between tuned and blind is the honest measure of how the classifier generalises. |
| D9 | `@noble/hashes` stays on `^2.4.0` as main has it; all new dependencies are pinned exact. | Don't move what `main` already uses. The lockfile pins the resolved version. |
