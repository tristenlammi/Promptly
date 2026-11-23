"""Choosing this server's maps: the list is built from the two public indexes,
the estimate adds up, only admins get in, a map already there is kept as it
is, and the maps container's own rules hold (nothing downloaded until chosen,
old installs carry on as Australia, .env wins, downloads only from the two
map mirrors). The container and both mirrors are stubbed."""
from __future__ import annotations

import importlib
import json
import os
import sys
import uuid
from pathlib import Path

import httpx
import pytest

_SCRIPTS = Path(os.environ.get("MAPS_SCRIPTS_DIR") or Path(__file__).resolve().parents[2] / "maps")
needs_scripts = pytest.mark.skipif(not (_SCRIPTS / "regions.py").is_file(), reason="maps/ scripts not mounted")


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


def _feature(rid, name, parent=None, **extra):
    base = "https://download.geofabrik.de/x/" + rid
    return {"type": "Feature", "properties": {"id": rid, "name": name, "parent": parent, "urls": {"pbf": f"{base}-latest.osm.pbf", "geojson": f"{base}.geojson"}, **extra}}


INDEX = [
    _feature("europe", "Europe"),
    _feature("north-america", "North America"),
    _feature("monaco", "Monaco", "europe", **{"iso3166-1:alpha2": ["MC"]}),
    _feature("france", "France", "europe", **{"iso3166-1:alpha2": ["FR"]}),
    _feature("us", "United States of America", "north-america", **{"iso3166-1:alpha2": ["US"]}),
    _feature("us/california", "California", "us", **{"iso3166-2": ["US-CA"]}),
    _feature("great-britain", "Great Britain", "europe"),
    _feature("alps", "Alps", "europe"),
    _feature("atlantis", "Atlantis", "europe", **{"iso3166-1:alpha2": ["ZZ"]}),
]
LISTING = """
<tr>
    <td><a href="https://download1.graphhopper.com/public/europe/france-monacco/index.html">France-Monacco</a></td>
    <td class="td-center">✓</td>
    <td>FR, MC</td>
</tr>
<tr>
    <td><a href="https://download1.graphhopper.com/public/europe/british-islands/index.html">British-Islands</a></td>
    <td class="td-center">✗</td>
    <td>GB, IM</td>
</tr>
<tr>
    <td><a href="https://download1.graphhopper.com/public/north-america/usa/index.html">Usa</a></td>
    <td class="td-center">✓</td>
    <td>US</td>
</tr>
<tr>
    <td><a href="https://download1.graphhopper.com/public/europe/index.html">Europe</a></td>
    <td class="td-center">✓</td>
    <td>FR, MC, GB, IM, DE</td>
</tr>
"""


def _catalog():
    from app.maps import regions

    rows = regions.build_catalog(INDEX, regions.photon_by_country(regions.parse_photon_listing(LISTING)))
    return {"source": "geofabrik", "fetched_at": 1, "regions": rows}


def test_the_list_is_countries_and_their_parts_with_a_search_file_each():
    from app.maps import regions

    by = {r["id"]: r for r in _catalog()["regions"]}
    # Continents, odd groupings and countries with no search file are left out.
    assert set(by) == {"monaco", "france", "us", "us/california", "great-britain"}
    # A small country shares its neighbour's file, and takes only its own places.
    assert by["monaco"]["photon"] == [{"path": "europe/france-monacco", "countries": ["mc"]}]
    assert by["monaco"]["kind"] == "country" and by["monaco"]["clip"] is False and by["monaco"]["continent"] == "Europe"
    # Part of a country: the country's file, cut along the part's outline.
    assert by["us/california"]["photon"] == [{"path": "north-america/usa", "countries": ["us"]}]
    assert by["us/california"]["clip"] is True and by["us/california"]["parent"] == "us" and by["us/california"]["continent"] == "North America"
    assert by["us"]["parent"] is None
    assert by["great-britain"]["photon"][0] == {"path": "europe/british-islands", "countries": ["gb"]}
    assert regions.photon_url("europe/france-monacco") == "https://download1.graphhopper.com/public/europe/france-monacco/photon-dump-france-monacco-1.0-latest.jsonl.zst"


