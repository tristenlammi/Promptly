"""The contract an item implements (the Item Store's "SDK", server side).

An item kind lives in its own package, ``app/items/kinds/<kind>/``, whose
``__init__.py`` exposes ``SPEC: ItemSpec``. The registry finds it on its own
— nothing shared has to be edited to add an item.

What a spec gives the framework:

* **Identity** — ``kind`` (``workout``), store copy, an icon name (lucide),
  a filename suffix (``.workout``).
* **Data** — ``model``: a Pydantic model for the whole file. Every save (the
  UI's, an action's, the AI's) is validated and normalised through it, so a
  bad write can never corrupt a file. ``template`` builds a new file;
  ``version`` + ``migrate`` upgrade old files when the shape changes.
* **Text** — ``to_text``: the file as plain text. It's the file's search
  text, what Drive AI indexes, and what chat reads, so write it for a
  reader: the facts that matter, newest first, bounded.
* **Actions** — named operations on the data with a Pydantic ``params``
  model. The item's AI panel and normal chats call them as tools; the UI can
  call them too (``POST /api/items/{id}/actions/{name}``). An action mutates
  ``data`` in place and returns an :class:`ActionOutcome`; read-only ones
  set ``writes=False``. Actions must be deterministic for (data, args, now):
  if someone saved in between, the AI's actions are replayed on the newer
  data.
* **AI** — ``ai_brief``: the expert system prompt (the domain science, how
  to use the actions, house rules). ``ai_suggestions``: starter prompts.
  ``ai_web``: may it search the web. ``reads``: other item kinds it may read
  (the meal planner reads recipes from ``meal_macro``…).
* **Reminders** — ``reminders(data, ctx)`` → the nudges due in the next
  :data:`REMINDER_HORIZON`. Recomputed on every save and hourly.
* **Background** — ``periodic(ctx)`` every ``periodic_minutes`` (a bank
  sync). ``router``: extra endpoints at ``/api/items/k/<kind>/…``.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any
from zoneinfo import ZoneInfo

from pydantic import AfterValidator, BaseModel


def _safe_url(v: str) -> str:
    """Links an item stores and the app renders as ``<a href>``: http(s),
    mailto, tel — never ``javascript:`` / ``data:`` (an AI may copy links
    from web pages and PDFs)."""
    s = (v or "").strip()
    if not s:
        return ""
    low = s.lower()
    if not low.startswith(("http://", "https://", "mailto:", "tel:")):
        if "://" in low or low.startswith(("javascript:", "data:", "vbscript:", "file:")) or ":" in low.split("/")[0]:
            raise ValueError("links must be http(s), mailto: or tel:")
        s = "https://" + s  # "example.com/booking" → a web link
    return s[:2000]


# Use for every link field: ``link: SafeUrl = ""``.
SafeUrl = Annotated[str, AfterValidator(_safe_url)]

if TYPE_CHECKING:
    from fastapi import APIRouter
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.auth.models import User

REMINDER_HORIZON = timedelta(days=8)

# The moment ``to_text`` runs for, in the file owner's time zone — set by the
# framework around each call (``to_text`` itself only takes the data).
_TEXT_NOW: ContextVar[datetime | None] = ContextVar("item_text_now", default=None)


def text_now() -> datetime:
    """"Now" for ``to_text``: aware, in the person's zone (UTC outside a save)."""
    from datetime import timezone

    return _TEXT_NOW.get() or datetime.now(timezone.utc)

CATEGORIES = ("Health & fitness", "Food", "Habits & journal", "Money", "People", "Travel", "Fun", "Learning")


class ActionError(Exception):
    """A controlled refusal ("there's no workout on that day"). The message
    goes back to the model (or the UI) as is."""


@dataclass
class ActionOutcome:
    """What an action did. ``summary`` is shown to the person ("Planned 4
    sessions for next week"); ``result`` (JSON-able) goes back to the model —
    an id it made, the numbers it read."""

    summary: str
    result: Any = None


