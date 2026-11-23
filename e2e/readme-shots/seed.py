"""Demo data for the README screenshots: the made-up Hartley family.

Part one of two. This half runs INSIDE a throwaway stack's backend
container and writes what has no simple API (accounts, the model list,
finished chats, a mailbox, a Study course). It prints JSON with each
person's id and sign-in tokens; ``tools-readme-seed.mjs`` (part two) uses
those to fill everything else over the ordinary API.

    docker exec -i PromptlyShots-Backend python - < e2e/readme-shots/seed.py

Never run this against a real install: it creates the first admin.
Everything here is invented. No real people, places or addresses.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

import app.db_models  # noqa: F401  (every mapper, so relationships resolve)
from app.auth.models import User
from app.auth.utils import create_access_token, create_refresh_token, encrypt_secret, hash_password
from app.chat.models import ChatFolder, Conversation, Message
from app.database import SessionLocal
from app.files.system_folders import seed_system_folders
from app.items.service import install_defaults
from app.mail.models import MailAccount, MailFolder, MailMessage
from app.models_config.models import ModelProvider
from app.models_config.service import encrypt_api_key
from app.study.models import StudyConcept, StudyDay, StudySource, StudySubject, StudyUnit

TZ = "Australia/Sydney"
NOW = datetime.now(timezone.utc)

PEOPLE = {
    # key: (username, email, role, avatar colour)
    "claire": ("Claire", "claire@hartley.example.com", "admin", "#D97757"),
    "tom": ("Tom", "tom@hartley.example.com", "user", "#4F7FE0"),
    "ellie": ("Ellie", "ellie@hartley.example.com", "user", "#8E6BD9"),
    "max": ("Max", "max@hartley.example.com", "user", "#4E9F5B"),
}

MODELS = [
    {"id": "demo-large", "display_name": "Claude Sonnet 4.5", "context_window": 200000, "supports_vision": True, "supports_tools": True},
    {"id": "demo-small", "display_name": "Claude Haiku 4.5", "context_window": 200000, "supports_vision": True, "supports_tools": True},
    {"id": "demo-local", "display_name": "Llama 3.3 70B (local)", "context_window": 128000, "supports_vision": False, "supports_tools": True},
]

DINNER_Q = (
    "Can you plan weeknight dinners for this week? Four of us, Max won't eat mushrooms, "
    "Ellie has netball Tuesday and Thursday so those nights need to be quick. "
    "Under 40 minutes each, and one meat-free night."
)
DINNER_A = """Here's a week that fits around netball, with the two quick nights on Tuesday and Thursday.

| Day | Dinner | Time | Notes |
| :-- | :-- | :-- | :-- |
| **Monday** | Lemon and herb chicken traybake with potatoes and green beans | 40 min | One tray, little washing up |
| **Tuesday** | Beef and veggie tacos | 20 min | Netball night. Everyone builds their own |
| **Wednesday** | Chickpea and spinach curry with rice | 30 min | Meat-free. Mild, so add chilli at the table |
| **Thursday** | Pesto pasta with cherry tomatoes and peas | 15 min | Netball night. Cook double for Friday lunches |
| **Friday** | Homemade pizzas | 35 min | Bases from the freezer. No mushrooms on Max's half |

