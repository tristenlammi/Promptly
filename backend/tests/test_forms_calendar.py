"""An RSVP form from a Calendar event (Forms WP-F1.7): made from the RSVP
template with the event's title, time and place, linked both ways, shown on
the event to people who can change it; the answer page knows only what was
copied, and "Add to my calendar" is a one-event .ics without the notes."""
from __future__ import annotations

import time
import uuid

import httpx
import pytest


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app
    from app.tasks import events

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(events, "emit_user_event", lambda **kw: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    async def fake(**kw):
        return None

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name, tz="Australia/Sydney"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user", settings={"timezone": tz})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_rsvp_form_from_an_event(client, db):
    from app.files.models import UserFile
    from app.forms.access import form_for_shell

    sam = await mk_user(db, "sam")
    r = await client.post("/api/calendar/events", headers=H(sam), json={
        "title": "BBQ at ours", "start": "2026-11-14T07:00:00Z", "end": "2026-11-14T10:00:00Z",
        "location": "12 Gum St", "description": "Gate code 4471, don't share",
    })
    assert r.status_code == 201, r.text
    ev_id = r.json()["event"]["event_id"] if "event_id" in r.json()["event"] else r.json()["event"]["id"].split(":")[0]

    r = await client.post("/api/forms/from-event", headers=H(sam), json={"event_id": ev_id})
    assert r.status_code == 201, r.text
    assert r.json()["made"] is True
    fid = r.json()["file"]["id"]
    shell = await db.get(UserFile, uuid.UUID(fid))
    form = await form_for_shell(db, shell)
    d = form.definition
    assert d["title"] == "BBQ at ours RSVP"
    assert "BBQ at ours" in d["description"] and "12 Gum St" in d["description"]
    assert "Saturday 14 November 2026, 6 pm to 9 pm" in d["description"]  # in Sam's own time zone
    assert "4471" not in d["description"]
    assert str(form.event_id) == ev_id
    # Asking again gives the same form.
    again = await client.post("/api/forms/from-event", headers=H(sam), json={"event_id": ev_id})
    assert again.json()["file"]["id"] == fid and again.json()["made"] is False
    # The event shows it to Sam.
    ev = (await client.get(f"/api/calendar/events/{ev_id}", headers=H(sam))).json()["event"]
    assert ev["rsvp_form"]["file_id"] == fid and ev["rsvp_form"]["answers"] == 0

    # Someone who can't see the event can't add one.
    other = await mk_user(db, "other")
    r = await client.post("/api/forms/from-event", headers=H(other), json={"event_id": ev_id})
    assert r.status_code == 404

    # The answer page: what was copied, and a one-event .ics without the notes.
    await client.patch(f"/api/forms/{fid}/settings", headers=H(sam), json={"audience": "link", "accepting": True})
    token = (await client.post(f"/api/forms/{fid}/link", json={}, headers=H(sam))).json()["link"]["token"]
    page = (await client.get(f"/api/f/{token}")).json()
    assert page["event"] == {"title": "BBQ at ours"}
    assert "4471" not in str(page)
    r = await client.get(f"/api/f/{token}/ics")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/calendar")
    body = r.text
    assert "SUMMARY:BBQ at ours" in body and "LOCATION:12 Gum St" in body and "DTSTART:20261114T070000Z" in body
    assert "DESCRIPTION" not in body and "4471" not in body
    # A form with no event has no .ics.
    r = await client.post("/api/forms", json={}, headers=H(sam))
    plain = r.json()["file"]["id"]
    await client.patch(f"/api/forms/{plain}/settings", headers=H(sam), json={"audience": "link", "accepting": True})
    t2 = (await client.post(f"/api/forms/{plain}/link", json={}, headers=H(sam))).json()["link"]["token"]
    assert (await client.get(f"/api/f/{t2}")).json()["event"] is None
    assert (await client.get(f"/api/f/{t2}/ics")).status_code == 404

    # The form going to the trash takes it off the event.
    shell = await db.get(UserFile, uuid.UUID(fid))
    from datetime import datetime, timezone

    shell.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    ev = (await client.get(f"/api/calendar/events/{ev_id}", headers=H(sam))).json()["event"]
    assert ev["rsvp_form"] is None
    # …and Add an RSVP form makes a new one.
    r = await client.post("/api/forms/from-event", headers=H(sam), json={"event_id": ev_id})
    assert r.json()["made"] is True and r.json()["file"]["id"] != fid
    _ = time
