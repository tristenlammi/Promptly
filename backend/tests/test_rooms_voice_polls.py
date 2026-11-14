"""Rooms: voice messages (a recording sent as a message, with its words
underneath) and polls (one vote each, counted on the server)."""
from __future__ import annotations

import subprocess
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from tests.test_rooms import H, _quiet_background, client, make_space, mk_user, people, say  # noqa: F401


def _tone(tmp_path, seconds: float = 2.0, name: str = "voice.webm") -> bytes:
    """A real recording, the way Chrome makes one (WebM/Opus)."""
    out = tmp_path / name
    codec = ["-c:a", "libopus", "-b:a", "24k"] if name.endswith(".webm") else ["-c:a", "aac"]
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", *codec, str(out)],
        check=True,
    )
    return out.read_bytes()


async def _upload(client, u, room, data: bytes, name="voice.webm", mime="audio/webm") -> str:
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(u), files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _voice(client, u, room, data: bytes, *, duration_ms=2000, **kw):
    att = await _upload(client, u, room, data, **kw)
    return await client.post(
        f"/api/rooms/rooms/{room}/messages",
        headers=H(u),
        json={"body": "", "voice": {"attachment_id": att, "duration_ms": duration_ms, "peaks": [0.1, 0.9, 0.4]}},
    )


async def _settings(db, **values):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    for k, v in values.items():
        setattr(row, k, v)
    await db.commit()


@pytest.fixture
def heard(monkeypatch):
    """Speech-to-text is on, and hears this."""
    import app.rooms.features as features
    import app.rooms.voice as voice

    said = {"words": "running ten minutes late, save me a seat", "on": True}

    async def _on(db, f=None):
        return said["on"] and (f or await features.load(db)).voice_transcripts is not False

    async def _transcribe(src):
        if said["words"] is None:
            raise RuntimeError("whisper fell over")
        return said["words"]

    monkeypatch.setattr(features, "transcripts_on", _on)
    monkeypatch.setattr(voice, "transcribe", _transcribe)
    return said


@pytest.fixture
def told(monkeypatch):
    """What the room's open pages were sent."""
    import app.rooms.core as core

    events: list[tuple[list[str], dict]] = []

    async def _publish(user_ids, event):
        events.append((sorted(str(u) for u in user_ids), event))

    monkeypatch.setattr(core, "publish", _publish)
    return events


# ================================================================== voice


async def test_a_voice_message_is_its_recording_with_a_length_and_a_waveform(client, db, people, tmp_path, heard):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    r = await _voice(client, ann, room, _tone(tmp_path), duration_ms=9999)
    assert r.status_code == 201, r.text
    m = r.json()
    v = m["meta"]["voice"]
    # The length is the audio's own, not what the page claimed.
    assert 1800 <= v["duration_ms"] <= 2300
    assert v["state"] == "pending" and v["play"] is False
    assert 1 <= len(v["peaks"]) <= 64 and all(0 <= p <= 1 for p in v["peaks"])
    assert m["body"] == "\U0001F3A4 0:02"
    assert len(m["attachments"]) == 1 and m["attachments"][0]["id"] == v["att"]

    boot = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()
    assert boot["features"] == {"voice_messages": True, "voice_max_seconds": 600, "polls": True}


