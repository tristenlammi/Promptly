# Changelog

All notable changes to Promptly are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How this works

- Work locally against the **[Unreleased]** section — add a line under the
  relevant heading (`Added` / `Changed` / `Fixed` / `Removed`) as you go.
- When a patch is tested and ready, cut a version: run
  `scripts/release.ps1 <version>` (Windows) or `scripts/release.sh <version>`
  (Linux/macOS). That bumps `VERSION` + `frontend/package.json`, stamps today's
  date onto a new release heading, and empties `[Unreleased]` again.
- Then rebuild, do a final local test, and commit/push as that version
  (optionally `git tag v<version>`).

The in-app version tag (bottom of the sidebar) reads the injected
`frontend/package.json` version, so it always reflects the built release.

## [Unreleased]

### Added
<!-- New-member onboarding (onboard-fixes) -->
- Admin → Users: after you create an account, a "Send them this" card shows the address, username and password with the steps to sign in, ready to copy, share, or email to them when email is set up.

### Changed
<!-- New-member onboarding (onboard-fixes) -->
- First sign-in for someone new now opens on Today with a short welcome: what Promptly is, how to put it on this phone, and a button to message the person who set it up (and Porch). It replaces the "Pick your apps" question.
- Install apps starts with one recommended step for the device you're on (iPhone, Android or computer); the separate per-app installs, Android Auto and the passwords extension are under "More".
- Today shows a small "Install Promptly on this device" link when you're using Promptly in a browser, and iPhone users get an "Add to Home Screen" link in the sidebar.
- On an iPhone in Safari, Rooms, Porch and Account → Notifications now explain how to get message alerts (add Promptly to the Home Screen) instead of hiding the option.
- Plainer words for new people: the sign-in page says "Your family's private space" and to ask the person who set up Promptly for an account; "Usage & cost" is now "AI usage"; the chat model button shows just the model's name; new chats suggest everyday things to ask; and the Apps page has a few words under each app.
- Starting a new message in Rooms now lists the people on your Promptly straight away, instead of an empty search.
- Admin → Users: the create form checks the password against the same rules as the server and shows them, and the role choices are described in plain words.

### Fixed
<!-- New-member onboarding (onboard-fixes) -->
- Choosing a password: a live checklist shows the rules (length, a number, a symbol), and errors read as plain sentences instead of "new_password: Value error, …".
- After changing your password, an old error message no longer stays on screen, and you see that it worked.
- Files: the "System" row at the bottom of a folder no longer cuts off the list's rounded corners.
### Removed
- Running code is gone: the AI can no longer run Python in chat, code blocks no longer have a Run button, and the code sandbox container is no longer installed (./update.sh removes it). HTML, React and SVG previews of code blocks still work, and old chats still show their past runs. The "Code execution" setting on users is gone with it.

