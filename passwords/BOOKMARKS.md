# Bookmark sync

The owner asked for this during the build (2026-11-07): the extension keeps bookmarks the same across every browser it's in. It wasn't in the plan.

## How it works

- **Storage.** Each bookmark or folder is one encrypted item, kind `bookmark`, in the person's own vault. It's a system kind, so it doesn't show in the item list, search, Security check or exports. The server sees blobs like any other item.
- **Own vault only.** Items in a shared vault are ignored, or anyone with write access to one could plant bookmarks in your browsers.
- **Comparing states.** Each browser keeps a salted hash of what both sides looked like after the last run. A run compares browser, vault and that record, so a browser that was shut or locked catches up by running again. It doesn't depend on seeing every event. Code: `frontend/src/passwords/core/bookmarks.ts`, no browser or network in it. The browser's side is `passwords/extension/src/bookmarks.ts`.
- **When.** About 3 seconds after a change here, and every minute with the vault's sync, while the vault's unlocked. Locked, there are no keys, so it waits.
- **Conflicts.** A change on one side wins. If both changed the same title, address or parent, the vault's wins, so every browser ends up the same. A folder deleted on one side stays if something new was put in it on the other.
- **Order.** Each item has a fractional position, so moving one bookmark rewrites one item.

## What keeps it from eating your bookmarks

- The first run only adds. Turning it on, or off and on, starts a fresh merge with no deletions.
- A run that would empty one side, from two bookmarks up, changes nothing and asks, however few there are: a server reset or a wiped profile looks like this.
- A run that would delete more than 25 items, or 20% of the total if that's more, changes nothing and asks. "Keep them everywhere" starts the comparison again, which brings each side's bookmarks back to the other.
- Deleted items are soft deletes on the server, as with any item.
- "Save a copy of this browser's bookmarks" writes an ordinary bookmarks HTML file.
- Travel mode pauses it, since those items being off the device isn't a deletion.

## Where it shows

- **In the toolbar panel:** a Bookmarks section to browse and search, from the vault, so it's the same list in any browser with the vault unlocked, whether or not that browser syncs.
- **In the vault:** a Bookmarks screen on web, in the extension and in the Windows app, for finding and opening them. The on/off box is on the extension's copy of that screen, since only an extension can reach a browser's bookmarks. Edit bookmarks in the browser.

## What moves and what doesn't

- `http` and `https` bookmarks and folders move. `javascript:`, `file:` and browser pages stay in the browser they're in and are counted on screen. A `javascript:` bookmark from elsewhere would be code that runs on whatever page it's clicked on.
- Separators and managed (company policy) folders stay put. Firefox's special query bookmarks aren't web addresses, so they stay too.
- **Roots.** Bookmarks bar, Other bookmarks and Mobile map across browsers by what they are, not their ids. Firefox's Bookmarks menu appears in a folder called "Bookmarks menu" inside Other bookmarks on Chromium browsers.
- **Exact duplicates.** The same title and address in the same folder become one, as two browsers with the same bookmarks would otherwise double up. Two folders with the same name in the same folder merge for the same reason.
- **A browser signed in to its own sync** can have an account and a local copy of each root. Only the account copy is used. Using both this and a browser's own bookmark sync works in that exact duplicates meet up, but the settings screen advises against it.

## Limits

- Browsers only. Chrome on Android has no extensions, and Firefox for Android has no bookmarks API. The Android and Windows apps don't show bookmarks.
- Not in the Windows backup or the vault's export, since neither includes system items. Use "Save a copy" for a file.
- Favicons, tags and Firefox keywords don't sync.

## Permission

`bookmarks` is an optional permission, asked for when the box is ticked and given back when it's unticked. It reads as "Read and change your bookmarks" in the prompt.
