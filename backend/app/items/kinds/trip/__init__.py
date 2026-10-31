"""Trip Planner (kind ``trip``): one file holds all of a person's trips —
each with bookings at correct local times across time zones, a day-by-day
itinerary with ideas, packing lists, shared expenses with settle-up, budget
and a documents checklist; reminders for check-in, departures, check-out and
documents across every trip. Ended trips can be archived to another file."""
from __future__ import annotations

import re

from app.items.spec import ItemContext, ItemSpec

from .actions import ACTIONS
from .brief import AI_BRIEF, AI_SUGGESTIONS
from .models import TripData
from .reminders import trip_reminders
from .text import to_text
from .trips import archive


def template(ctx: ItemContext) -> dict:
    """A new file: no trips yet (the app opens on "New trip"), the person's
    usual currency as the default for new trips."""
    settings = getattr(ctx.user, "settings", None) or {}
    cur = str(settings.get("currency") or "").strip().upper()
    home = cur if re.fullmatch(r"[A-Z]{3}", cur) else "AUD"
    return TripData.model_validate({"trips": [], "settings": {"home_currency": home}}).model_dump(mode="json")


def _migrate(data: dict, _from: int) -> dict:
    # v1 files held one trip at the top level; the model's before-validator
    # wraps them into ``trips[0]`` (so validating is the whole migration).
    return data


SPEC = ItemSpec(
    kind="trip",
    name="Trip Planner",
    tagline="All your trips in one place — every booking, day and dollar.",
    description=(
        "All your trips in one place: what's happening now, what's coming up (with a countdown) and every trip "
        "you've taken. For each trip keep flights, stays, trains, car hire and tickets with their real local times "
        "and durations across time zones, build a day-by-day itinerary from your ideas, pack with smart lists for "
        "everyone, split costs and settle up, track the budget, and never miss a passport, visa or check-in. The "
        "assistant reads your booking PDFs, plans realistic days, checks facts on the web, spots conflicts before "
        "they bite and can start your next trip from a past one. Share the file with your travel companions: "
        "everyone gets the check-in and departure reminders and picks which traveller they are. Finished trips can "
        "be archived to their own file. Works offline once opened on a device (attached Drive files need a "
        "connection). Not yet: live flight status, a map view, or importing bookings by forwarding emails — add "
        "them yourself or let the assistant read the confirmations in your files."
    ),
    category="Travel",
    icon="plane",
    color="#2C9CC8",
    suffix=".trip",
    model=TripData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=AI_SUGGESTIONS,
    ai_web=True,
    version=2,
    migrate=_migrate,
    reminders=trip_reminders,
    remind_collaborators=True,
    archive=archive,
    replaces="Replaces TripIt, Wanderlog and Google Travel",
    highlights=[
        "All your trips in one place — now, upcoming with a countdown, and past — switch between them in a tap",
        "Flights, stays, trains, car hire, tours and insurance — local times with real time zones, durations across zones",
        "Day-by-day itinerary that opens on today during the trip, with a live “next up” card and countdown",
        "Ideas list grouped by area, then drag ideas into days; copy a past trip to plan the next one",
        "Packing lists per traveller with templates (beach, ski, business, baby…) or made by AI for the weather",
        "Expenses in any currency (each keeps the rate it was logged at), split equal/exact/shares, settle up in as few "
        "transfers as possible, budget vs actual",
        "Documents checklist with the 6-month passport check, visa/ETA to-dos and reminders; conflict check for "
        "overlaps, impossible connections and nights without a stay",
        "AI that reads your booking PDFs from Drive, plans realistic days and checks opening hours on the web",
    ],
)
