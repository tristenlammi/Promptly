"""People and pets (PH-3): faces cluster into people (a stranger in the
background doesn't); the owner names, merges, corrects — and their word
stands; pets are matched closed-set against the photos the owner named, and
an unsure one is asked, never guessed."""
from __future__ import annotations

import uuid

import numpy as np
import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401

RNG = np.random.default_rng(3)


def _vec(axis: int, dim: int, noise: float = 0.15) -> str:
    v = np.zeros(dim)
    v[axis] = 1.0
    v += RNG.normal(0, noise / np.sqrt(dim), dim) * np.sqrt(dim) * 0.1
    v /= np.linalg.norm(v)
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


async def _face(db, user, axis, *, size=120, score=0.95):
    fid = await _photo(db, user, preview=_webp((180, 150, 120)))
    oid = await db.scalar(
        text(
            "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, embedding) "
            "VALUES (:f, :u, 0.3, 0.3, 0.2, 0.25, :s, :px, 'test', CAST(:v AS vector)) RETURNING id"
        ),
        {"f": fid, "u": user.id, "s": score, "px": size, "v": _vec(axis, 512)},
    )
    await db.commit()
    return oid


async def _animal(db, user, species, axis, mix=None):
    fid = await _photo(db, user, preview=_webp((150, 120, 90)))
    e = np.zeros(768)
    d = np.zeros(384)
    if mix is None:
        e[axis], d[axis] = 1.0, 1.0
    else:  # halfway between two pets: an unsure one
        for a in mix:
            e[a], d[a] = 1.0, 1.0
    e += RNG.normal(0, 0.02, 768)
    d += RNG.normal(0, 0.02, 384)
    lit = lambda v: "[" + ",".join(f"{x:.6f}" for x in v / np.linalg.norm(v)) + "]"  # noqa: E731
    oid = await db.scalar(
        text(
            "INSERT INTO photo_animals (file_id, user_id, species, box_x, box_y, box_w, box_h, score, size_px, model, "
            "embedding, embedding_dino) VALUES (:f, :u, :sp, 0.2, 0.2, 0.5, 0.5, 0.9, 300, 'test', CAST(:e AS vector), "
            "CAST(:d AS vector)) RETURNING id"
        ),
        {"f": fid, "u": user.id, "sp": species, "e": lit(e), "d": lit(d)},
    )
    await db.commit()
    return oid


async def _person_of(db, face):
    return await db.scalar(text("SELECT person_id FROM photo_faces WHERE id = :f"), {"f": face})


@pytest.mark.asyncio
async def test_faces_become_people_and_the_owner_has_the_last_word(client, db, user, root):
    from app.photos import people

    me = await db.get(type(user), user.id)
    me.settings = {**(me.settings or {}), "photos_faces": True}
    await db.commit()
    sarah = [await _face(db, user, 0) for _ in range(5)]
    tom = [await _face(db, user, 1) for _ in range(4)]
    stranger = await _face(db, user, 2)
    await people.cluster(budget=20)
    s = {await _person_of(db, f) for f in sarah}
    t = {await _person_of(db, f) for f in tom}
    assert len(s) == 1 and None not in s and len(t) == 1 and None not in t and s != t
    assert await _person_of(db, stranger) is None  # one face: nobody's

    got = (await client.get("/api/photos/people", headers=_auth(user))).json()["people"]
    assert sorted(p["photos"] for p in got) == [4, 5] and all(p["name"] is None and p["cover"] for p in got)
    review = (await client.get("/api/photos/people/review", headers=_auth(user))).json()["people"]
    assert [p["photos"] for p in review if p["kind"] == "person"] == [5, 4]

    sid, tid = s.pop(), t.pop()
    r = await client.patch(f"/api/photos/people/{sid}", json={"name": "Sarah"}, headers=_auth(user))
    assert r.json()["name"] == "Sarah"
    assert (await client.patch(f"/api/photos/people/{tid}", json={"me": True}, headers=_auth(user))).json()["me"] is True

    # "Not Sarah": out, and never suggested for her again.
    await client.post(f"/api/photos/faces/{sarah[0]}/not", json={"person_id": str(sid)}, headers=_auth(user))
    await people.cluster(budget=20)
    assert await _person_of(db, sarah[0]) != sid
    # "This is Bob": a new person by name, and the machine leaves it be.
    r = await client.post(f"/api/photos/faces/{stranger}/person", json={"name": "Bob"}, headers=_auth(user))
    bob = uuid.UUID(r.json()["person_id"])
    await db.execute(text("UPDATE photo_faces SET clustered_at = NULL"))
    await db.commit()
    await people.cluster(budget=20)
    assert await _person_of(db, stranger) == bob
    assert await db.scalar(text("SELECT assigned_by FROM photo_faces WHERE id = :f"), {"f": stranger}) == "user"

    # Tom and Sarah turn out to be one (say): merged, named, still "me".
    r = await client.post(f"/api/photos/people/{tid}/merge", json={"into": str(sid)}, headers=_auth(user))
    assert r.status_code == 200
    person = (await client.get(f"/api/photos/people/{sid}", headers=_auth(user))).json()
    assert person["person"]["name"] == "Sarah" and person["person"]["me"] is True and len(person["items"]) == 8

    # The photo's people, for its info panel.
    who = (await client.get(f"/api/photos/files/{(await db.scalar(text('SELECT file_id FROM photo_faces WHERE id = :f'), {'f': stranger}))}/people", headers=_auth(user))).json()
    assert [o["person"]["name"] for o in who["observations"]] == ["Bob"]

    # The crop People shows.
    from app.photos import crops

    path = await crops.ensure(db, sarah[1], user.id)
    assert path is not None and path.is_file()