**Shopping list** (leaving out what's usually in the pantry)

- **Meat:** 8 chicken thighs, 500 g beef mince
- **Fruit and veg:** baby potatoes, green beans, 2 lemons, lettuce, 3 tomatoes, avocado, baby spinach, cherry tomatoes, capsicum, onion, garlic
- **Fridge and freezer:** grated cheese, sour cream, mozzarella, frozen peas, 4 pizza bases
- **Pantry:** taco shells, 2 tins chickpeas, tin of coconut milk, curry paste, basmati rice, pesto, penne, passata

A couple of ways to save time:

1. Chop the onion and capsicum for both tacos and pizzas on Tuesday.
2. Wednesday's curry freezes well, so a double batch covers a night next week.

Want me to add these to the meal planner and put the shopping list in Notes?"""
DINNER_Q2 = "Yes please. And swap Friday to burgers, we had pizza on the weekend."
DINNER_A2 = """Done. Friday is now **beef burgers with oven wedges and slaw** (30 minutes), and I've changed the list to match: the pizza bases, mozzarella and passata are off, and burger buns, 500 g more mince, a small cabbage and two carrots are on.

- The five dinners are in **Meal Planner** for Monday to Friday.
- The shopping list is in **Notes** as *Groceries*, shared with Tom.

I left Thursday's pasta at double so there's enough for lunches."""

OTHER_CHATS = [
    ("Tasmania road trip ideas", "Home", True, 1),
    ("Is 6.6 kW of solar enough for us?", "Home", False, 2),
    ("Help Max with fractions homework", None, False, 2),
    ("Reply to the school about the camp form", None, False, 3),
    ("What to plant in November", "Garden", False, 5),
    ("Birthday party games for 12 year olds", None, False, 8),
    ("Compare the two car insurance quotes", "Home", False, 11),
    ("Sourdough starter keeps going flat", None, False, 16),
    ("Summarise the strata meeting minutes", None, False, 22),
    ("Packing list for a week of camping", None, False, 30),
]

MAIL = [
    # (hours ago, from name, from addr, subject, body, seen, flagged)
    (1.2, "Wattle Creek High School", "office@wattlecreekhigh.example.com", "Year 10 camp: forms due Friday",
     "Dear families,\n\nA reminder that permission and medical forms for the Year 10 camp at Lake Merrin are due this Friday. Students leave from the front gate at 7:15 am on Monday 7 December and are back by 3 pm on Wednesday.\n\nA packing list is attached to the original notice. Please label everything.\n\nKind regards,\nThe front office", False, True),
    (3.5, "Tom Hartley", "tom@hartley.example.com", "Re: Solar quotes",
     "The second one is cheaper but the inverter is a brand I can't find much about. Can we go through them tonight after dinner? I put both PDFs in the House folder.\n\nT", False, False),
    (6, "Riverbend Dental", "reception@riverbenddental.example.com", "Appointment reminder: Max, Thursday 3:45 pm",
     "Hello Claire,\n\nThis is a reminder that Max has a check-up and clean with Dr Okafor on Thursday at 3:45 pm. Please reply to this email or call us if you need to change it.\n\nSee you then,\nRiverbend Dental", False, False),
    (20, "Margaret Hartley", "margaret@hartley.example.com", "Christmas lunch",
     "Hello love,\n\nI've had a think and I'm happy to do the ham and the pudding if you two can do the salads. Uncle Rob is bringing the prawns. Shall we say 12:30 at ours?\n\nGive the kids a hug from me.\n\nMum x", True, True),
    (27, "Southern Ridge Energy", "billing@southernridge.example.com", "Your electricity bill is ready",
     "Hi Claire,\n\nYour bill for 21 August to 20 November is ready.\n\nAmount due: $412.60\nDue date: 9 December\n\nYou used 8% less than the same time last year.\n\nSouthern Ridge Energy", True, False),
    (31, "Wattle Creek Netball Club", "secretary@wcnetball.example.com", "Summer comp draw and umpire roster",
     "Hi everyone,\n\nThe draw for the summer competition is out. The Under 17s play Tuesdays at 6 pm on court 3. Each family is down for one umpiring duty; the roster is attached.\n\nThanks,\nPriya", True, False),
    (49, "Bass Strait Ferries", "bookings@bassstraitferries.example.com", "Booking confirmed: 9 January, 4 passengers and 1 vehicle",
     "Thanks for booking with us.\n\nSailing: Saturday 9 January, evening crossing\nPassengers: 2 adults, 2 children\nVehicle: 1 car under 5 m\nCabin: 4-berth inside\n\nCheck-in opens 2.5 hours before departure. Your booking reference is in the attached ticket.", True, True),
    (55, "Wattle Creek Library", "noreply@wattlecreeklibrary.example.com", "3 items are due back on Saturday",
     "Hello,\n\nThese items are due back on Saturday:\n\n- The Thursday Murder Club\n- Minecraft: The Island\n- Salt, Fat, Acid, Heat\n\nYou can renew them online if nobody is waiting.", True, False),
    (74, "Dana Whitlock", "dana.whitlock@example.com", "Book club is at mine this month",
     "Hi all,\n\nI'm hosting on the 3rd. 7:30, bring a plate if you like. We're talking about the first half only, so no spoilers from those who raced ahead (Claire).\n\nDana", True, False),
    (98, "Paws and Claws Vet", "hello@pawsandclawsvet.example.com", "Biscuit is due for a vaccination",
     "Hi Claire,\n\nOur records show Biscuit is due for a yearly vaccination and check-up in December. You can book online or call the clinic.\n\nThe team at Paws and Claws", True, False),
    (122, "Hartley, Tom", "tom@hartley.example.com", "Fwd: Car service booked",
     "Booked for the 2nd, drop off by 8. They said about $380 unless the brake pads need doing.\n\nT", True, False),
    (170, "Wattle Creek Primary P&C", "pandc@wattlecreekprimary.example.com", "Thank you: fete raised $6,240",
     "Thank you to everyone who baked, sold, set up and packed down on Saturday. The fete raised $6,240, which goes to shade sails for the Year 5 and 6 playground.", True, False),
]

COURSE = {
    "title": "How home solar power works",
    "goal": "We're getting quotes for panels and I want to understand what I'm being sold",
    "summary": "From sunlight on a panel to the number on your bill: how a home system makes power, what the parts do, and how to size one.",
    "units": [
        ("From sunlight to electricity", "What a panel actually does.", [
            ("What a solar cell does", "Light knocks electrons loose in silicon, and the cell steers them into a current.", "mastered"),
            ("Watts, kilowatts and kilowatt-hours", "Power is how fast, energy is how much. Bills charge for energy.", "mastered"),
            ("Why panels make DC", "A panel pushes current one way. Your house runs on current that swaps direction.", "mastered"),
            ("Sun hours and tilt", "Output depends on how much sun lands square on the panel over a day.", "mastered"),
        ]),
        ("The parts of a system", "What sits on the roof and on the wall.", [
            ("What the inverter does", "It turns the panels' DC into the AC your house uses.", "mastered"),
            ("String inverters and microinverters", "One box for all panels, or a small one under each.", "learning"),
            ("Shade and why one panel matters", "On a string, the weakest panel can hold back the rest.", "new"),
            ("The meter and the grid", "Spare power flows out through the meter; shortfalls flow in.", "new"),
        ]),
        ("Making it pay", "Reading a quote and a bill.", [
            ("Using your own power first", "Power you use yourself is worth more than power you sell.", "new"),
            ("Feed-in tariffs", "What the retailer pays for what you send out.", "new"),
            ("Sizing a system", "Matching panels and inverter to your roof and your use.", "new"),
            ("When a battery makes sense", "Storing the day's spare power for the evening.", "new"),
            ("Payback time", "How long the savings take to cover the cost.", "new"),
        ]),
    ],
}


async def _person(db, key: str) -> User:
    username, email, role, colour = PEOPLE[key]
    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        user = User(email=email, username=username, password_hash=hash_password(secrets.token_urlsafe(24) + "aA1!"), role=role, settings={})
        db.add(user)
        await db.flush()
        await seed_system_folders(db, user)
        await install_defaults(db, user)
    user.role = role
    user.avatar_color = colour
    user.must_change_password = False
    user.can_use_automations = True
    return user


async def _chats(db, user: User, provider: ModelProvider) -> None:
    if await db.scalar(select(Conversation.id).where(Conversation.user_id == user.id).limit(1)):
        return
    folders: dict[str, ChatFolder] = {}
    for name in ("Home", "Garden"):
        folders[name] = ChatFolder(user_id=user.id, name=name)
        db.add(folders[name])
    await db.flush()

    async def chat(title, turns, *, folder=None, pinned=False, age=timedelta(0)):
        when = NOW - age
        conv = Conversation(
            user_id=user.id, title=title, model_id=MODELS[0]["id"], provider_id=provider.id, pinned=pinned,
            folder_id=folders[folder].id if folder else None, title_manually_set=True, created_at=when, updated_at=when,
        )
        db.add(conv)
        await db.flush()
        parent = None
        for i, (role, content) in enumerate(turns):
            msg = Message(
                conversation_id=conv.id, parent_id=parent, role=role, content=content,
                created_at=when + timedelta(seconds=20 * i),
                author_user_id=user.id if role == "user" else None,
                model_id=MODELS[0]["id"] if role == "assistant" else None,
            )
            db.add(msg)
            await db.flush()
            parent = msg.id
        conv.active_leaf_message_id = parent

    await chat(
        "Weeknight dinners for this week",
        [("user", DINNER_Q), ("assistant", DINNER_A), ("user", DINNER_Q2), ("assistant", DINNER_A2)],
        age=timedelta(minutes=25),
    )
    for title, folder, pinned, days in OTHER_CHATS:
        await chat(
            title,
            [("user", title), ("assistant", "Happy to help. Here's where I'd start.")],
            folder=folder, pinned=pinned, age=timedelta(days=days, hours=3),
        )


async def _mail(db, user: User) -> None:
    if await db.scalar(select(MailAccount.id).where(MailAccount.user_id == user.id).limit(1)):
        return
    acct = MailAccount(
        user_id=user.id, email=user.email, display_name="Claire Hartley", imap_host="mail.hartley.example.com", imap_port=993,
        imap_security="ssl", smtp_host="mail.hartley.example.com", smtp_port=465, smtp_security="ssl", username=user.email,
        secret_encrypted=encrypt_secret("not-a-real-password"), status="ok", status_detail="", last_sync_at=NOW,
    )
    db.add(acct)
    await db.flush()
    boxes = {}
    for path, name, role in (("INBOX", "Inbox", "inbox"), ("Sent", "Sent", "sent"), ("Drafts", "Drafts", "drafts"),
                             ("Archive", "Archive", "archive"), ("Junk", "Junk", "spam"), ("Trash", "Trash", "trash")):
        boxes[role] = MailFolder(account_id=acct.id, path=path, name=name, role=role)
        db.add(boxes[role])
    await db.flush()
    me = [{"name": "Claire Hartley", "addr": user.email}]
    for n, (hours, who, addr, subject, body, seen, flagged) in enumerate(MAIL, start=1):
        db.add(MailMessage(
            account_id=acct.id, folder_id=boxes["inbox"].id, uid=n, thread_key=uuid.uuid4().hex,
            message_id=f"<{uuid.uuid4().hex}@mail.example.com>", subject=subject, from_name=who, from_addr=addr,
            to_addrs=me, cc_addrs=[], sent_at=NOW - timedelta(hours=hours), snippet=" ".join(body.split())[:230],
            body_text=body, body_html="", attachments=[], seen=seen, flagged=flagged, triaged=True,
        ))


async def _study(db, user: User) -> None:
    if await db.scalar(select(StudySubject.id).where(StudySubject.user_id == user.id).limit(1)):
        return
    subject = StudySubject(
        user_id=user.id, title=COURSE["title"], goal=COURSE["goal"], depth="overview", level="adult", status="active",
        summary=COURSE["summary"], use_web=True, build_stage="done", build_progress=100,
        created_at=NOW - timedelta(days=6), last_studied_at=NOW - timedelta(hours=14),
    )
    db.add(subject)
    await db.flush()
    position, previous = 0.0, None
    for u, (title, summary, concepts) in enumerate(COURSE["units"]):
        unit = StudyUnit(subject_id=subject.id, position=u, title=title, summary=summary)
        db.add(unit)
        await db.flush()
        for ctitle, csummary, state in concepts:
            position += 1.0
            done = state == "mastered"
            concept = StudyConcept(
                subject_id=subject.id, unit_id=unit.id, position=position, title=ctitle, summary=csummary,
                objectives=[f"Explain: {ctitle.lower()}"], nature="principle", prereqs=[str(previous)] if previous else [],
                state=state, mastery=0.92 if done else (0.45 if state == "learning" else 0.0),
                evidence_count=4 if done else (2 if state == "learning" else 0), steps_done=6 if done else (3 if state == "learning" else 0),
                last_seen_at=NOW - timedelta(days=1) if state != "new" else None,
                mastered_at=NOW - timedelta(days=2) if done else None, due_at=NOW + timedelta(days=5) if done else None,
            )
            db.add(concept)
            await db.flush()
            previous = concept.id
    for n, (title, url) in enumerate((
        ("How solar panels work", "https://energy.example.org/solar/how-panels-work"),
        ("Choosing an inverter", "https://energy.example.org/solar/inverters"),
        ("Understanding feed-in tariffs", "https://energy.example.org/solar/feed-in-tariffs"),
    ), start=1):
        db.add(StudySource(subject_id=subject.id, n=n, kind="web", title=title, url=url, excerpt=""))
    today = date.today()
    for back, steps in enumerate((0, 14, 9, 12, 0, 11, 8)):
        if steps:
            db.add(StudyDay(user_id=user.id, day=today - timedelta(days=back), steps=steps))


async def main() -> None:
    out: dict = {"users": {}}
    async with SessionLocal() as db:
        provider = (await db.execute(select(ModelProvider).where(ModelProvider.name == "Anthropic", ModelProvider.user_id.is_(None)))).scalar_one_or_none()
        if provider is None:
            provider = ModelProvider(name="Anthropic", type="openai_compatible", user_id=None)
            db.add(provider)
        # Nothing answers here: the chats are written straight in, below.
        provider.base_url = "http://127.0.0.1:9/v1"
        provider.api_key = encrypt_api_key("sk-demo-not-a-key")
        provider.models = MODELS
        provider.enabled_models = None
        provider.enabled = True
        await db.flush()

        people = {key: await _person(db, key) for key in PEOPLE}
        for user in people.values():
            user.settings = {
                **(user.settings or {}),
                "timezone": TZ,
                "memory_mode": "off",
                "default_web_search_mode": "off",
                "default_provider_id": str(provider.id),
                "default_model_id": MODELS[0]["id"],
                "features_chosen": True,
            }
        await db.flush()
        claire = people["claire"]
        await _chats(db, claire, provider)
        await _mail(db, claire)
        await _study(db, claire)
        await db.commit()
        for key, user in people.items():
            out["users"][key] = {
                "id": str(user.id),
                "username": user.username,
                "email": user.email,
                "access_token": create_access_token(user.id, token_version=user.token_version or 0),
                "refresh_token": create_refresh_token(user.id, token_version=user.token_version or 0),
            }
    print(json.dumps(out))


asyncio.run(main())
