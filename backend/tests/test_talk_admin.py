"""Admin -> Talk (WP-T6): the switch, groups, live slots, the speech models,
the speed numbers (timings only, never words), and keeping them 30 days.
Also the Talk header's "Answers come from ..." note."""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from .talk_fakes import Model, bearer
from .test_talk_turns import LONG, finish, open_talk, sidecars, talk_app, use_model  # noqa: F401


@pytest.fixture
async def http(talk_app):  # noqa: F811
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=talk_app), base_url="http://test") as c:
        yield c


async def _member(db, name: str, role: str = "user"):
    from .test_mail import mk_user

    return await mk_user(db, name, role)


def _metric(user_id, *, device="web", days_ago=0.0, **ms):
    from app.talk.models import TalkMetric

    return TalkMetric(
        user_id=user_id,
        session_id=uuid.uuid4(),
        device=device,
        transport="ws",
        created_at=datetime.now(timezone.utc) - timedelta(days=days_ago),
        **ms,
    )


async def test_only_an_admin_can_see_or_change_talk(db, user, http):
    someone = await _member(db, "plain")
    for method, path in (("GET", "/api/admin/talk"), ("PATCH", "/api/admin/talk"), ("GET", "/api/admin/talk/usage")):
        r = await http.request(method, path, json={} if method == "PATCH" else None, headers=bearer(someone))
        assert r.status_code == 403, (method, path, r.status_code)
        assert (await http.request(method, path, json={} if method == "PATCH" else None)).status_code in (401, 403)


async def test_switching_talk_off_and_limiting_it_to_groups(db, user, http):
    from app.auth.events import AuthEvent
    from app.groups.models import UserGroup, UserGroupMember

    admin = bearer(user)
    got = await http.get("/api/admin/talk", headers=admin)
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["enabled"] is True and body["group_ids"] == [] and body["live_slots"] == 2
    assert body["talking_now"] == 0 and body["max_live_slots"] == 20

    member = await _member(db, "talker")
    outsider = await _member(db, "quiet")
    group = UserGroup(name="Talkers")
    db.add(group)
    await db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=member.id))
    await db.commit()

    async def can_talk(who) -> bool:
        r = await http.get("/api/talk/config", headers=bearer(who))
        assert r.status_code == 200, r.text
        return r.json()["enabled"]

    # Off for everyone, admins included.
    r = await http.patch("/api/admin/talk", json={"enabled": False}, headers=admin)
    assert r.status_code == 200 and r.json()["enabled"] is False
    assert not await can_talk(member) and not await can_talk(user)
    cfg = (await http.get("/api/talk/config", headers=bearer(member))).json()
    assert cfg["reason"] == "Talk is turned off on this server."

    # On, but only for one group (admins always).
    r = await http.patch("/api/admin/talk", json={"enabled": True, "group_ids": [str(group.id)]}, headers=admin)
    assert r.status_code == 200 and r.json()["group_ids"] == [str(group.id)]
    assert await can_talk(member) and await can_talk(user) and not await can_talk(outsider)

    # A group that doesn't exist is refused; an empty list means everyone.
    r = await http.patch("/api/admin/talk", json={"group_ids": [str(uuid.uuid4())]}, headers=admin)
    assert r.status_code == 400 and "doesn't exist" in r.json()["detail"]
    r = await http.patch("/api/admin/talk", json={"group_ids": []}, headers=admin)
    assert r.status_code == 200 and r.json()["group_ids"] == []
    assert await can_talk(outsider)

    # Live slots: 1 to 20.
    for bad in (0, 21, -1):
        assert (await http.patch("/api/admin/talk", json={"live_slots": bad}, headers=admin)).status_code == 422
    r = await http.patch("/api/admin/talk", json={"live_slots": 3}, headers=admin)
    assert r.status_code == 200 and r.json()["live_slots"] == 3
    assert (await http.get("/api/talk/config", headers=bearer(member))).json()["limits"]["live_slots"] == 3

    # A deleted group stops counting (and isn't shown as picked).
    await http.patch("/api/admin/talk", json={"group_ids": [str(group.id)]}, headers=admin)
    await db.delete(group)
    await db.commit()
    assert (await http.get("/api/admin/talk", headers=admin)).json()["group_ids"] == []

    # Every change is in the audit log, as an app-settings change.
    events = (await db.execute(select(AuthEvent).where(AuthEvent.event_type == "app_settings_changed"))).scalars().all()
    details = " ".join(e.detail or "" for e in events)
    assert "talk_enabled=False" in details and "talk_live_slots=3" in details and "talk_group_ids" in details


