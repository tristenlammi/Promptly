"""A device's own notification switch (0442).

Every device that allowed notifications has a row in ``push_subscriptions``
and a switch, ``enabled``. Off means nothing at all is pushed to it: messages,
calls, reminders, alarms, Porch, the lot. Phones and tablets start on;
anything else (a computer's browser) starts off until its switch is turned
on in Account → Notifications."""
from __future__ import annotations

import hashlib
import re

# What a phone or tablet's browser calls itself. An iPad's Home Screen app
# says "Mobile/" even when it otherwise claims to be a Mac.
_MOBILE = re.compile(r"Android|iPhone|iPad|iPod|Mobile|Windows Phone", re.I)


def is_mobile(user_agent: str | None) -> bool:
    return bool(user_agent) and _MOBILE.search(user_agent) is not None


def starts_on(user_agent: str | None) -> bool:
    """A new device's switch: on for a phone or tablet, off otherwise."""
    return is_mobile(user_agent)


def endpoint_hash(endpoint: str) -> str:
    """Lets a page find its own row in the device list without the server
    handing push endpoints back (they're the address to push to)."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
