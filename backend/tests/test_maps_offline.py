"""P Maps offline areas: your areas are yours (someone else's is a 404), the
squares come out right for a view, a route and a place, sizes match the build's
index, and the download links are signed, expire, and only ever hand out files
from the live build they were issued for."""
from __future__ import annotations

import base64
import hashlib
import json
import uuid

import httpx
import pytest


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


def _hdr(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _other(db):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    return other


# Squares with packs in the fake build. 150_-35 (sea) has none.
CELLS = {"150_-34": "1342", "151_-34": "1342", "151_-35": "1342", "149_-36": "1252", "148_-33": "1342", "153_-28": "1433"}


def _write_build(root, name: str, *, salt: str = "") -> dict:
    """A build with offline packs: small files with known bytes and an index."""
    build = root / name
    areas = build / "areas"
    index = {"format": 1, "build": name, "built_at": "2026-11-04T00:00:00Z", "search": True, "cells": {}, "l0": {}, "base": {}}

    def put(rel: str, body: bytes) -> dict:
        path = areas / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}

    names = {"map": "map.pmtiles", "route": "route.tar", "places": "places.sqlite", "addresses": "addresses.sqlite"}
    for i, (cell, l0) in enumerate(sorted(CELLS.items())):
        files = {kind: put(f"{cell}/{fname}", f"{salt}{cell}:{kind}:".encode() * (10 + i * (k + 1))) for k, (kind, fname) in enumerate(names.items())}
        cx, cy = (int(v) for v in cell.split("_"))
        index["cells"][cell] = {"box": [cx, cy, cx + 1, cy + 1], "l0": int(l0), "files": files}
    for tile in sorted(set(CELLS.values())):
        index["l0"][tile] = put(f"l0/{tile}.tar", f"{salt}l0:{tile}".encode() * 50)
    for kind in ("cameras", "chargers"):
        index["base"][kind] = put(f"base/{kind}.json", f"{salt}[{kind}]".encode() * 7)
    (areas / "index.json").write_text(json.dumps(index))
    (build / "manifest.json").write_text(json.dumps({"built_at": "2026-11-04T00:00:00Z", "osm_data": ""}))
    return index


@pytest.fixture
def offline_build(tmp_path, monkeypatch):
    from app.config import get_settings
    from app.maps import data, offline

    index = _write_build(tmp_path, "build-1")
    (tmp_path / "current").write_text("build-1")
    (tmp_path / "status.json").write_text(json.dumps({"state": "ready", "offline": True}))
    monkeypatch.setattr(get_settings(), "MAPS_DATA_DIR", str(tmp_path))
    offline._index.key = None
    data._cache.build = None
    yield tmp_path, index
    offline._index.key = None
    data._cache.build = None


def _size(index: dict, cells: list[str], addresses: bool = True) -> int:
    kinds = ("map", "route", "places", "addresses") if addresses else ("map", "route", "places")
    total = sum(index["cells"][c]["files"][k]["bytes"] for c in cells for k in kinds)
    total += sum(index["l0"][t]["bytes"] for t in {str(index["cells"][c]["l0"]) for c in cells})
    return total + sum(b["bytes"] for b in index["base"].values())


VIEW = {"name": "Sydney", "kind": "view", "box": {"west": 150.5, "south": -34.5, "east": 151.5, "north": -33.5}}


