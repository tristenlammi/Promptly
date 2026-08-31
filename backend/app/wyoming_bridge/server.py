"""A Wyoming ``handle`` service, so Home Assistant satellites can ask us.

Home Assistant already solved the hard, physical half of voice: wake
words, microphones, echo cancellation, and a fleet of cheap ESP32 boxes
people already own and mount on walls. Rather than ship a satellite of
our own — a hardware product with a support queue attached — Promptly
speaks their protocol and plugs into that ecosystem as the *intent
handler*: the part that decides what the words mean.

Wyoming is a raw TCP protocol, not HTTP, so this runs as an asyncio
server alongside uvicorn rather than as a route. It is **off by
default** (see ``config.py``) for the reason in the next paragraph.

SECURITY — read before enabling. **Wyoming has no authentication.** The
protocol carries no credentials, so anything that can open a socket to
this port can ask Promptly to run the acting user's commands. Two things
follow, and neither is optional:

* Bind it to a trusted network. It is off unless an admin turns it on,
  and the port should never be published to the internet.
* It only ever runs *commands*, never a chat turn (see ``service.py``),
  so an open port can't be used to read documents or spend tokens on
  model calls.
"""
from __future__ import annotations

import asyncio
import logging

from wyoming.asr import Transcript
from wyoming.event import Event
from wyoming.handle import Handled, NotHandled
from wyoming.info import Attribution, Describe, HandleModel, HandleProgram, Info
from wyoming.server import AsyncEventHandler

from app.database import SessionLocal
from app.wyoming_bridge.service import answer

logger = logging.getLogger("promptly.wyoming")

_INFO = Info(
    handle=[
        HandleProgram(
            name="promptly",
            description=(
                "Runs your Promptly commands and answers from your own "
                "workspaces."
            ),
            attribution=Attribution(name="Promptly", url="https://localhost"),
            installed=True,
            version="1",
            models=[
                HandleModel(
                    name="promptly-commands",
                    description="Your saved command library",
                    attribution=Attribution(
                        name="Promptly", url="https://localhost"
                    ),
                    installed=True,
                    languages=["en"],
                    version="1",
                )
            ],
        )
    ]
)


class PromptlyHandler(AsyncEventHandler):
    """One connected Wyoming client (usually a Home Assistant pipeline)."""

    def __init__(self, *args, user_id, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._user_id = user_id

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            # Every client opens with this to learn what we are.
            await self.write_event(_INFO.event())
            return True

        if Transcript.is_type(event.type):
            said = Transcript.from_event(event).text or ""
            result = await self._answer(said)
            if not result.handled:
                # Explicitly NOT handled, so HA falls back to its own
                # agent rather than the satellite going quiet.
                await self.write_event(NotHandled().event())
            else:
                await self.write_event(Handled(text=result.text).event())
            return True

        # Anything else (audio, wake, tts) isn't ours — stay connected
        # rather than dropping the client mid-pipeline.
        return True

    async def _answer(self, said: str):
        # Its own session per utterance: this runs outside the request
        # lifecycle, so there's no request-scoped session to borrow, and
        # a long-lived one would hold a connection open per satellite.
        from app.auth.models import User

        async with SessionLocal() as db:
            user = await db.get(User, self._user_id)
            if user is None:
                logger.warning("wyoming: acting user %s is gone", self._user_id)
                from app.wyoming_bridge.service import SpokenResult

                return SpokenResult("", handled=False)
            try:
                return await answer(db, user, said)
            except Exception:  # noqa: BLE001 — never kill the listener
                logger.exception("wyoming: failed handling %r", said)
                from app.wyoming_bridge.service import SpokenResult

                return SpokenResult("Something went wrong.", handled=True)


async def serve(host: str, port: int, user_id) -> asyncio.AbstractServer:
    """Start listening. Returns the server so the caller can close it."""

    async def _client(reader, writer):
        handler = PromptlyHandler(reader, writer, user_id=user_id)
        try:
            await handler.run()
        except (ConnectionResetError, asyncio.IncompleteReadError):
            # Satellites come and go; a dropped socket is routine.
            pass
        except Exception:  # noqa: BLE001
            logger.exception("wyoming: client handler crashed")
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    server = await asyncio.start_server(_client, host, port)
    logger.info("Wyoming handle service listening on %s:%s", host, port)
    return server
