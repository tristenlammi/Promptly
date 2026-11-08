# Browser sync: tabs, sent tabs, history and the reading list

Chrome syncs with Chrome and Firefox with Firefox. Promptly Passwords already kept bookmarks the same across all of them ([BOOKMARKS.md](BOOKMARKS.md)). This does the same for four more things, between any browsers with the extension, and the Android app for sent tabs. It was asked for by the owner on 2026-11-08, after bookmarks worked.

| | What it does | Default | Needs |
|---|---|---|---|
| Open tabs | Each browser shares its open tabs. The others show them, with search, "open here" and how fresh each list is. | Off, per browser | `tabs` |
| Send a tab | Send the page you're on to another browser or your phone. | Always there | Nothing new. A notification instead of opening needs `notifications` |
| History | A browser shares the pages it visits, so you can search them from the others. | Off, per browser | `history` |
| Reading list | Save for later, synced everywhere, read or unread. On Chromium it can match the browser's own reading list too. | Always there. Matching Chromium's list is off | `readingList` (Chromium, for matching only) |

Each is turned on or off in the extension's Settings, under "Sync with this browser". The vault's "Tabs and history" screen shows what's synced, on the web, in the extension and in the Windows app.

## How it's kept private

- **One key for all of it**, made on each device from the personal vault's key: `HKDF(personal vault key, salt = vault id, "promptly-pw/v1/browser-sync")`. Only someone who can open that vault can make it, which means only this person's own unlocked devices. CRYPTO_SPEC section 13 has the exact format.
- **Every record is bound to where it lives**: its kind, its device and its slot are in the AAD, so the server can't swap one browser's tabs for another's, move a sent tab to another device, or turn a history day into a reading list entry. Each is padded to a size bucket like vault items.
- **What the server sees**: who it belongs to, which of their devices a record is for, its padded size, the day a history bucket covers, and when each was written. Never a title or an address. SECURITY.md says what that metadata gives away.
- **Locked means nothing moves.** Without the vault's key nothing can be read or written, so a browser does all of this only while unlocked. A right-click "Save for later" or "Send" while locked waits, in memory only, for the next unlock.
- **No AI or chat tool reads any of it**, as for the vault.

## Open tabs

- A browser publishes a few seconds after its tabs change, at most 30 seconds after the first change, and on the minute's sync. A tab switch alone isn't a change: what's published only moves when an address, title or pin changes, or every 10 minutes. The listeners are only added while sharing is on.
- Left out: private windows, popup and app windows, and anything that isn't `http` or `https`: browser pages, extension pages, `file:`, `data:` and `javascript:`. Up to 500 tabs, most recently used first, titles cut at 512 characters and addresses over 4,096 left out. The list says how many more there were.
- Others show each device's tabs by window, with "updated 5 min ago", and "may be out of date" after a day. A browser that hasn't published for 30 days is dropped by the server, and so is a removed device.
- Turning it off removes that browser's list from every device at once.

## Sending a tab

- From the panel's Browse section ("Send this tab") or the right-click menu on a page or link ("Send to your device"; on Firefox, also on a tab). The list is your devices that can reach the vault: browsers with the extension and Promptly for Android.
- The receiving browser checks every minute while unlocked. The tab opens in the background, or with the notification box ticked, a notification says one arrived and from which device, and opens it when clicked. The notification never shows the page's title or address.
- Each sent tab is shown once: it's remembered before it's acknowledged, and the server deletes it once acknowledged. One nobody collects goes after 14 days. A device can have up to 100 waiting.
- **Android**: the app's 30-minute alerts poll counts what's waiting for this phone, with no vault session and no content, and says "A tab was sent to this phone". Unlocking Passwords opens each one in the default browser. So it can take up to half an hour to be told, and it needs an unlock to open, because a locked phone has no key.

## History

- **Off until turned on, in each browser.** From then on only: what was visited before isn't uploaded.
- Read from the browser's own history, which in both Chrome and Firefox never holds private windows. One row per address per day, at its latest visit, encrypted per day. A day over 512 KB keeps its latest visits.
- **Kept for 90 days** unless changed, between 1 and 365, on the Tabs and history screen. It's one setting for the account, and the server enforces it: a write for an older day is refused, the hourly sweep deletes what's older, and choosing fewer days deletes the rest at once.
- **Sites to leave out**: a list per browser. A site includes its subdomains. Adding one also takes it out of what that browser already synced.
- **Deleting**: "Delete this browser's synced history" in Settings, and "Delete all synced history" on the Tabs and history screen. Clearing a browser's own history clears what it synced, and removing single pages removes those, if it happens while the vault's unlocked. Turning it off stops copying, and what was synced stays until it's that old or deleted.
- Up to 64 MB of synced history per account.

## Reading list

- "Save for later" from the panel or the right-click menu, and from the Tabs and history screen you can open, mark read or unread, and remove. The same address saved twice is one entry, marked unread again.
- **Chromium**: with "Keep this browser's own reading list the same" ticked, the browser's reading list (Chrome 120 and later) matches ours both ways. It compares both with what they had in common last time, kept as salted hashes, so a removal on either side is told apart from something new. The first run only adds. A read mark goes whichever way changed last.
- **Firefox** has no reading list API for extensions, so there ours is the list.
- Up to 5,000 entries.

## Limits

- Browsers with the extension, and Android for receiving a sent tab. The Android app doesn't share its own tabs or history, and can't send. The Windows app and the web page show what's synced but don't share anything themselves, since they aren't browsers.
- Not in the vault's export or the Windows backup.
- Favicons aren't synced. Tab groups and window names aren't either.
- History from before it's turned on isn't uploaded. On a browser's first run it can catch up on visits since then that happened while locked.
- If the personal vault's key ever changed, records sealed under the old key stop opening and are left out with a count on screen. Open tabs are published again on the next change; history from before is lost. In practice that key doesn't change.

## Code

| Part | Where |
|---|---|
| Logic and encryption, no browser in it | `frontend/src/passwords/core/browsersync.ts`, tests in `browsersync.test.ts` |
| Server | `backend/app/passwords/browsersync.py`, `sync_models.py`, migration `0260_pw_browsersync`, tests in `backend/tests/test_passwords_browsersync.py` |
| Extension background | `passwords/extension/src/browsersync.ts` (settings, the minute's tick, messages), `tabsync.ts`, `history.ts`, `readinglist.ts` |
| Extension pages | `popup-sync.tsx` (the panel's Browse section), `syncsettings.tsx` (Settings) |
| Vault screen | `frontend/src/passwords/ui/BrowserSync.tsx` |
| Android | `core/BrowserSync.kt`, `VaultClient.takeSentTabs`, `SentTabs.kt`, the count in `Alerts.kt` |
| End-to-end | `e2e/passwords-ext/browsersync.spec.ts` (two Chrome profiles), `e2e/passwords-firefox/browsersync.test.mjs` |
