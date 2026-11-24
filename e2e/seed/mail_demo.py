"""A made-up mailbox for e2e_alice, for looking at the Mail list (tools-mail-shots.mjs).

Piped into a PRIVATE stack's backend container (never the main app):

    docker exec -i <stack>-Backend python - < e2e/seed/mail_demo.py

Rows only: the mailbox's server is ``mail.invalid``, which doesn't exist, so nothing
is ever fetched or sent. Run it again to start over. ``python - remove`` takes it away.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailLabel, MailMessage, MailThreadLabel

EMAIL = "alex.morgan@example.com"
PDF, XLSX, DOCX, JPG, PNG, ZIP, PPTX = (
    "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/jpeg", "image/png", "application/zip",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
)

# (hours ago, who, address, subject, words, files, unread, starred, label)
MAIL = [
    (0.4, "Priya Nair", "priya.nair@example.com", "Quote for the kitchen splashback", "Hi Alex, the quote and the two tile options we talked about are attached. The grey one is in stock now.", [("Splashback quote 1182.pdf", PDF, 184_320), ("Tile options.jpg", JPG, 1_412_000)], True, False, None),
    (1.2, "Riverside Primary", "office@riverside.example.org", "Year 4 camp: forms due Friday", "Dear families, please return the permission and medical forms by Friday. The packing list is attached too.", [("Camp permission form.pdf", PDF, 96_000), ("Medical details form.docx", DOCX, 48_200), ("Packing list.pdf", PDF, 51_700), ("Camp timetable.xlsx", XLSX, 22_400)], True, False, None),
    (2.5, "Mum", "helen.morgan@example.com", "Photos from Sunday", "Lovely to see you all. Here are the ones of the kids in the garden, the last one is my favourite.", [("IMG_2041.jpg", JPG, 2_310_000), ("IMG_2042.jpg", JPG, 2_190_000), ("IMG_2047.jpg", JPG, 2_480_000), ("IMG_2051.jpg", JPG, 2_050_000), ("IMG_2053.jpg", JPG, 2_270_000)], True, True, None),
    (3.1, "Sam Okafor", "sam.okafor@example.com", "Re: Saturday football", "Works for us. We can take Leo and bring him back after, no trouble at all.", [], False, False, None),
    (4.8, "Northside Energy", "billing@northside-energy.example.com", "Your November bill is ready", "Your bill for 1 to 30 November is $182.40, due 14 December. A copy is attached for your records.", [("Northside Energy bill November 2026 account 00418827.pdf", PDF, 212_000)], False, False, None),
    (6.0, "Jordan Lee", "jordan.lee@example.com", "Budget for the trip", "I've put everything in the sheet, flights are the big one. Have a look and change whatever you like.", [("Trip budget v3.xlsx", XLSX, 38_900)], True, False, None),
    (7.5, "Dr Patel's rooms", "reception@patelclinic.example.com", "Appointment reminder: Thursday 9:40 am", "This is a reminder of your appointment on Thursday at 9:40 am. Please arrive ten minutes early.", [], False, False, None),
    (9.0, "Tom Fischer", "tom.fischer@example.com", "Slides for Thursday", "Draft deck attached. Slides 6 to 9 still need your numbers, the rest is done.", [("Q4 review draft.pptx", PPTX, 3_640_000), ("Speaker notes.docx", DOCX, 27_300)], False, False, None),
    (11.0, "City Library", "noreply@citylibrary.example.org", "Two books are due on Monday", "The Wild Robot and Atlas of Adventures are due back on Monday. You can renew them online.", [], False, False, None),
    (13.5, "Aunt Carol", "carol.b@example.com", "Grandad's 80th", "We're thinking the first weekend of February at the hall. Could you bring the old photo albums?", [], False, True, None),
    (20.0, "Harbour Vets", "hello@harbourvets.example.com", "Biscuit's vaccination certificate", "Thanks for bringing Biscuit in today. His certificate is attached, the next one is due in twelve months.", [("Vaccination certificate - Biscuit.pdf", PDF, 74_000)], False, False, None),
    (26.0, "Mia Chen", "mia.chen@example.com", "Book club: next month's pick", "We settled on The Covenant of Water. It's long, so start early. My place on the 18th.", [], False, False, None),
    (30.0, "Greenway Rentals", "agent@greenway.example.com", "Inspection report and photos", "The routine inspection went well. The report and the photos we took are attached.", [("Inspection report.pdf", PDF, 410_000), ("Photos.zip", ZIP, 18_400_000)], False, False, None),
    (33.0, "Leo's coach", "coach.dan@example.com", "Team sheet for Saturday", "Leo's starting at left back. Kick-off is 9:15 at the top oval, please be there by 8:45.", [("Team sheet round 12.pdf", PDF, 61_000)], False, False, None),
    (40.0, "Nina Alvarez", "nina.alvarez@example.com", "Recipe you asked for", "Here it is. Double the garlic, whatever it says. It freezes well.", [("Nonna's ragu.pdf", PDF, 133_000)], False, False, None),
    (47.0, "Parcel Post", "tracking@parcelpost.example.com", "Your parcel is out for delivery", "Your parcel from Bright Lights will arrive today between 1 pm and 5 pm.", [], False, False, None),
    (52.0, "Ben Carter", "ben.carter@example.com", "Signed contract", "All signed on our side. Countersigned copy attached, the start date is the 2nd.", [("Contract - countersigned.pdf", PDF, 288_000)], False, True, None),
    (58.0, "Swim School", "bookings@swimschool.example.com", "Term 1 timetable", "Term 1 starts on 3 February. Ava's class has moved to Tuesdays at 4:30.", [("Term 1 timetable.pdf", PDF, 88_000)], False, False, None),
    (70.0, "Dad", "peter.morgan@example.com", "Shed plans", "Had a go at drawing it up. Tell me if the door is on the wrong side.", [("Shed plans.png", PNG, 940_000)], False, False, None),
    (76.0, "Olivia Brandt", "olivia.brandt@example.com", "Thank you!", "The kids loved it. Ava hasn't stopped talking about the trampoline.", [], False, False, None),
    (5.5, "Council Rates", "rates@council.example.org", "Rates notice: second instalment", "Your second instalment of $486.00 is due on 28 November.", [("Rates notice 2026-27.pdf", PDF, 156_000)], False, False, "Bills"),
    (28.0, "Mum", "helen.morgan@example.com", "Christmas lunch", "I'll do the ham if you can do the pudding. Shall we say 12:30?", [], True, False, "Family"),
]
EXTRA_PEOPLE = [("Hannah Wells", "hannah.wells@example.com"), ("Marcus Reid", "marcus.reid@example.com"), ("Yuki Tanaka", "yuki.tanaka@example.com"), ("The Garden Centre", "news@gardencentre.example.com"), ("Elena Rossi", "elena.rossi@example.com")]
EXTRA_SUBJECTS = [
    ("Lunch next week?", "Are you free Wednesday or Thursday? There's a new place near the station."),
    ("Minutes from the committee meeting", "Attached are the minutes. Actions are at the bottom, yours is the hall booking."),
    ("Car service booked", "You're booked in for Tuesday at 8 am. It should be ready by 3."),
    ("Spring planting guide", "What to sow this month, and how to keep the snails off it."),
    ("Re: Spare room", "Yes, the 14th to the 17th is fine. We'll make up the bed."),
    ("Lost jumper", "Did Leo come home with a green jumper that isn't his? Name tag says Finn."),
    ("Piano lessons next term", "Same time on Mondays if that still suits. Fees are unchanged."),
]


async def remove(db, user: User) -> None:
    await db.execute(delete(MailAccount).where(MailAccount.user_id == user.id, MailAccount.email == EMAIL))
    await db.execute(delete(MailLabel).where(MailLabel.user_id == user.id, MailLabel.name.in_(["Family", "Bills", "School"])))
    await db.commit()


async def main() -> None:
    async with SessionLocal() as db:
        user = await db.scalar(select(User).where(User.username == "e2e_alice"))
        if user is None:
            raise SystemExit("no e2e_alice: run an e2e spec against this stack first")
        await remove(db, user)
        if "remove" in sys.argv[1:]:
            print("removed")
            return
        account = MailAccount(
            user_id=user.id, email=EMAIL, display_name="Alex Morgan", imap_host="mail.invalid", imap_port=993, imap_security="ssl",
            smtp_host="mail.invalid", smtp_port=465, smtp_security="ssl", username=EMAIL, secret_encrypted=encrypt_secret("not-a-real-password"),
            status="ok", last_sync_at=datetime.now(timezone.utc), notify=False,
        )
        db.add(account)
        await db.flush()
        inbox = MailFolder(account_id=account.id, path="INBOX", name="Inbox", role="inbox")
        db.add(inbox)
        labels = {name: MailLabel(user_id=user.id, name=name, color=colour) for name, colour in (("Family", "#3FA66B"), ("Bills", "#D98A3D"), ("School", "#5B8DD9"))}
        db.add_all(labels.values())
        await db.flush()
        now = datetime.now(timezone.utc)
        rows = list(MAIL)
        # A long inbox underneath, so there's something to scroll.
        for n in range(48):
            who, addr = EXTRA_PEOPLE[n % len(EXTRA_PEOPLE)]
            subject, words = EXTRA_SUBJECTS[n % len(EXTRA_SUBJECTS)]
            files = [("Minutes.pdf", PDF, 70_000)] if subject.startswith("Minutes") else []
            rows.append((80 + n * 9.5, who, addr, subject, words, files, False, False, None))
        for uid, (ago, who, addr, subject, words, files, unread, starred, label) in enumerate(rows, start=1):
            key = uuid.uuid4().hex
            db.add(MailMessage(
                account_id=account.id, folder_id=inbox.id, uid=uid, thread_key=key, message_id=f"<{key}@demo.invalid>", subject=subject,
                from_name=who, from_addr=addr, to_addrs=[{"name": "Alex Morgan", "addr": EMAIL}], cc_addrs=[], sent_at=now - timedelta(hours=ago),
                snippet=words[:240], body_text=f"{words}\n\nTalk soon,\n{who.split()[0]}", body_html="",
                attachments=[{"part": i + 2, "name": name, "mime": mime, "size": size} for i, (name, mime, size) in enumerate(files)],
                seen=not unread, flagged=starred, triaged=True,
            ))
            if label:
                db.add(MailThreadLabel(label_id=labels[label].id, account_id=account.id, thread_key=key))
        # A conversation: the reply is the newest, the file came with the first email.
        key = uuid.uuid4().hex
        for i, (ago, who, addr, words, files) in enumerate([
            (15.0, "Grace Whitfield", "grace.whitfield@example.com", "Here's the draft itinerary. Day three is the long drive, so I kept the afternoon free.", [("Itinerary draft.docx", DOCX, 64_000), ("Route map.png", PNG, 1_120_000)]),
            (8.2, "Grace Whitfield", "grace.whitfield@example.com", "Good call on the ferry. I've moved it to the morning and updated the booking sheet.", [("Bookings.xlsx", XLSX, 29_800)]),
        ]):
            db.add(MailMessage(
                account_id=account.id, folder_id=inbox.id, uid=900 + i, thread_key=key, message_id=f"<{key}-{i}@demo.invalid>", subject=("Re: " if i else "") + "Itinerary for January",
                from_name=who, from_addr=addr, to_addrs=[{"name": "Alex Morgan", "addr": EMAIL}], cc_addrs=[], sent_at=now - timedelta(hours=ago),
                snippet=words, body_text=words, body_html="", attachments=[{"part": j + 2, "name": n, "mime": m, "size": s} for j, (n, m, s) in enumerate(files)],
                seen=i == 0, flagged=False, triaged=True,
            ))
        await db.commit()
        print(f"mailbox {account.id} with {len(rows) + 2} emails")


asyncio.run(main())
