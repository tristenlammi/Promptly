"""Food, currency, units and time format, set once (app/items/shared.py)."""
from __future__ import annotations

import copy

import httpx
import pytest


async def _open(db, user, kind):
    from app.items import service

    await service.open_app(db, user, kind)
    return await service.primary_file(db, user, kind)


async def _save(db, user, row, doc, change):
    from app.items import service

    data = copy.deepcopy(doc.data)
    change(data)
    await service.save_data(db, user, row, doc, data, base_revision=doc.revision)
    await db.commit()


async def _data(db, doc):
    await db.refresh(doc)
    return doc.data


async def test_diet_follows_between_macros_and_meal_plan(db, user):
    m_row, meals = await _open(db, user, "meals")
    p_row, plan = await _open(db, user, "mealplan")
    await db.commit()

    def set_diet(d):
        d["profile"].update(diet_tags=["vegetarian"], allergies="Peanuts, shellfish", dislikes="olives")

    await _save(db, user, m_row, meals, set_diet)
    prefs = (await _data(db, plan))["preferences"]
    assert prefs["diets"] == ["vegetarian"]
    assert prefs["allergies"] == ["peanuts", "shellfish"]
    assert prefs["dislikes"] == ["olives"]

    # …and back: a dislike added in Meal Plan shows in Macros.
    def more(d):
        d["preferences"]["dislikes"] = ["olives", "coriander"]

    await _save(db, user, p_row, plan, more)
    assert (await _data(db, meals))["profile"]["dislikes"] == "olives, coriander"
    assert user.settings["diet"]["dislikes"] == ["olives", "coriander"]


async def test_currency_follows_between_account_budget_and_trip(db, user):
    b_row, budget = await _open(db, user, "budget")
    t_row, trip = await _open(db, user, "trip")
    await db.commit()

    def nzd(d):
        d["settings"]["currency"] = "NZD"

    await _save(db, user, b_row, budget, nzd)
    assert (await _data(db, trip))["settings"]["home_currency"] == "NZD"
    assert user.settings["currency"] == "NZD"


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


def _hdr(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_account_units_and_time_reach_every_app(db, user, client):
    h_row, health = await _open(db, user, "health")
    t_row, trip = await _open(db, user, "trip")
    m_row, meals = await _open(db, user, "meals")
    await db.commit()

    r = await client.patch("/api/auth/me/preferences", headers=_hdr(user), json={"units": "imperial", "clock": "24h", "currency": "USD"})
    assert r.status_code == 200, r.text
    h = await _data(db, health)
    assert h["settings"]["temp_unit"] == "f" and h["settings"]["water_unit"] == "oz"
    assert h["settings"]["weight_unit"] == "lb" and h["settings"]["length_unit"] == "in"
    t = await _data(db, trip)
    assert t["settings"]["distance"] == "mi" and t["settings"]["clock"] == "24h" and t["settings"]["home_currency"] == "USD"
    assert (await _data(db, meals))["settings"]["water_unit"] == "floz"

    # Trip's own 12h / 24h is the account's time format.
    def twelve(d):
        d["settings"]["clock"] = "12h"

    await _save(db, user, t_row, trip, twelve)
    me = (await client.get("/api/auth/me", headers=_hdr(user))).json()
    assert me["settings"]["clock"] == "12h"


async def test_new_files_start_with_the_account_choices(db, user, client):
    r = await client.patch("/api/auth/me/preferences", headers=_hdr(user), json={"units": "imperial", "currency": "GBP"})
    assert r.status_code == 200, r.text
    await db.refresh(user)  # the request changed it in its own session
    _row, plan = await _open(db, user, "mealplan")
    _row, budget = await _open(db, user, "budget")
    await db.commit()
    assert plan.data["preferences"]["units"] == "imperial"
    assert budget.data["settings"]["currency"] == "GBP"


async def test_existing_choices_fill_gaps_only(db, user):
    from app.items import shared

    m_row, meals = await _open(db, user, "meals")
    p_row, plan = await _open(db, user, "mealplan")
    meals.data = {**meals.data, "profile": {**meals.data["profile"], "diet_tags": ["vegan"]}}
    s = dict(user.settings or {})
    s.pop("diet", None)
    s.pop(shared.SEED_FLAG, None)
    user.settings = s
    await db.commit()

    await shared.seed(db, user)
    await db.commit()
    assert (await _data(db, plan))["preferences"]["diets"] == ["vegan"]
    assert user.settings["diet"]["diets"] == ["vegan"]