def test_the_built_in_list_is_usable_on_its_own():
    from app.maps import regions

    rows = regions.builtin_catalog()["regions"]
    assert "australia" in {r["id"] for r in rows}
    for r in rows:
        assert r["pbf"].startswith("https://download.geofabrik.de/") and r["bbox"] and r["photon"][0]["countries"]
        assert regions.public(r)["id"] == r["id"]


def test_the_estimate_is_for_the_whole_set_and_says_when_it_wont_fit():
    from app.maps import regions

    by = {r["id"]: r for r in _catalog()["regions"]}
    one = regions.estimate([by["monaco"]], {"monaco": 1.0}, offline=True, live_bytes=0, free_bytes=50_000_000_000)
    both = regions.estimate([by["monaco"], by["france"]], {"monaco": 1.0, "france": 4500.0}, offline=True, live_bytes=0, free_bytes=50_000_000_000)
    assert one["fits"] is True and one["complete"] is True and one["minutes"] < 15
    assert both["disk_after_bytes"] > 20 * one["disk_after_bytes"] and both["disk_needed_bytes"] > both["disk_after_bytes"]
    assert both["minutes"] > 120
    # 4.5 GB of France needs far more than 20 GB free.
    assert regions.estimate([by["france"]], {"france": 4500.0}, offline=True, live_bytes=0, free_bytes=20_000_000_000)["fits"] is False
    # No offline packs: smaller.
    assert regions.estimate([by["france"]], {"france": 4500.0}, offline=False, live_bytes=0, free_bytes=None)["disk_after_bytes"] < both["disk_after_bytes"]
    # A size nobody knows: say so rather than calling it free.
    assert regions.estimate([by["monaco"]], {}, offline=True, live_bytes=0, free_bytes=1)["complete"] is False


def _state(**over):
    base = {
        "managed": "ui", "chosen": True, "signature": "monaco",
        "wanted": [{"id": "monaco", "name": "Monaco"}],
        "live": {"build": "build-1", "built_at": "2026-11-20T00:00:00Z", "regions": [{"id": "monaco", "name": "Monaco"}], "bytes": 40_000_000},
        "status": {"state": "ready", "step": "", "steps": ["osm", "basemap", "routing", "search", "places"]},
        "disk": {"free": 80_000_000_000, "total": 100_000_000_000}, "offline": True,
    }
    return {**base, **over}


def test_what_the_app_is_told_about_each_map():
    from app.maps import regions

    off = regions.describe(None)
    assert off["available"] is False and off["regions"] == []

    none = regions.describe(_state(chosen=False, wanted=[], live=None, status={"state": "none"}))
    assert none["available"] is True and none["chosen"] is False and none["ready"] is False and none["regions"] == []

    adding = regions.describe(_state(
        wanted=[{"id": "monaco", "name": "Monaco"}, {"id": "liechtenstein", "name": "Liechtenstein"}],
        status={"state": "building", "step": "routing", "detail": "", "steps": ["osm", "basemap", "routing", "search", "places"]},
    ))
    assert [(r["id"], r["state"]) for r in adding["regions"]] == [("monaco", "installed"), ("liechtenstein", "building")]
    assert adding["building"] and adding["ready"] and adding["step_number"] == 3 and adding["steps_total"] == 5 and 0 < adding["progress"] < 1

    removing = regions.describe(_state(wanted=[], status={"state": "building", "step": "osm", "steps": ["osm"]}))
    assert [(r["id"], r["state"]) for r in removing["regions"]] == [("monaco", "removing")]