async def test_areas_are_yours_and_someone_elses_is_a_404(offline_build, db, user, client):
    _, index = offline_build
    other = await _other(db)
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json=VIEW)
    assert r.status_code == 201, r.text
    area = r.json()
    # The box touches four squares; the sea one has no pack.
    assert area["cells"] == ["150_-34", "151_-34", "151_-35"]
    assert area["bytes"] == _size(index, area["cells"])
    assert area["devices"] == [] and area["with_addresses"] is True
    aid = area["id"]

    got = (await client.get("/api/maps/offline", headers=_hdr(user))).json()
    assert got["enabled"] and got["ready"] and got["build"] == "build-1" and [a["id"] for a in got["areas"]] == [aid]
    assert (await client.get("/api/maps/offline", headers=_hdr(other))).json()["areas"] == []
    for method, path, body in (
        ("PATCH", f"/api/maps/offline/areas/{aid}", {"name": "Mine now"}),
        ("DELETE", f"/api/maps/offline/areas/{aid}", None),
        ("PUT", f"/api/maps/offline/areas/{aid}/device", {"device_id": "p1", "name": "Pixel", "state": "ready", "bytes": 1}),
    ):
        r = await client.request(method, path, headers=_hdr(other), json=body)
        assert r.status_code == 404, (method, r.text)

    r = await client.patch(f"/api/maps/offline/areas/{aid}", headers=_hdr(user), json={"name": "  Sydney   and around ", "with_addresses": False})
    assert r.json()["name"] == "Sydney and around"
    assert r.json()["bytes"] == _size(index, area["cells"], addresses=False)
    assert (await client.delete(f"/api/maps/offline/areas/{aid}", headers=_hdr(user))).status_code == 204
    assert (await client.get("/api/maps/offline", headers=_hdr(user))).json()["areas"] == []
    assert (await client.patch(f"/api/maps/offline/areas/{uuid.uuid4()}", headers=_hdr(user), json={"name": "x"})).status_code == 404


async def test_thirty_areas_at_most(offline_build, db, user, client):
    from app.maps.models import MapOfflineArea

    for i in range(30):
        db.add(MapOfflineArea(user_id=user.id, name=f"A{i}", kind="view", west=151, south=-34, east=152, north=-33, cells=["151_-34"]))
    await db.commit()
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json=VIEW)
    assert r.status_code == 409 and "30" in r.json()["detail"]


async def test_too_big_and_empty_areas_are_refused(offline_build, user, client):
    from app.maps import offline

    big = {"name": "Everywhere", "kind": "view", "box": {"west": 100, "south": -50, "east": 160, "north": -5}}
    # With no packs yet, every square in the box counts.
    offline._index.key = ("nope", 0)
    offline._index.value = None
    (offline_build[0] / "build-1" / "areas" / "index.json").unlink()
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json=big)
    assert r.status_code == 422 and "too big" in r.json()["detail"]
    assert (await client.post("/api/maps/offline/areas", headers=_hdr(user), json={"name": "x", "kind": "view"})).status_code == 422
    assert (await client.post("/api/maps/offline/areas", headers=_hdr(user), json={**VIEW, "box": {"west": 2, "south": 1, "east": 1, "north": 2}})).status_code == 422


async def test_sea_only_area_has_nothing_to_download(offline_build, user, client):
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json={"name": "Sea", "kind": "view", "box": {"west": 160.1, "south": -40, "east": 160.5, "north": -39.5}})
    assert r.status_code == 422 and "no map data" in r.json()["detail"]


def test_squares_for_a_box_a_route_and_a_place():
    from app.maps import offline

    assert offline.box_cells(150.5, -34.5, 151.5, -33.5) == ["150_-35", "151_-35", "150_-34", "151_-34"]
    assert offline.box_cells(151.0, -34.0, 152.0, -33.0) == ["151_-34"]
    # A drive along -33.5 from 150.5 to 152.5 stays in its row of squares...
    line = [(-33.5, 150.5), (-33.5, 152.5)]
    assert offline.corridor_cells(line) == {"150_-34", "151_-34", "152_-34"}
    # ...and one 5 km from the -34 line takes the squares south of it too.
    line = [(-33.955, 150.5), (-33.955, 152.5)]
    assert offline.corridor_cells(line) == {"150_-34", "151_-34", "152_-34", "150_-35", "151_-35", "152_-35"}
    # The coast from Sydney to Newcastle: two squares, and not the sea's.
    assert offline.corridor_cells([(-33.87, 151.21), (-33.43, 151.34), (-32.93, 151.78)]) == {"151_-34", "151_-33"}
    # Around a place: 30 km fits in one square; 60 km reaches the four beside it, not the corners.
    assert offline.near_cells(-33.5, 151.5, 30) == {"151_-34"}
    assert offline.near_cells(-33.5, 151.5, 60) == {"151_-34", "150_-34", "152_-34", "151_-35", "151_-33"}
    # Points every 2 km, so a long straight leg doesn't skip a square.
    assert len(offline.samples([(-33.5, 150.0), (-33.5, 151.0)])) >= 47


