# Promptly Passwords for Windows

Tauri 2 (2.12.x, not the 3 alpha) with the shared vault UI from `frontend/src/passwords/ui` in WebView2. Windows only. Linux and macOS are out of scope and untested.

## Layout

| Path | What |
|---|---|
| `src/` | The pages: `main.tsx` (connect flow, `Platform`), `shell.ts` (quick search, backup and SSH on the page side), `settings.tsx` (Desktop settings), `overlay.ts` (quick search window), `native.ts` (calls into Rust), `ssh.ts` (reads SSH items) |
| `src-tauri/` | The app: windows, tray, shortcut, commands. Also `src/bin/promptly-native-host.rs`, the browser's native messaging host |
| `native/` | Native code with no Tauri in it, so it has plain tests: auto-type, clipboard, Hello, DPAPI, native messaging, SSH agent, backup rules, network rules |
| `crypto-tests/` | The vault format in Rust on RustCrypto and dalek, tested against the shared `vectors.json`. Not linked into the app |
| `e2e/` | `tauri-driver` tests of the real app against the `:8092` stack |
| `build-ui.mjs` | esbuild and Tailwind from `frontend`, into `ui-dist/`, which Tauri embeds in the exe |

## Build

```
npm install
cargo tauri build            # target/release/bundle/nsis/*-setup.exe
```

Needs rustc 1.90+, MSVC build tools, Windows SDK, Node. The bundler downloads NSIS itself on first run. `cargo install tauri-cli --version 2.12.4 --locked`.

## Test

```
cargo test --workspace                 # crypto vectors, native logic, real DPAPI, real pipes
cargo clippy --workspace --all-targets -- -D warnings
npm run test:js                        # SSH item parsing, with keys from the real ssh-keygen
npm run typecheck                      # with frontend's tsc: ../../frontend/node_modules/.bin/tsc --noEmit

# The real app, driven. Needs the :8092 stack, docker, tauri-driver (cargo install tauri-driver
# --version 2.1.0 --locked), and an msedgedriver of exactly the installed WebView2's version.
# Build straight before running: `cargo test` overwrites target/debug with a non-e2e exe.
npm run build:e2e
MSEDGEDRIVER=C:\path\to\msedgedriver.exe npm run test:e2e

# The release exe, far enough to show it renders under the real CSP with no test hooks in it.
MSEDGEDRIVER=C:\path\to\msedgedriver.exe node e2e/release-smoke.mjs

# A one-off, about 7 minutes: do timers keep running in a hidden window? See below.
MSEDGEDRIVER=C:\path\to\msedgedriver.exe node e2e/hidden-timers.mjs
```

Driver notes for next time. Get msedgedriver from `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`, where the version is the newest folder under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`. Without `webviewOptions.userDataFolder`, msedgedriver silently puts WebView2 on a throwaway profile each session and overrides the app's own choice. `--user-data-dir` in `args` is reported back as accepted and has no effect. The driver's browser arguments also replace the app's. The `DevToolsActivePort` failure one report mentions (VERIFY_NOTES 22) didn't appear here: tauri-driver 2.1.0, msedgedriver and WebView2 156.0.4314.58, tauri 2.12.5.

The `e2e` Cargo feature exists only for that last one, and a release build has none of it: an in-memory clipboard, a mocked Hello gate (DPAPI stays real), no global shortcut and no single-instance lock, a data folder from `PROMPTLY_PW_DATA_DIR`, `PROMPTLY_PW_NO_BROWSER`, `PROMPTLY_PW_NO_REGISTRY` and `PROMPTLY_PW_OFFLINE`, and commands to open the overlay and settings. So a test run doesn't press keys or touch the clipboard on whoever's desktop it's on.

`native/tests/clipboard_real.rs` tests the real clipboard code in a window station of its own, because clipboards belong to window stations, and checks the real clipboard's sequence number didn't move. `native/tests/ssh_real.rs` runs the real `ssh-add` and `ssh-keygen -Y` against the agent on a private pipe.

## How it fits together

**No network in the page.** The CSP is `script-src 'self' 'wasm-unsafe-eval'`, with `connect-src` only for Tauri's IPC. `VaultApi` takes a `fetcher`, and here that's `net_fetch` in Rust, which only reaches the connected server's `/api/passwords/`, refuses redirects, and adds the device token itself. The page hands the token to Rust once when connecting and never gets it back. On disk it's DPAPI-wrapped. Using Rust for requests also means no change to the server's exact-match CORS list. TLS is the Windows stack (`native-tls`), so a self-hosted server's private CA works if Windows trusts it.

**Two vault clients in one page**, like the extension's background and pages (DECISIONS D14). `VaultApp` owns one. `shell.ts` owns another for what happens outside the screens, and `Platform.unlock` and `restore` keep them on the same keys. After a change `notifyChanged` re-reads the shared IndexedDB. The offline copy is `IdbStore` in the app's WebView2 profile, under `%LOCALAPPDATA%\org.promptly.passwords\webview`.

**Rust never holds vault keys.** It gets a secret only per use: the text to put on the clipboard, the characters to type, the 64-byte unlock secret to wrap for Hello. SSH private keys stay in the page, which signs after Rust has the person's approval.

**Quick search.** The shortcut handler in Rust records the window in front and makes a single-use gesture token that expires after 60 s. The overlay shows titles and usernames only, and says which item and what to do. The main page then hands the secret to Rust. Auto-type needs that token, and the overlay can't call anything but its own four commands.

**Auto-type rules** (`native/src/autotype.rs`). Types username, Tab, password, and never Enter. Refuses our own windows, and elevated windows, where Windows would drop the keys silently. The window's title must contain the item's title as whole words, or a custom field named `Window title`. A mismatch shows both titles and needs a second key press. Focus is checked before every key, and typing stops if it moved.

**Clipboard.** A secret goes on with `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`=0 and `CanUploadToCloudClipboard`=0 in one clipboard open. It's cleared after the vault's clipboard setting (30 s by default) only if the sequence number shows nothing's been copied since. Quit clears it too.

**Windows Hello.** A DPAPI-wrapped unlock secret, handed back after `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with the app's window. **It's a convenience gate, not a crypto boundary:** same-user malware can call DPAPI directly. After a master password change the saved secret stops working, and the app says the password isn't right. Turn Hello off and on again to fix that.

