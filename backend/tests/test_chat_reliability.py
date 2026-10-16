"""A reply that doesn't finish keeps what it already produced (WP-1.2).

Stop, a provider error halfway through, a dropped upstream connection or a
plain bug used to make the text the user had just watched stream in vanish:
nothing was saved, and on several of those paths no error was shown either.
These drive the real generator with a scripted model.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.models_config.provider import (
    FinishEvent,
    ProviderError,
    TextDelta,
    ToolCallDelta,
    UsageEvent,
)
from tests.test_chat_streaming import _FakeRequest, _seed_turn


@pytest.fixture(autouse=True)
def _clean_sessions():
    from app.chat.stream_runner import _sessions

    _sessions.clear()
    yield
    _sessions.clear()


async def _enqueue(conversation, user_msg, **extra) -> uuid.UUID:
    from app.chat.service import enqueue_stream

    stream_id = uuid.uuid4()
    await enqueue_stream(
        stream_id,
        {
            "conversation_id": str(conversation.id),
            "user_message_id": str(user_msg.id),
            "provider_id": str(conversation.provider_id),
            "model_id": "test-model",
            "web_search_mode": "off",
            "temperature": 0.7,
            "max_tokens": None,
            "tools_enabled": extra.pop("tools_enabled", False),
            "reasoning_effort": None,
            **extra,
        },
    )
    return stream_id


async def _drive(monkeypatch, user, stream_id, stub) -> list[str]:
    """Run the generator to the end (no background session)."""
    from app.chat import router as chat_router

    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", stub, raising=True)
    return [c async for c in chat_router._stream_generator(stream_id, user, _FakeRequest())]


async def _start_session(monkeypatch, user, conversation, stream_id, stub):
    """Run the generator as the app does: a background session."""
    from app.chat import router as chat_router
    from app.chat.stream_runner import get_or_create_session

    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", stub, raising=True)
    return await get_or_create_session(
        stream_id=stream_id,
        user_id=user.id,
        conversation_id=conversation.id,
        runner=lambda s: chat_router._bridge_generator_to_session(stream_id, user, _FakeRequest(), s),
    )


async def _until(predicate, timeout: float = 5.0) -> None:
    async def _poll():
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_poll(), timeout)


async def _replies(conversation):
    from app.chat.models import Message
    from app.database import SessionLocal

    async with SessionLocal() as s:
        return list(
            (
                await s.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation.id, Message.role == "assistant")
                    .order_by(Message.created_at)
                )
            ).scalars()
        )


async def _leaf(conversation):
    from app.chat.models import Conversation
    from app.database import SessionLocal

    async with SessionLocal() as s:
        return (await s.get(Conversation, conversation.id)).active_leaf_message_id


def _stalls_after(*texts: str, release: asyncio.Event):
    async def _stream(**kwargs):
        for t in texts:
            yield TextDelta(text=t)
        await release.wait()
        yield FinishEvent(reason="stop")

    return _stream


# ---------------------------------------------------------------- Stop


async def test_stop_mid_reply_keeps_what_was_written(db, user, conversation, monkeypatch):
    """The usual case: a single-hop reply, stopped while it streams. The
    text lived only in the hop's own buffer, which Stop couldn't see."""
    from app.chat.stream_runner import stop_session

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)
    release = asyncio.Event()
    session = await _start_session(
        monkeypatch, user, conversation, stream_id, _stalls_after("Hello ", "half", release=release)
    )
    await _until(lambda: any("half" in e for e in session.events))

    assert await stop_session(session, done_event='data: {"done": true}\n\n') is True

    (reply,) = await _replies(conversation)
    assert reply.content.startswith("Hello half")
    assert reply.content.endswith("_[Stopped.]_")
    assert await _leaf(conversation) == reply.id


async def test_stop_after_the_reply_is_saved_does_not_duplicate_it(db, user, conversation, monkeypatch):
    """Pressing Stop in the moment between the reply being saved and the
    stream closing used to save it a second time, tagged "Stopped", as the
    visible version."""
    from app.chat import router as chat_router
    from app.chat.stream_runner import stop_session

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)

    hold = asyncio.Event()
    real_check = chat_router.check_budget

    async def _slow_check(*a, **kw):
        await hold.wait()
        return await real_check(*a, **kw)

    monkeypatch.setattr(chat_router, "check_budget", _slow_check)

    async def _stream(**kwargs):
        yield TextDelta(text="A complete answer.")
        yield FinishEvent(reason="stop")

    session = await _start_session(monkeypatch, user, conversation, stream_id, _stream)
    replies: list = []

    async def _saved() -> bool:
        replies[:] = await _replies(conversation)
        return bool(replies)

    async def _poll():
        while not await _saved():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(_poll(), 5)
    await stop_session(session, done_event='data: {"done": true}\n\n')
    hold.set()

    replies = await _replies(conversation)
    assert [r.content for r in replies] == ["A complete answer."]
    assert await _leaf(conversation) == replies[0].id


async def test_stopping_a_regenerate_before_any_text_brings_the_old_answer_back(
    db, user, conversation, monkeypatch
):
    from app.chat.models import Conversation, Message
    from app.chat.stream_runner import stop_session

    user_msg = await _seed_turn(db, conversation)
    old = Message(conversation_id=conversation.id, role="assistant", content="The old answer", parent_id=user_msg.id)
    db.add(old)
    await db.flush()
    # What the regenerate endpoint does: point the leaf at the prompt so
    # the new answer streams in its place.
    conv = await db.get(Conversation, conversation.id)
    conv.active_leaf_message_id = user_msg.id
    await db.commit()

    stream_id = await _enqueue(conversation, user_msg, restore_leaf_id=str(old.id))
    release = asyncio.Event()
    session = await _start_session(
        monkeypatch, user, conversation, stream_id, _stalls_after(release=release)
    )
    await asyncio.sleep(0.3)
    await stop_session(session, done_event='data: {"done": true}\n\n')

    assert await _leaf(conversation) == old.id
    assert [r.content for r in await _replies(conversation)] == ["The old answer"]


# ---------------------------------------------------------------- errors


def _then_raises(exc: BaseException, *texts: str):
    async def _stream(**kwargs):
        for t in texts:
            yield TextDelta(text=t)
        yield UsageEvent(prompt_tokens=40, completion_tokens=12, cost_usd=0.001)
        raise exc

    return _stream


async def test_provider_error_keeps_the_partial_reply_and_says_why(db, user, conversation, monkeypatch):
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)

    chunks = await _drive(
        monkeypatch, user, stream_id,
        _then_raises(ProviderError("Upstream error during stream: overloaded"), "Most of ", "an answer"),
    )

    (reply,) = await _replies(conversation)
    assert reply.content.startswith("Most of an answer")
    assert "didn't finish" in reply.content
    assert await _leaf(conversation) == reply.id
    # Tokens already spent are counted, not dropped.
    assert reply.completion_tokens == 12
    joined = "".join(chunks)
    assert '"error"' in joined
    # ``done`` carries the saved message so the bubble stays on screen
    # under the error card instead of vanishing.
    assert f'"message_id": "{reply.id}"' in joined


async def test_a_dropped_connection_is_an_error_not_silence(db, user, conversation, monkeypatch):
    """httpx transport errors (read timeout, connection reset) used to
    bypass every handler: no error, no save, the text just vanished."""
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)

    chunks = await _drive(
        monkeypatch, user, stream_id, _then_raises(httpx.ReadTimeout(""), "Half a sentence")
    )

    joined = "".join(chunks)
    assert '"error_code": "provider_overloaded"' in joined
    (reply,) = await _replies(conversation)
    assert reply.content.startswith("Half a sentence")


async def test_a_bug_mid_reply_is_reported_and_the_text_kept(db, user, conversation, monkeypatch):
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)

    chunks = await _drive(monkeypatch, user, stream_id, _then_raises(RuntimeError("boom"), "Some text"))

    joined = "".join(chunks)
    assert '"error"' in joined and '"done": true' in joined
    (reply,) = await _replies(conversation)
    assert reply.content.startswith("Some text")


async def test_a_failed_regenerate_with_no_text_keeps_the_old_answer(db, user, conversation, monkeypatch):
    from app.chat.models import Conversation, Message

    user_msg = await _seed_turn(db, conversation)
    old = Message(conversation_id=conversation.id, role="assistant", content="Good answer", parent_id=user_msg.id)
    db.add(old)
    await db.flush()
    conv = await db.get(Conversation, conversation.id)
    conv.active_leaf_message_id = user_msg.id
    await db.commit()

    stream_id = await _enqueue(conversation, user_msg, restore_leaf_id=str(old.id))
    await _drive(monkeypatch, user, stream_id, _then_raises(ProviderError("429 rate limit")))

    assert await _leaf(conversation) == old.id
    assert [r.content for r in await _replies(conversation)] == ["Good answer"]


async def test_a_failed_second_hop_keeps_the_tool_activity(db, user, conversation, monkeypatch):
    """Work done on earlier hops (tool calls, their results) is kept even
    when no text was written before the failure."""
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    calls = {"n": 0}

    async def _stream(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            yield ToolCallDelta(index=0, id="call_1", name="echo", arguments='{"text": "ping"}')
            yield FinishEvent(reason="tool_calls")
            return
        raise ProviderError("Upstream error during stream: 503 service unavailable")

    await _drive(monkeypatch, user, stream_id, _stream)

    (reply,) = await _replies(conversation)
    assert reply.tool_calls and reply.tool_calls[0]["name"] == "echo"
    assert "didn't finish" in reply.content


# ---------------------------------------------------------------- runner


async def test_a_crashed_runner_still_tells_the_client(monkeypatch):
    from app.chat.stream_runner import get_or_create_session

    async def _runner(session):
        session.push('data: {"delta": "hi"}\n\n')
        raise RuntimeError("boom")

    session = await get_or_create_session(
        stream_id=uuid.uuid4(), user_id=uuid.uuid4(), conversation_id=uuid.uuid4(), runner=_runner
    )
    seen = [chunk async for _i, chunk in session.subscribe()]
    joined = "".join(seen)
    assert '"error"' in joined
    assert '"done": true' in joined


# ---------------------------------------------------------------- provider


async def test_provider_turns_transport_errors_into_provider_errors(monkeypatch):
    """The OpenAI SDK lets httpx errors out of a stream unwrapped."""
    from app.models_config import provider as prov
    from app.models_config.models import ModelProvider

    class _Stream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise httpx.RemoteProtocolError("peer closed connection without sending complete message body")

    class _Client:
        class chat:
            class completions:
                @staticmethod
                async def create(**kw):
                    return _Stream()

        async def close(self):
            pass

    monkeypatch.setattr(prov, "_client_for", lambda p: _Client())
    p = ModelProvider(name="x", type="openai_compatible", base_url="http://x/v1", api_key=None, models=[])
    with pytest.raises(prov.ProviderError) as e:
        async for _ in prov.model_router.stream_chat_events(
            provider=p, model_id="m", messages=[], system=None
        ):
            pass
    assert "connection" in str(e.value).lower()


# ---------------------------------------------------------------- done first


def _quick_reply():
    async def _stream(**kwargs):
        yield TextDelta(text="Done thinking.")
        yield FinishEvent(reason="stop")

    return _stream


async def test_done_goes_out_before_the_title_is_generated(db, user, conversation, monkeypatch):
    """A finished reply used to sit in "Stop" mode while the titler (and
    memory capture) ran on the chat model. ``done`` now comes first and the
    title follows it."""
    from app.chat import router as chat_router

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)
    called: list[bool] = []

    async def _titler(**kw):
        called.append(True)
        return "A fresh title"

    monkeypatch.setattr(chat_router, "generate_conversation_title", _titler)
    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", _quick_reply(), raising=True)

    seen: list[str] = []
    titler_ran_before_done = None
    async for chunk in chat_router._stream_generator(stream_id, user, _FakeRequest()):
        if '"done": true' in chunk and titler_ran_before_done is None:
            titler_ran_before_done = bool(called)
        seen.append(chunk)

    assert titler_ran_before_done is False
    done_at = next(i for i, c in enumerate(seen) if '"done": true' in c)
    title_at = next(i for i, c in enumerate(seen) if "title_updated" in c)
    assert title_at > done_at


async def test_a_stalled_titler_gives_up(db, user, conversation, monkeypatch):
    from app.chat import router as chat_router

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg)

    async def _stuck(**kw):
        await asyncio.Event().wait()

    monkeypatch.setattr(chat_router, "generate_conversation_title", _stuck)
    monkeypatch.setattr(chat_router, "_TITLE_TIMEOUT_S", 0.3)
    chunks = await asyncio.wait_for(_drive(monkeypatch, user, stream_id, _quick_reply()), 10)
    assert any('"done": true' in c for c in chunks)
    assert not any("title_updated" in c for c in chunks)


async def test_a_reload_after_done_does_not_reattach(monkeypatch):
    """The session lingers after ``done`` for the title and memory events;
    it mustn't look like a reply still being written."""
    from app.chat.stream_runner import find_active_for_conversation, get_or_create_session

    conv_id = uuid.uuid4()
    release = asyncio.Event()

    async def _runner(session):
        session.push('data: {"done": true, "message_id": "x"}\n\n')
        await release.wait()

    await get_or_create_session(stream_id=uuid.uuid4(), user_id=uuid.uuid4(), conversation_id=conv_id, runner=_runner)
    await asyncio.sleep(0.05)
    assert find_active_for_conversation(conversation_id=conv_id) is None
    release.set()


