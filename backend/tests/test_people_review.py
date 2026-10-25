"""Naming people and pets from a review card, and faces that are really
animals: a dog's face the detector found isn't kept as a "person" — new
faces are checked as they're found, older ones once — and a review card's
animals can all be named at once, as a pet you already have."""
from __future__ import annotations

import io

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _unit, _webp
from tests.test_photo_people_ph3 import _animal, _face
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


def _halves() -> bytes:
    """A picture red on the left (a person), blue on the right (a dog)."""
    from PIL import Image

    im = Image.new("RGB", (64, 32), (220, 30, 30))
    im.paste((30, 30, 220), (32, 0, 64, 32))
    buf = io.BytesIO()
    im.save(buf, "WEBP", lossless=True)
    return buf.getvalue()


@pytest.fixture
def fake_ml(monkeypatch):
    """Faces at the left and right of every picture; a crop that's mostly
    red looks like a person, mostly blue like an animal."""
    from PIL import Image

    from app.photos import face_check, ml

    async def health(*, fresh=False):
        return {"state": "ready", "model": "fake-siglip@1", "faces": {"state": "ready", "model": "fake-faces@1"}}

    async def embed_images(images):
        out = []
        for raw in images:
            with Image.open(io.BytesIO(raw)) as im:
                r, _g, b = im.convert("RGB").resize((1, 1)).getpixel((0, 0))
            out.append(_unit(0) if r > b else _unit(1))
        return "fake-siglip@1", out

    async def embed_texts(texts):
        return "fake-siglip@1", [_unit(0) if t in face_check.HUMAN else _unit(1) for t in texts]

    async def find_faces(images):
        face = lambda x: {"box": [x, 0.2, 0.3, 0.6], "landmarks": [[x, 0.3]] * 5, "score": 0.95, "size": 90,  # noqa: E731
                          "embedding": _unit(3)[:512]}
        return "fake-faces@1", [[face(0.05), face(0.65)] for _ in images]

    async def ready():
        return None

    async def off():
        return "not in this test"

    for name, fn in (("health", health), ("embed_images", embed_images), ("embed_texts", embed_texts),
                     ("find_faces", find_faces), ("faces_waiting", ready), ("waiting", ready),
                     ("animals_waiting", off), ("text_waiting", off)):
        monkeypatch.setattr(ml, name, fn)


async def _faces_on(db, user, on=True):
    me = await db.get(type(user), user.id)
    me.settings = {**(me.settings or {}), "photos_faces": on}
    await db.commit()


@pytest.mark.asyncio
async def test_a_dogs_face_isnt_kept_as_a_persons(db, user, root, fake_ml):
    from app.photos.models import PhotoUnderstanding
    from app.photos.understanding import tick

    await _faces_on(db, user)
    fid = await _photo(db, user, preview=_halves())
    await tick(budget=20)
    boxes = (await db.execute(text("SELECT box_x FROM photo_faces WHERE file_id = :f"), {"f": fid})).scalars().all()
    assert [round(b, 2) for b in boxes] == [0.05]  # the person, not the dog
    assert (await db.get(PhotoUnderstanding, (fid, "face_check"))).state == "done"


@pytest.mark.asyncio
async def test_animal_faces_found_before_are_removed_once_but_a_named_one_stays(db, user, root, fake_ml):
    from app.photos.models import PhotoUnderstanding
    from app.photos.understanding import tick

    await _faces_on(db, user, on=False)  # only the check runs, not the finding
    person = await _face(db, user, 0)
    dog = await _face(db, user, 1)
    named_dog = await _face(db, user, 1)
    # The test faces sit at (0.3, 0.3): paint their photos red or blue.
    from app.files.derivatives import rendition_path

    for oid, colour in ((person, (220, 30, 30)), (dog, (30, 30, 220)), (named_dog, (30, 30, 220))):
        fid = await db.scalar(text("SELECT file_id FROM photo_faces WHERE id = :o"), {"o": oid})
        rendition_path(fid, "preview.webp").write_bytes(_webp(colour))
    await db.execute(text("UPDATE photo_faces SET assigned_by = 'user' WHERE id = :o"), {"o": named_dog})
    await db.commit()

    await tick(budget=20)
    left = set((await db.execute(text("SELECT id FROM photo_faces"))).scalars().all())
    assert person in left and named_dog in left and dog not in left
    fid = await db.scalar(text("SELECT file_id FROM photo_faces WHERE id = :o"), {"o": person})
    assert (await db.get(PhotoUnderstanding, (fid, "face_check"))).state == "done"


@pytest.mark.asyncio
async def test_a_review_cards_animals_are_named_at_once_as_an_existing_pet(client, db, user, root):
    a1 = await _animal(db, user, "dog", 0)
    a2 = await _animal(db, user, "dog", 0)
    a3 = await _animal(db, user, "dog", 0)
    r = await client.post("/api/photos/faces/assign", json={"observation_ids": [str(a1), str(a2)], "name": "Bumi"},
                          headers=_auth(user))
    assert r.status_code == 200 and r.json()["assigned"] == 2
    bumi = r.json()["person_id"]
    # Later: "that's Bumi too" — the one you have, not a second Bumi.
    r = await client.post("/api/photos/faces/assign", json={"observation_ids": [str(a3)], "person_id": bumi},
                          headers=_auth(user))
    assert r.json()["person_id"] == bumi
    pets = (await db.execute(text("SELECT pet_id FROM photo_animals WHERE id = ANY(:i)"), {"i": [a1, a2, a3]})).scalars().all()
    assert {str(p) for p in pets} == {bumi}
    assert await db.scalar(text("SELECT count(*) FROM photo_people WHERE user_id = :u AND name = 'Bumi'"), {"u": user.id}) == 1

    # A person and an animal together isn't one answer.
    face = await _face(db, user, 0)
    r = await client.post("/api/photos/faces/assign", json={"observation_ids": [str(face), str(a1)], "name": "Bumi"},
                          headers=_auth(user))
    assert r.status_code == 400
