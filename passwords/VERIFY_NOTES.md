# Password manager plan: [verify] results

Checked 2026-11-06. No repo files changed, no sign-ins, no forms submitted.

**How to read this**
- Pages were read through a fetch tool that often summarises, so quotes are short and should be re-read at the URL before you rely on exact wording.
- Package versions, licences and browser compat data came straight from registries, GitHub and the mdn/browser-compat-data JSON ("BCD").
- "Inference" marks my own conclusion, which no source states.
- "Secondary" marks a source that is not the vendor's own.
- "(excerpt)" after a URL means I saw it only as a search-result excerpt and did not open the full page.

| Status | Count | Items |
|---|---|---|
| CONFIRMED | 18 | 1, 2, 3, 4, 7, 9, 10, 11, 12, 13, 14, 17, 19, 20, 21, 22, 23, 24 |
| WRONG | 3 | 6, 8, 15 |
| UNCLEAR | 4 | 5, 16, 18, 25 |

Sub-parts that are unclear or need correcting inside a CONFIRMED item:
- 1: Edge flag status
- 4: exact Origin header
- 13: installAddon is deprecated in the JS bindings
- 14: Chrome 142 and Firefox Android
- 23: BouncyCastle Argon2 speed

---

## 1. Chrome off-store install, --load-extension: CONFIRMED (Edge sub-part only secondary)
- **Windows off-store:** the only documented non-policy external route is the registry key, and its `update_url` must point to the Chrome Web Store. "As of Chrome 33, no external installs are allowed from a path to a local CRX file on Windows." So outside enterprise policy, Developer mode "Load unpacked" is the only off-store route.
- **Branded Chrome:** `--load-extension` removed in Chrome 137. `--disable-extensions-except` and `--extensions-on-chrome-urls` removed in Chrome 139, which also adds `--extensions-on-extension-urls`. One Sept 2025 reply reports `--disable-extensions-except` still working in 140, unexplained.
- **Chromium and Chrome for Testing:** both keep the flags. Playwright docs say to use the bundled Chromium with `channel: 'chromium'`, a persistent context, and `--disable-extensions-except` plus `--load-extension`.
- **Automation on branded Chrome:** a Chromium thread shows `--enable-unsafe-extension-debugging` plus BiDi `webExtension.install`. 2025 sample, retest.
- **Edge stable:** Playwright docs say "Google Chrome and Microsoft Edge removed the command-line flags needed to side-load extensions". Microsoft's sideloading doc only describes Load unpacked and is silent on flags. No Microsoft announcement found. A five-minute local test would settle it.
- **Design:** ship Windows users via store listing or a Load-unpacked guide. Never promise a one-click crx. E2E on Playwright Chromium or Chrome for Testing. Do not plan E2E on branded Chrome or Edge via flags.
- **Sources:** https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions ; https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY ; https://groups.google.com/a/chromium.org/g/chromium-extensions/c/FxMU1TvxWWg ; https://playwright.dev/docs/chrome-extensions ; https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading

## 2. Firefox signing and data_collection_permissions: CONFIRMED
- **Signing:** required on release and beta. Developer Edition, Nightly and ESR can install unsigned after toggling `xpinstall.signatures.required`, and the add-on must have an ID. Unbranded builds are not mentioned on that page.
- **Self-distribution:** `web-ext sign --channel=unlisted` (`--channel` required since web-ext 8) with `--api-key` and `--api-secret` (`$WEB_EXT_API_KEY`, `$WEB_EXT_API_SECRET`). Latest web-ext is 10.8.0. Self-distributed add-ons may still be manually reviewed.
- **Manifest:** `browser_specific_settings.gecko.data_collection_permissions: { required: [...], optional: [...] }`. Use `"required": ["none"]` if nothing is collected. `technicalAndInteraction` must be optional.
- **Who it applies to:** required for all new extensions since 3 Nov 2025; missing it blocks signing. Mozilla's post planned "first half of 2026" for all extensions, but I found no later notice.
- **Unlisted:** Mozilla's text says the check happens when "submitted to addons.mozilla.org for signing", which suggests unlisted is covered (inference, not explicit).
- **Versions:** built-in consent works on Firefox desktop 140+ and Android 142+. Set `strict_min_version` 140 under `gecko` and 142 under `gecko_android`, or build your own consent UI for older versions.
- **Design:** declare `"required": ["none"]` from day one, provided the extension only talks to the user's own Promptly server (check against the policy text) and sets the min versions. Declare it on the unlisted build too. The MDN examples are MV2-shaped but the key is the same.
- **Sources:** https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/ ; https://extensionworkshop.com/documentation/develop/web-ext-command-reference/ ; https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/ ; https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/

## 3. Argon2id parameters: CONFIRMED (64 MiB / t=3 / p=1 is a sound floor, but is not literally an RFC config)
- **OWASP minimums (Argon2id, all p=1, stated as equal defence):** m=47104 (46 MiB) t=1; m=19456 (19 MiB) t=2; m=12288 (12 MiB) t=3; m=9216 (9 MiB) t=4; m=7168 (7 MiB) t=5. OWASP adds that increasing p "does not multiply the total memory or act as an iteration count" and "is not a guarantee of slower password guessing".
- **RFC 9106 §4:** FIRST recommended t=1, p=4, m=2^21 (2 GiB), 128-bit salt, 256-bit tag. SECOND recommended t=3, p=4, m=2^16 (64 MiB), same salt and tag.
- **Your floor:** 64 MiB/t=3/p=1 is well above every OWASP minimum and matches RFC second-option memory and passes. It differs only in p (1 vs 4). Inference: acceptable given single-threaded WASM clients, but record p=1 as a deliberate choice.
- **Design:** store m/t/p per user so they can be raised later. Use a 16-byte salt and 32-byte tag.
- **Sources:** https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ; https://www.rfc-editor.org/rfc/rfc9106.html

## 4. Background fetch and CORS: CONFIRMED (Origin header UNCLEAR)
- **Firefox/MDN:** host permissions grant "`XMLHttpRequest` and `fetch` access to those origins without cross-origin restrictions, but not for requests from content scripts". Backend scripts have elevated cross-domain privileges; in MV3 content scripts follow page CORS.
- **Chrome:** docs say the service worker can talk to remote servers given host permissions, and content scripts stay subject to same-origin. They do not use the word "bypass". Host and scheme are matched separately, so http and https are separate entries.
- **Caveats:**
  - `optional_host_permissions`: Chrome 102+, Firefox 128+, MV3 only (BCD).
  - `permissions.request()` must be called inside a user gesture in both browsers, so it cannot be called from a background event. Open an extension page and let the user click.
  - Firefox and most browsers treat `host_permissions` as effectively optional and users can revoke them; check with `permissions.contains`.
  - Firefox shows them in the install prompt only from 127, and an update adding hosts is not shown (bug 1893232).
  - Chrome warns never to proxy arbitrary URLs for content scripts.
- **Origin header:** I found no primary doc stating what the server receives (community notes point to `chrome-extension://<id>`). Firefox is undocumented for background pages.
- **Design:** the server must not reject on unknown Origin or rely on CORS for auth. Log the actual header from both browsers against your own backend. Self-hosted users mean the host is unknown at build time, so use `optional_host_permissions: ["https://*/*"]` (Chrome docs advise this) and request after the user enters their server URL.
- **Sources:** https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts ; https://developer.chrome.com/docs/extensions/develop/concepts/network-requests ; https://developer.chrome.com/docs/extensions/reference/api/permissions ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request