async def test_the_speech_models_in_use(db, user, http, provider, monkeypatch):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.config import get_settings
    from app.models_config.models import ModelProvider
    from app.talk import admin as talk_admin

    async def health(client, base):  # noqa: ANN001
        if "whisper" in base:
            return {"status": "ok", "model": "small", "device": "cpu", "live": {"model": "base", "slots": 2, "smart_turn": "ok"}}
        return {"status": "ok", "voice": "af_heart", "threads": 4, "streams": {"active": 0, "slots": 2}}

    monkeypatch.setattr(get_settings(), "WHISPER_URL", "http://whisper:8000")
    monkeypatch.setattr(get_settings(), "TTS_URL", "http://tts:8000")
    monkeypatch.setattr(talk_admin, "_health", health)
    hosted = ModelProvider(name="OpenRouter", type="openrouter", base_url="https://openrouter.ai/api/v1", enabled=True, models=[])
    db.add(hosted)
    await db.flush()
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) or AppSettings(id=SINGLETON_APP_SETTINGS_ID)
    db.add(row)
    row.voice_provider_id, row.voice_model_id = hosted.id, "fast-model"
    await db.commit()

    body = (await http.get("/api/admin/talk", headers=bearer(user))).json()
    assert body["speech"]["listening"] == {
        "reachable": True, "live_model": "base", "live_slots": 2, "turn_detector": "ok", "dictation_model": "small", "device": "cpu",
    }
    assert body["speech"]["speaking"]["reachable"] and body["speech"]["speaking"]["stream_slots"] == 2
    assert body["answers"] == {"voice_model_set": True, "provider": "OpenRouter", "model": "fast-model", "hosted": True, "provider_enabled": True}