# ---------------------------------------------------------------- server-started


@pytest.fixture
async def client(db, monkeypatch):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _finish(stream_id: str) -> None:
    from app.chat.stream_runner import get_session

    session = get_session(uuid.UUID(stream_id))
    assert session is not None, "generation should already be running"
    await asyncio.wait_for(session.task, 10)


async def test_a_reply_is_written_even_if_the_client_never_attaches(
    db, user, conversation, client, monkeypatch
):
    """A phone that goes to the background straight after Send never opens
    the stream. The answer must still be written (R-055)."""
    from app.chat import router as chat_router

    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", _quick_reply(), raising=True)
    monkeypatch.setattr(chat_router, "generate_conversation_title", lambda **kw: asyncio.sleep(0, ""))

    r = await client.post(
        f"/api/chat/conversations/{conversation.id}/messages",
        json={"content": "hi", "provider_id": str(conversation.provider_id), "model_id": "test-model"},
        headers=_auth(user),
    )
    assert r.status_code == 202, r.text
    await _finish(r.json()["stream_id"])

    assert [m.content for m in await _replies(conversation)] == ["Done thinking."]


async def test_regenerate_starts_on_the_server_and_keeps_the_old_answer_on_failure(
    db, user, conversation, client, monkeypatch
):
    from app.chat import router as chat_router
    from app.chat.models import Conversation, Message

    user_msg = await _seed_turn(db, conversation)
    old = Message(conversation_id=conversation.id, role="assistant", content="Keep me", parent_id=user_msg.id)
    db.add(old)
    await db.flush()
    (await db.get(Conversation, conversation.id)).active_leaf_message_id = old.id
    await db.commit()

    monkeypatch.setattr(
        chat_router.model_router, "stream_chat_events", _then_raises(ProviderError("429 rate limit")), raising=True
    )
    r = await client.post(
        f"/api/chat/conversations/{conversation.id}/messages/{old.id}/regenerate",
        json={"provider_id": str(conversation.provider_id), "model_id": "test-model"},
        headers=_auth(user),
    )
    assert r.status_code == 202, r.text
    await _finish(r.json()["stream_id"])

    assert await _leaf(conversation) == old.id


