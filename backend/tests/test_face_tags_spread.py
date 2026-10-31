"""Tagging a face spreads (Photos people): "this is Sarah" on one face brings
the unnamed group it was in along, and her look-alikes in other unnamed
groups or nobody's are filed too — when sure. A face close to two named
people, or near but not close enough, is asked about in the review, never
guessed; the owner's confirmations and "not them" always stand. New faces
join a named person over an unnamed group. And pets: one tag, the rest
follow."""
from __future__ import annotations

import uuid

import numpy as np
import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _webp
from tests.test_photo_people_ph3 import _animal, _face
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401

RNG = np.random.default_rng(11)


async def _face_mix(db, user, weights: dict[int, float], *, person=None, by=None):
    """A face whose vector is a blend of axes (a little noise)."""
    v = np.zeros(512)
    for axis, w in weights.items():
        v[axis] = w
    v = v / np.linalg.norm(v) + RNG.normal(0, 0.01, 512)
    v /= np.linalg.norm(v)
    fid = await _photo(db, user, preview=_webp((180, 150, 120)))
    oid = await db.scalar(
        text(
            "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, embedding, "
            "person_id, assigned_by, clustered_at) VALUES (:f, :u, 0.3, 0.3, 0.2, 0.25, 0.95, 120, 'test', "
            "CAST(:v AS vector), :p, :by, now()) RETURNING id"
        ),
        {"f": fid, "u": user.id, "v": "[" + ",".join(f"{x:.6f}" for x in v) + "]", "p": person, "by": by},
    )
    await db.commit()
    return oid


async def _group(db, user, faces, *, name=None, by="auto"):
    """File faces under a (new) person directly — an unnamed group by default."""
    pid = await db.scalar(
        text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', :n) RETURNING id"),
        {"u": user.id, "n": name},
    )
    await db.execute(
        text("UPDATE photo_faces SET person_id = :p, assigned_by = :by, clustered_at = now() WHERE id = ANY(:ids)"),
        {"p": pid, "by": by, "ids": list(faces)},
    )
    await db.commit()
    return pid


async def _who(db, face):
    return await db.scalar(text("SELECT person_id FROM photo_faces WHERE id = :f"), {"f": face})


async def _by(db, face):
    return await db.scalar(text("SELECT assigned_by FROM photo_faces WHERE id = :f"), {"f": face})


async def _tag(client, user, face, **who):
    r = await client.post(f"/api/photos/faces/{face}/person", json=who, headers=_auth(user))
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["person_id"])


@pytest.mark.asyncio
async def test_tagging_one_face_brings_its_group_along(client, db, user, root):
    from app.photos import people

    faces = [await _face(db, user, 0) for _ in range(5)]
    await people.cluster(budget=20)
    group = await _who(db, faces[0])
    assert group is not None and {await _who(db, f) for f in faces} == {group}

    sarah = await _tag(client, user, faces[0], name="Sarah")
    assert {await _who(db, f) for f in faces} == {sarah}
    assert await _by(db, faces[0]) == "user" and {await _by(db, f) for f in faces[1:]} == {"auto"}
    assert await db.scalar(text("SELECT count(*) FROM photo_people WHERE id = :g"), {"g": group}) == 0


@pytest.mark.asyncio
async def test_a_look_alike_group_and_loose_faces_follow_but_not_someone_else(client, db, user, root):
    g1_faces = [await _face_mix(db, user, {0: 1}) for _ in range(3)]
    g2_faces = [await _face_mix(db, user, {0: 1}) for _ in range(3)]
    other_faces = [await _face_mix(db, user, {1: 1}) for _ in range(3)]
    await _group(db, user, g1_faces)
    g2 = await _group(db, user, g2_faces)
    g3 = await _group(db, user, other_faces)
    loose = await _face_mix(db, user, {0: 1})

    sarah = await _tag(client, user, g1_faces[0], name="Sarah")
    assert {await _who(db, f) for f in g1_faces + g2_faces + [loose]} == {sarah}
    assert await db.scalar(text("SELECT count(*) FROM photo_people WHERE id = :g"), {"g": g2}) == 0
    assert {await _who(db, f) for f in other_faces} == {g3}  # someone else stays who they were


