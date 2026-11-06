# Decisions log

Decisions made during the build, and what the plan's **[verify]** items turned out to be. Full evidence and sources for the checks are in `VERIFY_NOTES.md`. If context runs out, resume from here and the last milestone commit.

## Progress

| Milestone | State |
|---|---|
| M0 Setup | done |
| M1 Crypto core | done |

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
| D9 | `@noble/hashes` stays on `^2.4.0` as main has it; all new dependencies are pinned exact. | Don't move what `main` already uses. The lockfile pins the resolved version. |