## 5. WebAuthn PRF matrix and extension pages: UNCLEAR (extension + PRF undocumented; Windows Hello details are secondary)

| Platform | Status | Source quality |
|---|---|---|
| Chrome/Edge (desktop, Android) | `create` and `get` PRF since 116 | BCD |
| Firefox | 135 partial (no macOS), 139 full | BCD |
| Firefox Android | 149 for `create`; `get` listed false with impl bug 1958716 | BCD, inconsistent with Bugzilla 1958716 being RESOLVED FIXED |
| Safari | `create` 18; `get` listed false (webkit 259934) | BCD, but Corbado says platform authenticators work from 18; BCD may be stale, test it |
| Safari security keys | PRF + hmac-secret added in 26.4 | WebKit blog (primary) |
| WebKit 311099 | Safari returned the still-encrypted hmac-secret on USB/NFC keys, so outputs differ from Chrome and cross-browser decrypt fails. Status still NEW, but comments say fixed in branch 7624.1.16.13 and Safari TP 241 (Apr 2026). Corbado also lists 314934 (null results on intervalUV keys, e.g. YubiKey Bio) | Bug page; Corbado secondary |
| Windows Hello PRF (hmac-secret) | Only from Feb 2026 update KB5077181, builds 26100.7840+ / 26200.7840+, Windows 11 24H2/25H2. Windows 10: none. The KB page itself does not mention WebAuthn | Secondary (Corbado, project READMEs) |
| Hello PRF at creation | Requires `WEBAUTHN_API_VERSION_8`+: Firefox 147 fixed (bug 1993280); Chrome/Edge 147+ per Corbado, 146 and below `get` only | Bugzilla primary for Firefox; Chrome secondary |
| Security keys | PRF where the key supports hmac-secret; some 2.0/2.1 keys need it requested at creation | Secondary |

- **Regression to watch:** the DSInternals library saw `pHmacSecret`/PRF not returned at creation on build 26200.8655, attributed to the JSON returned by Windows.
- **Extension pages (MDN):** "Starting with Firefox 150 and Chrome 122", extensions can call WebAuthn with an RP ID for any domain in their host permissions.
  - RP ID must be that domain, not the extension URL. Firefox test source says `moz-extension://` cannot be claimed as an RP ID.
  - `clientDataJSON.origin` is `chrome-extension://<id>` or Firefox's deterministic `moz-extension://<sha256-derived>` (not the random UUID). The server must allowlist these.
  - Firefox bug 2026687: the popup closes when the prompt appears, so open a tab.
  - MDN does not mention PRF on this path. No source confirms or denies it.
- **Design:**
  - Treat PRF as an optional unlock, never the only one.
  - Set RP ID = the vault's own domain and use a full tab for enrolment. That requires a host permission for it (a self-hosted domain).
  - Prove with a real test that the extension and web vault get identical PRF output for the same credential and salt.
  - Add a server allowlist entry for the extension origins, and a Firefox 150 min version for this path only.
  - Block or warn on Safari + security key until a version check passes.
- **Sources:** https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api ; https://searchfox.org/firefox-main/source/dom/webauthn/tests/gtest/TestWebAuthnRpIdCommon.h (excerpt) ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/CredentialsContainer.json ; https://bugs.webkit.org/show_bug.cgi?id=311099 ; https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ ; https://bugzilla.mozilla.org/show_bug.cgi?id=1863819 ; https://bugzilla.mozilla.org/show_bug.cgi?id=1993280 ; https://www.corbado.com/blog/passkeys-prf-webauthn (secondary) ; https://github.com/MichaelGrafnetter/webauthn-interop/issues/45 (excerpt)

## 6. storage.session and setAccessLevel: WRONG (not available in Firefox; Chrome takes an object, not a string)
- **Chrome:** `storage.session` since 102, default trusted contexts only (not exposed to content scripts), 10 MB (1 MB before 112). The reference signature is `setAccessLevel(accessOptions: object)`, labelled Chrome 102+, so the call is `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, not a bare string. BCD says 96 for the session area and 140 for all areas; Chrome's page says 102.
- **Firefox:** `storage.session` since 115, same default. `setAccessLevel` is `version_added: false` (impl bug 1724754), on Android too. The MDN method page reads as if available and shows a string argument, which conflicts with Chrome's reference; follow BCD.
- **Safari:** session since 16.4; `setAccessLevel` partial from 17.1, all areas from 27.2.
- **Design:** do not call it unconditionally. You do not need it: the default is already trusted-only in both browsers. Add an E2E test that a content script cannot read `storage.session`. `local`/`sync` stay readable by content scripts in Firefox with no way to restrict them, so never store keys or secrets there.
- **Sources:** https://developer.chrome.com/docs/extensions/reference/api/storage ; https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/storage.json ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session

## 7. HIBP Pwned Passwords: CONFIRMED
- **Docs:** `GET https://api.pwnedpasswords.com/range/{5 hex}`, no key. `Add-Padding: true` gives padding entries with count 0 (discard). `?mode=ntlm` exists. "There is no rate limit on the Pwned Passwords API." No licensing or attribution requirement.
- **User-Agent:** the general API section requires one (403 if missing), not restated for this endpoint.
- **Live test today:**
  - A request with no User-Agent returned 200.
  - The preflight allows `Access-Control-Allow-Headers: Add-Padding` with `Allow-Origin: *`, so a web vault can send padding directly.
- **Design:** query directly from the client (k-anonymous), always pad, send a UA where you can, strip zero-count lines.
- **Sources:** https://haveibeenpwned.com/API/v3 ; live requests to api.pwnedpasswords.com

## 8. 2fa.directory and passkeys.directory: WRONG for passkeys.directory
- **passkeys.directory:** run by 1Password, "© 2026 1Password. All rights reserved", with no documented API, licence or GitHub. Do not scrape or bundle it.
- **Use instead:** the separate non-profit `passkeys.2fa.directory`.
  - Endpoints: `https://passkeys-api.2fa.directory/v1/{all,supported,passwordless,mfa}.json`, each with a PGP `.sig`.
  - Licence: repo licence CC-BY-4.0 (GitHub API). Icons excluded. Cache locally, since Cloudflare may block heavy use.
- **2fa.directory:**
  - Endpoints: `https://api.2fa.directory/v4/{all,sms,email,custom-hardware,u2f,totp,custom-software}.json`. v3 is also supported and adds `tfa.json` and `call.json`. `.sig` files too. v1 and v2 are end-of-life.
  - v4 entries are keyed by domain with `methods`, `documentation`, `recovery`, `notes`.
  - Licence: data is MIT, and attribution is required when visible to users: "Data sourced from 2FA Directory by 2factorauth" with links.
- **Design:** bundle or fetch these on the server and show the attribution lines. "Passkey available" badges should come from the 2factorauth dataset.
- **Sources:** https://passkeys.directory/ ; https://passkeys.2fa.directory/api/ ; https://github.com/2factorauth/passkeys ; https://2fa.directory/api/ ; https://github.com/2factorauth/twofactorauth