# ---------------------------------------------------------------- run_agents


async def test_stopping_run_agents_stops_every_sub_agent(db, user, conversation, monkeypatch):
    """Stop cancelled the tool but not the sub-agents it had launched: up to
    four kept searching and spending on the chat model (R-076)."""
    from app.chat import agent_runner
    from app.chat.tools import run_agents as ra
    from app.chat.tools.base import ToolContext

    monkeypatch.setattr(ra, "_LAUNCH_STAGGER_S", 0)

    async def _provider(*a, **kw):
        return object()

    monkeypatch.setattr(ra, "pick_search_provider", _provider)
    running: set[int] = set()
    cancelled: list[int] = []

    async def _agent(**kw):
        me = len(running)
        running.add(me)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(me)
            raise

    monkeypatch.setattr(agent_runner, "run_agent", _agent)
    ctx = ToolContext(db=db, user=user, conversation_id=conversation.id, user_message_id=uuid.uuid4())
    task = asyncio.create_task(
        ra.RunAgentsTool().run(ctx, {"tasks": [{"task": "a"}, {"task": "b"}, {"task": "c"}]})
    )
    await _until(lambda: len(running) == 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert sorted(cancelled) == [0, 1, 2]


# ---------------------------------------------------------------- sticky context (R-045)


def _capture(sent: list):
    async def _stream(**kwargs):
        sent.append(kwargs)
        yield TextDelta(text="ok")
        yield FinishEvent(reason="stop")

    return _stream


def _parts(msg) -> list:
    return msg.content if isinstance(msg.content, list) else []


def _text_of(msg) -> str:
    if isinstance(msg.content, str):
        return msg.content
    return " ".join(getattr(p, "text", "") or "" for p in msg.content)


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path.resolve()


async def _file(db, user, uploads, name: str, data: bytes, mime: str):
    from app.files.models import UserFile

    (uploads / name).write_bytes(data)
    f = UserFile(user_id=user.id, filename=name, original_filename=name, mime_type=mime,
                 size_bytes=len(data), storage_path=name)
    db.add(f)
    await db.flush()
    return f


async def _thread(db, conversation, turns: list[tuple[str, str, list | None]]):
    """Insert a user/assistant chain; returns the messages. The last one is
    the user turn being answered."""
    from app.chat.models import Conversation, Message

    parent = None
    rows = []
    for role, content, attachments in turns:
        m = Message(conversation_id=conversation.id, role=role, content=content,
                    parent_id=parent, attachments=attachments)
        db.add(m)
        await db.flush()
        rows.append(m)
        parent = m.id
    (await db.get(Conversation, conversation.id)).active_leaf_message_id = parent
    await db.commit()
    return rows


def _png() -> bytes:
    import io

    from PIL import Image

    # Noise, so it's big enough to pass the "too small to be real" check.
    buf = io.BytesIO()
    Image.frombytes("RGB", (64, 64), os.urandom(64 * 64 * 3)).save(buf, "PNG")
    return buf.getvalue()


async def test_an_attached_document_is_still_there_on_the_next_turn(
    db, user, conversation, uploads, monkeypatch
):
    """'Summarise this contract', then 'what does clause 7 say?' — the
    second turn used to be answered without the document."""
    doc = await _file(db, user, uploads, "contract.txt",
                      b"Clause 7: either party may terminate with 30 days notice.", "text/plain")
    rows = await _thread(db, conversation, [
        ("user", "Summarise this contract", [{"id": str(doc.id), "filename": "contract.txt"}]),
        ("assistant", "It's a services contract.", None),
        ("user", "What does clause 7 say?", None),
    ])
    sent: list = []
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture(sent))

    assert "30 days notice" in " ".join(_text_of(m) for m in sent[0]["messages"])


