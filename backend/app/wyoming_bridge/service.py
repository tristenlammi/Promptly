"""Answer a spoken utterance for a Wyoming client, without any audio.

This is the same brain the in-app voice mode uses, reached over a
different wire. The command library is tried first and the model is the
fallback, so a satellite in a hallway gets the identical behaviour —
and the identical guarantees — as the phone in your hand.

Audio never reaches this module. Home Assistant's pipeline has already
done wake word, VAD and speech-to-text by the time it asks us what the
words mean, which is precisely the division of labour worth having: they
are good at microphones, we are the only ones who can see your
documents.
"""
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.commands.service import (
    CommandError,
    execute,
    needs_confirmation,
    resolve,
)

logger = logging.getLogger("promptly.wyoming")


class SpokenResult:
    """What to say back, and whether we handled it at all.

    ``handled=False`` maps to Wyoming's ``NotHandled``, which lets Home
    Assistant fall back to its own agent rather than the satellite going
    silent. Silence is the one outcome a voice device must never
    produce — from across a room it's indistinguishable from a broken
    microphone.
    """

    __slots__ = ("text", "handled")

    def __init__(self, text: str, *, handled: bool = True) -> None:
        self.text = text
        self.handled = handled

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<SpokenResult handled={self.handled} text={self.text!r}>"


async def answer(db: AsyncSession, user, utterance: str) -> SpokenResult:
    """Turn a transcript into something to say.

    Only the command fast path runs here. Falling through to the chat
    model would mean this endpoint could quietly bill tokens and read
    documents for anyone who can reach a TCP port on the LAN — and
    Wyoming carries no authentication of its own. Handing unmatched
    speech back to Home Assistant keeps that decision where the
    credentials are.
    """
    said = (utterance or "").strip()
    if not said:
        return SpokenResult("", handled=False)

    command, slots = await resolve(db, user.id, said)
    if command is None:
        # Not ours. HA's own agent takes it from here.
        return SpokenResult("", handled=False)

    if needs_confirmation(command):
        # A spoken yes/no needs a conversation, and Wyoming's handle
        # service is a single request/response with no turn state. Rather
        # than half-implement a confirmation nobody can answer, say why
        # it didn't run — the in-app voice mode can hold that dialogue.
        logger.info(
            "wyoming: %s needs confirmation, refusing over this transport",
            command.name,
        )
        return SpokenResult(
            f"{command.name} is set to ask first, so I've left it. "
            "Run it from the app."
        )

    try:
        result = await execute(db, command, user, slots=slots)
    except CommandError as exc:
        # Spoken back, not swallowed. The reason is the useful part.
        return SpokenResult(str(exc))

    await db.commit()

    if command.response_template:
        spoken = command.response_template
        for key, value in (slots or {}).items():
            spoken = spoken.replace("{" + key + "}", str(value))
        return SpokenResult(spoken)

    if result.get("kind") == "automation":
        return SpokenResult(f"Started {command.name}.")
    output = (result.get("output") or "").strip()
    # Tool output is written for a screen. Say something short rather
    # than reading a JSON blob aloud.
    return SpokenResult(output[:200] if output else f"{command.name} done.")