@pytest.mark.asyncio
async def test_a_face_close_to_two_named_people_is_asked_not_filed(client, db, user, root):
    sarah_faces = [await _face_mix(db, user, {0: 1}) for _ in range(3)]
    tom_faces = [await _face_mix(db, user, {1: 1}) for _ in range(2)]
    tom = await _group(db, user, tom_faces, name="Tom", by="user")
    both = await _face_mix(db, user, {0: 1, 1: 0.9})  # looks like either (a little more like Sarah)
    near = await _face_mix(db, user, {0: 1, 7: 1.8})  # a bit like Sarah, not enough
    mixed = [await _face_mix(db, user, {0: 1, 1: 0.95}) for _ in range(3)]
    mixed_group = await _group(db, user, mixed)

    sarah = await _tag(client, user, sarah_faces[0], name="Sarah")
    await _tag(client, user, sarah_faces[1], person_id=str(sarah))
    assert await _who(db, sarah_faces[2]) == sarah  # the clear one is filed
    assert await _who(db, both) is None and await _who(db, near) is None
    assert {await _who(db, f) for f in mixed} == {mixed_group}

    review = (await client.get("/api/photos/people/review", headers=_auth(user))).json()["people"]
    asks = [e for e in review if e.get("suggest")]
    loose = [e for e in asks if e["id"] is None]
    assert len(loose) == 1 and loose[0]["suggest"]["name"] == "Sarah"
    assert {s["id"] for s in loose[0]["samples"]} == {str(both), str(near)}
    grp = next(e for e in review if e["id"] == str(mixed_group))
    assert grp["suggest"]["name"] == "Sarah"  # "Is this Sarah?" — a question
    assert review[0].get("suggest")  # questions first

    # "No": never asked about Sarah again for those faces.
    for f in (both, near):
        r = await client.post(f"/api/photos/faces/{f}/not", json={"person_id": str(sarah)}, headers=_auth(user))
        assert r.status_code == 200
    review = (await client.get("/api/photos/people/review", headers=_auth(user))).json()["people"]
    for e in review:
        if e["id"] is None and e.get("suggest", {}).get("name") == "Sarah":
            assert not {s["id"] for s in e["samples"]} & {str(both), str(near)}
    assert await _who(db, tom_faces[0]) == tom


@pytest.mark.asyncio
async def test_the_owners_word_and_not_them_are_never_overridden(client, db, user, root):
    x = await _face_mix(db, user, {0: 1})
    tom_faces = [await _face_mix(db, user, {1: 1}) for _ in range(2)]
    tom = await _group(db, user, [x, *tom_faces], name="Tom", by="user")  # the owner said x is Tom
    y = await _face_mix(db, user, {0: 1})
    vouched = [await _face_mix(db, user, {0: 1}) for _ in range(2)]
    unnamed_vouched = await _group(db, user, vouched)
    await db.execute(text("UPDATE photo_faces SET assigned_by = 'user' WHERE id = :f"), {"f": vouched[0]})
    await db.commit()
    seed = await _face_mix(db, user, {0: 1})
    sarah = await db.scalar(
        text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id}
    )
    await db.execute(text("INSERT INTO photo_rejections (person_id, observation_id) VALUES (:p, :f)"), {"p": sarah, "f": y})
    await db.commit()

    await _tag(client, user, seed, person_id=str(sarah))
    assert await _who(db, x) == tom and await _by(db, x) == "user"
    assert await _who(db, y) is None  # "not Sarah" stands
    assert {await _who(db, f) for f in vouched} == {unnamed_vouched}  # a group the owner vouched for stays

    # A group with a face said not to be Sarah: tagging another of its faces
    # brings the rest, not that one.
    g = [await _face_mix(db, user, {2: 1}) for _ in range(3)]
    grp = await _group(db, user, g)
    await db.execute(text("INSERT INTO photo_rejections (person_id, observation_id) VALUES (:p, :f)"), {"p": sarah, "f": g[2]})
    await db.commit()
    await _tag(client, user, g[0], person_id=str(sarah))
    assert await _who(db, g[1]) == sarah and await _who(db, g[2]) == grp


