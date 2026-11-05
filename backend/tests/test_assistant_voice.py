"""The phone assistant speaks in the voice chosen in your account."""
from __future__ import annotations

import base64

import pytest

from app.voice.service import TranscriptionError

from .test_mail import H, client, mk_user  # noqa: F401


@pytest.fixture
def voices(monkeypatch):
    asked: list[tuple[str, str | None]] = []

    async def fake(*, text, voice=None, speed=1.0):
        asked.append((text, voice))
        return b"RIFFfake"

    monkeypatch.setattr("app.assistant.router.synthesize_speech", fake)
    return asked


async def test_it_uses_the_voice_you_chose(client, db, voices):  # noqa: F811
    u = await mk_user(db, "owner")
    u.settings = {"tts_voice": "af_heart"}
    await db.commit()
    r = await client.post("/api/assistant/speak", json={"text": "Timer set."}, headers=H(u))
    assert r.status_code == 200 and r.content == b"RIFFfake" and r.headers["content-type"] == "audio/wav"
    assert "no-store" in r.headers["cache-control"]
    assert voices == [("Timer set.", "af_heart")]


async def test_no_choice_means_the_server_default(client, db, voices):  # noqa: F811
    u = await mk_user(db, "owner")
    assert (await client.post("/api/assistant/speak", json={"text": "Hello."}, headers=H(u))).status_code == 200
    assert voices == [("Hello.", None)]


async def test_a_voice_cant_be_picked_by_the_caller_or_used_signed_out(client, db, voices):  # noqa: F811
    u = await mk_user(db, "owner")
    u.settings = {"tts_voice": "af_heart"}
    await db.commit()
    await client.post("/api/assistant/speak", json={"text": "Hi there.", "voice": "bm_george"}, headers=H(u))
    assert voices == [("Hi there.", "af_heart")]
    assert (await client.post("/api/assistant/speak", json={"text": "Hi."})).status_code in (401, 403)
    assert (await client.post("/api/assistant/speak", json={"text": "   "}, headers=H(u))).status_code == 422


async def _password(client, u, scopes: list[str]) -> str:
    made = await client.post("/api/auth/app-passwords", json={"name": "Phone", "scopes": scopes}, headers=H(u))
    assert made.status_code in (200, 201), made.text
    token = base64.b64encode(f"{u.username}:{made.json()['password']}".encode()).decode()
    return f"Basic {token}"


async def test_a_phone_needs_the_assistant_permission(client, db, voices):  # noqa: F811
    u = await mk_user(db, "owner")
    assert (await client.post("/api/assistant/speak", json={"text": "Hi."}, headers={"Authorization": await _password(client, u, ["assistant"])})).status_code == 200
    assert (await client.post("/api/assistant/speak", json={"text": "Hi."}, headers={"Authorization": await _password(client, u, ["maps"])})).status_code in (401, 403)


async def test_a_speech_failure_tells_the_phone_to_use_its_own_voice(client, db, monkeypatch):  # noqa: F811
    async def broken(**_):
        raise TranscriptionError("No speech here.", status_code=503)

    monkeypatch.setattr("app.assistant.router.synthesize_speech", broken)
    u = await mk_user(db, "owner")
    assert (await client.post("/api/assistant/speak", json={"text": "Hi."}, headers=H(u))).status_code == 503
