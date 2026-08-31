"""Command library limits and vocabulary."""
from __future__ import annotations

from typing import Final

# What a command *does*. The tabs in the UI are filtered views of this
# one field — Prompts is ``prompt``, Commands is everything else — so
# adding a type here adds it to the library rather than to a new feature.
ACTION_TYPES: Final[tuple[str, ...]] = ("prompt", "automation", "mcp_tool")

# Action types that reach outside Promptly and can change something in
# the world. These require an ownership/enablement check on the target
# (see the capability rule) and confirmation before they run.
SIDE_EFFECTING: Final[frozenset[str]] = frozenset({"automation", "mcp_tool"})

MAX_COMMANDS_PER_USER: Final[int] = 300
MAX_PHRASES_PER_COMMAND: Final[int] = 12

MAX_NAME_CHARS: Final[int] = 120
MAX_PHRASE_CHARS: Final[int] = 120
# Matches the old saved-prompt body cap so nothing is truncated on backfill.
MAX_BODY_CHARS: Final[int] = 20_000

# Slot syntax inside a phrase: "turn off the {room} lights". One capture
# per slot, fed to the action as an argument. Deliberately minimal — no
# types, no defaults, no regex — because a phrase a user can't read back
# at a glance is a phrase they can't debug when it stops matching.
MAX_SLOTS_PER_PHRASE: Final[int] = 3
SLOT_NAME_MAX: Final[int] = 32

# Filler stripped before matching, so "Promptly, please turn the lights
# off" and "turn the lights off" are the same utterance. Ordered longest
# first so multi-word prefixes win.
LEADING_FILLER: Final[tuple[str, ...]] = (
    "hey promptly",
    "ok promptly",
    "okay promptly",
    "promptly",
    "please can you",
    "could you please",
    "can you please",
    "could you",
    "can you",
    "please",
)
TRAILING_FILLER: Final[tuple[str, ...]] = ("please", "thanks", "thank you")