async def test_a_turn_with_attachments_gets_them_indexed_for_later(
    db, user, conversation, uploads, monkeypatch
):
    from app.chat import attachment_rag

    doc = await _file(db, user, uploads, "notes.txt", b"Some notes.", "text/plain")
    rows = await _thread(db, conversation, [
        ("user", "Read this", [{"id": str(doc.id), "filename": "notes.txt"}]),
    ])
    indexed: list = []

    async def _index(conversation_id, file_ids):
        indexed.append((conversation_id, list(file_ids)))

    monkeypatch.setattr(attachment_rag, "index_turn_attachments", _index)
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture([]))
    await asyncio.sleep(0.1)

    assert indexed == [(conversation.id, [doc.id])]


async def test_a_saved_image_caption_is_reused_on_later_turns(
    db, user, conversation, uploads, monkeypatch
):
    """A non-vision model saw an earlier picture only through the relay's
    caption, and only on that one turn."""
    img = await _file(db, user, uploads, "bike.png", _png(), "image/png")
    rows = await _thread(db, conversation, [
        ("user", "What is this?", [{"id": str(img.id), "filename": "bike.png",
                                    "caption": "A red bicycle leaning on a fence."}]),
        ("assistant", "A bicycle.", None),
        ("user", "What colour was it?", None),
    ])
    sent: list = []
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture(sent))

    assert "A red bicycle leaning on a fence." in " ".join(_text_of(m) for m in sent[0]["messages"])