@pytest.fixture
def maps(monkeypatch):
    """The maps container and the two mirrors, stubbed."""
    from app.maps import regions

    box = {"state": _state(), "calls": []}

    async def control(method, path, body=None):
        box["calls"].append((method, path, body))
        if box["state"] is None:
            return None
        if method == "PUT":
            box["state"] = {**box["state"], "wanted": [{"id": r["id"], "name": r.get("name", r["id"])} for r in body["regions"]]}
        return box["state"]

    async def catalog(*, refresh=False):
        return _catalog()

    async def sizes(rows):
        return {"monaco": 1.0, "france": 4500.0, "us": 11000.0, "us/california": 1300.0, "great-britain": 1900.0}

    async def outline(client, region):
        return {"type": "Polygon", "coordinates": [[[7.4, 43.7], [7.5, 43.7], [7.5, 43.8], [7.4, 43.7]]]}

    monkeypatch.setattr(regions, "control", control)
    monkeypatch.setattr(regions, "catalog", catalog)
    monkeypatch.setattr(regions, "measured_osm_mb", sizes)
    monkeypatch.setattr(regions, "_outline", outline)
    return box


async def test_only_admins_can_see_or_choose_maps(db, user, client, maps):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    calls = [
        ("GET", "/api/maps/regions", None), ("GET", "/api/maps/regions/catalog", None),
        ("POST", "/api/maps/regions/estimate", {"ids": ["monaco"]}), ("PUT", "/api/maps/regions", {"ids": ["monaco"]}),
        ("POST", "/api/maps/regions/add", {"ids": ["france"]}), ("POST", "/api/maps/regions/remove", {"ids": ["monaco"]}),
        ("POST", "/api/maps/regions/retry", None),
    ]
    for method, path, body in calls:
        assert (await client.request(method, path, json=body)).status_code == 401, path
        assert (await client.request(method, path, headers=_hdr(other), json=body)).status_code == 403, path
    assert maps["calls"] == []
    assert (await client.get("/api/maps/regions", headers=_hdr(user))).status_code == 200


async def test_the_list_has_sizes_and_no_download_addresses(user, client, maps):
    r = await client.get("/api/maps/regions/catalog", headers=_hdr(user))
    assert r.status_code == 200
    rows = {x["id"]: x for x in r.json()["regions"]}
    assert set(rows["us/california"]) == {"id", "name", "parent", "parent_name", "continent", "kind", "download_mb", "disk_mb", "minutes"}
    assert rows["us/california"]["parent_name"] == "United States of America" and rows["us/california"]["kind"] == "part"


async def test_adding_a_map_keeps_the_ones_already_there_as_they_are(user, client, maps):
    r = await client.post("/api/maps/regions/add", headers=_hdr(user), json={"ids": ["us/california"]})
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["regions"]] == ["monaco", "us/california"]
    sent = [c for c in maps["calls"] if c[0] == "PUT"][-1][2]["regions"]
    assert sent[0] == {"id": "monaco", "keep": True}
    new = sent[1]
    assert new["pbf"] == "https://download.geofabrik.de/x/us/california-latest.osm.pbf"
    assert new["photon"] == [{"url": "https://download1.graphhopper.com/public/north-america/usa/photon-dump-usa-1.0-latest.jsonl.zst", "countries": ["us"]}]
    assert new["clip"] is True and new["gnaf"] is False and new["geometry"]["type"] == "Polygon"

    r = await client.post("/api/maps/regions/remove", headers=_hdr(user), json={"ids": ["monaco"]})
    assert [c for c in maps["calls"] if c[0] == "PUT"][-1][2]["regions"] == [{"id": "us/california", "keep": True}]
    assert (await client.put("/api/maps/regions", headers=_hdr(user), json={"ids": ["nowhere"]})).status_code == 404


