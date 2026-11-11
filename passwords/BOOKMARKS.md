# Bookmark sync

The owner asked for this during the build (2026-11-07): the extension keeps bookmarks the same across every browser it's in. It wasn't in the plan.

## How it works

- **Storage.** Each bookmark or folder is one encrypted item, kind `bookmark`, in the person's own vault. It's a system kind, so it doesn't show in the item list, search, Security check or exports. The server sees blobs like any other item.
- **Own vault only.** Items in a shared vault are ignored, or anyone with write access to one could plant bookmarks in your browsers.
- **Comparing states.** Each browser keeps a salted hash of what both sides looked like after the last run. A run compares browser, vault and that record, so a browser that was shut or locked catches up by running again. It doesn't depend on seeing every event. Code: `frontend/src/passwords/core/bookmarks.ts`, no browser or network in it. The browser's side is `passwords/extension/src/bookmarks.ts`.
- **When.** About 3 seconds after a change here, and every minute with the vault's sync, while the vault's unlocked. Locked, there are no keys, so it waits.
- **Conflicts.** A change on one side wins. If both changed the same title, address or parent, the vault's wins, so every browser ends up the same. A folder deleted on one side stays if something new was put in it on the other. A bookmark deleted on one device and only moved or reordered on another stays deleted (`resolveConflict` in `core/vault.ts`); renamed or given a new address, it's kept.
- **Deletions.** A deleted bookmark is a soft-deleted item, so it isn't in what a run reads from the vault. A browser that remembers the last run sees it gone and removes its own copy. If the browser refuses, the record of it is kept and the next run tries again, so the copy doesn't go back to the vault as a new bookmark. A browser that remembers nothing (first run, off and on, the extension reinstalled) is given the vault's recently deleted too: a bookmark here with the same folder, title and address as one of those, added here before that one was deleted, is removed rather than uploaded again. One added after the deletion is new. A browser that doesn't say when a bookmark was added keeps it.
- **Order.** Each item has a fractional position, so moving one bookmark rewrites one item.

## What keeps it from eating your bookmarks

- The first run only adds, with one exception: a bookmark that was deleted in another browser in the last 30 days, and is still here from before, goes from here too (see Deletions). Those count as deletions for the two rules below, and "Keep them everywhere" brings them back. Turning it on, or off and on, starts the same fresh merge.
- A run that would empty one side, from two bookmarks up, changes nothing and asks, however few there are: a server reset or a wiped profile looks like this.
- A run that would delete more than 25 items, or 20% of the total if that's more, changes nothing and asks. "Keep them everywhere" starts the comparison again, which brings each side's bookmarks back to the other.
- More than that within a day counts too, so a lot can't go a little at a time. "Yes, delete them" covers the number shown, and if it's grown it asks again.
- Deleted bookmarks stay for 30 days. "Recently deleted" on the Bookmarks screen restores them to every browser.
- "Save a copy of this browser's bookmarks" writes an ordinary bookmarks HTML file.
- Travel mode pauses it, since those items being off the device isn't a deletion.

## Where it shows

- **In the toolbar panel:** a Bookmarks section to browse and search, from the vault, so it's the same list in any browser with the vault unlocked, whether or not that browser syncs.
- **In the vault:** a Bookmarks screen on web, in the extension and in the Windows app, for finding and opening them. The on/off box is on the extension's copy of that screen, since only an extension can reach a browser's bookmarks. Edit bookmarks in the browser.

## What moves and what doesn't

- `http` and `https` bookmarks and folders move, up to 2,048 characters of title and 16 KB of address. Longer ones stay where they are. `javascript:`, `file:` and browser pages stay in the browser they're in and are counted on screen. A `javascript:` bookmark from elsewhere would be code that runs on whatever page it's clicked on.
- Separators and managed (company policy) folders stay put. Firefox's special query bookmarks aren't web addresses, so they stay too.
- **Roots.** Bookmarks bar and Other bookmarks map across browsers by what they are, not their ids. Chromium has no Bookmarks menu, and on a computer its Mobile folder can't be used unless it's signed in to its own sync. So Firefox's Bookmarks menu and Mobile bookmarks appear as folders of those names inside Other bookmarks on Chromium browsers, and go back to the real ones in Firefox.
- **Exact duplicates.** The same title and address in the same folder become one, as two browsers with the same bookmarks would otherwise double up. Two folders with the same name in the same folder merge for the same reason.
- **A browser signed in to its own sync** can have an account and a local copy of each root. Only the account copy is used. Using both this and a browser's own bookmark sync works in that exact duplicates meet up, but the settings screen advises against it.

## Limits

- Browsers only. Chrome on Android has no extensions, and Firefox for Android has no bookmarks API. The Android and Windows apps don't show bookmarks.
- Not in the Windows backup or the vault's export, since neither includes system items. Use "Save a copy" for a file.
- Favicons, tags and Firefox keywords don't sync.

## Permission

`bookmarks` is an optional permission, asked for when the box is ticked and given back when it's unticked. It reads as "Read and change your bookmarks" in the prompt.

## Tabs, history and the reading list

Open tabs, sending a tab, history and the reading list sync the same way, between browsers from different makers. [SYNC.md](SYNC.md) has them.