## 9. Apple password-manager-resources: CONFIRMED
- **Licence:** MIT text, "Copyright 2020 - 2026 Apple Inc." (`LICENSE.md`; the page does not print the word MIT in the file excerpt but the repo says MIT License).
- **`quirks/` files:** `password-rules.json`, `shared-credentials.json`, `shared-credentials-historical.json`, `change-password-URLs.json`, `apple-appIDs-to-domains-shared-credentials.json`, `web-browser-extension-distribution-information.json`, `websites-that-append-2fa-to-password.json`, `websites-that-ask-for-credentials-for-other-services-when-embedded-as-third-party.json`, plus `schemas/`. The listing has a "View all files" link, so there may be more.
- **Parser:** JS reference at `tools/PasswordRulesParser/PasswordRulesParser.js`.
- **Design:** vendor a pinned copy, keep the notice, and validate against `schemas/`. The repo warns that format and scope may change at any time.
- **Sources:** https://github.com/apple/password-manager-resources ; https://github.com/apple/password-manager-resources/tree/main/quirks ; https://raw.githubusercontent.com/apple/password-manager-resources/main/LICENSE.md

## 10. Closed shadow roots: CONFIRMED
- **Chrome:** `chrome.dom.openOrClosedShadowRoot(element)` since 88 (the `browser.*` alias from 148). Edge mirrors.
- **Firefox:** `dom.openOrClosedShadowRoot` is `version_added: false`, with note "Use `element.openOrClosedShadowRoot`, available since Firefox 63". So Firefox does not implement it on `browser.dom`.
- **Safari:** `dom.openOrClosedShadowRoot` from 26.
- **Note:** MDN's prose page for `dom` reads generically; go by BCD.
- **Design:** `const root = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.openOrClosedShadowRoot ?? el.shadowRoot`. Test on a closed-root fixture in both browsers.
- **Sources:** https://developer.chrome.com/docs/extensions/reference/api/dom ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/dom.json ; https://developer.mozilla.org/en-US/docs/Web/API/Element/openOrClosedShadowRoot

## 11. Passkey wrappers: CONFIRMED
- **`world: "MAIN"` in `content_scripts`:** Chrome 111, Firefox 128, Safari 18 (BCD, no notes). `match_origin_as_fallback`: Chrome 99, Firefox 128, Safari 18.4.
- **Reaching the isolated world:** MAIN-world scripts lack extension APIs, so the wrapper must message an isolated-world content script; Helme calls this the bridge or message bus. The `postMessage`/`CustomEvent` mechanism is my knowledge, not from these pages. MDN warns the page can detect and interfere.
- **Firefox manifest differences:** set `strict_min_version` 128 or fall back. Background uses `scripts`, see item 12.
- **`webAuthenticationProxy`:** Chrome-only, permission of the same name, Chrome 115+, MV3 from 148. Its purpose is remote desktop software relaying WebAuthn to the local client. Only one extension can attach, and normal WebAuthn is suspended while attached. Do not use it as the password manager's interception path.
- **Scott Helme's findings (1Password 8.12.12.44, reported 8 May 2026):**
  - The wrapper ran a full ceremony even when `Permissions-Policy: publickey-credentials-create=()` would make the native call reject.
  - The bridge had no authentication; only structure was checked.
  - Methods were replaceable writable properties, so stored XSS could swap in an attacker's keypair after a real prompt.
- **What a wrapper must do (his fix):**
  - Gate in the isolated-world content script, on the bridge handler, before anything reaches background or native. A main-world `document.featurePolicy` check is spoofable.
  - Read the isolated world's `document.featurePolicy`, which reflects the browser-computed frame policy including `=()`, `=(self)` and cross-origin iframes.
  - Fail closed with a `NotAllowedError` `DOMException` to the page. Use a reason like `permissions-policy-denied` internally.
  - Authenticate bridge messages (nonce or similar). Forged messages should fall through to the native API.
  - 1Password later (8.12.20.10) made the methods a non-configurable accessor with a no-op setter, but the demo still beat it by replacing `navigator.credentials` with a `Proxy`. Locking only the leaf property is not enough.
- **Limit:** none of this stops a compromised script forging a `fmt: "none"` credential to an RP's enrolment endpoint.
- **Firefox gap (inference):** BCD lists `Document.featurePolicy` as Chrome 74, Firefox 69 behind pref `dom.security.featurePolicy.webidl.enabled`, Safari not supported. Helme's rule "no policy object means allow" therefore fails open on default Firefox and Safari. Needs a Firefox-specific decision, and test what the isolated world sees there.
- **Sources:** https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/content_scripts.json ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts ; https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts ; https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy ; https://scotthelme.co.uk/passkeys-permissions-policy-and-bug-hunting-in-1passwords-webauthn-wrapper/ ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Document.json

## 12. WXT and Firefox MV3 background: CONFIRMED
- **WXT:** 0.21.5 (published 2026-10-26), MIT, repo pushed 2026-11-05, not archived, still 0.x. Sponsor-funded; ~155 open issues.
- **Trap:** "By default, WXT will target MV2 for Safari and Firefox", so you must build Firefox with the MV3 option.
- **Per-browser output:** WXT generates per-browser manifests. Source (`packages/wxt/src/internal/manifest.ts`): Firefox + MV3 emits `background: { type, scripts: [script] }`; other MV3 emits `service_worker`; MV2 emits `scripts` plus `persistent`.
- **One manifest with both keys:** supported per MDN. `background: { scripts: [...], service_worker: "..." }` works: Chrome uses the service worker and ignores `scripts` from 121 (before 121 it refuses to load); Firefox uses `scripts`, and from 121 starts the background page regardless of `service_worker` (before 120 it did not start). Firefox `service_worker` is `version_added: false` (bug 1573659).
- **Design:** shared background code must work under both lifecycles (no DOM, no long-lived state, top-level listeners). Keep `background.js` usable for both. Use WXT's separate builds or a single manifest as you prefer; since min versions are 140+ the old quirks do not matter.
- **Sources:** https://wxt.dev/ ; https://wxt.dev/guide/essentials/target-different-browsers ; https://wxt.dev/guide/essentials/entrypoints ; https://raw.githubusercontent.com/wxt-dev/wxt/main/packages/wxt/src/internal/manifest.ts ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json

## 13. Selenium, geckodriver, Playwright Firefox: CONFIRMED (no source tests release builds explicitly)
- **Temporary install:** Mozilla's BiDi docs say "Unsigned extensions can only be installed temporarily, which is the default behavior" and `moz:permanent: true` "requires the extension to be signed".
- **Selenium JS:** `installAddon(path, temporary)` is deprecated; use `installWebExtension(extension, { permanent, allowPrivateBrowsing })`, which uses BiDi if enabled and otherwise the classic geckodriver endpoint. `permanent: false` installs unsigned. A directory cannot be installed permanently over BiDi.
- **Other bindings:** Python `driver.install_addon(path, temporary=True)`, Java `installExtension(path, true)`.
- **Release builds:** none of these docs carve out release builds, but none explicitly test them either. Run a smoke test on release Firefox.
- **Playwright Firefox:** issue 7297 is Closed with an `archive` label, and the only maintainer statement is 2021: "it was never officially supported". Community workarounds: `PLAYWRIGHT_FIREFOX_POLICIES_JSON` force-install (Sep 2025 reports it working; policy route), and `playwright-webextext` (RDP `installTemporaryAddon`, Feb 2026). No official API.
- **Versions:** geckodriver 0.37.1 (2026-07-20), min Firefox 115 ESR; selenium-webdriver 4.52.0; playwright 1.65.0.
- **Design:** Firefox extension E2E goes through Selenium/geckodriver with `installWebExtension(..., {permanent:false})`, or web-ext. Chromium stays on Playwright. This means two harnesses, so keep test scenarios portable.
- **Sources:** https://firefox-source-docs.mozilla.org/remote/webdriver-bidi/Extensions.html ; https://www.selenium.dev/selenium/docs/api/javascript/module-selenium-webdriver_firefox-Driver.html ; https://www.selenium.dev/documentation/webdriver/browsers/firefox/ ; https://github.com/microsoft/playwright/issues/7297 ; https://firefox-source-docs.mozilla.org/testing/geckodriver/Support.html

