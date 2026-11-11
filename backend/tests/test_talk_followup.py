"""'Sent to your phone' (Talk phase 2, WP-T11).

What's checked: "send that to my phone" makes one push (and inbox row) with
the fixed title, the thing's own headline and its own link; the model can't
supply a link; with the switch off nothing is sent; quiet hours don't hold it
and it isn't a daily-summary category; at most three a conversation; in the
car, an answer that was cut to a gist sends the thing itself, saying so once.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from app.chat.tools import talk_phone
from app.talk import followup

from .talk_fakes import Model
from .test_talk_turns import finish, open_talk, sidecars, talk_app, use_model  # noqa: F401


def found_by(monkeypatch, tool: str, meta: dict) -> None:
    from app.chat.tools.base import ToolResult
    from app.chat.tools.registry import get_tool

    async def run(self, ctx, args):
        return ToolResult(content="The school says Friday's sports carnival starts at nine.", meta=meta)

    monkeypatch.setattr(type(get_tool(tool)), "run", run)


async def rows(db, user_id):
    from app.notifications.models import Notification

    for _ in range(50):
        db.expire_all()
        got = (await db.execute(select(Notification).where(Notification.user_id == user_id, Notification.category == "talk_followup"))).scalars().all()
        if got:
            return got
        await asyncio.sleep(0.05)
    return []


async def test_send_that_to_my_phone(db, user, conversation, sidecars, talk_app, monkeypatch):
    uid = user.id
    found_by(monkeypatch, "read_note", {"url": "/notes/n/abc", "title": "School notice"})
    model = use_model(
        monkeypatch,
        Model([
            {"tool": "read_note", "args": {"note": "school"}},
            "Friday's carnival starts at nine.",
            {"tool": "send_to_phone", "args": {"item": 1, "url": "https://evil.example/login"}},
            "Unused.",
        ]),
    )
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What does the school note say?")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    assert "send_to_phone" not in model.tools_offered(0)
    await live.say(2, "Send that to my phone.")
    await c.expect("state", state="thinking", timeout=10)
    await c.expect("state", state="listening", timeout=15)
    assert "send_to_phone" in model.tools_offered()
    assert "1. School notice" in model.system() or "1. School notice" in str(model.calls[-1])
    assert talk_phone.FIRST in " ".join(sidecars.spoken)
    sent = await rows(db, uid)
    assert len(sent) == 1
    assert sent[0].title == "From Talk" and sent[0].body == "School notice" and sent[0].url == "/notes/n/abc"
    await finish(c)


async def test_with_the_switch_off_nothing_is_sent(db, user, conversation, sidecars, talk_app, monkeypatch):
    from app.notifications.models import PushPreferences

    uid = user.id
    db.add(PushPreferences(user_id=uid, talk_followup=False))
    await db.commit()
    found_by(monkeypatch, "read_note", {"url": "/notes/n/abc", "title": "School notice"})
    use_model(monkeypatch, Model([{"tool": "read_note", "args": {"note": "school"}}, "It starts at nine.", {"tool": "send_to_phone", "args": {"item": 1}}, "Unused."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What does the school note say?")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    await live.say(2, "Send it to my phone.")
    await c.expect("state", state="thinking", timeout=10)
    await c.expect("state", state="listening", timeout=15)
    assert talk_phone.TURNED_OFF in " ".join(sidecars.spoken)
    await asyncio.sleep(0.3)
    assert await rows(db, uid) == []
    await finish(c)


async def test_in_the_car_a_cut_answer_goes_to_the_phone(db, user, provider, sidecars, talk_app, monkeypatch):
    uid = user.id
    user.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    found_by(monkeypatch, "read_note", {"url": "/notes/n/abc", "title": "School notice"})
    use_model(
        monkeypatch,
        Model([{"tool": "read_note", "args": {"note": "school"}}, "The carnival starts at nine.", {"tool": "read_note", "args": {"note": "school"}}, "Still nine."]),
    )
    c = await open_talk(talk_app, user, device="car", caps=["navigate"])
    live = await sidecars.live()
    await live.say(1, "What does the school note say?")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    spoken = sidecars.spoken
    assert followup.SAID_FIRST in spoken and spoken.index(followup.SAID_FIRST) > spoken.index("The carnival starts at nine.")
    sent = await rows(db, uid)
    assert len(sent) == 1 and sent[0].url == "/notes/n/abc"
    # The second time it's sent without saying so again.
    await live.say(2, "And the other one?")
    await c.find("reply", done=True, timeout=10)
    await c.expect("state", state="listening", timeout=15)
    assert spoken.count(followup.SAID_FIRST) == 1 and "Still nine." in spoken
    for _ in range(50):
        if len(await rows(db, uid)) == 2:
            break
        await asyncio.sleep(0.05)
    assert len(await rows(db, uid)) == 2
    await finish(c)


class _Ctx:
    def __init__(self, db, user, talk):
        self.db, self.user, self.turn = db, user, {"talk": talk}


async def test_at_most_three_and_only_its_own_links(db, user):
    tool = talk_phone.SendToPhoneTool()
    links = [{"title": "School notice", "url": "/notes/n/abc"}]
    done = await tool.run(_Ctx(db, user, {"links": links, "sent": 3}), {"item": 1})
    assert done.content == talk_phone.ENOUGH
    nothing = await tool.run(_Ctx(db, user, {"links": [{"title": "Bank", "url": "https://evil.example"}], "sent": 0}), {"item": 1})
    assert nothing.content == talk_phone.NOTHING


def test_links_come_only_from_tools_and_stay_inside_promptly():
    assert talk_phone.safe_link("/mail?open=a/b") == "/mail?open=a/b"
    for bad in ("https://evil.example", "//evil.example/x", "javascript:alert(1)", "/x\\y", None, 3):
        assert talk_phone.safe_link(bad) is None
    assert followup.link_of("web_search", {"url": "https://evil.example", "summary": "Win"}) is None
    place = followup.link_of("maps_search", {"map_card": {"kind": "places", "places": [{"name": "Chemist", "lat": -27.1, "lon": 153.2}]}})
    assert place == {"title": "Chemist (in P Maps)", "url": "/maps?to=-27.10000,153.20000,Chemist"}
    assert followup.link_of("mail_read", {"url": "/mail?open=a/b", "summary": "Read Friday sports"})["title"] == "Email: Friday sports"


def test_quiet_hours_dont_hold_it():
    from app.notifications.dispatch import CATEGORIES, SUMMARY_CATEGORIES, rule_for

    assert "talk_followup" in CATEGORIES
    assert rule_for("talk_followup").holdable is False
    assert "talk_followup" not in SUMMARY_CATEGORIES


@pytest.mark.parametrize("sent,said", [(0, followup.SAID_FIRST), (1, ""), (3, None)])
async def test_auto_send_says_so_once(db, user, sent, said, monkeypatch):
    calls = []

    async def send(user_id, title, url):
        calls.append(url)

    monkeypatch.setattr(talk_phone, "send", send)
    assert await followup.auto_send(user.id, {"title": "x", "url": "/notes/n/" + uuid.uuid4().hex}, sent) == said
    assert len(calls) == (0 if said is None else 1)
