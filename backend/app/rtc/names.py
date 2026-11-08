"""LiveKit room names: one prefix per kind of room, so every room on the
LiveKit server says which feature owns it, and a webhook or a usage count
can be routed without a database lookup.

Add a prefix here before using it (Talking to Promptly takes ``ai_``).
LiveKit room names are free-form; ours are ``<prefix><uuid hex>``.
"""
from __future__ import annotations

import uuid

PREFIXES: dict[str, str] = {
    "v_": "voice channel",  # Calls phase 1: one LiveKit room per voice channel
    "c_": "call",  # Calls phase 2+: DM calls and meetings
    "t_": "test call",  # Calls: Test calls ("Hear yourself"), one per person
}

# Rooms whose time counts as "in voice" for usage. Test calls don't.
USAGE_PREFIXES = ("v_", "c_")


def room_name(prefix: str, ident: uuid.UUID | str) -> str:
    if prefix not in PREFIXES:
        raise ValueError(f"unregistered LiveKit room prefix {prefix!r}")
    raw = ident.hex if isinstance(ident, uuid.UUID) else str(ident)
    return f"{prefix}{raw}"


def prefix_of(name: str) -> str | None:
    for p in PREFIXES:
        if name.startswith(p):
            return p
    return None


def parse(name: str) -> tuple[str, str] | None:
    """``("v_", "<hex>")`` for one of our rooms, else None."""
    p = prefix_of(name)
    if p is None:
        return None
    return p, name[len(p):]


def user_identity(user_id: uuid.UUID, suffix: str | None = None) -> str:
    """``u:<uuid>`` per person (LiveKit drops an older connection with the
    same identity, which is how a second device moves you), plus an
    optional role suffix for a second connection, e.g. ``u:<id>:echo``."""
    base = f"u:{user_id}"
    return f"{base}:{suffix}" if suffix else base


def identity_user(identity: str) -> uuid.UUID | None:
    if not identity.startswith("u:"):
        return None
    try:
        return uuid.UUID(identity[2:].split(":", 1)[0])
    except ValueError:
        return None