## 14. Android Chrome third-party autofill: CONFIRMED (Chrome 142 is one vendor's statement; Firefox Android unclear)
- **Timeline:**
  - Chrome 131 (stable 12 Nov 2024): setting testable. The Oct 2024 post was later corrected from 131 to 135.
  - Chrome 135: beta 5 Mar 2025, stable 1 Apr 2025, native third-party autofill.
  - Compat mode removal: blog says July 2025; Android docs say "stopped supporting the compatibility mode from version 137".
  - Chrome 142.0.7444.21: "new permission model" per Norton only. Norton's support page describes the same steps and needing to pick the service. Search found no Chrome or Android source.
- **Setting:** Chrome Settings > Autofill Services > "Autofill using another service", then Restart Chrome. Only changeable if a valid Android autofill service is selected in system settings. Pre-131 flag: `chrome://flags#enable-autofill-virtual-view-structure`.
- **Deep link:** documented and not a `chrome://` URL. `Intent(Intent.ACTION_APPLICATION_PREFERENCES)` with categories `CATEGORY_DEFAULT`, `CATEGORY_APP_BROWSER`, `CATEGORY_PREFERENCE`, plus `setPackage("com.android.chrome")` or a chooser.
- **Query state:** content provider with authority `<channel pkg>.AutofillThirdPartyModeContentProvider`, path `autofill_third_party_mode`, column `autofill_third_party_state` (0 off, 1 on, null cursor = old Chrome). Manifest needs `android.permission.READ_USER_DICTIONARY` and `<queries>` entries for `com.android.chrome`, `com.chrome.beta`.
- **Compat cap:** in the autofill-service XML set `<compatibility-package android:name="com.android.chrome" android:maxLongVersionCode="711900039" />` (also beta/dev/canary).
- **Other browsers (Bitwarden docs, secondary):**
  - Brave, Chrome, Vivaldi use a browser-integration toggle plus the browser setting.
  - Edge, Opera, Samsung Internet need no toggle; Bitwarden uses modified logic and warns credentials could be filled into an embedded or hidden iframe.
  - Samsung reports conflict (community threads; a forum claim of an inline package whitelist is unverified).
  - HTTP sites need a Chrome flag.
- **Firefox Android:** Mozilla only documents Firefox as a provider for other apps (93+). Behaviour as a client is UNCLEAR; test it.
- **Design:** first-run check via the content provider, a button using the intent, and a re-check on resume. Treat non-Chrome browsers as a test matrix and verify the web domain before filling.
- **Sources:** https://android-developers.googleblog.com/2024/10/chrome-3p-autofill-services.html ; https://developers.googleblog.com/chrome-3p-autofill-services/ ; https://android-developers.googleblog.com/2025/02/chrome-3p-autofill-services-update.html ; https://developer.android.com/identity/autofill/autofill-services ; https://chromium.googlesource.com/chromium/src/+/HEAD/components/android_autofill/README.md ; https://support.norton.com/sp/en/us/home/current/solutions/v20251015074832768 ; https://bitwarden.com/help/auto-fill-android/ ; https://support.mozilla.org/en-US/kb/logins-sync-autofill-saving-firefox-preview (excerpt)

## 15. androidx.credentials and CredentialProviderService: WRONG on the allowlist filename only; rest confirmed
- **Versions:** latest stable 1.6.0 (8 Apr 2026). Alpha is 1.7.0-alpha03 (29 Jul 2026), and the Android guide's snippet shows that alpha; pin 1.6.0 unless you need alpha APIs. `credentials-e2ee` is deprecated.
- **Two phases:** the service gets `onBeginCreateCredentialRequest`, `onBeginGetCredentialRequest`, `onClearCredentialStateRequest` and returns entries, each with a PendingIntent. The selected entry opens your activity, which reads via `PendingIntentHandler.retrieveProvider*Request` and returns via `setCreateCredentialResponse`/`setGetCredentialResponse`.
- **PendingIntent rules, exact:** "must be constructed with the flag `PendingIntent.FLAG_MUTABLE` so that the system can append the final request to the intent extra"; must not use `FLAG_ONE_SHOT` (the user may reselect); must use a unique request code per entry.
- **Locked vault:** return `AuthenticationAction`, and on unlock set `setBeginGetCredentialResponse`.
- **Manifest:** `android:permission="android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE"`, action `android.service.credentials.CredentialProviderService`, meta-data `android.credentials.provider`. Android 14+ only.
- **Privileged callers:**
  - Pass an allowlist JSON to `CallingAppInfo.getOrigin(privilegedAllowlist)`. If an origin returns, set it in client data and sign using the supplied `clientDataHash` with a placeholder `clientDataJSON`.
  - Google's openly available list is `https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json`, so the file is `apps.json`, not `gpm_passkeys_privileged_apps.json`.
  - Fetched today: 73 entries of `{type:"android", info:{package_name, signatures:[{build, cert_fingerprint_sha256}]}}`, including Chrome, Edge, Brave, Opera, DuckDuckGo. Providers may use it or their own. Browsers get onto Google's list by a request form.
- **Also note:**
  - Skip the origin-vs-RP-ID check (it breaks Related Origin Requests).
  - `android.settings.CREDENTIAL_PROVIDER` and `ACTION_REQUEST_SET_AUTOFILL_SERVICE` intents; `createSettingsPendingIntent()`.
  - `settingsActivity` in `provider.xml`, and set it even if it is also in `autofill-service`.
- **Design:** ship a bundled, signed copy of the list and refresh it from your server. Fail closed when a package is unknown.
- **Sources:** https://developer.android.com/identity/sign-in/credential-provider ; https://developer.android.com/jetpack/androidx/releases/credentials ; https://developer.android.com/identity/sign-in/privileged-apps (excerpt) ; https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json

## 16. SMS User Consent, autofill timeout, inline suggestions: UNCLEAR on the timeout figure; the rest confirmed
- **SMS User Consent:** current docs carry no deprecation note, and `startSmsUserConsent` in `SmsRetrieverClient` is not deprecated ("waits for an OTP-containing SMS message until timeout (5 minutes)"). `play-services-auth-api-phone` latest 18.3.1 (Maven metadata updated 2026-07-07). A Play policy angle was not found.
- **Autofill timeout:** I found no numeric figure in the docs. `AutofillService` says only that an unanswered request "will eventually time out and be discarded by the Android System". Any figure (such as 5 s) would be undocumented, and I did not verify it against AOSP. I read about 200k of the 250k-character page; the remainder is inherited-method tables.
- **Inline suggestions:** `FillRequest.getInlineSuggestionsRequest()` added in API 30, and the service must set `supportsInlineSuggestions` in its XML. Bitwarden notes that the keyboard must also support it. `getDelayedFillIntentSender` is API 33 with `FLAG_DELAY_FILL`.
- **Design:** answer fill requests from a local index with no network and no unlock (return an authentication dataset when locked). Keep a p99 budget well under a second, and treat the timeout as unknown. On API 33+ consider delayed fill.
- **Sources:** https://developers.google.com/identity/sms-retriever/user-consent/overview ; https://developers.google.com/android/reference/com/google/android/gms/auth/api/phone/SmsRetrieverClient ; https://dl.google.com/android/maven2/com/google/android/gms/play-services-auth-api-phone/maven-metadata.xml ; https://developer.android.com/reference/android/service/autofill/AutofillService ; https://developer.android.com/reference/android/service/autofill/FillRequest