async def _vision(db, conversation):
    from app.models_config.models import ModelProvider

    p = await db.get(ModelProvider, conversation.provider_id)
    p.models = [{"id": "test-model", "name": "Test", "supports_vision": True}]
    await db.commit()


async def test_images_are_never_sent_inside_assistant_messages(
    db, user, conversation, uploads, monkeypatch
):
    """A generated image or chart on an assistant turn was replayed as an
    image part, which OpenAI and Anthropic reject (R-046)."""
    await _vision(db, conversation)
    chart = await _file(db, user, uploads, "chart.png", _png(), "image/png")
    rows = await _thread(db, conversation, [
        ("user", "Plot it", None),
        ("assistant", "Here's the chart.", [{"id": str(chart.id), "filename": "chart.png"}]),
        ("user", "Thanks — now explain it", None),
    ])
    sent: list = []
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture(sent))

    for m in sent[0]["messages"]:
        if m.role == "assistant":
            assert not any(type(p).__name__ == "ImagePart" for p in _parts(m))
    assert "chart.png" in " ".join(_text_of(m) for m in sent[0]["messages"] if m.role == "assistant")


async def test_old_images_are_not_resent_on_every_turn(db, user, conversation, uploads, monkeypatch):
    await _vision(db, conversation)
    turns = []
    for i in range(5):
        f = await _file(db, user, uploads, f"p{i}.png", _png(), "image/png")
        turns += [("user", f"photo {i}", [{"id": str(f.id), "filename": f"p{i}.png"}]),
                  ("assistant", f"seen {i}", None)]
    rows = await _thread(db, conversation, turns + [("user", "compare them all", None)])
    sent: list = []
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture(sent))

    images = sum(1 for m in sent[0]["messages"] for p in _parts(m) if type(p).__name__ == "ImagePart")
    assert images == 3


