"""The command library: one thing you can say or type, and what it does.

Two things carry the risk.

The **matcher** sits in front of actions that turn off lights and will
eventually unlock doors. A fuzzy match that's right 95% of the time is a
1-in-20 chance of doing something nobody asked for, so most of what
follows pins down what it *refuses* to match rather than what it
matches.

The **capability rule** is the other half: a command must never grant
capability its owner didn't already have, and it must fail loudly when
its target disappears rather than looking like it worked.
"""
from __future__ import annotations

import uuid

import pytest

from app.commands.matcher import (
    MatchCandidate,
    compile_phrase,
    match,
    normalise,
    slot_names,
)
from app.commands.models import Command
from app.commands.service import (
    CommandError,
    assert_runnable,
    execute,
    needs_confirmation,
    resolve,
)


async def _cmd(db, user, **kw) -> Command:
    row = Command(
        user_id=user.id,
        name=kw.pop("name", "Test command"),
        phrases=kw.pop("phrases", []),
        action_type=kw.pop("action_type", "prompt"),
        **kw,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _cands(*pairs) -> list[MatchCandidate]:
    return [MatchCandidate(command_id=i, phrases=list(p)) for i, p in pairs]


# ------------------------------------------------------------ normalising


def test_case_punctuation_and_spacing_are_levelled():
    assert normalise("Turn  the LIGHTS off!!") == "turn the lights off"


def test_wake_word_and_politeness_are_stripped():
    """"Promptly, please turn the lights off" and "turn the lights off"
    are the same instruction. Making the user store both would be a
    library full of near-duplicates — which is also how you end up with
    the ambiguity the matcher then has to refuse."""
    for said in (
        "Promptly, turn the lights off",
        "Hey Promptly, could you turn the lights off please",
        "please turn the lights off, thanks",
        "OK Promptly can you turn the lights off",
    ):
        assert normalise(said) == "turn the lights off", said


def test_accents_are_folded():
    """Speech-to-text is inconsistent about accents; "café" and "cafe"
    must not be two different commands."""
    assert normalise("Café lights") == normalise("Cafe lights")


def test_filler_only_utterance_normalises_to_nothing():
    """"Promptly?" on its own is a false wake, not a command."""
    assert normalise("Promptly") == ""
    assert normalise("hey promptly, please") == ""


def test_slot_braces_survive_normalisation():
    """Braces are syntax, not punctuation — stripping them would turn a
    slotted phrase into a literal one that never matches."""
    assert normalise("Turn off the {room} lights") == "turn off the {room} lights"
    assert slot_names("turn off the {room} lights") == ["room"]


# ---------------------------------------------------------- numbers
#
# Measured on a real machine: Whisper transcribes spoken numbers as
# DIGITS — "twenty twenty five" comes back "2025", "channel four" comes
# back "channel 4". So a phrase written in words would match when typed
# and silently never fire when spoken, which reads as "voice is broken"
# rather than "that phrase is wrong". Both sides are canonicalised to
# digits so the two forms are one utterance.


def test_number_words_become_digits():
    assert normalise("turn on channel four") == "turn on channel 4"
    assert normalise("channel 4") == "channel 4"


def test_tens_and_units_join_up():
    assert normalise("set it to twenty five") == "set it to 25"
    assert normalise("set it to twenty-five") == "set it to 25"
    assert normalise("set it to thirty") == "set it to 30"


def test_a_phrase_in_words_matches_speech_in_digits():
    """The bug this exists for, in both directions."""
    written_words = _cands((1, ["turn on channel four"]))
    assert match("turn on channel 4", written_words) is not None

    written_digits = _cands((1, ["turn on channel 4"]))
    assert match("turn on channel four", written_digits) is not None


def test_words_that_merely_contain_a_number_are_untouched():
    """Substring replacement would wreck ordinary speech — "money" must
    not become "m1y", and "won" is not "one"."""
    assert normalise("show me the money") == "show me the money"
    assert normalise("who won the game") == "who won the game"
    assert normalise("tone down the lights") == "tone down the lights"


def test_large_spoken_numbers_are_left_alone():
    """Stops at 99 deliberately. "twenty twenty five" is a year, not
    20 + 25, and Whisper already emits digits for those — guessing would
    manufacture mismatches rather than fix them."""
    assert normalise("the 2025 report") == "the 2025 report"


# --------------------------------------------------------------- matching


def test_an_exact_phrase_matches():
    result = match("turn the lights off", _cands((1, ["turn the lights off"])))

    assert result is not None
    assert result.command_id == 1
    assert result.kind == "exact"


def test_any_of_a_commands_phrases_matches_it():
    cands = _cands((1, ["lights off", "turn the lights off", "kill the lights"]))

    for said in ("lights off", "Turn the lights off!", "kill the lights"):
        assert match(said, cands).command_id == 1, said


def test_a_near_miss_does_not_match():
    """The whole point. No edit distance, no "did you mean" — a phrase
    that isn't the phrase does nothing, and the caller falls through to
    the model."""
    cands = _cands((1, ["turn the lights off"]))

    for said in (
        "turn the light off",       # singular
        "turn off the lights",      # reordered
        "turn the lights of",       # typo
        "lights",                   # fragment
    ):
        assert match(said, cands) is None, said


def test_two_commands_claiming_one_phrase_match_nothing():
    """A coin flip between two commands is the worst possible answer
    when one of them might open a garage door. Refusing is honest and
    the UI can say the library is ambiguous."""
    cands = _cands((1, ["lights off"]), (2, ["lights off"]))

    assert match("lights off", cands) is None


def test_a_disabled_command_never_matches():
    cands = [MatchCandidate(command_id=1, phrases=["lights off"], enabled=False)]

    assert match("lights off", cands) is None


def test_empty_and_filler_only_utterances_match_nothing():
    cands = _cands((1, ["lights off"]))

    for said in ("", "   ", "promptly", "please"):
        assert match(said, cands) is None, repr(said)


# ------------------------------------------------------------------ slots


def test_a_slot_captures_the_span():
    result = match(
        "turn off the garage lights", _cands((1, ["turn off the {room} lights"]))
    )

    assert result is not None
    assert result.slots == {"room": "garage"}
    assert result.kind == "slot"


def test_a_slot_widens_exactly_one_span_and_nothing_else():
    """The text around a slot stays literal. Otherwise "{room} lights"
    quietly becomes a catch-all that swallows unrelated speech."""
    cands = _cands((1, ["turn off the {room} lights"]))

    assert match("turn off the garage lamps", cands) is None
    assert match("switch off the garage lights", cands) is None


def test_a_slot_requires_something_to_capture():
    """"turn off the lights" must not match "turn off the {room} lights"
    with an empty room — that would run an action with a missing
    argument and look like it worked."""
    assert match("turn off the lights", _cands((1, ["turn off the {room} lights"]))) is None


def test_an_exact_match_beats_a_slot_match():
    """A command written for exactly these words is more specific than
    one with a hole in it, so it wins rather than being called
    ambiguous."""
    cands = _cands(
        (1, ["turn off the kitchen lights"]),
        (2, ["turn off the {room} lights"]),
    )

    result = match("turn off the kitchen lights", cands)

    assert result is not None
    assert result.command_id == 1


def test_a_repeated_slot_name_is_unusable_rather_than_half_working():
    assert compile_phrase("move {x} to {x}") is None


# ------------------------------------------------------- resolve (DB path)


async def test_resolve_finds_the_command_and_its_slots(db, user):
    await _cmd(db, user, name="Room lights", phrases=["turn off the {room} lights"])

    command, slots = await resolve(db, user.id, "Promptly, turn off the garage lights")

    assert command is not None
    assert command.name == "Room lights"
    assert slots == {"room": "garage"}


async def test_a_prompt_with_no_phrases_is_menu_only(db, user):
    """Backfilled saved prompts land with no phrases on purpose. A
    template that was only ever picked from a menu must not become
    speakable by accident just because its title resembles something
    the user said."""
    await _cmd(db, user, name="Standup update", body="Write my standup", phrases=[])

    command, _ = await resolve(db, user.id, "standup update")

    assert command is None


async def test_resolution_is_scoped_to_the_caller(db, user, provider):
    """Another account's commands must be invisible, not merely
    unreturned — one person's phrase must never run another's action."""
    from app.auth.models import User

    other = User(
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        username=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(other)
    await db.commit()
    await db.refresh(other)
    await _cmd(db, other, name="Theirs", phrases=["secret phrase"])

    command, _ = await resolve(db, user.id, "secret phrase")

    assert command is None


# ------------------------------------------------------- capability rule


async def test_a_prompt_command_needs_no_confirmation(db, user):
    row = await _cmd(db, user, body="hello")

    assert needs_confirmation(row) is False
    await assert_runnable(db, row, user)  # does not raise


async def test_commands_do_not_confirm_by_default(db, user):
    """The risk isn't uniform, so the friction shouldn't be either. A
    dialog on every light toggle teaches people to dismiss dialogs —
    which is worse than no dialog at all on the one that mattered."""
    automation = await _cmd(
        db, user, action_type="automation", action_ref=str(uuid.uuid4())
    )
    tool = await _cmd(
        db, user, action_type="mcp_tool", action_ref=f"{uuid.uuid4()}:lights_off"
    )

    assert needs_confirmation(automation) is False
    assert needs_confirmation(tool) is False


async def test_the_flag_makes_a_command_confirm(db, user):
    """Ticked for the garage door, left off for the lights."""
    row = await _cmd(
        db,
        user,
        action_type="mcp_tool",
        action_ref=f"{uuid.uuid4()}:open_garage",
        confirm_before_run=True,
    )

    assert needs_confirmation(row) is True


async def test_a_command_pointing_at_a_missing_automation_fails_loudly(db, user):
    """The failure that matters: a stale command that looks like it ran.
    Saying nothing happened is the whole job here."""
    row = await _cmd(
        db, user, action_type="automation", action_ref=str(uuid.uuid4())
    )

    with pytest.raises(CommandError) as exc:
        await assert_runnable(db, row, user)

    assert "no longer exists" in str(exc.value)


async def test_you_cannot_command_someone_elses_automation(db, user, provider):
    """The capability rule. A command is a shortcut to something you
    could already do — never a way to reach something you couldn't."""
    from app.auth.models import User
    from app.tasks.models import Task

    other = User(
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        username=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(other)
    await db.commit()
    await db.refresh(other)

    their_task = Task(
        user_id=other.id, title="Theirs", prompt="x", frequency="daily"
    )
    db.add(their_task)
    await db.commit()
    await db.refresh(their_task)

    row = await _cmd(
        db, user, action_type="automation", action_ref=str(their_task.id)
    )

    with pytest.raises(CommandError):
        await assert_runnable(db, row, user)


async def test_a_disabled_command_refuses_to_run(db, user):
    row = await _cmd(db, user, body="hello", enabled=False)

    with pytest.raises(CommandError) as exc:
        await assert_runnable(db, row, user)

    assert "turned off" in str(exc.value)


async def test_a_command_on_a_disabled_connector_refuses(db, user):
    """Switching a connector off must switch off every command that uses
    it, without anyone having to find them."""
    from app.mcp.models import McpConnector

    connector = McpConnector(
        name="Home", slug=f"home{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://stub.invalid", enabled=False,
    )
    db.add(connector)
    await db.commit()
    await db.refresh(connector)

    row = await _cmd(
        db,
        user,
        action_type="mcp_tool",
        action_ref=f"{connector.id}:lights_off",
    )

    with pytest.raises(CommandError) as exc:
        await assert_runnable(db, row, user)

    assert "switched off" in str(exc.value)


# ------------------------------------------------------------- execution


async def test_running_a_prompt_returns_text_rather_than_sending_it(db, user):
    """A prompt is text for the composer. Executing it server-side would
    mean deciding to send a message on the user's behalf."""
    row = await _cmd(db, user, body="Write my standup")

    result = await execute(db, row, user)

    assert result == {"kind": "prompt", "text": "Write my standup"}


async def test_slots_fill_the_prompt_body(db, user):
    row = await _cmd(
        db, user, body="Draft an email to {name}", phrases=["email {name}"]
    )

    result = await execute(db, row, user, slots={"name": "Sam"})

    assert result["text"] == "Draft an email to Sam"


async def test_an_unfilled_placeholder_stays_visible(db, user):
    """Left verbatim rather than blanked, so it reads as an obvious gap
    to fill in instead of a sentence that quietly lost a word."""
    row = await _cmd(db, user, body="Draft an email to {name}")

    result = await execute(db, row, user)

    assert result["text"] == "Draft an email to {name}"


# ------------------------------------------------- recording in a chat


async def test_a_run_from_a_chat_is_recorded_as_a_tool_call(db, user, conversation):
    """The run lands in the transcript shaped like any other tool call,
    so the existing Tool Activity Card renders it without a bespoke
    message kind."""
    from app.commands.router import _record_in_conversation

    row = await _cmd(db, user, name="Garage lights off", action_type="mcp_tool")

    message = await _record_in_conversation(
        db, row, user, conversation.id, ok=True, detail="Garage lights off."
    )
    await db.commit()

    assert message is not None
    assert message.role == "assistant"
    assert message.content == "Garage lights off."
    assert message.tool_calls[0]["name"] == "Garage lights off"
    assert message.tool_calls[0]["ok"] is True
    assert message.tool_calls[0]["meta"]["source"] == "command"


async def test_a_failed_run_is_recorded_too(db, user, conversation):
    """A command that silently did nothing is the worst outcome — the
    user can't tell whether it fired. The failure gets a card of its own
    carrying the reason."""
    from app.commands.router import _record_in_conversation

    row = await _cmd(db, user, name="Broken thing", action_type="automation")

    message = await _record_in_conversation(
        db,
        row,
        user,
        conversation.id,
        ok=False,
        detail='"Broken thing" points at an automation that no longer exists.',
    )
    await db.commit()

    assert message.tool_calls[0]["ok"] is False
    assert "no longer exists" in message.tool_calls[0]["error"]


async def test_no_conversation_means_no_message(db, user):
    """Running from the library has no transcript to write to, and must
    not invent one."""
    from app.commands.router import _record_in_conversation

    row = await _cmd(db, user)

    assert await _record_in_conversation(
        db, row, user, None, ok=True, detail="ok"
    ) is None


async def test_it_refuses_to_write_into_someone_elses_chat(db, user, provider):
    """The command is the caller's, but the conversation might not be.
    Writing there would put a message in a thread they can't even see."""
    from app.auth.models import User
    from app.chat.models import Conversation
    from app.commands.router import _record_in_conversation

    other = User(
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        username=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(other)
    await db.commit()
    await db.refresh(other)
    their_chat = Conversation(user_id=other.id, title="Theirs")
    db.add(their_chat)
    await db.commit()
    await db.refresh(their_chat)

    row = await _cmd(db, user)

    assert await _record_in_conversation(
        db, row, user, their_chat.id, ok=True, detail="ok"
    ) is None


# ------------------------------------------------------- MCP transport


def test_both_transports_are_supported():
    """Streamable-HTTP is the standard; SSE is what Home Assistant (and
    plenty of other real servers) actually expose. Supporting only the
    former means those servers can't be connected at all."""
    from app.mcp.client import TRANSPORTS

    assert set(TRANSPORTS) == {"http", "sse"}


async def test_a_connector_defaults_to_streamable_http(db):
    """Existing connectors were all streamable-HTTP, so the column's
    default has to keep them working untouched."""
    from app.mcp.models import McpConnector

    row = McpConnector(
        name="Plain", slug=f"plain{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://stub.invalid/mcp", enabled=True,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    assert row.transport == "http"


async def test_a_connector_can_speak_sse(db):
    from app.mcp.models import McpConnector

    row = McpConnector(
        name="HA", slug=f"ha{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://homeassistant.local:8123/mcp_server/sse",
        transport="sse", enabled=True,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    assert row.transport == "sse"


def test_home_assistant_is_reachable_on_a_lan_address():
    """HA lives at 192.168.x.x or homeassistant.local. The SSRF guard
    deliberately allows private addresses (self-hosted model servers need
    it too) and blocks only cloud metadata endpoints — worth pinning,
    because tightening it later would silently break every home setup."""
    from app.net.safe_fetch import assert_provider_url_safe

    assert_provider_url_safe("http://homeassistant.local:8123/mcp_server/sse")
    assert_provider_url_safe("http://192.168.1.50:8123/mcp_server/sse")

    with pytest.raises(Exception):
        # Cloud instance metadata stays blocked.
        assert_provider_url_safe("http://169.254.169.254/latest/meta-data/")


async def test_confirmation_is_required_only_when_flagged(db, user):
    """The 409 gate follows the per-command flag, so an unflagged command
    runs on the first request and a flagged one can't be run without the
    caller saying so."""
    from app.commands.service import needs_confirmation

    plain = await _cmd(db, user, action_type="mcp_tool", action_ref="x:y")
    guarded = await _cmd(
        db,
        user,
        name="Open garage",
        action_type="mcp_tool",
        action_ref="x:open",
        confirm_before_run=True,
    )

    assert needs_confirmation(plain) is False
    assert needs_confirmation(guarded) is True


def test_only_a_clear_yes_confirms_a_spoken_command():
    """Mirrors the AFFIRMATIVE list in the voice overlay. Anything that
    isn't clearly affirmative cancels — the safe reading of a mumbled
    answer to "shall I open the garage door?" is no."""
    import re

    affirmative = re.compile(
        r"^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|affirmative)\b",
        re.IGNORECASE,
    )

    for said in ("yes", "Yeah", "go ahead", "do it please", "OK"):
        assert affirmative.match(said), said
    for said in ("no", "not now", "wait", "hang on", "maybe", "", "yellow"):
        assert not affirmative.match(said), said


# ------------------------------------------------- spoken replies


def test_the_voice_prompt_forbids_what_cannot_be_heard():
    """Markdown, lists and tables are silent — a model that emits them on
    a spoken turn produces an answer with holes in it."""
    from app.chat.base_prompt import VOICE_SYSTEM_PROMPT

    p = VOICE_SYSTEM_PROMPT.lower()

    assert "markdown" in p
    assert "1–2 sentences" in p or "1-2 sentences" in p
    for banned in ("bullet", "table", "emoji", "code block"):
        assert banned in p, banned


def test_the_voice_prompt_requires_admitting_ignorance():
    """The failure that matters most in voice: there's no screen to check
    the answer against, so a confident guess is far more expensive than
    it is in text."""
    from app.chat.base_prompt import VOICE_SYSTEM_PROMPT

    p = VOICE_SYSTEM_PROMPT.lower()

    assert "don't know" in p
    assert "guess" in p


def test_the_voice_prompt_bans_reading_out_references():
    """Answers come from the user's own documents, so citation markers,
    filenames, paths and ids are all live risks — each one is noise when
    read aloud."""
    from app.chat.base_prompt import VOICE_SYSTEM_PROMPT

    p = VOICE_SYSTEM_PROMPT.lower()

    assert "citation" in p
    assert "file path" in p
    for term in ("hash", "url"):
        assert term in p, term


def test_a_voice_turn_uses_the_voice_prompt_and_a_token_cap():
    """Two independent guards. The prompt does the real work; the token
    cap is the backstop for a model that ignores the steer, so neither
    alone is trusted to stop an essay being read aloud."""
    from app.chat.base_prompt import VOICE_SYSTEM_PROMPT
    from app.chat.router import VOICE_MAX_TOKENS

    assert VOICE_MAX_TOKENS <= 400
    assert len(VOICE_SYSTEM_PROMPT) > 500


# ------------------------------------------------- wyoming bridge


async def test_the_bridge_runs_a_matched_command(db, user):
    """Same brain as the in-app voice mode, different wire. A satellite
    in a hallway should behave identically to the phone in your hand."""
    from app.wyoming_bridge.service import answer

    await _cmd(
        db,
        user,
        name="Garage lights off",
        phrases=["garage lights off"],
        action_type="prompt",
        body="ignored",
        response_template="Garage lights off.",
    )

    result = await answer(db, user, "Promptly, garage lights off")

    assert result.handled is True
    assert result.text == "Garage lights off."


async def test_unmatched_speech_is_handed_back(db, user):
    """``NotHandled`` lets Home Assistant fall back to its own agent.
    Answering anyway would mean an unauthenticated TCP port could spend
    tokens and read documents — the protocol carries no credentials, so
    that decision stays where the credentials are."""
    from app.wyoming_bridge.service import answer

    result = await answer(db, user, "what is the capital of France")

    assert result.handled is False
    assert result.text == ""


async def test_a_command_that_asks_first_is_refused_over_wyoming(db, user):
    """Wyoming's handle service is one request and one response, with no
    turn state to hold a yes/no in. Rather than half-implement a
    confirmation nobody can answer, say why it didn't run."""
    from app.wyoming_bridge.service import answer

    await _cmd(
        db,
        user,
        name="Open garage",
        phrases=["open the garage"],
        action_type="prompt",
        body="x",
        confirm_before_run=True,
    )

    result = await answer(db, user, "open the garage")

    assert result.handled is True
    assert "ask first" in result.text


async def test_a_failing_command_says_why(db, user):
    """Spoken back, not swallowed. From across a room, silence is
    indistinguishable from a microphone that didn't hear you."""
    from app.wyoming_bridge.service import answer

    await _cmd(
        db,
        user,
        name="Morning routine",
        phrases=["run the morning routine"],
        action_type="automation",
        action_ref=str(uuid.uuid4()),
    )

    result = await answer(db, user, "run the morning routine")

    assert result.handled is True
    assert "no longer exists" in result.text


async def test_empty_speech_is_not_handled(db, user):
    from app.wyoming_bridge.service import answer

    assert (await answer(db, user, "   ")).handled is False


def test_the_bridge_is_off_unless_explicitly_enabled():
    """It's an unauthenticated listener. Default-on would be a port
    quietly appearing on someone's network."""
    from app.config import Settings

    s = Settings()

    assert s.WYOMING_ENABLED is False
    assert s.WYOMING_USER_ID == ""


async def test_the_wyoming_protocol_round_trips_over_a_real_socket(db, user):
    """The wire, not just the brain.

    Everything above tests the decision-making; this starts the actual
    TCP server, connects a real Wyoming client, and checks the three
    exchanges a Home Assistant pipeline performs: describe yourself,
    here's what was said, and what should I say back. The event
    encodings were built by reading the library rather than a spec, so
    "it type-checks" proves nothing here — only a round trip does.
    """
    from wyoming.asr import Transcript
    from wyoming.client import AsyncTcpClient
    from wyoming.handle import Handled, NotHandled
    from wyoming.info import Describe, Info

    from app.wyoming_bridge.server import serve

    await _cmd(
        db,
        user,
        name="Garage lights off",
        phrases=["garage lights off"],
        action_type="prompt",
        body="x",
        response_template="Garage lights off.",
    )

    # Port 0 = let the OS pick a free one, so a busy port on the test
    # machine can't make this flake.
    server = await serve("127.0.0.1", 0, user.id)
    port = server.sockets[0].getsockname()[1]
    try:
        async with AsyncTcpClient("127.0.0.1", port) as client:
            await client.write_event(Describe().event())
            info_event = await client.read_event()
            assert info_event is not None
            info = Info.from_event(info_event)
            assert info.handle, "should advertise a handle service"
            assert info.handle[0].name == "promptly"

            await client.write_event(
                Transcript(text="Promptly, garage lights off").event()
            )
            reply = await client.read_event()
            assert reply is not None
            assert Handled.is_type(reply.type)
            assert Handled.from_event(reply).text == "Garage lights off."

            await client.write_event(
                Transcript(text="what is the capital of France").event()
            )
            reply = await client.read_event()
            assert reply is not None
            # Explicitly not handled, so HA falls back to its own agent
            # rather than the satellite going silent.
            assert NotHandled.is_type(reply.type)
    finally:
        server.close()
        await server.wait_closed()


# ------------------------------------------------- MCP over SSE
#
# The SSE transport was added so Home Assistant could be connected at
# all — its MCP server speaks SSE while Promptly only spoke
# streamable-HTTP. Everything about it type-checked, but nothing had
# ever completed a handshake, and a transport that has never carried a
# message is a guess. This stands up a real SSE MCP server and talks to
# it with our own client.


async def test_our_client_talks_to_a_real_sse_mcp_server():
    import asyncio
    import contextlib

    import uvicorn
    from mcp.server.fastmcp import FastMCP

    from app.mcp.client import call_tool, fetch_tools

    server = FastMCP("probe")

    def lights_off(room="garage"):
        """Turn the lights off in a room."""
        return f"lights off in {room}"

    # This module has ``from __future__ import annotations``, so inline
    # hints would reach FastMCP as strings and its introspection would
    # choke. Set real classes and register by hand.
    lights_off.__annotations__ = {"room": str, "return": str}
    server.tool()(lights_off)

    app = server.sse_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=8931, log_level="error")
    running = uvicorn.Server(config)
    task = asyncio.create_task(running.serve())
    try:
        # Wait for the socket rather than sleeping a fixed amount, so a
        # slow machine doesn't turn this into a flaky test.
        for _ in range(100):
            if running.started:
                break
            await asyncio.sleep(0.05)
        assert running.started, "probe server never came up"

        url = "http://127.0.0.1:8931/sse"

        tools = await fetch_tools(url, transport="sse")
        assert any(t["name"] == "lights_off" for t in tools)

        out = await call_tool(
            url, "lights_off", {"room": "kitchen"}, transport="sse"
        )
        assert "lights off in kitchen" in out
    finally:
        running.should_exit = True
        with contextlib.suppress(Exception):
            await asyncio.wait_for(task, timeout=10)


async def test_the_default_transport_is_still_streamable_http():
    """Existing connectors were all streamable-HTTP. Adding SSE must not
    have quietly changed what they speak."""
    from app.mcp.client import TRANSPORTS
    from app.mcp.models import McpConnector

    assert TRANSPORTS[0] == "http"
    row = McpConnector(
        name="Plain", slug=f"p{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://stub.invalid/mcp",
    )
    assert row.transport is None or row.transport == "http"


async def test_destructive_tools_are_flagged_to_the_picker(db, user):
    """A deliberate asymmetry, made safe.

    The MODEL can't call a tool the connector flags destructive — those
    are stripped from its tool list entirely. A human's pre-written
    command CAN, because "open the garage door" is exactly the sort of
    thing someone writes on purpose and says out loud, and blocking it
    would make the whole integration useless.

    What squares that is the hint travelling to the editor, so
    confirmation defaults ON for those tools. The user shouldn't have to
    know which of a hundred Home Assistant services is the one that
    opens a door.
    """
    from app.commands.router import list_available_tools
    from app.mcp.models import McpConnector

    connector = McpConnector(
        name="Home",
        slug=f"home{uuid.uuid4().hex[:6]}",
        kind="mcp",
        url="http://stub.invalid/sse",
        transport="sse",
        enabled=True,
        tool_catalog=[
            {
                "name": "lights_off",
                "description": "Turn lights off",
                "annotations": {},
            },
            {
                "name": "open_garage",
                "description": "Open the garage door",
                "annotations": {"destructiveHint": True},
            },
            {
                "name": "read_sensor",
                "description": "Read a sensor",
                # Destructive AND read-only is a contradiction the spec
                # allows; read-only wins, so this must not be flagged.
                "annotations": {"destructiveHint": True, "readOnlyHint": True},
            },
        ],
    )
    db.add(connector)
    await db.commit()

    sources = await list_available_tools(db=db, user=user)
    tools = {t["name"]: t for s in sources for t in s["tools"]}

    assert tools["lights_off"]["destructive"] is False
    assert tools["open_garage"]["destructive"] is True
    assert tools["read_sensor"]["destructive"] is False


def test_the_model_still_cannot_call_destructive_tools():
    """The other half of the asymmetry, pinned so it can't drift."""
    from app.mcp.service import _is_blocked_destructive

    assert _is_blocked_destructive({"destructiveHint": True}) is True
    assert (
        _is_blocked_destructive({"destructiveHint": True, "readOnlyHint": True})
        is False
    )
    assert _is_blocked_destructive({}) is False


def test_connector_errors_name_the_actual_cause():
    """The MCP SDK runs its transport in an anyio task group, so a 404,
    a 401 or a refused connection all surface as "unhandled errors in a
    task group" — which tells the person configuring a connector
    nothing at the exact moment they most need to know whether it was
    the URL, the token, or the server.
    """
    import httpx

    from app.mcp.client import describe_error

    request = httpx.Request("GET", "http://ha.local:8123/mcp_server/sse")
    response = httpx.Response(404, request=request)
    status = httpx.HTTPStatusError(
        "Client error '404 Not Found' for url 'http://ha.local:8123/x'\n"
        "For more information check: https://developer.mozilla.org/...",
        request=request,
        response=response,
    )

    # The shape the SDK actually raises.
    grouped = ExceptionGroup("unhandled errors in a task group", [status])
    described = describe_error(grouped)

    assert "404" in described
    assert "task group" not in described
    # httpx's two-line MDN footer is noise in a one-line admin message.
    assert "developer.mozilla.org" not in described
    assert "\n" not in described


def test_repeated_failures_are_not_repeated_back():
    """A retrying transport reports the same refusal several times; the
    admin needs to read it once."""
    from app.mcp.client import describe_error

    err = ConnectionRefusedError("All connection attempts failed")
    grouped = ExceptionGroup("boom", [err, err, err])

    assert describe_error(grouped).count("All connection attempts failed") == 1


# ------------------------------------------- auth header normalisation


def test_a_bare_token_gets_the_bearer_scheme():
    """What you copy out of Home Assistant is the token, not
    "Bearer <token>". Expecting every admin to know they must type the
    scheme produces a 401 that reads like a bad token — the least
    diagnosable failure in the whole setup."""
    from app.mcp.service import auth_header_value

    assert auth_header_value("Authorization", "eyJhbGciOi") == "Bearer eyJhbGciOi"
    assert auth_header_value("authorization", "abc123") == "Bearer abc123"


def test_a_scheme_the_user_supplied_is_left_alone():
    """Anything with whitespace is a scheme they chose deliberately.
    Second-guessing it would be worse than doing nothing."""
    from app.mcp.service import auth_header_value

    for value in ("Bearer abc123", "Basic dXNlcjpwYXNz", "Token abc123"):
        assert auth_header_value("Authorization", value) == value


def test_other_headers_are_never_prefixed():
    """UniFi and friends take a raw key. Prefixing those would break a
    connector that currently works."""
    from app.mcp.service import auth_header_value

    assert auth_header_value("X-API-KEY", "abc123") == "abc123"
    assert auth_header_value("X-Api-Key", "abc123") == "abc123"
    assert auth_header_value(None, "abc123") == "abc123"


def test_an_empty_value_is_untouched():
    from app.mcp.service import auth_header_value

    assert auth_header_value("Authorization", "") == ""
    assert auth_header_value("Authorization", "   ") == "   "


async def test_tool_argument_schemas_reach_the_editor(db, user):
    """Home Assistant exposes *intents* — HassTurnOff — not entities, so
    "which lamp" is an argument rather than a tool you pick. Without the
    schema the editor can't ask for it, and a command ends up saying
    "turn something off" without saying what."""
    from app.commands.router import list_available_tools
    from app.mcp.models import McpConnector

    connector = McpConnector(
        name="Home",
        slug=f"home{uuid.uuid4().hex[:6]}",
        kind="mcp",
        url="http://stub.invalid/sse",
        transport="sse",
        enabled=True,
        tool_catalog=[
            {
                "name": "HassTurnOff",
                "description": "Turns off a device",
                "annotations": {"destructiveHint": True},
                "input_schema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            }
        ],
    )
    db.add(connector)
    await db.commit()

    sources = await list_available_tools(db=db, user=user)
    tool = sources[0]["tools"][0]

    assert tool["input_schema"]["required"] == ["name"]
    assert "name" in tool["input_schema"]["properties"]


async def test_fixed_arguments_are_sent_and_slots_win(db, user):
    """``action_args`` carries what the editor collected; a spoken slot
    of the same name overrides it, so "turn off the {room} lights" can
    reuse one command for every room."""
    from app.commands.service import execute

    row = await _cmd(
        db,
        user,
        name="Kitchen lamp off",
        action_type="prompt",
        body="off: {name}",
        action_args={"name": "Kitchen Lamp"},
    )

    fixed = await execute(db, row, user)
    assert fixed["text"] == "off: Kitchen Lamp"

    overridden = await execute(db, row, user, slots={"name": "Lounge Lamp"})
    assert overridden["text"] == "off: Lounge Lamp"


# --------------------------------------------------- device picking
#
# Home Assistant's GetLiveContext returns prose-ish text whose exact
# shape varies by version, so the parser tries three strategies and the
# endpoint hands back the raw text when all three come up empty. An
# empty list and an unreadable response look identical from the UI and
# need opposite fixes.


def test_devices_parse_from_yaml_ish_output():
    """The shape Home Assistant actually emits: a prose preamble, then
    entities keyed with the plural "names"/"areas"."""
    from app.commands.devices import parse_devices

    raw = """Live Context: An overview of the areas and devices in this home:
- names: Kitchen Lamp
  domain: light
  state: 'off'
  areas: Lounge Room
- names: Kitchen Speaker
  domain: media_player
  state: idle
  areas: Kitchen
"""
    devices = parse_devices(raw)

    assert [d["name"] for d in devices] == ["Kitchen Lamp", "Kitchen Speaker"]
    assert devices[0]["domain"] == "light"
    assert devices[0]["area"] == "Lounge Room"
    assert devices[1]["domain"] == "media_player"


def test_devices_parse_from_json_output():
    from app.commands.devices import parse_devices

    raw = '{"entities": [{"name": "Hue Bridge", "domain": "light", "state": "on"}]}'

    devices = parse_devices(raw)

    assert devices == [
        {"name": "Hue Bridge", "domain": "light", "area": "", "state": "on"}
    ]


def test_unreadable_output_yields_nothing_rather_than_junk():
    """The caller turns an empty parse into "couldn't read the list" plus
    the raw text. Inventing a device from prose would be worse."""
    from app.commands.devices import parse_devices

    assert parse_devices("I'm sorry, I can't help with that.") == []
    assert parse_devices("") == []


def test_duplicate_entities_are_collapsed():
    from app.commands.devices import parse_devices

    raw = """- names: Kitchen Lamp
  domain: light
- names: Kitchen Lamp
  domain: light
"""
    assert len(parse_devices(raw)) == 1


def test_actions_are_filtered_to_what_the_connector_really_has():
    """The domain map is a *preference*, not a claim. Filtering it
    against the real catalog means a stale entry costs nothing and can
    never offer an action that would fail."""
    from app.commands.devices import actions_for

    catalog = ["HassTurnOn", "HassTurnOff", "GetLiveContext"]

    # HassLightSet is preferred for lights but absent here, so it's
    # simply not offered.
    assert actions_for("light", catalog) == ["HassTurnOn", "HassTurnOff"]
    # An unknown domain still gets the universal pair.
    assert actions_for("doorbell", catalog) == ["HassTurnOn", "HassTurnOff"]
    # A connector with none of them offers none.
    assert actions_for("light", ["GetLiveContext"]) == []


def test_media_players_offer_media_actions_first():
    from app.commands.devices import actions_for

    catalog = ["HassTurnOn", "HassTurnOff", "HassMediaPause", "HassMediaNext"]

    actions = actions_for("media_player", catalog)

    assert actions[0] == "HassMediaPause"
    assert "HassMediaNext" in actions


def test_only_connectors_publishing_live_context_offer_devices():
    """UniFi and other connectors have no device list to read, so the
    editor falls back to picking a tool rather than showing an empty
    picker."""
    from app.commands.devices import supports_devices

    assert supports_devices(["HassTurnOn", "GetLiveContext"]) is True
    assert supports_devices(["list_sites", "list_clients"]) is False


def test_devices_parse_from_the_real_home_assistant_envelope():
    """The shape a real Home Assistant actually returned.

    GetLiveContext answers with a JSON object whose ``result`` field is
    a *string* holding the entire device list. Every structural parser
    walks that JSON correctly and finds nothing, because the entities
    aren't structure — they're text inside it. This is the case that hit
    in production, caught only because the UI shows the raw response
    instead of claiming there are no devices.
    """
    import json

    from app.commands.devices import parse_devices

    inner = (
        "Live Context: An overview of the areas and the devices in this "
        "smart home:\n"
        '- names: 100" Neo QLED\n'
        "  domain: media_player\n"
        "  state: 'off'\n"
        "- names: Downstairs Speakers\n"
        "  domain: media_player\n"
        "  state: 'off'\n"
        "  attributes:\n"
        "    device_class: speaker\n"
        "- names: Gym TV\n"
        "  domain: media_player\n"
        "  state: unavailable\n"
        "- names: Kitchen Lamp\n"
        "  domain: light\n"
        "  state: 'on'\n"
        "  areas: Lounge Room\n"
        "  attributes:\n"
        "    brightness: '255'\n"
    )
    raw = json.dumps({"success": True, "result": inner})

    devices = parse_devices(raw)
    by_name = {d["name"]: d for d in devices}

    assert "Kitchen Lamp" in by_name
    assert by_name["Kitchen Lamp"]["domain"] == "light"
    assert by_name["Kitchen Lamp"]["area"] == "Lounge Room"
    assert by_name["Downstairs Speakers"]["domain"] == "media_player"
    # A name containing a quote character must survive intact.
    assert '100" Neo QLED' in by_name
    # Nested attributes are not entities.
    assert "speaker" not in by_name
    assert "255" not in by_name
