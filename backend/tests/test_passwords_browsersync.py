"""Browser sync (passwords/SYNC.md): open tabs, sent tabs, history and the reading list.

The server only ever holds blobs, so these use random bytes. What's checked is who can
write and read what, the size limits, and that history goes when its days run out.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select, update

from tests.test_passwords import b64, bearer, client, connect_device, make_user, setup_vault, unb64  # noqa: F401

API = "/api/passwords/browser-sync"


class Browser:
    """A connected browser with a vault session: what the extension holds."""

    def __init__(self, device_id: str, token: str, session: str):
        self.id = device_id
        self.token = token
        self.session = session

    @property
    def h(self):
        return {"Authorization": f"Bearer {self.token}", "X-Vault-Session": self.session}


async def browser(client, v, name="Chrome extension on Windows", platform="chromium") -> Browser:
    d = await connect_device(client, v.user, platform=platform, name=name)
    r = await client.post("/api/passwords/session", headers={"Authorization": f"Bearer {d['token']}"}, json={"auth_key": b64(v.auth_key)})
    assert r.status_code == 200, r.text
    return Browser(str(d["device_id"]), d["token"], r.json()["token"])


def blob(n=300) -> str:
    return b64(os.urandom(n))


def today(offset=0) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


async def test_open_tabs_are_written_by_their_own_browser_and_read_by_the_others(client, db):
    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    b = await browser(client, v, name="Firefox extension on Linux", platform="firefox")
    tabs_a = blob(1000)
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": tabs_a})).status_code == 204

    # Another browser, and the web vault, see it under A's device id.
    for who in (b.h, v.h):
        r = await client.get(f"{API}/tabs", headers=who)
        assert r.status_code == 200
        body = r.json()
        assert [x["device_id"] for x in body["records"]] == [a.id]
        assert unb64(body["records"][0]["blob"]) == unb64(tabs_a)
        assert body["records"][0]["slot"] == ""
    rev = r.json()["rev"]

    # Nothing new since: ids still say what's there, with no blobs to download again.
    r = await client.get(f"{API}/tabs?since={rev}", headers=b.h)
    assert r.json()["records"] == [] and len(r.json()["ids"]) == 1

    # B writes its own. It can't write A's: the slot comes from its token.
    assert (await client.put(f"{API}/tabs", headers=b.h, json={"blob": blob()})).status_code == 204
    r = await client.get(f"{API}/tabs?since={rev}", headers=a.h)
    assert [x["device_id"] for x in r.json()["records"]] == [b.id]
    assert len(r.json()["ids"]) == 2

    # The web vault has no browser of its own to share.
    assert (await client.put(f"{API}/tabs", headers=v.h, json={"blob": blob()})).status_code == 403

    # Turning sharing off removes it everywhere.
    assert (await client.delete(f"{API}/tabs", headers=b.h)).status_code == 204
    r = await client.get(f"{API}/tabs", headers=a.h)
    assert [x["device_id"] for x in r.json()["records"]] == [a.id]


async def test_other_people_see_and_touch_nothing(client, db):
    v = await setup_vault(client, await make_user(db))
    w = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    x = await browser(client, w)
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": blob()})).status_code == 204
    assert (await client.put(f"{API}/history/{today()}", headers=a.h, json={"blob": blob()})).status_code == 204
    entry = str(uuid.uuid4())
    assert (await client.put(f"{API}/reading/{entry}", headers=v.h, json={"blob": blob()})).status_code == 204

    for kind in ("tabs", "history", "reading"):
        for who in (w.h, x.h):
            r = await client.get(f"{API}/{kind}", headers=who)
            assert r.status_code == 200 and r.json()["records"] == [] and r.json()["ids"] == [], kind
    # Their own entry can't take that id, and they can't remove it.
    assert (await client.put(f"{API}/reading/{entry}", headers=w.h, json={"blob": blob()})).status_code == 404
    assert (await client.delete(f"{API}/reading/{entry}", headers=w.h)).status_code == 404
    # A tab can't be sent to someone else's browser.
    r = await client.post(f"{API}/sent", headers=w.h, json={"id": str(uuid.uuid4()), "target": a.id, "blob": blob()})
    assert r.status_code == 404
    # Deleting "all synced history" is only ever your own.
    assert (await client.delete(f"{API}/history", headers=w.h)).status_code == 204
    r = await client.get(f"{API}/history", headers=v.h)
    assert len(r.json()["ids"]) == 1

    # No session, no blobs.
    for kind in ("tabs", "history", "reading", "sent"):
        assert (await client.get(f"{API}/{kind}", headers=bearer(v.user))).status_code == 401
    assert (await client.get(f"{API}/nothing", headers=v.h)).status_code == 404


async def test_send_a_tab_and_it_arrives_once(client, db):
    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    phone = await browser(client, v, name="Pixel", platform="android")
    sid = str(uuid.uuid4())
    sent = blob(500)
    assert (await client.post(f"{API}/sent", headers=a.h, json={"id": sid, "target": phone.id, "blob": sent})).status_code == 204
    # A retry with the same id is fine and doesn't make two.
    assert (await client.post(f"{API}/sent", headers=a.h, json={"id": sid, "target": phone.id, "blob": sent})).status_code == 204

    # The bare count a locked phone polls, with its device token alone.
    r = await client.get("/api/passwords/alerts", headers={"Authorization": f"Bearer {phone.token}"})
    assert r.json()["sent_tabs"] == 1
    r = await client.get("/api/passwords/alerts", headers={"Authorization": f"Bearer {a.token}"})
    assert r.json()["sent_tabs"] == 0

    # Only the device it's for lists it.
    r = await client.get(f"{API}/sent", headers=phone.h)
    assert [x["id"] for x in r.json()["records"]] == [sid]
    assert r.json()["records"][0]["device_id"] == phone.id
    assert (await client.get(f"{API}/sent", headers=a.h)).json()["records"] == []
    assert (await client.get(f"{API}/sent", headers=v.h)).status_code == 403

    assert (await client.delete(f"{API}/sent/{sid}", headers=phone.h)).status_code == 204
    assert (await client.get(f"{API}/sent", headers=phone.h)).json()["ids"] == []
    assert (await client.delete(f"{API}/sent/{sid}", headers=phone.h)).status_code == 404

    # The id is taken by nothing else afterwards, and a reading list entry can't reuse a sent id.
    sid2 = str(uuid.uuid4())
    assert (await client.post(f"{API}/sent", headers=v.h, json={"id": sid2, "target": phone.id, "blob": blob()})).status_code == 204
    assert (await client.put(f"{API}/reading/{sid2}", headers=v.h, json={"blob": blob()})).status_code == 404

    # A removed device gets nothing more.
    assert (await client.delete(f"/api/passwords/devices/{phone.id}", headers=bearer(v.user))).status_code == 204
    r = await client.post(f"{API}/sent", headers=a.h, json={"id": str(uuid.uuid4()), "target": phone.id, "blob": blob()})
    assert r.status_code == 404
    # A device that can't reach the vault isn't a target either.
    mail_only = await connect_device(client, v.user, platform="android", name="Mail codes", scopes=["mail_codes"])
    r = await client.post(f"{API}/sent", headers=a.h, json={"id": str(uuid.uuid4()), "target": str(mail_only["device_id"]), "blob": blob()})
    assert r.status_code == 404


async def test_too_many_waiting_for_one_device(client, db, monkeypatch):
    from app.passwords import browsersync

    monkeypatch.setattr(browsersync, "MAX_SENT_PENDING", 2)
    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    b = await browser(client, v)
    for _ in range(2):
        assert (await client.post(f"{API}/sent", headers=a.h, json={"id": str(uuid.uuid4()), "target": b.id, "blob": blob()})).status_code == 204
    assert (await client.post(f"{API}/sent", headers=a.h, json={"id": str(uuid.uuid4()), "target": b.id, "blob": blob()})).status_code == 429


async def test_size_limits(client, db, monkeypatch):
    from app.passwords import browsersync

    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    b = await browser(client, v)
    big = b64(os.urandom(browsersync.MAX_TABS_BYTES + 1))
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": big})).status_code in (413, 422)
    assert (await client.put(f"{API}/history/{today()}", headers=a.h, json={"blob": big})).status_code in (413, 422)
    # Exactly the largest bucket fits.
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": b64(os.urandom(512 * 1024 + 30))})).status_code == 204
    entry = str(uuid.uuid4())
    assert (await client.put(f"{API}/reading/{entry}", headers=v.h, json={"blob": b64(os.urandom(browsersync.MAX_READING_BYTES + 1))})).status_code == 413
    r = await client.post(f"{API}/sent", headers=a.h, json={"id": str(uuid.uuid4()), "target": b.id, "blob": b64(os.urandom(browsersync.MAX_SENT_BYTES + 1))})
    assert r.status_code in (413, 422)
    # Too small to be a blob at all.
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": b64(b"x")})).status_code == 422

    # Reading list entries are counted, and history is capped in total.
    monkeypatch.setattr(browsersync, "MAX_READING_ENTRIES", 2)
    for _ in range(2):
        assert (await client.put(f"{API}/reading/{uuid.uuid4()}", headers=v.h, json={"blob": blob()})).status_code == 204
    assert (await client.put(f"{API}/reading/{uuid.uuid4()}", headers=v.h, json={"blob": blob()})).status_code == 413
    monkeypatch.setattr(browsersync, "MAX_HISTORY_TOTAL", 1000)
    assert (await client.put(f"{API}/history/{today()}", headers=a.h, json={"blob": blob(600)})).status_code == 204
    # Rewriting the same day replaces it, so it doesn't count twice.
    assert (await client.put(f"{API}/history/{today()}", headers=a.h, json={"blob": blob(600)})).status_code == 204
    assert (await client.put(f"{API}/history/{today(-1)}", headers=a.h, json={"blob": blob(600)})).status_code == 413


async def test_reading_list_round_trip(client, db):
    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    entry = str(uuid.uuid4())
    first = blob()
    assert (await client.put(f"{API}/reading/{entry}", headers=a.h, json={"blob": first})).status_code == 204
    r = await client.get(f"{API}/reading", headers=v.h)
    assert r.json()["records"][0]["id"] == entry and r.json()["records"][0]["device_id"] is None
    rev = r.json()["rev"]
    # Marked read on the web: it changes in place.
    second = blob()
    assert (await client.put(f"{API}/reading/{entry}", headers=v.h, json={"blob": second})).status_code == 204
    r = await client.get(f"{API}/reading?since={rev}", headers=a.h)
    assert [x["id"] for x in r.json()["records"]] == [entry]
    assert unb64(r.json()["records"][0]["blob"]) == unb64(second)
    rev = r.json()["rev"]
    assert (await client.delete(f"{API}/reading/{entry}", headers=a.h)).status_code == 204
    r = await client.get(f"{API}/reading?since={rev}", headers=v.h)
    assert r.json()["ids"] == [] and r.json()["rev"] > rev


async def test_history_days_and_deleting(client, db):
    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    b = await browser(client, v)
    assert (await client.get("/api/passwords/browser-sync-prefs", headers=v.h)).json() == {"history_days": 90}
    for day in (today(), today(-10), today(-89)):
        assert (await client.put(f"{API}/history/{day}", headers=a.h, json={"blob": blob()})).status_code == 204, day
    assert (await client.put(f"{API}/history/{today()}", headers=b.h, json={"blob": blob()})).status_code == 204
    # Outside what's kept, or not a day.
    for day in (today(-90), today(3), "2026-13-01", "yesterday"):
        assert (await client.put(f"{API}/history/{day}", headers=a.h, json={"blob": blob()})).status_code == 422, day
    # Only browsers write history.
    assert (await client.put(f"{API}/history/{today()}", headers=v.h, json={"blob": blob()})).status_code == 403

    r = await client.get(f"{API}/history?from_day={today(-10)}", headers=v.h)
    assert sorted(x["slot"] for x in r.json()["records"]) == sorted([today(), today(), today(-10)])

    # Fewer days takes effect at once.
    r = await client.put("/api/passwords/browser-sync-prefs", headers=v.h, json={"history_days": 7})
    assert r.json() == {"history_days": 7}
    r = await client.get(f"{API}/history", headers=a.h)
    assert sorted(x["slot"] for x in r.json()["records"]) == [today(), today()]
    for bad in (0, 366):
        assert (await client.put("/api/passwords/browser-sync-prefs", headers=v.h, json={"history_days": bad})).status_code == 422

    # This browser's only, then everyone's.
    assert (await client.delete(f"{API}/history?this_device=true", headers=a.h)).status_code == 204
    r = await client.get(f"{API}/history", headers=v.h)
    assert [x["device_id"] for x in r.json()["records"]] == [b.id]
    assert (await client.delete(f"{API}/history", headers=v.h)).status_code == 204
    assert (await client.get(f"{API}/history", headers=v.h)).json()["ids"] == []


async def test_sweep_keeps_to_each_persons_days(client, db):
    from app.passwords import browsersync
    from app.passwords.sync_models import PwSyncRecord

    v = await setup_vault(client, await make_user(db))
    w = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    x = await browser(client, w)
    for who in (a, x):
        assert (await client.put(f"{API}/history/{today(-5)}", headers=who.h, json={"blob": blob()})).status_code == 204
        assert (await client.put(f"{API}/history/{today()}", headers=who.h, json={"blob": blob()})).status_code == 204
    # v chose 30 days; w never chose. Both have something that has since aged past 90 days.
    assert (await client.put("/api/passwords/browser-sync-prefs", headers=v.h, json={"history_days": 30})).status_code == 200
    await db.execute(update(PwSyncRecord).where(PwSyncRecord.slot == today(-5)).values(slot=today(-120)))
    await db.commit()
    # And v's newer one is past their 30 days but within the default 90.
    await db.execute(update(PwSyncRecord).where(PwSyncRecord.slot == today(), PwSyncRecord.device_id == uuid.UUID(a.id)).values(slot=today(-40)))
    await db.execute(update(PwSyncRecord).where(PwSyncRecord.slot == today(), PwSyncRecord.device_id == uuid.UUID(x.id)).values(slot=today(-40)))
    await db.commit()

    out = await browsersync.sweep(db)
    assert out["history"] == 3
    left = (await db.execute(select(PwSyncRecord.device_id, PwSyncRecord.slot).where(PwSyncRecord.kind == "history"))).all()
    assert left == [(uuid.UUID(x.id), today(-40))]


async def test_sweep_clears_sent_and_stale_tabs_and_removed_devices(client, db):
    from datetime import datetime, timezone

    from app.passwords import browsersync, service
    from app.passwords.sync_models import PwSyncRecord

    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    b = await browser(client, v)
    c = await browser(client, v)
    for who in (a, b, c):
        assert (await client.put(f"{API}/tabs", headers=who.h, json={"blob": blob()})).status_code == 204
    old_sent, new_sent = str(uuid.uuid4()), str(uuid.uuid4())
    for sid in (old_sent, new_sent):
        assert (await client.post(f"{API}/sent", headers=a.h, json={"id": sid, "target": b.id, "blob": blob()})).status_code == 204
    long_ago = datetime.now(timezone.utc) - timedelta(days=40)
    await db.execute(update(PwSyncRecord).where(PwSyncRecord.id == uuid.UUID(old_sent)).values(created_at=long_ago))
    await db.execute(update(PwSyncRecord).where(PwSyncRecord.kind == "tabs", PwSyncRecord.device_id == uuid.UUID(a.id)).values(updated_at=long_ago))
    await db.commit()
    # c is removed: its tabs aren't shown at once, and go at the sweep.
    assert (await client.delete(f"/api/passwords/devices/{c.id}", headers=bearer(v.user))).status_code == 204
    r = await client.get(f"{API}/tabs", headers=v.h)
    assert sorted(x["device_id"] for x in r.json()["records"]) == sorted([a.id, b.id])

    out = await service.sweep(db)
    assert out["browser_sent"] == 1 and out["browser_tabs"] == 1 and out["browser_revoked"] == 1
    left = (await db.execute(select(PwSyncRecord.kind, PwSyncRecord.device_id).order_by(PwSyncRecord.kind))).all()
    assert left == [("sent", uuid.UUID(b.id)), ("tabs", uuid.UUID(b.id))]
    assert (await browsersync.sweep(db))["history"] == 0


async def test_a_deleted_user_takes_everything_with_them(client, db):
    from app.auth.models import User
    from app.passwords.sync_models import PwSyncRecord, PwSyncState

    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    assert (await client.put(f"{API}/tabs", headers=a.h, json={"blob": blob()})).status_code == 204
    assert (await client.put(f"{API}/reading/{uuid.uuid4()}", headers=v.h, json={"blob": blob()})).status_code == 204
    await db.delete(await db.get(User, v.user.id))
    await db.commit()
    assert (await db.execute(select(PwSyncRecord))).all() == []
    assert (await db.execute(select(PwSyncState))).all() == []


@pytest.mark.parametrize("path", ["/browser-sync/tabs", "/browser-sync/reading/" + str(uuid.uuid4()), "/browser-sync/history/2026-01-01"])
async def test_bodies_arent_logged(client, db, caplog, path):
    """The access log has method, path and status. A blob never reaches a log."""
    import logging

    v = await setup_vault(client, await make_user(db))
    a = await browser(client, v)
    marker = os.urandom(64)
    with caplog.at_level(logging.DEBUG):
        await client.put(f"/api/passwords{path}", headers=a.h, json={"blob": b64(marker)})
    assert b64(marker) not in caplog.text