async def test_a_map_too_big_for_the_disk_is_refused_unless_forced(user, client, maps):
    maps["state"] = _state(disk={"free": 9_000_000_000, "total": 10_000_000_000})
    cost = (await client.post("/api/maps/regions/estimate", headers=_hdr(user), json={"ids": ["monaco", "france"]})).json()
    assert cost["fits"] is False and cost["free_bytes"] == 9_000_000_000 and cost["disk_live_bytes"] == 40_000_000
    r = await client.post("/api/maps/regions/add", headers=_hdr(user), json={"ids": ["france"]})
    assert r.status_code == 409 and "free disk space" in r.json()["detail"]
    assert not [c for c in maps["calls"] if c[0] == "PUT"]
    assert (await client.post("/api/maps/regions/add", headers=_hdr(user), json={"ids": ["france"], "force": True})).status_code == 200


async def test_a_map_set_in_env_cant_be_changed_here_and_maps_off_says_so(user, client, maps):
    maps["state"] = _state(managed="env")
    assert (await client.get("/api/maps/regions", headers=_hdr(user))).json()["managed"] == "env"
    r = await client.put("/api/maps/regions", headers=_hdr(user), json={"ids": ["france"]})
    assert r.status_code == 409 and ".env" in r.json()["detail"]
    maps["state"] = None
    assert (await client.get("/api/maps/regions", headers=_hdr(user))).json()["available"] is False
    assert (await client.put("/api/maps/regions", headers=_hdr(user), json={"ids": ["france"]})).status_code == 503
    assert (await client.post("/api/maps/regions/retry", headers=_hdr(user))).status_code == 503


async def test_the_maps_app_is_told_when_no_map_is_chosen(user, client, tmp_path, monkeypatch):
    from app.maps import data

    monkeypatch.setattr(data, "root", lambda: tmp_path)
    (tmp_path / "status.json").write_text(json.dumps({"state": "none"}), encoding="utf-8")
    body = (await client.get("/api/maps/config", headers=_hdr(user))).json()
    assert body["unchosen"] is True and body["ready"] is False and body["bounds"] is None
    # A map built before maps were chosen: Australia, with its address credit.
    (tmp_path / "current").write_text("build-1\n", encoding="utf-8")
    (tmp_path / "build-1").mkdir()
    (tmp_path / "build-1" / "manifest.json").write_text(json.dumps({"built_at": "2026-11-01T00:00:00Z"}), encoding="utf-8")
    (tmp_path / "status.json").write_text(json.dumps({"state": "ready"}), encoding="utf-8")
    body = (await client.get("/api/maps/config", headers=_hdr(user))).json()
    assert body["unchosen"] is False and body["ready"] is True and "G-NAF" in body["attribution"]
    (tmp_path / "build-1" / "manifest.json").write_text(json.dumps({"built_at": "2026-11-01T00:00:00Z", "gnaf": False, "bounds": [7.4, 43.5, 7.6, 43.8]}), encoding="utf-8")
    body = (await client.get("/api/maps/config", headers=_hdr(user))).json()
    assert "G-NAF" not in body["attribution"] and body["bounds"] == [7.4, 43.5, 7.6, 43.8]


# ---- The maps container's own scripts (maps/regions.py, maps/control.py) -------