**Native messaging host.** `promptly-native-host.exe`, registered per user in HKCU by Desktop settings, with manifests under the app's data folder. Firefox's id is fixed (`passwords@promptly.app`). Chrome-family ids are typed in until a store listing fixes one, because an unpacked extension's id depends on its path. The host checks the origin against that list, then that its parent is a known browser under Program Files or LocalAppData, allowing the one `cmd.exe` Chrome uses. This raises the bar; a same-user attacker can get round it. Each extension has its own wrapped file.

**Backup.** `core/exporter.ts` encrypts in the page, on the schedule, while the vault's unlocked. Rust refuses to write anything that isn't an encrypted export, and prunes only its own files. The backup password is separate from the master password and DPAPI-wrapped so it can run unattended. It covers item bodies, not attachments.

**SSH agent.** Off by default. Opens `\\.\pipe\openssh-ssh-agent` with `first_pipe_instance`, so if Windows's OpenSSH agent has it, Windows refuses, we say so and leave it alone. Rejects remote clients, and the DACL admits only this user. Offers Ed25519 keys with no passphrase. RSA, ECDSA and passphrase-protected keys aren't offered. Every signature gets a native Yes/No box with No as the default, naming the program and the key.

## A hidden window keeps running

Quick search and the SSH agent answer from the hidden main window, and VaultApp reads a timer gap over 60 s as the machine having slept. `e2e/hidden-timers.mjs` hid the window for 7 minutes, past Chromium's 5-minute throttling point, with the release's browser arguments: the longest gap in a 5 s timer was 5.014 s. `document.visibilityState` still said `visible` straight after hiding, so WebView2 may not be treating it as hidden at all. This was measured under the driver, not in a release exe.

## Things a test found, worth not undoing

- **WebView2's general autofill is on by default, and wrote form values to `EBWebView\Default\Web Data` in plain text.** That included an item's password and title, and the Secret Key, despite `autocomplete="off"`. `general_autofill_enabled(false)` on both windows stops it. The e2e disk scan fails if it comes back.
- **`freezePrototype` is off.** With it on, a bundled dependency's `toString` assignment throws at load and the window is blank.
- **Each `Shell` listens for Rust's events,** so there must be only one per page. Two answered quick search over each other, and the locked one sometimes won.

## Updates: off until the owner configures a key

The plugin is compiled in but not registered until `plugins.updater.pubkey` and `plugins.updater.endpoints` are both set in `src-tauri/tauri.conf.json`. A test fails if the checked-in config turns it on. When it's off, "Check for updates" is greyed out in the tray.

1. `cargo tauri signer generate -w <somewhere safe>`. Back it up offline. **Losing it means existing installs can never update.**
2. Put the public key in `plugins.updater.pubkey`, your `/downloads` endpoint in `plugins.updater.endpoints`, and set `bundle.createUpdaterArtifacts` to `true`.
3. Build with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment. `.env` files don't work for these.
4. Fix the updater test that asserts it's off.

None of the update path has been run, since it can't be without a key.

## Unsigned

The installer isn't code-signed, so SmartScreen warns on install, and that needs a certificate from the owner. The NSIS install is per-user and asks for no elevation. WebView2 comes from Windows, or the installer's bootstrapper downloads it if missing.
