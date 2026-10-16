"""What a turn costs in context, and what the meter says about it (WP-1.4).

A one-line question went out with ~18k tokens on the meter: tool
descriptions sent three times over, the date and time at the very top of
the system prompt (so no provider could cache a byte of it), and a meter
that added up every tool-call round trip.
"""
from __future__ import annotations

from app.chat.context_usage import build_context_usage, history_chars
from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta, UsageEvent
from tests.test_chat_reliability import _drive, _enqueue, _replies
from tests.test_chat_streaming import _seed_turn


def _capturing(seen: list[dict], *, hops=None):
    """A model that records each request; ``hops`` scripts a tool call first."""

    async def _stream(**kwargs):
        seen.append(kwargs)
        n = len(seen)
        if hops and n <= len(hops):
            for ev in hops[n - 1]:
                yield ev
            return
        yield TextDelta(text="Four.")
        yield UsageEvent(prompt_tokens=1200, completion_tokens=3)
        yield FinishEvent(reason="stop")

    return _stream


async def test_the_standing_prompt_comes_first_and_the_turn_last(db, user, conversation, monkeypatch):
    """The date and time change every minute. At the top they made every
    request's prefix unique, so provider prompt caching never applied."""
    from app.chat.base_prompt import PROMPTLY_BASE_PROMPT

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    seen: list[dict] = []
    await _drive(monkeypatch, user, stream_id, _capturing(seen))

    system = seen[0]["system"]
    assert system.startswith("Tools you can call this turn:")
    assert system.index(PROMPTLY_BASE_PROMPT.strip()[:60]) < system.index("Today's date")


async def test_tools_are_named_once_not_described_again(db, user, conversation, monkeypatch):
    """Each tool's description already travels in its schema."""
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    seen: list[dict] = []
    await _drive(monkeypatch, user, stream_id, _capturing(seen))

    system, tools = seen[0]["system"], seen[0]["tools"]
    assert tools
    for schema in tools:
        description = schema["function"]["description"]
        assert description[:80] not in system


async def test_a_model_without_tool_calling_isnt_told_about_tools(
    db, user, conversation, provider, monkeypatch
):
    """The provider layer drops tools for such a model, but the prompt
    still described them — tokens spent inviting a call it can't make."""
    provider.models = [{"id": "test-model", "name": "Test Model", "supports_tools": False}]
    await db.commit()
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    seen: list[dict] = []
    await _drive(monkeypatch, user, stream_id, _capturing(seen))

    assert not seen[0]["tools"]
    assert "Tools you can call" not in seen[0]["system"]


async def test_the_meter_reads_the_last_request_not_the_sum(db, user, conversation, monkeypatch):
    """A turn that called a tool made two requests. Billing adds them up;
    the context in view when the reply was written is the second one."""
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    seen: list[dict] = []
    first_hop = [
        ToolCallDelta(index=0, id="call_1", name="echo", arguments='{"text": "ping"}'),
        UsageEvent(prompt_tokens=1000, completion_tokens=10),
        FinishEvent(reason="tool_calls"),
    ]
    await _drive(monkeypatch, user, stream_id, _capturing(seen, hops=[first_hop]))

    (reply,) = await _replies(conversation)
    assert reply.prompt_tokens == 2200  # billing: both requests
    usage = reply.context_usage
    assert usage["total"] == 1200 and usage["measured"] is True
    assert abs(sum(usage["parts"].values()) - 1200) <= 4
    assert usage["parts"]["tools"] > 0 and usage["parts"]["turn"] > 0


def test_parts_are_scaled_to_the_real_total():
    usage = build_context_usage(
        measured_prompt_tokens=500,
        instructions_chars=400,
        turn_chars=400,
        tools_chars=800,
        history_chars=400,
    )
    assert usage == {
        "total": 500,
        "measured": True,
        "parts": {"instructions": 100, "turn": 100, "tools": 200, "history": 100},
    }


def test_without_a_reported_total_the_estimate_stands():
    usage = build_context_usage(
        measured_prompt_tokens=None, instructions_chars=40, turn_chars=0, tools_chars=0, history_chars=40
    )
    assert usage["measured"] is False and usage["total"] == 20


def test_an_image_counts_as_an_image_not_its_base64():
    from app.models_config.provider import ChatMessage, ImagePart, TextPart

    msg = ChatMessage(
        role="user",
        content=[TextPart(text="what is this?"), ImagePart(url="data:image/png;base64," + "A" * 400_000)],
    )
    assert history_chars([msg]) < 10_000
