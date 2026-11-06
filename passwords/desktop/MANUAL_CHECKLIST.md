# Windows app: manual checklist

For what automation can't reach on someone's real desktop. Use a throwaway vault, not real passwords. Install `target/release/bundle/nsis/Promptly Passwords_0.1.0_x64-setup.exe`.

## Install

- [ ] SmartScreen warns, since it's unsigned. "More info", then "Run anyway" installs without asking for admin.
- [ ] It's in the Start menu. `promptly-native-host.exe` sits next to `promptly-passwords.exe` in `%LOCALAPPDATA%\Promptly Passwords`.
- [ ] On a machine or VM with no WebView2, the bootstrapper fetches it.
- [ ] Uninstall removes the app, the Run value and the NativeMessagingHosts values. `%LOCALAPPDATA%org.promptly.passwords` stays unless you tick the box to delete app data: check that it does what it says.

## Connect

- [ ] Enter your server's https address. Your default browser opens the approval page, and the code matches the app's.
- [ ] Approve. "Add this device" appears. Try both "Approve from another device" (compare the words) and the recovery kit.
- [ ] A private-CA server works if Windows trusts the CA.
- [ ] "Scan the QR on my kit" asks for the camera, and works or fails cleanly.

## Tray and start with Windows

- [ ] Closing the window leaves the app in the tray. Left-click brings it back. Starting the app again brings the first one back rather than opening a second.
- [ ] Tray menu: Open, Quick search, Lock (the window goes to the lock screen), Desktop settings, Quit. "Check for updates" is greyed out.
- [ ] Quit, with a secret on the clipboard: the clipboard is cleared.
- [ ] Desktop settings → Start with Windows. Sign out and back in: the app starts in the tray with no window. Untick it, and `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` no longer has "Promptly Passwords".
- [ ] Hidden in the tray for over 6 minutes, unlocked: it doesn't lock before your idle setting. (Measured by driver only: see the report.)
- [ ] Sleep the machine for over a minute and wake it: the vault is locked.

## Windows Hello

- [ ] Desktop settings → Windows Hello: type the master password, Turn on. **The Hello prompt appears in front of the app, not behind it.** Wrong PIN, then right.
- [ ] Lock. "Unlock with Windows Hello": prompt in front, the vault opens. Cancel the prompt: it stays locked with a message.
- [ ] Offline (stop the server, or unplug): Hello still unlocks from the local copy.
- [ ] Change the master password on another device, then try Hello: it fails with a message, and the master password still works. Turn Hello off and on to recover.
- [ ] Copy `%LOCALAPPDATA%\org.promptly.passwords\hello.bin` to another Windows account: it doesn't open there.
- [ ] Settings → the shared "Unlock with Windows Hello" tick box: with the Current master password field filled in, it turns on. (See the report on this box.)

## Quick search and auto-type

Use throwaway logins titled to match the target, for example an item titled `Notepad`.

- [ ] Ctrl+Shift+Space from another app: the overlay opens in front with focus in the box, centred on the active monitor, and shows "Typing goes to: <that window>".
- [ ] If another app holds Ctrl+Shift+Space, the app still starts and works.
- [ ] Type to find. Arrows move. Esc closes. Clicking elsewhere closes.
- [ ] Enter: the password is on the clipboard, and the overlay closes. Paste it. After 30 s it's gone.
- [ ] Copy something else within the 30 s: it's still there afterwards.
- [ ] Win+V: the secret isn't in clipboard history. With cloud clipboard on, it doesn't sync.
- [ ] Shift+Enter copies the username. Alt+Enter copies the 2FA code.
- [ ] Locked vault: the overlay says so, and Enter opens the app.
- [ ] Item with "ask for master password" set: Enter refuses, and the app comes forward.

Auto-type (Ctrl+Enter) into real apps:

- [ ] After typing a login that has a 2FA code, the code is on the clipboard, and clears after the set time.
- [ ] Ctrl+Alt+Enter on that login types only the code into the window that was in front, with no Enter.

- [ ] Notepad with an item titled `Notepad`: types username, Tab, password. No Enter. Keys come out right, including `@ # é 🔑`, on your keyboard layout.
- [ ] Still holding Ctrl when it starts: it waits for release, and doesn't fire shortcuts.
- [ ] An item whose title doesn't match: nothing's typed, and both titles are shown. Enter types anyway. Esc stops.
- [ ] A custom field named `Window title` on the item makes a window match.
- [ ] Alt+Tab away during a long password: typing stops at once.
- [ ] A real login window (PuTTY, an RDP client, a game launcher): works, or note which don't. Some read raw keys and ignore Unicode input.
- [ ] An app run as administrator: refused with a clear message. Nothing typed.
- [ ] Shortcut pressed over Promptly's own window: no target, so auto-type refuses.
- [ ] The Windows lock screen and UAC prompts can't be typed into. Check that it fails safely.

## Browser extension Hello

Needs the extension wired to `native.ts` first.

- [ ] Desktop settings → Browser extension: paste the id from `chrome://extensions` and Save. Firefox needs no id, but Save must be pressed once.
- [ ] In Chrome, Edge and Firefox: turn on Hello in the extension, lock, unlock with Hello. The prompt appears in front of the browser.
- [ ] Each browser's secret is separate. Disable in one, and the other still works.
- [ ] Remove in Desktop settings: the browser reports the host as not found, and the extension falls back to the master password.
- [ ] A different extension id, not on the list, gets refused.

## Backup

- [ ] Desktop settings → Backup: choose a folder, a password, tick the schedule. Leave it unlocked. A file appears within about a minute, then not again until due.
- [ ] Open the file on another device: Import → Promptly export, with that password.
- [ ] Keep = 2: older files go, and other files in that folder stay.
- [ ] An unwritable folder (a read-only or missing drive) shows an error in settings.

## SSH agent

- [ ] With Windows's OpenSSH Authentication Agent running: tick the box. It says another agent's running, and that service keeps working.
- [ ] With it stopped: tick. `ssh-add -L` lists your Ed25519 item while unlocked, and nothing while locked.
- [ ] `ssh somehost`: a box names `ssh.exe` and the key. No is the default button. No fails. Yes logs in. It asks every time.
- [ ] A passphrase-protected or RSA key isn't offered.

## A new device asking to join

- [ ] With the app unlocked and hidden in the tray, start joining from another device. Within about 20 s, hovering the tray icon names the device. It's easy to miss, so judge whether it's enough.
- [ ] With the window open: a notice appears at the bottom right, and the taskbar button flashes if the window isn't in front. Review goes to Devices. Not now hides it.
- [ ] Approve or refuse there: the tooltip goes back to normal within about 20 s.

## Odds and ends

- [ ] Import and export: "Export encrypted file" and the plain export save where WebView2's download UI says, and open.
- [ ] Attachments upload and download.
- [ ] External links on an item open in your browser. Nothing navigates the app's window away.
- [ ] High-DPI and a second monitor: the window and overlay look right.
- [ ] Dark mode follows Windows.
