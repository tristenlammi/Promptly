"""Memories (PH-5): on this day, a trip away from home, a pet's first year
and you & Sarah are made from the library; dismissed stays dismissed;
"don't show me memories of her" holds; a memory can become an album."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _gazetteer, _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

TODAY = date(2026, 10, 15)
BRISBANE = (-27.47, 153.03)
MADRID = (40.42, -3.70)


@pytest.mark.asyncio
async def test_memories_from_the_library(client, db, user, root, fake_ml, monkeypatch):
    from app.photos import memories, places

    _gazetteer(places.local_dir())
    await places.load(db)
    me = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name, linked_user_id) VALUES (:u, 'person', 'Tris', :u) RETURNING id"), {"u": user.id})
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    max_ = await db.scalar(text("INSERT INTO photo_people (user_id, kind, species, name) VALUES (:u, 'pet', 'dog', 'Max') RETURNING id"), {"u": user.id})
    await db.commit()

    # Home: the two of us in Brisbane on eight days.
    for d in range(8):
        await _scene(db, user, who=[me, sarah], lat=BRISBANE[0], lon=BRISBANE[1], when=datetime(2023, 2, 1 + d, 3, tzinfo=timezone.utc))
    # Max: his first ten photos over 2024 — two of them on 15 October.
    max_photos = []
    for i, when in enumerate([datetime(2024, m, 10, 3, tzinfo=timezone.utc) for m in range(1, 9)]
                             + [datetime(2024, 10, 15, 3, tzinfo=timezone.utc), datetime(2024, 10, 15, 5, tzinfo=timezone.utc)]):
        fid = await _scene(db, user, who=[], lat=BRISBANE[0], lon=BRISBANE[1], when=when)
        await db.execute(
            text(
                "INSERT INTO photo_animals (file_id, user_id, species, box_x, box_y, box_w, box_h, score, size_px, model, "
                "embedding, embedding_dino, pet_id, assigned_by) SELECT :f, :u, 'dog', 0.1, 0.1, 0.5, 0.5, 0.9, 300, 't', e.embedding, "
                "CAST(:d AS vector), :p, 'user' "
                "FROM photo_embeddings e WHERE e.file_id = :f"
            ),
            {"f": fid, "u": user.id, "p": max_, "d": "[" + ",".join(["0.051"] * 384) + "]"},
        )
        max_photos.append(fid)
    await db.commit()
    # Madrid: ten photos over three days in May 2025.
    for i in range(10):
        await _scene(db, user, who=[], lat=MADRID[0], lon=MADRID[1],
                     when=datetime(2025, 5, 1, 9, tzinfo=timezone.utc) + timedelta(hours=6 * i))

    assert await memories.generate(db, user, TODAY) == 4
    await db.commit()
    got = {r.key: r for r in (await db.execute(text("SELECT * FROM photo_memories WHERE user_id = :u"), {"u": user.id})).all()}
    assert set(got) == {"otd:2026-10-15:2024", "trip:2025-05-01", f"first_year:{max_}", f"together:{sarah}"}
    otd = got["otd:2026-10-15:2024"]
    assert otd.title == "2 years ago" and otd.subtitle == "15 October 2024 · Brisbane" and len(otd.file_ids) == 2
    trip = got["trip:2025-05-01"]
    assert trip.title == "Trip to Madrid" and trip.subtitle == "1–3 May 2025 · 3 days" and len(trip.file_ids) == 10
    first = got[f"first_year:{max_}"]
    assert first.title == "Max's first year" and len(first.file_ids) == 10 and first.person_id == max_
    assert got[f"together:{sarah}"].title == "You & Sarah" and len(got[f"together:{sarah}"].file_ids) == 8

    # The API: the list (no remake here — today is fixed), one, dismiss, album.
    async def fresh(db, user):
        return None

    monkeypatch.setattr(memories, "ensure_fresh", fresh)
    listed = (await client.get("/api/photos/memories", headers=_auth(user))).json()["memories"]
    assert [m["kind"] for m in listed] == ["on_this_day", "trip", "first_year", "together"]
    assert listed[1]["cover"]["thumb"] is None or listed[1]["cover"]["id"]
    one = (await client.get(f"/api/photos/memories/{listed[0]['id']}", headers=_auth(user))).json()
    assert {i["id"] for i in one["items"]} == {str(f) for f in max_photos[-2:]}

    assert (await client.post(f"/api/photos/memories/{listed[1]['id']}/dismiss", headers=_auth(user))).status_code == 204
    await memories.generate(db, user, TODAY)
    await db.commit()
    listed = (await client.get("/api/photos/memories", headers=_auth(user))).json()["memories"]
    assert "trip" not in [m["kind"] for m in listed]

    # Not Sarah: her story goes, and isn't made again.
    together_id = next(m["id"] for m in listed if m["kind"] == "together")
    assert (await client.post(f"/api/photos/memories/{together_id}/hide-person", headers=_auth(user))).status_code == 204
    await memories.generate(db, user, TODAY)
    await db.commit()
    listed = (await client.get("/api/photos/memories", headers=_auth(user))).json()["memories"]
    assert [m["kind"] for m in listed] == ["on_this_day", "first_year"]
    p = (await client.get("/api/photos/people", params={"kind": "person", "hidden": True}, headers=_auth(user))).json()
    rows = p if isinstance(p, list) else p.get("people", [])
    assert next(x for x in rows if x["id"] == str(sarah))["memories"] is False

    # Kept as an album.
    r = await client.post(f"/api/photos/memories/{listed[1]['id']}/album", headers=_auth(user))
    assert r.status_code == 201 and r.json()["added"] == 10
    album = (await client.get(f"/api/photos/albums/{r.json()['id']}", headers=_auth(user))).json()
    assert album["title"] == "Max's first year"

    # Another day: yesterday's "on this day" goes.
    await memories.generate(db, user, TODAY + timedelta(days=1))
    await db.commit()
    kinds = (await db.execute(text("SELECT kind FROM photo_memories WHERE user_id = :u AND dismissed_at IS NULL"), {"u": user.id})).scalars().all()
    assert "on_this_day" not in kinds


def test_trip_needs_two_days_and_enough_photos():
    from app.photos.memories import Shot, trips

    home = {"lat": BRISBANE[0], "lon": BRISBANE[1], "country": "AU"}
    places = {1: {"name": "Madrid", "country": "ES", "country_name": "Spain", "admin1": "ES.29", "admin1_name": "Madrid", "lat": 40.4, "lon": -3.7}}
    t0 = datetime(2025, 5, 1, 9)

    def shots(n, hours):
        return [Shot(__import__("uuid").uuid4(), t0 + timedelta(hours=hours * i), 0.5, 1, MADRID[0], MADRID[1], False) for i in range(n)]

    assert trips(shots(12, 1), places, home) == []  # a day trip
    assert trips(shots(6, 12), places, home) == []  # too few photos
    assert len(trips(shots(10, 12), places, home)) == 1
    # Four days apart: two separate visits, each too short.
    a, b = shots(5, 1), shots(5, 1)
    for s in b:
        s.taken += timedelta(days=4)
    assert trips(a + b, places, home) == []