@pytest.mark.asyncio
async def test_pets_are_matched_to_the_ones_you_named_or_asked_about(client, db, user, root):
    from app.photos import people

    max_ = [await _animal(db, user, "dog", 5) for _ in range(5)]
    luna = [await _animal(db, user, "dog", 6) for _ in range(5)]
    unsure = await _animal(db, user, "dog", None, mix=(5, 6))
    cat = await _animal(db, user, "cat", 5)  # looks like Max to the vector — but it's a cat

    review = (await client.get("/api/photos/people/review", headers=_auth(user))).json()["people"]
    assert {(p["species"], p["photos"]) for p in review if p["kind"] == "pet"} == {("dog", 11), ("cat", 1)}

    # Name two photos of each.
    r = await client.post(f"/api/photos/faces/{max_[0]}/person", json={"name": "Max"}, headers=_auth(user))
    max_id = r.json()["person_id"]
    await client.post(f"/api/photos/faces/{max_[1]}/person", json={"person_id": max_id}, headers=_auth(user))
    r = await client.post(f"/api/photos/faces/{luna[0]}/person", json={"name": "Luna"}, headers=_auth(user))
    luna_id = r.json()["person_id"]
    await client.post(f"/api/photos/faces/{luna[1]}/person", json={"name": "luna"}, headers=_auth(user))  # same Luna

    await people.match_pets(budget=10)
    pet = lambda a: db.scalar(text("SELECT pet_id::text FROM photo_animals WHERE id = :a"), {"a": a})  # noqa: E731
    assert {await pet(a) for a in max_[2:]} == {max_id}
    assert {await pet(a) for a in luna[2:]} == {luna_id}
    assert await pet(unsure) is None  # asked, not guessed
    assert await pet(cat) is None  # never Max the dog

    pets = (await client.get("/api/photos/people", params={"kind": "pet"}, headers=_auth(user))).json()["people"]
    assert sorted((p["name"], p["photos"], p["species"]) for p in pets) == [("Luna", 5, "dog"), ("Max", 5, "dog")]


def test_the_vector_that_tells_your_pets_apart():
    from app.photos.people import _vec, choose_vector

    a, b = np.eye(8)[0], np.eye(8)[1]
    ex = {
        uuid.uuid4(): {"embedding": [_vec(a + 0.9 * b), _vec(a + 0.9 * b)], "embedding_dino": [_vec(a), _vec(a)]},
        uuid.uuid4(): {"embedding": [_vec(b + 0.9 * a), _vec(a + 0.95 * b)], "embedding_dino": [_vec(b), _vec(b)]},
    }
    assert choose_vector(ex) == "embedding_dino"  # SigLIP can't tell these two apart here


def test_what_a_relationship_label_means():
    from app.photos.people import relation_kind

    cases = {
        "my wife": "spouse", "Husband": "spouse", "my girlfriend": "partner", "our son": "child", "my baby": "child",
        "Mum": "parent", "dad": "parent", "my little sister": "sibling", "Grandma": "grandparent", "nana": "grandparent",
        "my best mate": "friend", "Auntie Jo": "relative", "my boss": "colleague", "the neighbour": "other",
    }
    assert {k: relation_kind(k) for k in cases} == cases


@pytest.mark.asyncio
async def test_relationships_are_yours_and_a_wrong_merge_is_split(client, db, user, root):
    from app.photos import people

    faces = [await _face(db, user, 3) for _ in range(6)]
    await people.cluster(budget=20)
    pid = await _person_of(db, faces[0])
    other = (await client.post(f"/api/photos/faces/{faces[0]}/person", json={"name": "Ana"}, headers=_auth(user))).json()

    # "My wife" — and only one person is.
    r = await client.put(f"/api/photos/people/{pid}/relationship", json={"label": "my wife"}, headers=_auth(user))
    assert r.json() == {"relationship": "my wife", "kind": "spouse"}
    await client.put(f"/api/photos/people/{other['person_id']}/relationship", json={"label": "wife"}, headers=_auth(user))
    rows = (await db.execute(text("SELECT person_id::text, kind FROM photo_relationships WHERE viewer_user_id = :u"), {"u": user.id})).all()
    assert rows == [(other["person_id"], "spouse")]
    listed = (await client.get("/api/photos/people", headers=_auth(user))).json()["people"]
    assert {p["name"]: p["relationship"] for p in listed if p["name"]} == {"Ana": "wife"}

    # Two of the cluster's faces are someone else: split off, named.
    got = (await client.get(f"/api/photos/people/{pid}/faces", headers=_auth(user))).json()["faces"]
    move = [f["id"] for f in got[:2]]
    r = await client.post(f"/api/photos/people/{pid}/split", json={"observation_ids": move, "name": "Bea"}, headers=_auth(user))
    bea = r.json()["into"]
    for f in move:
        assert str(await _person_of(db, uuid.UUID(f))) == bea
    # …for good: re-clustering never puts them back.
    await db.execute(text("UPDATE photo_faces SET clustered_at = NULL WHERE assigned_by IS DISTINCT FROM 'user'"))
    await db.commit()
    await people.cluster(budget=20)
    for f in move:
        assert str(await _person_of(db, uuid.UUID(f))) == bea