async def test_its_words_arrive_underneath_and_are_searchable(client, db, people, tmp_path, heard, told):  # noqa: F811
    from app.rooms import voice

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    assert await voice.process(uuid.UUID(m["id"])) == "done"

    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"][-1]
    v = got["meta"]["voice"]
    assert v["state"] == "done" and v["transcript"] == heard["words"] and v["play"] is True
    assert got["body"] == f"\U0001F3A4 0:02 · {heard['words']}"
    assert got["edited_at"] is None  # not an edit anyone made
    # Everyone's open page heard about it.
    edits = [e for _to, e in told if e["type"] == "message_edit" and e["message"]["id"] == m["id"]]
    assert edits and edits[-1]["message"]["meta"]["voice"]["transcript"] == heard["words"]

    hits = (await client.get("/api/rooms/search", headers=H(bob), params={"q": "save seat"})).json()
    assert [h["message"]["id"] for h in hits] == [m["id"]]

    # The copy every browser can play (AAC in MP4), and the original.
    url = got["attachments"][0]["url"]
    play = await client.get(url + "&play=1")
    assert play.status_code == 200 and play.headers["content-type"].startswith("audio/mp4")
    assert play.content[4:8] == b"ftyp"
    raw = await client.get(url)
    assert raw.status_code == 200 and raw.headers["content-type"].startswith("audio/webm")
    # Seeking works (Safari asks for ranges).
    part = await client.get(url + "&play=1", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100


async def test_safaris_recording_plays_too(client, db, people, tmp_path, heard):  # noqa: F811
    from app.rooms import voice

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    r = await _voice(client, ann, room, _tone(tmp_path, name="voice.m4a"), name="voice.m4a", mime="audio/mp4")
    assert r.status_code == 201, r.text
    assert await voice.process(uuid.UUID(r.json()["id"])) == "done"
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"][-1]
    assert got["meta"]["voice"]["play"] is True


async def test_no_speech_to_text_means_no_words_and_no_error(client, db, people, tmp_path, heard):  # noqa: F811
    from app.rooms import voice

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    heard["on"] = False
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    assert m["meta"]["voice"]["state"] == "off"
    assert await voice.process(uuid.UUID(m["id"])) == "off"
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"][-1]
    assert got["meta"]["voice"]["state"] == "off" and "transcript" not in got["meta"]["voice"]
    assert got["meta"]["voice"]["play"] is True and got["body"] == "\U0001F3A4 0:02"


async def test_the_admin_can_turn_transcripts_off(client, db, people, tmp_path, heard):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await _settings(db, rooms_voice_transcripts=False)
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    assert m["meta"]["voice"]["state"] == "off"


async def test_a_failed_transcription_leaves_a_message_that_still_plays(client, db, people, tmp_path, heard):  # noqa: F811
    from app.rooms import voice

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    heard["words"] = None
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    assert await voice.process(uuid.UUID(m["id"])) == "failed"
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"][-1]
    assert got["meta"]["voice"]["state"] == "failed" and got["meta"]["voice"]["play"] is True


async def test_the_servers_limits_are_kept(client, db, people, tmp_path, heard):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    long = _tone(tmp_path, seconds=16)
    await _settings(db, rooms_voice_max_seconds=10)
    # Whatever the page says about its length.
    r = await _voice(client, ann, room, long, duration_ms=2000)
    assert r.status_code == 400 and "10 seconds" in r.json()["detail"]
    boot = (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()
    assert boot["features"]["voice_max_seconds"] == 10

    await _settings(db, rooms_voice_max_seconds=600, rooms_voice_messages=False)
    r = await _voice(client, ann, room, _tone(tmp_path))
    assert r.status_code == 403 and "turned off" in r.json()["detail"]
    assert (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["features"]["voice_messages"] is False


async def test_only_your_own_fresh_recording_can_be_sent(client, db, people, tmp_path, heard):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    # Not audio.
    r = await _voice(client, ann, room, b"hello there", name="notes.txt", mime="text/plain")
    assert r.status_code == 400, r.text
    # Somebody else's upload.
    att = await _upload(client, bob, room, _tone(tmp_path))
    r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"voice": {"attachment_id": att, "duration_ms": 2000}})
    assert r.status_code == 400, r.text
    # Sent once already.
    ok = await _voice(client, ann, room, _tone(tmp_path))
    used = ok.json()["meta"]["voice"]["att"]
    r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"voice": {"attachment_id": used, "duration_ms": 2000}})
    assert r.status_code == 400, r.text


async def test_a_voice_message_cant_be_edited_and_is_wiped_when_deleted(client, db, people, tmp_path, heard):  # noqa: F811
    from app.files.storage import absolute_path
    from app.rooms import service, voice
    from app.rooms.models import RoomAttachment, RoomMessage

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    assert await voice.process(uuid.UUID(m["id"])) == "done"
    r = await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": "typed instead"})
    assert r.status_code == 403, r.text

    att = await db.get(RoomAttachment, uuid.UUID(m["meta"]["voice"]["att"]))
    copy = absolute_path(voice.play_path(att))
    assert copy.exists()
    assert (await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))).status_code == 204
    assert (await client.get(m["attachments"][0]["url"] + "&play=1")).status_code == 404
    assert await service.purge_deleted(db, older_than=timedelta(seconds=0)) == 1
    db.expire_all()
    row = await db.get(RoomMessage, uuid.UUID(m["id"]))
    assert row.body == "" and "voice" not in row.meta
    assert not copy.exists()


