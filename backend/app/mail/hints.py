"""What an email looks like, from its words alone: a bill to pay or something
to put in the calendar. No model and nothing stored: it only decides which
one-tap offer the conversation shows ("Remind me to pay it", "Add to
calendar"). The email is read as text, never followed as instructions, and
nothing is added until the person taps and checks the details."""
from __future__ import annotations

import re

# A bill: something asks for money by a date.
_BILL = re.compile(
    r"\b(invoice|tax invoice|amount (due|owing|payable)|payment (is )?due|due date|pay by|total due|balance due|"
    r"your (\w+ ){0,2}bill|bill is (ready|due)|overdue|direct debit|rates notice|renewal notice|statement is ready)\b",
    re.IGNORECASE,
)
# Something on a day: a stay, a flight, an appointment, tickets.
_EVENT = re.compile(
    r"\b(booking (confirmation|confirmed|reference)|your booking|reservation|check[- ]?in|check[- ]?out|itinerary|"
    r"boarding pass|flight|e-?ticket|your tickets?|appointment|is confirmed for|see you on|welcome guide|"
    r"you'?re (booked|going)|rsvp|save the date)\b",
    re.IGNORECASE,
)
# Receipts and marketing mention the same words without asking for anything.
_NOT_A_BILL = re.compile(r"\b(payment received|thanks? for your payment|receipt for your payment|has been paid|paid in full)\b", re.IGNORECASE)

LOOK_AT = 6000


def suggest(subject: str, text: str, *, has_invite: bool = False) -> str | None:
    """``"bill"``, ``"event"`` or None. A real calendar invite has its own
    card, so it gets no offer here."""
    if has_invite:
        return None
    words = f"{subject or ''}\n{(text or '')[:LOOK_AT]}"
    bill = len(_BILL.findall(words))
    event = len(_EVENT.findall(words))
    if bill and _NOT_A_BILL.search(words):
        bill = 0
    if not bill and not event:
        return None
    # The subject decides a tie: "Invoice 2316" with a visit date inside is a bill.
    if bill and event:
        if _BILL.search(subject or ""):
            return "bill"
        if _EVENT.search(subject or ""):
            return "event"
    return "bill" if bill >= event else "event"