@dataclass
class ItemContext:
    """Everything an action / template / reminder may need besides the data."""

    db: AsyncSession
    user: User
    file_id: uuid.UUID | None
    now: datetime  # aware, in ``tz``
    tz: ZoneInfo
    # Read another of this person's items by kind (only kinds in the spec's
    # ``reads``): ``(file_id, title, data)`` of the most recently changed one,
    # or None.
    read_item: Callable[[str], Awaitable[tuple[uuid.UUID, str, dict] | None]] | None = None

    @property
    def today(self):  # noqa: ANN201 — datetime.date
        return self.now.date()


@dataclass
class ItemAction:
    name: str  # snake_case; becomes the tool name (``<kind>__<name>``)
    description: str  # for the model: when to use it, what it changes
    params: type[BaseModel]
    run: Callable[[ItemContext, dict, Any], ActionOutcome | Awaitable[ActionOutcome]]
    writes: bool = True
    # Offered to normal chats (list/read/use_item). False keeps it to the
    # item's own panel and UI — e.g. reading a journal entry's full text.
    chat: bool = True


@dataclass
class Reminder:
    key: str  # stable per occurrence
    due_at: datetime  # aware
    title: str
    body: str = ""


@dataclass
class PeriodicContext(ItemContext):
    """For ``periodic``: ``update(fn)`` applies ``fn(data)`` (in place) and
    saves through the normal path (validation, revision, text, reminders).
    ``get_state`` / ``set_state`` reach the file's server-only state."""

    update: Callable[[Callable[[dict], Any], str], Awaitable[bool]] | None = None
    get_state: Callable[..., Awaitable[Any]] | None = None
    set_state: Callable[..., Awaitable[None]] | None = None


@dataclass
class ItemSpec:
    kind: str
    name: str
    tagline: str  # one line on the store card
    description: str  # the store page: what it does, a few sentences
    category: str  # one of CATEGORIES
    icon: str  # lucide icon name, e.g. "dumbbell"
    color: str  # accent, a hex like "#E2725B"
    suffix: str  # ".workout"
    model: type[BaseModel]
    template: Callable[[ItemContext], dict]
    to_text: Callable[[dict], str]
    actions: list[ItemAction] = field(default_factory=list)
    ai_brief: str = ""
    ai_suggestions: list[str] = field(default_factory=list)
    ai_web: bool = False
    reads: tuple[str, ...] = ()
    version: int = 1
    migrate: Callable[[dict, int], dict] | None = None
    reminders: Callable[[dict, ItemContext], list[Reminder]] | None = None
    periodic: Callable[[PeriodicContext], Awaitable[None]] | None = None
    periodic_minutes: int = 60
    router: APIRouter | None = None
    # What one file may hold, serialised. Big enough for years of logging.
    max_bytes: int = 8 * 1024 * 1024
    # Not in the Store (tests, internal kinds).
    hidden: bool = False
    # Shown under the name in the Store ("Replaces Strong, Hevy, Fitbod").
    replaces: str = ""
    # Feature bullets for the store page.
    highlights: list[str] = field(default_factory=list)
    # Normal chats may see the file's raw JSON (read_item) — False limits
    # them to ``to_text`` and the chat-visible actions (a journal).
    chat_raw: bool = True
    # Keys left out of what the AI is shown (the prompt's JSON, read_data,
    # read_item) wherever they appear — bulky fields like a contact's
    # photo (base64). The data itself is untouched.
    ai_hidden_keys: tuple[str, ...] = ()
    # Reminders also go to everyone the file is shared with for editing
    # (a shared trip, a household grocery list), not just the owner.
    remind_collaborators: bool = False
    # Archiving older data out of a file that's filling up:
    # ``archive(data, ctx, before_day)`` → ``(kept, archived)`` — two whole
    # files' data. The framework writes ``archived`` to a new file next to
    # this one and keeps ``kept``. Offered when the file passes 75% full.
    archive: Callable[[dict, ItemContext, str], tuple[dict, dict]] | None = None
    # After a version is restored (Undo / version history): reset server-only
    # state that tracked the replaced data (a bank sync cursor).
    after_restore: Callable[[AsyncSession, uuid.UUID], Awaitable[None]] | None = None

    def action(self, name: str) -> ItemAction | None:
        return next((a for a in self.actions if a.name == name), None)

    def validate(self, data: Any) -> dict:
        """``data`` checked and normalised through the model (raises
        ``pydantic.ValidationError``)."""
        return self.model.model_validate(data).model_dump(mode="json")
