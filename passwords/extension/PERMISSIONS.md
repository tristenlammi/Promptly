# Why the extension asks for each permission

For store review, and for anyone who wants to know. Nothing is collected or sent anywhere except the user's own Promptly server. There's no telemetry, and no remote code.

| Permission | Why |
|---|---|
| `storage` | `storage.session` holds the unlock secret in memory while unlocked, so the service worker can restart without asking again. Only trusted extension contexts can read it. Everything else is in IndexedDB in the extension's own origin. |
| `activeTab` | "Only when I click" mode: fills the current tab after a click on the toolbar button, with no standing site access. |
| `scripting` | Registers the content script when the person chooses all-site filling, and injects it on a click in "on click" mode. |
| `alarms` | Auto-lock timer, periodic sync, clearing a copied secret when it's due, and keeping the decrypted index alive while unlocked. |
| `contextMenus` | "Fill" and "Generate a password here" on the right-click menu. |
| `idle` | Locks the vault when the machine locks or sleeps. |
| `webNavigation` | Lists a tab's frames, to compare each frame's real origin with the login before filling. Notices when a single-page site changes route, so the page's forms get looked at again. |
| `clipboardWrite` | Copies a 2FA code once a sign-in has moved on, and clears copied secrets. |
| `offscreen` (Chrome family) | A Chromium service worker has no document, so it can't touch the clipboard. A page with reason `CLIPBOARD` exists for a moment to write or clear it, and is closed straight after. Firefox's background page does this itself. |
| `nativeMessaging` | Talks to the optional Promptly Passwords Windows app, for Windows Hello unlock. Does nothing without that app. |
| `sidePanel` (Chrome family) | Vault in the side panel. Firefox uses `sidebar_action`, which needs no permission. |

## Optional permissions

`clipboardRead`. Not granted at install, and only asked for if the person ticks "Don't clear the clipboard if I've copied something else since" in Settings. It lets the extension compare what's on the clipboard with a salted hash of what it copied, when a clear is due. Nothing read is kept or sent. Without it, a clear goes ahead whatever's on the clipboard, because there's no way to tell.

## Host permissions

`optional_host_permissions: ["https://*/*", "http://*/*"]`. None are granted at install.

- **The server's origin:** asked for when the person types their server's address. Self-hosted, so it can't be known at build time.
- **All sites:** asked for after a plain explanation on first run, because filling needs to read sign-in forms. The person can pick "Only when I click" instead, which uses `activeTab` and no host permission. It's a first-class setting.

## What runs where

| Part | World | Sees secrets? |
|---|---|---|
| `background.js` | Extension | Yes, while unlocked. |
| `popup.html`, `vault.html`, `passkey.html` | Extension pages | Yes, only for what they show. |
| `menu.html`, `save.html` | Extension frames in a page, which the page can't read | No: titles and usernames for this tab. |
| `content.js` | Isolated world in pages | Only values being filled, at fill time. Never stored. |
| `passkey-main.js` | The page's own world | No. It carries requests and shapes answers. It makes no trust decisions. Not installed in "on click" mode. |
| `offscreen.html` (Chrome family) | Extension page, for a moment | Only what's being copied. |

The content script reads what the page's own requests came back with from the page's Resource Timing entries. It patches nothing in the page, and asks for no `webRequest` permission. It only looks after a person has typed in a password box.

## Remote code and rules

No remote code, ever. The rules pack (`rules/pack.json`) ships inside the extension and changes only with an extension release. It's data: hosts and CSS selectors, checked against a signature and a public key pinned in the code. Nothing in it can run, and anything but the known fields gets the whole pack refused.

## Web accessible resources

`menu.html` and `save.html`, with `use_dynamic_url` on the Chrome family so a page can't probe for the extension. Firefox's per-install UUID does the same job.