@pytest.mark.asyncio
async def test_new_faces_join_the_named_person_over_an_unnamed_group(db, user, root):
    from app.photos import people

    confirmed = [await _face_mix(db, user, {0: 1}) for _ in range(2)]
    sarah = await _group(db, user, confirmed, name="Sarah", by="user")
    others = [await _face_mix(db, user, {0: 1}) for _ in range(3)]
    await _group(db, user, others)
    new = await _face(db, user, 0)
    await people.cluster(budget=20)
    assert await _who(db, new) == sarah


def test_the_vote_between_neighbours():
    from app.photos.people import _vote

    s, t, g = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    f = lambda: uuid.uuid4()  # noqa: E731
    # A named person with real support wins over a bigger unnamed group…
    assert _vote([(f(), g, 0.8, False, False), (f(), g, 0.75, False, False), (f(), s, 0.7, True, True)], set()) == s
    # …but not with a lone, faint auto face.
    assert _vote([(f(), g, 0.8, False, False), (f(), g, 0.75, False, False), (f(), s, 0.52, False, True)], set()) == g
    # Two named people neck and neck: asked.
    assert _vote([(f(), s, 0.7, True, True), (f(), t, 0.68, True, True)], set()) == "ask"
    # "Not Sarah" takes her out of the vote.
    assert _vote([(f(), s, 0.9, True, True), (f(), g, 0.6, False, False)], {s}) == g
    assert _vote([(f(), None, 0.9, False, False)], set()) is None


@pytest.mark.asyncio
async def test_one_pet_tag_and_the_rest_follow(client, db, user, root):
    from app.photos import people

    dogs = [await _animal(db, user, "dog", 5) for _ in range(4)]
    stranger = await _animal(db, user, "dog", 9)
    await people.match_pets(budget=10)  # nobody named yet: nothing happens
    r = await client.post(f"/api/photos/faces/{dogs[0]}/person", json={"name": "Max"}, headers=_auth(user))
    max_id = r.json()["person_id"]
    await people.match_pets(budget=10)
    pet = lambda a: db.scalar(text("SELECT pet_id::text FROM photo_animals WHERE id = :a"), {"a": a})  # noqa: E731
    by = lambda a: db.scalar(text("SELECT assigned_by FROM photo_animals WHERE id = :a"), {"a": a})  # noqa: E731
    assert {await pet(a) for a in dogs} == {max_id}
    assert {await by(a) for a in dogs[1:]} == {"auto"}
    assert await pet(stranger) is None
    review = (await client.get("/api/photos/people/review", headers=_auth(user))).json()["people"]
    assert [(e["species"], e["photos"]) for e in review if e["kind"] == "pet" and e["id"] is None] == [("dog", 1)]


@pytest.mark.asyncio
async def test_someone_named_before_with_no_confirmed_faces_still_pulls_in_look_alikes_on_the_tick(db, user, root):
    """People named by naming a whole group have only auto faces: their
    clearest faces stand in as examples, and the clustering tick looks
    again for them without anything being tagged."""
    from app.photos import people

    named_auto = [await _face_mix(db, user, {0: 1}) for _ in range(5)]
    sarah = await _group(db, user, named_auto, name="Sarah")  # all 'auto'
    alike = [await _face_mix(db, user, {0: 1}) for _ in range(3)]
    g = await _group(db, user, alike)
    other = [await _face_mix(db, user, {1: 1}) for _ in range(3)]
    g_other = await _group(db, user, other)
    await people.cluster(budget=20)
    assert {await _who(db, f) for f in alike} == {sarah}
    assert {await _by(db, f) for f in alike} == {"auto"}
    assert await db.scalar(text("SELECT count(*) FROM photo_people WHERE id = :g"), {"g": g}) == 0
    assert {await _who(db, f) for f in other} == {g_other}
    # Not looked at again on every tick — only once due (or new faces came).
    assert await people.relook_due(budget=5) == 0
