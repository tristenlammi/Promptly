"""Photos quality (Part E §E9): the evaluation harness measures search
(success@5, MRR, latency), faces and pets against a labelled library — here
a small synthetic one — and the permission matrix shows zero cross-user
leakage across every Photos endpoint."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _gazetteer, _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

T = datetime(2022, 12, 27, 2, tzinfo=timezone.utc)


async def _named(db, fid, name):
    await db.execute(text("UPDATE files SET filename = :n WHERE id = :f"), {"n": name, "f": fid})
    await db.commit()


@pytest.mark.asyncio
async def test_the_harness_measures_search_faces_and_pets(db, user, root, fake_ml):
    from app.photos import evaluate, places

    _gazetteer(places.local_dir())
    await places.load(db)
    me = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name, linked_user_id) VALUES (:u, 'person', 'Tris', :u) RETURNING id"), {"u": user.id})
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    a = await _scene(db, user, who=[me, sarah], lat=-26.39, lon=153.09, when=T, beach=True)
    b = await _scene(db, user, who=[me], lat=-26.39, lon=153.09, when=T)
    c = await _scene(db, user, who=[sarah], lat=40.42, lon=-3.70, when=datetime(2023, 5, 1, tzinfo=timezone.utc))
    for fid, name in ((a, "noosa-both.jpg"), (b, "noosa-me.jpg"), (c, "madrid-sarah.jpg")):
        await _named(db, fid, name)

    spec = {
        "user": user.username,
        "queries": [
            {"q": "me and Sarah at Noosa", "expect": ["noosa-both.jpg"]},
            {"q": "Sarah in Madrid", "expect": ["madrid-sarah.jpg"]},
            {"q": "Sarah at the North Pole", "expect": ["noosa-both.jpg", "madrid-sarah.jpg"]},
            {"q": "Tris", "expect": ["no-such-photo.jpg"]},
        ],
        # Sarah is labelled in one photo the engine missed (b): recall 2/3.
        "people": {"Sarah": ["noosa-both.jpg", "madrid-sarah.jpg", "noosa-me.jpg"], "Tris": ["noosa-both.jpg", "noosa-me.jpg"]},
    }
    report = await evaluate.run(db, spec)
    s = report.summary()
    ranks = {q["q"]: q["rank"] for q in report.queries}
    assert ranks["me and Sarah at Noosa"] == 1 and ranks["Sarah in Madrid"] == 1
    assert ranks["Tris"] is None  # its expected photo isn't in the library
    assert s["search"]["queries"] == 4 and s["search"]["p50_ms"] >= 0
    assert s["search"]["success_at_5"] == 0.75 and 0.5 < s["search"]["mrr"] <= 0.75
    assert s["people"] == {"labelled": 2, "recall": round(4 / 5, 3), "precision": 1.0}
    assert report.problems == ["“no-such-photo.jpg” isn't in the library"]
    text_report = evaluate.render(report)
    assert "success_at_5=0.75" in text_report and "'Tris': not found" in text_report


@pytest.mark.asyncio
async def test_no_photo_leaks_to_someone_else(client, db, user, root, fake_ml):
    """Every Photos read, asked by a stranger, about the owner's photo."""
    from app.auth.models import User
    from app.photos import memories

    stranger = User(email=f"s-{uuid.uuid4().hex[:8]}@example.com", username=f"str{uuid.uuid4().hex[:5]}", password_hash="x", role="user")
    db.add(stranger)
    await db.commit()
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    fid = await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=T, beach=True)
    for hour in (2, 5):  # "on this day" needs two
        await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=T.replace(year=2021, month=10, day=16, hour=hour), beach=True)
    album = (await client.post("/api/photos/albums", json={"title": "Private", "file_ids": [str(fid)]}, headers=_auth(user))).json()["id"]
    await memories.generate(db, user, datetime(2026, 10, 16).date())
    await db.commit()
    mem = await db.scalar(text("SELECT id FROM photo_memories WHERE user_id = :u LIMIT 1"), {"u": user.id})
    assert mem is not None
    s = _auth(stranger)
    me = str(fid)

    def nothing_of_theirs(body) -> bool:
        return me not in str(body) and str(sarah) not in str(body)

    for path, params in [
        ("/api/photos/timeline", None), ("/api/photos/buckets", None), ("/api/photos/search", {"q": "on the beach"}),
        ("/api/photos/places", None), ("/api/photos/cleanup", None), ("/api/photos/people", None),
        ("/api/photos/people/review", None), ("/api/photos/albums", None), ("/api/photos/memories", None),
    ]:
        r = await client.get(path, params=params, headers=s)
        assert r.status_code in (200, 503), (path, r.status_code)
        assert nothing_of_theirs(r.json()), path
    for path in [
        f"/api/photos/albums/{album}", f"/api/photos/albums/{album}/items", f"/api/photos/people/{sarah}",
        f"/api/photos/memories/{mem}", f"/api/photos/files/{me}/edit", f"/api/photos/files/{me}/people",
        f"/api/files/{me}/signed-urls", f"/api/files/{me}/media",
    ]:
        assert (await client.get(path, headers=s)).status_code == 404, path
    assert (await client.post("/api/photos/items", json={"ids": [me]}, headers=s)).json()["items"] == []
    assert (await client.post(f"/api/photos/memories/{mem}/album", headers=s)).status_code == 404
    assert (await client.put(f"/api/photos/files/{me}/edit", json={"rotate": 90}, headers=s)).status_code == 404
    assert (await client.post("/api/photos/cleanup/keep", json={"file_ids": [me], "reason": "blurry"}, headers=s)).json() == {"kept": 0}
