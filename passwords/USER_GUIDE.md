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
- **On Firefox,** clicking a login in the menu on the page opens the toolbar panel with that login at the top. Click Fill there. It's one more click than on Chrome, because Firefox can't tell us whether a page is hiding or covering the menu. The same goes for saving: Save in the panel opens the panel, and you answer there. On Firefox older than 149, click the toolbar button yourself; the login is still at the top. If the panel ignores a click right as it opens, click again.
- Right-clicking a box and choosing Fill from Promptly Passwords, or Ctrl+Shift+L, fills this site's first login straight away, in any browser. Those are the browser's own menu and keys, which a page can't fake.
- If the extension gets a form wrong, open the toolbar button, then This page, then Show me which boxes to fill here. It remembers.
- If it warns that a site looks like another one you have a login for, believe it and look at the address. Nothing is offered there.
- Logins for different services on one domain stay apart. On zyx.example.org you get the zyx login, and the one for abc.example.org is under "Other logins for example.org" in the toolbar panel.
- A website saved with no port works on any port of that host, so `nas.home` covers `nas.home:5001`. Save it with a port, like `nas.home:5001`, to keep it to that port.
- To change how a login matches, edit it and pick **Match websites**. Auto suits nearly everything. Same domain offers it on every host of the domain. Exact host keeps it to one host. Exact host and port keeps it to one host and port. Starts with keeps it to addresses that start with the one saved. Never stops it being offered; you can still search for it. Each website can have its own setting too.
- Cards and addresses always ask first.

Settings has more: filling only when you click the toolbar button, a PIN of 6 to 12 digits for the browser (it stops working 8 hours after the vault locks), and offering codes from your Promptly Mail.

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

The extension and the Android app can make and use passkeys for you, and they sync. You can always choose your browser's or a hardware key instead.

Each time you sign in with a passkey or make one, Promptly asks for your **passkey PIN**, in its own window in the browser or its own sheet on Android. The box is ready to type in, and Enter (or Done) signs in. The first time, it asks you to choose one and type it twice: 4 to 12 digits, and not an easy one like 1234 or 1111. It's the same PIN on all your devices. You can change it in Settings, under Passkeys on the web and in the extension, and Passkey PIN on Android, with your master password or the PIN you have now. Five wrong PINs in a row lock your vault, and then you need your master password to unlock it. An item you've marked to ask for your master password still asks, after the PIN.

A site decides when it asks for a passkey, and nothing can make it ask. When a page asks and the passkey's in your unlocked vault, our window opens, with your browser's and Windows Hello's option one click away. If the site asks quietly, or the vault's locked, the toolbar button shows **PK** once unlocked, and "Sign in with a passkey" is at the top of the panel, and in the menu on the page in Chromium browsers. If you have a passkey for a site that hasn't asked yet, the panel says so. Press the site's own button, such as Continue, "Use a passkey" or "Try another way", and our window opens.

## Sharing

**Shared vaults** are for logins you share with people on your Promptly, like streaming or the Wi-Fi.

- Compare **safety words** with someone, in person or by phone, the first time you share. That's what proves your server isn't sitting in between.
- If someone leaves or you remove them, change the key, and change the passwords they could read. They may have copied them, and no key change undoes that. You'll get the list.
- "Can fill only" is a convenience, not a lock. Someone determined can still get at a password their browser fills.

**Sends** are for one password or file to anyone, even someone with no account. Set how long it lasts and how often it opens. If you post the link through Rooms or Mail, the link passes through your server, so add a password and tell them that some other way.

**Emergency access** lets someone you trust ask for your vault if you can't reach it. You get a push and an email, and you can refuse. If you don't refuse before the wait runs out, it opens. Choose someone you'd trust with all of it. It covers your own vault and vaults you made and haven't shared; once you remove someone, they stay removed on all your devices.

## Aliases on your own domain

An alias is a different email address for each login, like `shop.k7m2@yourdomain.com`. If a site leaks or sells it, you'll see who, and you can turn that one address off without changing the rest.