## 17. Windows third-party passkey plugin API: CONFIRMED
- **GA:** Microsoft IT Pro blog: "generally available with the Windows November 2025 security update". KB5068861 is named by one secondary source; rollout was controlled.
- **The Learn page you listed** only walks through the demo app, with no status or version info. The requirements are in the sample's README.
- **Requirements (sample):** Windows 11 25H2 build 26200 minor >= 6725, or 24H2 26100 minor >= 6725. Windows SDK 10.0.26100.7175 or higher.
- **APIs:**
  - `WebAuthNPluginAddAuthenticator`, `WebAuthNPluginAuthenticatorAddCredentials`, `...RemoveCredentials`, `WebAuthNPluginPerformUserVerification`, `WebAuthNPluginUpdateAuthenticatorDetails`, `WebAuthNPluginRemoveAuthenticator`, and the COM `IPluginAuthenticator` interface.
  - Newer `WebAuthNPluginAddAuthenticator2`, `...PerformUserVerification2`, `...UpdateAuthenticatorDetails2` from builds 26200.8524 / 26100.8524 (KB5089573). Headers: `webauthnplugin.h`, `pluginauthenticator.h/.idl` in microsoft/webauthn.
- **User enablement:** Settings > Accounts > Passkeys > Advanced options, then toggle on and verify with Hello.
- **Package identity:** effectively required. The sample uses `Package.appxmanifest` with a CLSID, 1Password ships an MSIX, and a third-party test of an unpackaged server got `APPMODEL_ERROR_NO_PACKAGE` (not a Microsoft statement).
- **Design consequence:** a plain Tauri NSIS/MSI install will not qualify. Plan an MSIX or sparse package for the passkey-provider component, or defer this feature and keep extension-based passkeys on Windows.
- **Sources:** https://learn.microsoft.com/en-us/windows/apps/develop/security/third-party ; https://techcommunity.microsoft.com/blog/windows-itpro-blog/windows-11-expands-passkey-manager-support/4467572 ; https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/PasskeyManager ; https://github.com/microsoft/webauthn ; https://github.com/OlegG90/pswmanager/issues/274 (secondary, excerpt)

## 18. Windows Hello from Win32/Tauri: UNCLEAR (no documented stable-secret mechanism; signature scheme docs conflict)
- **APIs:**
  - `KeyCredentialManager` (`IsSupportedAsync`, `RequestCreateAsync`, `OpenAsync`, `DeleteAsync`) with `KeyCredential.RequestSignAsync(IBuffer)` gives per-user RSA-2048 keys. The private key is never exposed.
  - `UserConsentVerifier` returns a yes/no result only, no key material. Desktop apps must call `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, msg)` (`userconsentverifierinterop.h`, min build 22000) instead of `RequestVerificationAsync`.
- **Rust (`windows` crate 0.62.2):** `windows::Security::Credentials::KeyCredentialManager` has the five methods above, with no `ForWindow` variant in this version. `windows::Win32::System::WinRT::IUserConsentVerifierInterop` exists with an `unsafe` generic `RequestVerificationForWindowAsync`. Cargo feature lists were not shown on these pages.
- **Stable secret:** there is no official method. The common pattern is sign a fixed challenge, then HKDF the signature. Problem: determinism is undocumented, and Microsoft's own pages conflict. `KeyCredentialManager` remarks say "PKCS #1 RSA PSS with SHA256" (PSS is randomised), while the Windows Hello guide verifies with SHA256 and `RSASignaturePadding.Pkcs1`. A Bitwarden-style community design (Boltwarden issue 39) proposes a sign-twice self-test at enrolment, and that is a proposal only.
- **Focus pitfalls (Bitwarden PR 14953):**
  - The `RequestSignAsync` prompt often opens behind other windows, and the API has no window handle.
  - After a few seconds it can fail with `0x80098044` even after confirmation.
  - `SetForegroundWindow` was unreliable.
  - Bitwarden moved to User Consent with a foreground window and dropped the OS key half, and lost unlock on app start.
  - `RequestCreateForWindowAsync(WindowId, ...)` now exists in Microsoft's reference (winrt-26100 and later), but that covers creation, and no sign variant is listed.
- **Security boundary:** a Microsoft Q&A thread (no authoritative answer) has a test where an unpackaged process opened another app's credential and got a signature after Hello. Assume any same-user process that knows the name can use it; packaging is not proven to isolate.
- **DPAPI:** `CryptProtectData` binds to the user's logon, and any same-user process can decrypt. `pOptionalEntropy` adds a secret. `CRYPTPROTECT_PROMPTSTRUCT` flow is deprecated and "will be removed in April 2027", so never use it.
- **Design:**
  - Treat Hello as a convenience unlock. Master password remains the root.
  - Simplest honest option: DPAPI-wrapped key plus a UCV gate, documented as "gate, not crypto boundary" against same-user malware.
  - If you want crypto binding, use sign-then-HKDF as DPAPI entropy, with a two-sign self-test at enrolment and fallback to master password on mismatch or PIN reset (`NotFound`).
  - Test focus from a Tauri window with `hwnd`.
- **Sources:** https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredentialmanager ; https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello ; https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync ; https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredentialmanager.requestcreateforwindowasync ; https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier ; https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nn-userconsentverifierinterop-iuserconsentverifierinterop ; https://microsoft.github.io/windows-docs-rs/doc/windows/Security/Credentials/struct.KeyCredentialManager.html ; https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/WinRT/struct.IUserConsentVerifierInterop.html ; https://github.com/bitwarden/clients/pull/14953 ; https://github.com/vleeuwenmenno/boltwarden/issues/39 ; https://learn.microsoft.com/en-us/answers/questions/5912130/what-is-the-security-boundary-of-windows-hello-key ; https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata

## 19. Windows clipboard formats: CONFIRMED
All three need `RegisterClipboardFormat` to get their id:
- `ExcludeClipboardContentFromMonitorProcessing`: "any data" excludes all formats from both history and cloud sync.
- `CanIncludeInClipboardHistory`: serialized DWORD, 0 = exclude, 1 = explicitly include. Does not affect sync.
- `CanUploadToCloudClipboard`: serialized DWORD, 0 = do not sync, 1 = explicitly sync. Does not affect local history.

**Design:** on copy, set the text plus Exclude (any data) and both DWORDs to 0, in the same clipboard open. Auto-clear after N seconds only if the clipboard sequence or contents is still yours.

**Source:** https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats

## 20. DOM-based extension clickjacking: CONFIRMED (Marek Tóth, DEF CON 33, 9 Aug 2025, updated 14 Jan 2026)
Attacker lures a click on something fake (cookie banner, captcha, close button) while the extension's injected UI is invisible or covered. No CVE IDs in the article.

### Attack variants (one test each)

