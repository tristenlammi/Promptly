"""Forms phase 2, WP-F2.2: the Location question.

* answers: text cap, coordinate ranges, rounding to 5 decimals, spots only
  for a picked suggestion;
* the public place search ``GET /api/f/{token}/places``: Photon only (a
  respondent with saved places, recents and contacts gets none of them
  back, and neither do the owner's), the same 404 for a closed, trashed
  or Location-less form, the per-person limit, Maps down → an empty list,
  "suburb or town" filtering, the cache;
* the owner's side: summary places, ``GET /forms/{id}/places`` (read
  grant yes, no grant 404), downloads with a "(map)" column;
* ``read_form_responses`` shows the words only, never a spot.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


def loc(iid="where", ask="address", required=False, title="Where do you live?"):
    return {"id": iid, "kind": "location", "title": title, "description": "", "image_asset_id": None,
            "required": required, "config": {"ask": ask}, "deleted": False}


def short(iid="name"):
    return {"id": iid, "kind": "short_text", "title": "Name", "description": "", "image_asset_id": None,
            "required": False, "config": {}, "deleted": False}


def defn(items):
    return {"version": 1, "title": "Location test", "description": "", "after": "continue",
            "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
            "items": items}


def feature(name, lat, lon, kind="house", **props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"name": name, "type": kind, "osm_key": "place" if kind in ("city", "district", "locality") else "building",
                           **props}}


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify, sheet
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
    monkeypatch.setattr(sheet, "sync_soon", lambda form: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def photon(monkeypatch):
    """A fake Photon: records each call, answers with ``photon.features``."""
    from app.maps import engine

    class Fake:
        features: list = []
        calls: list = []
        down = False

        async def __call__(self, path, params):
            self.calls.append((path, dict(params)))
            if self.down:
                from fastapi import HTTPException

                raise HTTPException(503, "Maps aren't ready on this server yet.")
            return list(self.features)

    fake = Fake()
    fake.features = [
        feature("12 Smith Street", -42.882131234, 147.3271987, housenumber="12", street="Smith Street", city="Hobart", state="Tasmania"),
        feature("Sandy Bay", -42.9, 147.33, kind="district", state="Tasmania"),
        feature("Hobart", -42.88, 147.32, kind="city", state="Tasmania"),
        feature("Salamanca Market", -42.887, 147.331, kind="other", osm_key="amenity", osm_value="marketplace"),
    ]
    monkeypatch.setattr(engine, "photon", fake)
    return fake


async def make_form(client, owner, definition, **settings):
    r = await client.post("/api/forms", json={}, headers=H(owner))
    fid = r.json()["file"]["id"]
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": definition, "data_version": 1},
                         headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, **settings}, headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))
    view = r.json()
    return fid, uuid.UUID(view["form"]["id"]), view["link"]["token"]


async def send(client, form_id, token, answers, who=None):
    from app.forms import abuse

    body = {"answers": answers, "submit_id": str(uuid.uuid4()),
            "start_token": abuse.start_token(form_id, now=time.time() - 30)}
    return await client.post(f"/api/f/{token}/submit", json=body, headers=H(who) if who else {})


async def mk_user(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


# ------------------------------------------------------------------ answers
def test_location_answer_checks():
    from app.forms import answering as ans
    from app.forms.definition import DefinitionError, validate_definition

    d = validate_definition(defn([loc()]))
    item = d["items"][0]
    assert item["config"] == {"ask": "address"}
    with pytest.raises(DefinitionError):
        validate_definition(defn([{**loc(), "config": {"ask": "gps"}}]))

    def err(v):
        with pytest.raises(ans.AnswerError) as e:
            ans.check_one(item, v)
        return str(e.value)

    # Typed: words only, extra spaces tidied, coordinates dropped.
    assert ans.check_one(item, {"text": "  12  Smith St ", "picked": False, "lat": 1, "lon": 2}) == {
        "text": "12 Smith St", "picked": False}
    # Picked: rounded to 5 decimals (about a metre).
    assert ans.check_one(item, {"text": "12 Smith St, Hobart", "lat": -42.882131234, "lon": 147.3271987, "picked": True}) == {
        "text": "12 Smith St, Hobart", "lat": -42.88213, "lon": 147.3272, "picked": True}
    assert err({"text": "x" * 301, "picked": False}) == "Keep the place to 300 characters or fewer."
    assert "spot on the map" in err({"text": "Somewhere", "lat": 91, "lon": 0, "picked": True})
    assert "spot on the map" in err({"text": "Somewhere", "lat": 0, "lon": 181, "picked": True})
    assert "spot on the map" in err({"text": "Somewhere", "lat": "1", "lon": 2, "picked": True})
    assert "spot on the map" in err({"text": "Somewhere", "picked": True})
    assert err({"text": "x", "picked": False, "accuracy": 3}) == "Type the place again."
    assert err("12 Smith St") == "Type the place again."
    assert ans.is_empty(item, {"text": "   ", "picked": False})
    with pytest.raises(ans.AnswerError) as e:
        ans.check_answers(validate_definition(defn([loc(required=True)])), {"where": {"text": " ", "picked": False}})
    assert str(e.value) == "This question needs an answer."


# ------------------------------------------------------------------ the public place search
async def test_place_search_is_photon_only(client, db, user, photon):
    """A signed-in respondent who has saved places, recents and contacts
    gets none of them back — and nor does anyone get the owner's."""
    from app.maps.models import MapPlace, MapRecent

    respondent = await mk_user(db, "resp")
    for who in (user, respondent):
        db.add(MapPlace(user_id=who.id, kind="home", name="Home", address="1 Secret Lane, Hobart", lat=-42.8, lon=147.3))
        db.add(MapRecent(user_id=who.id, key=f"k{uuid.uuid4().hex[:8]}", name="Smith St doctor", address="9 Smith St", lat=-42.85, lon=147.31))
    await db.commit()

    import app.maps.router as maps_router

    async def boom(*a, **k):
        raise AssertionError("find_places must never be used for a form")

    maps_router.find_places, saved = boom, maps_router.find_places
    try:
        fid, form_id, token = await make_form(client, user, defn([loc()]), audience="server")
        r = await client.get(f"/api/f/{token}/places", params={"q": "Smith", "lat": -42.8812, "lon": 147.3199},
                             headers=H(respondent))
    finally:
        maps_router.find_places = saved
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["maps"] is True
    names = [x["name"] for x in body["results"]]
    assert "Home" not in names and "Smith St doctor" not in names
    assert names[0] == "12 Smith Street"  # an address question puts houses and streets first
    assert all(set(x) == {"kind", "name", "address", "category", "lat", "lon"} for x in body["results"])
    # Only Photon was asked, near a rounded spot.
    [(path, params)] = photon.calls
    assert path == "/api" and params["q"] == "Smith" and (params["lat"], params["lon"]) == (-42.88, 147.32)


