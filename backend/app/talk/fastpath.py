"""The commands fast path, server-side (WP-T3).

Before a spoken turn goes to the model, your command library gets the first
look (``commands/matcher.py``): "kitchen lights off" runs the command you made
for it, says its reply, and no model is asked (no wait, no tokens, nothing
leaves the network). The web voice overlay used to do this in the browser;
Talk does it in the session, so the phone gets it too.

The rules are the overlay's and the library's, unchanged:

* a command set to "Ask before running" is asked about first ("Kitchen lights
  off? Say yes to run it.");
* a near miss is asked about, never guessed ("Did you mean kitchen lights
  off?"), and a plain "no" to that answers what you really said;
* a saved prompt (``prompt`` commands) isn't run: its words become what's
  asked of the model, as typing it from the ``/`` menu would;
* the target is checked again when it runs, every time (``assert_runnable``).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.auth.models import User

logger = logging.getLogger("promptly.talk")

FAILED = "{name} didn't run, something went wrong on the server."


@dataclass
class Hit:
    command_id: uuid.UUID
    name: str
    action_type: str
    slots: dict[str, str] = field(default_factory=dict)
    ask_first: bool = False
    suggestion: bool = False  # a near miss: asked about, never run unasked

    def question(self) -> str:
        # No "say yes" in it: the echo filter would take their "yes" for
        # the question coming back through the microphone.
        if self.suggestion:
            return f"Did you mean {self.name}? Should I run it?"
        return f"Run {self.name}?"


@dataclass
class Ran:
    ok: bool
    say: str
    prompt: str | None = None  # a saved prompt: ask the model this instead
    tool_call: dict[str, Any] | None = None


async def match(user: User, utterance: str) -> Hit | None:
    """The command this means, a near miss worth asking about, or None."""
    from app.commands import service
    from app.database import SessionLocal

    async with SessionLocal() as db:
        # Most turns aren't commands, and many people have none: one query
        # to find out, before the matcher's own lookups.
        if not any(c.phrases for c in await service.load_commands(db, user.id)):
            return None
        command, slots = await service.resolve(db, user.id, utterance)
        if command is not None:
            return Hit(
                command.id,
                command.name,
                command.action_type,
                slots=dict(slots or {}),
                ask_first=service.needs_confirmation(command),
            )
        miss = await service.explain_miss(db, user.id, utterance)
        if miss is not None:
            service.log_command_run(
                db, user_id=user.id, command=None, name=miss[0], source="voice", ok=False, detail=miss[1], utterance=utterance
            )
            await db.commit()
        close = await service.nearest(db, user.id, utterance)
        if close:
            c = close[0]
            return Hit(c.id, c.name, c.action_type, suggestion=True, ask_first=True)
    return None


def _summary(action_type: str, name: str, result: dict[str, Any]) -> str:
    if result.get("kind") == "automation" or action_type == "automation":
        return f"Started {name}."
    output = " ".join(str(result.get("output") or "").split())
    return output[:200] if output else f"Ran {name}."


async def run(user: User, hit: Hit, utterance: str) -> Ran:
    """Run it (it's been asked about, if it needed to be) and say what
    happened. Failures are said too: across the room there's no toast."""
    from app.commands import service
    from app.commands.models import Command
    from app.database import SessionLocal

    async with SessionLocal() as db:
        command = await db.get(Command, hit.command_id)
        me = await db.get(User, user.id)
        if command is None or me is None or (command.user_id != me.id and not command.shared):
            return Ran(False, f"{hit.name} isn't there any more.")
        name = command.name
        try:
            result = await service.execute(db, command, me, slots=hit.slots)
        except service.CommandError as exc:
            detail = str(exc)
            service.log_command_run(
                db, user_id=me.id, command=command, name=name, source="voice", ok=False, detail=detail,
                utterance=utterance, slots=hit.slots,
            )
            await db.commit()
            return Ran(False, detail, tool_call=_call(command, ok=False, error=detail))
        except Exception:  # noqa: BLE001 - never a silent failure
            logger.exception("talk: command %s failed", hit.command_id)
            await db.rollback()
            detail = FAILED.format(name=name)
            return Ran(False, detail, tool_call=_call(command, ok=False, error=detail))
        if result.get("kind") == "prompt":
            return Ran(True, "", prompt=str(result.get("text") or ""))
        spoken = command.response_template
        if spoken:
            for key, value in (hit.slots or {}).items():
                spoken = spoken.replace("{" + key + "}", str(value))
        say = spoken or _summary(command.action_type, name, result)
        service.log_command_run(
            db, user_id=me.id, command=command, name=name, source="voice", ok=True, detail=say,
            utterance=utterance, slots=hit.slots,
        )
        await db.commit()
        return Ran(True, say, tool_call=_call(command, ok=True))


def _call(command: Any, *, ok: bool, error: str | None = None) -> dict[str, Any]:
    """The run as a chat tool-card entry, as ``commands/router.py`` records one."""
    return {
        "id": str(command.id),
        "name": command.name,
        "ok": ok,
        "error": error,
        "meta": {"action_type": command.action_type, "source": "command", "spoken": True},
    }