| # | Family | Mechanism |
|---|---|---|
| 1 | Extension Element: Root | `opacity` set on the extension's root element (0, also 0.5 for demo) |
| 2 | Extension Element: Child | `opacity: 0 !important` via `cssText` on children inside an open shadow root (an iframe in the example). Root found by tag-name prefix because the name changes per load. Survived a root-only fix in Proton Pass |
| 3 | Parent: BODY | `opacity` on `<body>` (0 or 0.001), with a site screenshot as `<html>` `background-image` so the page looks normal. Needs matching screen resolution. Opacity restored to 1 after capture |
| 4 | Parent: HTML | `opacity` on `<html>`; victim must click a blank page (e.g. fake reaction-time game) |
| 5 | Overlay: Partial | Elements placed around the UI leaving only a small clickable hole. Uses the injected element being last in DOM with max z-index (2147483647 seen), or Popover top layer |
| 6 | Overlay: Full | Element covering the whole UI with `pointer-events: none`, clicks pass through; `popover="manual"` + `showPopover()` so it stays open after the click |
| 7 | Position: Fixed | Autofill UI fixed under the lure element (accept/decline/close/checkbox). Simpler form: fix the attacker's form so the UI opens there |
| 8 | Position: Mouse-follow | Extension UI or attacker form moved under the cursor on `mousemove`, input refocused repeatedly, so one click anywhere fills |
| 9 | IFRAME (classic, related) | Extension HTML pages in `web_accessible_resources` loaded in a transparent iframe; MV3 `matches` restricts this. NordPass, Dec 2023 |

- **Other CSS used in the article:** `z-index`, `position`, `top/left/width/height/margin`, `display`, `visibility: visible !important`, `animation`, `overflow: hidden`, `background-color`.
- **Not mentioned:** `filter`, `clip`, `mask`. Add these yourself (inference).
- **Supporting techniques:** a universal script detects which manager's UI is present and reads DOM attributes to tell locked from unlocked vaults. Keep your DOM free of vault-state signals.

### What gets stolen
- **Attacker's own site:** cards and personal data (fill anywhere). Needs no site flaw, 1-2 clicks.
- **Site with XSS, subdomain takeover or cache poisoning:** login, password, TOTP, since all tested managers fill into subdomains by default.
- **Custom-content platforms (Jan 2026 addition):** user-uploaded HTML/SVG on sibling subdomains (e.g. Shopify CDN) host the script with no vulnerability, so sibling admin-panel credentials are exposed.
- **Passkeys:** signed assertion replay when the server doesn't session-bind the challenge. Named as lacking it: Hanko, SK Telecom, NokNok, Authsignal, Passage, Corbado, Descope.

### Limits
Vault unlocked, at least one click, credentials stored for the target domain, matching screen resolution for the screenshot lure.

### Developer mitigations in the article (near-verbatim)
- Extension Element:
  - "styles cannot be changed (MutationObserver)"
  - "using 'Closed Shadow-Root'"
- Parent Element:
  - "BODY/HTML opacity detection"
  - "using Popover API for extension should protect this method"
- Overlay:
  - "the extension UI element must be the last element in DOM"
  - "popover elements listing - when the autofill menu is opened, check if any other 'top layer' elements exist", and close or hide if so
  - `elementsFromPoint()` works for partial overlays but not popovers, and ignores `pointer-events: none`; temporarily remove `pointer-events: none` from popovers before checking