async def test_route_corridor_is_saved_simplified(offline_build, user, client):
    from app.maps import data, offline

    # A wiggly drive along -33.5 with 40,000 points: far more than 20 KB.
    line = [(-33.5 + (0.001 if i % 2 else 0), 150.2 + i * 0.00005) for i in range(40_000)]
    shape = offline.encode_polyline(line)
    assert len(shape) > 100_000
    assert data.decode_polyline(shape)[:2] == [(-33.5, 150.2), (-33.499, 150.20005)]
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json={"name": "The drive", "kind": "route", "shape": [shape]})
    assert r.status_code == 201, r.text
    got = r.json()
    assert got["kind"] == "route" and got["cells"] == ["150_-34", "151_-34"]
    assert len(got["shape"]) <= 20_000
    assert round(got["box"]["west"], 3) == 150.2 and round(got["box"]["north"], 3) == -33.499
    bad = await client.post("/api/maps/offline/areas", headers=_hdr(user), json={"name": "x", "kind": "route", "shape": "!"})
    assert bad.status_code == 422


async def test_around_a_place(offline_build, user, client):
    r = await client.post("/api/maps/offline/areas", headers=_hdr(user), json={"name": "Home", "kind": "around", "around": {"lat": -33.5, "lon": 151.5, "km": 60}})
    assert r.status_code == 201, r.text
    # 150_-34 and 151_-34 have packs; the other neighbours don't in this build.
    assert r.json()["cells"] == ["150_-34", "151_-34", "151_-35"]


async def test_the_estimate_matches_the_index(offline_build, user, client):
    _, index = offline_build
    q = {"west": 150.5, "south": -34.5, "east": 151.5, "north": -33.5}
    got = (await client.get("/api/maps/offline/estimate", headers=_hdr(user), params=q)).json()
    assert got["ready"] and got["cells"] == ["150_-34", "151_-34", "151_-35"] and not got["too_big"]
    assert got["bytes"] == _size(index, got["cells"])
    assert got["addresses_bytes"] == sum(index["cells"][c]["files"]["addresses"]["bytes"] for c in got["cells"])
    without = (await client.get("/api/maps/offline/estimate", headers=_hdr(user), params={**q, "addresses": "0"})).json()
    assert without["bytes"] == got["bytes"] - got["addresses_bytes"]
    assert (await client.get("/api/maps/offline/estimate", params=q)).status_code == 401