async def test_place_search_town_filter_cache_and_limits(client, db, user, photon, monkeypatch):
    from app import rate_limit
    from app.forms import places

    fid, form_id, token = await make_form(client, user, defn([loc("town", ask="town")]), audience="link")
    r = await client.get(f"/api/f/{token}/places", params={"q": "Hob"})
    assert [x["name"] for x in r.json()["results"]] == ["Sandy Bay", "Hobart"]
    assert photon.calls[0][1]["layer"] == ["city", "district", "locality"]
    # Cached for the same words.
    r = await client.get(f"/api/f/{token}/places", params={"q": "  hob "})
    assert len(photon.calls) == 1 and len(r.json()["results"]) == 2
    # q is 2–120 characters.
    assert (await client.get(f"/api/f/{token}/places", params={"q": "H"})).status_code == 422
    assert (await client.get(f"/api/f/{token}/places", params={"q": "x" * 121})).status_code == 422
    # The per-form-per-person limit, in Redis with a TTL.
    monkeypatch.setattr(places, "PER_PERSON_PER_HOUR", 3)
    rate_limit._settings.RATE_LIMIT_ENABLED = True
    try:
        codes = [(await client.get(f"/api/f/{token}/places", params={"q": f"Ho{i}"},
                                   headers={"X-Real-IP": "203.0.113.9"})).status_code for i in range(4)]
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = False
    assert codes == [200, 200, 200, 429]
    from app.redis_client import redis

    ttl = await redis.ttl(places._who(form_id, None, "203.0.113.9"))
    assert 0 < ttl <= 3600


async def test_place_search_maps_down_is_an_empty_list(client, db, user, photon):
    photon.down = True
    fid, form_id, token = await make_form(client, user, defn([loc()]), audience="link")
    r = await client.get(f"/api/f/{token}/places", params={"q": "Smith"})
    assert r.status_code == 200 and r.json() == {"results": [], "maps": False}


