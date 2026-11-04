"""Health, Macros and Workout share the person's body details and weigh-ins
(app/items/body.py): change one, the other two follow — only in the
person's own files."""
from __future__ import annotations

import copy

import httpx
import pytest


async def _open(db, user, kind):
    from app.items import service

    row, _ = await service.open_app(db, user, kind)
    found = await service.primary_file(db, user, kind)
    assert found is not None and found[0].id == row.id
    return found


async def _save(db, user, row, doc, change):
    from app.items import service

    data = copy.deepcopy(doc.data)
    change(data)
    await service.save_data(db, user, row, doc, data, base_revision=doc.revision)
    await db.commit()


async def _fresh(db, row, doc):
    await db.refresh(doc)
    return doc.data


async def test_profile_and_weighins_follow_across_the_three_apps(db, user):
    h_row, health = await _open(db, user, "health")
    m_row, meals = await _open(db, user, "meals")
    w_row, workout = await _open(db, user, "workout")
    await db.commit()

    # Height and date of birth set in Health reach Macros (and the year Workout).
    def health_profile(d):
        d["profile"].update(height_cm=180.0, birth_date="1990-05-04", sex="male")

    await _save(db, user, h_row, health, health_profile)
    m = await _fresh(db, m_row, meals)
    w = await _fresh(db, w_row, workout)
    assert m["profile"]["height_cm"] == 180.0
    assert m["profile"]["birth_year"] == 1990 and m["profile"]["sex"] == "male"
    assert w["settings"]["birth_year"] == 1990 and w["settings"]["sex"] == "male"

    # A weigh-in logged in Macros shows in Health and is Workout's body weight.
    def weigh(d):
        d["weighins"].append({"date": "2026-11-01", "kg": 82.4})

    await _save(db, user, m_row, meals, weigh)
    h = await _fresh(db, h_row, health)
    w = await _fresh(db, w_row, workout)
    weights = [r for r in h["readings"] if r["metric"] == "weight"]
    assert [(r["at"][:10], r["value"]) for r in weights] == [("2026-11-01", 82.4)]
    assert w["settings"]["bodyweight_kg"] == 82.4

    # Removing it in Health removes it from Macros — it isn't brought back.
    def unweigh(d):
        d["readings"] = [r for r in d["readings"] if r["metric"] != "weight"]

    await _save(db, user, h_row, health, unweigh)
    m = await _fresh(db, m_row, meals)
    assert m["weighins"] == []

    # A new birth year in Workout drops Health's date of birth? No — Health
    # keeps what it had, but the shared copy forgets the stale date.
    def year(d):
        d["settings"]["birth_year"] = 1991

    await _save(db, user, w_row, workout, year)
    from app.items import body

    assert body.public(user)["birth_year"] == 1991
    assert body.public(user)["birth_date"] is None
    m = await _fresh(db, m_row, meals)
    assert m["profile"]["birth_year"] == 1991


async def test_existing_apps_are_merged_once_and_new_ones_start_filled(db, user):
    from app.items import body, service

    m_row, meals = await _open(db, user, "meals")
    # Pretend the sharing came later: Macros already has details, nothing shared yet.
    meals.data = {**meals.data, "profile": {**meals.data["profile"], "height_cm": 165.0, "sex": "female"},
                  "weighins": [{"date": "2026-10-30", "kg": 61.0}]}
    settings = dict(user.settings or {})
    settings.pop("body", None)
    user.settings = settings
    await db.commit()

    await body.seed(db, user)
    await db.commit()
    assert body.public(user)["height_cm"] == 165.0

    # Health made now starts with them.
    h_row, health = await _open(db, user, "health")
    await db.commit()
    assert health.data["profile"]["height_cm"] == 165.0
    assert health.data["profile"]["sex"] == "female"
    assert [r["value"] for r in health.data["readings"] if r["metric"] == "weight"] == [61.0]
    assert service  # (imported for open_app)


async def test_a_file_shared_with_you_is_never_touched(db, user):
    """Someone else's Workout shared with you: your saves to it don't move
    your details into it, and theirs don't land in your apps."""
    from app.auth.models import User
    from app.auth.utils import hash_password
    from app.items import body

    other = User(email="body-other@example.com", username="bodyother", password_hash=hash_password("x" * 16), role="user", settings={})
    db.add(other)
    await db.commit()
    o_row, o_workout = await _open(db, other, "workout")
    m_row, meals = await _open(db, user, "meals")
    await db.commit()

    # The other person (the owner) changes their own Workout: only their apps follow.
    def theirs(d):
        d["settings"]["birth_year"] = 1970

    await _save(db, other, o_row, o_workout, theirs)
    m = await _fresh(db, m_row, meals)
    assert m["profile"]["birth_year"] != 1970

    # You saving into their file (as if it were shared with you) changes nothing of yours.
    before = body.public(user)

    def edit(d):
        d["settings"]["birth_year"] = 1960

    await _save(db, user, o_row, o_workout, edit)
    assert body.public(user) == before


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def test_about_you_endpoint_updates_every_app(db, user, client):
    from app.auth.utils import create_access_token

    hdr = {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}
    m_row, meals = await _open(db, user, "meals")
    await db.commit()

    r = await client.put("/api/items/body", headers=hdr, json={"height_cm": 172, "weight_unit": "lb"})
    assert r.status_code == 200, r.text
    assert r.json()["height_cm"] == 172 and r.json()["weight_unit"] == "lb"
    m = await _fresh(db, m_row, meals)
    assert m["profile"]["height_cm"] == 172
    assert m["settings"]["weight_unit"] == "lb"

    got = (await client.get("/api/items/body", headers=hdr)).json()
    assert got["height_cm"] == 172