async def test_the_notification_reads_the_words(client, db, people, tmp_path, heard, monkeypatch):  # noqa: F811
    import app.notifications.dispatch as dispatch
    from app.rooms import push, voice

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = (await _voice(client, ann, room, _tone(tmp_path))).json()
    sent: list[dict] = []

    async def _notify(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", _notify)
    await voice.after_send(uuid.UUID(m["id"]))
    assert len(sent) == 1 and sent[0]["user_id"] == bob.id
    assert sent[0]["body"].endswith(f"\U0001F3A4 0:02 · {heard['words']}")
    assert push._plain("\U0001F3A4 0:02") == "\U0001F3A4 0:02"


# ================================================================== polls

LUNCH = {"question": "  Where for   lunch? ", "options": ["Thai", " Pizza ", "thai", "", "Sushi"]}


async def _poll(client, u, room, **poll):
    return await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(u), json={"body": "ignored", "poll": {**LUNCH, **poll}})


async def _vote(client, u, mid, *options):
    return await client.put(f"/api/rooms/messages/{mid}/poll/vote", headers=H(u), json={"options": list(options)})


async def test_a_poll_is_a_message_with_its_answers(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    r = await _poll(client, ann, room)
    assert r.status_code == 201, r.text
    m = r.json()
    p = m["meta"]["poll"]
    assert p["question"] == "Where for lunch?"
    # Blank and repeated answers are dropped.
    assert p["options"] == [{"id": "1", "text": "Thai"}, {"id": "2", "text": "Pizza"}, {"id": "3", "text": "Sushi"}]
    assert p["multiple"] is False and p["anonymous"] is False and p["closes_at"] is None and p["closed_at"] is None
    assert m["body"] == "\U0001F4CA Where for lunch?"
    assert m["poll"] == {"counts": {"1": 0, "2": 0, "3": 0}, "voters_total": 0, "closed": False, "voters": {"1": [], "2": [], "3": []}}

    for bad in ({"options": ["Only one", "only ONE"]}, {"options": ["A"]}, {"question": "   "}, {"closes_at": "2020-01-01T00:00:00Z"}):
        r = await _poll(client, ann, room, **bad)
        assert r.status_code in (400, 422), r.text
    r = await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": "Where for dinner?"})
    assert r.status_code == 403, r.text


async def test_one_vote_each_and_you_can_change_it(client, db, people, told):  # noqa: F811
    ann, bob, cat, dan = people
    _sid, room = await make_space(client, ann, bob, cat)
    mid = (await _poll(client, ann, room)).json()["id"]

    r = await _vote(client, bob, mid, "1")
    assert r.status_code == 200, r.text
    assert r.json()["poll"]["counts"] == {"1": 1, "2": 0, "3": 0} and r.json()["poll"]["mine"] == ["1"]
    # Voting again moves the vote; it's never counted twice.
    assert (await _vote(client, bob, mid, "1")).json()["poll"]["counts"]["1"] == 1
    r = await _vote(client, bob, mid, "2")
    assert r.json()["poll"]["counts"] == {"1": 0, "2": 1, "3": 0} and r.json()["poll"]["voters"]["2"] == [str(bob.id)]
    await _vote(client, cat, mid, "2")
    await _vote(client, ann, mid, "3")

    # One answer only, and only real ones.
    assert (await _vote(client, bob, mid, "1", "2")).status_code == 400
    assert (await _vote(client, bob, mid, "9")).status_code == 400
    # Not in the room: it doesn't exist for you.
    assert (await _vote(client, dan, mid, "1")).status_code == 404

    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(cat))).json()["messages"][-1]
    assert got["poll"]["counts"] == {"1": 0, "2": 2, "3": 1} and got["poll"]["voters_total"] == 3 and got["poll"]["mine"] == ["2"]

    # Taking it back.
    r = await _vote(client, cat, mid)
    assert r.json()["poll"]["counts"]["2"] == 1 and r.json()["poll"]["mine"] == []

    # Everyone's page hears the count, and never somebody's "mine".
    polls = [(to, e) for to, e in told if e["type"] == "poll" and e["message_id"] == mid]
    assert polls and all("mine" not in e["poll"] for _to, e in polls)
    assert polls[-1][0] == sorted(str(u.id) for u in (ann, bob, cat))