async def test_place_search_refuses_forms_it_isnt_for(client, db, user, photon):
    """Closed, trashed, no Location question, a server form for someone
    signed out, a made-up link: all the same 404."""
    _f1, _id1, closed = await make_form(client, user, defn([loc()]), audience="link")
    fid1 = _f1
    await client.patch(f"/api/forms/{fid1}/settings", json={"accepting": False}, headers=H(user))
    f2, _id2, trashed = await make_form(client, user, defn([loc()]), audience="link")
    r = await client.post(f"/api/files/{f2}/trash", headers=H(user))
    assert r.status_code in (200, 204), r.text
    _f3, _id3, plain = await make_form(client, user, defn([short()]), audience="link")
    _f4, _id4, server = await make_form(client, user, defn([loc()]), audience="server")
    _f5, _id5, other_q = await make_form(client, user, defn([loc(), short()]), audience="link")
    bodies = []
    for token, params in ((closed, {}), (trashed, {}), (plain, {}), (server, {}), ("not-a-real-link", {}),
                          (other_q, {"question": "name"})):
        r = await client.get(f"/api/f/{token}/places", params={"q": "Smith", **params})
        assert r.status_code == 404, (token, r.text)
        bodies.append(r.json())
    assert all(b == bodies[0] for b in bodies) and bodies[0]["detail"]["code"] == "gone"
    assert photon.calls == []


# ------------------------------------------------------------------ the owner's side
async def test_owner_sees_places_text_and_map(client, db, user, photon):
    from app.chat.tools.base import ToolContext
    from app.chat.tools.forms import ReadFormResponsesTool

    fid, form_id, token = await make_form(client, user, defn([loc()]), audience="link")
    assert (await send(client, form_id, token, {"where": {"text": "12 Smith St, Hobart", "lat": -42.88213,
                                                          "lon": 147.3272, "picked": True}})).status_code == 200
    assert (await send(client, form_id, token, {"where": {"text": "Grandma's", "picked": False}})).status_code == 200

    s = (await client.get(f"/api/forms/{fid}/summary", headers=H(user))).json()
    [q] = s["questions"]
    assert q["with_spot"] == 1
    assert q["places"] == [{"number": 2, "text": "Grandma's"},
                           {"number": 1, "text": "12 Smith St, Hobart", "lat": -42.88213, "lon": 147.3272}]
    r = await client.get(f"/api/forms/{fid}/places", headers=H(user))
    assert r.json() == {"places": [{"number": 1, "text": "12 Smith St, Hobart", "lat": -42.88213, "lon": 147.3272,
                                    "question_id": "where"}], "capped": False}

    # A read grant sees the map; someone without one (an admin too) gets a 404.
    reader = await mk_user(db, "reader")
    nobody = await mk_user(db, "nobody")
    admin = await mk_user(db, "admin")
    admin.role = "admin"
    await db.commit()
    r = await client.post(f"/api/files/file/{fid}/grants", json={"grantee_user_id": str(reader.id), "can_edit": False},
                          headers=H(user))
    assert r.status_code in (200, 201), r.text
    assert (await client.get(f"/api/forms/{fid}/places", headers=H(reader))).status_code == 200
    assert (await client.get(f"/api/forms/{fid}/places", headers=H(nobody))).status_code == 404
    assert (await client.get(f"/api/forms/{fid}/places", headers=H(admin))).status_code == 404

    # Downloads: the words, then the spot as text.
    r = await client.get(f"/api/forms/{fid}/export", params={"format": "csv"}, headers=H(user))
    lines = r.content.decode("utf-8-sig").splitlines()
    assert lines[0].endswith("Where do you live?,Where do you live? (map)")
    # A spot south of the equator starts with "-": formula-safe like any other cell.
    assert lines[1].endswith("\"12 Smith St, Hobart\",\"'-42.88213, 147.3272\"")
    assert lines[2].endswith("Grandma's,")

    # Search in the question view finds the words.
    r = await client.get(f"/api/forms/{fid}/responses", params={"question": "where", "q": "smith"}, headers=H(user))
    assert [i["number"] for i in r.json()["items"]] == [1]

    # Chat reads the words, never a spot.
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await ReadFormResponsesTool().run(ctx, {"form": fid})
    assert "12 Smith St, Hobart" in out.content and "Grandma's" in out.content
    assert "-42.88" not in out.content and "147.32" not in out.content


def test_ai_never_drafts_a_location_question():
    from app.forms.ai import DRAFT_KINDS, items_from

    assert "location" not in DRAFT_KINDS
    out = items_from({"title": "x", "items": [{"kind": "location", "title": "Where?"}, {"kind": "short_text", "title": "Name"}]})
    assert [i["kind"] for i in out["items"]] == ["short_text"]