You need a domain you own (a subdomain like `mail.yourdomain.com` is fine, and keeps your main domain's mail as it is) and a mailbox connected in Promptly Mail.

**1. At your mail provider**, add the domain and turn on a **catch-all**, so mail to anything at that domain lands in your mailbox. The provider tells you which DNS records (MX, and usually SPF and DKIM) to add at whoever sells you the domain. Some common setups, in general terms:

- **Google Workspace**: add the domain to your Workspace, then set up a catch-all route to your user in the Admin console's Gmail routing settings. To reply from an alias, add the domain as a "send mail as" address in Gmail.
- **Microsoft 365**: there's no simple catch-all switch. It takes a mail flow rule in the Exchange admin centre. A subdomain at another provider can be easier.
- **Fastmail**: add the domain and turn on its catch-all. Add a sending identity for the domain (a wildcard one if offered) to reply from aliases.
- **Proton Mail, Zoho Mail, iCloud+ custom domains**: paid plans let you add a domain and turn on catch-all, or "allow all incoming". Sending from an alias usually needs each address added.
- **A forwarding service** (Cloudflare Email Routing and similar): a catch-all rule that forwards to your mailbox works. Replying from an alias then needs your mailbox provider to allow that domain as a sender.
- **Your own mail server**: a catch-all mapping for the domain to your user, and permission for that user to send as the domain.

**2. In Passwords → Aliases**, add the domain, pick the mailbox it lands in, and press **Run the check**. Promptly sends a test from that mailbox to a random address on the domain and waits for it. It also notes whether your provider kept the alias as the sender. The test goes to Trash by itself.

**3. Make an alias** with **New alias** under the username in a login, or in the browser extension's Generator while you're on a sign-up page, which also fills it in. Choose how aliases start in the domain's settings: a random word (the default), the site's name (easier to read, but it names the site to anyone who sees it), a word you type, or no word. You can choose the random part's length and the separator too.

**In Mail**, an email sent to an alias says which alias and links to its login. Each alias in Passwords → Aliases shows how many emails it's had and when the last came.

**A warning** appears when an alias gets mail from a sender that doesn't look like its site. That's often a sign it was sold or leaked, but it can be the site's newsletter service. Press **This sender is fine**, or turn the alias off.

**Turning an alias off** moves its new mail to Trash, or a folder you choose for the domain. Mail clients can't refuse mail, so the sender won't know, and your provider still gets it. Forgetting an alias doesn't stop its mail either.

**Replying** to mail that came to an alias sends from that alias, if your provider allows it. If it doesn't, Mail says so and replies from your mailbox's own address. Even from an alias, hidden headers can show your real address.

## Staying safe

**How long it stays unlocked** is your choice, in the toolbar panel under More or in Settings: from 1 minute to 12 hours, when the browser closes, or never. Never means no password after a restart, and it also means anyone who can open that browser has your passwords and can sign in with your passkeys. It's reasonable on a computer only you use, with its disk encrypted and its own login. It stays unlocked until you press Lock, and removing the device from another one locks it the next time it's online.

**Security check** looks for weak, reused, old and breached passwords, all worked out on your device. For breaches, only the first few characters of a hash leave, through your server. It also tells you about emails from your sites saying a password changed, and walks you through changing passwords one at a time: a new one is saved first, you change it on the site, then you say whether it worked.

**Accounts not in your vault**, also in Security check, lists sites your Promptly Mail says you have an account with: welcome and sign-up emails, "verify your email", password resets, sign-in alerts, receipts and subscriptions. Sites you already have a login for are left out. That comparison happens on your device, and your server never sees your vault. For each one:

- **Add login** opens a new login with the site and the address it wrote to already filled in.
- **Not an account** hides it for good, on all your devices. Use it for a shop you only bought from once as a guest, say.
- **Delete account** shows how: the site's deletion page if it's a known one, or its account settings, and a ready-made deletion request that opens in Mail as a draft for you to check and send. Nothing is sent for you. The row then says Deleting until you press It's gone.

It only reads mail you were sent, not your Trash, Spam, Drafts or Sent mail, and it skips forwards, replies and newsletters. New mail is picked up in the background every 20 minutes.

**Find stray passwords**, in Security check, looks through your own Mail, Files and Photos for passwords, Wi-Fi passwords, API keys, recovery codes and 2FA setup keys left in plain text, plus files like `passwords.txt`, `.env` or a leftover export. Your server does the looking, in your things only, and keeps just where it found something. For each one, "Save to vault" fills in a new item for you to check and save. Then you're asked whether to move the original to its Trash. "Ignore" hides one for good. It also checks new mail and files every hour, so the count stays up to date. A password that sat in plain text is worth changing too.

Keep an encrypted export now and then, from Import and export. That's the copy that survives if your server doesn't. The Windows app can make one on a schedule.

Every six months or so you'll be asked whether you still have your kit. Check, and mean it.

**Travel mode**, in Settings, takes chosen vaults off a device until you're back. It only helps if you don't turn it off for whoever's asking.

## If something goes wrong

- **Forgot your master password, still have the kit?** You can't change it without the password, because the kit alone doesn't open anything. Without it, your only way forward is below.
- **Lost both?** "I've lost my master password and my kit", on the lock screen. It destroys the vault so you can start again.
- **A new device won't unlock after you made a new Secret Key?** That's expected. Join it again.
- **"Someone's keys changed":** they may have reset their vault, or something may be wrong with the server. Check with them directly before going on.
- **A warning that the server showed an older state:** your device kept its newer copy. If your server was restored from a backup, that's why. If not, ask whoever runs it.