@pytest.fixture
def scripts(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPS_DATA", str(tmp_path))
    for key in ("MAPS_PBF_URL", "MAPS_PHOTON_URL", "MAPS_BBOX", "MAPS_REGION_NAME"):
        monkeypatch.delenv(key, raising=False)
    sys.path.insert(0, str(_SCRIPTS))
    try:
        for name in ("regions", "control"):
            sys.modules.pop(name, None)
        regions = importlib.import_module("regions")
        control = importlib.import_module("control")
        yield regions, control, tmp_path
    finally:
        sys.path.remove(str(_SCRIPTS))
        for name in ("regions", "control"):
            sys.modules.pop(name, None)


MONACO = {
    "id": "monaco", "name": "Monaco", "pbf": "https://download.geofabrik.de/europe/monaco-latest.osm.pbf",
    "photon": [{"url": "https://download1.graphhopper.com/public/europe/france-monacco/photon-dump-france-monacco-1.0-latest.jsonl.zst", "countries": ["mc"]}],
    "clip": False, "gnaf": False,
    "geometry": {"type": "Polygon", "coordinates": [[[7.40, 43.72], [7.44, 43.72], [7.44, 43.76], [7.40, 43.76], [7.40, 43.72]]]},
}


@needs_scripts
def test_a_new_server_downloads_nothing_until_a_map_is_chosen(scripts):
    regions, control, data = scripts
    plan = regions.plan()
    assert plan["source"] == "none" and plan["regions"] == [] and not (data / "regions.json").exists()
    state = control.state()
    assert state["chosen"] is False and state["wanted"] == [] and state["live"] is None and state["managed"] == "ui"

    code, state = control.set_regions({"regions": [MONACO]})
    assert code == 200 and state["wanted"] == [{"id": "monaco", "name": "Monaco"}] and state["chosen"] is True
    plan = regions.plan()
    assert plan["source"] == "chosen" and plan["signature"] == "monaco" and plan["legacy_ok"] is False and plan["gnaf"] is False
    assert plan["regions"][0]["slug"] == "monaco" and plan["area"]["features"][0]["geometry"]["type"] == "Polygon"
    assert plan["bounds"] == [7.4, 43.72, 7.44, 43.76]


@needs_scripts
def test_map_data_from_before_choosing_carries_on_as_australia(scripts):
    regions, control, data = scripts
    (data / "current").write_text("build-20261101-0000\n", encoding="utf-8")
    (data / "build-20261101-0000").mkdir()
    (data / "build-20261101-0000" / "manifest.json").write_text(json.dumps({"built_at": "2026-11-01T00:00:00Z", "osm_data": "x", "basemap": "y"}), encoding="utf-8")
    plan = regions.plan()
    # The same downloads as ever, and the live build counts as this plan: no rebuild.
    assert plan["source"] == "chosen" and plan["signature"] == "australia" and plan["legacy_ok"] is True and plan["gnaf"] is True
    assert plan["regions"][0]["pbf"] == regions.AUSTRALIA_PBF and plan["regions"][0]["photon"] == [{"url": regions.AUSTRALIA_PHOTON, "countries": []}]
    assert plan["bounds"] == [112.0, -44.5, 154.5, -9.0]
    state = control.state()
    assert state["live"]["regions"] == [{"id": "australia", "name": "Australia"}] and state["wanted"] == [{"id": "australia", "name": "Australia"}]
    # Adding a map keeps Australia's record word for word.
    code, state = control.set_regions({"regions": [{"id": "australia", "keep": True}, MONACO]})
    assert code == 200 and regions.plan()["signature"] == "australia,monaco" and regions.plan()["legacy_ok"] is False
    assert regions.read_choice()["regions"][0]["photon"] == [{"url": regions.AUSTRALIA_PHOTON, "countries": []}]


@needs_scripts
def test_a_first_build_that_had_started_is_australia_too(scripts):
    regions, _, data = scripts
    (data / "next").mkdir()
    (data / "next" / ".done-osm").write_text("", encoding="utf-8")
    assert regions.plan()["signature"] == "australia"


@needs_scripts
def test_env_settings_still_win_and_lock_the_choice(scripts, monkeypatch):
    regions, control, _ = scripts
    monkeypatch.setenv("MAPS_PBF_URL", "https://download.geofabrik.de/europe/monaco-latest.osm.pbf")
    monkeypatch.setenv("MAPS_PHOTON_URL", "https://example.org/mine.jsonl.zst")
    monkeypatch.setenv("MAPS_BBOX", "7.4,43.7,7.5,43.8")
    plan = regions.plan()
    assert plan["source"] == "env" and plan["legacy_ok"] is True and plan["bbox_arg"] == "7.4,43.7,7.5,43.8" and plan["gnaf"] is False
    assert plan["regions"][0]["pbf"].endswith("monaco-latest.osm.pbf") and plan["regions"][0]["photon"][0] == {"url": "https://example.org/mine.jsonl.zst", "countries": []}
    code, body = control.set_regions({"regions": [MONACO]})
    assert code == 409 and ".env" in body["error"]
    assert control.state()["managed"] == "env"
    # Only the box set: still Australia, with its addresses, as it always was.
    monkeypatch.delenv("MAPS_PBF_URL")
    monkeypatch.delenv("MAPS_PHOTON_URL")
    plan = regions.plan()
    assert plan["source"] == "env" and plan["gnaf"] is True and plan["regions"][0]["pbf"] == regions.AUSTRALIA_PBF


@needs_scripts
def test_downloads_only_come_from_the_two_map_mirrors(scripts):
    regions, control, _ = scripts
    bad = [
        {**MONACO, "pbf": "https://evil.example/monaco-latest.osm.pbf"},
        {**MONACO, "pbf": "https://download.geofabrik.de/../x.osm.pbf"},
        {**MONACO, "pbf": "https://download.geofabrik.de/x.osm.pbf?u=http://evil"},
        {**MONACO, "photon": [{"url": "https://evil.example/a.jsonl.zst", "countries": ["mc"]}]},
        {**MONACO, "photon": [{"url": MONACO["photon"][0]["url"], "countries": ["MC; rm -rf /"]}]},
        {**MONACO, "id": "../etc"},
        {**MONACO, "geometry": {"type": "Point", "coordinates": [0, 0]}},
        {k: v for k, v in MONACO.items() if k != "geometry"},
    ]
    for r in bad:
        assert regions.valid_region(r) is not None, r
        assert control.set_regions({"regions": [r]})[0] == 400
    assert regions.valid_region(MONACO) is None
    assert control.set_regions({"regions": [{"id": "narnia", "keep": True}]})[0] == 400


@needs_scripts
def test_search_keeps_only_the_chosen_maps_places(scripts):
    import io

    regions, _, _ = scripts

    def place(code, lon, lat, name):
        return json.dumps({"type": "Place", "content": [{"country_code": code, "centroid": [lon, lat], "name": {"name": name}}]}, separators=(",", ":")) + "\n"

    header = '{"type":"NominatimDumpFile","content":{"version":"0.1.0"}}\n'
    dump = [header, place("fr", 2.35, 48.85, "Paris"), place("mc", 7.42, 43.74, "Casino"), place("mc", 7.42, 43.73, "Port")]
    out = io.StringIO()
    kept = regions.filter_lines(dump, [regions.Rule(["mc"], MONACO)], out, header=True)
    assert kept == 2 and "Paris" not in out.getvalue() and out.getvalue().startswith(header)

    # Part of a country: inside the outline only. A second file adds no second header.
    half = {**MONACO, "clip": True, "geometry": {"type": "Polygon", "coordinates": [[[7.40, 43.735], [7.44, 43.735], [7.44, 43.76], [7.40, 43.76], [7.40, 43.735]]]}}
    out = io.StringIO()
    assert regions.filter_lines(dump, [regions.Rule(["mc"], half)], out, header=False) == 1
    assert "Casino" in out.getvalue() and "Port" not in out.getvalue() and "NominatimDumpFile" not in out.getvalue()

    # The old Australia entry takes its whole file, untouched.
    out = io.StringIO()
    assert regions.filter_lines(dump, [regions.Rule([], regions.australia())], out, header=True) == 3
    assert out.getvalue() == "".join(dump)

    # Two maps sharing one file: it's read once, for both.
    france = {**MONACO, "id": "france", "photon": [{"url": MONACO["photon"][0]["url"], "countries": ["fr"]}]}
    grouped = regions.sources([MONACO, france])
    assert len(grouped) == 1 and len(next(iter(grouped.values()))) == 2