async def test_a_chat_mentioned_earlier_still_applies(db, user, conversation, monkeypatch):
    from app.chat import router as chat_router

    other = uuid.uuid4()
    rows = await _thread(db, conversation, [
        ("user", f"Using @[Pricing call]({other}) as background, draft an email", None),
        ("assistant", "Here's a draft.", None),
        ("user", "Make it shorter", None),
    ])
    asked: list = []

    async def _resolve(mentions, **kw):
        asked.extend(m.conversation_id for m in mentions)
        return []

    monkeypatch.setattr(chat_router, "resolve_mentions", _resolve)
    await _drive(monkeypatch, user, await _enqueue(conversation, rows[-1]), _capture([]))

    assert asked == [other]


@pytest.mark.parametrize("message,status,code", [
    ("Error code: 429 - insufficient_quota: You exceeded your current quota", 429, "out_of_credits"),
    ("402 Payment Required", 402, "out_of_credits"),
    ("The model `gpt-4-0314` has been deprecated", 404, "model_unavailable"),
    ("This model's maximum context length is 128000 tokens", 400, "context_overflow"),
    ("prompt is too long: 210000 tokens > 200000 maximum", 400, "context_overflow"),
    ("Rate limit reached for requests", 429, "rate_limited"),
])
def test_provider_errors_are_explained(message, status, code):
    """An exhausted quota used to show a retry countdown that could never
    succeed, and other failures showed raw provider text (R-301)."""
    from app.chat.router import _classify_upstream_error

    assert _classify_upstream_error(message, provider_type="openai", status_code=status)["error_code"] == code