async def test_unreachable_speech_services_say_so_quickly(db, user, http, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "WHISPER_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(get_settings(), "TTS_URL", "")
    r = await http.get("/api/admin/talk", headers=bearer(user))
    assert r.status_code == 200
    speech = r.json()["speech"]
    assert speech["listening"]["reachable"] is False and speech["speaking"]["reachable"] is False
    assert r.json()["answers"]["voice_model_set"] is False


async def test_usage_is_medians_and_the_slow_end_with_no_words(db, user, http):
    from app.chat.models import Conversation, Message

    # Words that must never reach this screen, sitting in the same database.
    chat = Conversation(user_id=user.id, title="Zebrafish plans")
    db.add(chat)
    await db.flush()
    db.add(Message(conversation_id=chat.id, role="user", content="Remind me about the zebrafish quarterly", voice={"spoken": True}))
    for n in range(1, 11):
        db.add(_metric(user.id, endpoint_ms=100 * n, stt_ms=200 * n, ttft_ms=50 * n, first_audio_ms=1000 + 100 * n))
    db.add(_metric(user.id, device="android", endpoint_ms=300, stt_ms=600, first_audio_ms=1500, barge_in_ms=700, barge_ins=1))
    db.add(_metric(user.id, device="android", endpoint_ms=500, stt_ms=800, first_audio_ms=1900, barge_in_ms=900, barge_ins=1, fast_path=True))
    db.add(_metric(user.id, days_ago=9, endpoint_ms=99_999, first_audio_ms=99_999))  # outside 7 days
    await db.commit()

    r = await http.get("/api/admin/talk/usage", params={"days": 7}, headers=bearer(user))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["days"] == 7 and body["keep_days"] == 30
    every = body["all"]
    assert every["turns"] == 12 and every["people"] == 1 and every["conversations"] == 12
    assert every["barge_ins"] == 2 and every["fast_path"] == 1
    web = next(d for d in body["devices"] if d["device"] == "web")
    t = web["timings"]
    assert t["end_of_turn"] == {"median_ms": 550, "p90_ms": 910, "count": 10}
    assert t["first_audio"]["median_ms"] == 1550 and t["first_audio"]["p90_ms"] == 1910
    assert t["barge_in"] == {"median_ms": None, "p90_ms": None, "count": 0}
    android = next(d for d in body["devices"] if d["device"] == "android")
    assert android["timings"]["barge_in"] == {"median_ms": 800, "p90_ms": 880, "count": 2}
    assert [d["device"] for d in body["devices"]] == ["web", "android"]
    # The old row shows up only when asked for 30 days.
    month = (await http.get("/api/admin/talk/usage", params={"days": 30}, headers=bearer(user))).json()
    assert month["all"]["turns"] == 13
    assert (await http.get("/api/admin/talk/usage", params={"days": 31}, headers=bearer(user))).status_code == 422

    # Numbers and device names only: no string in it but its own labels.
    strings: list[str] = []

    def walk(v):  # noqa: ANN001
        if isinstance(v, dict):
            for item in v.values():
                walk(item)
        elif isinstance(v, list):
            for item in v:
                walk(item)
        elif isinstance(v, str):
            strings.append(v)

    walk(body)
    assert set(strings) <= {"web", "android", "car"}
    assert "zebrafish" not in json.dumps(body).lower()


async def test_prune_keeps_thirty_days(db, user):
    from app.talk import metrics
    from app.talk.models import TalkMetric
    from app.tasks.worker import WorkerSettings

    db.add(_metric(user.id, days_ago=31, first_audio_ms=1))
    db.add(_metric(user.id, days_ago=29, first_audio_ms=2))
    db.add(_metric(user.id, first_audio_ms=3))
    await db.commit()
    assert await metrics.prune_talk_metrics() == 1
    db.expire_all()
    left = sorted(r.first_audio_ms for r in (await db.execute(select(TalkMetric))).scalars())
    assert left == [2, 3]
    # Nightly.
    jobs = [j for j in WorkerSettings.cron_jobs if j.name.endswith("prune_talk_metrics")]
    assert len(jobs) == 1 and jobs[0].hour == 4 and jobs[0].minute == 35


async def test_talking_over_it_is_timed_for_the_speed_card(db, user, conversation, sidecars, talk_app, http, monkeypatch):  # noqa: F811
    from app.talk.models import TalkMetric

    hdr = bearer(user)
    use_model(monkeypatch, Model([LONG, "Friday's clear."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.until_audio()
    await c.drain(0.6)
    await live.emit({"type": "speech_start", "turn": 2, "at_ms": 5000})
    await live.emit({"type": "partial", "turn": 2, "text": "Wait, what about", "stable": ""})
    await c.expect("stop_audio", timeout=3)
    await live.emit({"type": "turn_end", "turn": 2, "reason": "complete", "speech_end_ms": 6000, "at_ms": 6280})
    await live.emit({"type": "final", "turn": 2, "text": "Wait, what about Friday?"})
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    # Each answer's timings are written as it finishes, on their own session.
    for _ in range(100):
        db.expire_all()
        rows = (await db.execute(select(TalkMetric).order_by(TalkMetric.created_at))).scalars().all()
        if len(rows) == 2:
            break
        await asyncio.sleep(0.05)
    await finish(c)
    assert len(rows) == 2
    cut, second = rows
    assert cut.barge_ins == 1 and cut.barge_in_ms is not None and 0 <= cut.barge_in_ms < 2000
    assert second.barge_in_ms is None
    usage = (await http.get("/api/admin/talk/usage", headers=hdr)).json()
    assert usage["all"]["turns"] == 2 and usage["all"]["timings"]["barge_in"]["count"] == 1


async def test_the_talk_header_says_where_answers_come_from(db, user, sidecars, talk_app, monkeypatch):  # noqa: F811
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.chat.models import Conversation
    from app.models_config.models import ModelProvider

    local = ModelProvider(name="Ollama", type="ollama", base_url="http://ollama:11434", enabled=True, models=[])
    hosted = ModelProvider(name="OpenRouter", type="openrouter", base_url="https://openrouter.ai/api/v1", enabled=True, models=[])
    db.add_all([local, hosted])
    await db.flush()
    chat = Conversation(user_id=user.id, title="Local", provider_id=local.id, model_id="llama")
    db.add(chat)
    await db.commit()

    c = await open_talk(talk_app, user, chat)
    ready = next(e for e in c.events if e.get("type") == "ready")
    assert ready["answers"] == {"provider": "Ollama", "hosted": False}
    await finish(c)

    # The admin's voice model answers spoken turns: that's where they come from.
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) or AppSettings(id=SINGLETON_APP_SETTINGS_ID)
    db.add(row)
    row.voice_provider_id, row.voice_model_id = hosted.id, "fast"
    await db.commit()
    c = await open_talk(talk_app, user, chat)
    ready = next(e for e in c.events if e.get("type") == "ready")
    assert ready["answers"] == {"provider": "OpenRouter", "hosted": True}
    await finish(c)