async def test_several_answers_when_the_poll_allows_it(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    mid = (await _poll(client, ann, room, multiple=True)).json()["id"]
    r = await _vote(client, bob, mid, "1", "3", "3")
    assert r.status_code == 200, r.text
    assert r.json()["poll"]["counts"] == {"1": 1, "2": 0, "3": 1} and r.json()["poll"]["voters_total"] == 1
    assert sorted(r.json()["poll"]["mine"]) == ["1", "3"]


async def test_an_anonymous_poll_never_says_who(client, db, people, told):  # noqa: F811
    ann, bob, cat, _ = people
    _sid, room = await make_space(client, ann, bob, cat)
    mid = (await _poll(client, ann, room, anonymous=True)).json()["id"]
    mine = (await _vote(client, bob, mid, "1")).json()["poll"]
    assert mine["mine"] == ["1"] and "voters" not in mine
    # Not to the others, not to the asker, not on the live feed.
    for u in (ann, cat):
        got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(u))).json()["messages"][-1]
        assert got["poll"]["counts"]["1"] == 1 and got["poll"]["mine"] == [] and "voters" not in got["poll"]
    assert str(bob.id) not in str([e for _to, e in told if e["type"] == "poll"])
    pins = await client.patch(f"/api/rooms/messages/{mid}", headers=H(ann), json={"pinned": True})
    assert "voters" not in pins.json()["poll"]


async def test_closing_a_poll(client, db, people):  # noqa: F811
    from app.rooms.models import RoomMessage

    ann, bob, cat, _ = people
    _sid, room = await make_space(client, ann, bob, cat)
    await client.patch(f"/api/rooms/spaces/{_sid}/members/{cat.id}", headers=H(ann), json={"role": "admin"})
    mid = (await _poll(client, bob, room)).json()["id"]
    await _vote(client, ann, mid, "1")
    # Someone who didn't ask it (and isn't an admin) can't close it.
    other = (await _poll(client, cat, room)).json()["id"]
    assert (await client.post(f"/api/rooms/messages/{other}/poll/close", headers=H(bob))).status_code == 403
    # An admin can; so can whoever asked.
    r = await client.post(f"/api/rooms/messages/{mid}/poll/close", headers=H(cat))
    assert r.status_code == 200 and r.json()["poll"]["closed"] is True and r.json()["meta"]["poll"]["closed_at"]
    assert (await _vote(client, ann, mid, "2")).status_code == 409
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()["messages"]
    assert [m for m in got if m["id"] == mid][0]["poll"]["counts"] == {"1": 1, "2": 0, "3": 0}

    # A closing time: open until then, closed after, with nobody pressing anything.
    soon = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    timed = (await _poll(client, bob, room, closes_at=soon)).json()
    assert timed["meta"]["poll"]["closes_at"] and timed["poll"]["closed"] is False
    assert (await _vote(client, ann, timed["id"], "1")).status_code == 200
    row = (await db.execute(select(RoomMessage).where(RoomMessage.id == uuid.UUID(timed["id"])))).scalar_one()
    row.meta = {**row.meta, "poll": {**row.meta["poll"], "closes_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}}
    await db.commit()
    assert (await _vote(client, ann, timed["id"], "2")).status_code == 409


async def test_polls_in_a_conversation_and_the_servers_switch(client, db, people):  # noqa: F811
    ann, bob, cat, _ = people
    r = await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})
    dm = r.json()["id"]
    mid = (await _poll(client, ann, dm)).json()["id"]
    assert (await _vote(client, bob, mid, "2")).status_code == 200
    assert (await _vote(client, cat, mid, "2")).status_code == 404
    # Only the asker closes it in a conversation.
    assert (await client.post(f"/api/rooms/messages/{mid}/poll/close", headers=H(bob))).status_code == 403

    await _settings(db, rooms_polls=False)
    r = await _poll(client, ann, dm)
    assert r.status_code == 403 and "turned off" in r.json()["detail"]
    # Polls already asked still take votes.
    assert (await _vote(client, bob, mid, "1")).status_code == 200


async def test_a_deleted_polls_votes_go_with_it(client, db, people):  # noqa: F811
    from app.rooms import service
    from app.rooms.models import RoomMessage, RoomPollVote

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    mid = (await _poll(client, ann, room)).json()["id"]
    await _vote(client, bob, mid, "1")
    assert (await client.delete(f"/api/rooms/messages/{mid}", headers=H(ann))).status_code == 204
    assert (await _vote(client, bob, mid, "2")).status_code == 404
    assert await service.purge_deleted(db, older_than=timedelta(seconds=0)) == 1
    db.expire_all()
    assert (await db.execute(select(RoomPollVote).where(RoomPollVote.message_id == uuid.UUID(mid)))).first() is None
    assert "poll" not in (await db.get(RoomMessage, uuid.UUID(mid))).meta
