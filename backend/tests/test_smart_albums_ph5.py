"""Smart albums (PH-5): "Always add Sarah" and "Max at the beach" stay
correct as photos arrive; what the owner takes out stays out; what they put
in by hand stays in; a rename doesn't break it."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

T = datetime(2024, 3, 1, tzinfo=timezone.utc)


async def _items(client, user, album_id):
    got = (await client.get(f"/api/photos/albums/{album_id}/items", headers=_auth(user))).json()
    return {i["id"] for i in got["items"]}


@pytest.mark.asyncio
async def test_always_add_sarah(client, db, user, root, fake_ml):
    from app.photos import smart

    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    one = await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=T)
    nobody = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=T)

    r = await client.post("/api/photos/albums", json={"title": "Sarah", "q": "Sarah"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    album = r.json()
    assert album["smart"]["summary"] == "Sarah" and album["smart"]["rules"]["people"] == [f"id:{sarah}"]
    assert await _items(client, user, album["id"]) == {str(one)}

    # A new photo of her arrives: in it goes (at the next refresh).
    two = await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=T)
    await db.execute(text("UPDATE albums SET rules_checked_at = NULL"))
    await db.commit()
    await smart.refresh_due(budget=10)
    assert await _items(client, user, album["id"]) == {str(one), str(two)}

    # Renamed: still her album.
    await db.execute(text("UPDATE photo_people SET name = 'Sarah J' WHERE id = :p"), {"p": sarah})
    await db.commit()
    got = (await client.get(f"/api/photos/albums/{album['id']}", headers=_auth(user))).json()
    assert got["smart"]["summary"] == "Sarah J"

    # Taken out by hand: stays out. Put in by hand: stays in.
    await client.request("DELETE", f"/api/photos/albums/{album['id']}/items", json={"file_ids": [str(one)]}, headers=_auth(user))
    await client.post(f"/api/photos/albums/{album['id']}/items", json={"file_ids": [str(nobody)]}, headers=_auth(user))
    await db.execute(text("UPDATE albums SET rules_checked_at = NULL"))
    await db.commit()
    await smart.refresh_due(budget=10)
    assert await _items(client, user, album["id"]) == {str(two), str(nobody)}

    # She's no longer in a photo (a wrong face): out of the album.
    await db.execute(text("DELETE FROM photo_faces WHERE file_id = :f"), {"f": two})
    await db.commit()
    await db.execute(text("UPDATE albums SET rules_checked_at = NULL"))
    await db.commit()
    await smart.refresh_due(budget=10)
    assert await _items(client, user, album["id"]) == {str(nobody)}


@pytest.mark.asyncio
async def test_max_at_the_beach_and_the_preview(client, db, user, root, fake_ml):
    max_ = await db.scalar(text("INSERT INTO photo_people (user_id, kind, species, name) VALUES (:u, 'pet', 'dog', 'Max') RETURNING id"), {"u": user.id})
    await db.commit()

    async def with_max(beach):
        fid = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=T, beach=beach)
        await db.execute(
            text(
                "INSERT INTO photo_animals (file_id, user_id, species, box_x, box_y, box_w, box_h, score, size_px, model, "
                "embedding, embedding_dino, pet_id, assigned_by) SELECT :f, :u, 'dog', 0.1, 0.1, 0.5, 0.5, 0.9, 300, 't', "
                "e.embedding, CAST(:d AS vector), :p, 'user' FROM photo_embeddings e WHERE e.file_id = :f"
            ),
            {"f": fid, "u": user.id, "p": max_, "d": "[" + ",".join(["0.051"] * 384) + "]"},
        )
        await db.commit()
        return fid

    beach = await with_max(True)
    await with_max(False)
    rules = {"pets": [f"id:{max_}"], "looks_like": "on the beach"}
    p = (await client.post("/api/photos/albums/preview", json={"rules": rules}, headers=_auth(user))).json()
    assert p["count"] == 1 and [s["id"] for s in p["sample"]] == [str(beach)] and p["summary"] == "Max · on the beach"
    r = await client.post("/api/photos/albums", json={"title": "Max at the beach", "rules": rules}, headers=_auth(user))
    assert await _items(client, user, r.json()["id"]) == {str(beach)}

    # Nobody called Zed: said, not an empty album.
    r = await client.post("/api/photos/albums", json={"title": "Zed", "q": "me and Zed"}, headers=_auth(user))
    assert r.status_code == 422 and "Zed" in r.json()["detail"]
