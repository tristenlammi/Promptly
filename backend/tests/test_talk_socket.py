"""The Talk socket (WP-T2): who may connect, what's kept, and what isn't.

Signing in by bearer token, by app password (only with the ``assistant``
scope) and by a one-use ticket; someone else's chat looks like no chat
(4404); Talk switched off, or limited to groups, refuses; the live slots
fill; a dropped connection can be resumed by its owner only; a phone
conversation leaves nothing behind; nothing holds a database connection
between turns; and no words or audio reach the database or the logs.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import tempfile

import httpx
import pytest
from sqlalchemy import func, select

from .talk_fakes import Closed, Model, TalkClient, bearer
from .test_talk_turns import finish, messages, open_talk, sidecars, talk_app, use_model  # noqa: F401


@pytest.fixture
async def http(talk_app):  # noqa: F811
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=talk_app), base_url="http://test") as c:
        yield c


async def _app_password(http, user, scopes: list[str]) -> str:
    made = await http.post("/api/auth/app-passwords", json={"name": "Phone", "scopes": scopes}, headers=bearer(user))
    assert made.status_code in (200, 201), made.text
    token = base64.b64encode(f"{user.username}:{made.json()['password']}".encode()).decode()
    return f"Basic {token}"


async def _refused(app, **kw) -> tuple[int, dict]:
    c = TalkClient(app, **kw)
    try:
        await c.connect()
        await c.send({"type": "hello", "codec": "pcm16", "sample_rate": 16000, "device": "web"})
        code = await c.closed_with(timeout=10)
    except Closed as e:
        code = e.code
    errors = [e for e in c.events if e.get("type") == "error"]
    await c.drop()
    return code, (errors[0] if errors else {})


async def test_signed_out_and_wrong_scope_are_refused(db, user, sidecars, talk_app, http):  # noqa: F811
    code, err = await _refused(talk_app)
    assert code == 4401 and err["code"] == "not_signed_in"
    maps_only = await _app_password(http, user, ["maps"])
    code, _ = await _refused(talk_app, headers={"Authorization": maps_only})
    assert code in (4401, 4403)
    code, _ = await _refused(talk_app, headers={"Authorization": "Bearer not-a-token"})
    assert code == 4401


async def test_the_phone_signs_in_with_an_assistant_app_password(db, user, provider, sidecars, talk_app, http, monkeypatch):  # noqa: F811
    from app.chat.models import Conversation
    from app.talk.models import TalkMetric

    uid, hdr = user.id, bearer(user)
    user.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    use_model(monkeypatch, Model(["Ten minutes, starting now."]))
    auth = await _app_password(http, user, ["assistant"])
    c = TalkClient(talk_app, headers={"Authorization": auth})
    await c.connect()
    ready = await c.hello(device="android", codec="opus", play="pcm16", caps=["timer", "bogus"])
    assert ready["conversation_id"] is None  # nothing to open: it isn't kept
    live = await sidecars.live()
    assert live.query["codec"] == "opus"
    await live.say(1, "Set a timer for ten minutes")
    heard = await c.expect("heard")
    assert heard["message_id"] is None
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)

    # While it lasts, a hidden throwaway chat: never listed, never in memory.
    db.expire_all()
    conv = (await db.execute(select(Conversation).where(Conversation.user_id == uid))).scalar_one()
    assert conv.temporary_mode == "ephemeral" and conv.memory_capture_paused
    listed = await http.get("/api/chat/conversations", headers=hdr)
    assert all(row["id"] != str(conv.id) for row in listed.json())

    await finish(c)
    db.expire_all()
    assert (await db.scalar(select(func.count()).select_from(Conversation).where(Conversation.user_id == uid))) == 0
    metric = (await db.execute(select(TalkMetric))).scalar_one()
    assert metric.device == "android" and metric.conversation_id is None


async def test_a_ticket_signs_a_browser_in_once(db, user, conversation, sidecars, talk_app, http):  # noqa: F811
    r = await http.post("/api/talk/ticket", headers=bearer(user))
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert "promptly_talk=" in cookie and "HttpOnly" in cookie and "Path=/api/talk/ws" in cookie
    assert "samesite=strict" in cookie.lower()
    ticket = r.json()["ticket"]
    c = TalkClient(talk_app, query=f"conversation_id={conversation.id}", cookies={"promptly_talk": ticket})
    await c.connect()
    ready = await c.hello()
    assert ready["conversation_id"] == str(conversation.id)
    await finish(c)
    # Spent: the same ticket doesn't work twice, as a cookie or in the URL.
    code, _ = await _refused(talk_app, cookies={"promptly_talk": ticket})
    assert code == 4401
    code, _ = await _refused(talk_app, query=f"ticket={ticket}")
    assert code == 4401
    r2 = await http.post("/api/talk/ticket", headers=bearer(user))
    c = TalkClient(talk_app, query=f"ticket={r2.json()['ticket']}")
    await c.connect()
    await c.hello()
    await finish(c)


async def test_someone_elses_chat_looks_like_no_chat(db, user, conversation, sidecars, talk_app):  # noqa: F811
    from .test_mail import mk_user

    other = await mk_user(db, "other")
    code, err = await _refused(talk_app, query=f"conversation_id={conversation.id}", headers=bearer(other))
    assert code == 4404 and err["code"] == "not_found"
    code, _ = await _refused(talk_app, query="conversation_id=00000000-0000-0000-0000-000000000000", headers=bearer(user))
    assert code == 4404
    code, _ = await _refused(talk_app, query="conversation_id=nonsense", headers=bearer(user))
    assert code == 4404


async def test_talk_off_or_not_in_the_group_is_refused(db, user, conversation, sidecars, talk_app, http):  # noqa: F811
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.groups.models import UserGroup, UserGroupMember

    from .test_mail import mk_user

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.talk_enabled = False
    await db.commit()
    code, err = await _refused(talk_app, headers=bearer(user))
    assert code == 4403 and err["say"] == "Talk is turned off on this server."
    cfg = await http.get("/api/talk/config", headers=bearer(user))
    assert cfg.json()["enabled"] is False

    group = UserGroup(name="Talkers")
    db.add(group)
    await db.flush()
    member = await mk_user(db, "member")
    outsider = await mk_user(db, "outsider")
    db.add(UserGroupMember(group_id=group.id, user_id=member.id))
    row.talk_enabled = True
    row.talk_group_ids = [group.id]
    await db.commit()
    code, err = await _refused(talk_app, headers=bearer(outsider))
    assert code == 4403 and err["say"] == "Talk isn't turned on for your account."
    c = TalkClient(talk_app, headers=bearer(member))
    await c.connect()
    await c.send({"type": "hello", "codec": "pcm16", "sample_rate": 16000})
    # Signed in and allowed: it gets past the gate (no model set up for this
    # new user, so it says so rather than refusing them).
    code = await c.closed_with()
    assert code == 4503 and any(e.get("code") == "no_model" for e in c.events)
    await c.drop()


async def test_the_live_slots_fill(db, user, conversation, sidecars, talk_app):  # noqa: F811
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) or AppSettings(id=SINGLETON_APP_SETTINGS_ID)
    row.talk_live_slots = 1
    db.add(row)
    await db.commit()
    first = await open_talk(talk_app, user, conversation)
    code, err = await _refused(talk_app, query=f"conversation_id={conversation.id}", headers=bearer(user))
    assert code == 4429 and err["code"] == "busy"
    await finish(first)
    second = await open_talk(talk_app, user, conversation)
    await finish(second)


async def test_whisper_busy_or_missing_says_so(db, user, conversation, sidecars, talk_app):  # noqa: F811
    sidecars.refuse_live = {"type": "error", "code": 1013, "message": "Too many live sessions right now."}
    code, err = await _refused(talk_app, query=f"conversation_id={conversation.id}", headers=bearer(user))
    assert code == 4429 and "Too many people" in err["say"]
    sidecars.refuse_live = {"type": "error", "code": 4503, "message": "off"}
    code, err = await _refused(talk_app, query=f"conversation_id={conversation.id}", headers=bearer(user))
    assert code == 4503 and err["say"] == "Voice isn't available on this server right now."


async def test_a_dropped_connection_resumes_for_its_owner_only(db, user, provider, conversation, sidecars, talk_app, monkeypatch):  # noqa: F811
    from .test_mail import mk_user

    use_model(monkeypatch, Model(["Here you go."]))
    c = await open_talk(talk_app, user, conversation)
    session_id = next(e for e in c.events if e["type"] == "ready")["session_id"]
    await c.drop()

    other = await mk_user(db, "other")
    other.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    o = TalkClient(talk_app, query=f"resume={session_id}", headers=bearer(other))
    await o.connect()
    ready = await o.hello()
    assert ready["session_id"] != session_id and ready["resumed"] is False
    await finish(o)

    back = TalkClient(talk_app, query=f"resume={session_id}", headers=bearer(user))
    await back.connect()
    ready = await back.hello()
    assert ready["session_id"] == session_id and ready["resumed"] is True
    live = sidecars.lives[0]
    await live.say(1, "Is it still there?")
    await back.find("reply", done=True)
    await finish(back)


async def test_no_database_connection_is_held_between_turns(db, user, conversation, sidecars, talk_app, monkeypatch):  # noqa: F811
    from app.database import engine

    use_model(monkeypatch, Model(["Sure."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Hello there")
    await c.expect("state", state="listening", timeout=15)
    await asyncio.sleep(0.3)  # the generator's after-reply work (title, memory)
    await db.close()
    for _ in range(50):
        if engine.pool.checkedout() == 0:
            break
        await asyncio.sleep(0.1)
    assert engine.pool.checkedout() == 0
    await finish(c)


async def test_no_words_or_audio_in_the_database_or_logs(db, user, conversation, sidecars, talk_app, monkeypatch, caplog):  # noqa: F811
    from app.talk.models import TalkMetric

    secret_heard = "Remind me about the zebrafish quarterly"
    secret_said = "Okay, the xylophone appointment is noted."
    use_model(monkeypatch, Model([secret_said]))
    tmp_before = set(os.listdir(tempfile.gettempdir()))
    caplog.set_level(logging.DEBUG)
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    for _ in range(20):
        await c.mic(os.urandom(640))
    await live.say(1, secret_heard)
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    await finish(c)

    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "talk: session open" in logged  # the log was captured at all
    for word in ("zebrafish", "xylophone"):
        assert word not in logged
    # The timings row: numbers only.
    db.expire_all()
    metric = (await db.execute(select(TalkMetric))).scalar_one()
    for col in TalkMetric.__table__.columns:
        value = getattr(metric, col.key)
        assert not isinstance(value, (str, bytes)) or col.key in ("device", "transport"), col.key
    # The words live only in the chat, as chat messages; the audio nowhere.
    rows = await messages(db, conversation)
    assert rows[0].content == secret_heard and rows[1].content == secret_said
    assert set(os.listdir(tempfile.gettempdir())) - tmp_before == set() or all(
        not n.endswith((".wav", ".pcm", ".opus", ".webm")) for n in set(os.listdir(tempfile.gettempdir())) - tmp_before
    )
    upload_root = os.environ.get("PROMPTLY_UPLOAD_ROOT")
    if upload_root and os.path.isdir(upload_root):
        for dirpath, _dirs, files in os.walk(upload_root):
            assert not files, dirpath


async def test_config_says_what_the_client_needs(db, user, http):
    user.settings = {"tts_voice": "bm_george", "tts_speed": 5, "talk_save": "temporary", "talk_interrupt": "tap"}
    await db.commit()
    r = await http.get("/api/talk/config", headers=bearer(user))
    body = r.json()
    assert r.status_code == 200 and body["enabled"] is True and body["protocol"] == 1
    assert body["prefs"] == {"voice": "bm_george", "speed": 1.3, "save": "temporary", "turn_mode": "hands_free", "interrupt": "tap", "captions": True}
    assert body["limits"]["live_slots"] == 2
    assert (await http.get("/api/talk/config")).status_code in (401, 403)


async def test_a_new_web_conversation_follows_the_temporary_setting(db, user, provider, sidecars, talk_app, monkeypatch):  # noqa: F811
    from app.chat.models import Conversation

    uid = user.id
    user.settings = {"talk_save": "temporary", "default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    use_model(monkeypatch, Model(["Hi."]))
    c = TalkClient(talk_app, headers=bearer(user))
    await c.connect()
    ready = await c.hello()
    conv_id = ready["conversation_id"]
    assert conv_id
    live = await sidecars.live()
    await live.say(1, "Hello")
    await c.expect("state", state="listening", timeout=15)
    await finish(c)
    db.expire_all()
    conv = (await db.execute(select(Conversation).where(Conversation.user_id == uid))).scalar_one()
    assert str(conv.id) == conv_id and conv.temporary_mode == "one_hour" and conv.expires_at is not None
    assert conv.title == "Hello"


async def test_ping_is_answered_at_once_and_a_picked_voice_speaks_next(db, user, conversation, sidecars, talk_app, monkeypatch):  # noqa: F811
    """WP-T4: the web times the connection with ``ping``, and a voice picked
    on the Talk screen is used from the next thing it says."""
    use_model(monkeypatch, Model(["First answer.", "Second answer."]))
    c = await open_talk(talk_app, user, conversation)
    await c.send({"type": "ping", "t": 12345})
    pong = await c.find("pong")
    assert pong["t"] == 12345
    live = await sidecars.live()
    await live.say(1, "Hello there")
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    assert sidecars.tts_bodies[-1].get("voice") != "bm_george"

    await c.send({"type": "prefs", "voice": "bm_george", "speed": 9})
    await c.send({"type": "prefs", "voice": "not a voice!"})  # ignored
    await live.say(2, "And again")
    await c.expect("reply", done=True, timeout=15)
    await c.expect("state", state="listening", timeout=15)
    assert sidecars.tts_bodies[-1]["voice"] == "bm_george"
    assert sidecars.tts_bodies[-1]["speed"] == 1.3
    await finish(c)


async def test_account_voice_saves_the_talk_settings(db, user, http):
    r = await http.patch(
        "/api/auth/me/preferences",
        json={"tts_speed": 1.1, "talk_turn_mode": "tap", "talk_interrupt": "tap", "talk_captions": False, "talk_save": "temporary"},
        headers=bearer(user),
    )
    assert r.status_code == 200, r.text
    body = (await http.get("/api/talk/config", headers=bearer(user))).json()
    assert body["prefs"] == {"voice": None, "speed": 1.1, "save": "temporary", "turn_mode": "tap", "interrupt": "tap", "captions": False}
    bad = await http.patch("/api/auth/me/preferences", json={"tts_speed": 3}, headers=bearer(user))
    assert bad.status_code == 422
