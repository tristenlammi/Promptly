# Why the extension asks for each permission

For store review, and for anyone who wants to know. Nothing is collected or sent anywhere except the user's own Promptly server. There's no telemetry, and no remote code.

| Permission | Why |
|---|---|
| `storage` | `storage.session` holds the unlock secret in memory while unlocked, so the service worker can restart without asking again. Only trusted extension contexts can read it. Everything else is in IndexedDB in the extension's own origin. |
| `activeTab` | "Only when I click" mode: fills the current tab after a click on the toolbar button, with no standing site access. |
| `scripting` | Registers the content script when the person chooses all-site filling, and injects it on a click in "on click" mode. |
| `alarms` | Auto-lock timer, periodic sync, and keeping the decrypted index alive while unlocked. |
| `contextMenus` | "Fill" and "Generate a password here" on the right-click menu. |
| `idle` | Locks the vault when the machine locks or sleeps. |
| `webNavigation` | Lists a tab's frames, to compare each frame's real origin with the login before filling. |
| `clipboardWrite` | Copies a 2FA code after filling, and clears copied secrets. |
| `nativeMessaging` | Talks to the optional Promptly Passwords Windows app, for Windows Hello unlock. Does nothing without that app. |
| `sidePanel` (Chrome family) | Vault in the side panel. Firefox uses `sidebar_action`, which needs no permission. |

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
| `passkey-main.js` | The page's own world | No. It carries requests and shapes answers. It makes no trust decisions. |

## Web accessible resources

`menu.html` and `save.html`, with `use_dynamic_url` on the Chrome family so a page can't probe for the extension. Firefox's per-install UUID does the same job.
