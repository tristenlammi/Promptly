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


def native_user_agent(version: str, device: str, install: str = "") -> str:
    safe = re.sub(r"[^\w .\-]", "", device)[:80]
    v = re.sub(r"[^\w.\-]", "", version)[:20] or "0"
    which = f"; {install}" if _INSTALL.fullmatch(install or "") else ""
    return f"{NATIVE_PREFIX}{v} (Android; {safe}{which})"


# Which phone a registration came from: a short id the app derives from
# Android's per-app device id. A phone that registers again after the app was
# reinstalled (new address, nothing remembered) replaces its old row by it.
_INSTALL = re.compile(r"[0-9a-f]{12}")


def native_install(user_agent: str | None) -> str | None:
    if not is_native(user_agent):
        return None
    m = re.search(r"; ([0-9a-f]{12})\)$", user_agent or "")
    return m.group(1) if m else None


def is_native(user_agent: str | None) -> bool:
    return bool(user_agent) and user_agent.startswith(NATIVE_PREFIX)


def native_version(user_agent: str | None) -> tuple[int, ...]:
    """The app's version from its row ("PromptlyAndroid/1.10.0 (…)" → (1, 10, 0))."""
    if not is_native(user_agent):
        return ()
    m = re.match(r"(\d+(?:\.\d+)*)", (user_agent or "")[len(NATIVE_PREFIX):])
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


# Promptly for Android after this one takes a notification down when a
# silent "clear" push says its conversation was read elsewhere; this one and
# older would show it as an empty notification, so they're never sent one.
CLEARS_AFTER = (1, 10, 0)


def takes_clears(user_agent: str | None) -> bool:
    return native_version(user_agent) > CLEARS_AFTER


def is_push_service(endpoint: str) -> bool:
    """The app registers with Google's push service, the one Chrome uses."""
    return endpoint.startswith("https://fcm.googleapis.com/")


def covered(rows) -> set:  # noqa: ANN001 — PushSubscription rows
    """The ids of browser subscriptions on a phone whose Promptly app shows
    notifications itself: the app's subscription is still there, so the
    browser's stays quiet (otherwise the phone would get everything twice).
    The app's switch counts for the phone: off there, and neither is sent."""
    native = {endpoint_hash(r.endpoint) for r in rows if is_native(r.user_agent)}
    return {r.id for r in rows if r.covered_by and r.covered_by in native and not is_native(r.user_agent)}
