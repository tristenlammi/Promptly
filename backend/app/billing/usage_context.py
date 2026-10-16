"""Who pays for the model calls made while handling this request (R-276).

Usage used to be recorded only for a finished main-chat reply. Titles,
memory capture, compaction, prompt enhance, image captions, workspace Ask,
meeting notes, automations — every other model call — never reached the
user's usage or budget. The signed-in user is set here when a request is
authenticated (and an automation run sets its owner); ``stream_chat``, the
wrapper those side calls go through, records against them.

A ContextVar: tasks started during the request (the background reply
stream) inherit it.
"""
from __future__ import annotations

import uuid
from contextvars import ContextVar

_bill_to: ContextVar[uuid.UUID | None] = ContextVar("promptly_bill_to", default=None)


def bill_usage_to(user_id: uuid.UUID | None) -> None:
    _bill_to.set(user_id)


def billed_user() -> uuid.UUID | None:
    return _bill_to.get()
