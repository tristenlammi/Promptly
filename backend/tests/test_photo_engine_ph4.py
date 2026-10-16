"""Ask your photos — the engine (PH-4): "me and my wife at Noosa" finds the
photo with both of us there; nothing matching relaxes visibly; names it
doesn't know are said, not guessed."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _unit, _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer, _gazetteer_keys, _photo  # noqa: F401


def test_the_search_bar_reads_the_question():
    from app.photos.engine import parse

    q = parse("me and my wife at Noosa in December 2022", people_names=["Sarah"], pet_names=["Max"], today=date(2026, 10, 15))
    assert q.people == ["me", "my wife"] and q.place == "Noosa"
    assert (q.date_from, q.date_to) == (date(2022, 12, 1), date(2022, 12, 31)) and q.visual is None
    q = parse("videos of Max on the beach", people_names=[], pet_names=["Max"])
    assert q.pets == ["Max"] and q.media == "video" and q.visual == "beach"
    q = parse('the menu that says "nasi goreng"', people_names=[], pet_names=[])
    assert q.text == "nasi goreng" and q.visual == "menu says"
    q = parse("Sarah at Christmas 2021", people_names=["Sarah"], pet_names=[])
    assert q.people == ["Sarah"] and (q.date_from, q.date_to) == (date(2021, 12, 20), date(2021, 12, 31))
    q = parse("our dogs last year", people_names=[], pet_names=[], today=date(2026, 3, 1))
    assert q.species == ["dog"] and q.date_from == date(2025, 1, 1)


@pytest.fixture
def fake_ml(monkeypatch):
    from app.photos import ml

    async def waiting():
        return None

    async def embed_texts(texts):
        return "fake-siglip@1", [_unit(0) if "beach" in t else _unit(9) for t in texts]

    async def off():
        return "off"

    monkeypatch.setattr(ml, "waiting", waiting)
    monkeypatch.setattr(ml, "embed_texts", embed_texts)
    for name in ("faces_waiting", "animals_waiting", "text_waiting"):
        monkeypatch.setattr(ml, name, off)


async def _scene(db, user, *, who, lat, lon, when, beach=False):
    """A photo with these people in it, taken there and then."""
    from app.custom_models.embedding import vector_literal
    from app.photos import places
    from app.photos.library import sync
    from app.photos.models import PhotoAsset

    fid = await _photo(db, user, lat=lat, lon=lon, preview=_webp((10, 20, 30)))
    await db.execute(text("UPDATE file_media SET taken_at = :t WHERE file_id = :f"), {"t": when, "f": fid})
    await sync(db, fid)
    a = await db.get(PhotoAsset, fid)
    a.place_id = await places.nearest(db, lat, lon)
    for pid in who:
        await db.execute(
            text(
                "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, embedding, person_id, assigned_by) "
                "VALUES (:f, :u, 0.1, 0.1, 0.2, 0.2, 0.9, 100, 't', CAST(:v AS vector), :p, 'user')"
            ),
            {"f": fid, "u": user.id, "v": vector_literal(_unit(0)[:512]), "p": pid},
        )
    await db.execute(
        text("INSERT INTO photo_embeddings (file_id, model, embedding) VALUES (:f, 'fake-siglip@1', CAST(:v AS vector))"),
        {"f": fid, "v": vector_literal(_unit(0) if beach else _unit(5))},
    )
    await db.commit()
    return fid


@pytest.mark.asyncio
async def test_me_and_my_wife_at_noosa(client, db, user, root, fake_ml):
    from app.photos import places

    _gazetteer(places.local_dir())
    await places.load(db)
    me = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name, linked_user_id) VALUES (:u, 'person', 'Tristan', :u) RETURNING id"), {"u": user.id})
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.execute(
        text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, 'my wife', 'spouse')"),
        {"u": user.id, "p": sarah},
    )
    await db.commit()
    dec22 = datetime(2022, 12, 27, 2, tzinfo=timezone.utc)
    both_noosa = await _scene(db, user, who=[me, sarah], lat=-26.39, lon=153.09, when=dec22, beach=True)
    me_noosa = await _scene(db, user, who=[me], lat=-26.40, lon=153.10, when=dec22)
    both_madrid = await _scene(db, user, who=[me, sarah], lat=40.42, lon=-3.70, when=datetime(2023, 5, 1, tzinfo=timezone.utc))

    async def ask(q):
        r = await client.get("/api/photos/search", params={"q": q}, headers=_auth(user))
        assert r.status_code == 200, r.text
        return r.json()

    got = await ask("me and my wife at Noosa")
    assert [i["id"] for i in got["items"]] == [str(both_noosa)]
    assert got["understood"]["people"] == ["you", "my wife"] and got["understood"]["place"] == "Noosa Heads, Australia"
    chips = {c["kind"]: c["label"] for c in got["items"][0]["chips"]}
    assert chips["place"] == "Noosa Heads, Queensland, Australia" and chips["when"] == "27 Dec 2022"

    # Both of us, anywhere, newest first; just me at Noosa.
    assert [i["id"] for i in (await ask("me and Sarah"))["items"]] == [str(both_madrid), str(both_noosa)]
    assert {i["id"] for i in (await ask("me in Noosa"))["items"]} == {str(both_noosa), str(me_noosa)}

    # Nothing in 2019: the dates are let go, and it says so.
    got = await ask("me and my wife at Noosa in 2019")
    assert [i["id"] for i in got["items"]] == [str(both_noosa)] and got["relaxed"] == ["any date"]

    # What it looks like ranks within the filters.
    got = await ask("me at Noosa on the beach")
    assert [i["id"] for i in got["items"]][0] == str(both_noosa)

    # Who it doesn't know is said, not guessed.
    got = await ask("me and Zed")
    assert any("Zed" in u for u in got["unresolved"])


@pytest.mark.asyncio
async def test_only_your_own_photos(client, db, user, root, fake_ml):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    theirs = await _scene(db, other, who=[], lat=-26.39, lon=153.09, when=datetime(2022, 1, 1, tzinfo=timezone.utc), beach=True)
    got = (await client.get("/api/photos/search", params={"q": "beach"}, headers=_auth(user))).json()
    assert str(theirs) not in {i["id"] for i in got["items"]}