async def test_files_are_signed_links_that_resume(offline_build, user, client):
    root, index = offline_build
    got = (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": "151_-34,150_-35,153_-28"})).json()
    assert got["build"] == "build-1" and got["missing"] == ["150_-35"]
    kinds = [(f["cell"], f["kind"]) for f in got["files"]]
    assert kinds == [
        ("151_-34", "map"), ("151_-34", "route"), ("151_-34", "places"), ("151_-34", "addresses"),
        ("153_-28", "map"), ("153_-28", "route"), ("153_-28", "places"), ("153_-28", "addresses"),
        (None, "l0"), (None, "l0"), (None, "cameras"), (None, "chargers"),
    ]
    assert sorted(f["tile"] for f in got["files"] if f["kind"] == "l0") == [1342, 1433]
    for f in got["files"]:
        assert f["url"].startswith("/m/")
        body = (await client.get(f"/api{f['url']}")).content
        assert len(body) == f["bytes"] and hashlib.sha256(body).hexdigest() == f["sha256"], f
    first = got["files"][0]
    r = await client.get(f"/api{first['url']}", headers={"Range": "bytes=4-9"})
    assert r.status_code == 206 and r.content == (root / "build-1" / "areas" / "151_-34" / "map.pmtiles").read_bytes()[4:10]
    # Behind nginx, the bytes come straight from the build's folder (Range included).
    r = await client.get(f"/api{first['url']}", headers={"X-Promptly-Accel": "1"})
    assert r.status_code == 200 and r.headers["X-Accel-Redirect"] == "/_maps/build-1/areas/151_-34/map.pmtiles"
    l0 = next(f for f in got["files"] if f["kind"] == "l0")
    r = await client.get(f"/api{l0['url']}", headers={"X-Promptly-Accel": "1"})
    assert r.headers["X-Accel-Redirect"] == "/_maps/build-1/areas/l0/1342.tar"
    # Without house numbers, those files aren't listed.
    lean = (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": "151_-34", "addresses": "0"})).json()
    assert "addresses" not in {f["kind"] for f in lean["files"]}
    for bad in ("", "151-34", "x_y", ",".join(f"{x}_-30" for x in range(401))):
        assert (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": bad})).status_code == 422, bad


async def test_links_are_refused_when_expired_forged_revoked_or_from_another_build(offline_build, db, user, client):
    import time

    from app.files import media_urls
    from app.maps import offline

    root, _ = offline_build
    tag = offline.build_tag("build-1")
    good = media_urls.sign_offline(user.id, user.token_version, "map", tag, west=151, south=-34)
    assert (await client.get(f"/api{good}")).status_code == 200

    # Expired: issued three days ago.
    old = media_urls.sign_offline(user.id, user.token_version, "map", tag, west=151, south=-34, now=time.time() - 3 * 86400)
    assert (await client.get(f"/api{old}")).status_code == 404
    # Forged: one byte changed.
    raw = bytearray(base64.urlsafe_b64decode(good[3:] + "=" * (-len(good[3:]) % 4)))
    raw[30] ^= 1
    assert (await client.get("/api/m/" + base64.urlsafe_b64encode(bytes(raw)).decode().rstrip("="))).status_code == 404
    # Issued to nobody, or to a file that isn't in the build.
    assert (await client.get(f"/api{media_urls.sign_offline(uuid.uuid4(), 0, 'map', tag, west=151, south=-34)}")).status_code == 404
    assert (await client.get(f"/api{media_urls.sign_offline(user.id, user.token_version, 'map', tag, west=150, south=-35)}")).status_code == 404
    assert (await client.get(f"/api{media_urls.sign_offline(user.id, user.token_version, 'l0', tag, tile=9999)}")).status_code == 404

    # A new build goes live: links from the old one stop, the new ones work.
    _write_build(root, "build-2", salt="new")
    (root / "current").write_text("build-2")
    assert (await client.get(f"/api{good}")).status_code == 404
    fresh = (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": "151_-34"})).json()
    assert fresh["build"] == "build-2"
    r = await client.get(f"/api{fresh['files'][0]['url']}")
    assert r.status_code == 200 and r.content.startswith(b"new151_-34:map:")

    # Turned off on the server: no downloads.
    (root / "status.json").write_text(json.dumps({"state": "ready", "offline": False}))
    assert (await client.get(f"/api{fresh['files'][0]['url']}")).status_code == 404
    assert (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": "151_-34"})).status_code == 404
    (root / "status.json").write_text(json.dumps({"state": "ready", "offline": True}))

    # Signing out everywhere ends every link.
    user.token_version += 1
    await db.commit()
    assert (await client.get(f"/api{fresh['files'][0]['url']}")).status_code == 404


async def test_phones_report_what_they_have(offline_build, user, client):
    aid = (await client.post("/api/maps/offline/areas", headers=_hdr(user), json=VIEW)).json()["id"]
    url = f"/api/maps/offline/areas/{aid}/device"
    r = await client.put(url, headers=_hdr(user), json={"device_id": "pixel-9", "name": "Pixel 9", "state": "downloading", "build": "build-1", "bytes": 1000})
    assert r.status_code == 200, r.text
    r = await client.put(url, headers=_hdr(user), json={"device_id": "pixel-9", "name": "Pixel 9", "state": "ready", "build": "build-1", "bytes": 5000})
    [phone] = r.json()["devices"]
    assert phone["device_id"] == "pixel-9" and phone["state"] == "ready" and phone["bytes"] == 5000 and phone["at"]
    for i in range(12):
        r = await client.put(url, headers=_hdr(user), json={"device_id": f"p{i}", "name": f"Phone {i}", "state": "waiting"})
    assert len(r.json()["devices"]) == 10 and r.json()["devices"][0]["device_id"] == "p11"
    r = await client.put(url, headers=_hdr(user), json={"device_id": "p11", "name": "Phone 11", "state": "removed"})
    assert "p11" not in {d["device_id"] for d in r.json()["devices"]}
    assert (await client.put(url, headers=_hdr(user), json={"device_id": "bad id!", "name": "x", "state": "ready"})).status_code == 422


async def test_the_phone_uses_its_maps_app_password(offline_build, db, user, client):
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    db.add(AppPassword(user_id=user.id, name="phone", token_hash=token_hash(token), hint=hint(token), scopes=["maps"]))
    await db.commit()
    basic = {"Authorization": "Basic " + base64.b64encode(f"{user.username}:{token}".encode()).decode()}
    assert (await client.get("/api/maps/offline", headers=basic)).status_code == 200
    got = (await client.get("/api/maps/offline/files", headers=basic, params={"cells": "151_-34"})).json()
    assert (await client.get(f"/api{got['files'][0]['url']}")).status_code == 200


async def test_server_without_packs_says_why(offline_build, user, client):
    from app.maps import offline

    root, _ = offline_build
    # Turned off by the admin.
    (root / "status.json").write_text(json.dumps({"state": "ready", "offline": False}))
    got = (await client.get("/api/maps/offline", headers=_hdr(user))).json()
    assert got["enabled"] is False and got["ready"] is False
    assert (await client.post("/api/maps/offline/areas", headers=_hdr(user), json=VIEW)).status_code == 409
    # On, but this build came before packs: the next refresh makes them.
    (root / "status.json").write_text(json.dumps({"state": "building", "step": "routing", "offline": True}))
    import shutil

    shutil.rmtree(root / "build-1" / "areas")
    offline._index.key = None
    got = (await client.get("/api/maps/offline", headers=_hdr(user))).json()
    assert got["enabled"] and not got["ready"] and got["building"]
    assert (await client.get("/api/maps/offline/files", headers=_hdr(user), params={"cells": "151_-34"})).status_code == 409
    est = (await client.get("/api/maps/offline/estimate", headers=_hdr(user), params={"west": 151.2, "south": -33.9, "east": 151.3, "north": -33.8})).json()
    assert est["ready"] is False and est["bytes"] is None and est["cells"] == ["151_-34"]


@pytest.mark.parametrize(
    ("status_json", "areas", "failed", "state"),
    [
        ({"state": "ready", "offline": True}, True, False, "ready"),
        ({"state": "ready", "offline": False}, True, False, "off"),
        ({"state": "building", "step": "areas", "offline": True}, False, False, "building"),
        ({"state": "ready", "offline": True}, False, True, "failed"),
        ({"state": "ready", "offline": True}, False, False, "waiting"),
    ],
)
async def test_admins_see_the_packs_state(offline_build, db, user, client, status_json, areas, failed, state):
    import shutil

    from app.maps import offline

    root, index = offline_build
    (root / "status.json").write_text(json.dumps(status_json))
    if not areas:
        shutil.rmtree(root / "build-1" / "areas")
        offline._index.key = None
    if failed:
        (root / "build-1" / "areas.failed").write_text("")
    user.role = "admin"
    await db.commit()
    got = (await client.get("/api/maps/data-status", headers=_hdr(user))).json()["offline"]
    assert got["state"] == state
    if state == "ready":
        assert got["squares"] == 0 or got["squares"] == index.get("totals", {}).get("squares", 0)


async def test_admins_see_the_packs_disk_use_and_how_many_areas(offline_build, db, user, client):
    """Admin -> App settings' offline row: the build, its date, the packs' disk
    use and how many areas people saved (counts only, no names or places)."""
    from app.maps import offline

    root, index = offline_build
    index["totals"] = {"squares": 6, "bytes": 4_410_000_000}
    (root / "build-1" / "areas" / "index.json").write_text(json.dumps(index))
    offline._index.key = None
    other = await _other(db)
    for who, name in ((user, "Sydney"), (user, "Canberra"), (other, "Theirs")):
        r = await client.post("/api/maps/offline/areas", headers=_hdr(who), json={**VIEW, "name": name})
        assert r.status_code == 201, r.text
    user.role = "admin"
    await db.commit()
    got = (await client.get("/api/maps/data-status", headers=_hdr(user))).json()["offline"]
    assert got == {
        "state": "ready", "squares": 6, "bytes": 4_410_000_000, "build": "build-1",
        "built_at": "2026-11-04T00:00:00Z", "areas": 3, "people": 2,
    }
    # Not for everyone.
    assert (await client.get("/api/maps/data-status", headers=_hdr(other))).status_code == 403
