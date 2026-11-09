"""Talk turns end to end (WP-T2): the socket, the chat pipeline and a scripted
speech-sidecar pair (``talk_fakes.py``), run in one loop against the test DB.

What's checked: a turn walks the latency path in order (heard, thinking,
first words, first audio, speaking, listening), the reply lands in the chat
marked spoken; talking over it stops it and the saved reply is cut back to
what was heard; its own echo and backchannels don't stop it; a turn that
carries on after a pause joins the first instead of getting two answers; a
cough while it's thinking doesn't cost the answer.
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from .talk_fakes import FakeSidecars, Model, TalkClient, bearer

LONG = (
    "You've got three things today, the dentist at nine, Sam's call at two, and the bins go out tonight. "
    "The dentist is on Harbour Street, so leave by half past eight. "
    "Sam wanted to go over the garden budget before the call. "
    "Tomorrow looks quieter, with only the school pickup at three. "
    "On Thursday there's the plumber between eight and ten, and your sister's birthday dinner at seven. "
    "Friday is clear, apart from the library books, which are due back by five."
)


@pytest.fixture
async def sidecars(monkeypatch):
    from app.config import get_settings

    fakes = await FakeSidecars().start()
    monkeypatch.setattr(get_settings(), "WHISPER_URL", fakes.whisper_url)
    monkeypatch.setattr(get_settings(), "TTS_URL", fakes.tts_url)
    try:
        yield fakes
    finally:
        await fakes.stop()


@pytest.fixture
def talk_app():
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        yield app
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def use_model(monkeypatch, model: Model) -> Model:
    from app.chat import router as chat_router

    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", model, raising=True)
    return model


async def open_talk(app, user, conversation=None, **hello) -> TalkClient:
    q = f"conversation_id={conversation.id}" if conversation is not None else ""
    c = TalkClient(app, query=q, headers=bearer(user))
    await c.connect()
    await c.hello(**hello)
    await c.expect("state", state="listening")
    return c


def ident(row):
    """A row's id without loading it (it may have been expired)."""
    from sqlalchemy import inspect

    return inspect(row).identity[0]


async def messages(db, conversation):
    from app.chat.models import Message

    conversation_id = ident(conversation)
    db.expire_all()
    rows = (
        await db.execute(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at))
    ).scalars().all()
    return rows


async def finish(c: TalkClient) -> None:
    await c.send({"type": "bye"})
    try:
        await c.closed_with(timeout=10)
    except asyncio.TimeoutError:
        pass
    await c.drop()


