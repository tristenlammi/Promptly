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


# The Android app showing notifications itself (no browser): what its row's
# ``user_agent`` starts with. It says "Android", so it starts switched on.
NATIVE_PREFIX = "PromptlyAndroid/"


def native_user_agent(version: str, device: str) -> str:
    safe = re.sub(r"[^\w .\-]", "", device)[:80]
    v = re.sub(r"[^\w.\-]", "", version)[:20] or "0"
    return f"{NATIVE_PREFIX}{v} (Android; {safe})"


def is_native(user_agent: str | None) -> bool:
    return bool(user_agent) and user_agent.startswith(NATIVE_PREFIX)


def is_push_service(endpoint: str) -> bool:
    """The app registers with Google's push service, the one Chrome uses."""
    return endpoint.startswith("https://fcm.googleapis.com/")
