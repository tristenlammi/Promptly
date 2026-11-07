# Using Promptly Passwords

**This is a preview.** Try it with low-value accounts first, and keep your important passwords where they are until you've used it for a while.

## Getting started

Open Passwords from the Promptly launcher. You'll choose a **master password** and get a **recovery kit**, a PDF with your **Secret Key** on it.

- You need both to get in on a new device. Your server never has either.
- **If you lose both, your vault is gone.** Nobody can get it back, including whoever runs your server. Print the kit, or put it somewhere that isn't this vault.
- Use a few random words for the master password. You'll be typing it often.

## Adding your passwords

- **From a browser or another manager:** Import and export, in the sidebar. Your file is read on your device and never uploaded. Afterwards, delete the plain copy, and the passwords stored in the old place.
- **One at a time:** New, at the top. Or just sign in on a site with the extension on, and it offers to save.

## Filling on websites

Install the extension from your server's Install page, connect it to your server, and approve it. On a sign-in page:

- Click a field to see your logins for that site, or use the toolbar button.
- **The toolbar button is the safest way:** a page can't touch or cover it.
- If the extension gets a form wrong, open the toolbar button, then This page, then Show me which boxes to fill here. It remembers.
- If it warns that a site looks like another one you have a login for, believe it and look at the address.
- Cards and addresses always ask first.

Settings has more: filling only when you click the toolbar button, a short PIN for the browser, and offering codes from your Promptly Mail.

## Bookmarks

In the extension's toolbar panel, open Bookmarks and click "Turn on bookmark sync". Do this in each browser you use. Bookmarks are encrypted in your vault, so your server can't read them.

They sync about once a minute while your vault's unlocked, and catch up when you next unlock. The first sync only adds, so nothing in a browser is removed by turning this on. The same bookmark in the same folder of two browsers becomes one. If you delete a lot at once, sync stops and asks first.

Bookmarklets (`javascript:` addresses) and browser pages stay in the browser they're in. Bookmarks don't sync to the phone app, since Chrome on Android has no extensions. If you also use a browser's own bookmark sync, turn that off. [BOOKMARKS.md](BOOKMARKS.md) has the details.

## On your phone

In Promptly for Android, open P Passwords and connect. Settings walks you through turning on autofill and passkeys. Chrome needs one extra setting, and the app takes you to it.

## On Windows

Install the Windows app from the Install page. Windows warns you because the installer isn't signed yet. Press Ctrl+Shift+Space anywhere to search, then Enter to copy the password, or Ctrl+Enter to type it into the window you were in.

## 2FA codes

Add a code to a login by scanning its QR, pasting its setup key, or from a picture. Then the code fills or copies as you sign in. To move from Google Authenticator, export its transfer QR and use Import and export, From a QR image.

## Passkeys

The extension and the Android app can make and use passkeys for you, and they sync. You can always choose your browser's or a hardware key instead. In the browser, an unlocked vault and a click are all it takes, unless you've marked the item to ask for your master password.

A site decides when it asks for a passkey, and nothing can make it ask. When a page asks and the passkey's in your unlocked vault, our window opens, with your browser's and Windows Hello's option one click away. If the site asks quietly, or the vault's locked, the toolbar button shows **PK** once unlocked, and "Sign in with a passkey" is at the top of the panel, and in the menu on the page in Chromium browsers. If you have a passkey for a site that isn't asking, the panel says so: look on the page for "Use a passkey" or "Try another way".

## Sharing

**Shared vaults** are for logins you share with people on your Promptly, like streaming or the Wi-Fi.

- Compare **safety words** with someone, in person or by phone, the first time you share. That's what proves your server isn't sitting in between.
- If someone leaves or you remove them, change the key, and change the passwords they could read. They may have copied them, and no key change undoes that. You'll get the list.
- "Can fill only" is a convenience, not a lock. Someone determined can still get at a password their browser fills.

**Sends** are for one password or file to anyone, even someone with no account. Set how long it lasts and how often it opens. If you post the link through Rooms or Mail, the link passes through your server, so add a password and tell them that some other way.

**Emergency access** lets someone you trust ask for your vault if you can't reach it. You get a push and an email, and you can refuse. If you don't refuse before the wait runs out, it opens. Choose someone you'd trust with all of it.

## Staying safe

**How long it stays unlocked** is your choice, in the toolbar panel under More or in Settings: from 1 minute to 12 hours, when the browser closes, or never. Never means no password after a restart, and it also means anyone who can open that browser has your passwords and can sign in with your passkeys. It's reasonable on a computer only you use, with its disk encrypted and its own login. It stays unlocked until you press Lock, and removing the device from another one locks it the next time it's online.

**Security check** looks for weak, reused, old and breached passwords, all worked out on your device. For breaches, only the first few characters of a hash leave, through your server. It also tells you about emails from your sites saying a password changed, and walks you through changing passwords one at a time: a new one is saved first, you change it on the site, then you say whether it worked.

Keep an encrypted export now and then, from Import and export. That's the copy that survives if your server doesn't. The Windows app can make one on a schedule.

Every six months or so you'll be asked whether you still have your kit. Check, and mean it.

**Travel mode**, in Settings, takes chosen vaults off a device until you're back. It only helps if you don't turn it off for whoever's asking.

## If something goes wrong

- **Forgot your master password, still have the kit?** You can't change it without the password, because the kit alone doesn't open anything. Without it, your only way forward is below.
- **Lost both?** "I've lost my master password and my kit", on the lock screen. It destroys the vault so you can start again.
- **A new device won't unlock after you made a new Secret Key?** That's expected. Join it again.
- **"Someone's keys changed":** they may have reset their vault, or something may be wrong with the server. Check with them directly before going on.
- **A warning that the server showed an older state:** your device kept its newer copy. If your server was restored from a backup, that's why. If not, ask whoever runs it.