async def test_a_turn_walks_the_latency_path_in_order(db, user, conversation, sidecars, talk_app, monkeypatch):
    from app.talk.models import TalkMetric

    model = use_model(monkeypatch, Model(["You've got three things today, the dentist at nine. Want the rest?"]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    assert live.query["codec"] == "pcm16"

    # The microphone goes straight through to Whisper, header off.
    for i in range(5):
        await c.mic(bytes([i]) * 640)
    for _ in range(100):
        if live.frames == 5:
            break
        await asyncio.sleep(0.01)
    assert live.frames == 5 and bytes(live.audio) == b"".join(bytes([i]) * 640 for i in range(5))

    await live.say(1, "What's on today?")
    heard = await c.expect("heard")
    assert heard["text"] == "What's on today?" and heard["message_id"]
    await c.until_audio()
    await c.expect("state", state="speaking")
    done = await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    kinds = c.kinds()
    order = [kinds.index(k) for k in ("state:thinking", "audio", "state:speaking")]
    assert order == sorted(order), kinds
    assert kinds.index("state:listening", order[-1]) > order[-1]
    assert "partial" in kinds

    # Short first piece, then the rest, each spoken by Kokoro in turn.
    assert sidecars.spoken[0] == "You've got three things today,"
    assert sidecars.spoken[1:] == ["the dentist at nine.", "Want the rest?"]
    assert sidecars.tts_bodies[0]["format"] == "pcm" and sidecars.tts_bodies[0]["first_clause"] is False
    # Every frame carries a sequence number and is 20 ms of 24 kHz PCM16.
    seqs = [int.from_bytes(a[:4], "big") for a in c.audio]
    assert seqs == list(range(len(seqs))) and all(len(a) == 4 + 960 for a in c.audio)

    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[0].voice["spoken"] is True and rows[0].content == "What's on today?"
    assert rows[1].content == "You've got three things today, the dentist at nine. Want the rest?"
    assert rows[1].voice == {"spoken": True, "interrupted": False}
    assert done["message_id"] == str(rows[1].id)
    assert model.calls and "What's on today?" in model.last_user_text()

    metric = (await db.execute(select(TalkMetric))).scalar_one()
    assert metric.device == "web" and metric.transport == "ws" and metric.conversation_id == ident(conversation)
    assert metric.endpoint_ms == 280 and metric.first_audio_ms is not None and metric.ttft_ms is not None
    assert metric.barge_ins == 0
    await finish(c)


async def test_talking_over_it_stops_it_and_keeps_what_was_heard(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([LONG, "Friday's clear."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.until_audio()
    await c.drain(0.9)  # about the first clause and a bit
    assert "stop_audio" not in c.kinds()

    await live.emit({"type": "speech_start", "turn": 2, "at_ms": 5000})
    await live.emit({"type": "partial", "turn": 2, "text": "Wait, what about", "stable": ""})
    stop = await c.expect("stop_audio", timeout=3)
    assert stop
    frames_at_stop = len(c.audio)
    await live.emit({"type": "turn_end", "turn": 2, "reason": "complete", "speech_end_ms": 6000, "at_ms": 6280})
    await live.emit({"type": "final", "turn": 2, "text": "Wait, what about Friday?"})
    heard = await c.expect("heard")
    assert heard["text"] == "Wait, what about Friday?"
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)

    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant", "user", "assistant"]
    cut = rows[1]
    assert cut.voice["interrupted"] is True
    assert LONG.startswith(cut.content) and 0 < len(cut.content) < len(LONG) - 40, cut.content
    assert cut.voice["heard_chars"] == len(cut.content)
    assert "Stopped" not in cut.content
    assert rows[2].parent_id == cut.id and rows[3].content == "Friday's clear."
    # Speech stopped: nothing more of the first answer went out, and Kokoro
    # wasn't asked for the sentences nobody would hear.
    assert "Friday is clear, apart from the library books, which are due back by five." not in sidecars.spoken
    assert frames_at_stop < sum(len(t.split()) for t in sidecars.spoken[:2]) * 2 + 40
    await finish(c)


async def test_its_own_echo_and_backchannels_dont_stop_it(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model(["You've got three things today, the dentist at nine, Sam's call at two."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.until_audio()
    await c.drain(0.2)
    # Its own voice back through the microphone, slightly misheard.
    await live.emit({"type": "speech_start", "turn": 2})
    await live.emit({"type": "partial", "turn": 2, "text": "you've got three things to day", "stable": ""})
    await live.emit({"type": "final", "turn": 2, "text": "You've got three things to day."})
    # And a backchannel.
    await live.emit({"type": "speech_start", "turn": 3})
    await live.emit({"type": "partial", "turn": 3, "text": "mm yeah", "stable": ""})
    await live.emit({"type": "final", "turn": 3, "text": "Mm, yeah."})
    await c.expect("state", state="listening", timeout=15)
    assert "stop_audio" not in c.kinds()
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[1].voice == {"spoken": True, "interrupted": False}
    await finish(c)


async def test_a_stop_word_stops_it_without_a_new_turn(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([LONG]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.until_audio()
    await live.emit({"type": "speech_start", "turn": 2})
    await live.emit({"type": "partial", "turn": 2, "text": "stop", "stable": ""})
    await c.expect("stop_audio", timeout=3)
    await live.emit({"type": "final", "turn": 2, "text": "Stop."})
    await c.drain(0.3)
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[1].voice["interrupted"] is True
    await finish(c)


async def test_tap_to_interrupt_uses_what_the_client_played(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([LONG]))
    c = await open_talk(talk_app, user, conversation, interrupt_mode="tap")
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.until_audio()
    # Talking doesn't stop it in this mode...
    await live.emit({"type": "speech_start", "turn": 2})
    await live.emit({"type": "partial", "turn": 2, "text": "what about friday then", "stable": ""})
    await c.drain(0.3)
    assert "stop_audio" not in c.kinds()
    # ...the Stop button does, and the client says how much it played.
    # "You've got three things today," is 200 ms of speech + a 90 ms pause
    # (padded to 100 ms); 20 ms into the next piece is no whole word of it.
    first_clause_ms = 320
    await c.send({"type": "interrupt", "played_ms": first_clause_ms})
    await c.expect("stop_audio", timeout=3)
    await c.drain(0.2)
    rows = await messages(db, conversation)
    assert rows[1].content == "You've got three things today,"
    assert rows[1].voice == {"spoken": True, "interrupted": True, "heard_chars": len("You've got three things today,")}
    await finish(c)


async def test_carrying_on_after_a_pause_joins_the_turn(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Added for Thursday morning."], ttft=0.6))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist to my calendar on Thursday", partials=False)
    await c.expect("heard")
    # The answer has started (speculatively) but nothing has played: they carry on.
    await asyncio.sleep(0.1)
    await live.emit({"type": "speech_start", "turn": 2})
    await live.emit({"type": "partial", "turn": 2, "text": "morning", "stable": ""})
    await live.emit({"type": "turn_end", "turn": 2, "reason": "complete", "speech_end_ms": 3000, "at_ms": 3280})
    await live.emit({"type": "final", "turn": 2, "text": "morning."})
    heard = await c.expect("heard")
    assert heard["text"] == "Add the dentist to my calendar on Thursday morning."
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)

    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"], [(r.role, r.content) for r in rows]
    assert rows[0].content == "Add the dentist to my calendar on Thursday morning."
    assert rows[0].voice["joined"] is True
    assert rows[1].content == "Added for Thursday morning." and rows[1].parent_id == rows[0].id
    # One answer: the first start was dropped unheard (cancelled, or on a
    # busy box dropped before it reached the model), the second had it all.
    assert len(model.calls) - model.cancelled == 1 and len(model.calls) <= 2
    assert "Thursday morning" in model.last_user_text()
    assert sidecars.spoken == ["Added for Thursday morning."]
    await finish(c)


async def test_a_cough_while_it_thinks_doesnt_cost_the_answer(db, user, conversation, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["It's sunny."], ttft=0.3))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's the weather like?")
    await c.expect("heard")
    await live.emit({"type": "speech_start", "turn": 2})
    await asyncio.sleep(0.5)  # the answer is ready, and held
    assert "audio" not in c.kinds()
    await live.emit({"type": "dropped", "turn": 2, "reason": "too_short", "speech_ms": 120})
    await c.until_audio(timeout=5)
    await c.expect("state", state="listening", timeout=10)
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"] and rows[1].content == "It's sunny."
    assert len(model.calls) == 1
    await finish(c)


async def test_typing_instead_and_saying_goodbye(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model(["Sure."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await c.send({"type": "text", "words": "Remind me about the bins"})
    heard = await c.expect("heard")
    assert heard["text"] == "Remind me about the bins"
    await c.expect("state", state="listening", timeout=10)
    await live.say(2, "That's all, thanks.")
    assert await c.closed_with() == 1000
    bye = [e for e in c.events if e["type"] == "bye"]
    assert bye and bye[0]["reason"] == "goodbye"
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"]
    assert rows[0].voice is None  # typed, not spoken
    assert rows[1].voice == {"spoken": True, "interrupted": False}
    await c.drop()


async def test_mute_stops_listening(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model(["Hi."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await c.send({"type": "mute"})
    await c.expect("state", state="muted")
    before = live.frames
    await c.mic(b"\x01" * 640)
    await asyncio.sleep(0.1)
    assert live.frames == before and "reset" in live.commands
    await c.send({"type": "unmute"})
    await c.expect("state", state="listening")
    await c.send({"type": "end_turn"})
    for _ in range(50):
        if "flush" in live.commands:
            break
        await asyncio.sleep(0.01)
    assert "flush" in live.commands
    await finish(c)