- Handle both timings: tampering before the UI renders and after it is visible.
- Confirmation: clear text naming the data type (criticised 1Password's generic "item").
- "The safest solution is to display a new popup window" (or context menu or system dialog).
- TOTP stored separately from the password undermines one-click compromise of both.
- "Doesn't exist simple protection." "Some platform-level support should be created."
- IntersectionObserver v2 is not mentioned.

### Website and user mitigations
- **Websites:**
  - Session-bind passkey challenges.
  - Verify before adding a device or passkey.
  - Limit CORS.
  - Fix XSS and takeovers.
  - `X-Frame-Options`/`frame-ancestors` for iframe clickjacking only.
- **Users:**
  - Update.
  - Disable manual on-page autofill and use the toolbar icon.
  - Set Chromium site access to "on click".
  - Use exact-URL matching.
  - Disable 0-click autofill.
  - Keep 2FA elsewhere.
  - Lock when idle.

### Vendor status (as of 14 Jan 2026)
The article gives versions, not fix strategies. "Fixed means that only the described methods from this research are patched."

| Manager | Status | Fixed in | Methods |
|---|---|---|---|
| 1Password | Vulnerable (<=8.11.27.2) | none; dialog text changed Aug 2025 | Parent, Overlay |
| LastPass | Vulnerable (<=4.150.1) | none | card/personal noted fixed <=4.125.0, ambiguous |
| Bitwarden | Fixed | 2025.8.2 (31 Aug 2025) | Overlay <=2025.8.1 |
| Dashlane | Fixed | v6.2531.1 (1 Aug 2025) | passkey dialog |
| Enpass | Fixed | 6.11.6 (13 Aug 2025) | Parent, Overlay <=6.11.5; Extension <6.11.4.2 |
| iCloud Passwords | Fixed | 3.1.30 (21 Oct 2025) | Extension <=3.1.27; earlier 2.3.22 |
| Keeper | Fixed | 17.2.0 | Extension <17.1.2; Overlay <17.2.0 |
| KeePassXC-Browser | Fixed | 1.9.11 (26 Nov 2025) | <=1.9.9.2 |
| LogMeOnce | Fixed | 7.12.7 (9 Sep 2025) | Extension, Parent, Overlay |
| NordPass | Fixed | 5.13.24 (15 Feb 2024) | IFRAME |
| Proton Pass | Fixed | 1.31.6 | Extension, Parent <1.9.5; Extension <=1.31.0; Overlay <=1.31.4 |
| RoboForm | Fixed | 9.7.6 (25 Jul 2025) | Extension <9.5.6; Parent, Overlay <=9.7.5 |

Article inconsistency: its conclusion still calls Bitwarden, Enpass, iCloud and LogMeOnce vulnerable, and summary counts differ from the table. The table above follows its fix-status section.

### Suggested test suite (inference from the above)
- Run variants 1-8 against each injected UI: both before render and after visible; each with `opacity` 0, 0.001 and 0.1, and also `!important`.
- Add `filter`, `clip-path`, `mask`, `visibility`, `transform` scale, ancestor `opacity` on any ancestor, and `popover=manual` both before and after your UI opens.
- Assert no fill occurs and no secret enters the DOM, and that vault lock state is unreadable from the page.
- Secrets should reach the page only after a trusted gesture on a UI that passed checks at click time. Check `event.isTrusted` plus a re-verification at click time, not just at open.
- Best design per the article: no inline fill of cards or identity without a popup or toolbar confirmation. Treat this as the baseline.

**Sources:** https://marektoth.com/blog/dom-based-extension-clickjacking/

## 21. FIDO CXF: CONFIRMED (first 100k of 240k characters read: data model complete, sharing and IANA sections not read)
- **Header:** `version {major, minor}`, `exporterRpId`, `exporterDisplayName`, `timestamp`, `accounts[]`.
- **Account:** `id` (b64url), `username`, `email`, `fullName?`, `collections[]`, `items[]`, `extensions?`.
- **Collection:** `id`, `creationAt?`, `modifiedAt?`, `title`, `subtitle?`, `items[] {item, account?}`, `subCollections?`, `extensions?`.
- **Item:** `id`, `creationAt?`, `modifiedAt?`, `title`, `subtitle?`, `favorite?`, `scope? {urls[], androidApps[{bundleId, certificate?{fingerprint, hashAlg}, name?}]}`, `credentials[]`, `tags?`, `extensions?`.
- **EditableField (EF):** `{id?, fieldType, value, label?, extensions?}`. fieldType: `string`, `concealed-string`, `email`, `number`, `boolean`, `date`, `year-month`, `wifi-network-security-type`, `country-code`, `subdivision-code`.
- **Field map:**

| Yours | `type` | Fields |
|---|---|---|
| Login | `basic-auth` (URLs live in `item.scope`) | `username?` EF, `password?` EF concealed |
| TOTP | `totp` | `secret` (Base32), `period`, `digits`, `username?`, `algorithm` (sha1/sha256/sha512/other), `issuer?`. Plain values, not EFs |
| Passkey | `passkey` | `credentialId` b64url, `rpId`, `username`, `userDisplayName`, `userHandle` b64url, `key` b64url PKCS#8 DER, `fido2Extensions? {hmacCredentials?{algorithm, credWithUV, credWithoutUV}, credBlob?, largeBlob?{uncompressedSize, data}, payments?}` |
| Note | `note` | `content` EF |
| Card | `credit-card` | `number?`, `fullName?`, `cardType?`, `verificationNumber?`, `pin?`, `expiryDate?` (year-month), `validFrom?` |
| Other | `address`, `api-key`, `custom-fields`, `drivers-license`, `file`, `generated-password`, `identity-document`, `item-reference`, `passport`, `person-name`, `ssh-key`, `wifi` | see spec |

- **Design:** one Item holds many credentials, so a login + TOTP + passkey arrives as one item. Ignore unknown types and fields but report them. Store `hmacCredentials` if you support PRF passthrough.
- **Source:** https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html

## 22. Tauri 2: CONFIRMED
- **Versions:** tauri 2.12.5 (2026-10-21); CLI 2.12.4; 3.0.0-alpha exists, stay on 2.x.
- **tauri-driver:** 2.1.0, README still says "pre-alpha". Windows via Microsoft Edge Driver, Linux via WebKitWebDriver, no macOS. Docs: msedgedriver must match the Edge version or the suite may hang; found on PATH or via `--native-driver`; helper `cargo install --git https://github.com/chippers/msedgedriver-tool`. Install `cargo install tauri-driver --locked`.
- **Community report (one PR):** wry's own WebView2 arguments can cause "DevToolsActivePort" failures even with matching versions. Tauri docs also mention an embedded WebDriver route.
- **Updater:**
  - Signature is mandatory and "cannot be disabled". `tauri signer generate -w <path>`.
  - Build env vars: `TAURI_SIGNING_PRIVATE_KEY` (path or contents), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `.env` files do not work.
  - `pubkey` in config, `createUpdaterArtifacts: true`. Plugin 2.14.1.
  - Dynamic server: 204 for no update, 200 JSON with `url`, `version`, `signature`.
  - Windows `installMode`: `passive` (default), `basicUi`, `quiet`. Losing the key means no updates for existing installs.
- **Bundling:**
  - MSI only on Windows (WiX v3); needs the VBSCRIPT optional feature.
  - Not on the docs page, but the bundler source auto-downloads and hash-checks `wix314-binaries.zip` and NSIS 3.13 plus `nsis_tauri_utils.dll`, so a build needs network access or a tools cache.
  - NSIS `installMode`: per-user default, `perMachine`, `both`.
- **WebView2 `webviewInstallMode`:** `downloadBootstrapper` default (0 MB, internet), `embedBootstrapper` (~1.8 MB), `offlineInstaller` (~127 MB), `fixedRuntime` (~180 MB), `skip`.
- **Global shortcut:** `tauri-plugin-global-shortcut` 2.4.1 (Rust 1.90+, desktop block). No default permissions; enable `global-shortcut:allow-register` etc. in a capability.
- **Tray:** `tauri` feature `tray-icon`, `TrayIconBuilder`, `show_menu_on_left_click(false)`; `on_tray_icon_event` not on Linux.
- **Design:** NSIS per-user plus the updater. Store the signing key in CI secrets with an offline backup. See item 17 for why this doesn't cover the passkey plugin.
- **Sources:** https://crates.io/crates/tauri ; https://tauri.app/develop/tests/webdriver/ ; https://v2.tauri.app/develop/tests/webdriver/manual-setup/ ; https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-driver/README.md ; https://tauri.app/plugin/updater/ ; https://tauri.app/distribute/windows-installer/ ; https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/msi/mod.rs ; https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs ; https://tauri.app/plugin/global-shortcut/ ; https://tauri.app/learn/system-tray/

## 23. Libraries: CONFIRMED (BouncyCastle Argon2 speed UNCLEAR)

| Lib | Latest | Licence | Notes |
|---|---|---|---|
| hash-wasm | 4.12.0 (2024-11-19) | npm MIT; GitHub API shows NOASSERTION, read the LICENSE | No release for two years; WASM bundled as base64; single-threaded Argon2. README has no CSP note |
| @noble/hashes | 2.4.0 (2026-08-27) | MIT | Audit: Cure53 Jan 2022 at 1.0.0, excluding `argon2`, `blake3`, `sha1`, `sha3-addons`. AI self-audits since Apr 2026. v2 ESM-only with `.js` imports, Node 20.19+. Its `argon2` is about 5x slower than native and unaudited, so do not use it for the vault KDF |
| @noble/curves | 2.4.0 (2026-08-27) | MIT | Audits: Trail of Bits 2.3.0 Aug 2026 (everything); Cure53 1.6.0 Sep 2024; Kudelski 1.2.0; ToB 0.7.3. ed25519 and x25519 at `@noble/curves/ed25519.js` |
| jsqr | 1.4.0 (2021-04-24) | Apache-2.0 | Repo last pushed May 2026, 98 open issues; effectively dormant, keep it isolated or use `BarcodeDetector` first |
| @zxcvbn-ts/core | 4.2.0 (2026-08-12) | MIT | Dictionaries in separate language packages; check each one's data licence |
| tldts | 7.4.19 (2026-10-20) | MIT | Active |
| EFF large wordlist | `https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt` | EFF default CC BY 4.0 (eff.org/copyright); downstream packagers cite CC BY 3.0 US | The page has no list-specific licence. Attribute EFF either way. 6^5 = 7776 words by inference |
| bcprov-jdk18on | 1.86 (Maven Central metadata 2026-09-11) | MIT-style Bouncy Castle licence | search.maven.org still shows 1.80 (stale) |
| argon2kt | 1.6.0 (published 2024-09) | MIT | JNI over phc-winner-argon2; direct ByteBuffers so secrets can be wiped; aar only; repo pushed 2026-11-01 |
| aes-gcm | 0.11.1 | see crate | RustCrypto |
| argon2 (crate) | 0.6.0 | see crate | RustCrypto |
| hkdf | 0.13.0 | see crate | RustCrypto |
| x25519-dalek | 3.0.0 | see crate | Major version bump 2026-07 |
| ed25519-dalek | 3.0.0 | see crate | Same |

- **wasm-unsafe-eval (partly inference):** hash-wasm instantiates WASM. Firefox MV3 requires `'wasm-unsafe-eval'` in `script-src` (102+); Chrome's minimum extension-page CSP already permits it. Declare `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"`, and add it to the web vault's CSP.
- **Argon2 speed on Android:** no benchmark found for BouncyCastle vs native at 64 MiB. Benchmark on a low-end device. Expect JNI to win (inference).
- **To check (from memory, not verified):** whether the 2024 argon2kt AAR's native libs meet Google Play's 16 KB page-size requirement. You self-host the APK, so it matters less, but check it anyway.
- **Design:** hash-wasm for extension and web, argon2kt on Android, RustCrypto `argon2` on Tauri. One shared known-answer vector across all three. The Rust crates' major bumps can change APIs, so pin them.
- **Sources:** https://registry.npmjs.org/ (each package) ; https://crates.io/ (each crate) ; https://raw.githubusercontent.com/Daninet/hash-wasm/master/README.md ; https://raw.githubusercontent.com/paulmillr/noble-hashes/main/README.md ; https://raw.githubusercontent.com/paulmillr/noble-curves/main/README.md ; https://github.com/cozmo/jsQR ; https://raw.githubusercontent.com/zxcvbn-ts/zxcvbn/master/README.md ; https://www.eff.org/dice ; https://www.eff.org/copyright ; https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/maven-metadata.xml ; https://www.bouncycastle.org/about/license/ ; https://raw.githubusercontent.com/lambdapioneer/argon2kt/main/README.md ; https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy (excerpt) ; https://developer.chrome.com/docs/extensions/mv3/manifest/content_security_policy/ (excerpt)

## 24. Authenticator import formats: CONFIRMED (all unofficial; no Google or Valve spec exists)
- **Google Authenticator** `otpauth-migration://offline?data=<base64 protobuf>`, from an MIT community reconstruction:
  - `MigrationPayload`: `otp_parameters=1` (repeated), `version=2`, `batch_size=3`, `batch_index=4`, `batch_id=5`.
  - `OtpParameters`: `secret=1` (bytes), `name=2`, `issuer=3`, `algorithm=4`, `digits=5`, `type=6`, `counter=7` (int64).
  - Enums: Algorithm 0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5; DigitCount 1 six, 2 eight; OtpType 1 HOTP, 2 TOTP.
  - GNOME Authenticator's Rust version uses different enum names but handles only SHA1. Handle multi-QR batches.
- **Aegis** (repo GPL-3.0; format doc used for facts, no code):
  - Top level `version` (1), `header {slots, params}` null when plain, `db {version (3), entries[], groups[]}`.
  - Entry: `type` (hotp/totp/steam/motp/yandex), `uuid`, `name`, `issuer`, `note`, `icon`, `icon_mime`, `icon_hash`, `favorite`, `info {secret, algo, digits, period|counter, pin?}`, `groups`.
  - Encrypted: `db` is a Base64 string, AES-256-GCM, password slots use scrypt N=2^15, r=8, p=1.
- **2FAS** (repo GPL-3.0; only JSON field names taken):
  - Top: `services[]`, `groups[]`, `updatedAt`, `schemaVersion` (currently 4), `appVersionCode`, `appVersionName`, `appOrigin`, `account?`, `servicesEncrypted?`, `reference?` (present means encrypted).
  - Service: `name`, `secret`, `updatedAt`, `type`, `serviceTypeID`, `otp {link, label, account, issuer, digits, period, algorithm, counter, tokenType, source}`, `order {position}`, `badge`, `icon`, `groupId`.
- **Steam Guard:** Base64 shared secret, HMAC-SHA1, 30 s, dynamic truncation, then 5 characters from `23456789BCDFGHJKMNPQRTVWXY`. Cited from the `steam_guard` crate (MIT per crates.io) plus RFC 6238 for the base. No Valve documentation found.
- **Design:** implement from these facts with your own test vectors, do not copy GPL code. Encrypted Aegis and 2FAS imports are an extra step; start with plain.
- **Sources:** https://cdn.jsdelivr.net/npm/otpauth-migration-parser@0.1.1/otpauth-migration.proto ; https://world.pages.gitlab.gnome.org/Authenticator/authenticator/backup/google/protobuf/struct.MigrationPayload.html (excerpt) ; https://raw.githubusercontent.com/beemdevelopment/Aegis/master/docs/vault.md ; https://raw.githubusercontent.com/twofas/2fas-android/develop/data/services/src/main/java/com/twofasapp/data/services/domain/BackupContent.kt ; https://docs.rs/steam_guard/latest/src/steam_guard/lib.rs.html (excerpt) ; https://www.rfc-archive.org/getrfc?rfc=6238 (excerpt)

## 25. Bitwarden export and 1Password .1pux: UNCLEAR for Bitwarden encrypted byte details; rest confirmed
- **Bitwarden official docs:**
  - Types: `.json`, `.csv`, `.json (Encrypted)` (account restricted or password protected), `.zip` with attachments.
  - Only `.json` includes passkeys, cards, identities and SSH keys.
  - Plain JSON: top `encrypted`, `folders[{id, name}]`, `items[]`, `collections` on org files.
  - Item: `id, organizationId, folderId, type (1 login, 2 note, 3 card, 4 identity), reprompt, name, notes, favorite, fields[{name, value, type}], login{uris[{match, uri}], username, password, totp}, collectionIds, passwordHistory[{lastUsedDate, password}]`.
  - Docs don't list the SSH type or `fido2Credentials` fields, so read them from a real export.
  - Password protected per docs: password is salted and run through "your configured KDF settings", expanded with HKDF into a key that encrypts and produces a MAC. No byte-level format published.
- **Bitwarden third-party notes (secondary):**
  - Fields `encrypted: true, passwordProtected: true, salt, kdfType, kdfIterations, kdfMemory?, kdfParallelism?, encKeyValidation_DO_NOT_EDIT, data`.
  - Stretch with HKDF-Expand info `"enc"` and `"mac"`.
  - Cipherstrings `2.<iv>|<ct>|<mac>` as AES-256-CBC + HMAC-SHA256 (verify MAC over iv || ct, then decrypt).
  - Decrypt the validation field first; wrong password fails the MAC.
- **Bitwarden conflicts:**
  1. Bramble says "always PBKDF2", while Bitwarden's help page ("configured KDF settings") and one issue describe Argon2id as kdfType 1.
  2. Salt input: Bramble says base64-decoded bytes; a bitwarden/android PR says UTF-8 bytes of the base64 text, not decoded. An implementation built from one note could reject every file.
- **Bitwarden design:** support both KDFs. Create real test exports (PBKDF2 and Argon2id) in your own account to pin this before writing the importer. Build a clean-room importer from docs and observed files, no client code (GPL).
- **1PUX official:**
  - `<uuid>.1pux` ZIP with `export.attributes` (`version, description, createdAt`), `export.data`, `files/`.
  - `accounts[].attrs{accountName, name, avatar, email, uuid, domain}`, `.vaults[].attrs{uuid, desc, avatar, name, type P/E/U}`, `.items[]`.
  - Item: `uuid, favIndex, createdAt, updatedAt, state (active/archived), categoryUuid, overview{subtitle, title, url, urls[{label, url}], tags[]}, details{loginFields[{value, name, type, designation}], notesPlain, sections[{title, name, fields[{title, id, value}]}], passwordHistory[{value, time}], documentAttributes}`.
  - Field type codes T, E, U, N, P, A, TEL. The page's prose says `type`, its example says `fieldType`, so accept both.
- **1PUX gap:** only `categoryUuid: "001"` = Login is evidenced. The docs give no category table. Do not hard-code 002+ without a real export; fall back to shape detection.
- **Sources:** https://bitwarden.com/help/encrypted-export/ ; https://bitwarden.com/help/export-your-data/ ; https://bitwarden.com/help/condition-bitwarden-import/ ; https://github.com/flythenimbus/bramble/blob/main/docs/encrypted-import.md (secondary) ; https://github.com/jotyy/vauly/issues/50 (secondary, excerpt) ; https://github.com/bitwarden/android/pull/7415 (excerpt) ; https://support.1password.com/1pux-format/
