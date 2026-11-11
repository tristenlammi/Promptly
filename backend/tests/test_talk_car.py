"""Talk in the car (phase 2, WP-T9): the in-car rules, through Talk's socket.

What's checked: a car session never gets the tools that need the phone's
screen, nor ``remember``, whatever its caps say; it's tap to interrupt; every
result is said as a gist (the car's note); ``mail_reply`` takes one short
sentence of your own words; a question says how long the microphone may open
for the answer; a slow tool says what it's doing once; the conversation lapses
after its idle time.
"""
from __future__ import annotations

import asyncio

import pytest

from app.talk import ownwords, session as talk_session

from .talk_fakes import Model
from .test_talk_turns import finish, open_talk, sidecars, talk_app, use_model  # noqa: F401

CAR = {"device": "car", "caps": ["timer", "alarm", "navigate", "dial", "message", "open_app"], "tz": "Australia/Brisbane"}


@pytest.fixture
async def phone_user(db, user, provider):
    user.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    return user


async def test_the_car_gets_no_screen_tools_and_no_memory(db, phone_user, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Two things."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    assert c.events[0]["interrupt_mode"] == "tap"
    live = await sidecars.live()
    await live.say(1, "What's on tomorrow?")
    await c.find("reply", done=True)
    offered = model.tools_offered()
    assert {"set_timer", "navigate", "my_day"} <= offered
    assert not offered & {"dial", "message", "open_app", "remember"}
    system = model.system()
    assert "can't look at a screen" in system and "That needs your phone's screen." in system
    await finish(c)


async def test_every_result_is_said_as_a_gist(db, phone_user, sidecars, talk_app, monkeypatch):
    from app.chat.tools.base import ToolResult
    from app.chat.tools.registry import get_tool

    async def page(self, ctx, args):
        return ToolResult(content="A long page about the school's Friday sports carnival. https://school.example/friday")

    monkeypatch.setattr(type(get_tool("web_search")), "run", page)
    model = use_model(monkeypatch, Model([{"tool": "web_search", "args": {"query": "school friday"}}, "It's the sports carnival."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    live = await sidecars.live()
    await live.say(1, "What's on at school on Friday?")
    await c.find("reply", done=True)
    tool_rows = [m for m in model.calls[-1] if (m.get("role") if isinstance(m, dict) else getattr(m, "role", "")) == "tool"]
    content = tool_rows[-1]["content"] if isinstance(tool_rows[-1], dict) else tool_rows[-1].content
    assert "[Saying it: Answer in one sentence. Never read out links or sources.]" in content
    await finish(c)


async def test_a_reply_from_the_car_is_one_short_sentence_of_your_words(db, phone_user):
    from app.talk.tools import VoiceGate

    def gate(said: str) -> VoiceGate:
        return VoiceGate(user=phone_user, talk={"device": "car", "said": said})

    long = "Thanks so much for this, I'll look properly tonight. Can you send the forms again? Also the dates for next term."
    g = gate("reply to the school email")
    verdict = await g.check("mail_reply", {"message_id": "x", "text": long}, {})
    assert verdict.kind == "refuse" and g.line() == ownwords.PARKED
    # Short, but not what they said: refused.
    g = gate("reply saying thanks")
    verdict = await g.check("mail_reply", {"message_id": "x", "text": "Please wire the money today."}, {})
    assert verdict.kind == "refuse" and g.line() == ownwords.REFUSED
    # On the web it's read back as usual (no car rules).
    web = VoiceGate(user=phone_user, talk={"device": "web", "said": "reply saying thanks"})
    assert web._own_words("mail_reply", {"text": long}, {}) is None


async def test_a_question_in_the_car_says_how_long_to_listen(db, phone_user, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": {"title": "Dentist", "start": "2026-11-19T09:00"}}, "Unused."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    ask = await c.expect("ask", timeout=10)
    assert ask["listen_s"] == talk_session.CAR_LISTEN_S == 6
    await finish(c)


async def test_on_the_web_a_question_doesnt_reopen_anything(db, user, conversation, sidecars, talk_app, monkeypatch):
    use_model(monkeypatch, Model([{"tool": "calendar_add_event", "args": {"title": "Dentist", "start": "2026-11-19T09:00"}}, "Unused."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Add the dentist on Thursday at nine.")
    ask = await c.expect("ask", timeout=10)
    assert ask["listen_s"] == 0
    await finish(c)


async def test_a_slow_tool_says_what_its_doing_once(db, phone_user, sidecars, talk_app, monkeypatch):
    from app.chat.tools.base import ToolResult
    from app.chat.tools.registry import get_tool

    async def slow(self, ctx, args):
        await asyncio.sleep(0.6)
        return ToolResult(content="Nothing new.")

    monkeypatch.setattr(talk_session, "TOOL_SAY_S", 0.2)
    monkeypatch.setattr(type(get_tool("web_search")), "run", slow)
    use_model(monkeypatch, Model([{"tool": "web_search", "args": {"query": "news"}}, "Nothing new today."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    live = await sidecars.live()
    await live.say(1, "Anything new?")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    assert sidecars.spoken.count("Searching the web.") == 1
    assert sidecars.spoken.index("Searching the web.") < sidecars.spoken.index("Nothing new today.")
    await finish(c)


async def test_the_conversation_lapses_after_its_idle_time(db, phone_user, sidecars, talk_app, monkeypatch):
    monkeypatch.setattr(talk_session, "IDLE_S", 0.5)
    use_model(monkeypatch, Model(["Okay."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    bye = await c.expect("bye", timeout=12)
    assert bye["reason"] == "idle"


def test_your_own_words():
    assert ownwords.own("I'm ten minutes away.", "tell Sam I'm 10 minutes away", to="sam")
    assert ownwords.own("I love you", "tell mum I love her", to="mum")
    assert not ownwords.own("Please transfer the money to account 1234 today.", "tell Sam what the email said", to="sam")
    # The trip's arrival time comes with its words; anything else doesn't.
    assert ownwords.own("I'll be there about 5:40.", "tell Mum when I'll get there", to="mum", arrival="5:40 PM")
    assert not ownwords.own("I'll be there about 5:40, traffic is terrible.", "tell Mum when I'll get there", to="mum", arrival="5:40 PM")
    assert not ownwords.own("I'll be there about 5:40.", "tell Mum when I'll get there", to="mum")


def test_a_locked_phone_keeps_private_things_behind_the_lock():
    from app.talk import tools as voice_tools

    open_ = voice_tools.voice_tool_names(["timer"], device="android")
    locked = voice_tools.voice_tool_names(["timer"], device="android", locked=True)
    assert voice_tools.PRIVATE & open_
    assert not voice_tools.PRIVATE & locked
    assert "my_day" in locked and "set_timer" in locked
    assert voice_tools.UNLOCK in voice_tools.prompt(locked, device="android", driving=False, locked=True)