### Security
<!-- Security review fixes (sec-fixes) -->
- A placeholder TUS_HOOK_SECRET (copied from .env.example) now stops Promptly starting on a public address, like a placeholder SECRET_KEY does. ./update.sh fills it in before it restarts anything.
- After a SECRET_KEY change, mail account passwords, saved secrets, the breach-check key and the traffic key are also moved onto the new key at start-up (with SECRET_KEY_PREVIOUS set), not only MFA, provider and connector secrets.
- Password-reset emails, single sign-on and feedback emails no longer take this server's address from the request. A forged Host header could make a real reset email link to someone else's site. Links now always use the public address set in Admin, or the one you're using when it's one of those.
- Workspace search results in the Ctrl+K palette show their highlighted snippet as text, so words in a shared note can't turn into page markup.
- Updated python-jose to 3.4.0 and cryptography to 44.0.1 for their security fixes.
- After a chat has read something from outside (a web page, an email, a shared file), Promptly asks before it opens a website you didn't give it or its search didn't find ("Promptly wants to open example.com"). A page could otherwise tell the AI to send your information somewhere in a web address. Sub-agents and automations refuse instead of asking.
- The Office converter can no longer call Promptly's own server directly over the internal network it shares with it, and big-upload hooks need their secret (no more "it came from inside, so it's fine").
- Fetching a web page (the AI's page reader, remote images in Mail, automations, link previews) connects to the exact address that was checked, so a site can't switch its DNS to an address inside your network between the check and the request.
- nginx ignores the visitor address in CF-Connecting-IP when it arrives through Docker's gateway, so a device on your network can't pretend to be someone else to the rate limits. cloudflared should run as a container on Promptly's network (README, "Cloudflare Tunnel").
- New optional NGINX_BIND in .env picks which address ports 8087/8488 open on (usually the server's LAN address). By default they now open on IPv4 only. The README has a new "Exposure" section: what should be reachable, and how to check from outside on IPv4 and IPv6.
- The server, its workers, the upload service and the Office converter run with almost all Linux privileges removed and can't gain new ones.
- Signing out now ends that session's access straight away, instead of up to 15 minutes later.
- Once a public address is set, pages on this machine's localhost are no longer allowed to make signed-in requests to Promptly (unless DEBUG is on).
- Calls on Linux: LiveKit's ports 7880 and 6789 are documented as firewall-only (they can't be limited to localhost because nginx and the backend reach them over Docker's bridge).
<!-- UI polish, shared foundations (ui-polish) -->
- Dialogs, sheets and menus now open and close with a short, soft movement instead of snapping in and out (off when your device asks for reduced motion).
- Icon buttons in the Item Store apps show a quick themed tooltip on hover or keyboard focus, in place of the slow browser one.
- Shared building blocks for the apps to move onto: one menu (arrow keys, type to jump, Esc), one popover, one "name it" dialog in place of the browser prompt, one app header, and loading placeholders shaped like lists, cards, tiles, messages and people.

### Changed
- Porch: on a computer a post's ⋯ menu drops down from the button instead of opening a sheet in the middle of the screen. Double-tap to like answers a little faster.
- Photos: in search, Faces, Places and memories, where photos can't be picked, tiles no longer show a tick that did nothing. While you're picking photos, the set-up banner and memories fade back out of the way.
- Messages at the bottom of the screen start beside the app's own side list in Porch, Rooms, Calendar and Notes, instead of sitting on top of it.
- Mail with no mailbox connected keeps the Promptly sidebar open: there's no mail list yet for it to make room for.
- Files: the uploads panel moves up out of the way while the selection bar is showing, so neither covers the other.
- More lists show an outline while they load in place of the word "Loading…": Photos pages, the family library, Archive, Trash, a task, an import, sharing dialogs, workspace members and several Settings and Admin panels.
- Apps from the Apps page (Contacts, Tasks & Reminders and the rest) keep their own colour for the icon in the header only. Buttons, tabs and selection are Promptly's terracotta, the same as everywhere else.
- An app whose name is also its title no longer says the name twice under the header; it says Saved.
- Opening an app shows the outline of a list while it loads, not a spinner.
- Photos: the People tab is called Faces.
- Notes, Calendar and Maps fold the main sidebar down to its icons, like Mail and Files do, so their own side list has room.
- Calendar: the quick add box has a pen, not the assistant's sparkle. It doesn't use the assistant.
- Files: with things selected, the list can be scrolled clear of the bar at the bottom.
<!-- UI polish, shared foundations (ui-polish) -->
- Messages such as "Saved" and "Undo" now appear at the bottom of the screen (bottom-left on a computer, bottom-centre on a phone, above the tab bar) so they no longer cover the top of the page.
- The Ask panel in Item Store apps starts closed, and each app remembers on its own whether you left it open.
- Automations now live at /automations. Old /tasks links and bookmarks still work.
- Bottom sheets close on Esc, keep keyboard focus inside while open, and can be dragged down to close.
- Empty lists and pages share one look across the Item Store apps and the rest of Promptly.
- A confirmation asked from inside a sheet now appears in front of it.
<!-- Sidebar "happening now" dock (ui-dock) -->
- A "happening now" spot in the sidebar, just above your account: small live cards for the voice channel or call you're in (who's speaking, how long, Mute and Leave), uploads ("Uploading 12 of 40"), the next event or reminder in the next couple of hours (with a tick for the reminder), a mailbox that needs attention or a message that didn't send, location sharing in Maps (with Stop), someone on their way to you, a recording being written up, and how far understanding your photos has got. Three cards show at most and the rest fold into "+N more"; tapping a card takes you back to where it's happening. On the folded sidebar they are icons that open the cards; on a phone they are in the menu, and the menu button carries a dot while something is happening.
- The sidebar shows which app you're in: Photos, Rooms, Porch, Maps, Notes, Mail, Calendar or any other app now appears as the highlighted row under Apps while it's open, even when it isn't pinned.
- In apps with their own side list (Rooms, Porch, Mail and Files) the main sidebar folds to its icons by itself, and comes back when you leave. Open it there once and it stays open in those apps on that device.
- The voice panel in the sidebar is now a card in the "happening now" spot. Deafen, camera, sharing your screen and voice settings are in the channel itself, one tap away.
- On a computer, uploads away from Files and Photos show in the sidebar instead of as a floating pill.
- The sidebar's Automations link goes to /automations.
<!-- Files UI (ui-files) -->
- Files: Recent, Starred, Trash, Shared links, Home and Devices show placeholder rows while they load, like My files does, instead of the word "Loading".
- Files: the search box says "Search Files" (it used to say "Search Drive"), and Trash says things there "still take up space" instead of talking about quota.
- Files: an empty folder shows one clean panel with "Upload" and "New" (the list of things to make opens from New), without a table heading and a lone "System" row underneath; a fresh My files tucks its built-in folders behind "Show built-in folders".
- Files: moving things to the trash no longer asks "are you sure" first. It just goes, with Undo on the message; only "Delete forever" still asks.
- Files: when a folder can't be opened you get a plain message with "Try again" instead of "Failed to load files", and a failed "Save a copy" shows a normal message instead of a browser pop-up.
- Files: starring is instant. The star fills the moment you tap it (and comes back off with a message if it couldn't be saved), and starring several things at once says how many.
- Files: "Move to…" on Recent opens the move dialog (it used to just open the folder; that is now "Show in folder"), and trashing several starred things offers Undo.
- - Files: pictures in the preview zoom with the wheel, a pinch or a double-click, drag to look around, and swipe across for the next file.
- - Files: the selection bar now floats at the bottom and slides in, so the list no longer jumps; on a phone it names its three main actions and keeps the rest under More.
- - Files: the left list is grouped into Browse, Shared and Tools, and storage is one slim line that opens to show what is using the space and the last backup.
- - Files: "Details" is in every item's menu; on a phone or tablet it opens as a sheet from the bottom.
- Photos: on a phone, a handle on the right edge of the timeline to drag through the months, with the month shown beside it.
- Photos: Undo after moving photos to the trash or archiving them, in the timeline, in an album and in the viewer.
- Photos: drop photos or videos anywhere in Photos to upload them; dropped on an open album, they go into that album.
- Photos: tick a whole day from its date heading.
- Photos viewer: a "More" button on phones with Send, Download, Download edited and Archive; the F, A and Delete keys favourite, archive and trash; every button says what it does when you hover.
- Photos viewer: the photo follows your finger as you swipe and the next one slides in; it opens growing from its tile and follows a swipe down to close.
- Photos: the selection bar floats over the grid, so the photos no longer jump when you start picking; its buttons are bigger.
- Photos: the menu keeps Photos, Albums, People and Places in the row; Favourites, Archive, Family and Clean up are under "More".
- Photos: the heart flips straight away, with a small pop, in the grid and the viewer.
- Photos: grey placeholder tiles and album cards while things load, in place of "Loading…".
- Photos: New album, Save as a smart album and closing the editor with changes ask in the app's own dialogs, not the browser's.
- Photos: photos added from an album page upload through the upload list, so they show progress and can be retried.
- Photos: the tick on a tile is easier to hit, and the empty Photos page is shorter, with a "Set up phone backup" button.
<!-- UI pass: Rooms (ui-rooms) -->
- Rooms: what you were typing in a room is kept if you reload or come back later, on that device.
- Rooms: the emoji picker has a search box and a row of the ones you used lately.
- Rooms: see who reacted to a message, from the button beside its reactions or by pressing and holding one.
- Rooms: on a phone, tap a message to see when it was sent.
- Voice: the voice card shows how long you've been in.
<!-- UI pass: Rooms (ui-rooms) -->
- Rooms: the reply, react and more buttons now sit on the message they belong to, instead of at the far edge of the screen.
- Rooms: conversations sit in a centred column on wide screens, with the message box lined up underneath.
- Rooms: deleting a message happens at once, with Undo for ten seconds, instead of asking first.
- Rooms: leaving or deleting a space or room, removing someone and clearing call history now ask in Promptly's own style instead of a browser pop-up. Deleting a space asks you to type its name.
- Rooms: Enter finishes the create and rename forms.
- Rooms: buttons, selection and your own messages use Promptly's terracotta; indigo stays as the Rooms mark.
- Rooms: spaces, rooms and messages show placeholder rows while they load, instead of a spinner.
- Rooms: new messages, the jump-to-latest button and the side panel ease in, the typing line has moving dots, and reactions are bigger and pop when added.
- Rooms: Block and Unblock moved from the top of a one-to-one conversation into its More menu.
- Rooms: a brand-new Rooms shows one "Create a space" button, and "It's just you here" is a card with an Add people button.
- Voice: the voice card says "Good connection", "Okay connection" or "Weak connection" (tap for the details), has bigger buttons on touch screens, says "Leave" instead of "Disconnect", and slides in and out.
<!-- Porch UI pass (ui-porch) -->
- Porch: tap a photo to see it full screen. Pinch or double-tap to zoom, swipe sideways for the next one, swipe down to close, and Save keeps a copy. Double-tapping a photo in the feed still likes it.
- Porch: pull the feed down on a phone to check for new posts, and the "new posts" pill now slides in.
- Porch: Undo after deleting your own post or comment. It goes at once with no "are you sure", and you have ten seconds to bring it back.
- Rooms and Porch: a deleted message or post now disappears for everyone straight away, and Undo brings it back exactly as it was (reactions, pin, files and comments included). Before, other people kept seeing it until Undo ran out, and closing the app in those ten seconds could leave it there.
- Porch on a phone: Search, Saved and Settings buttons at the top of your own profile, and a marker on the bottom bar showing which tab you're on.
<!-- Porch UI pass (ui-porch) -->
- Porch: posting takes you straight back to the feed. A small chip shows "Posting… 60%", then "Posted" with View. If it doesn't go, the chip says why, offers Try again, and the post is kept as a draft.
- Porch: a new post starts with the words, with "Add photos or videos" as the first button, so a short post is one step.
- Porch: your comment shows the moment you send it. If it can't be sent it goes back in the box.
- Porch: liking gives a small pop, and on a phone the number of comments sits beside the comment button.
- Porch: a post's "…" menu is set out as Share, Manage and Safety.
- Porch: the welcome is now the top of your feed the first time you open it, with nothing to close.
- Porch: lists show grey placeholders while they load, not the word "Loading…".
- Porch: on a computer the right-hand column only shows when there's an invite or a group to join; otherwise the feed sits in the middle.
- Porch: unread badges match the rest of Promptly, the smallest text is bigger, and the small buttons (photo arrows, comment heart and "…", reactions) are easier to hit.
<!-- Maps UI pass (ui-maps) -->
- Maps on a phone: the panel at the bottom now drags between three heights (just the handle, half the screen, nearly full) by its handle, so the map is never stuck behind it.
- Maps: Undo after removing a saved place, a recent place, your parked car or a usual route, and after you stop sharing your location. A delete that fails now says so and puts the row back.
- Maps search: your recent places show as soon as you tap the search box, the arrow keys and Enter pick a result, Esc closes the list, and "nothing found" suggests what to try.
- Maps routes: each route shows when you would arrive, the quickest one is tagged "Fastest", a Swap button reverses the trip, and each step has a turn icon.
- Maps place card: a Share button, how far the place is from you, and "Copy coordinates" in place of the raw numbers.
- Maps: "Send to my phone" on a computer or iPhone shows a code to scan (or a link to copy) that opens the trip in Promptly on your Android phone.
- Maps on a computer: zoom buttons, and a compass button that turns the map back to north when it has been rotated.
- Places: "Open in Maps" on each place that is on the map.
<!-- Maps UI pass (ui-maps) -->
- Maps: the locate button shows when the map is following you and when location is blocked; charging stations and traffic are now under one Layers button.
- Maps: placeholder rows while a route, a timeline day or your offline areas load; the Home, Place and Route panels slide between each other.
- Maps: bigger tap targets on phones, terracotta for selected buttons, and switches and pill choices in place of tick boxes and drop-downs (avoid tolls, timeline, live location, offline areas).
- Maps: when Maps is not set up, people who are not admins are told to ask their admin instead of seeing setup steps.
- Places: a proper empty state, with a way back to all places when a filter or map spot has nothing.
<!-- Notes look and feel (ui-notes) -->
- Notes: "Delete forever" now asks first, on a note in the Trash, on several selected notes and inside an open note.
- Notes on a phone: swipe a card sideways to archive it (or bring it back from the Archive), and press and hold a card for everything you can do with it: colour, select, pin, remind, share, labels, archive, delete. Press and hold used to select the note; Select is now the first choice in that list.
- Notes on a phone: with notes selected, the actions sit along the bottom with their names (Pin, Colour, Labels, Archive, Delete).
- Notes: a note opens by growing out of its card and closes back into it, cards glide to their new places when you add, pin, archive or move one, and "Take a note…" opens smoothly. Menus, sheets and the phone's side menu ease in. All of it stays still if your device asks for less motion.
- Notes: while your notes load you see the shape of the cards instead of a spinner, and the columns no longer jump on first paint.
- Notes: with only a few notes the cards sit centred under "Take a note…", and in dark mode a plain card is a touch lighter than the page with an edge you can see.
- Notes: "Edit labels" opens in place: rename a label, change its colour or delete it without leaving Notes. Labels are shared with your other apps, so the change shows everywhere.
- Notes: bigger buttons on cards and bigger colour swatches, easier to hit with a finger.
- Calendar: buttons, selection and today markers use Promptly's terracotta; blue stays on the app icon and on calendar colours.
- Calendar: times read "9 am" or "09:00" following your clock setting, never a bare "09".
- Calendar: the phone header is the month, Today and a view switch (search and earlier/later are in the view menu).
- Calendar: the phone's week view shows three days instead of seven squeezed columns.
- Calendar: stepping forward or back slides the view, and switching view fades it in.
- Calendar: the quick-add button is labelled "Quick add" instead of a sparkle icon.
- Calendar: the smallest text is now 12px.
- Mail: write more than one email at a time. Messages sit in a dock at the bottom of the screen; minimise one to read something else and it keeps everything you wrote. Esc tucks a message away (or closes it when it is empty).
- Mail: drag files onto a message, or paste them, to attach. Attachments show their size, and pictures show a small preview.
- Mail: in a conversation, Reply and Forward sit under every message, a Reply / Reply all / Forward row follows the last one, earlier messages in a long conversation fold away, and tapping a time shows the full date.
- Mail: filter search results by Unread, Has attachment, who it is from, and how recent (filters apply to the results already loaded).
- Mail: new keys: r reply, a reply all, f forward, s star, u mark unread, and ? for the list of shortcuts. j and k keep the highlighted email in view.
- Mail: a Select button on phones for picking several emails at once.
- Mail: starring, marking read or unread, and "No reply needed" now show straight away, and go back if the change does not save.
- Mail: Undo for archive, delete, move and send is now a normal toast with an Undo button (still five seconds).
- Mail: older email loads by itself as you scroll down.
- Mail: the list shows placeholder rows while your mail loads, instead of a spinner.
- Mail: every sheet (snooze, labels, mailboxes, add to calendar, settings) is now the same sheet the rest of Promptly uses, with Esc to close.
- Mail: adding a mailbox asks for just your email and password; server details are under "Advanced", and a failed sign-in suggests what to check.
- Mail: adding a link while writing uses a small box in the toolbar, not a browser pop-up.
- Mail: colours come from the shared theme, small text is at least 12px, and buttons are bigger on phones.
<!-- Contacts UI pass (ui-contacts) -->
- Contacts: a "More" menu next to the search box with Import, Export, Find duplicates and Reminders & display, so they are one tap from the list instead of under Groups.
- Contacts: select several people at once (More → Select contacts, Ctrl or Shift-click, or press and hold on a phone) to add them to a group, export them or delete them, with Undo on the delete.
- Contacts: Call, Email and Favourite buttons appear on a row when you point at it, and "Clear filters" shows when nothing matches.
- Person page: Call, Text, Email and Directions tiles for people who aren't on Promptly, and their address opens in Maps.
- Photos faces: "Turn on face recognition" with a button when it's off, instead of a line pointing at settings.
<!-- Contacts UI pass (ui-contacts) -->
- Contacts: buttons and selection are terracotta like the rest of Promptly; the blue stays for the app's own mark.
- The three screens that were all called "People" now have their own names: Contacts (the address book), Faces (in Photos) and the person page, with the same back and More buttons at the top of each.
- Photos faces: saying two people are the same now shows both faces and asks first, and offers Undo straight after for named people.
- Person page: Block and Unblock moved into the More menu at the top, and unblocking asks first.
- Contacts: the delete buttons on notes and history are faintly visible instead of hidden until you point at them.
- Contacts, Faces and the person page show the page's shape while loading instead of "Loading…".
- Tasks: swipe a task right on a phone to tick it off, or left to move it to tomorrow, next week or a day you pick. On a computer the same choices sit on a button that shows when you point at a task.
- Tasks: drag a task onto another day in Upcoming to move it there (with a mouse), with Undo.
- Tasks: steps inside a task can be renamed where they sit, dragged into order, and brought back with Undo after removing one.
- Tasks: tap a task in the Completed list to put it back on your list.
- Tasks: keyboard keys. Up and Down move between tasks, Enter or E opens one, T moves it to today, Q starts a new one.
- Tasks: ticking a task now draws the tick, strikes the title through and folds the row away before it moves to Done. Tap the circle again while it plays to call it off; Undo still works after.
- Tasks: "Move all to today" says how many tasks it moved and offers Undo.
- Tasks: deleting a list asks in the app's own dialog (not the browser's), and can be undone, putting its tasks back.
- Tasks: the list editor has a grid of icons to pick from instead of a text box, and colours have names.
- Tasks: buttons, selection and the tick use the suite's terracotta; red is kept for the app's mark and the high-priority flag.
- Tasks: new tasks ease into place, and a task being reordered follows your pointer.
- Tasks: Settings explains typing tasks with plain examples first, and shows priority as !, !! and !!!.
- Tasks: bigger tap targets on phones for the day "+", send, new list and the reorder grip.

### Fixed
- Photos: a photo or video you upload shows in the grid straight away, without a reload.
- Files: the folder list at the side drops a folder as soon as you move it to trash, and brings it back on Undo or restore.
- Photos: the viewer no longer shows a Next arrow on the last photo once it knows there are no more.
- Contacts: a new contact with nothing typed yet shows "?" on its picture, not "NN".
<!-- Maps UI pass (ui-maps) -->
- Maps: stopping live location sharing, pausing the timeline, changing how long history is kept and deleting a timeline day now say so when they fail instead of failing silently.
<!-- Notes (ui-notes) -->
- Notes: Close in the "Take a note…" box works on the first click. The formatting buttons keep their place under the text (quieter until you're typing) instead of appearing and pushing Close down.
- Notes: pressing Enter in a note's title starts a new line under the text that's already there, instead of putting what you type next in front of it.
- Calendar: click or drag on the week and day grid to draw a new event, with a small bubble beside it for the title, time and calendar ("More options" opens the full editor).
- Calendar: "+3 more" on a month day opens that day's list in place.
- Calendar: resize an event from its top edge, and stretch all-day and month events across days from either end.
- Calendar: Undo after moving a repeating event.
- Calendar: the editor asks before closing with unsaved changes.
- Calendar: placeholder blocks while Calendar and its events load.
- Calendar: on a phone, swipe left or right to change the period.
- Calendar: more keys (n and p for next and previous, e to edit and Delete to delete the open event, ? for the list).
- Calendar: Promptly's own date and time pickers in the event editor on a computer (a phone keeps its built-in ones).
- Tasks: the Completed list shows each task's time in your own time format and under the right local day.
- Admin → Users: a Storage column for everyone at once, with a small bar, the percentage, and used / limit (or "no limit"). You can also sort by most storage. It shows totals only, never what the files are.

### Fixed
- Porch: "Text post" is now a button at the top of the new-post screen. It was a link underneath all your photos, where it was easy to never find.
- Passwords extension: bookmark sync no longer says "synced" when your server couldn't be reached. It says the other browsers don't have the latest yet, and keeps trying.
- Passwords bookmark sync: a bookmark deleted in one browser now stays deleted. A browser with no record of its last sync (first sync, sync turned off and on, or the extension reinstalled) used to send its own copy back as a new bookmark, so it stayed there and came back everywhere; it now removes a copy that matches one in Recently deleted and was there before the deletion. A removal the browser refuses is tried again instead of being re-uploaded, and a deleted bookmark is no longer brought back because another device reordered it at the same time. "Keep them everywhere" still brings everything back.
- Solid accent buttons with white text now meet WCAG AA in light and dark: the fill is the deeper terracotta (white on it is 4.95:1, was 3.1:1) and hover darkens (6.0:1) instead of fading. Accent text, borders, tints, switches and progress bars are unchanged, and the e2e accessibility checks no longer skip accent buttons.

## [0.35.0] - 2026-11-09

### Added
<!-- Porch phases 2–3 (porch-p2) -->
- Porch stories: photo, video and text stories that disappear after a day, posted to your groups the way posts are and seen only by the people in those groups. Only you see who has viewed yours. Videos can be up to a minute. A story can carry words, an @mention and a place; the person mentioned gets a notification, and nothing else about a story sends one. Stories are never searched, they are in Export my library, and a story can be reported to its group's admins like a post.
- Porch stories on screen: a row of stories under the group chips (new ones ringed in terracotta, with the group's emoji when they went to one group), a full-screen viewer (tap for the next or last one, hold to pause, swipe down or Esc to close), "Seen by" on your own, and a story maker with the phone's camera, your Photos library or words on a colour, plus stickers you drag, pinch and style. ＋ now offers Post or Story, and long-pressing P Porch on Android offers New story and New post. A video over a minute offers to become a post instead.
- Replying to a Porch story: send a message or one of six quick reactions from under someone's story, and it goes to your one-to-one conversation with them in Rooms, with the story attached while it's up ("This story has ended" after).
- Porch highlights and your story archive: every story you post is kept privately for you (Profile → Story archive), and you can keep some on your profile as named highlights with a cover. Each story in a highlight still shows only to the people in the groups it went to, so Mum sees the family ones and your mates theirs. Profiles also show a ring round the picture while someone has a story up.
- Pinned posts in Porch groups: a group's admins can pin up to three posts to the top of the group's page (never the feed), from a post's "…" menu.
- Porch group events: plan an event in a group (the group's Event button, or Event when posting to one group) and it goes in Calendar with everyone in the group invited (not for Everyone, unless you choose), on a post with a card showing who's going and Going · Maybe · Can't go. Anyone in the group can answer from the card, someone who joins later too, and it lands in their calendar. A group's Events tab lists what's coming up. Make this an event on your own post now puts the card on the post, and can invite everyone who sees it. Deleting the event leaves "Cancelled" on the post; deleting the post can cancel the event too.
- People pages show what you share with someone in other apps, starting with Porch: "On Porch" has their latest posts you can see, the groups you're both in, and See all on Porch. Nothing shows from a group you're not in.

### Changed
- Install apps: the Passwords browser extension for Chrome, Edge and Brave now comes from the Chrome Web Store with one "Add to Chrome" button, and keeps itself up to date. Installing it by hand from a zip is still there as a fallback.

## [0.34.0] - 2026-11-09

### Added
<!-- Calls (DM calls), WP-D1 -->
- Calls in DMs, the server side (the call screen comes next): voice and video calls in 1:1 and group conversations. A call rings everyone else on every device for 45 seconds, even during quiet hours; answer on one device and the others stop ringing. Decline from the notification, or let it ring out: the conversation then shows "Missed call" and you get a "Missed call" notification. A finished call leaves "Call · 12 min" in the conversation. Anyone in a group conversation can join its call while it is on, and a group call can ring someone again. You are only ever in one call or voice channel at a time. Blocking someone refuses calls both ways and ends a call with them.
- Account → Notifications gains a Calls switch (on by default) for ringing and missed calls.
<!-- Calls (DM calls), WP-D2 -->
- Calls in DMs, the call screen: phone and camera buttons in every 1:1 and group conversation. A call rings in every open Promptly tab with a ringtone and a big Answer and Decline (Voice only for a video call; "End and answer" when you're already on a call or in a voice channel), and as a notification with Answer and Decline when Promptly isn't in front. In the call: mute, camera on and off, switch camera on a phone, share your screen, speaker, microphone and camera choice, a timer, a green ring on whoever is talking, a grid for group calls, and Ring again. Minimise to a small window you can drag around while you use Promptly, or pop the video out into picture-in-picture.
- Rooms: a green "Call in progress · 2 people · Join" bar in a conversation with a call on, and "Switch here" when you're in it on another device. Call lines in the conversation in your own words ("Missed call from Sam · Call back", "No answer · Call again", "Video call · 12 min"). On a phone, the conversation's header keeps the call buttons and moves Search, Events, Pinned and Block into More.
<!-- Calls (DM calls), WP-D3 -->
- Calls in DMs on Android phones with the Promptly app: a call rings like a phone call, full screen over the lock screen with your phone's own ringtone (silent, vibrate and Do Not Disturb respected), with Answer and Decline, or End and answer when you're already on a call. Answering keeps the call going with the screen off or in other apps, with a call notification for Mute, Speaker and Hang up. Android treats it as a real call: Bluetooth headsets and the car can answer and hang up, the car shows the call screen, and spoken directions duck under it. Answer on your laptop and the phone stops ringing. If Android 14 or later won't let calls ring full screen, they show as a notification and Promptly asks once to allow it.
- Rooms on a phone with the app: a video call answered on the phone opens its conversation with everyone's cameras while the app keeps the sound; Mute and Speaker there control the app's call, and Turn camera on moves the call to the page.
<!-- Calls (DM calls), WP-D4 -->
- Rooms: a Calls tab (Spaces · Messages · Calls on a phone, a phone button under Messages on a computer) with your call history: who, which way, how long, missed calls in red and the ones you haven't seen in bold, a call-back button on every row, All or Missed, and a red badge with the number of missed calls until you look. Each call opens to its details: every call with the same people, Call, Video call and Message, and Remove from call history. Removing a call, or clearing your whole history, only changes your own list.
- New call: pick someone from the Calls tab, or call anyone straight from their person page or their contact card (Call and Video call, when they're on Promptly and can take calls).
- Ctrl+K: "Call Mum" or "Video call Sam" calls someone by the name you know them by (a contact's name or nickname, what they are to you in Photos, or their username). People you've blocked, or who blocked you, aren't offered.
<!-- Calls (DM calls), WP-D5 -->
- Calls on Android phones with the Promptly app: Call and Video call on the phone now hand the call to the app (the first time, it asks), so the call you start keeps going with the screen locked, in other apps or with the page closed, just like a call you answer. The ringback plays in the app, Bluetooth headsets and the car see it as a call, and if Android puts it on hold for a phone call the other person is told. Needs the new app version; without the app the page holds the call as before.
- Video calls on Android phones with the app: your phone's own camera in the call (on and off, switch front and back), everyone's video on the app's call screen, working over the lock screen, and picture-in-picture when you leave the call screen. Locking the phone pauses your camera and it comes back when you unlock. The conversation's page can turn the app's camera on and off and switch it too.
- Call tones: the through tone when they answer, a tone when the connection drops and when it's back, a soft tone while the other person has you on hold, and one when the call ends. While the connection drops the call says "Reconnecting…", or "You're offline" when there's no network, and carries on by itself (also when a phone moves from Wi-Fi to mobile data).
- Calls on a weak connection, or with Data saver on: video is taken and sent smaller, and the call says so. On Android, mobile data takes the middle quality and Android's Data Saver the lowest.
- Account → Notifications → Calls: "Don't ring me during quiet hours". Calls still ring through quiet hours unless you turn this on; then a call in your quiet hours rings out to a missed call, and you're told about it when quiet hours end.
- Passwords: a Duplicates page in the vault's sidebar, with a count, finds logins saved twice (same site and username) and ones that are probably the same (same site and password, another username or none), all on your device. Pick which to keep and Merge (the others go to Trash for 30 days, with Undo), mark a group Not a duplicate (remembered in your encrypted vault), or Merge all sure duplicates at once.
- Talking to Promptly (groundwork): a speed bench for the speech pipeline, `python -m app.talk.bench` (Whisper base/small per pass and as a live lane, Smart Turn, Kokoro to first audio, the voice model's first word), and an echo test page, `backend/app/talk/echo_test.html`, that shows whether a browser cancels its own playback. Nothing changes for users yet.
- Talking to Promptly (groundwork): the speech services can now listen and speak live. Whisper hears a conversation as it happens, shows words as you say them, and knows when you've finished talking (about a fifth of a second after your last word) without cutting you off when you pause mid-thought; it uses the small `base` model for this, so dictation and meetings keep theirs. The voice service starts speaking about 0.3 s into a reply instead of after the whole sentence, and stops the moment it's interrupted. Not used by the app until Talk is switched on in a later update.
- Talking to Promptly (groundwork): the conversation engine behind Talk. The app can now hold a spoken conversation over one connection: it hears you as you speak, starts answering as soon as you've finished (about a second after your last word with a fast model, under two seconds with a typical hosted one, measured on CPU), stops the moment you talk over it and keeps only the part you heard in the chat, ignores its own voice coming back through your speakers and "mm"s and "yeah"s, and treats a pause mid-sentence as one turn, not two. Web conversations are saved like any chat (or as a temporary chat if you choose); phone conversations aren't kept. Only timings are recorded, never words or audio. No screen uses it yet; the web and Android Talk screens come next.
- Talking to Promptly (groundwork): doing things by voice. In a spoken conversation Promptly can look things up in your apps (your day, calendar, email, files, photos, maps, the web) and make changes, but a change always waits for your yes: it reads back exactly what it will do ("Add Dentist to your calendar for Friday 20 November at 9 AM?") and you answer out loud or tap Yes, in the conversation or on the card in the chat. Say "no, I meant Friday" and it asks again with the change. Your own commands answer straight away without the AI, and on the phone it can set a timer or an alarm, start a call or a text for you to send, open an app or start directions. Nothing is deleted by voice.
- Talk to Promptly on the web: tap the Talk orb next to the message box (or press Ctrl+Shift+Space, use Talk on Today, or "Talk to Promptly" in Ctrl+K) and just talk. It answers out loud, shows your words and its words as captions as they're said, stops the moment you talk over it (or press Stop), and asks before changing anything, with Yes and No buttons as well as your spoken answer. On a computer it sits beside the chat so cards and maps land where you can see them; on a phone it fills the screen. Pick a voice and speed on the spot, mute, type instead, or use tap to talk (hold Space) in noisy places. A dropped connection or a page reload picks the conversation back up, and a weak connection switches to the simpler tap-to-talk voice mode until it recovers.
- Account → Voice: Talk settings for speaking speed, how you take turns, whether talking over it interrupts, captions, and whether voice conversations started outside a chat are kept or temporary.
- Chats mark spoken messages with "Spoken", and replies you talked over with "Spoken · interrupted".
- Talk to Promptly on Android: the assistant sheet is now a conversation. Just talk, it answers out loud with captions, talk over it to interrupt, and say "that's all" to finish. Changes and alarms wait for your yes (say it or tap it); timers, calls, texts, apps and directions work as before. Open it with your phone's assistant gesture, the new "Talk to Promptly" Quick Settings tile, or long-press the Promptly icon → Talk. Once started it keeps going if your screen locks, with Mute and End on the lock screen; a headset button stops it talking or mutes it, and it waits quietly while a call or another app has the audio. Phone conversations aren't saved. If your server doesn't have Talk yet (or it's off), the sheet asks one question at a time as before.
- Phone assistant settings: turn hands-free conversations off, and choose whether answers play as call audio (best for talking over it on the speaker) or as assistant audio (can be louder).
- Admin → Talk: turn Talk on or off, limit it to some user groups, set how many people can talk at once, see the speech models in use, and see how fast answers have been (usual and slow-end times for knowing you'd finished, the transcript, the model, the first sound, and going quiet when talked over, per device). Only timings are kept for this, for 30 days, never words or audio.
- The Talk screen shows a small cloud when answers come from a hosted model; hover or tap it to see which ("Answers come from OpenRouter").
- README: "Talking to Promptly" setup notes, with the speech settings `WHISPER_LIVE_MODEL`, `WHISPER_LIVE_SLOTS`, `TTS_THREADS` and `TTS_STREAM_SLOTS` (now also settable in `.env`).
- Notes (groundwork for the new Notes app): notes and checklists you can pin, colour, label with your #tags, archive, share with chosen people on this server (who can edit, or leave) and restore from earlier versions. Ticking and adding list items never clash between people, and everyone on a note sees changes live. Nothing about a note is ever shown to someone it isn't shared with.
- Notes: a "Notes" switch in Notifications, for when someone shares a note with you.
- Notes: deleted notes go to the Trash for 30 days, with Restore and Delete forever, and show in the one Trash under "Notes".
- Notes: the Notes app at /notes (a tile in Apps, and it installs as its own app). "Take a note…" saves as you type with no Save button; lists tick, indent and reorder; notes can be pinned, coloured, labelled with your #tags, archived, deleted to the Trash, dragged into your own order, searched with filter chips, and picked several at a time. Grid or list view. On a phone it's Keep's layout: a two-column grid, + and New list at the bottom, and the note as a full page.
- Notes: works with no connection. Notes are kept on the device, changes wait there (even if the page is closed) and save when you're back; if someone else edited the same note meanwhile, both versions are kept.
- Notes: share text or a link from another app into the installed Notes app to make a note.
- Notes: pictures in notes, from this device (or the phone's camera) or from your Photos. They sit at the top of the note and on its card, and open full size; added pictures are kept in My files › Notes, and a photo from your library isn't copied.
- Notes: voice notes. Record one in the browser (pause, stop, or discard; up to 3 hours), or add an audio file. It plays in the note with a waveform, a scrubber and 1×/1.5×/2×, and uploads in the background, carrying on where it left off if the connection drops, or later if you're offline.
- Notes: recordings are turned into words by the server's own Whisper. The words sit under the recording (Show all, Copy, Add to note), never replace what you wrote, and search finds them in Notes and in Files. With cloud speech-to-text it's off until an admin turns it on (Admin → Defaults → Voice notes in Notes).
- Notes: share pictures and recordings from another app into the installed Notes app, and a "Voice note" shortcut on its icon.
- Notes: the people a note is shared with see and play its pictures and recordings, and nobody else can, even with a link.
- Notes: Share a note with people on this Promptly (the people picker, with names from your Contacts and Photos). It turns up in their Notes straight away and they get a notification (held during quiet hours); they can edit it, see who else has it, and Leave. The owner can take anyone off. Someone you've blocked, or who has blocked you, can't be added, and the message never tells anyone they were blocked.
- Notes: everyone on a shared note sees the others' ticks and edits within a second or two. If two people type in the same note at once, each sees the other's words appear; a paragraph both changed keeps both versions, with a line saying so. A shared note someone else changed shows "Sam made changes" on its card until you open it.
- Notes: Remind me (Later today, Tomorrow, Next week, or a day and time, repeating daily, weekly, monthly or yearly). A reminder is a task in your Tasks, linked to the note, with Done and Snooze on its notification, which opens the note. Ticking it off anywhere (the notification, Tasks, Today) clears the note's reminder straight away. Reminders are your own, even on a shared note.
- Notes: a Reminders view (Overdue, Today, Upcoming) and a Reminders search filter.
- Notes: if someone takes you off a note while you have it open, it says so and offers Keep a copy.
- Notes: a Notes card on Today with your pinned notes (a list says how many items are left) and voice notes still being turned into words.
- Notes: Ctrl+K finds your notes by their title, words, list items and what was said in their recordings, including notes shared with you.
- Notes: type [[ (or @ after a space) in a note to link anything you can open: another note, a task, an event, a file, a person. Clicking the link opens it, and the other note shows where it was mentioned. Notes can be linked the same way from documents, chats, journal entries and room messages.
- Notes in chat: "add oat milk and eggs to my shopping list" puts them on your note called Shopping or Groceries (your own or one shared with you), or on the Shopping list in Tasks when you don't have one, and the reply says which. Chat can also find, read and make notes and tick items off. It won't change your notes in a reply that read a web page, a file or someone else's words.
- Notes: AI in a note's ⋯ menu. Tidy up, Make a list and Suggest a title show what they'd do first, nothing changes until you choose Use this, and Undo puts the note back. Only offered when an AI model is available to you.
- Notes: Make an event opens a new Calendar event filled in from the note, with the day, time and place read by AI when a model is available.
- Notes: Turn into tasks adds a list's unticked items, or the to-dos AI finds in a text note, to the Tasks list you pick, each linked to the note, with Undo.
- Notes: Send to… posts a note card in a room or to a person. Only people the note is shared with can open it; everyone else sees "This note isn't shared with you".
- Notes: Make a copy (pictures and recordings come too) and Open as document (the note's words become a Document in your Files, and the note keeps a card that opens it), each with Undo.
- Calendar: a link to `/calendar?new=1` with a title, notes, place, day and times opens a new event filled in.
- Notes: bring your Google Keep notes across (Import from Google Keep in Notes, or Files → Import & export → Google Keep). Colours, pins, archived notes, labels, ticked lists, pictures and recordings come with them, with the dates you wrote them. Links Keep found stay in the note, notes in Keep's trash are left out, and importing the same Takeout again skips what's already in. Keep's older voice recordings are converted so browsers can play them. The Google Takeout import brings Keep notes too, along with Photos and Drive.
- Export my library includes your notes: a Markdown file for each (colour, pin, labels, dates, reminder and who it's shared with at the top; lists as checkboxes; pictures and recordings linked) and a notes.json with all of them. Importing the export into another Promptly ("A folder of photos") brings the notes back with their colours, pins, labels, lists, formatting, pictures, recordings and transcripts, and importing it twice adds nothing new.
- Notes: Ctrl+K has New note, New list ("new list milk, eggs" makes the list with its items) and Record a voice note, each opening Notes.
- Promptly for Android: home-screen widgets. **Agenda** shows today and the week ahead from your calendars (tap an event to open it in P Calendar, + to add one) and **Tasks** shows today's and overdue tasks: tick them off right on the home screen (tap again within a moment to undo), add one with Quick task, tap a task to open it in P Tasks. Both work with no signal: they show the last saved copy, ticks and new tasks wait on the phone and sync when you're back, and they move on by themselves at midnight. Each has settings (which calendars, titles only; which list, tasks with no date). They refresh every 30 minutes and a couple of minutes after you open a Promptly app, and look like Promptly in light and dark.
- Account → Devices: phones now show what they can do (maps, phone assistant, home-screen widgets), with a tick to turn a phone's widgets off. Phones already linked can use the widgets without linking again; a removed phone's widgets wipe what they showed.
- Promptly for Android: a **Notes** widget (your pinned and latest notes as cards in their colours, with list items you can tick right there, and Take a note, New list and a mic at the top) and a **One note** widget (a note or list you pick, its items to tick, ticked ones below, + to add more). Both work with no signal and can show titles only.
- Promptly for Android: Quick note (a title and text, or a list) and Voice note from the Notes widget or a long-press on P Notes. A voice note records even with no signal and with the screen locked (a notification shows while it records, with Pause and Stop & save); it uploads when you're back online, carrying on where it left off, and the server turns it into words.
- Promptly for Android: Share to Notes. Share a link, text, pictures or recordings from Chrome, Photos or any app as a new note, or add them to one of your notes. A link gets its page's title.
- Promptly for Android: a P Notes icon (turn it on in Choose apps), with New note, New list and Voice note on a long-press.
- Promptly for Android: the widget picker shows a preview of each widget (Android 15 and newer).
- Porch (being built): the groundwork for sharing photos and news with the people on your server through groups. Groups can be public (anyone can join with one tap) or private (invite only, invisible from outside), with an owner, admins and invites to accept; everyone is in the built-in Everyone group. Posts go to all your groups, one, or a few, and only people in those groups can see them or their photos, which stay in your own Photos library. The Porch app itself comes next.
- Porch (being built): the app, at /porch and as its own installable app (an Apps tile for everyone it's turned on for). The feed shows the groups you tick, saved on your account, with a Photos only filter, "You're all caught up" where you last left off, and a "new posts" button when something arrives while you're looking. Each post shows which of your groups it's in, swipes through its photos and videos, and can be edited, deleted, saved at full size or have its link copied. Groups: invites to accept or decline, Find groups with one-tap Join, making a private or public group, a group page with its posts, photos, people and invites, and admin tools (make admin, hand on, remove, edit, delete). Profiles show someone's photos, posts and life events that you can see, the groups you share, and what they are to you from your own People. A welcome on first open, and plain empty states on a new server. Writing posts comes next.
- Porch (being built): writing a post. Pick up to 20 of your own photos and videos from your Photos library (recent, an album, or a search), or take or upload new ones, which land in Photos like any other. Drag them into order, crop or give one a look (Vivid, Mono, Fade, Bright, Moody, Soft) for that post only, without changing the photo in your library, and describe each one for screen readers (filled in from Photos' own description when it has one). Then choose who sees it (all your groups, one or a few, starting from what you used last), write a caption with @mentions of only the people who'll see it, add a place from Maps (Photos offers where the photos were taken first) or a life event, and post. Text posts show a link's preview. Unfinished posts are kept as a draft on that device. Your own posts can now have their photos and place changed too, not just their words. "Share to Porch" on a Photos memory opens a post with its photos, and the installed Porch app takes photos and links shared from other apps on the phone.
- Porch (being built): talking about posts. Comment on a post, or reply to a comment (one level), edit or delete your own, and delete any comment on your own post. React with one of six emoji (double-tap a photo for a heart, hold the heart for the others); only the person who posted sees who reacted, everyone else just sees the emoji. @mention people in posts and comments (only people who can see the post are offered or told). Polls of 2 to 6 options that close after a day, three days, a week or never, with one vote each that you can change; once you've voted you see how everyone voted. Tag people on a photo while arranging it; a tag shows only after they say yes, and "Suggest tags from my faces" offers people your Photos already knows, when you both turn it on. Save posts to a private Saved list. A new Activity tab (with its badge) gathers comments, replies, mentions, reactions, tag requests and group invites. Anyone you've blocked, or who blocked you, is left out of all of it.
- Porch (being built): Porch connects to the rest of Promptly. Search posts you can see from Porch's own search or Ctrl+K, by their words and place, or photos by what's in them ("beach Sam"). From a post's menu: Share to a Room (people in the room who can't see the post get "This post isn't shared with you"), Reply privately (opens your Rooms conversation with the poster, with the post attached; not possible across a block), and Make this an event (the calendar's editor filled in with the post's words and place, inviting only people who can see the post; the event links back to it for them). Today has a Porch card with new posts from your ticked groups and today's birthdays of people in your groups, with "Post for Sam". Export my library adds porch.json (your posts and which photos, their comments, your comments elsewhere and your groups). Moving a photo to the trash in Photos warns first when it's in Porch posts ("This photo is in 2 Porch posts").
- Porch: notifications. Get one for new posts from a group (the bell on the group, "All new posts") or from a person ("Notify me" on their profile), comments on your posts, replies, mentions, tags (with Show it / Not me on the notification), group invites (with Join / Not now) and birthdays of people in your groups. Each is On, Daily summary or Off in Porch → Settings → Notifications; reactions start in the daily summary. Quiet hours hold them like the rest of Promptly, nothing comes from someone you've blocked, and Porch has its own switch in Account → Notifications.
- Porch: report a post or comment from its menu. Admin → Porch has the reports queue (remove it, telling the poster why in their Activity, or keep it), Porch on or off, who can use it (everyone or chosen user groups), video limits, and the Everyone group's name. Server admins can also take a post out of Everyone, with a reason.
- Promptly for Android: P Porch, a home-screen launcher (turn it on in Choose apps) that's also in Android's share sheet, so photos and videos shared from another app open in Porch's composer.
<!-- Nav badges -->
- Sidebar count badges: a small terracotta number on the Tasks, Mail, Rooms and Porch rows of the sidebar (and the phone menu, and the sidebar beside the Passwords vault), on the icon when the sidebar is collapsed. Tasks counts what's due today or overdue (in your time zone), Mail your unread Inbox conversations, Rooms your unread messages and mentions plus missed calls you haven't looked at, and Porch new posts in your feed plus new Activity (comments, replies, mentions, reactions, invites and tag requests). It goes away when there's nothing new, shows 99+ past 99, and updates as you read, tick things off or open the app.
<!-- Calendar: location suggestions (cal-location) -->
- Calendar: the Location box fills in as you type, from your saved P Maps places (Home, Work, favourites), contacts with an address, and P Maps search (addresses and the businesses OpenStreetMap knows), nearest to you first; anything you type still works as it is. The same box is in Mail's Add to calendar, and an event's place opens in P Maps only when Maps is set up.

### Changed
<!-- Calls (DM calls), WP-D5 -->
- A missed call's notification now opens that call in the Calls tab (call back, message, or every call with them), rather than the conversation.
- When Talk is off for you, the Talk button is hidden and every way in (Today, Ctrl+K, the shortcut, the + menu) opens the tap-to-talk voice mode instead.
- Memory learns from voice conversations knowing which of your words were transcribed, and skips facts that look misheard (it won't save a name, number or date from speech unless the conversation confirms it).
- Read-aloud runs Kokoro on 4 threads (`TTS_THREADS`) instead of one per core, which was 2–3× slower when the server was busy.
- Phone assistant: a spoken yes or no is now judged by the same strict rule everywhere. "Okay, do it" and "nope, never mind" are understood without asking the AI, and anything with a "wait" or "no" in it is never taken as a yes.
- One thing in Promptly is called a note now. A workspace's documents are called Pages (New page, Untitled page, pages in counts, search, the trash, automations and links); they work exactly as before. Files' New → Note and the Note tile on Files' home start a note in Notes; use Document for long writing.
- Porch (being built): ticked groups above the feed are now a light tint with a tick instead of solid orange, and on a wide screen the feed's groups are ticked only in the left-hand "In your feed" list (the chip row stays on phones and tablets).
- Porch (being built): in the composer's Arrange step the order buttons now say "Earlier" and "Later" on phones too (with tooltips), and the badge for group invites moved from Groups to the new Activity tab. Invites in the right-hand panel on wide screens no longer squeeze into a narrow column.
<!-- v0.34.0 integration: approve instead of refuse -->
- Chat: after reading something from outside (a web page, an email, a file, or a note in a shared workspace), the chat no longer refuses to change things for you. It shows exactly what it would do on a card (add this event, send this message, make this note, save this to memory, look at your timeline) with "Yes, do it" and "Don't run it", and does it once, only if you say yes. Talk asks out loud the same way instead of saying it won't.
<!-- v0.34.0 integration: app navigation -->
- Porch and Notes opened inside Promptly keep Promptly's menu: on a big screen they sit in Promptly's layout, and on a phone Porch's pages have Promptly's menu button at the top (Porch's "Back to Promptly" links are gone). Only the installed Porch or Notes app shows just that app.
<!-- v0.34.0 integration: phone app -->
- Promptly for Android 1.6.0 brings this release's phone parts: calls that ring like phone calls, Talk on the phone, the Notes widgets and quick capture, and sharing to Porch from other apps.
<!-- Admin privacy, AP4 -->
- Admin → Users → Delete: shared workspaces no longer need a new owner picked by hand; each says who it goes to, and private ones come with a reminder to ask the person to use Export my library first.

### Fixed
<!-- Porch: reports go to the group's admins (WP-P2.0) -->
- Porch: a report now goes to the admins of the group you saw the post in, and you choose which group when you see it in more than one. Only reports made in Everyone go to the people who run this Promptly. Before, every report went to the server admins, who could read the post and see its photos even in a private group they weren't in.
- Porch: server admins no longer see how many other groups a reported post is in, and can no longer remove posts or comments from groups they aren't in.
- Porch: whoever looks at a report sees the reason given, not who reported it.
- Porch: group admins have a Reports tab on the group page (and a line in Activity when something's waiting). "Remove from Family" takes a post out of that group only; it stays in its other groups, and the person who posted it is told why. The poster can still delete it everywhere.
- Porch: you can't report someone to a group they run on their own; the report sheet tells you to leave the group or block them instead.
<!-- Calls (DM calls), WP-D5 -->
- Calls: a 1:1 call no longer ends when one side's connection drops for a moment and comes back (for example moving from Wi-Fi to mobile data). A connection now has 15 seconds to come back before it counts as hanging up.
<!-- Calls (DM calls), WP-D2 -->
- Voice channels: reloading the page, or joining the same channel on another device, could drop you straight back out when the old connection's goodbye arrived late.
- Chat: workspace notes, boards, sheets and files that the chat reads on its own before answering now count as outside content, the same as when it opens them with a tool, so text someone else wrote there can't make it save to memory, change your calendar or files, or post for you without you asking. The same goes for @-mentioned files and chats, a custom model's documents, and files attached earlier in the chat.
- Android crash reports now say what the voice assistant was doing when the app stopped (listening, thinking or speaking, on the phone or in the car, and for how long), to help find the crash some people had while driving. The car's microphone is also now always let go if asking fails.
- Phone assistant: it now uses the default model you chose in your account when the server has no voice model set. It used to skip your choice and fall back to the server's.
- Notes: notes made while you were elsewhere in Promptly (an import, a chat) didn't show when you went back to Notes until the page was reloaded.
- Notes: a note put back the way it was (an earlier version, or Undo) sometimes kept showing the newer words in an open note until it was reopened.
- Notes: list tick boxes were plain white squares in dark mode; they now match the cards in both themes.
- People picker (sharing in Notes, Files, Calendar, Rooms): each person in the list was a button inside a list option, which screen readers announce badly; the option itself is now what you pick.
- Notes: a label's page opened while the label was new on the device stopped working once it was saved; it now keeps working.
<!-- v0.34.0 integration -->
- Notes: pressing Esc while typing in a note's text didn't close the new note or the open note (it only worked from the title). It now closes and saves from anywhere in the note, and still just closes the link suggestions when they're showing.
<!-- Nav badges -->
- Rooms: the number on the Rooms app icon counted every unread message in rooms you'd set to mentions only; it now counts just the mentions of you there, the same number the Rooms app shows.
<!-- Passwords: vault nav -->
- Passwords: opened inside Promptly, it now has Promptly's normal sidebar (expanded, with New chat, Search, your pages and pinned apps in the same simple icons, folders, recent chats and your account) instead of a narrow strip with coloured app icons, and the same slide-in menu on a phone. It follows your collapsed or expanded choice, the same as the rest of Promptly.
- Opening Passwords while you're in a voice call no longer drops the call: Passwords opens in a new tab and the call carries on in the first one.
<!-- Admin privacy, AP3 -->
- Custom models: taking a file out of a custom model now also stops the model from finding what was in it.
<!-- Admin privacy, AP1 -->
- Admin → Errors: a request that crashed now shows whose request it was; the person was always left blank.

### Security
<!-- Admin privacy, AP3 -->
- Custom models: an admin can only add their own files. Before, any person's file could be added by its id, and everyone using the model could then search it. A file someone shared with the admin can't be added either, because it was shared with the admin alone. Other people's files already in a custom model are taken out when the server updates (only the number is logged).
<!-- Admin privacy, AP4 -->
- Deleting a user: an admin can no longer take over the person's workspaces. A private workspace is deleted with the account, and a shared one goes to one of its own members who can edit it (the longest-standing workspace admin, then editor; the admin can pick another of them). With nobody else who can edit it, it's deleted.
- Deleting a user: the confirmation no longer shows the names of their workspaces. Private ones are only counted, and a shared one is named only if you're in it.
<!-- Admin privacy, AP1 -->
- Admin → Console and Admin → Errors no longer show the addresses people open. Each request is shown by its route, like GET /api/calendar/feed/{token}.ics, so calendar feed links, signed photo and file links, share, album and form links, phone pairing codes, WebDAV file names and map positions stay out of them. Everyday request lines no longer say who made them; errors still do. Errors and rate-limit records saved before the update are rewritten the same way, and old errors whose address can't be matched to a route are removed.
- Pairing a phone: the page now checks the pairing code in the body of the request rather than in its address, so the code can't show up in a log.
<!-- Admin privacy, AP2 -->
- Admin → Console and Admin → Errors no longer show what people type or say: no file-search or web-search words, research questions, sub-agent tasks, voice assistant requests, WebDAV file names, pasted links, recipe links, flashcard file names or fetched page addresses (only the site's name). Saved errors and Android crash reports lose web address queries and long quoted text before they're stored.
- The admin's "The Android app crashed" notification now says only how many new faults came in, without the fault text, the person or the phone.

## [0.33.0] - 2026-11-09

### Added
- Forms (groundwork): a form is a new kind of file. It can be made blank or from six ready templates (RSVP, sign-up sheet, feedback, contact details, event registration, order form), copied, saved as a template, shared with people who can edit it or see its answers, trashed (which stops it taking answers) and restored (still closed), and downloaded as a .zip of its questions and answers.
- Forms: the form builder. Make a form from the new Forms app (blank or from a template), from New ▸ Form in Files, or from the Files home. Every kind of question (short answer, paragraph, multiple choice, checkboxes, dropdown, linear scale, rating, date, time, file upload), plus text, pictures and sections, with "go to section based on answer", places per option for sign-up sheets, answer rules, a colour, header picture and font for each form, and a live preview that works just like the real form. Drag questions to reorder them, or use Move up and Move down; duplicate, delete and undo. It saves as you go, even with the form open in two tabs or while you're offline.
- Forms: answering. Send gives a form its link, with Copy, a QR code you can download for a flyer, Reset link and Turn off, and sends it to people on this server as a notification. The answer page is made for phones: it keeps your answers on the device as you go, sends when you're back if you lost signal (never twice), checks everything again on the server so required questions can't be skipped, and gives the last place on a sign-up sheet to exactly one person. People on this server answer as themselves, once if the form says so, and can change their answer; people without an account get a private link to change theirs. Forms close at a time or after a number of answers, with your message.
- Forms: spam limits with nothing to set up for forms anyone with the link can answer (per person, per form and per address, a hidden trap field, and answers sent too fast refused), a "Report this form" link, and Admin → Forms, where admins can turn off answers from people without an account, see link forms and their reports, and close one (its owner is told why).
- Forms app: your forms and forms shared with you, with how many answers each has and how many are new, whether it's open, and when it closes. Forms made there go in a Forms folder in Files.
- Forms: the Responses tab. A summary of every question (bar charts with counts and percentages for choices, showing when a limited option is full; columns and the average for scales and ratings; dates grouped by day; the newest written answers), every answer to one question with search, and one answer at a time (swipe on a phone). Delete an answer (its place on a limited option opens again) or all of them, and download the answers as Excel or CSV, with anything that looks like a formula kept as plain text.
- Forms: notifications about new answers. One notification per form that updates as answers arrive ("BBQ RSVP · 6 new answers"), never what anyone wrote. Each form has its own choice (each time, once a day in your daily summary, or never) and an optional daily email; collaborators can follow a form too. Forms has its own switch in Account → Notifications, you're told when a form closes by itself, and Today shows forms with new answers and forms closing today.
- Forms: answers in a Sheet. From the Responses tab, link a new spreadsheet (made next to the form) or add a "Form responses" tab to one you have; the header row comes from your questions and every answer is added as a row as it arrives, live even while the sheet is open in front of you. A changed answer updates its own row (found by its Response #, so sorting the sheet or adding your own columns is fine), new questions add a column, and deleting an answer in Forms leaves the sheet alone. Answers that look like formulas stay plain text. The Sheet card shows when it was last updated, with Sync now and Unlink; if the sheet is deleted or in the bin it says so, with Make a new sheet. If the sheet can't be reached for a moment, the answers are added a few minutes later.
- Forms: file questions. People answering can add photos (a phone offers its camera) and files, each uploading with its progress, and take one back before sending. People on this server can send the kinds the question allows; people without an account only pictures and PDFs, and only when the form allows it. Files count against the form owner's storage, never show in Files or search, lose their location before they're kept, and each form takes at most a day's worth (500 MB, or 100 MB for a link form; an admin can change both in Admin → Forms). Responses shows them as tiles with Download and Save to Files, warns about files from people outside the server, and a linked sheet lists each file with a link back to its answer. Deleting or changing an answer deletes the files it no longer has, and files picked but never sent are deleted after a day.
- Forms: Make with AI. Describe your form (or tap "Describe your form" on a blank one) and the AI suggests questions, shown as a preview to Add, Add all or Skip; nothing goes in until you say. Choice questions get Suggest options.
- Forms: Summarise on a written question gives themes with how many people said each and short quotes that open their answers, labelled as an AI summary to check. Answers are read as other people's words, never as instructions, and the summary isn't saved or remembered.
- Chat can make a form: "make me a sign-up form for the BBQ" makes a draft in your Forms folder to check and send (it isn't taking answers and has no link until you send it), and can read a form's answers, which it treats as other people's words.
- Calendar: Add an RSVP form on an event makes an RSVP form with the event's title, time and place and links the two; the event then shows "RSVP form · 14 answers". People who answer can add the event to their own calendar (title, time and place only).
- Forms: Send ▸ To a room or person posts a card in Rooms with Fill in, for everyone the form lets answer (it never lets them change the form or see its answers), and Send ▸ Email opens your Mail composer with the link filled in (or gives you the words to copy).
- Ctrl+K: New form (also "new survey", "new rsvp"). Link… and [[ find forms by name, labelled Form.
- Export my library: files people sent with form answers are saved beside each form's .zip.
<!-- P Maps offline (maps-offline) -->
- P Maps in the car: "You've arrived at …" on the car's screen, with Save parking and Done, including for trips started from the car with the phone in a pocket.
- P Maps in the car: lane guidance on the turn card at junctions where the map knows the lanes.
- P Maps in the car: a "Speed camera · 60" note on the car's screen as well as the voice.
- P Maps: "Finding a new route…" on the phone and the car's loading card while a new way is worked out after a wrong turn.
- P Maps: "navigate to" and map links from other apps and assistants open P Maps (a navigate link starts driving; a place or a search opens it in P Maps), on the phone and in the car.
- Promptly for Android: a Google Play build (for Android Auto, which only runs Play-installed apps) that Play keeps up to date, plus a "P Maps in your car" card in Apps → Install apps explaining how to get it.
- P Maps: the server now makes offline map packs with each monthly map update: the map, directions and search (house numbers included) for all of Australia, in squares a phone can download. `MAPS_OFFLINE=0` turns them off.
- P Maps: offline areas you save (a view, a route's corridor or around a place) and signed, resumable downloads of their packs, for the Android app's offline maps. Admin → App settings says if making the packs failed.
- Promptly for Android: Offline areas (P Maps on the web hand-off, Photo backup → Offline maps, or the download notification): choose an area on a map and see its size first, or save the area around Home; it downloads on Wi-Fi (or now, on mobile data, if you say so), carries on from where it stopped after a lost connection or a restart, checks every file, and updates itself after your server's monthly map update. Shows the space used and free, says plainly when there isn't room, and deleting an area frees its space at once.
- Promptly for Android: P Maps' map now comes from your offline areas first, on the phone and in the car, so it draws in full with no signal and saves data with it. Outside your areas it uses the map along each trip you've started in the last week (Offline areas → Keep each trip's map for a week, on by default), then your server; with neither, the route still shows on a plain map.
- Promptly for Android: P Maps finds routes on the phone when your server can't be reached (no signal, or it takes more than 6 seconds). Inside your offline areas you can start a trip, and a wrong turn gets a new route from the phone within a few seconds; the screen shows "Offline route", "No signal · no traffic info" and, where there's no downloaded map, "No offline map here"; speed cameras still warn, and Ask Promptly says plainly that it needs signal. Outside your areas it tells you to head back to the route, and picks you up when you do. Back in signal, routes come from your server again. In the car, a one-off "No signal: using your offline map" note, and the route list works offline too.
- Promptly for Android: P Maps search works with no signal, on the phone and in the car: places by name ("Caltex Mudgee", nearest you first), street addresses with house numbers ("12 Macquarie St Dubbo", "3/12 …"), "fuel" or "the nearest servo", and your saved places, recents and usual routes, kept on the phone. Your server answers first; if it can't within 4 seconds, the phone does, and the results say they're offline ones.
- Promptly for Android: Add stop with no signal lists fuel, food and the rest along the road ahead from your offline areas, with how far ahead each is.
- P Maps on the web: Offline areas. Save the map's view for your Android phone with its size shown first (the squares it keeps are shaded on the map), or a route's roads with Save for offline next to Start; see what each of your phones has of each area ("Ready on Pixel 9 · 3 Nov", "Not on a phone yet"); rename, delete, or leave out house numbers. On an Android phone, saving opens the Promptly app to download it; elsewhere your phone downloads it next time it's on Wi-Fi.
- Admin → App settings: an "Offline maps for phones" card with the packs' state, the disk they use and how many areas people have saved.
- Export my library includes your P Maps offline areas (`maps/offline-areas.json`).
- Promptly for Android: opening P Maps with no signal now opens its own map, Drive, instead of a web page that can't load: your location, Where to?, Home, Work and your places, and a place's routes from your offline areas with Start. Long-press the P Maps icon for Drive and Offline areas. A map link from another app with no signal opens there too.
<!-- Calls (voice channels), WP-V1 -->
- Calls: the calls service (LiveKit, self-hosted) that voice channels in Rooms will use. New installs get it on. On an existing server, run the update once more after updating to this version: that run makes the calls key pair and starts the service (Admin → Calls says so if it hasn't). For voice from outside your home, forward UDP 7882 and TCP 7881 on your router.
- Admin → Calls: turn voice on, choose everyone or certain groups, cap Go Live quality and how many people fit in a channel, a set-up checklist that says what's wrong and how to fix it (calls service running, keys, your internet address and CGNAT, works from outside, upload for streams), and live usage. Admins are alerted if the calls service stops or your home's address changes.
- Account → Voice & video → Test calls: pick your microphone, speaker and camera, see your mic level, then make a real call to your server and hear yourself back, with how it connected in plain words ("Direct (best)", "Fallback over TCP (fine)", "Couldn't connect from here") and what to do about it. From outside your home it also estimates how many people could watch a stream.
<!-- Calls (voice channels), WP-V2 -->
- Rooms: voice channels in spaces, the server side (the screens come next). Admins add them like rooms; anyone in the space can drop in, and you can only be in one at a time: joining another channel, or the same one on another device, moves you. Admins set a user limit, voice quality, who can join and who can talk, whether cameras and Go Live are allowed, and how long someone alone in a channel stays before a "Still there?" check (15 minutes unless changed). Admins can mute or deafen someone for everyone (it sticks until they lift it), move them to another channel, or disconnect them. Nothing said is recorded.
<!-- Calls (voice channels), WP-V3 -->
- Voice channels, the engine in the browser (the screens come next): joining and moving between channels, staying connected while you use other pages, reconnecting on its own after a network drop, Enhanced noise suppression on by default (removes keyboards, barks and fans on your own device; switches to a lighter filter by itself on a slow device), voice activity with automatic or manual sensitivity, push to talk with a key and a release delay, mute and deafen (Ctrl+Shift+M / Ctrl+Shift+D), each person's volume up to 200% and "Mute for me" remembered on every device, join and mute sounds, and Go Live: share a screen, window or tab at 720p 30, 1080p 30 or 1080p 60, with its sound where the browser allows, which others watch only when they press Watch.
<!-- Calls (voice channels), WP-V4 -->
- Rooms: voice channels you can use, the way Discord's work. They sit in a space's list with 🔊 and show who's in them right now, with a green ring while someone talks and icons for muted, deafened (red when an admin did it), camera and LIVE. One click joins, or moves you from another channel. Admins add one from the space's menu ("New voice channel") or "+ Add voice channel".
- The voice panel: while you're in voice it stays at the bottom of the Rooms list and of Promptly's sidebar on every page, with the connection (click for ping, packet loss and how it connected), the channel, Disconnect, Camera, Go Live, who's in the channel, and Mute, Deafen and settings. A reload puts you straight back in your channel.
- A voice channel's page: everyone as a tile with their speaking ring or camera, live streams with a Watch button and how many are watching, a big view of the stream you watch with its own volume, theatre mode, full screen and pop-out, and the channel's text chat beside it.
- Go Live: pick your entire screen, a window or a browser tab, the quality (up to what your server allows), and "Smoother motion" or "Better for text". It says plainly which choices can bring sound (a tab in Chrome or Edge, your whole screen with sound in Chrome or Edge on Windows) and that a single window's or game's sound can't be shared from a browser.
- Click or right-click someone in voice for their volume (0–200%), Mute for me, Message, and for the space's admins Mute or Deafen for everyone, Move to another channel and Disconnect.
- Voice & video settings (Account → Voice & video, or the gear in the voice panel): microphone, speaker and camera, input and output volume, "Let's check" with a level meter and hearing yourself, voice activity with automatic or manual sensitivity, or push to talk with your own key and a release delay, noise suppression (Enhanced, Standard or Off, saying when a device uses a lighter filter), echo cancellation, automatic gain, Go Live defaults, data saver and voice sounds.
- Voice channel settings for admins: user limit, voice quality, who can join and who can talk, cameras and Go Live on or off, and how long someone can be alone before "Still there?" (5, 15, 30 or 60 minutes, or never).
- Voice messages in plain words: "Still there?" with a countdown, "You're muted" when you talk while muted, "You might be too quiet", moved by an admin, every way a call can end, microphone and camera problems with how to allow them, a reconnecting and "Rejoin" state, and a one-time tip the first time you join.
- Voice on a phone: a full-screen channel with big buttons and hold-to-talk for push to talk, a bar at the top of every screen to get back or leave, the screen kept awake while you're in the channel, and a note that voice may stop if you lock the phone.
- Ctrl+K: "join lounge" joins a voice channel; Mute, Deafen and Leave voice while you're in one. Today shows who's hanging out in voice now, with Join. Export my library includes voice.json: your time in voice channels (which channel, when, how long; nothing said is ever recorded).
<!-- Calls (voice channels), WP-V5 -->
- Voice channels on Android phones with the Promptly app: tapping Join in P Rooms hands the channel to the app, which keeps you in it with the screen off or while you use other apps, through Bluetooth earbuds, a car or the loudspeaker. Its notification says who's talking and has Mute, Deafen and Leave; the channel page stays the remote control and still shows cameras and streams while it's open. Spoken directions from P Maps play over the channel, and "Still there?" asks on the phone too. Needs the new app version; iPhones and phones without the app keep the page awake instead, as before.

### Changed
- Phone parts of this release arrive with the next Promptly phone app update: downloading offline map areas on the phone, the Android Auto improvements, and keeping a voice channel going in the background on Android. Until then you can save offline areas on the web (your phone downloads them once it has the new app), and voice channels on a phone join from the page.
<!-- P Maps offline (maps-offline) -->
- P Maps in the car uses the avoid choices (tolls, highways, ferries) of your last drive started on the phone, and the route list says so.
- P Maps: a trip started on the phone with avoid options now shows on the car's screen too, and wrong turns get the new road's speed cameras.
- P Maps: on a weak signal, routes give up sooner with a clear message, and the car's map and saved places use the copies from last time instead of waiting.
- P Maps: wrong turns check for road closures at most once every 5 minutes, so a bad day doesn't use up the day's closure checks (Admin → App settings explains this).
- P Maps in the car: the route choice uses the newer car screen on cars that support it.
- P Maps (Android): ending a trip (on the phone, in the car, or on arriving) goes back to P Maps' Drive map, ready for the next place, and a trip that can't start says why there.
<!-- Calls (voice channels), WP-V1 -->
- The site now allows the camera and screen sharing for itself (for voice channels' cameras and Go Live) and WebAssembly (for noise suppression). Account → Voice is now Voice & video.
<!-- Calls (voice channels), WP-V5 -->
- Voice & video settings use Promptly's own colour (terracotta) for sliders, switches, focus rings and the selected options, also inside Rooms. Push to talk now says what to do in a game: voice activity keeps working while you play, with a "Use voice activity instead" link.

### Fixed
- Sheets: text that looks like a formula (typed as text) stays text when the sheet is downloaded as Excel or CSV, instead of turning into a formula there.
- Sheets: a change arriving from someone else for a cell below the bottom of your sheet (or on a tab you didn't have yet) could stop your editor; the sheet now grows to fit, and a new tab's cells appear once the tab does.
- Chat: a workspace sheet holding form answers (other people's words) now counts as outside content in a workspace chat, like a web page, so it can't make the chat change things on its own.
<!-- P Maps offline (maps-offline) -->
- P Maps (Android): your speed on the driving screen now turns red when you're over the road's speed limit. It never did, because the limit was read the wrong way.
- P Maps: ending a trip from the car (or by voice) now closes the phone's driving screen instead of leaving a map with no trip.
- P Maps (Android): Back while the driving screen's Add stop list is open now closes the list (or goes back to the kinds of stop) instead of leaving the driving screen.
- P Maps (Android): the driving screen no longer restarts its trip when Android rebuilds it (the phone switching to dark mode at sunset, or reopening it after Android closed it in the background), mid-drive or after you've arrived.
- P Maps: the map's "© OpenStreetMap contributors · Protomaps" credit is stored so no app can show it garbled as "Â©".
- Android Auto: release builds only talk to Google's own car hosts.
- P Maps (Android): "Save where I parked" with no signal is no longer lost: it's kept on the phone and saved to P Maps when there's signal, with the time you parked (a place saved since, on the web or another phone, isn't overwritten). The car's own parking note and the timeline's work the same way.
<!-- Calls (voice channels), WP-V4 -->
- Rooms: making a new room without a topic failed ("Couldn't create the room").

## [0.32.1] - 2026-11-09

### Fixed
- Apps opened inside Promptly keep Promptly's menu, in a browser and in the installed Promptly window: Passwords now shows Promptly's navigation beside your vault (a menu button on a phone), and Rooms, Mail, Calendar, Maps and Photos on a phone, and Photos and installed-app pages on a big screen, no longer leave you with no way back. Only an app installed on its own (or the browser extension) shows just that app.

## [0.32.0] - 2026-11-09

### Added
- Notifications: quiet hours for all of Promptly (Account → Notifications), with start and end in your own time zone and different times on Friday and Saturday nights if you like. Notifications wait and arrive together when quiet hours end; calls, Calendar reminders, item reminders, Passwords and admin alerts always get through. Rooms and Mail can go in a daily summary instead, one push of counts at your Today summary time. And you can block someone from their profile or your 1:1 conversation: neither of you can message the other one-to-one, you get no notifications about what they do, and they aren't told. Account → Blocked people lists them, with Unblock.
- `scripts/stack.sh` (and `scripts/stack.ps1`) runs a separate copy of Promptly for a worktree on its own port (`up`, `down`, `ls`, `e2e`), with its own containers, images, data and throwaway secrets, so testing a branch never touches the main app.

### Fixed
- Mail: a very large or tangled HTML email could still tie up the mail worker for minutes while it was cleaned. Cleaning now stops after 3 seconds, and an email it can't finish shows as plain text, with a note saying so. Sending works the same way, so a draft like that no longer holds up the app.
- Workspaces: two board edits close together (adding a card, then dragging it to Done) could leave the board's text in chat search out of date, because both tried to create the workspace's Boards folder at once and one crashed. Making a workspace folder is now safe when two requests race, for every folder kind.

## [0.31.0] - 2026-11-08

### Added
- Passwords: once the Firefox add-on is signed by Mozilla, Install apps offers it with one click from your own server, and it updates itself. `passwords/extension/sign-firefox.mjs` does the signing.
- Passwords: a passkey PIN, asked every time you sign in with a passkey or make one, in the browser extension and on Android. You choose it the first time, it syncs to all your devices, and it can be changed in Settings. Five wrong in a row lock the vault until the master password.
- Passwords: "Find stray passwords", in Security check, finds passwords, keys, Wi-Fi passwords, recovery codes and 2FA setup keys left in plain text in your own Mail, Files and Photos. "Save to vault" fills in a new item, then offers to move the original to Trash; "Ignore" hides one for good. It runs when you ask and checks new mail and files hourly.
- Passwords: aliases on your own domain. Point a domain you own at your mail provider with a catch-all, add it in Passwords → Aliases and run the check, then make a different address for each login from the item editor or the extension's Generator, which fills it into the sign-up form.
- Mail: an email sent to one of your aliases says which alias and links to its login, warns when the sender doesn't look like the site, and lets you turn the alias off, which moves its new mail to Trash or a folder you choose.
- Mail: a reply to mail that came to an alias goes out from that alias, when your provider allows it, and says so when it doesn't.
- Passwords: "Remind me" on IDs, licences and cards with an expiry date puts an event in Calendar and/or a task in Tasks, with a heads-up some weeks before. It moves when the date changes and goes when the item is deleted. Off unless you turn it on, and it says that the wording and date go on the server.
- Passwords: the Security check lists what's expired or expiring in the next three months, worked out on your device.
- Passwords: breach alerts for your email addresses, from Have I Been Pwned. An admin adds a paid HIBP key in Admin, Passwords; each person turns alerts on for themselves on the Security check, which shows the breaches each address is in and the change helper for logins at those sites. New breaches arrive as a notification.
- Passwords: Security check lists "Accounts not in your vault", sites your own email says you have an account with and no login for, worked out on your device. Each has Add login, Not an account, and Delete account, which links to the site's deletion or account page (from JustDeleteMe's list of over 6,000 sites) and opens a ready-to-send deletion request in Mail as a draft.
- Passwords: each login has a match setting: Auto, Same domain, Exact host, Exact host and port, Starts with, or Never. Set it in the item editor on the web, in the extension and on Android. Each website can still have its own.
- Passwords in the browser: open tabs on your other browsers, sending a tab to another browser or your phone, synced history (off until turned on) and a reading list, between Chrome, Firefox and the others, end-to-end encrypted. Turn each on under Settings, "Sync with this browser"; the panel's Browse section and the vault's Tabs and history screen show them.
- Passwords in the browser: choose how long the vault stays unlocked, from 1 minute to 12 hours, when the browser closes, or never, in the toolbar panel and in Settings.
- Passwords on Android: security emails on the Security check, matched against your logins on the phone.
- Passwords on Android: a change-password helper from the Security check, with a queue, a new password that waits until you confirm it, and autofill that offers the current and new password on the site's change form.
- Passwords on Android: the generator makes a plus-address and can have Mail label what's sent to it.
- Passwords on Android: move a document from Files into an item, with an offer to bin the original and a Calendar reminder that says nothing about it.
- Passwords on Android: saving your Promptly login when you make a vault, with the warning about your kit.
- Passwords on Android: codes and sign-in links from Promptly Mail on the fill sheet, if you turn them on. Only the site's own sender gets a row, nothing fills until you tap it, and a phone connected earlier can add what it needs from Settings.
- Passwords on Android: an Activity screen, and an opt-in to post coarse counts to your Today page.
- Passwords: the extension's own passkey window opens when a site asks for a passkey you have here, without needing a click, and it offers them from the toolbar panel and the on-page menu when a site asks quietly.
- Passwords on Android: import from LastPass, 1Password (.1pux), Proton Pass, Dashlane, KeePass (XML and KDBX, with its password), Credential Exchange, Aegis, 2FAS and Google Authenticator links on the phone itself, with limits so a hostile file can't hang or exhaust it.
- Passwords: the extension's toolbar button opens a full control panel: this site's logins, categories, live 2FA codes, a generator, bookmarks and shortcuts.
- Passwords: a Bookmarks screen in the vault, on the web, in the extension and in the Windows app.
- Passwords: the extension can keep your bookmarks the same in every browser, end-to-end encrypted in your vault.
- Passwords: email codes and sign-in links in the extension's toolbar button, which is how Firefox gets them.
- Passwords: on Windows, typing a login copies its 2FA code afterwards, and Ctrl+Alt+Enter types the code.
- Passwords: big attachments save straight to a file on Chromium browsers.
- Export my library has its own step for saving an encrypted copy of your vault.
- Passwords (preview): the end-to-end encrypted core. Your vault is locked by your master password plus a Secret Key only your devices hold, so a stolen database or backup can't be guessed open.
- Passwords (preview): the web vault at /passwords, on its own page with a stricter security policy: onboarding with a printable recovery kit, logins, cards, identities, notes, keys and documents, 2FA codes, generator, search, folders, tags, history, Trash, offline use, and new devices approved with safety words.
- Passwords (preview): import from Chrome, Edge, Firefox, Google, Bitwarden, 1Password, LastPass, Dashlane, Proton Pass, Apple Passwords, KeePass, Credential Exchange, Aegis, 2FAS and Google Authenticator, all read on your device. Encrypted export, a Security check with breach lookups through your server, and encrypted attachments.
- Passwords (preview): a browser extension for the Chrome family and Firefox: popup, inline menu with anti-clickjacking checks, multi-step sign-ins, save and update prompts, teach-it-once site rules, 2FA codes, side panel, and passkeys that sync.
- Notifications: a Passwords switch for new-device requests and shared-vault invites. They never carry anything from the vault.
- Passwords: a Windows app with quick search, auto-type, Windows Hello, scheduled encrypted backups and an optional SSH agent.
- Passwords: codes and sign-in links from Promptly Mail in the fill menu, if you turn them on. The server isn't told which page you're on.
- Passwords: Security check now raises security emails against your logins, warns about what could lose your vault, merges duplicates, and walks you through changing passwords one at a time.
- Passwords: move a document from Files into the vault, with a Calendar reminder that says nothing about it; plus-address labels in Mail; a coarse count on Today if you opt in; vault devices in Account; admin policy in Admin.
- Passwords: travel mode, a short PIN on the extension and Windows app, unlock with a passkey on the web, fill on page load for logins that ask, and scanning a 2FA QR code off the current tab.
- Passwords: shared vaults with safety words, roles, and a new key when someone's removed, plus a list of the passwords they could read.
- Passwords: Secure Send, a link with an expiry and a view limit for someone with no account. It can be posted in Rooms or sent by Mail.
- Passwords: emergency access, where a trusted contact can ask for your vault and it opens after a wait unless you refuse.
- Passwords (preview): Promptly for Android gets the vault too: autofill in apps and browsers that support it, passkeys through Credential Manager, fingerprint unlock, sharing, Security check, attachments, import and export, and adding a device by QR code.
- Passwords (preview): a fresh review of the crypto, the extension, Android and the server's access rules. Trust in other people's keys now lives in your own encrypted vault, removing someone from a shared vault can't be blocked by them, and imports can't plant internal items. `passwords/SECURITY.md` says what it still doesn't defend against.
- Passwords on Android: a guided setup after your first unlock turns on autofill, passkeys and Chrome's autofill setting, and a new vault offers to make a Family vault when others are on your Promptly.
- Passwords on Android: warns before filling on a site that only looks like one you have a login for, in autofill and Credential Manager. Such a page gets no ordinary suggestions, and "Don't fill" comes first.
- Passwords on Android: the same warnings as the web vault about what could lose your vault, a recovery kit check, and a reminder every three months to save an encrypted export, right from the reminder.
- Passwords on Android: filter by tag, rename and delete folders, site icons you can turn on per vault, merge logins saved twice, and the passkey directory in the Security check.
- Passwords on Android: Sends show their name and can copy their link again, or post it in Rooms or by Mail. Name an emergency contact and ask for access from the phone. A dropped attachment upload picks up where it stopped.

### Changed
- Passwords: the browser extension and the Windows app are now version 0.2.0, with the Passwords changes in this release.
- Passwords on Firefox: clicking a login in the menu under a login box opens the toolbar panel with it at the top, ready to fill with one more click, and the save bar's button opens the panel to save. Before, the menu and bar there only said to use the toolbar.
- Passwords: a site is told you were verified only after the passkey PIN, not just for an unlocked vault and a click, and Android asks for the PIN instead of a fingerprint before using a passkey.
- Passwords: logins for different services on one domain stay apart. On zyx.example.org only the zyx login is offered, and the abc.example.org one is listed under "Other logins for example.org". A login saved at a site's sign-in host, like accounts.example.com, still fills across the domain.
- Passwords: a login saved with no port now fills on any port of the same host, such as nas.home:5001 or 192.168.1.10:8443. One saved with a port fills only on that port.
- Passwords: on a site that only looks like one you have a login for, the toolbar panel and the menu under a login box now say so plainly, and still offer nothing.
- Passwords: a new login on one service of a domain is saved beside the login for another service there, never over it, on Android too.
- Passwords: the panel's Bookmarks section is now Browse, with bookmarks, tabs, the reading list and history.
- Passwords: Settings is grouped into Locking, Filling, Clipboard and Appearance, with password, keys and recovery folded away.

### Fixed
- Passwords in the browser: on your own vault's pages, the extension no longer offers to save your master password, Secret Key or PINs as a login, and no longer opens its menu over those boxes and the page's buttons, even before the extension is connected (it used to cover Create vault).
- Passwords: a Windows checkout could change the line endings of the signed autofill rules file, so its signature no longer matched. Git now leaves that file's bytes alone.
- Passwords: your devices now decide for themselves which vault is your own, instead of going by what the server calls it, so a server can no longer pass a shared vault off as your personal one. Your devices mark your own vault on their next sync.
- Passwords: removing an emergency contact now holds on all your devices, and emergency access no longer covers vaults that other people's logins are in.
- Passwords in the browser: the unlock PIN's five-try limit can't be got round by sending many tries at once, new PINs need 6 to 12 digits, a shorter old one is flagged to change, and a PIN stops working 8 hours after the vault locks.
- Passwords in the browser: site rules are only taken from your own vault, not from a shared vault someone else can write to.
- Passwords in the browser: a copied secret whose timed clear fails is tried again instead of being left on the clipboard.
- Passwords in the browser: a key press in the menu under a login box counts only once a row has been selected for a moment.
- Passwords: the per-address limit on wrong vault unlock tries now works.
- Passwords on Android: saving from an app only offers to update a login saved for that same app, signed with the same certificate.
- Passwords for Windows: the app's pages are kept more tightly to the vault on your own server, and the Windows app's PIN needs 6 to 12 digits.
- Passwords in the browser: the menu under a login box now opens on the password step of sign-ins that show it in the same page, the way the big account providers do, and on any box the page focuses by itself before the extension is ready. Clicking a box that already has focus opens it too.
- Passwords in the browser: fewer wrong offers. An email box elsewhere on a page no longer counts as a sign-in because of a Log in button above it, nothing behind an open dialog is offered, and strength testers, webhook secrets and Wi-Fi settings pages aren't treated as logins.
- Passwords in the browser: better at login screens of self-hosted apps (NAS, home automation, hypervisors, routers, dashboards), arrow-only Next buttons, buttons named only for screen readers, and see-through submit buttons laid over styled ones.
- Passwords in the browser: on a change-password form, the confirm box is the one whose label says so, and a card's security code is found from the words beside it.
- Passwords in the browser: with a passkey saved for the site, the panel now says to press the site's own button, such as Continue, rather than that the page isn't asking for one.
- Passwords on Chrome and Chromium browsers: a copied 2FA code, or the timed clear of a copied secret, could be lost because the extension's hidden clipboard page closed too soon.
- Passwords: the menu under a login box fits its rows, so it no longer leaves an empty dark block over the page, and an ordinary click on a row fills straight away. A click that comes as the menu opens is still ignored, now 0.3 s instead of 0.5 s, and the note says why in plain words.
- Passwords in the browser: changing the master password, Secret Key or key settings in the vault page keeps the browser's lock working, and the Lock button works even when the server doesn't answer.
- Passwords in the browser: a page that fills on load no longer postpones the lock timer.
- Passwords in the browser: using a passkey no longer asks for the master password. An unlocked vault and a click are enough, unless the item is marked to ask.
- Passwords: keys are sealed to an emergency contact only after you've compared safety words with them.
- Passwords on Android: adding an emergency contact shows their safety words first, and a contact whose words aren't compared gets no keys.
- Passwords on Android: a fill sheet that's open when the vault locks goes back to asking for the unlock, and can't fill from what it was holding.
- Passwords on Android: a code from Mail asks first on an http page, or one whose scheme isn't known, as a login does.
- Passwords on Android: a password-protected Bitwarden file can't ask for more key-derivation work than the phone can give, and two imports can't run those at once.
- Passwords on Android: updating a password no longer leaves an old new-password waiting that could overwrite it later, and "No, keep the old one" keeps it in the history.
- Passwords on Android: connecting the phone again for email only accepts the vault's own account, and keeps the old connection otherwise.
- Passwords on Android: security alerts name the sender's domain, not the name the email gave itself.
- Passwords on Android: a bad 2FA secret from an import says so when filling, instead of crashing.
- Passwords on Android: merging duplicates keeps the dropped copies' passwords, and any waiting new password, when the history's full.
- Passwords on Android: approving "connect this phone again" in the browser still works if going there locked the vault.
- Passwords on Android: a different file with the same name and size no longer mixes with an interrupted upload, and Files only offers to bin the original once the vault's copy has been read back.
- Passwords on Android: the recovery kit screen can be passed if your server won't take the answer, and it no longer takes over a screen you have open.
- Passwords on Android: a Send's "Copy link" only offers a real link to that Send, from your own vault.
- Passwords on Android: an import with a huge CSV header or a huge number in it is refused or ignored rather than hanging the app.
- Passwords on Android: a password change in progress could be lost if the vault was still opening when the screen came back.
- Passwords: importing a large KeePass file no longer gets passwords wrong after the first few KiB of protected values.
- Passwords: a LastPass row with only a name no longer turns the next login into a note.
- Passwords: passkeys imported from Bitwarden now work: their ids are converted to the form sites use.

## [0.30.0] - 2026-11-08

### Fixed
- Claude 5 models (Opus, Sonnet, Haiku and Fable 5) weren't recognised as thinking models when the provider's model list didn't say so, so a short reply could come back empty after the thinking used up its length limit.
- Memory: Undo on a fact that had been changed deleted it. It now puts back what it said.
- Memory: temporary chats could write to memory. They can't any more.
- Mail: an email with crafted HTML (for example thousands of unclosed `<img` or `<script` tags) could tie up the mail worker for minutes per megabyte. Its HTML is now cleaned in linear time, with the same result as before.

### Added
- Memory: learns from whole chats once they go quiet, instead of a filter on each message that missed most of what people say. "Remember this" and corrections still apply straight away. Health and other sensitive details wait for your approval.
- Memory: the AI can search your past chats. Temporary chats and chats with memory paused stay out.
- Memory: facts are found by their exact words as well as by meaning, so names and numbers like "Parcel 7534" work, even with no embedder.
- Memory: facts have dates and history. A fact can end on a date, what it used to say is kept, and one that's no longer true is retired where you can restore it. The limit goes from 200 facts to 2,000.
- Memory: a project's facts stay in its workspace, while who you are applies everywhere.
- Memory: nightly upkeep retires what's over, merges duplicates, and writes a short profile from your facts that's always in front of the AI.
- Memory: "my wife" finds facts about Alex, using the names in your Contacts and Photos.
- Memory: optionally learn from Mail, Calendar and Health. Off by default, one switch each, and everything is a suggestion you approve, with a link back to where it was found.
- Memory: a button to go back through the last 90 days of chats, and a scorecard (`scripts/memory_scorecard.sh`) that measures how well it remembers.
- Mail: select several emails to act on together. Ctrl-click picks them one by one, Shift-click picks everything between two, and Ctrl+A picks the whole list. Delete, archive, label, snooze, star or mark them from the bar above the list, by right-click, by key, or by dragging them.
- Mail: Mark all as read, by right-clicking a folder, a label, an email or the list. It covers everything unread there, including what hasn't loaded yet.

## [0.29.0] - 2026-11-06

### Changed
- Mail: on Gmail, Archive now holds everything you've ever archived, and search reaches it, because All Mail is copied in gradually without downloading or showing anything twice. Archiving, deleting or moving an email in Gmail's own app is followed here too, instead of the email disappearing from Promptly.
- Mail: copying older mail stops at 1 GB a day per mailbox and carries on the next day, well short of Gmail's 2500 MB limit, which would shut off your mail for a while. Set `MAIL_BACKFILL_BYTES_PER_DAY` to change it.
- Mail: on Gmail, a label called Archive is now just a label, and archiving goes to All Mail.

## [0.28.1] - 2026-11-06

### Fixed
- Mail: on Gmail, what you archive now shows in Archive. It went to All Mail, but Archive only looked for a folder called Archive, so it always looked empty.
- Mail: a delete or archive now goes through as soon as you open another view or leave the app, instead of waiting out the undo time. Closing the app in those 5 seconds used to lose it, and Trash looked empty if you went straight there.
- Mail: a conversation that's only in Sent or Drafts can now be deleted or archived. Nothing used to happen, and it came straight back.
- Mail: an old label that's only called Trash or similar, like Gmail's [Imap]/Trash, is no longer mistaken for the mailbox's real one.

## [0.28.0] - 2026-11-06

### Fixed
- Mail: moving an email again before the first move has synced, or undoing a move straight away, now reaches your mailbox too. It used to stay at the first place in Gmail while Promptly showed the second.
- Mail: an attachment no longer says it's been deleted while its email is moving between folders, or after it was moved from another device: Promptly now looks for it where it's coming from, and offers Try again.

### Added
- Mail: labels nest. A label inside another (Homes/Lot 7534, as Gmail keeps them) sits under its parent and folds away with it, and Manage labels can put one inside another, taking what's inside it along.

## [0.27.1] - 2026-11-06

### Fixed
- P Maps no longer sits on "Finding your location" forever: a rough position gets the route going while GPS searches, a phone that can't give a location says why with Try again, and the Android app (1.4.4) now hands the map its location itself.

## [0.27.0] - 2026-11-06

### Added
- Apps: Edit now lists the apps in your sidebar so you can drag them into the order you want, instead of unpinning and pinning them again.

## [0.26.1] - 2026-11-06

### Fixed
- AI search no longer counts photos, videos and other files it can't read under "Text & other files", which could add thousands to its total and slow indexing down.

## [0.26.0] - 2026-11-06

### Added
- Android Auto: tapping a place now shows the route on the map with time, distance and other ways there, and a big Go button, instead of setting off straight away. Home and Work are one tap from the map.
- Mail: quick actions on each email as you point at it: archive, delete, mark read or unread, snooze.
- Files: a Select all checkbox on the list and in the selection bar, so a folder like Chat Uploads or Generated Files can be cleared in one go. It covers the whole folder, including what hasn't scrolled in yet.

### Fixed
- Android Auto: a route that can't be found or a missing GPS fix now says so on the car's screen instead of doing nothing.
- Android Auto: places have icons, distances and addresses, lists use as many rows as your car allows, search works as you type and looks near you, and ending a trip asks first.
- Mail: a deleted or archived email no longer flashes back when the undo time runs out.
- Mail: a mailbox's labels and folders now get their mail even if one folder is too big or has a problem: mail is copied in small batches that pick up where they left off, a failure in one folder doesn't stop the others, and a label still being fetched says so.
- Trashing only system folders no longer says "Moved 0 items"; it explains what to do instead, and Ctrl+A leaves system folders out.
- P Maps no longer asks where you're starting from when you tap Directions before your phone has a location: it waits for the location and shows the route. It only asks if location is turned off.

## [0.25.0] - 2026-11-05

### Changed
- New installs have P Maps on by default, building its map data in the background (`--no-maps` / `-NoMaps` to skip it). Existing installs keep their settings.
- The Photos date scrubber is rebuilt: a marker shows where you are, every year gets readable room, dragging follows smoothly, the wheel works over it, and the browser's scrollbar no longer sits underneath.

### Fixed
- `install.sh` no longer stops with an error before printing the setup code when it can't work out the machine's network address. The README now gives the right minimum Docker Compose version (2.24).

## [0.24.0] - 2026-11-05

### Added
- Health: attach a blood test or other health document in the Health app's AI chat or a normal chat, and every result is logged on the date and time it was collected, with the report's own units and ranges. Scanned reports and photos work too, and sending the same report twice doesn't log it twice.
- Any app's AI chat can now take attached files.
- Android app crashes now reach your server: see them in Admin → Console → Errors, grouped, with the app version and device, including crashes in native libraries and times the app stopped responding. The app's assistant settings list them too. Admins get a notification when a crash is new, or back after being resolved.

### Changed
- The assistant only listens when you ask: press the button in P Maps or on the car's screen, or use your phone's assistant gesture. The button is on the car's screen when you're not on a trip too.

### Removed
- The always-on "Hey Promptly" wake word, its background microphone service and its setting. It could turn your music down on a false alarm during a drive.

### Fixed
- The phone assistant's sheet no longer brings a background sliding up the screen with it.
- A background traffic or location-sharing check that goes wrong can no longer take a drive down with it.

## [0.23.0] - 2026-11-05

### Added
- Mail: connect any IMAP/SMTP mailbox (several if you like) and read, search, file and send from one calm terracotta app, with undo send and an AI to ask. Switch mailboxes from the menu at the top left, gather mail under labels, and right-click (or press and hold) an email to make a rule that files it and future ones like it. Labels work like folders: drag an email onto one and it moves out of your Inbox. Your mailbox's own folders and Gmail's labels show as labels too, and moves stay in step. Open any attachment in a viewer, and choose which mailbox Ask looks at.
- Mail: reply all, forward, attachments, Cc and Bcc, formatting, drafts that wait for you, address suggestions, and undo send that brings back what you wrote.
- Mail: AI search, on or off for all of Promptly from Admin → Models → Defaults (automatic: on with a local indexing model, off with a cloud one).
- Mail: optional AI sorting with "Needs a reply" and one-line summaries using a model you choose, plus AI drafts you review before sending.
- Mail with the rest of Promptly: answer invites with Yes, Maybe or No, add any email to your calendar, ask about your email in Chat and on the phone assistant, save attachments to an Email Attachments folder and attach from Files, turn email into tasks, a Mail card on Today, contact names and pictures on your mail, and mail in Ctrl+K.
- Mail: snooze, phone swipes, notifications, mailbox settings, older mail coming in gradually, and Proton Mail Bridge support.

### Changed
- Search now finds chats by their name, and matches the word you're still typing ("budg" finds "budget"), in chats and in mail.
- The sidebar has one search box just under New chat, the same search as Ctrl+K. The separate message search and the Chat link are gone, since New chat does the same job.

### Fixed
- P Maps: directions now follow the GPS once a second. They were asking for battery-saving location, so the position barely moved while driving.
- P Maps: your location starts again when you come back to the map, and it says so if location permission is off instead of waiting forever.
- Quick add: a time you type now beats a part of the day, so "tomorrow morning at 8am" means 8:00 rather than 9:00 with "at 8am" left in the title, and "this evening at 8" means 8 pm. This applies to Tasks, Calendar and Ctrl+K.
- The phone assistant now slides up as a panel over what you're doing, instead of flashing a full-screen window first.
- The phone assistant now answers in the voice chosen in your account, and only uses the phone's own voice if your server can't be reached.

## [0.22.0] - 2026-11-04

### Added
- **Promptly as your phone's assistant**: choose Promptly under Android's Default apps → Digital assistant app, and the assistant gesture opens a small sheet that listens, thinks and answers out loud, with or without a trip running.
- The assistant can set timers straight away and alarms after a spoken or tapped yes, open your Promptly apps, start directions, open the dialler for a contact or number, and start a text message. You always press call or send yourself.
- Optional **"Hey Promptly" anywhere**, off by default, for phones with Promptly as their assistant.
- `POST /api/assistant`, with its own app password scope `assistant`. Phones already linked keep working.

### Changed
- The older `POST /api/maps/assistant` now needs the `assistant` scope too, so a maps-only app password can no longer reach your calendar and files through it.

### Fixed
- P Maps no longer drives a chosen route twice when a trip starts from a named place like Home: it added about 150 km to an 82 km trip.
- Muting P Maps' voice now stays muted, between trips too, until you turn it back on.
- P Maps on the car screen opens on your location instead of the whole world, and follows the car's light or dark setting.
- The Promptly phone app no longer offers server updates when it was installed from Google Play, which keeps it working in Android Auto.

## [0.21.0] - 2026-11-04

### Added
- **"Hey Promptly" while driving** in P Maps: say it (or just "Promptly") and ask for a stop, a change of destination, your arrival time or whether your way is clear. The wake word is heard on the phone and no sound leaves it until then; what you say next goes to your own server. Speech from the car uses a mic button on its screen. An on-screen button turns listening off.
- **Nearby in P Maps**: fuel, food, coffee, groceries, chemists, toilets, parking, ATMs and places to stay around you. Searching for "fuel" or "the nearest servo" finds them too, including in chat and in the car. All from the map on your own server.
- **Stop on the way**: on a route, on the driving screen and in the car, see what's along the road ahead and how long each adds, and add it as a stop, with a button to take it off again.
- Admin → App settings warns if P Maps' last data update failed, if its data is overdue for its monthly refresh, or if its street address download failed and search has no house numbers.
- "Hey Promptly" can use your other apps: your day, calendar, tasks, contacts, timeline and web search. Anything that would change something is read back and only happens after you say yes.
- Contacts can say who someone is on your Promptly: pick their account when adding or editing a contact, and it shows their @username.
- **Go via a road**: tap a road on the map to route along it, then "Always go this way" to make it your usual route.

### Fixed
- P Maps' route panel on a phone: Start is always on screen, routes take less room, avoid and usual-route settings moved under Options, and Add stop becomes a full panel above the keyboard so results aren't hidden.
- After restoring a backup, photo and video thumbnails are now remade automatically instead of staying blank, and doing so keeps any dates and places you corrected.
- The full backup now includes `nginx/ssl`, `nginx/local` and `docker-compose.override.yml`, and `--with-env` restores them.
- P Maps' Live location now suggests people on your server as you type, and its Share button no longer gets cut off.
- P Maps' map build keeps retrying and resuming the 1.9 GB address download, so a dropped connection is less likely to leave search without street addresses.

## [0.20.0] - 2026-11-04

### Changed
- P Maps' traffic layer is now off until you turn it on, turns itself off after 10 minutes, and only loads when zoomed in. Your route always shows its own traffic. The layer has its own daily limit, so browsing can't use up traffic for a drive.
- The Photos and Places maps now use your server's own map, with street and place names, and no longer fetch anything from OpenFreeMap. Without the `maps` profile they show countries only.
- Addresses in Calendar, Contacts and Trips, and a photo's location, now open in P Maps instead of Google Maps or OpenStreetMap. The Android app now needs Android 10 or newer.
- **Today is now a full dashboard.** Medication due now, with Take and Skip right there. A **Schedule** with everything timed today in order (events, doses, appointments, timed tasks, shifts, workouts) and a "now" line. **Needs you**: due doses, overdue tasks, bills, today's appointments and birthdays, messages, failed automations. **At a glance** tiles and a progress ring for the day. New cards: Food and water (quick-add water), Body & Health (log weight and mood), Budget and bills, Next trip, Flashcards, Journal, People, Coming up (the next seven days across every app) and Automations. Everything is in Customise, and the layout fills wide screens.
- Today shows trends: spike graphs for 14 days of calories and protein against your targets, sleep, steps and other daily goals, and a 30-day weight line with the change.
- The desktop sidebar stays as you left it, saved to your account. Files and workspaces no longer collapse it for you.
- Rooms opens on Messages (your DMs) — on a computer, at your latest conversation. Spaces are one tap away.

### Added
- **P Maps**, a new app for maps and directions where nothing goes to Google: search addresses, places and your contacts; Home, Work, favourites and lists; car, bike and walking routes with alternatives; multi-stop trips you can drag to reorder or put in the best order; avoid tolls, highways or ferries; where you parked; and charging stations by plug and power, on the map or along your route. All the map data lives on your server, in an optional `maps` Docker profile that downloads Australia's data and refreshes it monthly.
- **P Maps driving screen** in the Promptly Android app: turn-by-turn with voice that keeps going with the screen off, automatic rerouting, your speed against the limit, and speed camera warnings. It reads the phone's GPS directly rather than Google's location service.
- **P Maps on Android Auto**: the map and turn-by-turn on the car's screen, with your saved places and a search, and it notes where you parked when the car screen goes away. This needs Unknown sources turned on in Android Auto's developer settings.
- **P Maps timeline**: an opt-in, private history of where you've been, by day, with stays, journeys and your photos from the day; pause it, delete any day or all of it, choose how long it's kept, and import your Google Timeline.
- **P Maps live location**: choose someone on your Promptly to see where you are and when you'll arrive, for a set time or until you stop.
- **Live traffic in P Maps**, using a TomTom key added under Admin → App settings: "traffic adds 6 min", arrival times in current traffic, the fastest route right now listed first, busy stretches on your route, a traffic layer for the map, and the same figures in chat, on Today and on the driving screen. Your server asks by map area, so TomTom never gets your trip. Without a key, P Maps works as before.
- **Your usual routes in P Maps**: pick a route and choose "Always go this way", and it comes first between those two places even when another is a little quicker. It's followed on the map, in chat, on the driving screen and in the car, including after a wrong turn.
- **Faster route alerts while driving**: the phone and car screen offer a quicker way when traffic makes it worthwhile, with a bigger saving needed to leave your usual route. Traffic delays and arrival times now show on Android Auto, and slow stretches of your route are coloured while you drive. Start now drives the route you picked.
- **Warnings and closures in P Maps**, from TomTom: crashes, closed roads, flooding, roadworks and other hazards on your route, shown on the route, spoken and shown while driving, and in chat and on Today. Routes go around closed roads, including your usual way, and the driving screen offers a way around a closure ahead. A place's More details button adds its hours, phone and website; it names that place to TomTom, so it only happens when pressed.
- Today shows when to leave for your next event, and where you parked.
- **Maps in chat**: ask any chat for distances, directions, places or chargers, and the reply carries a map chip that opens the trip in a window. Ask about your timeline too: "when was I last at Bunnings?", "where did I go on Saturday?". Timeline answers are refused on a turn that read outside content.
- Saved places in P Maps always show on the map. Save lets you choose a name, icon and colour; Home and Work have their own icons, and the Home and Work buttons show when a place is set and ask before replacing it.
- Your timeline draws the day's journeys and stops on the map.
- Body & Health, Macros and Workout share your body details: sex, date of birth (or birth year), height and units are set once and fill in all three — change them in any of those apps, or in Account → About you → Body, and the others follow. Private to you: files shared with you are never touched. What the three already held is merged the first time you open one of them.
- One weight log across Body & Health, Macros and Workout: a weigh-in added, changed or removed in Health or Macros shows in the other, and Workout's body weight follows the newest one (changing it in Workout logs today's weigh-in).
- Macros and Meal Plan share your diets, allergies and dislikes: set them in either and the other follows (anything one already had fills the other's gaps the first time).
- Currency is one setting: change it in Account, Budget or Trip (the default for new trips — each trip keeps its own) and the others follow.
- Account → About you → **Units & time**: Metric/Imperial and Automatic/12-hour/24-hour for every app. New app files start with them, changing them updates Trip, Body & Health, Macros, Meal Plan and Workout, and Calendar shows times in your chosen format. Trip's own 12/24-hour switch is the same setting.
- Calendar can show your Health appointments (Also show → Health appointments), at their time in your time zone, with a link back to the Health app. Only your own Health file is read.
- Person fields in Trip, Board Games and Health suggest your Contacts and Promptly people as you type. Trip travellers remember the contact and account they were picked from, and Health's emergency contact and care team fill in phone, email and address from the contact card.
- New trips reuse your passport country and passport details from your last trip, and Board Games starts with your account name instead of asking for it.
- Phone backup in Photos: Photos settings (and More → Phone backup on a phone) has "Set up backup on this phone", which links the Promptly Android app in one tap, and "Open backup settings". On a computer it points to Files → Devices.

## [0.19.0] - 2026-11-03

### Added
- **Promptly for Android**: one app for Android phones. It puts Promptly on your home screen and lets you pick which other apps get their own icon (P Photos, P Rooms, P Calendar, P Contacts, P Budget, P Habits, P Journal, P Workout, P Cards, P Games, P Health, P Meal Plan, P Macros, P Trips, P Tasks), each opening full screen with notifications, all in terracotta. Get it from Apps → Install apps on an Android phone; "Set up the app" connects it to your server and pre-ticks the apps you already use. Long-press Promptly for Choose apps, Change server and Photo backup. The normal web-app installs still work.
- Photo backup now lives inside Promptly for Android (long-press Promptly or P Photos → Photo backup); on the phone itself, Files → Devices → Add device offers "Set up backup here" instead of scanning.
- Each app has a fixed address, `/app/open/<app>`, that opens your copy of it as its own app.

### Fixed
- P Maps' traffic button no longer overlaps the other map buttons.
- Resuming a big upload after a name clash ("Choose file to continue") started again from the beginning instead of carrying on.

### Removed
- The separate PromptlySync app download — photo backup is part of Promptly for Android now. Uninstall PromptlySync and re-link backup in the new app.

## [0.18.2] - 2026-11-03

### Fixed
- Installing Rooms, Calendar, Photos or an app (/app/…) could install Promptly again, or say it was already installed, in browsers that only read the page's first manifest. The server, and the installed app's offline worker, now hand each of those pages its own manifest from the start.

## [0.18.1] - 2026-11-03

### Changed
- Apps pinned to the sidebar now use simple line icons that match the rest of the menu. Apps → Edit has a "Sidebar icons: Simple / Colour" switch to bring back the colour app icons.

## [0.18.0] - 2026-11-03

### Added
- Today is customisable: a Customise button picks which cards show (Calendar, Tasks, Habits, Workout, Meals, Workspaces, Unread rooms, On this day, Recently opened, Morning summary) and the order they come in, saved to your account.
- Admins can lock a member to one model (Admin → Users → Model access → Locked): they see its name with no model picker, and groups can't add more.
- First sign-in asks new members which extras they want in their sidebar (Places, Workspaces, and Automations if allowed); the same switches stay in Account → Sidebar features.

### Changed
- Automations are off by default and turned on per account by an admin (Admin → Users → Automations). Admins always have them, and anyone who already owns an automation keeps them on. With them off, the sidebar entry and "New automation" buttons are hidden, saved automations don't run, and the page keeps just Commands, Prompts and History.
- Today's Workspaces card now holds everything My work did: today's shifts, the week's coming shifts, every open card assigned to you (overdue first, "Show all"), and the shifts calendar link.
- New members start with Places, Workspaces and Automations hidden from their sidebar.
- Custom models show under "Internal" by their own name only — no "Custom" badge, no "Based on…" line, and members are no longer sent which model one runs on.

### Fixed
- The server could stop answering after a while: every open Rooms live feed (and discussion, admin log and chat streams) held a database connection for as long as it stayed connected, so enough open tabs and backgrounded phones used up the pool. Streams now hand the connection back before they start.

### Removed
- The My work page and its sidebar entry; old /work links open Today.

## [0.17.0] - 2026-11-03

### Added
- Ctrl+K now does things as well as searching: type "new event lunch with Sam fri 1pm", "add task buy milk tomorrow", "remind me to call mum at 5", "log $40 fuel", "note …", "new doc/sheet/slides <title>", "message sam …" or "go to calendar" and press Enter on the "Do" row to make it in place (a toast offers Open). Plain Create… actions (New event, New task, New doc, New room message…) are there too, and Tab picks which Tasks or Budget file to use when you have several.
- **Pick up where you left off** on Today: the docs, sheets, whiteboards, files, app files, chats, rooms and workspace items you opened last, newest first, one tap back to each (Clear empties it).
- **Places** (sidebar → Places): one list and map of your trip stops, where your photos were taken, event locations and contact addresses, grouped by town, each linking back into its app. Matched offline — nothing is sent to a geocoding service; places written as text Promptly can't place stay in the list only.
- **Shared tags**: one set of tags across Tasks, Contacts, Journal, Recipes, Budget, Files, Calendar events and photo albums — tag something in one app and the same tag autocompletes everywhere. Tags you already had in those apps join the set automatically.
- **Tag pages** (`/tags`): everything with a tag across your apps (only what you can still open), plus rename, recolour, merge and delete — changes reach the apps' own tags too.
- Ctrl+K search matches tags: "#home" shows the tag and the contacts, tasks and events carrying it.
- Chat reaches every app at once: ask "what's my week look like and can we afford the trip?" and it checks your calendar, tasks, bills, workouts, meals, birthdays and trips together, looks people up across Contacts and Photos, searches events, contacts, tasks, trips and recipes by name, and reads or posts in Rooms (it only reads rooms where Promptly reading has been switched on, and only posts when you ask).
- **Mention anything**: type `[[` in a doc, a room message, a chat message or a journal entry to mention a task, event, file, photo, album, contact, trip, recipe, budget transaction, person or workspace item. The mentioned thing then lists it under **Mentioned in**, with a link back (taking the mention out removes it).
- **Linked**: link any two things — a receipt or photo to an event, a task to a contact, a file to a trip or a budget transaction. Links show on both sides in a "Linked" section on events, tasks, contacts, trips, recipes, transactions, journal entries, albums, photos, files, people and workspace items, with a search across apps to add one. Only what you can open yourself ever shows in either list.
- **One Trash for every app** (account menu → Trash, `/trash`): deleted files, photos, workspaces and workspace pages, calendar events, photo albums, tasks and contacts in one list, grouped by app and searchable, with the same Restore, "Delete forever" and Empty trash everywhere. Everything is deleted for good after 30 days; restoring puts it back where it was, or at the top level when that's gone.
- Deleting a calendar event, a photo album or a contact now shows an Undo toast (events and albums used to be gone for good straight away).
- **Tasks & Reminders comes with every account**, beside Rooms and Calendar, so nobody has to add it from Get apps first (existing accounts get it too; you can still remove it).

### Changed
- Rooms reads like a messaging app: your messages sit on the right in tinted bubbles, everyone else's on the left with their name and picture.

### Fixed
- Workspace pages in a workspace's trash are now deleted after 30 days even if nobody opens that workspace's Trash panel.
- Drive's Share dialog uses the same people picker as Calendar and Rooms (accounts, your Contacts and people from your Photos).
- Meal Planner → "Open Tasks" after sending the grocery list now opens straight on the Groceries list.
- "Snooze 10 min" on an event reminder is no longer lost if the server restarts.
- Opening an emailed invitation's link no longer answers it by itself (link scanners could RSVP for you); the suggested answer is highlighted and you tap to send it.

## [0.16.0] - 2026-11-02

### Added
- **Today** (sidebar → Today): your events, tasks due, habits, today's workout and meals, "on this day" photos, unread rooms and assigned cards/shifts on one page — tick tasks and habits right there.
- One **Morning summary** push built from Today ("3 events · 4 tasks due · Leg day"); turn it on and pick the time on the Today page or in Tasks settings.
- **Person pages**: one page per person — their contact card, photos of them, plans together, your conversations and files shared between you — with Message, Invite to event and Share my calendar. Open it from Contacts, Photos, a room's members or an event's guests.
- One people picker across Calendar and Rooms: searches Promptly accounts, your Contacts and the people in your Photos, with labels like "Bea · Wife" and suggestions first.
- **Send to…**: share a Drive file or folder, photo, album, task, recipe or trip into a room or to a person as a card. It only opens for people who already have access, unless you tick "Also give everyone in the room access".
- Calendar "Also show": workouts, your meal plan, bills due, trips and public holidays for a country you pick, each with its own switch; tap one to open it in its app.
- Calendar: plan a task into a time slot — drag it onto week or day view, or tap it → "Plan a time". The event has a "Done" box that ticks the task off.
- Calendar: "Photos from this event" — your own photos taken while it was on, with "Make an album".
- Calendar: invite people who aren't on Promptly by email — they get the details, a calendar invite and Going / Maybe / Can't go links; changes and cancellations are emailed too.
- Calendar: rooms an event was planned in get a "Starting in 1 hour · N going" post (change or turn it off from the bell on the "Planned in" chip).
- Calendar: an optional second time zone beside the hours, both times for events set in another zone ("9:00 AM Tokyo time · 1:00 AM your time"), and a notice when you're travelling.
- Buttons on notifications: Going / Can't go on invites, Done / Snooze 1 hour on task reminders, Snooze 10 min on event reminders.
- Journal shows that day's events and your photos while you write — tap to add them to the entry.
- Search (Ctrl+K) also finds your calendar events, contacts and tasks.
- Trip Planner: make a trip album of your photos from the trip's dates (keeps itself up to date), and see "Spent so far" from Budget purchases tagged to the trip (Budget suggests the tag for purchases in a trip's dates).
- Meal Planner: "Send to Tasks" turns the grocery list into a Groceries list in Tasks, by aisle, updated in place when you send it again.

### Changed
- The Tasks morning digest is replaced by the combined Morning summary (no double pushes).
- Tapping a task on the calendar opens a small card (tick it off, plan a time, open in Tasks).
- Tasks and Calendar quick add share one way of reading dates, times and repeats.
- Budget: "Always for this payee" now sits at the top of the category picker, so you can switch it on before picking.

### Fixed
- App assistants (Ask Budget and the rest) no longer stop after saying what they'll do next — they carry on, and when a step fails they're told what it needs and retry. Their replies no longer run two steps' sentences together ("first.September").
- App assistants show what they're doing the whole time they work ("Finding transactions…", "Thinking…") with a running timer, instead of going quiet after their first sentence.

## [0.15.0] - 2026-11-02

### Added
- **Calendar** — a shared calendar for friends and family, in Apps (pinnable to the sidebar, installable as its own app). Private by default: you see only events on your calendars or ones you're invited to. Invite people per event (they answer Going / Maybe / Can't go), or make shared calendars like "Family" with owner/editor/viewer roles. Month, week, day and agenda views; repeating events (edit or delete just one, this-and-following, or all); reminders and invite/change/cancel notifications; a private read-only subscribe link for Google/Apple Calendar on your phone.
- Chat can read and add to your calendar ("what's on this weekend?", "add dinner at Mum's Sunday 6pm and invite Sam", "when are Sam and I both free Saturday?") — only events you can see; never on a turn that read outside content.
- "Calendar" toggle in notification settings.
- Calendar: share your own calendar with someone — your partner, family — so you're in sync ("Share my calendar"). Pick what each person gets: free/busy only (just "Busy", never what or where), see all details, or make changes. It shows next to theirs under "Other people's" as "<you>'s calendar"; they don't get your reminders. People in your Contacts are suggested first, with what they are to you from Photos ("Bea · Wife").
- Calendar: drag events to move them, or drag the bottom edge to change how long they last (week, day and month views; asks "just this one / following / all" for repeating events).
- Calendar: quick add — type "Dinner with Sam Fri 7-9pm at Mum's" and it's on your calendar (same date wording as Tasks).
- Calendar: search your events.
- Calendar: see who's free when inviting — each guest shows "Not available" for that time (never what they're doing), and "Find a time" lines everyone up on one day to pick a slot. You can still invite people who are busy.
- Calendar: your Tasks with due dates and your Contacts' birthdays and anniversaries show on the calendar (tick tasks off right there); turn either off under "Also show".
- Rooms: plan an event right in a room — everyone in it gets it on their calendar, and the room gets a card to answer Going / Maybe / Can't go (people who join the room later can add themselves). Share any event to a room from the event. A room's info panel lists its upcoming events.
- Contacts and Photos link up: link a contact to a person in Photos (or add someone from Photos to Contacts) — their face becomes the contact's picture, their photos are a tap away, and their contact card and birthday show on their Photos page.
- Workout: a Warm-up setting per exercise in the plan (Auto / On / Off, under "Rest, superset, warm-up, notes"). Auto warms up only before the first heavy compound of each movement — not before a second press after bench, or isolation lifts.

### Fixed
- Calendar: people on a shared calendar can set their own reminders for its events, answer, or take one off their own calendar (before, only invited guests could).
- Workout: warm-up sets are back in planned workouts for lifts you haven't logged yet (they went missing when plans stopped carrying weights). Before there's a working weight they show the ramp's reps (and the empty bar); type your working weight and the warm-up weights fill in.

## [0.14.0] - 2026-11-01

### Added
- Pin any app to your sidebar — Apps → Edit → tap the pin on a tile — to use it from inside Promptly without installing it. Per user; unpin the same way.

### Changed
- Rooms is back to being an app only — removed from the default sidebar menu; open it from Apps or pin it (it still shows inside Promptly with the sidebar on desktop).

### Fixed
- Hiding Workspaces from the sidebar (Account → Features) now sticks — the server was dropping the "workspaces" key and only accepting the old "projects" name.

## [0.13.1] - 2026-11-01

### Changed
- Rooms on desktop now opens inside Promptly, with the usual sidebar (and a new **Rooms** item in it, which you can hide in Account → Features). On a phone, and in the installed Rooms app, it's still its own full-screen app.

### Fixed
- Text fields across Promptly (Rooms, the Item Store apps, sheets) showed two focus outlines at once — an orange box inside their own blue highlight — because the global keyboard-focus outline overrode each field's own; now each field shows just its own.

## [0.13.0] - 2026-11-01

### Added
- **Rooms** — chat for the people on your Promptly, installable as its own app (`/rooms`): spaces (e.g. Family, The Lads) with text rooms, plus direct and group messages. Replies, reactions, edits, pins, photos and files, @-mentions and @everyone, unread counts and badges, typing indicators, message search, per-space/room notification levels, and push notifications like a messaging app's — they arrive with the app closed, show the sender's picture, stack a room's messages into one notification ("Family · #general (4 new)"), keep the unread count on the app icon, clear when you read the room, and open straight into it. Private by default: messages and attachments are never indexed or shown to the AI — `@promptly` is the only AI, and it sees just the message that mentions it unless a room admin turns on "Promptly can read this room" (a DM needs everyone's OK).
- Item Store: **Tasks & Reminders** — lists of to-dos with due days and times, reminder pushes (at the time, or minutes to a week before), repeats (daily, weekdays, chosen weekdays, monthly on a date, yearly, or N days after it's done), priorities, tags, steps and notes; a morning digest push; Today / Upcoming / Lists (drag to reorder, High priority, Completed log, search) / Settings tabs; quick add that understands plain words (“Pay rent every month on the 1st #home !3”); undo on complete and delete; works offline; the assistant can add, reschedule, plan your day and review your week, and normal chats can use it ("remind me to…"). Shared lists remind everyone who can edit them.

## [0.12.0] - 2026-11-01

### Added
- Workout: a weight step setting (Settings → Logging) — the set editor's − / + change the weight by it; 2.5 kg by default, any value to 2 decimals (follows a kg ↔ lb switch).
- Workout: a Rest timer on/off switch in Settings → Logging — off means no countdown, beep or vibration after a set.
- Workout: a Settings tab — "Your week" at the top sets what you do on each day (Rest, Upper body, Legs, Push, Pull… or let the coach decide), followed by profile, equipment, logging and reminders. Replaces the gear icon's Profile & equipment sheet.
- Workout: setup now asks which days you train and what each day is for — Upper body, Legs, Push, Pull, Full body, Cardio… or "let the coach decide" — and the coach builds your week around it.

### Changed
- Workout: in an empty workout, an exercise you add starts with no sets — tap Add set for each one you do (the first starts from last time's numbers). Planned workouts still come with their sets.
- Workout (phone): the live logger is easier one-handed — tapping a set opens the big editor instead of popping the keyboard on a tiny box; set type (Warm-up / Working / Drop set / To failure) is picked there rather than by tapping the little badge, which changed sets by accident; the weight in the editor can be typed; "Last time" with a Use button replaces the narrow Previous column, so the weight and reps boxes are wider; tapping a done set reopens it to fix.
- Workout: plans no longer contain weights — they're sets × reps. Each set in the live logger shows a small suggested weight instead (from what you've actually lifted, or a best you told it), and ticking a set without typing one uses it. A lift you've never logged gets no suggestion at all — no more guessed starting weights; the coach tells you how to find yours on the first session.

### Removed
- Workout: the "re-fit loads" banner and action (plans have no loads to re-fit; the suggestions keep up by themselves).

### Fixed
- Install apps: tapping Install inside the installed Promptly app just opened the page in Promptly's own window (where phones won't offer an install) — it now opens the page in your browser with a short how-to-install guide and a Copy link fallback.

## [0.11.0] - 2026-10-31

### Added
- **Photos — mark up a photo:** a new **Mark up** tab in the photo editor with pen, highlighter, arrow, line, circle, rectangle, text and a blur box for hiding things, plus an **emoji** picker (search and recents) and 16 built-in **stickers** (hand-drawn circle, arrows, tick, cross, speech and thought bubbles, NEW, SOLD, price tag…). Six colours, three thicknesses, undo/redo, and select to move, resize, turn or delete. The server draws the marks exactly as the editor shows them, so the grid, viewer and downloads match.
- **Photos — more ways out of the editor:** **Copy** puts the edited picture on the clipboard without saving anything. **Share** (on a phone) or **Download** gives it as a file. **Save as new photo** files a copy next to the original ("IMG_1234 (edited).jpg", same date and place), leaving the original untouched. **Close** asks before throwing changes away. You can also mark up and copy a photo someone shared with you.
- **Apps:** a new **Apps** section in the main menu. It's a launcher of app tiles you arrange yourself (drag to reorder in Edit, or long-press on a phone). Tap a tile to open the app. Apps with several files, like trips, have a switcher in the header. **Get apps** opens the Store. Everything is free, nothing is on by default, and removing an app keeps its files. Admins can hide an app from everyone.
- **Every app's data lives in Files:** under My files › Apps › <App> (a protected system folder). App files are shareable, starrable and trashable like any other file, with version history. They download as JSON and import back. Drive AI search indexes them like everything else.
- **The app view**: a phone-first layout with a bottom tab bar and bottom sheets, and a proper desktop
  layout with tabs and a side panel. Saves happen as you go. A change made on another device, by the
  assistant or from a chat is merged in rather than overwritten.
- **The assistant inside every item** ("Ask" on a phone, a side panel on desktop) works *in* the app
  through the item's own actions. It can also read your other files and, where it helps, the web.
  Every change it makes comes with one-tap Undo.
- **Item reminders**: habits, medication, trips and birthdays arrive as push notifications, with their
  own switch under Notifications.
- **Eleven items in the Store:**
  - **Workout:**
    - A tracker and coach: the assistant plans your week as sets × reps × load, using double progression and volume landmarks (no RIR or RPE to rate).
    - Program templates (Full body, Upper/Lower, Push/Pull/Legs, 5×5, Minimalist) fitted to your equipment, for when you'd rather not ask the coach.
    - A live logger with a rest timer, plate calculator, warm-ups and supersets.
    - Progression that a lifter can trust: assisted lifts progress by taking help away, weighted dips/pull-ups add plates, timed holds add time, and a lift that stalls twice resets about 10%. One PR per lift per workout.
    - Tell the coach your recent bests and the first weights come from them (with a couple of reps in hand) until you've logged the lift.
    - PRs, e1RM charts and weekly sets per muscle.
  - **Body & Health:**
    - Weight trend, blood pressure (AHA categories), glucose, sleep, symptoms and labs.
    - Medications with dose reminders, adherence and refills.
    - Appointments with visit summaries, and optional cycle tracking.
  - **Meals & Macros:**
    - A food diary with macro targets.
    - Barcode scanning and Open Food Facts lookup.
    - Describe-a-meal logging, and an adaptive maintenance-calorie estimate.
  - **Meal Planner:**
    - A recipe box with import from links and cook mode.
    - A weekly plan with leftovers.
    - A merged, aisle-grouped grocery list with a pantry and shop mode.
    - Strict allergy rules.
  - **Habits:** one-tap check-off, every kind of schedule, streaks and habit strength, weekly reviews and reminders.
  - **Budget:**
    - Up Bank sync: the token is stored encrypted, sync runs every 30 minutes, and webhooks are used when the server is public.
    - Automatic subscription and bill detection with price-change alerts.
    - Budgets with payday months, CSV import, rules and goals.
  - **Contacts:**
    - An address book plus a personal CRM: keep-in-touch rhythms, birthdays, interactions, gift ideas.
    - vCard and CSV import and export, and duplicate merging.
  - **Trip Planner:**
    - All your trips in one place: upcoming, someday and past, with duplicate and archive.
    - A day-by-day itinerary with an ideas list.
    - Bookings with correct time zones.
    - Packing lists, expenses with settle-up, documents, and check-in reminders.
  - **Journal:**
    - A writing room with templates (gratitude, CBT thought record…), moods and emotions.
    - A calendar, insights and "On this day".
    - Private by default in chat.
  - **Game Night:**
    - A pass-the-phone score pad with official score sheets for 34 games.
    - Plays log, Elo ratings, head-to-head and stats.
  - **Flashcards:**
    - FSRS spaced repetition and cloze cards with maths.
    - A swipeable study flow, import from Anki, Quizlet or CSV, and stats.
    - The assistant writes cards from your notes.
- **Items work offline:**
  - An item you've opened on a device opens again with no connection.
  - Changes are kept on the device, even if the app is closed, and save when the connection is back. A banner says when you're working from the device copy.
- **Items stay fast as they grow:**
  - Saves send only what changed.
  - Past 75% full, an item offers to move older data into an archive file next to it.
- **Undo is safer:** Undo reverses only your last change, never edits from other devices or the assistant. When the server refuses one change, only that change is lost, not everything saved with it.
- **Install apps** (Apps › Install apps): one place to install Promptly, Photos and each of your apps on your home screen or desktop. Each app's icon wears its own colour.
- **Install any item as its own app** (⋯ → Install as an app). Your workout log or budget gets its own
  name, icon and window on your phone or desktop, with none of Promptly's navigation. It's still the
  same file in your Promptly, so chats and search keep seeing it. On iPhone and iPad, use Share → Add
  to Home Screen.
- **Apps fit the space they get:** every app lays out by its own width, so desktop views stay
  readable with the assistant panel open, and phone views are tuned for one-handed use (today-first
  plans, sticky actions, nothing scrolling sideways). Links like `/apps/budget?tab=subscriptions` open that tab.
- **Items from any chat**: with tools on, chat can list your item files, read one, and run its actions
  ("log 3×8 bench at 80"). It won't change a file on a turn that read outside content.
- **Promptly Photos as its own app:** install Photos with its own icon and window (`/photos`). It opens straight into your library with none of Promptly's menus: bottom tabs on a phone (Photos · Albums · People · Search · More), the Photos menu on desktop, and Upload always at hand. Open `/photos/?install=1` for install steps (an Install button, or Share → Add to Home Screen on iPhone/iPad). Photos inside Files works as before.

### Changed
- **Promptly Files is no longer offered as a separate app:** Files pages now install as Promptly itself. Photos is the separate app. An already-installed Files app keeps working.
- **Photos: naming a face now spreads.** Tag one face as Sarah and the rest of its unnamed group comes with it, and her look-alikes (faces nobody's yet, and other unnamed groups that are mostly her) are filed too — only when they're clearly her and clearly not someone else you've named. New faces now join a named person over an unnamed group, and people you named before (even without tagging single faces) are looked at again in the background, so look-alike groups found since join them. "Not them" and faces you confirmed are never changed.
- **Photos: automatic tags look tagged.** A person or pet matched automatically now shows their name with a small "Auto" label and a × to remove it, instead of ✓/✗ buttons that read like an unanswered question.
- **People → "Is this Sarah?"**: faces that look like someone you've named, but not surely enough to be filed, are now asked about in the review with Yes / No, instead of being guessed or left unasked.

### Fixed
- **The assistant inside apps failed with Claude models:** some tool definitions had blanked fields, which Anthropic rejects as invalid JSON Schema.
- **Claude through OpenRouter:** newer Claude models (e.g. Haiku 5.5) failed with "No endpoints found that can handle the requested parameters". Promptly no longer sends them a temperature they don't accept.

## [0.10.4] - 2026-10-30

### Changed
- **People → "Who is this?"** is a search now. The row of up to 8 name buttons is gone. The name box
  matches everyone you've named as you type (names that start with it first). An exact name, in any
  case, adds the photos to that person instead of making a second one. "+ New person …" is always
  the explicit way to add someone new. Arrow keys and Enter work.

## [0.10.3] - 2026-10-30

### Added
- **PromptlySync 0.1.2 → Free up space**: removes photos and videos from the phone that are safely in
  Promptly, and nothing else. A file only goes if all of these hold:
  - the app backed it up, from a chosen folder;
  - it's hashed on the phone at the time of the check;
  - the server confirms it holds those exact bytes in Photos (not in the trash, not deleted);
  - when you tap Free up, both checks pass again: the file is unchanged on the phone and still stored.

  Anything not backed up, edited since, or deleted in Promptly stays. Android's own "Allow … to
  delete?" dialog confirms. An option keeps the last 30 days on the phone (on by default). An "Open
  Promptly Photos" button opens the library.
- **A photo you delete in Promptly stays deleted**: a phone never sends it back, even after being
  re-linked from scratch. Photos in the trash, and the SHA-256 of photos deleted for good (new
  `photo_deleted_hashes`, migration 0228), are reported to the phone as "skip"
  (`POST /api/devices/have` now returns `have` and `skip`). The app counts them as "deleted in
  Promptly", not as waiting.

## [0.10.2] - 2026-10-30

### Fixed
- **PromptlySync 0.1.1**: tapping "Scan QR code" crashed the app. The release build's code shrinker
  removed the constructors Google's QR scanner (ML Kit) creates by reflection; they're kept now.

## [0.10.1] - 2026-10-30

### Added
- **Photos → Clean up → Similar**: shots taken moments apart that look almost the same (bursts,
  retakes of one pose) now have their own tab, with the best of each set marked. Nothing is picked
  for you, since they're all real photos; "Keep only the best" picks the rest of one set.

### Changed
- **Clean up → Duplicates now means the same photo twice**: identical files, or the same picture
  taken at the same instant (a Takeout copy of a phone photo), or saved again much later.
  Bursts moved to Similar.

### Fixed
- A burst from a phone (several frames a second) could be hidden as "copies" of its first frame
  when it synced. A copy now has to be the same instant: when both files record the fraction of a
  second (Pixels do), it must match. A copy stamped only to the whole second is matched to the one
  frame it looks most like, not the whole burst.
- Clean up called pictures with completely different colours "duplicates" (plain or near-plain
  shots especially). The fingerprint only sees light and dark shapes, so matching photos (in Duplicates,
  Similar, and when hiding copies) now also need the same average colour, read from each photo's stored
  preview hash. A black-and-white version of a photo still counts as Similar.

## [0.10.0] - 2026-10-30

### Added
- **Files → New → Note**: a note is a Document that starts as "Untitled note" (`POST /api/files/office`
  accepts `kind: "note"`). Home gets a Note tile too.
- **Create from anywhere in Files**: right-clicking empty space in a folder now offers every New item
  (Folder, Document, Note, Spreadsheet, Presentation, Whiteboard, From template, imports, uploads) into
  that folder; an empty folder (or a fresh My files holding only system folders) shows one-click
  create buttons; on tablet widths every Files page shows New in its top bar, not only My files.
- **PromptlySync, an Android app that backs up a phone's photos and videos to Photos** (`android/`).
  Files → Devices → Add device shows a one-time QR code (10 minutes). The phone's camera opens the
  `/sync` download page; the app scans the same code and gets its own app password (upload + read,
  never delete). Then it lists the phone's folders to choose from, and backs them up in the background:
  hourly, soon after a new photo, Wi-Fi-only and charging-only options, resumable 50 MB tus chunks,
  original files with their location. Before sending, it asks the server which files Photos already
  has (by SHA-256, `POST /api/devices/have`), so a Takeout-imported photo isn't sent twice. Deleting
  on the phone never deletes in Promptly. Removing a phone in Files → Devices stops it at once. The
  APK is served from the server itself (`frontend/public/downloads/`, built and signed with
  `android/build-release.ps1`), and the app offers its own updates. Built to be light on battery (tuned
  for Pixels):
  - Each run reads only the photos that changed since the last one (MediaStore generations), with a
    full look once a day.
  - A burst of shots is one run: 30 s after the last one, never more than 2 min late.
  - The safety-net run is every 6 hours, and Android can fold it into other wake-ups.
  - Nothing runs when the battery is low.
  - A foreground notification appears only for big backups.
  - The status screen no longer re-reads the library every few seconds.
  - Schedules are re-registered after an app update.
  - It warns when Android's battery setting is "Restricted" (backups would stop), and offers
    "Unrestricted" as an opt-in for immediate backups.

### Changed
- The New menu, the right-click menu and the empty-folder state share one list of actions, so they
  always match. Files' subtitle no longer describes it as chat attachments.

### Fixed
- Whiteboards and presentations showed a `.whiteboard` suffix in their name in Files (and renaming one
  dropped it); the suffix is now treated as the extension like `.sheet`.

## [0.9.11] - 2026-10-30

### Fixed
- **Chatting with newer Claude models through the Anthropic API failed** with "`temperature` is
  deprecated for this model". Claude 4.7 and later (Opus 4.7/4.8/5/5.5, Sonnet 5/5.5, Haiku 5.5,
  Fable) reject `temperature`, `top_p` and `top_k`, and from Anthropic's API version 2026-10-21
  every model does. Promptly no longer sends them to Anthropic; older Claude models use their
  default temperature.

## [0.9.10] - 2026-10-26

### Fixed
- **Describing photos still failed with Qwen 3.x Flash (and other reasoning models OpenRouter
  lists).** 0.9.9 asked for no thinking, but only for models it guessed reasoned from their id, and
  "qwen3.7-flash" didn't match, so the request was never sent. Whether a model reasons now comes
  from OpenRouter's own model list, with the id guess only as a fallback. Thinking is turned off the
  way OpenRouter documents (`effort: "none"`). A model that still answers nothing gets one more try
  with a little thinking and more room. Chat's Effort control now also applies to those models.
  After updating, press **Try again** under Admin → Storage → Understanding photos.

## [0.9.9] - 2026-10-25

### Added
- **Photos you already have aren't shown twice.** A photo arriving in Photos that's the same as one
  you already have is hidden as a copy, as when a phone syncs pictures a Google Takeout already
  brought in. It counts as the same if it's the same file, or an image taken within a second that
  looks the same (Google's copy and the phone's original often aren't byte-identical). The file
  stays where the phone put it, so the phone doesn't send it again. The original keeps its albums,
  people and descriptions. Clean up lists the hidden copies next to their originals, with "Not a
  copy" to put one back (migration 0227).

### Changed
- **Naming people and pets is quicker.** The "Who is this?" cards are a grid instead of a sideways
  strip, with bigger pictures. Untick any that aren't them, then tap someone you've already named
  ("It's… Bumi") or type a new name. On a pet card that names every ticked photo at once, not just
  the first, and the rest of that pet's photos follow on their own. Person cards have a Hide button.

### Fixed
- **Describing photos failed for every photo with a reasoning model** (Qwen 3.x Flash, DeepSeek…).
  The model spent its whole short budget thinking before writing anything, so each photo "couldn't
  be read". Descriptions now ask for no thinking, with a little more room. After updating, press
  **Try again** under Admin → Storage → Understanding photos.
- **A provider's "slow down" (429) failed the photo being described.** Three in a row and that photo
  was never described. Now it isn't counted against the photo: describing waits for the next minute,
  and runs two at a time instead of four.
- **A dog could turn up under People.** The face detector finds dogs' and cats' faces too, and they
  grouped into a "person". Each face is now checked against the photo-search model (a person's face,
  or an animal's?) and animal faces are dropped. New faces are checked as they're found; the faces
  already found are checked once ("Telling faces from animals"). A face you named yourself is never
  removed.

## [0.9.8] - 2026-10-23

### Fixed
- **Updates didn't apply nginx config changes on Linux.** `nginx.conf` is mounted into the nginx
  container as a single file, and `git pull` replaces that file. The running container kept the old
  one, and the update only reloaded it. That's why 0.9.7's map was blocked by the old security rules
  and stayed blank. `update.sh` / `update.ps1` now recreate the nginx container. If you're on 0.9.7,
  run `docker compose up -d --force-recreate nginx` once.
- **The Photos map stayed blank after updating.** Its background worker ran under the security
  rules cached with the worker file, which were the old ones, so every map tile was refused. The
  worker now runs from a copy made inside the page, which always follows the page's current rules.

## [0.9.7] - 2026-10-23

### Added
- **The Photos map shows streets, towns and place names.** With no offline basemap on the server,
  it uses OpenFreeMap: free, no key, in a light or dark style to match the app. Your browser fetches
  only the map tiles for the area on screen; nothing about your photos leaves the server.
  `PHOTOS_ONLINE_MAP=false` keeps the map offline (countries only).
- **Storage shows how much Photos takes.** The storage panel splits Files into Photos (your Photos
  folder) and Other files.

### Changed
- **The Photos menu stays put, and looks the same everywhere.** Before, opening Albums or People
  replaced the menu with a back arrow. Now every Photos page has the same single row:
  - Photos, Favourites, Archive, Family, Albums, People, Places and Clean up, each with an icon.
  - Search, Settings, the progress figure and Upload together on the right.
  - It never wraps. When the labels don't fit, the sections show as icons with their names on hover.
  - Family's settings button moved from the menu into the Family view.

### Fixed
- **Faces were found but never grouped into people while a big batch of photos was being
  processed.** Grouping only got whatever time the other stages left in each minute, which was none
  during a backfill. It now always gets its own share.

## [0.9.6] - 2026-10-22

### Fixed
- **An import sat at "Adding parts" after its upload finished.** It waited for a "Check the
  archives" click that was easy to miss after a long upload. The archives are now checked as soon as
  the uploads finish; review what's in it and press Import.
- **A Takeout part could land in an import you'd cancelled.** Choosing the same file again for a new
  import carried on the old upload, which still belonged to the cancelled import. The part ended up
  there, unseen and never deleted. An upload now only resumes for the same import. A part finishing
  for a cancelled import is refused and deleted, and leftover files of cancelled imports are cleared.

## [0.9.5] - 2026-10-22

### Changed
- **Photos is now one locked folder, like Google Photos.** "Camera Uploads" became **Photos**:
  - It's always in My files and can't be renamed, moved or deleted.
  - The Photos tab shows only what's in it and the folders inside it.
  - The Photos tab has an **Upload** button. Uploads, phone backups, shared photos and imports land in
    it by the month each was taken.
  - Pictures elsewhere in My files (scans, ID cards, chat attachments, AI images) stay ordinary files
    and leave Photos. "Move to Photos" on a picture's menu files it in.
  - A phone app still set up with the old "Camera Uploads" folder keeps backing up into Photos.
  - Existing accounts get it from their Camera Uploads, a folder of theirs already called "Photos", or
    a new empty one (migration 0226). Nothing is moved.
  - The "Use photos from" choice from 0.9.4 is gone; the folder replaces it.

### Fixed
- **Photos settings were easy to miss.** The button was an unlabelled gear at the very end of the
  Photos header, and on a narrower window that row ran off the edge. It now reads "Settings", and
  the row wraps instead.

## [0.9.4] - 2026-10-22

### Added
- **Photos can use only your photos folder.** Photos → settings → "Use photos from" is now
  "Everywhere in my files" (as before) or "Only these folders", with your folders to tick (Camera
  Uploads first). Subfolders count. Everything else stays out of Photos and isn't searched, or read
  for faces or text, in the background.

### Fixed
- **Photos could keep reading the same few photos every minute, forever, on a slower server.** The
  background work took 100 photos at a time and saved nothing until all were done. Reading the text
  in them could take longer than the two minutes a tick was allowed, so the tick was cut off, nothing
  was kept, and the next minute started again. It now works through a few photos at a time (8 for
  text and descriptions), saving each batch, and a tick that's still busy makes the next one wait.
- **Photos' background work also worked on pictures that aren't in Photos.** Chat Uploads,
  workspace files and folders hidden from Photos were all searched and read for faces and text.

## [0.9.3] - 2026-10-21

### Fixed
- **Photos kept the server's CPU busy all the time.** Three things fed each other:
  - With every model loaded, the photo-understanding service needed more than its 3 GB of memory, so
    it was killed mid-batch and restarted, reloading its models.
  - The batch it died on was sent again a minute later, and again, forever.
  - A photo it couldn't read was retried every minute instead of hourly, three times at most.

  It now uses about 2.7 GB (ONNX Runtime's memory arena is off) within a 4 GB limit, and a failed
  batch or unreadable photo waits an hour and gets three tries.

## [0.9.2] - 2026-10-18

### Added
- **DeepSeek models search and read the web with DeepSeek's own engine.** When a chat's model comes
  from a DeepSeek provider, web search goes to DeepSeek's Search API first (your other search
  providers are the fallback, and none is needed), and a page that blocks the normal fetch is read
  through DeepSeek's Fetch API. It uses the DeepSeek key already set up for chat, covers sub-agents,
  scheduled tasks and Deep Research, and is never used for other models. The tool card says "via
  DeepSeek". DeepSeek charges $0.75 per 1,000 successful searches or fetches.

### Changed
- **Deleting on your phone no longer deletes in Promptly.** A device's WebDAV deletes now leave the
  file here, so you can clear space on a phone and keep the backup, even if its sync app mirrors
  deletions. Account → Devices has "Deleting on this device deletes here too" per device, for a
  drive you open in Finder or mount with rclone. Existing devices start with it off (migration 0225).

## [0.9.1] - 2026-10-18

### Added
- **Choose what AI search reads.** The AI search dialog in Files now lists the top of your Drive
  with a tick box per folder (Generated Files and Chat Uploads included) and one per kind of file
  (Docs, Sheets, Whiteboards, PDFs, Word/Excel/PowerPoint, text and other files). Unticking one
  takes what was already indexed out at once. Generated Files and Chat Uploads also get "Leave out
  of AI search" on their menu.

### Fixed
- **Clicking a folder in Files only selected it.** A click anywhere on a row now opens it (a folder
  navigates, a file previews); Ctrl/Cmd- or Shift-click and the tick boxes select. The second
  click of a double-click no longer lands on whatever replaced the row.

## [0.9.0] - 2026-10-16

### Security

- **Every page load told Google who was visiting.** The DM Sans web font came from
  Google Fonts, so each visitor's IP went to `fonts.googleapis.com` /
  `fonts.gstatic.com`, and offline the app fell back to system fonts. It's now bundled
  (`@fontsource/dm-sans` 5.3.0, OFL-1.1; weights 400–700, latin + latin-ext) and in the
  offline precache, and the CSP no longer allows either Google host.
- **Single sign-on could hand over the wrong account.** It trusted an email the identity
  provider hadn't verified, matched accounts by email alone, and skipped two-step
  verification and "Require MFA" — admins included. Now the email must be verified (an
  admin can opt out for providers that never say), an account is tied to its provider
  identity after the first SSO sign-in, and Promptly's own second factor applies to SSO
  unless an admin says the provider's is enough. (R-140)
- **Two-step verification could be changed with just a stolen session.** Setting up a new
  method or new backup codes now needs your password, your current method keeps working
  until the new one is confirmed (so abandoning a switch can't lock you out), sign-in
  ignores a half-set-up method, and you're emailed whenever it changes. (R-141)
- **Signing out didn't end the session on the server** — a copy of the sign-in cookie
  kept working for 30 days. It's now revoked. (R-191)
- **People on your home network skipped the blanket rate limit** just for having a
  private address. Only Promptly's own services are exempt now; the limit is higher to
  allow for it. (R-134)
- **Each wrong backup code cost about 1.6 seconds of server time.** A code is now looked
  up directly, so only one is checked. (R-139)
- **"Close the garage" could fail in Home Assistant and Promptly still said "Garage
  closed."** A connector tool reporting an error came back as ordinary text, so commands
  spoke their success line, History showed a green tick and chat showed a tick too. A
  failed tool is now a failure everywhere, with the tool's own reason. (R-130)
- **"Okay, cancel that" counted as yes** to a spoken "shall I open the garage door?", as
  did "Sure, wait no" and "Do it later". Only a clear yes runs a guarded command now, and
  any no, stop or wait cancels it. (R-131)
- **Attaching a connector to a workspace could silently remove ones an admin had
  attached.** Saving now changes only the connectors you're allowed to manage, and the
  Connectors tab shows what the workspace really has, with why you can't change a
  particular one. Turning one on warns that everyone in the workspace can use it. (R-156)
- **Anyone who reached a new server first could claim its admin account.** The setup
  page was open to whoever got there first, on a port published on every network
  interface. The installers now print a one-time setup code that the wizard asks for.
  Without one, for a hand-built install, setup only works from the local network.
  (WP-1.5, R-263)
- **Any signed-in user could overwrite or trash another user's file.** A workspace
  discussion stores the id of its search-transcript file in its settings, and those
  settings could be replaced wholesale by the client. Pointing a discussion at any file
  id you knew — someone else's PDF, a file shared with you — then toggling its AI
  context made the server overwrite that file's contents with the chat transcript or
  move it to Trash. Fixed in two independent layers: the client can no longer set
  server-managed settings, and the transcript indexer now refuses to touch any file
  that isn't that discussion's own transcript, owned by the workspace owner.
  (Roadmap R-001, the review's only P0.)
- **Viewers could edit shared documents, canvases and sheets.** The collaboration
  server received each connection's read-only flag but put it in the wrong place, so
  it was never enforced — a workspace viewer or a read-only file grantee could change
  or wipe content with a modified client (the server even told them they had
  read-write access). Read-only connections now have their edits dropped
  server-side. (R-021)
- **Removing or demoting a member didn't affect sessions already open.** An editor
  removed from a workspace — or demoted to viewer — kept full edit access in any
  document, canvas or sheet they still had open, for as long as it stayed open. The
  collaboration server now re-checks every open session as its 5-minute access token
  runs out: a demoted member becomes read-only on the spot, and a removed member is
  cut off within about five minutes. Members whose access is unchanged notice
  nothing. (R-036)
  Both are covered by end-to-end checks in `collab/scripts/` that drive the real
  server with read-only, revoked, demoted and renewed connections.
- **Workspace Ask could quote another member's private draft.** "Ask this
  workspace", workspace search, Related items and workspace chats searched the whole
  workspace and relied on an exclusion list that missed rosters, discussions, card
  attachments and chat transcripts, ignored archived items, and couldn't exclude a
  canvas or sheet before its first save — so private drafts, trashed, archived and
  switched-off content could surface in answers and quoted snippets, even for a
  viewer. All of them now draw only from one allow-list of content the AI may see:
  shared (not private), live (not trashed or archived), switched on for context, and
  not inside a switched-off notebook. Anything not on the list is never searched.
  The roster "use as context" toggle, which previously did nothing, now works. (R-033)
- **Removed members kept access through their old workspace chats.** A member removed
  from a workspace could keep reading its notes and boards, and keep filing changes,
  from chats they'd started there; a member demoted to viewer could still propose and
  apply edits. Workspace chats now use the caller's *current* role: removed members
  lose the workspace's prompt, context and tools, viewers get read-only tools, and
  applying a proposal re-checks membership and write access at that moment. (R-032)
- **Private drafts and private chats showed up in shared lists.** The workspace
  overview's task rollup quoted checklist items from other members' private drafts,
  and its recents, counts, the trash and archive lists, the activity feed and the chat
  list all included private items and chats. Workspace memory could be rebuilt from
  private chats (and then read by everyone), any editor could index someone else's
  chat into the shared pool, and the owner's export included members' private chats.
  All of these now apply one shared visibility rule; only a chat's creator can index
  it (and only once it's shared with the workspace); and rewriting workspace memory
  is limited to owners and admins, matching the settings screen. (R-039, R-040)
- **Commands and automations could use connectors their runner had no access to.**
  Running a command that calls a connector tool only checked that the connector
  existed and was switched on — never whether *the person running it* could reach that
  connector, whether the admin had allowed that tool, or whether it was a destructive
  tool. So a shared command lent everyone its author's connector access, contrary to
  what v0.8.6 promised. Automation tool steps likewise skipped the tool allow-list and
  the destructive-tool block. Commands, automations and the device list now all go
  through the same check chat uses, for the person actually running it; destructive
  tools need a command set to "ask before running" (and are never run unattended by
  an automation). Saving a command whose tool you can't use is refused with a clear
  reason, only slots a command's phrases declare can override its fixed arguments,
  and other people's shared commands no longer reveal their connector target or
  arguments. (R-031)
- **Chat could run tools it was never offered.** The chat engine ran any built-in tool
  the model named, even one switched off for this conversation or user — so a
  confused model, or instructions hidden in a fetched web page or file, could invoke
  it. Tools now only run if they were offered for that turn.
- **Workspace notes ignored the member's role.** The note editor decided whether you
  could type from file-sharing grants alone, so workspace viewers were shown an
  editable note (their edits were then silently dropped) and workspace admins
  couldn't save edits at all. The server now gives one answer — owner, a file grant
  with edit rights, or a workspace owner/admin/editor — and the editor, live
  collaboration, manual save and image upload all follow it. The editor stays
  read-only until that answer arrives. Opening a note through a workspace also no
  longer reaches another member's private draft or a note in the trash. (R-218)

- **Automations could leak a stored credential to anyone who could feed them text.**
  Values pasted in at run time (a webhook body, an AI answer, a card title someone else
  typed) were inserted *before* `{{secret.NAME}}` tokens were filled in, so text
  containing a token made the automation send the real credential, and the run log
  only showed the token. Credentials now come only from the steps you wrote. Each
  credential can also be limited to the hosts it's meant for (Automations ▸
  Credentials), and a redirect to another site no longer carries your headers along.
  (R-005)
- **Any user could point an automation at your local network**, including the Docker
  host and Promptly's own unauthenticated internal services, by ticking "allow private
  network" on an HTTP step. That's now a per-user permission an admin grants (Admin ▸
  Users), it's checked when a flow is saved and again every time it runs, and Promptly's
  own services (database, Redis, Ollama, the code sandbox…) stay off-limits even with
  it. Separately, the network guard used by automations, link previews and the AI's
  page fetcher let through 100.64.0.0/10 (where Tailscale puts every device) and other
  non-public ranges; it now blocks every address that isn't on the public internet. If
  you point web search at a Tailscale address, add it to `SSRF_ALLOWED_HOSTS`, as
  for any private address. (R-008, R-015)
- **Automation MCP steps could call any tool**, including ones an admin had switched off
  or that delete things, because a flow is just saved data. The tool is now checked
  when the flow is saved and again when it runs, and the connector layer itself refuses
  tools that are switched off, unknown, or destructive without a human confirmation, for
  every caller. (R-006)
- **Automations ignored the owner's current access.** A workspace viewer could create
  automations that wrote into the workspace, and a removed member's automations kept
  running there and receiving its events. Automations now need an editor or higher in
  their workspace, both when saved and on every run. Removing a member pauses their
  automations there (they're told). Event-triggered flows no longer receive events about
  other members' private drafts. (R-007)
- **Automations ignored model restrictions and usage budgets, and their spend wasn't
  counted.** They now use only models their owner is allowed, stop with a clear message
  when the owner's budget is used up, and count towards usage like chat does, including
  the copilot and test runs. (R-011)
- **Anyone could log you out and keep you out.** Five wrong passwords for an account,
  from anywhere, locked it, and the lock also ended every session the owner had open,
  repeatable around the clock. Now wrong passwords are counted per account *and* address:
  the guesser's address is paused, and the owner, from anywhere else, signs in normally.
  A separate account-wide lock still stops a spray from many addresses (25 failures). A
  device that already passed two-factor gets past both. A lock never ends a session.
  (R-002)
- **Two-factor codes could be guessed without limit.** A sign-in attempt is now
  abandoned after 5 wrong codes, and can't be reused once it succeeds. After 10 wrong
  codes in an hour, two-factor sign-in pauses for that account and the owner is
  notified that someone has their password. (R-003)
- **Rate limits could be dodged by faking the client address.** The server trusted a
  `CF-Connecting-IP` header any client could set, so every request could claim a new
  address, getting past the login, two-factor and share-link limits, and the audit log
  recorded whatever was claimed. nginx now overwrites that header and only accepts a
  forwarded address from Docker's own network. **If your Cloudflare tunnel or reverse
  proxy runs on a different machine, add `set_real_ip_from <its address>;` to a file
  in `nginx/local/`**, or every visitor will appear to come from that machine.
  Share-link passwords are also capped at 10 wrong guesses per link per 15 minutes,
  wherever they come from. (R-014)
- **Web framework security updates.** FastAPI 0.115 → 0.128, Starlette 0.38 → 0.52,
  python-multipart 0.0.9 → 0.0.32. This closes an unauthenticated upload that could
  exhaust memory (CVE-2024-47874) and an upload stall (CVE-2025-54121), and adds HTTP
  Range support, so downloads can resume and videos can seek. (R-017)
- **Signing out now leaves nothing behind for the next person on the same browser.**
  Their chat titles stayed on screen, their unsent drafts were in the next person's
  composer, and the browser kept receiving their notifications with message previews.
  Signing out (or a session ending) now stops this device's notifications, clears saved
  drafts and choices, and starts a fresh page. If someone else signs in where a
  previous user never signed out, that user's saved data is cleared first. (R-030)
- **Saved memories could be planted by a web page.** While reading a page, search
  results, a connector's response or a file, the AI could be told to "remember" something
  ("the user prefers vendor X"), and that fact was then quietly fed into every future chat.
  Memory saves were also completely invisible. Now every save shows as a "Saved to memory"
  notice with Undo. On a turn that read outside content, nothing is saved unless you asked
  in your own words; the AI's suggestion is offered as "Save to memory?" instead. Outside
  content is clearly marked as data for the AI, with a standing instruction never to follow
  instructions found inside it. (R-019)
- **Photos you shared kept their location for anyone with the link.** Share links now give
  out photos without where they were taken or camera details, unless you tick "Include
  photo location" when creating the link. Photos sent to an AI model never include them.
  Images pasted into documents lose them too, because their links outlive unsharing.
  (WP-0.5, decision D13)
- **"Ask this workspace" ignored model access and spending limits.** It answered with the
  workspace's default model even for members an admin hadn't given that model, and its
  usage skipped the daily and monthly caps. It now uses a model the person asking may use,
  counts against their limits like a chat message, and says why when it can't answer.
  (R-183)
- **Private boards weren't private.** Their cards and comments could be read and edited by
  every member through the board API, and a private board's cards showed in the overview's
  "Needs attention". The workspace activity feed had no access check at all, and backlinks
  listed other people's private notes. All of these now follow the board's or note's
  privacy. (R-168)
- **Canvas "Remove background" could take the server down.** Any signed-in user could send
  it huge images, several at once, until the backend ran out of memory and restarted,
  dropping everyone's chats. It now needs edit access to the workspace, runs one image at a
  time, scales big images down first and is rate-limited per person. (R-172)
- **Webhook URLs can be regenerated** (a leaked one used to work until the automation was
  deleted), their secret no longer appears in the server's access logs, and a webhook can
  require a signed request (HMAC-SHA256 of the body in a header, as GitHub and Stripe send,
  checked against a credential from the vault). (R-195)
- **Web app libraries updated for known security flaws.** The HTTP client (axios
  1.15.0 → 1.20.0) had a run of prototype-pollution, proxy-bypass and header-injection
  advisories (among them GHSA-3g43-6gmg-66jw, GHSA-35jp-ww65-95wh, GHSA-898c-q2cr-xwhg,
  GHSA-pjwm-pj3p-43mv), and its form-data dependency a CRLF-injection one
  (GHSA-hmw2-7cc7-3qxx, now 4.0.6). The router (react-router-dom 6.30.3 → 6.30.6,
  @remix-run/router 1.23.4) fixes open-redirect advisories GHSA-2j2x-hqr9-3h42 and
  GHSA-jjmj-jmhj-qwj2. Both are pinned to exact versions now.

### Added
- **Docs and Office files show their first page in Files.** In the grid, a Doc's tile is a
  picture of its first page (made on the server, and made again when the Doc changes) instead of
  the Doc icon; with the optional converter running, Word, Excel, PowerPoint and OpenDocument files
  get one too. **Space** previews the selected file (Quick Look), as in Finder. (Files)
- **Suggesting mode in Docs (track changes).** Switch the toolbar from **Editing** to
  **Suggesting** and what you type shows as a suggested insertion (underlined in green) while what
  you delete is struck through (in red) instead of removed. Click any suggestion to see who made it
  and when, and **Accept** or **Reject** it — or accept or reject them all from the same menu.
  Suggestions sync live to everyone editing, and a Word export carries them as Word's own tracked
  changes. (Docs)
- **Family library.** Photos → **Family** pools photos with people on this server. Start one and
  add people; each person chooses what of theirs goes in — nothing (the default), everything, photos
  from a date, or photos with certain people — and new photos that fit join by themselves. Everyone
  sees what the others share in the Family view and in search, but can only look and download:
  editing, archiving and deleting stay with the owner. Leaving takes your photos out at once.
  (Photos)
- **Measure how well Photos finds things.** An evaluation command
  (`python -m app.photos.evaluate spec.json`, run in the backend container) checks a hand-labelled
  sample of a library — the queries you'd ask, and who's in which photo — and reports search
  success@5 and MRR, latency p50/p95, and face and pet precision and recall. The labels stay on your
  machine. A test also now checks that no Photos screen or API shows one person's photos to
  someone else. (Photos)
- **Do things with your photos from a chat.** Ask "make an album of these", "add them to Holiday",
  "keep an album of Max at the beach going" (a smart album), "share it with sam@example.com" or
  tell it "Sarah is my wife": a card shows exactly what would happen, and nothing changes until you
  press **Apply**. Sharing only ever goes to people on this server, by their exact username or
  email. (Photos)
- **Search covers albums shared with you.** Searching your photos (in Photos or in a chat) also
  finds photos in albums you were invited to, labelled with whose album they're from. Your own
  names for people and pets only ever match your own photos, and smart albums stay your own photos.
  (Photos)
- **Presentations (Slides-lite).** New → **Presentation** (in Files and on the Files home) makes a
  whiteboard in slide mode: each slide is a frame you draw on with the whiteboard tools. The sorter
  down the side shows every slide — click to go to it, drag (or Alt+↑/↓) to reorder, **New slide**,
  delete with Undo — and each slide has its own speaker notes. **Present** shows the slides
  full-screen (→ / Space / click for the next, ← back, Esc to stop); **Presenter view** opens a
  second window with the notes, the next slide and a clock. Export to **PowerPoint (.pptx)** —
  one picture per slide, with the speaker notes — or to **PDF**. Everything syncs live for everyone
  editing, like any whiteboard. (Stage 12)
- **Generate slides from files.** In a presentation, **Generate slides from files** drafts a deck
  from up to ten of your files (and what the talk is for): titles, bullets and what to say, with
  each slide's speaker notes naming the files it came from. The slides are added after the ones
  already there, ready to edit. (Stage 12)
- **PowerPoint and old Office files preview as they look.** Through the new bundled `convert`
  service (started by default), a `.pptx`, `.ppt`,
  `.doc`, `.xls` or OpenDocument file previews as its real pages in the PDF viewer instead of a text
  outline; the converter has no internet access. Old Word, Excel and PowerPoint files (`.doc`,
  `.xls`, `.ppt`) can now be uploaded at all, and with the converter their text becomes searchable
  too. (Stage 12)

- **Off-site backup** in Admin → Backups. Until now every copy lived on the machine it
  protects, so a dead disk or a stolen box took the backups too. Choose a USB disk or NAS
  folder, an S3 or Backblaze B2 bucket, another computer over SFTP, or a restic
  rest-server, and Promptly sends it an encrypted copy of the database, everyone's files
  and its own keys every night, keeping 7 daily, 4 weekly and 12 monthly copies. It
  checks a twelfth of the stored data every week and, on the 1st of each month,
  restores the database into a scratch copy and compares a sample of files byte for
  byte. The card says "Not a real backup yet" until it's set up, turns amber when the
  last good copy is over two days old, and every admin is alerted when a copy, check or
  trial restore fails. (WP-2.3)
- **Recovery kit:** `scripts/recovery-kit.sh` (or `.ps1`) writes the backup's location,
  its password, the target's credentials and `SECRET_KEY` to a file for safekeeping off
  the machine. It runs only on the server and is never shown in the web app. (WP-2.3)
- **Forgot password?** on the sign-in page emails a single-use link that works for 30
  minutes (when the server can send email). (R-191)
- **Sign out of all devices** under Account → Security. Only an admin could do it
  before. (R-191)
- **Admins can reset someone's two-step verification** when they've lost their phone and
  their backup codes, and there's a command for when no admin can sign in:
  `docker compose exec backend python -m app.cli reset-mfa <user>`. (R-138)
- **Changing SECRET_KEY no longer locks everyone out of MFA and stored keys:** set
  `SECRET_KEY_PREVIOUS` to the old value and stored secrets move to the new key at
  start-up. Secrets that can't be read are reported in the log. (R-138)
- **The audit log records the admin actions that matter** — users created, roles and
  emails changed, imports, group changes, provider keys replaced — no longer logs every
  token refresh, keeps a year by default (90 days of errors), and can be filtered by date
  and exported as CSV. (R-145)
- **Users panel:** search, a status/role filter, sort by name, last seen or newest, and
  "last seen" now means last active rather than last password sign-in. Disabling someone
  or signing them out everywhere asks first. (R-192)
- **Connector actions that change something can run from chat, after you approve
  them.** Tools a server marks destructive (unlock, open, delete) were hidden from chat.
  Now, when the AI asks to use one, an approval card shows exactly what would be sent;
  nothing happens until you press Approve, and your access is checked again then.
  Automations still never get these tools. (WP-2.1)
- **Choose which connectors each chat can use** from the More menu. Every connector's
  tools used to ride along on every chat — a GitHub tool in a recipe chat. (R-161)
- **Connector health in Admin → Connectors:** each connector shows whether it's working,
  its last error, and admins get a notification after three failures in a row. Tool lists
  now refresh by themselves every six hours. (R-158, R-160)
- **Home Assistant voice (Wyoming) status in Admin → Health:** whether it's listening,
  why it didn't start, and when a satellite last connected and spoke. (R-200)
- **End-to-end safety net** (`e2e/`, roadmap WP-1.1): a Playwright suite that drives the
  real app in a browser against the running stack. It covers sign-in, sending, Stop,
  Regenerate, attaching an image, uploading and opening a PDF, sharing a folder, a note
  opened through a public link, dragging a board card, and running a command. It uses a
  built-in fake model, so it costs nothing and gives the same result every time, and takes
  about 20 seconds. Run it with `cd e2e && npm test` before every release.
- **Automatic database backups.** Promptly now dumps its database before every update
  and every night at 02:00, keeping the last 14, in `data/backups/`. If the pre-update
  backup can't be taken, the update doesn't run. **Admin → Backups** shows the last good
  backup, lists every attempt, has a *Back up now* button, and every admin gets an alert
  if a backup fails. The dump tool is matched to the database version, so a backup
  always restores.
- **One-command full backup and restore.** `scripts/backup.sh` (and `.ps1` on Windows)
  bundles the database, your files and `.env` into one archive. `.env` has to be in
  there: its key unlocks every stored API key. `scripts/restore.sh` puts an archive
  back: it rebuilds the database from scratch and moves your current files aside rather
  than deleting them. `--with-env` restores onto a new machine, `--db-only` restores a
  single dump.
- **Safer updates, with undo.** `update.sh` / `update.ps1` now move to the latest
  release rather than whatever is on the main branch (`--channel main` and `--version`
  are still there), list the database changes coming, back up first, refresh the
  third-party images, and check that the background worker and live editing came back,
  not just the backend. If anything fails, `--rollback` restores the pre-update database
  and code. They refuse to run over local edits to tracked files, which would be lost;
  put your own settings in `.env`, `docker-compose.override.yml` or the new
  `nginx/local/` folder, all of which updates leave alone.
- **Offboarding instead of delete.** Deleting a user now shows what they own first. Each
  workspace other people use has to be handed to one of its members or an admin, and
  their notes and files go with it. Invites the user sent and chats they shared with a
  workspace are kept. You type the username to confirm, *Disable instead* is offered,
  and the deletion is recorded in the audit log. (R-004)
- **"Promptly was updated — Reload."** Open tabs now notice an update and offer a reload,
  instead of running the old version against the new server. (R-247)
- A cancel button for meeting recordings that are still processing.

- Admin ▸ Users: **"Automations can reach your network"** permission per user.
- Automations ▸ Credentials: **allowed hosts** per credential.
- "Run to here" has a **Run actions for real** option. Test runs no longer perform
  POST/PUT/DELETE requests or MCP tool calls unless it's ticked.
- Admin ▸ Console ▸ Health shows **event loop lag**. A high number means something
  stalled everyone's replies.
- **"Include photo location"** option when creating a share link (off by default), shown
  as a badge on links that include it.
- **Deleted workspaces can be restored for 30 days.** Deleting a workspace moves it to
  *Recently deleted* in the Archive tab, where the owner can restore it or delete it for
  good. Until now one click past the confirmation destroyed its boards, sheets, canvases,
  rosters and discussions for ever. Automations in a deleted workspace don't run. (R-177)
- **Transfer ownership** of a workspace to one of its admins (Settings ▸ Lifecycle). Its
  Drive folder and files go with it, and you stay on as an admin. (R-177)
- **Workspace members:** change someone's role from the member list (it used to take
  removing and re-inviting them, which unpinned their files); removing someone now asks
  first and says what happens; members can **Leave** a workspace; and everyone can see
  who the admins are. Admins get the Share button too. (R-180)
- **Workspaces update live.** When a teammate adds, renames, moves or deletes something,
  it appears without reloading; coming back to the tab also refreshes. (R-187)
- **"Move to…"** in an item's ⋯ menu files it into a notebook, or back to the top level,
  without dragging. (R-181)
- **Duplicate workspace**, and **Offer as a template**: members can start new workspaces
  from your setup (instructions, notebooks, notes, boards with their columns, sheets,
  rosters and automations). (R-204)
- **Home & family templates:** Household, Trip, Renovation and School, next to the work
  ones. (V10)
- **Workspace export** now includes rosters (CSV), discussions, automations and the
  notebook structure, and an export imports back as a workspace with its notebooks.
  (R-188)
- **Workspaces on a phone:** boards, rosters and sheets open in simple read views
  (cards by column, shifts by day, the sheet as a table), notes can be edited, and the
  workspace overview has its own tab. They used to say "best on desktop". (V9)
- Opening a card from **My Work** now opens that card, not just its board. (R-184)
- **Sheets: Import and Export.** Bring an .xlsx or .csv into a sheet, and download a sheet
  as .xlsx (every tab, formulas kept) or .csv. (R-132)
- **Sheets: Version history.** Versions are kept while a sheet is edited and before an
  import, a restore or a clear, and any of them can be restored. Clearing a sheet can now
  be undone. (R-132)
- **Rosters: Publish is real.** Staff see the published roster (not the manager's work in
  progress), and everyone whose shifts changed gets a notification. **My work** shows your
  upcoming shifts from every roster, with a calendar link to subscribe to from your phone.
  Chat can now read rosters in every workspace, with full dates. (R-174)
- **Meeting notes:** a recording being processed can be cancelled, and if writing the notes
  fails after transcription you can **retry** or **download the transcript** rather than
  losing it. Uploads show their progress. (R-133)
- **Edit** your own discussion messages and comments; long discussion threads load their
  latest messages first with "Load earlier messages". (R-176, R-202)
- **Comments on sheets and canvases**, the same as notes have. (R-202)
- **Boards update live** for everyone looking at them when a card is moved, edited or
  commented on. (R-170)
- **Automations can read their workspace:** a new **Workspace** step searches the
  workspace, or reads one note, board, sheet or roster, or a file's text — so "when an
  invoice lands in the drive, pull out the totals" and "every Friday, summarise this board"
  can be built. (R-153)
- **Choose when an automation notifies you:** when it fails (the new default, which also
  tells you the first time it works and when it recovers), when its result changes, after
  every run, or never. (R-152)
- **Incomplete flows can be saved as drafts.** A draft is kept but never runs; the
  automation keeps running its last complete version until the draft is finished and saved.
  (R-149)
- **Diagnose** on a failed run: the AI reads the flow and the steps that ran and says what
  broke and how to fix it. (R-146)
- Webhook flows can read request headers (`{{trigger.headers.x_github_event}}`) and the
  query string (`{{trigger.query.ref}}`); `{{utc_datetime}}` gives the run time in UTC.
  (R-195, R-148)
- The flow editor has an **Add step** button, and its variable picker lists earlier steps
  by name (`AI step 2 — its output`) and the trigger's fields. (R-155)
- **Import & export** under Account settings: import chats from ChatGPT, Claude, another
  Promptly or a Markdown transcript from any device, and **Export all conversations** as one
  re-importable file. (R-310)
- The admin embedding card shows the embedder's health (last error, paused calls) and how much
  is still waiting to be re-indexed; admins are notified when the embedder stops answering and
  when it recovers. (R-322)
- Workspace owners can **Retry** failed indexing and **Re-index** the whole workspace from the
  overview; anything queued or failed is also retried every hour. (R-321)
- Memory import accepts plain-text facts (pasted, or a .txt / .md file, one per line) from other
  assistants. (R-329)
- **Shared links** in Files: every "anyone with the link" share you've made, how often it was
  opened, and a one-click Turn off. The Share dialog has a General access section to make and
  manage links, and linked files show a link badge. (R-208)
- Search shows matches as you type, finds folders and files shared with you, and has Type,
  Modified and Owner filters with Load more. (R-213)
- Uploads: **Retry** (and Retry all failed) without re-picking files, and **Replace / Keep both**
  when the folder already has a file with that name. Unsupported or oversized files are refused
  before uploading. (R-212)
- "Share → Promptly Files" on a phone uploads the shared photos and files to My files. (R-211)
- Folders have **Download** (as a zip) in their menu; a long press selects on touch screens. (R-210)
- **Spreadsheets and whiteboards are Drive files.** Each has a real file in Files (in its
  workspace's folder): it shows up in Files and Search with its own icon, downloads as `.xlsx` /
  `.excalidraw`, can be shared — including as an editor — and opening it from Files goes to the
  sheet or whiteboard. Existing ones are converted on upgrade.
- One collab-token endpoint for documents, spreadsheets and whiteboards
  (`POST /api/files/{id}/collab-token`), with one access rule: ownership, Drive grants, the
  workspace role, private drafts and trash.
- **Snapshots for documents, spreadsheets and whiteboards.** While a file is edited, a copy of its
  state is kept at most every 10 minutes and when the last person leaves; before a save that would
  shrink it to under half its size, the fuller version is kept first; and a copy is kept before an
  AI change is applied, an import, a restore or "Clear sheet". Hourly copies are kept for two
  days and daily ones for a month. Admins can recover any of them as a copy next to the original:
  `docker compose exec backend python -m app.cli versions list <file-id>` / `versions recover
  <version-id>`. (The version-history screen comes later.)
- **Documents, spreadsheets and whiteboards of your own, from Files.** **New** now offers
  Document, Spreadsheet, Whiteboard and **From template…**, and each opens on its own page
  (`/files/doc/…`, `/files/sheet/…`, `/files/whiteboard/…`). The page header shows where the
  file lives and has rename, star, Share, Export, **Make a copy**, **Save as template** and, for
  a workspace file, **Open in workspace**. Files, Recent, Starred and Search all open office
  files this way, including ones shared with you.
- **Templates.** A protected Templates folder starts with the four note templates as
  documents, budget, chore-chart, packing-list and invoice sheets, and mind-map, floor-plan
  and kanban-sketch whiteboards. "Save as template" adds your own. A file made from a
  template is a full copy that you edit like any other.
- **Whiteboard thumbnails.** Whiteboards show a picture of the board in the Drive grid. It
  refreshes a few seconds after editing stops.
- **Shared spreadsheets and whiteboards open from a link.** A share link to a sheet shows it
  as a read-only table, a whiteboard shows read-only, and Download gives an `.xlsx` /
  `.excalidraw` file.
- **You're told when something is shared with you.** Being given access to a file or folder
  sends a notification ("Alex shared “Budget” with you"). It goes to your inbox and as a push,
  and opens the file.
- **Files has its own rail.** On Files pages the app sidebar shrinks to an icon strip, and a Files
  rail holds **+ New** (Document, Spreadsheet, Whiteboard, From template…, Upload files, **Upload
  folder**, New folder), Home, My files with its folder tree, Shared, Workspaces, Starred, Recent
  and Trash. Chat Uploads and Generated Files move into a "From chats" group. The rail also shows
  storage used (files, trash, and versions, which are free) and when the server was last backed
  up. Admins can click through to Backups. On tablets the rail opens as a drawer.
- **Files › Home** (`/files/home`): tiles to make a document, sheet or whiteboard, start from a
  template or upload; a box to ask about the files you tick; and Recent, which includes shared and
  workspace files. The installed Files app now opens here.
- **Workspaces as drives.** Files › Workspaces lists each workspace you're in. Each one shows its
  documents, sheets, whiteboards and pinned files as real files that open on their own pages,
  instead of the old System › Workspaces mirror folders.
- **Ask about this.** From a file's preview, the details pane, the editor page or a selection,
  start a chat with those files attached. **Summarize** does the same with the question already
  filled in. It works for files shared with you and workspace files too, and a sheet or whiteboard
  is read as its contents.
- **Drive-style clicking and keys.** A click selects an item and shows its details; a
  double-click or Enter opens it. ⌘/Ctrl-click and Shift-click add to the selection. The arrow
  keys move through the list, F2 renames, and typing jumps to a name. On a touchscreen a tap
  still opens. Trashing or moving something shows an **Undo**.
- The details pane shows the owner, the location, real created and modified dates, and how many
  earlier versions are kept.
- `/files/f/<id>` links straight to any file you can open.
- Phones get Files tabs along the bottom (Home · Files · "+" · Shared · More). Documents stay
  editable on a phone; sheets and whiteboards open read-only there, including workspace
  whiteboards, which used to say "best on desktop".
- **Word, Excel and PowerPoint files can be uploaded.** So can OpenDocument (.odt, .ods, .odp)
  and RTF files. Each one is checked before it's opened: no zip bombs, and it really is the
  format it claims. Their text is read in the background, so Drive search, workspace answers
  and "Ask about this" can find and cite what's inside. (WP-4.3, R-219)
- **Word files preview in place.** A .docx shows with its layout, inside a sandboxed frame
  where nothing in the file can run. Excel, PowerPoint and OpenDocument files show their text
  (sheet by sheet, slide by slide).
- **Open in Promptly Docs.** From a Word file's preview or details pane, or with **New → Import
  Word document…**, you get an editable Promptly document next to the original. It keeps
  headings, bold, italics and underline, lists, tables (merged cells too), links, images and
  footnotes. A note at the top lists anything that didn't come across: comments, tracked
  changes (accepted), text colours, alignment, headers and footers, and images in formats like
  EMF. The original Word file is never changed.
- **Download as Word.** A Promptly document's Download, and Export on its page, now give a
  .docx that opens in Word and LibreOffice, with images. HTML, Markdown and PDF stay in the
  editor's download menu.
- **Excel and OpenDocument spreadsheets preview as a grid.** An uploaded .xlsx, .xlsm or .ods
  shows its first rows and columns as a read-only grid, with its formatting (bold, colours,
  fills, merged cells, column widths) and a tab for each sheet. (WP-4.4)
- **Open in Promptly Sheets.** From a spreadsheet's preview or details pane, or with **New →
  Import spreadsheet…**, you get an editable, shareable Promptly sheet next to the original
  (.xlsx, .xlsm, .ods, .csv). It keeps fonts, colours, fills, alignment and wrapping, number
  formats (money, percentages, dates as real dates), merged cells, column widths, row heights,
  borders, frozen header rows, hidden rows and tabs, web links and formulas. Formulas saved
  without a result (by a script, say) are worked out when the sheet opens. A note at the top
  lists anything that didn't come across: charts, pictures, cell comments, conditional
  formatting, drop-down lists, pivot tables and macros. The original file is never changed.
  AI-generated spreadsheets get the same button.
- **Documents format like Docs and Word.** Text alignment (left, centre, right, justify),
  font and font size, subscript and superscript, clear formatting, a "Normal text / Heading"
  style menu, page breaks (a new page when printed, in PDFs and in Word), LaTeX formulas
  (inline or on their own line; click one to edit it), and find and replace (Ctrl/⌘+F,
  Ctrl/⌘+H; match case, step through, replace one or all). (WP-4.5, R-226)
- **Pictures can be resized, aligned and captioned.** Drag a corner; left / centre / right
  and a caption from the image's options. Size and caption carry into previews, PDFs and Word.
- **Block options.** With the cursor in a table: insert rows and columns, delete them, merge
  and split cells, header row / column, delete the table. In a callout: change its colour or
  remove it. In a column layout: add, remove, or undo the columns. Selecting text brings up a
  formatting bubble (it was built but never shown). The YouTube link and the "/" menu now use
  an in-app box instead of the browser's prompt. (R-226)
- **Comments on documents and notes.** Select text and choose Comment (or Ctrl/⌘+Alt+M): the
  words are highlighted and the comment sits in a panel beside the document, staying with its
  words as anyone edits. Reply, resolve and reopen, edit or delete your own, and @-mention
  people who can open the document — they're notified, and so is everyone in a thread when
  someone replies. Comments appear live for everyone with the document open. Anyone who can
  open it reads them; editors add, reply and resolve; the owner (or a workspace admin, for a
  note) can remove any. Drive documents had no comments at all; notes' comments move into the
  editor, anchored, with their history kept. (WP-4.5, R-227)
- **Open a Markdown file as a document.** A .md file's preview and details pane offer "Open in
  Promptly Docs", with headings, tables, checklists, strike-through and pictures intact
  (pictures in automation-made notes come through too). (WP-4.6, R-229)
- **Mentioning someone in a note tells them.** `@` in a workspace note now offers people and
  dates (it only ever offered items); picking a person notifies them, if they can open the
  note, and the mention remembers who it is. (R-232)
- **Move blocks on a phone.** The block bar has move up / move down (Alt+Shift+↑/↓ on a
  keyboard), since dragging needs a mouse. (R-231)
- **AI search of your files (opt-in).** Under Files ▸ AI search you can let chat and search find
  what's *inside* your documents, sheets, whiteboards, PDFs, Office and text files — not just their
  names. It's off until you turn it on (the dialog names the model your files' text goes to), shows
  its progress, and can leave folders out ("Leave out of AI search" on a folder's menu, which
  covers everything inside it). Indexing runs in the background a few files at a time, only
  re-reads files that changed, and reuses work a workspace has already done for the same file.
  Files people share with you are included when they've turned it on too. Turning it off removes
  the index of your files. (WP-5.1)
- **Chat answers from your files, with sources that open in the right place.** With AI search
  on, chats can look inside your files (a new "In chats" choice: when it's relevant — the
  default — every reply, or never). Each passage used is listed under the reply as a source;
  clicking it opens the PDF at the page, the sheet at the tab and row (selected), or the document
  with the passage found. Files shared with you count too, and only ones you can open. In "every
  reply" mode a lookup only happens when your files actually mention something from the question,
  so a "thanks" doesn't drag in passages. (WP-5.2)
- **Ask the assistant to find, open and organise your files.** In any chat (with Tools on) it can
  list your files by type, folder, owner, date or part of the name, read one — a Doc, a Sheet tab by
  tab with row numbers, a PDF page by page, an Office or text file, long ones in parts — and propose
  tidying up: new folders, moves and renames. Nothing changes until you press Apply on the preview
  card, which lists every step; Apply re-checks everything and does all of it or none of it. Only
  your own files can be moved or renamed, and system and workspace folders stay put. Searching
  inside your files can now be narrowed the same way ("in my Taxes folder", "PDFs only"). (WP-5.3)
- **One search box for Files.** Words inside files match as you type ("budg" finds "budget"),
  names in any language match as written, and folders shared with you come up alongside yours.
  Every result shows where it lives — "My files / Taxes / 2025" or "Shared by sam / Projects" — and
  "Show in folder" on its menu opens it. Filter chips for Docs, Sheets, PDFs, Office files, Images and
  Folders (more under "More…"). Searching from inside a folder searches that folder, with a chip
  to widen it to everything. With AI search of your files on, the results page also lists files
  related by meaning — "car insurance" finds the motor policy that never says either word — and
  only ones that clearly stand out, not just the nearest. (WP-5.4)
- **Ask AI in the editors.** Docs, Sheets and Whiteboards have an "Ask AI" panel: ask about the
  file you have open (it reads the file and what you've selected), keep a short back-and-forth, copy
  an answer, or insert it into a document at the cursor. (WP-5.5)
- **Sheet AI.** An "AI" button in Sheets fills a column from the other columns ("the spending
  category of each item"), cleans the selected cells (stray spaces, capitalisation, date and number
  formats — formulas are left alone), builds a new tab from a description (with working formulas),
  and explains the formula in the selected cell. Every suggestion is shown first and only applied
  when you press Apply — then it's an ordinary edit you can undo. (WP-5.5)
- **Convert with AI.** From a photo's or PDF's preview: turn a table into a Sheet, or a scanned
  letter or page into a Doc. It makes a new file beside the original (which is left alone) and opens
  it. A PDF with real text only needs a chat model; photos and scans need the vision model an
  administrator picks under Admin ▸ Models. (WP-5.5)
- **Comments on sheets and whiteboards.** Like documents, a Sheet or Whiteboard now has a Comments
  panel: comment on a cell ("Comment on B5") or on the shapes you've selected, reply, resolve and
  @-mention people who can open the file — they're notified, and the link opens the file on that
  cell or those shapes. Threads are listed in sheet order, show which cell they're on, and update
  live for everyone with the file open. Works for workspace sheets and boards too, with the
  workspace's roles. (WP-6.1)
- **Version history for documents, sheets and whiteboards.** One History panel for all three: the
  versions kept as the file is edited, grouped by day with who edited, and what restoring one would
  change — the paragraphs for a document, the changed cells (and tabs) for a sheet, the shapes for a
  whiteboard. Editors can name a version (named ones are never cleared away), keep one forever,
  save a version now, and restore. A restore is exact — merges, formats and images included — and
  happens for everyone at once: what's there is kept as a version first, and anyone with the file
  open sees it reload onto the restored version (an editor that was offline reloads when it comes
  back, instead of merging the newer content back in). (WP-6.2)
- **Two people can change a sheet's layout at once.** Tabs, merged cells, frozen rows, column
  widths and row heights, hidden rows and columns, borders, pictures, conditional formatting, links
  and validation now update live for everyone, like cell values already did — one person merging
  cells while another adds a tab keeps both, where the last save used to win. (WP-6.3)
- **Page setup for Docs.** Paper size (A4, Letter, Legal, A5, A3), orientation, margins, a header,
  a footer and page numbers, from the download menu → "Page setup…". It's part of the document, so
  everyone editing sees it, versions keep it, and it shapes the PDF, the Word file and printing.
  A Word file opened in Docs keeps its paper, margins, header, footer and page numbers. (WP-6.4)
- **Print preview for Docs** — the document's PDF, shown before you print or download it; Print
  prints exactly those pages. (WP-6.4)
- **A real PDF viewer.** PDFs in Files now open in a full viewer: select and copy text, search
  (Ctrl+F), follow links, **fill in forms**, highlight, add text notes and draw, and work with
  pages — delete them, save some as a new PDF, or add pages from another PDF or a picture. **Save**
  keeps your changes as the file's new content and the previous copy in its version history (name
  it, keep it, see what changed, restore it); anyone who can only view a PDF can still save a
  filled-in copy to their own files. Saving over a newer copy someone else saved is refused and
  offers a copy instead. PDFs can now be shared with editors. (WP-6.5)
- **Links that let people comment or edit.** A share link can now say what people with it can do —
  view, comment or edit (comment and edit on Docs, Sheets and Whiteboards; edit on PDFs). Comment
  and edit links are always for signed-in people: opening one takes them straight into the file
  with that role, they show on the file's people list ("via link"), and revoking or letting the
  link expire ends it. A person you've shared with directly keeps their own role. (WP-6.6)
- **iPhone photos and phone videos.** HEIC/HEIF and AVIF photos and MP4, MOV, M4V and 3GP videos
  can be uploaded; HEIC photos get thumbnails and a preview (browsers can't show HEIC themselves),
  go to the AI as JPEGs, and become JPEGs when dropped into a document. Camera originals — TIFF,
  DNG, CR2, CR3, NEF, ARW — are kept as they are (checked by ExifTool, since they can't be sniffed
  otherwise) and downloadable. (WP-7.3)
- **A photo's own details** in the Files details pane: when it was taken (and how we know — from
  the photo, the video, the file's date on your device, or when it was uploaded), where, its
  dimensions, the camera, a video's length and codec, and whether it's a Live Photo (its photo and
  video are paired) or a motion photo. The owner can correct the date and the place, or remove the
  place, without changing the original. Read in the background as files arrive; earlier photos
  are filled in hourly. (WP-7.3)
- **Photo and video thumbnails, previews and web-playable videos**, made in the background by a
  new **media worker** container with its own CPU budget, so a phone backup of hundreds of photos
  never slows chat. Photos get a small WebP grid tile and a larger preview (upright, whatever the
  camera's orientation tag says — and from the embedded preview for camera raws); videos get a
  poster frame and, when the browser can't play them as they are (an iPhone's HEVC .MOV, say), an
  H.264 MP4 that starts playing before it's downloaded. Videos that already play are copied, not
  re-encoded. The grid shows a blurred placeholder (ThumbHash) until each tile arrives. Encoding
  on an NVIDIA, Intel or AMD GPU is opt-in (`docker-compose.media-nvidia.yml`,
  `-vaapi.yml`, `-qsv.yml`), falling back to the CPU. Admin → Storage shows how many are ready,
  being prepared or failed (with a retry), and the space renditions take — never counted against
  anyone's quota, and made again if lost. (WP-7.4)
- **Big uploads that survive a dropped connection or a refresh.** Files over 64 MB now go up in
  50 MB pieces through a new `tusd` service, so a 4 GB phone video uploads under Cloudflare's 100 MB
  request limit, picks up where it stopped if the connection drops, and — after a refresh or a
  closed tab — is listed in the uploads panel to carry on: choose the same file again and it
  continues from where it got to. Each upload is checked before a byte is sent (allowed type, the
  folder, disk space, your storage including your other uploads still under way) and filed through
  the normal upload path at the end. An admin sets the largest single upload (Admin → App settings;
  10 GB by default). (WP-8.2)
- **Drag a folder in and its folders come too** — the whole tree is recreated in Files (system
  clutter like `.DS_Store` left behind). (WP-8.2)
- **Files that are already there aren't uploaded again** — before a batch goes up, any file with the
  same name and size in that folder is compared byte for byte, and identical ones are skipped
  ("Already there"). Re-uploading a camera roll or last week's folder takes seconds. (WP-8.2)
- **Uploads show wherever you are.** Away from Files a small pill shows the progress (click it for
  the list), a failure tells you even if you've moved on, and a workspace's drive shows the uploads
  panel too. (WP-8.2)
- **Account → Devices: an app password for each device that syncs.** Phone and desktop sync apps
  (and scripts) sign in with a password made here, never your account password: it's shown once
  with the server address and username to copy, kept only as a hash, limited to what you tick (see
  and download files / add, change and delete files / upload big files), shows when and from where
  it was last used, and **Revoke** cuts that one device off at once without touching the others. A
  disabled account's devices stop too; wrong attempts are rate-limited per address like sign-ins and
  recorded in the audit log. Big uploads accept one (with "upload big files") as well as a
  signed-in session. (WP-8.3)
- **Sync your files with WebDAV at `/dav/`.** rclone, Finder, FolderSync, PhotoSync and other WebDAV
  clients see My files and sign in with a device's app password ("see and download" to read, "add,
  change and delete" to write). It follows the web app's rules: a deleted file goes to the trash
  (and a mass delete from one device can be undone in one go — the alert names the device),
  writing over a file keeps the old one as a version, uploads count against your storage and the
  same file types are allowed. Big files stream straight to disk (up to the admin's largest-upload
  limit), downloads resume, modified times are kept, and rclone checks every file by hash. Docs,
  Sheets and Whiteboards appear as read-only exports (.html, .xlsx, .excalidraw), and workspace
  folders are read-only there — change them in Promptly. (WP-8.4)
- **Camera Uploads.** A folder at the top of My files where phone backups and shared photos land,
  sorted into a folder for each year and month by when each photo or video was taken (or, without
  that, when the phone last changed it). The same photo arriving twice is kept once, and a phone
  app re-sending its whole camera roll over WebDAV stores nothing new. Photos and videos shared to
  the installed Promptly Files app go there too (videos can be shared now). It's in the Files rail,
  and a folder you'd already called "Camera Uploads" becomes it. (WP-8.5)
- **How to connect each device** — Account → Devices now explains, for iPhone (PhotoSync), Android
  (FolderSync / PhotoSync), Mac (Finder), Windows (rclone + WinFsp) and rclone, what to enter, with
  your server and username filled in, and what to expect (deletes go to Trash, read-only Docs,
  types that aren't accepted, the 100 MB limit through a Cloudflare tunnel). (WP-8.5)
- **The photo library behind Photos** — every photo and video you own, by when it was taken (in the
  time zone it was taken in, so a trip abroad reads in order), with counts per month and a fast
  way to page back years. Left out: the trash, Chat Uploads, workspace folders, the video half of a
  Live Photo, and any folder you mark "Hide from Photos". Photos can be archived out of the
  timeline, and favourites are your starred files. Correcting a photo's date moves it. The Photos
  pages themselves come next. (WP-9.1)
- **Photos** — Files → Photos (and a Photos tab on a phone): every photo and video you own, newest
  first, in a grid by day where each keeps its own shape, with a soft preview until the picture
  arrives. A date scrubber down the side jumps to any month in an instant, even in a 50,000-photo
  library. Select photos (hover and tick, Shift-click for a run, or press and hold on a phone) to
  favourite, archive, download or trash them together; Favourites and Archive have their own views.
  A folder's menu in Files can now hide it from Photos (scans, receipts, work). (WP-9.2)
- **The photo viewer.** Open a photo and move through the whole timeline with the arrows, the
  keyboard or a swipe (swipe down on a phone to close). Wheel, pinch or double-click to zoom — the
  full-size original takes over as you zoom in — and drag to look around. Videos play and seek
  straight away. A Live Photo, or an Android motion photo, plays its moment of video while you hold
  LIVE. The info panel (press i) shows when and where it was taken and the camera, lets you correct
  the date or place, says who can see it, and links to it in Files; favourite, download, archive
  and trash are on the top bar. (WP-9.3)
- **Albums.** Select photos and choose Add to album (or make a new one), or open Photos → Albums.
  An album holds the photos themselves, not copies — a photo can be in many albums and stays in
  its own folder. Share an album with people who can look, or who can add photos too: what they
  add stays in their own Files (uploads go to their Camera Uploads) and counts against their own
  storage, and if they leave, their photos go with them. Rename an album, pick its cover, show it
  oldest first, or delete it (the photos stay). Only your own photos can go into an album. (WP-9.4)
- **Share an album with a link — no account needed.** An album's Share window can make a link (with
  a QR code to show on your phone): anyone who opens it sees the album as a gallery, looks through
  the photos and plays the videos, and can download one or all of them. Nothing they get says where
  a photo was taken, unless you tick "include where photos were taken" for that link. Turn the link
  off and it stops at once; a photo you take out of the album can't be reached through it. Album
  links are listed with your other links. (WP-9.5)
- **Import from Google Takeout — reading it first.** Files → Import → Google Takeout: add every
  .zip or .tgz part Google gave you (big ones upload in pieces and carry on after a dropped
  connection; they don't count against your storage), then Check the archives. Promptly reads
  every part, matches each photo with the details Google kept beside it — the date taken (with
  any correction you made in Google Photos), the place, the description, favourites, archived,
  albums — whichever of Takeout's many naming quirks it uses, and shows what's in it before
  anything is imported: photos and videos, years, albums, Drive files, what's left out (Google's
  trash, other Google products). A part that didn't finish downloading is named plainly.
  Cancelling deletes what was uploaded. (WP-10.1)
- **…and importing it.** Import brings it all in: photos and videos into Camera Uploads by the
  month they were taken, with Google's date (and any correction you made there), place and
  description — shown in a photo's info — favourites starred, archived photos still archived,
  albums recreated (or added to, if you already have one by that name), and Drive files in a
  "Google Drive" folder with their folders kept. Anything you already have — a phone backup, an
  earlier import, the same photo twice in the Takeout — isn't copied again, so importing the same
  Takeout twice adds nothing. It runs in the background with a progress bar and a notification
  at the end, stops cleanly if your storage fills up (and carries on from there when started
  again), lists anything it couldn't take, and deletes the uploaded parts when it's done.
  (WP-10.2)
- **Import a folder of photos, or your Apple Photos.** Zip any folder — an old laptop's
  Pictures, a camera card — and import it: photos and videos go to Camera Uploads by the date
  inside them (or the file's own date when they have none), and every other file keeps its
  folders under "Imported – <name>". An Apple export brings the XMP sidecars Photos writes
  (date, place, description) and, from an iCloud Photos download, the dates and favourites in
  Apple's photo list — photos deleted there are left out. Mac and Windows clutter
  (`__MACOSX`, `.DS_Store`, `Thumbs.db`) is skipped. (WP-10.3)
- **Export my library.** Files → Import & export → Export my library downloads everything you own
  as an ordinary folder tree: your files in their folders with their original names and dates,
  documents as Word files, spreadsheets as Excel, whiteboards as Excalidraw, and beside each photo
  and video its date, place, description, favourite and albums — as a `.json` in Google Takeout's
  format (which other photo apps import) and an `.xmp` (for Lightroom, digiKam and the like). It
  comes in parts of 2, 10 or 50 GB, each put together as it downloads, so the server needs no
  spare room for a copy; a part that stops is just downloaded again. The links last a week.
  Importing an export into another Promptly (as "A folder of photos") brings back its dates,
  places, favourites, archived photos and albums. (WP-10.4)
- **Photos know where they were taken.** A photo with a location now shows the place by name —
  "Noosa Heads, Queensland, Australia" — worked out on your own server from GeoNames' list of
  places (about 10 MB, downloaded once, the first time a photo has a location; on a box with no
  internet the admin can drop the files in). Promptly also measures each photo's sharpness and
  exposure and spots near-identical shots, ready for search, best-shot picks and clean-up. It
  all runs in the background, newest photos first, and Photos shows how far it's got;
  Admin → Storage shows every library's progress. (PH-2, WP-PH2.1)
- **Search your photos by what's in them.** Photos → Search finds "dog on the beach", "birthday
  cake" or "snow" by looking at the pictures themselves, closest first — on your own server, with
  nothing sent anywhere. It runs on the new bundled `photos-ml` service (started by
  default; it downloads about 1.5 GB of models once and uses about 2 GB of RAM); new
  photos are searchable within a minute or two, and an existing library is worked through in
  the background (about 4 photos a second on 2 cores). (PH-2, WP-PH2.2)
- **Face recognition, if you want it.** Photos → settings → Recognise faces finds the faces in your
  photos — on your own server, only in your own photos — ready for naming the people in them. It's
  off until you turn it on, and turning it off deletes every face found at once. A photo's info
  says how many faces are in it. (PH-2, WP-PH2.3)
- **Photos know the animals in them.** Dogs, cats, birds, horses and other animals are found in
  your photos (with the `photos` service), named in a photo's info ("A dog"), and remembered
  well enough for naming your own pets later. (PH-2, WP-PH2.4)
- **Photos read the text in them.** Signs, menus, receipts and screenshots are read (on your own
  server), shown in a photo's info, and searched first — "nasi goreng" finds the menu you
  photographed, even while the rest of the photo models are down. (PH-2, WP-PH2.5)
- **Describe my photos (optional).** An admin can choose a "Photos vision" model (Admin → Models →
  Defaults); anyone can then turn on Photos → settings → Describe my photos to get a sentence and
  tags for each photo, searchable ("lighthouse", "birthday party"). Before turning it on you see
  which model it is and whether it runs on this server; a cloud model gets the photo at most
  1024 px and without its location, and describes no more than the admin's monthly limit.
  Turning it off deletes the descriptions. (PH-2, WP-PH2.6)
- **People & pets.** Photos → People shows who's in your photos. With face recognition on, faces
  that look alike gather into people; "Who is this?" asks you to name each once, and every photo of
  them follows. Rename, merge two that are one person, hide someone, and mark which person is you.
  A photo's info lists who's in it — tick to confirm, cross for "not them" (never suggested
  again), or name someone new; what you say is never undone by the machine. Pets work the same
  way: name your dog in a couple of photos and its other photos are matched — only against your
  pets of the same kind, and when it isn't sure (two black dogs) it asks rather than guesses.
  Turning face recognition off deletes the people found too. (PH-3)
- **Who they are to you, and fixing a mix-up.** On a person's page, say who they are to you — "my
  wife", "Mum", "my son" — in your own words; only you see it. And if two people got mixed
  together, the Faces view lets you pick the faces that are someone else and move them to another
  person or someone new; they aren't put back. (PH-3)
- **Ask your photos.** Search Photos — or ask in chat — the way you'd ask a friend who'd seen them
  all: "me and my wife at Noosa", "Max on the beach", "videos from Christmas 2022", "the menu
  that says nasi goreng". It works out who (you, names, "my wife"), which pet, where, when and what
  it shows, finds the photos with everyone in them, best first, and folds a burst of near-identical
  shots into one. It shows how it read the question; if nothing matches exactly it widens the
  search and says how ("any date"), and names it doesn't know are said, not guessed. In chat the
  photos appear as a gallery under the answer (tap to open), follow-ups narrow the same set ("just
  the beach ones", "without Sarah"), and with a Photos vision model it can look at the photos
  themselves for things search can't tell ("where we're both smiling"). Only your own photos are
  ever searched — and the photos in albums shared with you (PH-4).
- **Smart albums.** An album can be a question that keeps itself up to date — "always add Sarah",
  "Max at the beach", "videos from Japan, 2024". Build one under Albums → **New smart album**
  (who, which pets, where, when, what it shows, words in it, videos or favourites only) and see
  how many photos match before saving, or turn any photo search into one with **Save as smart
  album**. New photos that match join it by themselves; a photo you take out stays out, one you
  put in by hand stays in, and renaming someone doesn't break it. Edit what it holds, or stop it
  updating, from the album's ⋯ menu. (PH-5)
- **Memories.** The Photos home now opens with memories made from your own library: **On this
  day** ("3 years ago"), **trips** (spotted by themselves after you've been away from home for a
  couple of days — "Trip to Japan, 12–18 March 2024"), a pet's **first year**, and **You & Sarah**.
  Open one to see its photos, **Play** it as a slideshow (Space pauses), keep it as an album, or put
  it away for good; "Don't show memories of …" (also in that person's ⋯ menu in People) stops
  them for someone. Memories are only ever yours — nothing is shared or sent anywhere. (PH-5)
- **Photos map.** Places → **Map** shows where your photos were taken, clustered; click a cluster
  for its photos (or zoom in). It works offline: the country outlines are bundled, and an admin can
  add a detailed basemap for streets and towns by putting a Protomaps `.pmtiles` extract at
  `uploads/.maps/basemap.pmtiles` (or `MAP_PMTILES`). Nothing is fetched from map servers on the
  internet. (Photos)
- **Places in Photos.** A new **Places** view lists the countries your photos were taken in, most
  photos first, then each country's towns, then the photos taken there. (PH-5)
- **Clean up Photos.** Photos → **Clean up** finds what you may not want: duplicates (the same
  file twice, a re-saved copy, or a burst of near-identical shots — the best of each is kept and the
  rest picked for you), blurry shots, screenshots and videos over 100 MB, with how much space each
  frees. Move what you pick to the trash (with Undo, and recoverable until the trash is emptied), or
  **Keep** it so it isn't suggested again. Favourites are never called blurry. (PH-7)
- **Edit photos.** The viewer's **Edit** button crops (free, original, square, 4:3, 3:2, 16:9),
  rotates, flips and adjusts brightness, contrast and saturation. The edit is kept beside your
  original, which is never changed: the grid, viewer, albums and shared links show the edited
  photo, **Download edited** gives you a full-size JPEG of it, and **Revert to original** undoes it
  any time. (PH-7)
- **Set up Photos.** A guided start for new libraries — from a banner on the Photos home (or the
  empty Photos page): bring your photos in (upload, move in from Google/Apple Photos or a folder,
  or back up your phone), switch on face recognition and photo descriptions, say which person is
  you, name the people and pets found, then try a first question. Every step can be skipped and
  finished later. (PH-7)
- **Every file has a version history.** Uploading a file with a name that's already in the folder
  and choosing **Replace** now keeps the old one as a version — it's the same file, so its shares,
  star, comments and links stay (it used to go to the trash as a different file). An AI document
  re-made after you edit its source keeps what it replaces the same way (it was overwritten). From
  a file's details: **Version history** — see what changed (line by line for text), download any
  version, name it, keep it forever, or restore it. Versions are kept for 30 days, then each file
  keeps its newest 100; named and keep-forever ones always stay. (WP-8.1)
- **Folders of any size open straight away.** A folder now arrives 200 files at a time as you
  scroll, and only the rows on screen are drawn, so a 3,000-photo folder lists in about 65 ms and
  keeps 30 rows in the page instead of 3,000. Trash and Starred page the same way. Opening another
  folder keeps the last one on screen until the new one is ready rather than flashing a skeleton,
  and a folder you've just made (or a file you've just uploaded on its own) is scrolled into view.
  (WP-7.6)
- **Zip downloads that finish.** "Download" on a folder or a selection is now made in the
  background — with a progress note for big ones — and then downloaded by your browser with its own
  progress and resume. Folders keep their whole structure, empty ones included; photos and videos
  are stored as they are rather than squeezed again. Up to 10,000 files or 20 GB at a time; zips
  are cleared a few hours later. (WP-7.6)
- **A workspace's Drive is the Files browser** — the same rows, grid view and preview as your own
  files, and uploads go through the same upload queue (progress, retry, the panel). Each file still
  shows who added it, whether it's indexed, and whether the workspace's chats can use it, with
  Include / Leave out of context in its menu. (WP-7.6)
- **Videos play in the preview** — straight away, and you can skip to any point without
  downloading the whole file. An iPhone's HEVC video plays from its web copy once the media worker
  has made it (with its poster and a "Preparing…" note until then); an MP4 plays as uploaded
  meanwhile. Photos open on their light 1440 px preview, with **Full size** for the original.
  (WP-7.5)
- **Photos, videos and downloads come from short-lived signed links** that nginx serves itself:
  seeking works, the browser caches tiles across visits, scrolling a big photo folder no longer
  runs into the API's rate limit (links have their own budget), and nothing passes through the
  app server. A link names one file and one size, works for a few hours for the person it was
  given to, and stops at once if the file is unshared or they sign out everywhere. (WP-7.5)
- **Admin → Storage** — is every file still what was stored? Every night Promptly checks that
  each file is there and the right size and re-reads a share of them against their fingerprints
  (the whole library over a few nights). A file that's gone missing or changed alerts the admins,
  is listed with "Check again" for after you've restored it, and shows a "restore it from a backup"
  note to whoever opens it. Also on the page: disk space, the quarantine, and whether the database
  keeps page checksums. (WP-7.2)
- **Uploads pause before the disk fills** — below 5% or 10 GB free (`DISK_MIN_FREE_PERCENT`,
  `DISK_MIN_FREE_GB`), with an alert to admins at 85% and 95% full. A full disk can corrupt the
  database. (WP-7.2)
- **"Restore everything this device deleted."** If one device sends more than 500 files or 5 GB to
  the trash within ten minutes, the owner is told at once and can put it all back in one click from
  the link. (WP-7.2)
- **Database page checksums** for new installs; existing ones can switch them on offline (README →
  "Database checksums"). (WP-7.2)
- **Commenter**, a role between Viewer and Editor when sharing a Doc, Sheet or Whiteboard with
  someone: they can read and comment but not change it. In a document they select text and
  choose Comment; on a whiteboard they can comment on the board as a whole. (WP-6.6)

### Changed
- **Photo understanding and Office previews just work after an update.** The `photos-ml` and
  `convert` services are no longer optional compose profiles: a plain `docker compose up -d`
  (and `update.ps1` / `update.sh`) starts them, and the backend finds the converter without a
  `CONVERT_URL` line in `.env`. The first start downloads about 1.5 GB of photo models.
- **Photos is easier to use with a keyboard and a screen reader.** A photo in the grid is now an
  "open" button with a separate "select" button beside it, rather than one button inside another.
  The editor's crop box moves with the arrow keys and resizes with + and −. The app's content area
  is marked as the page's main region, so you can skip straight to it. Places now says when it
  couldn't load. An automated accessibility check (axe, WCAG 2.1 A/AA) covers the Photos screens.
  (PH-7)
- **Photos stays responsive on big libraries.** Clean up and memories now do their work off the
  server's main loop, so other people's requests don't wait while they run. On a 50,000-photo
  library the timeline loads in about 20 ms, search in about 90 ms, places in about 0.3 s, Clean up
  in about 1.7 s, and memories are made in about 1 s at most hourly. An opt-in scale test
  (`PROMPTLY_PERF=1`) checks these. (PH-7)

- **Pillow 10.4 → 12.3**, with pillow-heif 1.8 for HEIC (and AVIF built in), and rembg 2.0.65 →
  2.0.85. (WP-7.3)
- **Photo and video metadata is read by the media worker** rather than the general background
  worker, and earlier files are picked up by its sweep every 20 minutes rather than an hourly
  backfill. Adds rawpy 0.27.1. The update, rollback and restore scripts stop and health-check the
  media worker along with the others. (WP-7.4)
- **One row for every Drive list** — My files and Shared (list and grid), Recent, Starred, Trash,
  search results and a workspace's drive all draw the same row; there were four that had drifted
  apart. A page has one set of actions and one menu rather than one per row. (WP-7.6)
- **Uploads refresh only the folder they landed in** (and Recent and the storage pill), not every
  Drive list. The folder tree and the Move picker load just folders, not each folder's files.
  (WP-7.6)
- **Uploading into a workspace is Drive's upload** — checked, stored and audited the same way,
  then added to the workspace. The workspace upload had its own older copy that skipped the
  refusal audit. (WP-7.6)
- **Downloads are the browser's own** — with its progress bar, resume and no size or time limit —
  instead of being pulled into the page first, which failed on any download over 30 seconds.
  (Sheets and whiteboards, exported on the fly, still come through the page.) (WP-7.5)
- **nginx serves uploads directly** from a read-only mount of the uploads folder. If you run your
  own server block in `nginx/local/` (for TLS), add `include /etc/nginx/promptly/media.conf;` to
  it, or photos, videos and downloads won't load there; the update scripts warn if it's missing.
  (WP-7.5)
- **Files on disk that nothing refers to are set aside, never deleted on their own** — a weekly
  walk moves them to `.quarantine/` in the uploads folder for an admin to look at and empty. (They
  used to be deleted after 14 days.) (WP-7.2)
- **Uploads are written safely and fingerprinted.** A file is streamed into a staging area, checked,
  and only then moved into place — a failed, rejected or interrupted upload never leaves a
  half-written file behind. Every upload now records its SHA-256 and SHA-1, and files from before
  this are fingerprinted in the background, a few minutes an hour. (WP-7.1)
- **Uploads can live on another disk** — set `PROMPTLY_UPLOADS_DIR` (an array, a NAS share) and keep
  the database on fast storage; the backup and restore scripts follow it. Backups now skip
  thumbnails and other files that can be regenerated. (WP-7.1)
- **pdf.js 5 → 6.4** for every PDF in the app, with its CMaps, standard fonts and image decoders
  served from Promptly itself — PDFs with Chinese, Japanese or Korean text, unembedded fonts or
  JPEG 2000 / JBIG2 images now show properly. (WP-6.5)
- **Versions start counting toward your storage** 30 days after this update ("Versions (free until
  …)" in the storage meter until then). (WP-6.2)
- **Restoring a document version is exact.** It used to paste the old text into the live document
  (losing formatting it couldn't paste); now the server puts the old version back as it was.
  (WP-6.2)

- **Turning on "Require two-step verification" now reaches people already signed in:**
  everyone without it (except the admin making the change) is signed out and sets it up
  when they sign back in. (R-190)
- **CSV user import runs in the background** and keeps its results — including the
  temporary passwords — for an hour, so a large roster no longer times out and loses
  them. Rows are checked with the same rules as the add-user form. (R-137)
- **One password rule everywhere.** The screens disagreed with each other and with the
  server (8, 10 and 12 characters); they now show what the server actually requires, and
  the trusted-device period is read from the server too. (R-194)
- **Chat says what a connector did:** "Home Assistant · Unlock · front door" instead of
  "ran 1 tool call", and actions that change something outside Promptly are marked.
  Command runs show the command's name. (R-166)
- **Command History records more:** Home Assistant satellite runs, near misses ("no
  exact match — nearest was …"), two commands claiming the same phrase, and crashes. It
  also says where a run came from (voice, satellite, the / menu, the library). If a shared
  command uses the same phrase as one of yours, yours now runs. (R-163, R-196)
- **The Home Assistant device picker** tells apart same-named devices in different rooms
  (and sends the room), says Lock/Unlock and Open/Close for locks and doors, no longer
  picks an action for you, and turns on "Ask before running" for locks, doors and alarms.
  Arguments are sent as the type the tool expects, so a brightness of 50 isn't "50".
  (R-164)
- **Dictation and voice mode no longer wait behind a meeting being transcribed.** Short
  clips have their own lane on the transcriber, and a slow one now says it's busy rather
  than unreachable. (R-197)
- **Voice mode turns don't get connector tools,** which could make a spoken reply claim
  an action it never took. Voice acts through your commands. (R-198)
- **The desktop composer has the phone's shape:** + (attach files, talk, subchat), the
  search and tools menu, then the mic and send. Enhance appears once you've typed
  something, and Queue only while a reply is coming in. They used to sit greyed out the
  rest of the time. (V5)
- **The sidebar footer is one account menu.** Your name opens Account, Admin, Archived
  chats, workspace invites, Feedback, Theme and Log out. Only the inbox keeps its own
  button. The footer used to be seven rows, about a third of the sidebar. (V6)
- **Usage now includes the work behind the scenes.** Chat titles, memory updates,
  compaction, prompt enhance, image descriptions, workspace Ask, meeting notes and
  automations all use the model too, but only the main chat reply used to count. They now
  count towards each person's usage and budget, without being counted as messages sent.
  (WP-1.5)
- **The Effort control is shown only where it works.** On direct Anthropic and Ollama
  connections it did nothing, so it's hidden there (refresh the provider's models to update
  existing ones). It now works with Google Gemini. (WP-1.5)
- **Ollama:**
  - the bundled Ollama gets a larger context window (8,192 tokens, set with
    `OLLAMA_CONTEXT_LENGTH`), so long prompts are no longer silently cut short;
  - the context meter shows each local model's real window;
  - "Refresh" picks up pulled models for every Ollama provider, not just the built-in one.
  (WP-1.5)
- OpenRouter's "Test connection" is quick again. It no longer downloads the whole catalog
  and every model's details just to count them. (WP-1.5)
- **Users an admin creates now choose their own password on first sign-in.** The flag was
  recorded but never enforced. It's on by default in the Create user dialog and can be
  unticked. (WP-1.5)
- **Setup wizard:**
  - it picks up where you left off after a reload;
  - the "Local" options are offered only when this install actually has Ollama, and the
    embedding model is downloaded and tested before it's switched on;
  - with an OpenAI key, OpenAI embeddings are one click;
  - you choose the default chat model for everyone;
  - the test email names the address it really went to. (WP-1.5)
- `.env` settings now reach Promptly. Only a handful of variables were passed into the
  containers, so documented options such as `COOKIE_SECURE` and the rate-limit settings had
  no effect. A provider key in `.env` now also loads that provider's model list at start-up.
  (WP-1.5)
- **Promptly opens faster.** The first page load downloads about a third less (1 MB down
  to 690 KB compressed). The charts library and the document editor were being fetched on
  every page because of how shared code was bundled; they now load only on the pages that
  use them. (WP-1.3)
- **Edit or regenerate any message, not just the last one.** Earlier versions stay
  available through the version arrows. You can also resend a message unchanged
  ("Resend"), and a question left without an answer offers "No reply yet — send again".
  (WP-1.3)
- **Your new message moves to the top of the screen, with room for the answer below.**
  Before, the reply streamed in below the visible area. (WP-1.3)
- **Long conversations stay smooth while a reply streams.** Each new word used to redraw
  every message in the chat; now only the reply being written is updated, and messages
  off screen aren't drawn at all. (WP-1.3)
- **A finished reply is ready the moment it's written.** The answer used to sit with a
  Stop button and no actions for seconds, or indefinitely if the provider stalled, while
  the chat's title and memory were worked out using the chat model. Those now happen just
  after; the title still appears a moment later. Both have time limits, and a model that
  goes silent for 5 minutes is treated as failed instead of holding the reply for up to
  half an hour. (WP-1.2)
- **Replies keep going if you leave straight after sending.** The answer used to start only
  once your browser picked up the reply, so a phone switched to another app right after
  Send got nothing. It now starts the moment you send. (WP-1.2)
- **Files, pictures and @-mentions stay part of the conversation.** "Summarise this
  contract" followed by "what does clause 7 say?" used to be answered without the contract,
  and the same went for screenshots and @-mentioned chats and files. Documents are now kept
  available for the rest of the chat, image descriptions are saved and reused, and
  @-mentions keep applying for the next several messages. Only the last 3 pictures are
  re-sent to the model, so long picture-heavy chats stop getting steadily more expensive.
  (WP-1.2)
- **Deep Research runs in the background.** It survives a reload or leaving the chat (come
  back and the progress is still there), Cancel actually stops it, and its full cost now
  counts towards usage limits. (WP-1.2)
- **"Delete forever" is recoverable for 14 days.** Permanently deleted files (Trash,
  Empty trash, a deleted user's files) are removed from disk two weeks later, so a
  mistake can still be undone from a backup. Admin → Backups shows how much space is
  waiting to be freed.
- **Drive trash empties itself after 30 days**, like workspace trash. Items used to stay
  in the trash, counting against your storage, forever.
- While Promptly restarts for an update, you see "Reconnecting…" instead of being sent
  to the sign-in screen with a session that was still valid. (R-246)
- The background worker now uses the backend's own image: one build per update, so the
  two can never run different code. It waits for database updates to finish before it
  starts. (R-243, R-244)
- Logs rotate on every container (10 MB × 5). A disk filled by logs can take the
  database down with it.
- Third-party images (nginx, Redis, Ollama) are pinned to a version line, and the live
  editing server's dependencies are locked, so an update brings no surprise upgrades.
  (R-243)

- **Your uploads are stored exactly as you uploaded them.** Photos used to be re-encoded
  on upload to remove their metadata, which altered the original, threw away its
  orientation (so phone photos could turn sideways) and took seconds per photo. The
  original is now kept byte-for-byte, location included, for you and the people you share
  with inside Promptly. Metadata comes off only where a photo leaves: share links, AI
  models and document images, all without touching the image itself. Photos uploaded
  before this update were already stripped, so their location can't come back.
- **Workspace export downloads straight to disk.** The browser fetched the whole zip
  into memory and gave up after five minutes; it now downloads from a short-lived link.
  (R-188)
- The new-workspace template list comes from the server, so the app and the backend
  can't disagree, and a template that fails part-way leaves a clean blank workspace.
  (R-204)
- **Workspace permission messages say what's actually shared.** They claimed members
  could see (and edit) every chat; chats stay private to whoever started them until
  they're shared with the workspace. (R-187)
- The workspace overview says "everything here is context" once instead of three
  times. (V11)
- **Back stays in the workspace.** Opening an item adds a history entry, so Back (and a
  phone's back gesture) returns to the previous item instead of leaving the workspace.
  (R-182)
- **Board edits show straight away.** A dropped card stays where you dropped it, renames
  appear as you type, and if a save fails the change is undone with a message (it used to
  fail silently). Reordering cards no longer re-embeds the board, and a burst of edits
  re-embeds it once. (R-170)
- Posting in a discussion that's part of the workspace's AI context no longer waits for the
  whole discussion to be re-embedded. (R-176)
- Workspace owners and admins can remove anyone's comment, as they already could in
  discussions; a card's activity entries ("moved to Done") can't be deleted by anyone.
  (R-202)
- Workspace exports include each canvas as an `.excalidraw` drawing, not just its text.
  (R-175)
- **A failed automation keeps what it did.** The steps that ran (including any cards filed
  or messages posted before the failure), which step broke, and the tokens spent are saved
  on the run; skipped and pinned steps no longer look like failures; "needs a look" runs can
  be exported and followed up like successful ones. (R-146)
- **Fair turns on the automation worker.** One person can have two runs going at once (the
  rest wait their turn), long meeting transcriptions take at most two slots, and the worker
  runs eight jobs instead of four — one person's burst or two long recordings no longer
  hold up everyone's morning digests. (R-151)
- Automation results keep one rolling inbox entry per automation, and can't push mentions,
  invites or assignments out of the inbox. (R-152)
- **Automations on a phone:** a workspace automation (and its failure notification) opens
  its runs page, where you can read reports, pause it or run it now; Advanced flows open on
  their runs rather than the desktop-only canvas, and new Advanced flows are offered on a
  computer only. (R-154)
- **The Automations page opens on Scheduled automations**, not on Prompts (snippets you
  insert with /), and remembers the tab you used last. (V13)
- Switching between a flow and its runs, or clicking a past run, keeps unsaved canvas
  edits, the tab warns before closing with unsaved changes, and **Run now** asks when the
  flow has changes that aren't saved yet. (R-149)
- The automation copilot knows the event trigger, connector actions and the Workspace step.
  (R-155)
- Changing the embedding model (not only its size) re-embeds everything: files, items, chats,
  memories and chat-search vectors. Until a row is re-embedded, search keeps to the current
  model's vectors instead of mixing two models' results. (R-317)
- Saving the embedding setup always makes one test call and rejects a model whose vectors don't
  fit; **Test** fails on a size mismatch, and `dimensions` is only sent when the model needs
  shortening. (R-333)
- Chat import: one batched write per chat, a savepoint per chat (a bad chat is skipped and
  named, not the whole file), chats already imported are skipped on a retry, and the upload no
  longer times out after 30 s. (R-309)
- Promptly's JSON chat export (v2) keeps regenerations and edits with their place in the
  thread, plus the model and reasoning per message; Markdown and PDF exports show the visible
  thread only. (R-307)
- Markdown-zip import into a workspace accepts up to 2000 notes (was 400) with a 200 MB limit,
  and shows what was skipped and why. (R-315)
- The workspace export copy says it's a readable export, not a restorable backup — full backups
  are in Admin → Backups. (R-327)
- Trash lists what you deleted, not every file inside a deleted folder, with where it was;
  restoring puts things back in the nearest folder that still exists and says where. A trashed
  folder's name no longer blocks a new folder with it. (R-209)
- "Modified" and Recent follow content changes only — starring or moving a file no longer
  changes them. (R-209)
- Drive no longer lists workspace text mirrors (sheet, canvas, board, roster, discussion,
  automations, chat transcripts) — they doubled up in Search and opened as raw Markdown.
- Thumbnails are rendered once and cached, revalidate with 304, decode big JPEGs at reduced
  scale, and have their own rate limit; a 1024 px size is available for previews. (R-207)
- The share picker lists people you already work with until you type, searches with at least
  two characters, and shows an email only when you typed it exactly. (R-217)
- Big folders render a page of rows at a time, and finished uploads refresh the list in batches
  instead of once per file. (R-214)
- Spreadsheets and whiteboards count toward storage at their real size (they were free); the new
  usage shows now, and the cap applies to it 30 days after the upgrade.
- Renaming, trashing, restoring or deleting a sheet or whiteboard — or its whole workspace — does
  the same to its file in Files.
- The collab server reaches the backend on an internal-only route with its own token
  (`COLLAB_INTERNAL_TOKEN`, derived from `SECRET_KEY` when unset) instead of `SECRET_KEY` itself.
- A spreadsheet save based on an older version than the one stored no longer overwrites it: when
  the tabs are the same the editor re-saves its live copy on top, and when someone else changed
  the tabs the editor shows their version instead of replacing it. Workbook saves are capped in
  size.
- **Recent includes files shared with you and workspace files you worked on.** It used to
  list only your own files by their last change. It now also lists every file you opened or
  edited (live edits count), each at its latest time, and drops a file once you lose access.
- **"Make a copy" of a document, sheet or whiteboard stays editable.** It used to make a plain
  file with no editor. An owner's copy also lands next to the original.
- Renaming a personal sheet or whiteboard in Drive renames it in the editor too. Deleting one
  forever from the trash removes its contents with it.
- **Shared is split into "With me" and "By me"** (plus a Links shortcut). Items you've only shared
  by link count as shared by you.
- **A folder shared with you opens properly** from Shared. It used to land in My files and fail
  (R-023).
- "Drive" now reads "My files" in breadcrumbs, the folder tree and the move picker.
- **The document editor and live collaboration are on current versions.** TipTap 2.27 → 3.31,
  Hocuspocus 3 → 4.7 (server and browser), and Node 20 → 22 for the frontend build and the
  collaboration server (Node 20 reached end of life in April 2026). Existing documents open
  unchanged — nothing is rewritten on open. Two things changed under the hood: the editor's
  menus position with Floating UI instead of Tippy, and the live-cursor CSS classes are now
  `collaboration-carets__*`. (WP-4.2)
- The Files editor page retries a busy or restarting server a few times before saying a file
  isn't available.
- **The document toolbar fits on one row.** Headings moved into a "Normal text" style menu and
  the less-used inserts (audio, YouTube, callout, divider, page break, formula, emoji) into an
  Insert menu, as in Docs. (WP-4.5)
- **One rule for who can open a file.** Downloads, previews and the new AI search now decide with
  the same check — your file, shared with you, or inside a folder shared with you — so search can
  never surface something you can't open. (WP-5.1)
- **The AI search index remembers where each passage is** — a PDF's page, a sheet's tab and row —
  so every file is re-read once after updating. (WP-5.2)
- **The AI search dialog answers straight away** — switches and choices change as you click
  instead of after the server replies (and change back if saving fails). (WP-5.2)

### Fixed
- Two dialogs open at once (one opened from another) now each have their own name for screen
  readers — they shared one, so the second was announced with the first's title.

- **CI passes again.** Every run since v0.8.2 had failed: the frontend lint stopped on a
  control-character regex (deliberate, now marked so), and the backend tests couldn't start the app
  without a `SECRET_KEY` (the test setup now makes a throwaway one) and lacked the system tools the
  backend image has (ffmpeg, exiftool, Pango and fonts, restic, a matching `pg_dump`) — CI installs
  them now. The workflow's actions are on their Node 24 releases (v7) and the frontend builds on
  Node 22, as its image does.
- **The off-site backup no longer copies half-finished big uploads** (and now leaves out import
  archives too): they're temporary and could be many gigabytes. (WP-10.1)
- **Times shown in your own time zone.** Promptly now remembers your browser's time zone when you
  haven't set one, so the assistant knows your local time, and photos without a time zone of their
  own (screenshots, scans, dates you correct) land on the right day in Photos — they used to follow
  UTC. Changing your time zone moves them. (WP-9.3)
- **Photos from cameras that don't record a time zone showed at the wrong time.** Their clock
  was read as UTC and then shown in your time zone, so a photo taken at 10 pm could land on the
  next day. It's now read as your zone, so it shows the time on the camera's clock, and
  changing your zone keeps that time. Camera Uploads also sorts a photo with no date of its own
  into the month in your zone, not UTC's. (WP-10.3)
- **A new album could be missing from Albums** for up to half a minute when it was made while the
  album list was still loading in the Add to album dialog. (PH-3)
- **A photo's info showed a different time from the viewer** for photos without a time zone of
  their own (screenshots, uploads with no date): the info used UTC. It now shows the same time
  as Photos does. (PH-2)
- **Automations can't reach Promptly's own services by name, even where the name doesn't resolve.**
  The internal-service check ran after the DNS lookup; it now refuses the name first.
- **Uploading a text file that was really binary answered with an error** although the file was
  saved: its search text held bytes the database can't store, and the error handling then failed
  too. The text is cleaned and the upload succeeds. (WP-8.4)
- **Zipping a folder flattened every folder inside it into one**, skipped files that had only been
  shared with you, and anything over roughly 40 MB never finished. (WP-7.6)
- **Rows with a sharing badge pushed their Kind / Modified / Size columns out of line.** (WP-7.6)
- **A row's menu could close the moment it opened** when the list nudged its own scroll position;
  menus now close when you scroll. (WP-7.6)
- **Two uploads finishing at the same moment could take someone over their storage limit** — each
  checked the limit against the same usage. They now take turns at the final check. (WP-7.1)
- **The Share dialog in the Docs editor showed the document's name with ".html" on the end.**
  (WP-6.6)
- **A Doc's PDF ignored everything about the page** and was always A4 with fixed margins and no
  page numbers; it's now made by WeasyPrint from the document's page setup, in the background
  worker. Russian, Greek, Chinese, Japanese and Korean text no longer comes out as boxes (the image
  now carries Liberation, DejaVu and Noto CJK fonts). (WP-6.4, R-080 for Docs)
- **Printing a Doc lost text colours and highlights** — everything was forced to black on white.
  It now prints as it looks, in the light theme, on the chosen paper and margins. (WP-6.4)
- **A PDF or page downloaded a second after an edit could miss it** — exports now read the open
  document's live state. (WP-6.4)
- **The file name box in the Docs / Sheets / Whiteboard header was white in dark mode.** (WP-5.5)
- **A tab added while someone else saved the same sheet could vanish** — the editor showed "Someone
  else changed this sheet's tabs" and replaced its copy with theirs. Now both changes are kept.
  (WP-6.3)
- **A version-history test failed when the suite ran between 5 and 15 minutes past the hour** —
  its "same hour" versions straddled two hours. (WP-6.1)

- **Pressing Stop just as a reply finished could save it twice**, the second copy marked
  "Stopped" and shown instead. The reply now counts as saved from the moment it's
  written. (WP-1.2 follow-up)
- **Users with an internal email address (like bob@corp.local) got an error on every
  sign-in**, and the add-user form refused addresses the CSV import accepted. Both now
  accept the same addresses, and nothing re-checks them on the way out. (R-136)
- **A failed token refresh signed you out** even when it was only a hiccup — a rate
  limit, a server error. Only a definite "no" from the server ends a session now, and
  turning off two-step verification says why you're back at the sign-in page. (R-142)
- **Connector setup mistakes gave "Internal Server Error".** A missing http://, a
  .local name the server can't look up, or a metadata address now says what's wrong and
  how to fix it, and retrying a slow create no longer makes a duplicate. (R-157)
- **The connector form:** changing the transport when editing was ignored, Test ignored
  the saved token, refresh and delete errors weren't shown, and slow creates timed out in
  the browser. A changed address or token re-reads the tool list. (R-158)
- **Connector tools from servers that page their tool list** were cut off after the first
  page, and an oddly shaped tool definition could break every Tools-on chat for some
  models. (R-160)
- **Command values were mangled:** "21.5" reached the tool as "21 5", "O'Brien's" as
  "o brien s" and "Café" as "cafe". They're now what you said; spoken numbers still
  become digits. (R-162)
- **Voice mode:** saying "no" to "did you mean …?" sent the word "No" to the AI; it now
  answers your original request. Replies no longer pause between sentences, and when the
  browser blocks audio you're told to tap, instead of voice mode quietly stopping. (R-165)
- **Admin alerts never pushed to phones,** and the test push counted registered devices
  rather than deliveries. It now reports what was sent, what failed and what was removed.
  Push notifications identify the server by an admin's email instead of
  admin@localhost. (R-167)
- **A failed "new chat" in a workspace's sidebar** said nothing. (R-199)
- **Selecting several files and pressing Trash, or restoring several from Trash, always
  failed** with a cryptic error. Only the per-row menu worked. A new test checks that no
  route can hide another one like this again. (R-024)
- **"Delete forever" in Trash deleted nothing**, though it said it had, and for folders
  it left broken files behind that could be restored but never opened. It now deletes
  for real and reports what was actually removed. (R-025)
- **Custom-model knowledge files and board-card attachments were being moved to the
  trash within hours.** The Chat Uploads cleaner only looked at chat messages and binned
  everything else uploaded the same way. It now leaves alone anything a model, a card or
  a workspace still uses, and anything uploaded in the last day (an attachment you
  haven't sent yet). Files it wrongly trashed are restored by this update. (R-026)
- **Card attachments**: teammates can now open them, and Download no longer opens an
  error page. (R-034)
- **Images pasted into a document went missing when the document moved.** They stayed
  in the old folder, invisible, and were trashed and deleted along with it. They now
  live with their document and go wherever it goes. Images already in that state are
  repaired, and folder share links no longer list them as stray files. (R-027)
- **A roster could wipe itself.** If it failed to load, it opened as an empty roster, and
  the next drag saved that over the real schedule. It now shows an error with *Try
  again*. Saves are refused if someone else changed the roster since you opened it, and
  a pending edit is saved when you switch away instead of being dropped. (R-035)
- **Compacting a chat after a regenerate or an edit could cut it down to its last
  message** and delete the rest. Compaction now works only on the conversation you can
  see, and other versions of the latest answer are kept. It also works in chats with
  custom assistants (it always failed there), and a failed auto-compact is reported
  instead of hidden. (R-018, R-020)
- **The document editor's offline mode could lose your work or duplicate the whole
  document.** When live editing was unreachable it loaded the saved copy *into* the
  shared document, which merged into a second copy on reconnect, and Save wrote a copy
  the next live edit overwrote. Now an unreachable document opens read-only on its last
  saved version. If the connection drops mid-session you can keep typing: your changes
  stay in the tab and sync when it comes back, and Save writes them into the document
  itself. Re-saving can't create duplicates. (R-022)
- **Meeting recordings interrupted by a restart stayed "processing" forever** and
  blocked new recordings in that workspace. They're now marked failed after the
  time limit, and can be cancelled. (R-240)
- **Automations interrupted by a restart re-ran from the first step**, repeating emails,
  webhooks and notes. An interrupted run is now marked as such and the next scheduled
  run starts fresh. The worker also gets two minutes to finish its jobs before it's
  stopped. (R-241)
- **Document previews and search could miss the last edits** if the backend was
  restarting when they were saved. Those saves are now retried, and a daily check
  catches anything missed. (R-249)
- Database updates now give up after 30 seconds if they can't get a lock, rather than
  hanging. Errors during startup after a database update are no longer hidden from the
  log. (R-250)
- Removed leftovers from the deleted Study feature: an unused nginx route that allowed
  inline scripts and framing, and its script file. (R-251)
- The backend's container healthcheck no longer fails when web search (SearXNG) is down.
  It now checks only that the app is up and can reach its database. (R-245)

- **Event-triggered automations couldn't be saved** ("Couldn't save the flow"). Saving
  also now picks up AI steps on every branch of a flow, not just the first path, so
  their connectors are attached. (R-009)
- **The schedule columns, not the flow, decided when an Advanced automation ran.** The
  Edit form rewrote a flow's prompt, model and schedule, Pause/Resume set webhook-only
  flows running daily, new flows ran a placeholder prompt at 09:00 before you'd built
  anything, and the list showed "Daily · 09:00" for webhook and event flows. Edit on a
  flow now opens the flow editor. Only flows with a schedule trigger run on the clock.
  New flows start switched off and switch on when first saved. The list shows how each
  flow actually starts ("On webhook", "When a file is added"). The Edit form also no
  longer resets an automation's notification and history settings. (R-010)
- **AI text with quotes or line breaks broke HTTP and MCP steps**, including the editor's
  own `{"key": "{{upstream_output}}"}` example. Values are now escaped for JSON, and a
  field that is a single `{{...}}` token holding a JSON list or object inserts that
  value. (R-012)
- **"Run to here" could time out, waited out Delay steps, and crashed on Memory
  steps.** Test runs stop after about two minutes with a clear message, skip delays,
  and Memory steps work in tests. (R-013)
- **One user's upload or chat could freeze everyone else's for seconds.** Stripping
  photo metadata, reading PDFs, re-preparing every image in a chat's history on every
  message, password checks, workspace exports, copying files, chat imports and some
  connector address lookups all ran on the backend's single event loop. They now run
  alongside it. Prepared chat images are also cached, so a conversation with photos
  isn't re-processed on every turn. (R-016)
- **Tables in note templates and automation notes showed up as `| a | b |` text.** They now
  arrive as real tables, and `~~strikethrough~~` works too. (V3)
- Phone photos sent to the AI arrive the right way up.
- **Opening a shared note, PDF or text file from a public link never got past "Loading…".**
  The page tried to re-read the file through a link type the app's security policy blocks,
  and a failure looked the same as still loading. Visitors now see the file, or a clear
  "couldn't be shown — use Download" message. Found by the new end-to-end suite.
- The close button on a board card's detail panel now has a name screen readers can
  announce ("Close card").
- **Stop threw away the reply you were watching.** Pressing Stop on an ordinary reply saved
  nothing, and pressing it just as a reply finished saved it twice, the copy marked
  "Stopped". What was written now stays, marked as stopped. (WP-1.2)
- **A reply that failed partway vanished.** When the provider returned an error, the
  connection dropped, or something broke on the server, the text already shown
  disappeared, sometimes with no error at all. It's now kept and marked as unfinished, with
  the error shown under it, and any files the reply had produced are kept too. (WP-1.2)
- **A failed or stopped Regenerate hid the previous answer.** If the new attempt produced
  nothing, the answer you had is put back. (WP-1.2)
- **Stop didn't stop multi-agent research.** The sub-agents kept searching and running up
  costs; Stop now ends them all. (WP-1.2)
- **A Deep Research report in an ongoing chat disappeared when it finished.** (WP-1.2)
- **Images that an AI had generated could make later messages fail.** Generated images and
  charts were sent back to the model as if they were part of its own replies, which OpenAI
  and Anthropic models reject. The model is now just told which files it produced. (R-046)
- **Older chats disappeared from the sidebar.** Only the 50 most recent loaded, and chats
  inside workspaces counted towards those 50, so busy workspace users saw hardly any.
  Folders looked empty when their chats weren't among them. The sidebar now loads older
  chats as you scroll, each folder loads its own chats when opened, and folder counts are
  the real totals. The Archive no longer stops at 200, and its search covers every
  archived chat. (WP-1.3)
- **One broken page took down the whole app.** Any display error replaced everything,
  sidebar included, and in the installed app there was no way out. Now only that page
  shows the problem, with "Try again" and "Go to chats", and going anywhere else recovers.
  A single message that can't be displayed shows its text instead of breaking the chat.
  (WP-1.3)
- **Links were lost when you had to sign in first.** Opening a link to a chat, file or
  workspace while signed out always ended on the chat page. You now land where the link
  pointed, including after two-step verification and single sign-on. (WP-1.3)
- **Many actions failed silently.** Pinning a chat, deleting a folder, and admin actions
  such as "Disable user" and "Log out everywhere" showed nothing when they failed. A failed
  action now always says so. (WP-1.3)
- Notifications are announced reliably by screen readers, stay up while you hover, focus
  or touch them, and any notification with a button (such as Undo) now stays for at
  least 10 seconds. (WP-1.3)
- **Enter sent the message while typing Chinese, Japanese or Korean.** Picking a word in
  the input method no longer sends or picks a suggestion. (WP-1.3)
- **Errors read "Request failed with status code 429" (or 403, 502…).** They now say
  what happened in plain words. A rejected first message in a new chat used to vanish with
  no error at all; it now stays on screen with the reason, ready to send again. Sends with
  large attachments get more time before giving up. (WP-1.3)
- **Voice mode never heard "yes".** When a spoken command asked "shall I…?", every answer
  counted as no, because the check for "yes" contained a stray invisible character. It
  now works. (Found by the code checker, which now runs clean.)
- **Light theme: orange and green text was too faint to read comfortably.** Accent-coloured
  and success text, and grey secondary text, now meet the WCAG AA contrast standard. Filled
  buttons keep the brand colour. (WP-1.3)
- **Keyboard and screen-reader fixes in dialogs.** A field set to be selected when a dialog
  opens now actually is. Closing a dialog returns you to the button that opened it. Escape
  closes only the top dialog, not every one that's open. Confirms for destructive actions
  start on Cancel, so a stray Enter can't delete anything. Secondary and plain buttons show
  a focus outline. On phones, the menu closes with Escape and can't be reached by keyboard
  or screen reader while it's closed. In the command editor, the "Insert text / Run an
  automation / Call a tool" buttons are announced by their own names. (WP-1.3)
- **The Windows installer failed straight away on the PowerShell that ships with
  Windows** (5.1); it needed PowerShell 7. It now works on both, checks Docker properly, and
  requires Docker Compose 2.24 or newer. (WP-1.5)
- **Opening Promptly by its network address (http://192.168.x.x) signed you out on every
  reload.** The session cookie was marked HTTPS-only, so browsers dropped it. It's now
  HTTPS-only everywhere except plain-HTTP addresses on your own network (`COOKIE_SECURE`
  can force it either way). The installers also print the network address. (WP-1.5)
- **A local Ollama wasn't detected on fresh installs, and the "Local (Ollama)" choice
  pointed at the wrong place.** The installers now wire up an Ollama running on the
  machine, and the wizard uses the address Promptly is actually set up with. (WP-1.5)
- **Create user ignored "Image generation", "Code execution" and private-network access.**
  A user meant to be restricted got everything. (WP-1.5)
- On phones, a non-admin with no model available is no longer sent to an admin page that
  bounced them straight back. (WP-1.5)
- **OpenAI's reasoning models (o3, o4-mini, GPT-5…) failed on every message.** They
  reject two settings Promptly always sent. (WP-1.5)
- **Only 20 Anthropic models were listed,** and several Claude models were shown with a
  1M-token context window when they have 200K. All models now load, and the window comes
  from Anthropic's own model list. (WP-1.5)
- **One "slow down" from a search provider switched web search off for a week.** A brief
  rate limit now just moves that provider to the back of the queue for the time it asks
  for. Only a used-up quota pauses it longer. A second key of the same kind (two Brave
  keys, say) is now tried when the first fails. (WP-1.5)
- **Errors now explain an empty account, a retired model, or a chat that's grown too long
  for the model,** instead of a rate-limit countdown or raw provider text. (WP-1.5)
- Deep Research, sub-agents and multi-agent research work in Custom Model chats. They
  failed every time. (WP-1.5)
- **An embedding model that was down slowed every chat turn by seconds to minutes.**
  After a few failures in a row it's now skipped for a minute, and lookups made while you
  wait for a reply give up after 5 seconds. Chat carries on without that context, as it
  did before, just without the wait. (WP-1.5)
- **Files, notes and memories saved without an embedding model were never caught up.**
  Workspaces showed "indexing" spinners that never stopped, and memories saved then were
  never found again. They're now indexed as soon as an embedding model is set up (or
  changed), and every night for anything an outage left behind. Until a model is set up,
  workspaces say "Search is off — no embedding model yet" instead of spinning. (WP-1.5)
- **Memory could forget something without telling you.** When a message made Promptly
  drop a saved fact, it did so silently. You now get a "Forgot: …" notice with Undo.
  Facts you pinned are never removed this way, and facts you added yourself only change
  when you correct them. (WP-1.5)
- **Memory Export saved an error instead of your memories.** The download carried no
  sign-in, so the "backup" was a 401 error page. It now downloads the real file.
  (R-264)
- **Turning memory off hid everything it had stored**, so you couldn't see, export or
  delete it. Stored facts now stay listed (and deletable) with memory off; only adding
  new ones and the AI tools need it on. (R-291)
- **Asking Promptly to "remember that…" could later lose the fact** to make room for
  new ones. Things you explicitly ask it to remember are now kept like facts you typed
  yourself. The memory list shows how full it is and warns when it's nearly full.
  (R-269)
- **Tidy up and plain-English memory edits said "nothing to change" when the AI's
  answer was simply cut off.** They now have more room, and say so when an answer is
  cut short — nothing is changed in that case. A failed model call in a plain-English
  edit now shows a clear message instead of a server error. (R-265, R-289)
- **Unrelated memories rode along on every chat.** With only a few facts saved, the
  closest ones were added to every conversation however off-topic. Facts that don't
  relate to the message are now left out. (R-296)
- **A failed Ollama download showed no error.** The progress bar vanished and Ollama's
  reason (usually a mistyped model tag) was lost. The Local Models panel now shows why
  the download failed. (R-278)
- **Local Models always said "No NVIDIA GPU detected", even on GPU installs**, and gave
  CPU-only advice. Only Ollama's own container can see the GPU, so the panel now shows
  the GPU as in use once Ollama has a model loaded on it, and says it can't tell rather
  than claiming there's none. (R-279)
- **New chats said "No model provider is connected yet" while models were still
  loading**, and kept saying it when the server couldn't be reached. They now say
  "Loading models…", explain a connection problem as one, and tell people without model
  access to ask an administrator. (R-284)

- **The context meter overstated how full a chat was.** It added up every request a turn
  made, so a reply that searched the web once showed about double its real size. It now
  shows the size of the request the reply was written from, broken down into
  conversation, instructions, tool definitions, and the date, memories and files looked
  up for that message. Large windows read "1M", not "1000k". (WP-1.4, V2, V15)
- **Every message carried more instructions than it needed.** Tool descriptions were sent
  three times over (in the tool definitions, then again twice in the instructions), and
  models that can't call tools were still told about them. The instructions now name the
  tools once and keep only what the definitions don't say. (WP-1.4)
- **Provider prompt caching never applied.** The current date and time, memories and
  retrieved files sat at the top of the instructions, so no two requests started the same
  way. They now come after the instructions that stay the same for the whole chat, so
  providers that cache prompts (OpenAI, DeepSeek, Gemini and others) can reuse that part
  — cheaper and faster replies. (WP-1.4)

- **A web search that found nothing showed a green tick** ("Searched the web"), over an
  answer the model wrote from memory. The activity card now says "Web search found
  nothing — answered without it", and each empty search reads "no results". (V1)
- **Chats could be titled "user: …"**. When re-titling a longer chat failed, the fallback
  title was the first line of the transcript, role label and all. A failed re-title now
  keeps the title the chat already has. (V4)
- **Links in replies and documents were hard to read on the light theme.** They now use
  the darker accent, as the rest of the accent-coloured text already did, and the send
  button reads as grey rather than a faded orange until there's something to send. (V14)
- **The Account page's address was `/account/security` whatever it showed.** It's now
  `/account`, and `/account/<section>` (for example `/account/memory`) opens at that
  section. Old `/account/security` links open at Security. (V25)
- **An open workspace kept reloading its heaviest data every 2.5 seconds** whenever it
  had a pinned image or no embedding model — those never finish indexing. And files or
  notes caught mid-index by a restart stayed "indexing" for good; they're now picked up
  again at start-up. (R-178)
- **Workspace settings could undo another admin's changes.** Every autosave re-sent
  every field, so fixing the title put back the old instructions, and an admin without
  access to the default model couldn't save anything. Only changed fields are saved now,
  and if someone else changed the instructions while you were typing you're asked which
  version to keep. Providers added in the admin panel can also be picked as a workspace
  default by everyone. (R-179)
- **Items couldn't be dragged into a notebook** (only next to one), and a notebook could
  be moved inside another. (R-181)
- **A workspace that failed to load spun for ever**, the workspace list said "Create
  your first workspace" when it couldn't load, and a failed delete did nothing. Each now
  says what happened, with a way back. (R-182)
- **My Work kept cards finished in a custom "done" column**, and cards from boards in
  the trash, whose links went nowhere. (R-184)
- **Workspace chats could miss the big reference files** in a note-heavy workspace:
  retrieval spent its slots on notes and boards already included in full. Content the
  chat can't use (switched off, private, in the trash) also no longer pushes a workspace
  into retrieval mode. (R-185)
- **Search (⌘K) embedded the same query once per workspace**, one after another, on
  every pause in typing. It's embedded once (and remembered briefly), and a newer search
  cancels the one in flight. (R-186)
- **"New advanced automation" created a live daily 9 am job** with a placeholder prompt
  that ran and notified even if you walked away. It now starts switched off until the
  flow is first saved, uses the workspace's model, and says if creating it failed.
  (R-189)
- **Workspace counts were wrong:** pinned files always counted 0 (so a workspace of PDFs
  showed "get started"), rosters and discussions weren't counted, and trashed items and
  other people's private chats were. (R-203)
- Creating a second workspace with the same name as one you already have (including a
  duplicate or a re-import) failed.
- **A meeting recording interrupted by a restart blocked new recordings** in that workspace
  and was never marked failed. Uploads without a model to write the notes with are now
  refused up front instead of after an hour of transcription. (R-133)
- **Renaming a board column, label, checklist item or field lost characters** while you
  typed, and each keystroke re-embedded the board. They save when you finish. (R-169)
- **Due dates were a day off** for the AI, `query_board` and the card activity log in
  Australia and other zones ahead of UTC, and AI-created cards could land on the wrong day
  in the Americas. Dates now use your own timezone. (R-173)
- **Deleted sheet cells could come back for everyone** after the sheet was emptied and
  reopened, and every open copy of a sheet re-saved the whole workbook after each edit
  someone else made. (R-171)
- **Canvases kept every image ever added**, including deleted ones and the originals that
  "Remove background" replaced, so image-heavy canvases kept growing. Unused images are now
  removed (after a day, so undo still works). (R-175)
- **Board paper cuts:** marking a column "Done" now updates the cards already in it;
  deleting a column moves its cards to the first column (and asks first); duplicating a
  board keeps cards' custom-field values; deleting a duplicated card no longer removes the
  original's attachments from search; AI-added cards land in the board's first column even
  without a "To do". (R-201)
- **Boards, notebooks and discussions were created without a creator**, so they had no
  attribution and a board could never be made private. Existing ones are attributed to the
  workspace's owner.
- The card dialog closes with Escape. (R-202)
- **A server restart could run an automation's steps twice** — a retried job re-ran the
  whole flow, repeating cards, notes, messages and outbound requests. A run is claimed
  exactly once and an interrupted run isn't retried. (R-147)
- **`{{date}}` and `{{time}}` were UTC**, labelled with the schedule's timezone, so an 8 am
  Sydney automation was dated the previous day at 21:00. They're now in the schedule's
  timezone. (R-148)
- **Large webhook bodies broke field access:** past 400 values in the whole context, later
  `{{json.*}}` references silently stayed as literal text. Each payload now has its own,
  larger allowance, and a step that used a variable with no value shows it. (R-150)
- "File into folder" on note and sheet outputs offered nothing — it listed folders, which
  were replaced by notebooks. It lists notebooks now. (R-155)
- Restoring an earlier version of a flow left the editor's cached copy stale. (R-155)
- **The backend test suite could hang indefinitely**: a background write cut off at the end of
  one test kept a lock that blocked the next. (test infrastructure)
- The ChatGPT importer brought in the drafts you'd regenerated away and dropped the rest of the
  chat; it follows the branch you kept. Reasoning, custom-instruction and tool-call rows no
  longer import as blank or stray bubbles, and citation glyphs are removed. (R-306, R-313)
- Claude imports keep pasted and uploaded document text, artifacts and the branch you kept.
  (R-330)
- A Markdown chat transcript containing `## User` inside a code block split into the wrong
  messages on import; `---` rules were deleted and Sources folded into the text. (R-325)
- A small zip that expanded to gigabytes could take the server down on import. (R-308)
- Imported chats kept their original title only until the next message. (R-328)
- Workspace editors couldn't import chats into a workspace they can add chats to. (R-326)
- The "Import complete" notification never fired, and chat export/import never reached the
  audit log. (R-316)
- An indexed chat attachment vanished from the answer when the embedder was down or had been
  switched: retrieval now has a keyword arm and falls back to the file's text. Indexing an
  attachment on send no longer holds the request past the client's timeout. (R-319, R-320)
- Ask and workspace search say when meaning-based search is unavailable instead of answering
  "couldn't find anything"; Ask answers from the workspace content instead. (R-322)
- Interrupted or failed indexing of boards, sheets, rosters, canvases, discussions and chats
  was never retried. (R-321)
- One message the embedder rejected stalled chat-search indexing for good, and the indexer
  re-scanned every message each minute; it now marks bad rows, looks only at what changed, and
  yields to chat queries. (R-323, R-332)
- Embedding calls could wait ten minutes on a dead provider, each call opened a new HTTP client,
  and a disabled provider kept being called. (R-318, R-324, R-336)
- Re-indexing a file briefly left it with no chunks, and two overlapping re-indexes could mark
  an indexed file "failed". (R-334)
- Small search scopes on a busy instance could return too few vector matches. (R-335)
- Markdown → note conversion (vault imports, workspace templates, automation output notes)
  drops YAML front matter and renders GFM tables, ~~strikethrough~~ and `- [ ]` task lists as
  real blocks instead of literal text. (R-314)
- Markdown-zip import: top-level folders become notebooks, Notion's page ids are stripped from
  titles, a Promptly workspace export's chats and canvases are skipped (not turned into notes),
  and conversion no longer blocks the server. (R-315, R-327)
- The workspace export's chat transcripts held every regenerated version; they hold the visible
  thread. Other members' private chats are never included. (R-307, R-312)
- Memory import restores each fact's source, usage count and dates, and a richer imported fact
  replaces a shorter existing one instead of being dropped. (R-329)
- An image over 80 megapixels attached to a document gave a server error and left its bytes on
  disk outside any quota; it's refused with a clear message, and a nightly sweep collects blobs
  no file points at. (R-206)
- Photo folders showed random tiles as generic icons when thumbnails hit the rate limit; tiles
  load a few at a time and retry. (R-207)
- Trashing a workspace's folder from Files silently broke its notes and files, and emptying the
  trash destroyed them; Files leaves workspace folders to the workspace and says so. (R-215)
- Restoring a file whose folder was still in the trash made it vanish into that folder. (R-209)
- The Files app's install scope was ignored, so the two installed apps fought over links; it
  opens inside /files/ now and no longer locks portrait. (R-211)
- On phones, a single selected file showed no actions and grid menus needed a hover. (R-210)
- The workspace upload pickers offered .docx, .rtf and .html, which were always rejected after
  uploading. (R-212)
- After sharing, copying to My files or saving to Drive, lists and the storage meter stayed
  stale. (R-216)
- Removing someone's access (a share, a workspace membership, or edit rights) now cuts their
  open editing session at once; it used to last until their next token refresh.
- The backend test suite could hang waiting on a re-index left over from an earlier test.
- **A blip in the connection no longer takes a document away.** A failed sign-in refresh for
  live editing — a backend restart during an update, a laptop waking up — replaced the document
  with "Collaboration unavailable" until it was closed and reopened, and disabled Save and
  Download. Now it retries in the background with a "Reconnecting…" note while you keep the
  document and your edits. Only a document you really can't open shows an error. (R-221)
- **"Saved" now means saved.** The save chip used a timer, so typing offline showed a green
  "All changes saved". It now follows what the server has confirmed: "Saving…" until it has
  every change, "Saved" once it does, and "Offline · 3 unsynced changes" while disconnected. A
  manual Save counts until your next edit. On a phone it shows as an icon. (R-224)
- **AI Enhance could overwrite the wrong text.** If anything was typed before the selection
  while the rewrite was being written (by you or a collaborator), Replace deleted the wrong
  span. The selection is now tracked through every edit. If the text itself changed, Replace
  steps aside and offers **Insert below** instead. Selections that are too long get a clear
  message, and Enhance works without first picking a model in a chat. (R-222)
- **Renaming a workspace note from its title failed** with "Rename failed" for everyone. The
  title now renames the workspace item (and its file). Viewers can't edit it, the editing
  toolbar is hidden from people who can only read, and saving no longer makes an editor's
  screen act as if they owned the document. (R-218)
- **Esc closes the menu, not the document.** Esc used to close the whole document when it was
  meant for the slash menu, emoji picker or spellcheck suggestions. Leaving with edits that
  haven't reached the server now asks first, and so does closing or reloading the tab. (R-225)
- Upload, rename, save and download errors in documents now say why (too large, over your
  storage limit, not allowed) instead of "Request failed with status code 413". (R-235)
- **Live edits are now credited to whoever made them while they're still editing.** The
  collaboration server only noted a document's editor when they closed it. So a long session
  showed up in Recent as "edited" late or not at all, and snapshots could go unattributed. (WP-4.2)
- The editor no longer runs its own undo history alongside the collaborative one for a moment
  when a document opens. Two undo stacks over one shared document can corrupt it. (WP-4.2)
- **Exports are up to date and complete.** HTML, Markdown and PDF downloads were built from the
  last saved copy, so they could miss the last few seconds of typing. They now come from the
  document as it is. PDFs and web pages carry their images (PDFs dropped every one). The web
  page is a real standalone page with a title and readable styling, and Markdown keeps
  checklists as `- [x]` / `- [ ]`. The PDF renderer refuses any remote fetch outright. (R-219)
- **Sheets keep their look on the way in and out.** Importing an .xlsx into a sheet, and
  downloading a sheet as .xlsx (Download, Export, the sheet's .xlsx button), only carried values
  and formulas. Formatting, merged cells, column widths, borders, frozen rows and dates now come
  across both ways, numbers are right-aligned as they are in Excel, and the in-sheet Import also
  takes .ods files and says what it couldn't bring over. A downloaded sheet asks Excel and
  LibreOffice to recalculate its formulas when it opens. CSV import no longer turns codes like
  `00123` into numbers. (WP-4.4, R-132)
- **Exported sheets and whiteboards get the right file name.** Export on a sheet's or
  whiteboard's page saved the file as `name.sheet` / `name.whiteboard`, which nothing could
  open. It now uses the name the server gives it (`name.xlsx`, `name.excalidraw`).
- **Text colours, highlights, alignment and fonts stay put.** The saved copy behind previews,
  downloads, version history and restores blanked every inline style, so colours "randomly
  disappeared" and a restore removed them for good. Styles the editor makes are now kept, and
  anything else is still refused. Merged table cells also kept their spans only in the live
  editor — previews, exports and the Word download now keep them too. (R-223)
- **Pictures in documents keep working.** Each embedded picture or recording carried a permanent
  key in its link: changing the server's secret broke every image on the instance, a copied
  note's pictures depended on the original (and vanished for anyone who couldn't open it), and
  a former collaborator's link worked forever. Documents now store just the picture's address
  and readers get links that expire after a few hours; a copy gets its own pictures. Existing
  documents keep working. Pictures deleted from a document are cleaned up after a week instead
  of using storage forever. (WP-4.6, R-228)
- **Typing stays smooth in long or busy documents.** The editor redrew its whole window on every
  keystroke and on every collaborator's cursor move, and the spell checker re-read the entire
  document each time. Now only the toolbar parts that change redraw, and spelling re-checks just
  the paragraph being edited (remembering words it has already checked). (R-234)
- **Phone editing.** The document toolbar is one row that scrolls sideways (it wrapped to about
  three) and sits just above the keyboard while you type; version history stacks the list above
  the preview on a small screen. (R-231)
- **Search and previews keep up with documents.** Saving a document's searchable copy is now
  strictly in order (a slow save could land after a newer one), written in one step, and a
  note re-indexes for workspace answers once you pause typing rather than every few seconds.
  (R-233)

### Removed

- An unused built-in list of suggested Ollama models (and its API route); the Local
  Models panel links to ollama.com/library instead. (R-305)
## [0.8.9] - 2026-09-16

### Fixed

- Models: vision support no longer depends on someone remembering to re-fetch
  the model catalog. The flag is cached on the provider row, so it was only ever
  as current as the build that wrote it — a model that gained vision kept
  reading as text-only until an admin re-fetched, which nobody thinks to do
  because the UI states it as fact. It now falls back to live id-based detection
  the same way the context window and reasoning flags already did, so a deploy
  is enough. This is why the DeepSeek fix appeared not to work twice.

## [0.8.8] - 2026-09-16

### Fixed

- Files: PDF previews render again. nginx's stock `mime.types` has no entry for
  `.mjs`, so pdf.js's worker — the one asset shipped with that extension — was
  served as `application/octet-stream`, and browsers refuse to execute an ES
  module that isn't a JavaScript type. It surfaced as "Failed to fetch
  dynamically imported module", which is misleading: the fetch returned 200.
  **After deploying, affected browsers need a hard refresh** — the bad response
  was cached under `immutable` for a year and the filename hash doesn't change.

## [0.8.7] - 2026-09-10

### Fixed

- Models: DeepSeek's `deepseek-flash` (V4.1-Flash, released 2026-09-10) is now
  detected as vision-capable. It has native multimodal understanding but dropped
  "vision" from its name, which defeated the rule added six days earlier — so
  the whole hosted `*flash*` family is matched now, including the
  `deepseek-v4-flash*` ids that DeepSeek keeps as aliases routed to V4.1.
  Refresh the provider's model list to pick it up.

### Added

- Admin → Analytics: **Response quality**. The thumbs on assistant replies have
  been collected since Phase 2.5 and read by nothing — they now show up as
  up/down per model, worst down-rate first, so "which model is letting people
  down" is a glance rather than a hunch. The rate is against *rated* replies,
  not everything sent, and replies are attributed to the model that actually
  produced them rather than whichever the conversation currently has selected.
- Admin → Analytics: **What people said** — the notes left on a thumbs-down.
  Counts tell you which model is failing; only the notes tell you how. Shows
  the note and the model, never the message content.

## [0.8.6] - 2026-09-08

### Added

- Commands: a **History** tab in Automations showing what has run recently — the
  command, what was actually said or typed, whether it came by voice or typing,
  and whether it worked. Entries survive the command being renamed or deleted.
- Commands: **share a command with everyone on this instance** (read-only for
  everyone else). Sharing shares the phrasing, not the access — whatever the
  command points at is still checked against whoever runs it.
- Voice: **"Did you mean…?"** — when nothing matches but a command is close, it
  asks instead of going silent. Only ever a question; it never runs on a guess.

### Fixed

- Models: DeepSeek's `deepseek-v4-flash-vision-exp` is now detected as
  vision-capable, so attaching an image no longer shows the "this model can't
  see images" warning. Refresh the provider's model list to pick it up.
- Voice: an unanswered spoken confirmation now expires after 20 seconds instead
  of waiting forever and consuming the next unrelated thing you say.
- Commands: a phrase slot no longer swallows a whole clause — "turn off the
  kitchen and the bathroom lights" no longer matches "turn off the {room}
  lights" with a room name that can't exist.

## [0.8.5] - 2026-08-31

### Changed
- **Picking a device now hides the arguments you no longer need.** Once
  you've chosen a device, the fields that only exist to say *which
  thing* — area, floor, domain, device class — fold away behind "target
  it another way", leaving a single line: "Targeting Kitchen Lamp".
  Arguments that are real parameters of the action, like brightness or
  volume, stay on screen, because no device picker can know what you
  meant by those.

### Fixed
- **Picking a device no longer leaves a contradictory target behind.**
  Choosing a device filled in its name but left any area or floor you'd
  already typed, so Home Assistant received two different ways to find
  the same thing and could only do as it was told. Picking a device now
  replaces the targeting rather than adding to it.

## [0.8.4] - 2026-08-31

### Fixed
- **The device list reads Home Assistant's real response.** HA returns
  its device list as a JSON object whose `result` field is a *string*
  containing the whole list — so every parser walked the JSON correctly
  and found nothing, because the devices aren't structure, they're text
  inside it. Embedded documents are now unwrapped and parsed. Found
  because the picker showed the raw response instead of claiming there
  were no devices, which is the only reason it took one look rather than
  a debugging session.

## [0.8.3] - 2026-08-31

### Added
- **Pick a device, then what to do to it.** Building a Home Assistant
  command no longer means knowing HA's intent vocabulary and typing an
  entity name by hand. Choose the connector and your devices are listed —
  "Kitchen Lamp — Lounge Room (light)" — and picking one offers the
  actions that make sense for it in plain English: Turn on, Turn off, Set
  brightness. Choosing an action fills in the tool and the device for
  you. Home Assistant already publishes this through its own
  `GetLiveContext`, so nothing extra needs enabling.
  - The actions offered are filtered against the intents your Home
    Assistant actually publishes, so the list can never offer something
    that would fail — and it stays a shortcut over the tool picker, not a
    replacement. An unusual device, a connector with no device list, or
    an action we haven't mapped all fall back to choosing the tool by
    hand.
  - If the device list can't be read, it says so and shows what came
    back, because "no devices exposed" and "unreadable response" look
    identical from the outside and need opposite fixes.

## [0.8.2] - 2026-08-31

### Fixed
- **You can now say *which* device a command acts on.** Home Assistant
  exposes intents — `HassTurnOff` — rather than one tool per device, so
  the lamp is an *argument* to the tool, not something you pick from the
  tool list. The editor didn't ask for those arguments, which left you
  able to build a command that says "turn something off" without ever
  saying what. Choosing a tool now shows a field for each argument it
  declares, marks the required ones, and offers a dropdown where the tool
  gives a fixed set of choices. A phrase slot of the same name overrides
  the fixed value when spoken, so one command can cover every room.

## [0.8.1] - 2026-08-31

### Fixed
- **Paste the token, not "Bearer <token>".** Connectors that authenticate
  with an `Authorization` header now add the `Bearer` scheme for you —
  what you copy out of Home Assistant or GitHub is the token, and having
  to know you must type a word in front of it produced a 401 that reads
  exactly like a bad token. The field used to say `Bearer …`, which made
  the app the source of the confusion. A value you supply with its own
  scheme (`Basic …`, `Token …`) is still used as-is, and headers like
  `X-API-KEY` are never touched. It's applied when the request is sent
  rather than when you save, so a connector already saved with a bare
  token starts working without being re-entered.
- **Connector errors say what actually went wrong.** "Couldn't list
  tools: unhandled errors in a task group" was the app reporting the
  wrapper around the real error rather than the error. It now names the
  cause — `404 Not Found`, `401 Unauthorized`, `All connection attempts
  failed` — which is the difference between knowing it's the URL, the
  token, or the server, at the one moment that matters.

## [0.8.0] - 2026-08-31

### Added
- **Command library.** One place for the things you've taught
  Promptly to do, whether you type them or (later) say them out loud. A
  saved prompt and a voice command turn out to be the same object with
  different action types — a prompt inserts text, an automation runs a
  flow, a tool command calls a connector — so they now live in one table
  behind one matcher, rather than two features that would have drifted
  apart. Your existing saved prompts are copied in automatically and keep
  working exactly as they do today; the old table is left untouched so
  nothing is at risk. Find it under **Automations**, which now has
  three tabs: Prompts, Commands, and the Scheduled flows that were
  already there.
  - **The matcher refuses to guess.** Matching is exact after
    normalisation: case, punctuation, accents, and filler like "Promptly,
    please…" are all levelled, so one phrase covers how people actually
    talk — but there's no fuzzy matching, no edit distance, and no "did
    you mean". Two commands claiming the same phrase match *nothing*
    rather than the app picking one. This sits in front of things that
    turn off lights and eventually unlock doors, where being right 95% of
    the time means doing something nobody asked for one time in twenty.
  - **A command never grants new capability.** It's a shortcut to
    something you could already do, so it's checked against the *target*
    every time it runs — you own that automation, that connector is
    switched on — rather than being trusted from when it was created. A
    command whose automation was deleted says so instead of looking like
    it worked, and switching off a connector switches off every command
    that used it without anyone hunting them down.
- **`/` in chat now runs commands, not just inserts prompts.** The same
  menu holds both: a prompt inserts text you then edit, exactly as
  before, while a command *does something* — runs an automation, calls a
  connected tool. Action rows are marked, say what they'll do before you
  pick them, and confirm before anything happens, because the difference
  between the two is a paragraph appearing versus a garage door opening.
  A voice-only library would be invisible — you'd have to remember what
  you set up and phrase it exactly right — so the typed menu is what
  makes it discoverable, and it ships first.
- **Commands you run from a chat land in the transcript.** Running one
  from `/` now records it as an activity card in the thread — the same
  card the assistant's own tool calls use — so the chat shows what
  happened instead of a toast that vanishes. Failures are recorded too,
  with the reason: a command that silently did nothing is the worst
  outcome, because you can't tell whether it fired. Runs from the library
  still just report back, since there's no thread to write to.
- **Home Assistant is now a connector you can add.** Pick it from the
  preset list in Settings → Connectors, paste a Long-Lived Access Token,
  and its devices become tools Promptly can call — which is what makes
  "turn the garage lights off" possible as a command. No bespoke
  integration was needed: Home Assistant already ships an official MCP
  server. What was missing was the **SSE transport** — Promptly only
  spoke streamable-HTTP, and HA (like plenty of other real MCP servers)
  speaks SSE. Both are supported now, picked per connector, with
  streamable-HTTP staying the default so existing connectors are
  untouched. Home Assistant on a LAN address works as-is.
- **Voice runs commands now.** The hands-free voice mode checks your
  command library before it asks a model anything. Say a phrase you've
  saved and it just happens — and because Whisper, the matcher and the
  speech reply all run on your own machine, and the action is a call on
  your own network, a matched command never touches a cloud API at all.
  Only speech that matches nothing falls through to the model, which is
  where any real waiting happens. Failures are spoken, not swallowed:
  across the room you can't see a toast, and a voice turn that goes
  quiet is indistinguishable from one that didn't hear you.
- **Commands that change something ask first, automatically.** Connectors
  tell us which of their tools alter the world rather than just reading
  it, and Promptly now uses that: pick one for a command and "ask before
  running" switches itself on, with the tool marked in the list. You
  shouldn't have to know which of a hundred Home Assistant services is
  the one that opens a door. Turning it back off stays your call, and
  picking a harmless tool afterwards never quietly un-guards a command
  you deliberately guarded. The model still can't call those tools at
  all — a shortcut you wrote and said out loud is a different thing from
  a model deciding on its own.
- **Home Assistant voice satellites can run your commands.** Promptly
  now speaks the Wyoming protocol as an intent handler, so the wall-
  mounted boxes and ESP32 satellites people already own can reach your
  command library — no Promptly hardware, no satellite to install. Home
  Assistant keeps doing the part it's good at (wake word, microphones,
  audio); Promptly does the part only it can (your commands, your
  documents). **Off by default, and it must stay that way unless you've
  read why**: the Wyoming protocol carries no authentication, so anything
  that can reach the port can run the acting user's commands. Keep it on
  a trusted network. It only ever runs commands and never a chat turn,
  so an exposed port can't be used to read documents or spend tokens,
  and speech it doesn't recognise is handed back to Home Assistant
  rather than answered.
- **Commands with numbers in them work when spoken.** Speech-to-text
  writes numbers as digits — "channel four" comes back as "channel 4" —
  so a phrase you'd written in words matched when typed and silently
  never fired when said out loud, which looks like voice being broken
  rather than the phrase being wrong. Number words and digits are now
  levelled to one form on both sides, the same way case and punctuation
  already were.
- **Spoken replies own up to not knowing.** Voice already answered in a
  sentence or two with no markdown; four rules were missing, and each
  only started to matter once answers began coming from your own
  documents. It now says so plainly when something isn't in what it was
  given, rather than filling three seconds with a confident guess — in
  voice there's no screen to check an answer against, so a plausible
  invention costs far more than it does in text. It also stops reading
  citation markers, filenames, paths and ids aloud, and speaks numbers
  and times the way a person does rather than as digits and ISO dates.
- **"Ask before running this one" is now per command, off by default.**
  Every side-effecting command used to confirm, which is the wrong shape
  — a dialog on every light toggle just teaches people to dismiss
  dialogs, so the one that mattered gets dismissed too. Tick the box for
  the garage door and leave it off for the lights. The flag governs both
  the typed and spoken paths, so a command can't be the kind that asks
  in one place and not the other. Spoken confirmations are asked out
  loud (a dialog is no use across the room), and anything that isn't a
  clear "yes" cancels.
- **Pick a tool from a list, not a UUID from an API.** Building a
  tool-calling command used to mean typing `<connector-id>:<tool-name>`
  by hand, which meant digging a UUID out of an admin endpoint first.
  It's now two dropdowns — connector, then tool — with the tool's own
  description underneath and a manual Refresh, since catalogs change
  when an admin adds a connector, not while you're filling in a form.
  The list shows only what you could already call by asking in a chat,
  so building a shortcut never reaches further than you can.
- **The library warns you when two commands share a phrase.** Promptly
  refuses to act on an ambiguous phrase rather than guessing which you
  meant, so a duplicate is a command that silently never fires. Both are
  now flagged in the list, because from the outside a command that does
  nothing looks identical to a broken app.
- **Automations works on a phone.** The page was desktop-only because of
  its flow canvas, but Prompts and Commands are things you reach for on a
  phone. The gate moved down to the canvas itself — everything else,
  including runs and pause/resume, now works on mobile.
- **The assistant can write to your memory itself.** Two new tools —
  `remember` and `forget` — let the model save a durable fact the moment
  you state it, and correct or drop one that's no longer true. Until now
  memory could only be written by a post-turn extraction pass sitting
  behind a phrase-matching gate, and the model itself never touched the
  store. Memory work runs silently — no tool card, no "ran 1 tool call" —
  because it is plumbing, not work worth narrating. Everything saved is
  still listed and editable in Settings → Memory. Advertised only when you
  have both memory and the Tools switch on, and never when memory is off.
  **Self-managed mode keeps its promise**: the tools are available there
  so an explicit "remember that…" works, but the assistant is instructed
  not to save anything you merely mention — automatic capture stays
  exclusive to Auto.

- **Edit your memory by describing the change.** Settings → Memory takes a
  plain-English instruction — "forget everything about my old job at Acme",
  "change my name to Tris" — and shows exactly what it would add, rewrite
  and remove before anything happens. Editing one row at a time is fine
  for a typo and tedious across a store of two hundred. Nothing is written
  until you press Apply, and every id in the plan is re-checked against
  your own memories server-side rather than trusted from the browser.

### Removed
- **The separate saved-prompts store is gone.** Its rows moved into the
  command library in this same release and nothing has read the old table
  since, so the table and its endpoints have been removed. Rolling the
  migration back re-creates them and copies your prompts back, including
  any written after the switch.

### Changed
- **Deep research reads its sources in parallel.** Each research angle
  fetched its two full-page sources one after the other — up to ~25
  seconds of serial waiting per angle on slow or anti-bot-walled pages,
  gating the gap-check phase on the slowest chain. The reads within an
  angle now run concurrently.
- **The assistant can look up what it doesn't have in front of it.** Only
  a handful of your saved facts are injected into any given chat — the
  ones judged relevant to what you just said — but nothing told the model
  that, so "what do you know about me?" was answered confidently from a
  sample of ten out of a possible two hundred. The injected block now says
  how many facts it is a selection of, and a new `recall` tool searches
  the rest. Read-only, and silent like the other memory tools.
- **Saved facts say how they were learned, not just when.** Memory has
  always recorded whether you stated something outright or it was picked
  up from conversation, and the prompt threw that away — so a month-old
  inference arrived with exactly the same authority as something you
  typed, with nothing to break the tie when they disagreed. Each line now
  reads `(stated, Aug 2026)` or `(inferred, Aug 2026)`.
- **Pinned memories no longer crowd out relevant ones.** Pinned facts are
  injected into every chat unconditionally, and they were drawing from the
  same ten slots as relevance — so pinning ten facts silently switched
  semantic retrieval off entirely, and pinning twenty doubled the injected
  block on top of that. Nothing in the UI hinted that "always keep this in
  mind" had a cost. Half the slots are now reserved for relevance, and
  pinning is capped at 12 with an explanation when you hit it.
- **Memory eviction now discards the stalest fact, not the least-injected
  one.** At the 200-fact cap the victim was chosen by an injection
  counter — which is incremented *by* injection and rewarded *by* the
  retrieval ranking, so a fact that kept being injected kept being
  protected whether or not it ever helped, while a genuinely useful fact
  that only fires for a rare topic looked like the cheapest thing to throw
  away. Eviction now goes by least-recently-useful.

### Fixed
- **The assistant no longer gives up on a search because its query was
  "too long".** The search tools declared hard character caps
  (`web_search` 400, `deep_research` / `run_agents` 600) in their
  schemas, and the server rejected any call that exceeded them before
  the tool could run — so a model that pasted your whole question as
  the query got back "exceeds maxLength", told you it went over the
  limit, and often just stopped. Over-long queries and agent tasks are
  now trimmed at a word boundary and searched anyway. Brave's own
  400-character / 50-word API limit is also clamped at the adapter, so
  a long query can't error there either.
- **A broken search provider no longer slows down every search.** A
  provider that timed out or returned zero results (the signature of a
  rate-limited SearXNG) was still tried *first* on every search, so
  every search paid its full 10-second timeout before failover kicked
  in — deep research multiplied that by every angle. After two
  consecutive transient failures a provider is now demoted to the back
  of the failover chain for a few minutes: still available as a last
  resort, no longer a toll booth in front of the providers that work.
- **Searching or fetching a page no longer stalls other people's
  replies.** The SSRF guard resolved DNS synchronously on the event
  loop — on this deliberately single-worker backend, one slow lookup
  froze every open chat stream. Resolution now runs off-loop.
- **"Search: always" works with reasoning models.** The query
  distiller didn't strip `<think>` blocks, so a reasoning model's
  chain-of-thought could get sent to the search engine as the query.
- **The failover chain budgets OpenRouter search at its real cost.**
  OpenRouter's search is a chat completion with a 30s ceiling, but the
  chain budgeted it like a 10s API call and could start a request it
  couldn't afford to finish, turning a recoverable failover into a
  bare "timed out". Its completion is also capped at fewer tokens now
  — the citations arrive early, the essay after them was pure latency.
- **Opening a PDF preview no longer downloads the file and shows a blank
  page.** The preview handed the PDF to the browser's built-in plugin via
  an ``<iframe>``, and a browser that declines to render one inline —
  Chrome's "Download PDFs instead of automatically opening them" setting
  is the common case — *downloads it and leaves the frame empty*. So
  clicking a file to look at it silently dropped a copy in Downloads and
  showed a white rectangle, for a button the user never pressed;
  downloading is what the Download button is for. PDFs are now rendered
  by pdf.js onto a canvas, with page count, zoom and scroll: same result
  in every browser, no plugin involved. The same fix covers the chat
  attachment panel and shared-link pages (a guest had the least context
  for a file appearing in their Downloads). pdf.js is lazy-loaded and
  excluded from the offline precache, so it only downloads for people who
  open a PDF.
- **The assistant can't delete a fact you pinned.** Pinning is the one
  signal that a fact matters more than the rest, so removing it is a
  decision for the person who pinned it — `forget` now refuses and says
  so, rather than quietly dropping it.
- **The per-chat memory pause now applies to the assistant too.** Pausing
  capture stopped the post-turn extraction pass but not the `remember`
  tool, so the assistant could still write to memory in a chat whose
  toggle said capture was off. Self-managed mode and the per-chat pause
  now resolve to the same rule in one place, rather than each path
  deciding for itself. Pausing is a hard off: it refuses even an explicit
  "remember this", which Self-managed mode still honours.
- **Credentials are screened out of memory.** Anything shaped like an API
  key, token, private key, card number or SSN is refused on both write
  paths. Memory is replayed into every relevant future chat, so a secret
  saved once is a secret re-injected indefinitely — and with the assistant
  now able to write memory and read fetched pages in the same turn, "don't
  save secrets" being a prompt instruction alone was the weakest link.
- **Memory can be corrected now, not just added to.** The machinery to
  rewrite and delete stale facts already existed, but the gate deciding
  whether to run it recognised assertions and almost nothing else: "I use
  Vim" was captured while "I don't use Vim any more", "I've switched from
  Python to Go", "stop calling me Tris" and "actually, I no longer work
  there" all passed straight through. So memory accumulated confidently
  wrong facts and had no realistic way to retract them — worse than not
  remembering, since a stale fact is injected into every relevant turn as
  established background. `remember(replaces=…)` is now the direct route,
  and the gate itself recognises corrections, negations and changes of
  state in every language it already covered.

## [0.7.2] - 2026-08-10

### Fixed
- **"Keep" no longer discards the subchat it was asked to save.** The
  window closed and the transcript was purged *before* the promotion was
  sent, so a failed request looked exactly like success — while the chat
  stayed ephemeral and the sweeper deleted it within 24h. Everything else
  about a subchat is meant to be thrown away, which made this the one
  place a silent failure cost anything. It now promotes first and only
  closes on success, and reports the failure instead of logging it to a
  console nobody has open (as do Open and Reset).
- **Subchats can use tools again.** The panel sent no `tools_enabled`, and
  the backend defaults it off — so code execution, page fetching and image
  generation silently didn't work in a subchat while the composer one
  panel over had them. The hook's own documentation claimed the opposite.
- **Escape meant for something else no longer closes a subchat.** The
  handler listened on `document` and nothing in the composer stops
  propagation, so the Escape that dismisses the @-mention popover, the
  slash-command popover or a message action menu also discarded the
  subchat. It now only closes when the keystroke was aimed at the window.
- **A subchat reply is no longer lost when you switch chats mid-answer.**
  The panel is torn down on navigation and dropping the reader tells the
  backend nothing, so the reply finished and was saved while the panel
  never heard — you'd come back to your question with no answer, forever,
  with the answer sitting in the database. It now reattaches to a live
  stream on return, or picks up the finished reply if it landed while you
  were away.
- **A dead connection no longer wedges the subchat on "Thinking…".** The
  panel's SSE reader was copied from the main chat's without its stall
  watchdog, so a half-closed proxy left the composer unusable until the
  subchat was discarded. Same 75s budget as the main chat now.

## [0.7.1] - 2026-08-10

### Fixed
- **Stop actually stops the reply now.** The button only aborted the
  browser's `fetch`, and generation doesn't live on that connection — it
  runs as a background task filling an in-process buffer, which is what
  lets you navigate away mid-reply and reattach. So the model ran to
  completion, the tokens were billed, the *whole* answer was saved, and
  reloading the page produced the finished reply you thought you'd
  stopped (revisiting the chat could even resume it on screen). Stop now
  cancels the generation server-side and saves the text written up to
  that moment as a real message marked `[Stopped.]`, so the reply ends
  where you stopped it. The same fix covers the subchat panel — which
  additionally threw the partial text away — and voice-mode barge-in.
- **The composer no longer freezes after Stop.** Cancelling nulled the
  turn's abort handle, so the turn's own cleanup couldn't recognise
  itself and skipped tearing down the streaming state: `isStreaming`
  stayed true forever, leaving the Stop button showing and the send
  button unreachable until a reload.

## [0.7.0] - 2026-08-10

### Added
- **React artifacts render live.** A `jsx` / `tsx` code block now gets a
  Preview tab in the artifact panel: the component is transformed with
  Sucrase and mounted in the same sandboxed iframe posture as the HTML
  preview (`allow-scripts`, no `allow-same-origin`). React's runtime is
  inlined into the document rather than fetched, so it works under the
  strict CSP and on an install with no internet. Plain `javascript` /
  `typescript` blocks deliberately don't get the tab — most aren't
  components. Imports other than React can't be resolved without a
  bundler, so they're caught up front and named in a readable message
  instead of failing as `require is not defined` at runtime; a component
  that mounts itself with `createRoot` is left to do so. The preview is
  lazy-loaded and excluded from the service-worker precache (~350 kB,
  nearly all of it React), so nobody pays for it until they open one.
  The tool-aware system prompt now steers models to emit one
  self-contained component for React requests.

## [0.6.4] - 2026-08-09

### Changed
- **`echo` is no longer advertised to the model.** A Phase A1 smoke test
  was being sent to every user in the tools payload *and* the tool-aware
  system prompt on every Tools-on turn — the same hazard that got
  `attach_demo` retired, since a model with a no-op tool in scope will
  eventually "demonstrate" it instead of answering. It keeps a `debug`
  category so it stays dispatchable for tests and diagnostics but is
  never offered. Twelve real tools are advertised now.
- **The tools switch says what it does.** It was a bare "AI tools"
  checkbox in the composer's overflow menu with no tooltip and no
  description, so the only way to discover that Promptly can search the
  web, read pages, run Python, generate PDFs and images or fan out to
  research agents was to have it happen by accident. It now names them,
  and the Settings description does too instead of citing one example.

### Removed
- `ToolsToggle.tsx`, which nothing imported. It carried the original
  "Enable AI tools (echo, file generation, more coming)" copy, so the
  most misleading description of the tool system in the codebase was one
  no user could ever see — only the next developer.

## [0.6.3] - 2026-08-09

### Fixed
- **Web search and page fetching are no longer killed mid-recovery.** Both
  tools allowed 30 seconds for work that can legitimately take longer:
  search tries each provider in turn at 10s apiece, so the documented
  four-provider setup needs 40s, and `fetch_url` may spend 12s on the
  direct fetch before its Tavily and Ollama fallbacks (10s each) — the
  steps that exist specifically to rescue a page that blocks crawlers. In
  both cases the dispatcher cancelled the tool right as it was recovering
  and the model got a bare "timed out", losing the reason and the fact
  that the next provider might well have answered. Both budgets now cover
  the real worst case, and the search chain is given an internal deadline
  so it stops *before* starting a provider it can't finish and reports
  what it tried — including the last provider's actual error — instead of
  being cancelled with nothing to show.
- **"Your file doesn't exist" — when it did.** `code_interpreter` dropped
  input files it couldn't read without telling anyone, and the sandbox
  stopped at its 64 MB total-input ceiling by discarding that file *and
  every remaining one*. The script's `read_csv('sales.csv')` then raised
  FileNotFoundError, and the model reported the file was missing while
  the user's attachment chip sat visible in the thread — a missing file
  and a typo'd filename produce the identical traceback, so it had no way
  to tell them apart. The result now opens with what actually loaded and
  what didn't, each with a reason, and the size ceiling no longer
  disqualifies the small files queued behind a large one.
- **Truncated output is no longer presented as complete.** The sandbox
  already computed `stdout_truncated`/`stderr_truncated` and the tool
  discarded them, so a clipped `df.to_string()` reached the model looking
  like a finished table and it answered from a partial one. The
  truncation is now stated explicitly.
- **The AI can read a whole long page again.** `fetch_url` cut every page
  at 6,000 characters and there was no way to see past it: the tool took
  only a `url`, its description told the model the rest was unavailable,
  and calling again replayed the identical prefix from the turn's dedup
  cache. So "summarise this article" quietly answered from the first 15%
  of a long one, with nothing to suggest the answer was partial. Pages
  are now paginated rather than clipped — the truncation notice reports
  the character range shown and the exact `offset` to pass to continue,
  and the model has six fetches per turn to work through it. The
  discovered-links block is only attached to the first chunk (it's
  page-level, and repeating it burned the budget it exists to save), and
  the citation snippet still comes from the top of the page so a
  continuation doesn't retitle the source with mid-article text.

## [0.6.2] - 2026-08-09

### Fixed
- **Code in replies is no longer silently corrupted.** Inline citation
  markers were stripped with a regex run over the whole message, code
  blocks included — and array indexing is indistinguishable from a
  citation. `print(items[0])` rendered as `print(items)` and
  `matrix[1][2];` as `matrix;`. Because Copy strips too, users were
  pasting broken code with no sign anything had changed. Stripping now
  skips fenced blocks and inline code, and leaves Markdown link
  definitions (`[1]: https://…`) intact.
- **Research sub-agents no longer produce citations that point at the
  wrong pages.** Each agent numbered its own sources — and `web_search`
  restarts at `[1]` on every call — so those markers couldn't be mapped
  onto anything, yet the parent model was told to cite "from the merged
  list" and copied them verbatim. Clicking a citation landed on an
  unrelated source. The unresolvable markers are now removed from agent
  briefs and the merged sources are presented numbered once, correctly,
  for the parent to cite against.
- **Boards with custom columns work with the AI again.** The chat tools
  matched a column *id* against the column *name* the model reads from
  the board text, so on any board with custom columns "how many are in
  review?" answered **0 cards** as fact, and "mark the in-progress ones
  done" wrote a status no column owned — the card wasn't actually
  completed and the board put it in the *first* column, so work the user
  asked to finish moved to the backlog under a proposal marked
  "Applied". Both tools now resolve against the board's real column
  registry (by name, id, or alias) and say which columns exist when a
  name doesn't match.
- **A failed Deep Research run says so.** The card previously just
  vanished after 1–3 minutes of visible progress — no message, no
  reason, and any partially-written report discarded — even though the
  failure reason was recorded and simply never rendered. It now shows
  what went wrong and offers the partial report.
- **Tool failures explain themselves.** The backend writes useful
  messages ("this workspace has several boards — pass the board
  argument", "no label named X"), and the UI discarded them one layer
  before rendering, showing only "failed". The reason is now shown on
  the step.

## [0.6.1] - 2026-08-09

### Added
- Tests for the **multi-hop tool path** in chat — a tool is called, its
  result feeds the next model hop, and the final reply persists with the
  per-turn tool log the Tool Activity Card renders. The streaming tests
  added in 0.6.0 all ran with tools disabled, so this half was still
  uncovered. Also pins the property that no database connection is held
  across a tool call, so a future refactor can't quietly reintroduce one.

## [0.6.0] - 2026-08-09

### Added
- **The chat streaming path has tests.** It's the most critical code in
  the app and had none, because it genuinely needs a database and Redis to
  do anything and the suite had no harness for either. There is one now —
  a scratch database built by running the real Alembic chain (so a
  migration that doesn't apply cleanly fails the suite), plus row
  factories and a stubbed model provider. CI gained Postgres and Redis
  service containers to run it, and fails rather than skips if they're
  missing, so a broken service can't produce a green run that proved
  nothing.
- Four end-to-end tests over a real generation, two of which lock in fixes
  previously verified only by hand: the reply is streamed **and persisted**
  with token usage recorded, deleting a chat mid-reply still closes the
  stream cleanly and writes nothing, and — the important one — **no
  database connection is held during the model call**, which is what
  stopped concurrent replies from exhausting the pool and restarting the
  container. That last one is asserted by sampling pool occupancy at the
  moment the provider is called; it confirmed the generation holds zero
  connections while the model is working.

## [0.5.3] - 2026-08-09

### Fixed
- **A crashed worker no longer disables an automation forever.** A run
  moves `pending` → `running` → done, and only the worker moved it out of
  the first two states — so if the worker was killed mid-run (OOM,
  redeploy, `docker compose down`) the row stayed non-terminal
  permanently. That mattered because two things treat a non-terminal run
  as "still in flight": a task set to skip overlapping runs was then
  skipped on **every future tick** (logged once at INFO, so the
  automation just quietly stopped), and webhook triggers counted the
  orphan toward their queue cap and eventually returned a permanent 429.
  A sweeper now fails runs that have outlived any legitimate execution —
  90 minutes for `running`, comfortably past the worker's own 55-minute
  job timeout, and 30 for `pending` — with a message distinguishing "the
  worker died mid-run" from "the worker never picked it up", and a
  warning in the log because a reaped run means work was lost.

## [0.5.2] - 2026-08-09

### Changed
- **Opening a chat no longer downloads the whiteboard and spreadsheet
  editors.** The browser was preloading ~10.6 MB of JavaScript on every
  page load; it now preloads **3.2 MB**. Excalidraw (4.6 MB),
  Fortune-Sheet (2.7 MB) and React Flow (163 kB) are genuinely fetched on
  demand, verified on a cold load with the service worker cleared.
  Cause: DOMPurify and Vite's dynamic-import helper matched no chunking
  rule, so Rollup was free to place those shared modules inside the
  excalidraw chunk — which meant the entry had to statically import 4.6 MB
  of whiteboard editor just to sanitize a message, dragging the other
  editors along behind it. Both are now pinned to their own small chunks.

## [0.5.1] - 2026-08-09

### Changed
- **Pages now load on demand instead of all at once.** Every route was
  imported eagerly, so opening a chat first downloaded the admin console,
  the automations flow editor and the whole Drive surface — a 2.4 MB
  entry chunk to render a text box. Routes are code-split now and the
  entry is **1.2 MB, roughly half**. The heaviest pages became their own
  chunks (admin 222 KB, workspace detail 343 KB) fetched on first visit.
  Login, MFA and the chat page stay eager on purpose: they're the first
  screens you see, and splitting them would only add a spinner to the
  most common path. The pending state lives in the app layout, so
  navigation shows a spinner in the content area rather than blanking the
  sidebar. Uses the existing `lazyWithRetry`, so a redeploy under an open
  tab still recovers instead of failing on a stale chunk name.

## [0.5.0] - 2026-08-08

### Added
- **A Health tab in Admin → Console** showing what the app is actually
  doing right now: database-pool usage against its ceiling, replies in
  flight, background tasks, memory, request counts by status class, and
  p50/p95/p99 response times. Promptly had no metrics of any kind, which
  meant the recent resource-starvation fixes (a pooled connection held
  for a whole generation, large uploads blocking the event loop,
  background tasks being collected mid-flight) were all made blind —
  with no way to confirm a fix held or to spot the next one before users
  did. The pool bar is the one to watch: exhausting it also blocked the
  health check, which got the container restarted mid-reply.
- `GET /api/admin/metrics` (admin-only) backs the panel. Deliberately a
  plain JSON snapshot rather than a Prometheus endpoint — the operator
  here is an admin on a settings page, not an SRE with a scraper. Numbers
  are collected in-process, cost nothing (counters plus a fixed-size
  latency ring), and are fed from the timing the access log already
  computes, so there's no second middleware and no extra clock reads.

## [0.4.2] - 2026-08-08

### Fixed
- **Background work can no longer vanish before it runs.** Nine places
  fired off a task and discarded the handle, but the event loop keeps
  only a *weak* reference to tasks — so Python was free to collect them
  mid-flight. The affected work is all the kind whose disappearance is
  silent: push notifications and inbox rows, workspace-memory refresh,
  chat re-indexing, automation event fan-out, the Redis-unavailable
  fallback for task runs, stream-session eviction, and the write that
  persists captured errors (so the admin error log could drop exactly
  the errors that happen under load). All now go through a shared helper
  that holds a reference until completion **and logs failures** —
  previously a crash in one of these surfaced only as asyncio's "Task
  exception was never retrieved" during garbage collection, attributed
  to nothing in particular.

## [0.4.1] - 2026-08-08

### Fixed
- **Large file operations no longer freeze the whole backend.** Promptly
  runs a single uvicorn worker by design, so a synchronous write in an
  async handler stalls every user at once — no chat tokens, no SSE, not
  even the health check. Uploading a meeting recording (allowed up to
  100 MB) did exactly that, as did downloading a folder as a zip, which
  deflate-compresses up to 1 GB inline. Both now run off the event loop.
  Covered by tests that race a heartbeat against the write, so the
  regression is caught rather than remembered.

## [0.4.0] - 2026-08-08

### Added
- **First-run setup now connects a model provider.** The wizard gained a
  provider step (OpenRouter / Anthropic / OpenAI / local Ollama) right
  after account creation, so a fresh install can actually answer a
  message when setup finishes — previously it configured SMTP, CORS and
  MFA but never the model, and landed on a chat screen that couldn't
  reply. Skipping is still allowed but says plainly that chat won't work.
- A provider set via `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` in the environment is now **seeded automatically on
  first boot**, and the wizard detects it and skips the provider step.
- **An in-flight reply now survives a server restart.** Generation state
  lives only in process memory, so every restart — including a routine
  `docker compose up -d` — silently destroyed replies that were still
  being written: no message row, no billing entry, and the chat left
  showing a question with no answer and no error. Shutdown now persists
  whatever text has accumulated, marked inline as interrupted. Bounded by
  an 8s timeout so a slow save can't hang the shutdown, and covered by
  the first automated tests this path has ever had.
- **Continuous integration** (`.github/workflows/ci.yml`) — the repo's
  first automated gate. Runs the backend test suite, frontend lint, and
  the full production build (which is where PWA precache failures
  surface) on every push and pull request.
- **ESLint is now real.** A `lint` script had existed for a long time
  with no config and no eslint installed, so it could never run; there
  is now a flat config (typescript-eslint + react-hooks + jsx-a11y) that
  passes clean on errors. `npm run lint:strict` also fails on the ~233
  known warnings for burning that debt down.

### Fixed
- **A chat reply no longer holds a database connection for its whole
  generation.** The streaming path kept one pooled connection checked out
  as `idle in transaction` from the first prep query until the reply was
  persisted — across every tool hop and model round-trip. With
  `pool_size=10, max_overflow=20` that capped the instance at roughly 30
  concurrent replies, and once the pool drained even `/api/health`'s
  `SELECT 1` blocked, so the container was marked unhealthy and restarted,
  killing every in-flight stream. The connection is now returned to the
  pool around each model call and re-acquired on demand.
- Tool side-effects (a generated image or PDF, a workspace write) are now
  committed as they happen instead of sitting uncommitted in the reply's
  transaction, where they were rolled back and lost if the generation
  later failed.
- **The setup wizard ended after its first step.** Creating the admin
  account flipped auth status to "authenticated", which swapped the
  router to the signed-in branch — where `/setup` redirects to `/chat`.
  Every step after account creation was therefore unreachable, so no
  install ever got the chance to configure a public URL, an embedder, or
  SMTP. Status now flips when the wizard actually finishes.
- **Two conditional-React-hook bugs**, both caught by the new lint gate:
  `ResearchProgressCard` called `useMemo` after an early `return null`,
  and `WorkspaceDetailPage` called `useState`/`useCallback` after its
  `!id` guard. Either one throws "rendered fewer hooks than expected"
  and blanks the page if the component re-renders across that boundary
  instead of unmounting.
- The zero-provider chat screen is actionable instead of misleading: it
  no longer points at a "Models tab" that no longer exists, gives admins
  a button straight to the right settings tab, and tells non-admins to
  ask an administrator — previously they clicked "Configure a model" and
  were silently bounced back to the same broken screen.
- The backend test suite runs again. It had been broken since the Study
  feature was deleted — two test files still imported the removed
  `app.study` module, so `pytest` failed at collection and every test
  silently stopped running. Also repaired a stale test that patched
  `run_search` after the search-failover work moved callers onto
  `run_search_with_failover`.

### Changed
- The setup wizard's embedding step now says what it's actually asking
  for. It never used the words "embedding model" anywhere prominent, and
  its two tiles looked almost identical to the model-provider tiles a
  couple of steps earlier (both offered "Local (Ollama)"), so it read as
  picking the same thing twice. It now names the thing, explains that it
  powers search, states plainly that it is *not* the chat model, and
  confirms what was configured. The "API provider" tile — which sets up
  nothing and defers to the admin panel — says so.
- `scripts/release.ps1` works on Windows again. Its `[Unreleased]` regex
  didn't tolerate carriage returns, so with `core.autocrlf=true` (the
  Windows default, and this is the Windows-primary script) it refused to
  cut any release at all.
- Ollama Web Search admin hint rewritten to be honest about the free
  tier: it's small (unpublished; ~a dozen searches per cycle in
  practice), so the guidance is now "last in the chain / blocked-page
  rescue", not "great primary".

## [0.3.0] - 2026-07-23

### Added
- **Ollama Web Search** as a web-search provider: Ollama's hosted search
  API (free tier with a free ollama.com account, API key auth). Joins the
  admin-ordered failover chain like any other provider — a zero-cost,
  off-instance alternative to self-hosted SearXNG.
- `fetch_url` gained a second blocked-page rescue: when the direct crawl
  is 403'd/empty and Tavily Extract can't recover it (or isn't
  configured), Ollama's hosted `web_fetch` now takes a turn. The tool
  chip shows "via Ollama" / "via Tavily" for whichever fetcher saved the
  page.

## [0.2.1] - 2026-07-23

### Fixed
- Leaked tool-call markup (e.g. DeepSeek's `<|DSML|…>` blocks) no longer
  lingers on screen: the stream's `done` event now carries the persisted
  (sanitized) reply text and the client prefers it over its raw delta
  accumulation — so backend-side cleanup and synthesis-retry answers
  actually reach the bubble. The live streaming bubble also elides the
  markup client-side while tokens are still arriving.

## [0.2.0] - 2026-07-23

### Added
- Workspace **Discussions**: a new `discussion` item kind giving members a
  threaded place to talk inside a workspace — thread rail, chronological
  messages, composer (Enter to send, Shift+Enter for a newline), and delete
  on your own threads/messages. Available from the navigator's **New** menu.
- Discussions show each author's **profile picture** next to their messages,
  in the thread rail, and on the thread header (initials chip when no
  picture is set).
- Discussions are **realtime**: new threads, messages, and deletions push to
  every open pane over SSE (Redis pub/sub fan-out) instead of the old 6s
  poll. A dropped stream reconnects with backoff and a slow safety-net
  refetch keeps the pane honest.
- Discussions are **opt-in for AI context**: they're created excluded from the
  workspace RAG pool, and the pane says so until a member turns the ⚡ on.
- Discussion RAG indexing: turning a discussion's context toggle ON flattens
  its threads into a backing Markdown file in the workspace's `Discussions/`
  Drive folder and embeds it into the workspace pool (re-indexed on every
  post); turning it OFF purges the chunks and trashes the file.
- Mobile: start a **New chat** or **New discussion** directly from the
  workspace item list on a phone.

### Changed
- Mobile workspaces: **Discussions are now usable on a phone** — the pane
  collapses to a single column (thread list → tap → messages screen with a
  back button and a keyboard-safe composer pinned to the bottom).
- Mobile workspaces no longer lock the interactive kinds: **chats and
  discussions are now fully editable** on a phone (post messages, start
  threads); notes stay read-only and the heavier editors still defer to
  desktop. Stale "read-only" copy updated to match.

### Fixed
- Chat streaming is now fully scoped to its conversation: switching chats
  mid-reply shows the chat you clicked, **browsing back to the streaming
  chat restores its thread with the live reply still ticking**, and a reply
  finishing while you're elsewhere lands in its own chat (visible instantly
  on return, no refetch wait). Sending from the New-chat screen tags its
  turn correctly so another chat's stream can never bleed into it.
- A cancelled/superseded turn can no longer wipe the next turn's live
  streaming state (thinking bubble vanishing, replies popping in all at
  once, sent messages not appearing until the reply finished).
- Dead SSE connections can't freeze chat any more: the backend now sends a
  keepalive ping every 20s while the model is quiet, and the frontend
  aborts a stream after 75s of total silence (the reply keeps generating
  server-side and appears on revisit) instead of leaving the send button
  and chat switching stuck forever.

### Removed
- The **"New from template"** entry in the workspace navigator's New menu
  (and the now-unreachable note-template picker behind it).

## [0.1.0] - 2026-07-12

### Added
- Initial versioned baseline. Establishes the `0.1.0` starting point, the
  `VERSION` file, this changelog, the `scripts/release.*` bump helper, and the
  in-app version indicator in the sidebar footer.
