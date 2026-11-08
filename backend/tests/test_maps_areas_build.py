"""P Maps offline packs: the maps container's ``areas`` step (``maps/areas.py``
and ``maps/search_index.py``), run as plain functions on a tiny fake build: a
tar of fake Valhalla tiles, a stand-in for the map cut, and a few lines of
Photon's import stream. No downloads, no ``pmtiles`` binary."""
from __future__ import annotations

import hashlib
import importlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tarfile
from pathlib import Path

import pytest

_SCRIPTS = Path(os.environ.get("MAPS_SCRIPTS_DIR") or Path(__file__).resolve().parents[2] / "maps")
pytestmark = pytest.mark.skipif(not (_SCRIPTS / "areas.py").is_file(), reason="maps/ scripts not mounted")


@pytest.fixture
def mods():
    sys.path.insert(0, str(_SCRIPTS))
    try:
        search_index = importlib.import_module("search_index")
        areas = importlib.import_module("areas")
        yield areas, search_index
    finally:
        sys.path.remove(str(_SCRIPTS))


def _place(**c) -> str:
    return json.dumps({"type": "Place", "content": [c]}, separators=(",", ":")) + "\n"


NEWTOWN = {"suburb": "Newtown", "city": "Sydney", "state": "New South Wales"}
STREAM = "".join([
    '{"type":"NominatimDumpFile","content":{"version":"0.1.0"}}\n',
    _place(osm_key="amenity", osm_value="fuel", name={"name": "Caltex", "brand": "Caltex", "alt_name": "Caltex Newtown"},
           address=NEWTOWN, postcode="2042", importance=0.2, centroid=[151.18, -33.89], address_type="other"),
    # The same street twice (two OSM ways) is one row.
    _place(osm_key="highway", osm_value="primary", name={"name": "King Street"}, address=NEWTOWN, centroid=[151.18, -33.893], address_type="street"),
    _place(osm_key="highway", osm_value="primary", name={"name": "King Street"}, address=NEWTOWN, centroid=[151.181, -33.895], address_type="street"),
    _place(osm_key="place", osm_value="suburb", name={"name": "Newtown"}, address={"city": "Sydney", "state": "New South Wales"},
           centroid=[151.179, -33.897], address_type="suburb", importance=0.4),
    # Nobody drives to a time zone.
    _place(osm_key="boundary", osm_value="timezone", name={"name": "Australia/Sydney"}, centroid=[151.5, -33.5]),
    # G-NAF house numbers, as addresses.py writes them.
    _place(place_id="GANSW1", osm_key="place", osm_value="house", housenumber="12", address={"street": "King St", "city": "Newtown", "state": "New South Wales"},
           postcode="2042", centroid=[151.1801, -33.8931]),
    _place(place_id="GANSW2", osm_key="place", osm_value="house", housenumber="14", address={"street": "King St", "city": "Newtown", "state": "New South Wales"},
           postcode="2042", centroid=[151.1802, -33.8932]),
    _place(place_id="GANSW3", osm_key="place", osm_value="house", housenumber="3", address={"street": "Macquarie St", "city": "Dubbo", "state": "New South Wales"},
           postcode="2830", centroid=[148.6, -32.25]),
    # No street, no position, broken: skipped, not fatal.
    _place(osm_key="place", osm_value="house", housenumber="9", address={"city": "Nowhere"}, centroid=[151.2, -33.9]),
    _place(osm_key="amenity", osm_value="cafe", name={"name": "Lost"}),
    '{"type":"Place","content":[{broken\n',
])


def _gph(name: str) -> bytes:
    return (name.encode() + b"|") * 40


@pytest.fixture
def fake_build(tmp_path, mods):
    areas, search_index = mods
    build = tmp_path / "next"
    build.mkdir()
    # Level 0 tile 1342 (4 degrees: 144..148 x -34..-30 is 1341; 148..152 is 1342),
    # level 1 and two level 2 tiles in 151_-34, level 1 in 148_-33, level 2 in 150_-35.
    tiles = [
        areas.tile_path(0, 1342),
        areas.tile_path(1, (-34 + 90) * 360 + (151 + 180)),
        areas.tile_path(2, 224 * 1440 + 1324),
        areas.tile_path(2, 227 * 1440 + 1327),
        areas.tile_path(1, (-33 + 90) * 360 + (148 + 180)),
        areas.tile_path(2, ((-35 + 90) * 4) * 1440 + (150 + 180) * 4),
    ]
    with tarfile.open(build / "valhalla_tiles.tar", "w") as tar:
        for name in ["index.bin", *tiles]:
            body = b"\0" * 64 if name == "index.bin" else _gph(name)
            info = tarfile.TarInfo(name)
            info.size, info.mtime = len(body), 1_700_000_000
            tar.addfile(info, io.BytesIO(body))
    (build / "basemap.pmtiles").write_bytes(b"PMTiles")
    (build / "cameras.json").write_text('[{"lat":-33.9,"lon":151.2,"maxspeed":60}]')
    (build / "chargers.json").write_text("[]")
    counts = search_index.build(io.StringIO(STREAM), build / "search.sqlite")
    return build, tiles, counts


@pytest.fixture
def cuts(mods, monkeypatch):
    """The map cut, without the pmtiles binary: a file naming the box."""
    areas, _ = mods
    made: list[str] = []

    def cut(basemap, cx, cy, dest):  # noqa: ANN001
        made.append(f"{cx}_{cy}")
        dest.write_bytes(b"PMTiles:" + f"{cx},{cy}".encode())

    monkeypatch.setattr(areas, "cut_map", cut)
    return made


def test_tile_names_match_valhallas(mods):
    areas, _ = mods
    # Names from the live build's tar.
    assert areas.tile_path(0, 1071) == "0/001/071.gph"
    assert areas.tile_path(1, 64799) == "1/064/799.gph"
    assert areas.tile_path(2, 463535) == "2/000/463/535.gph"
    assert areas.tile_of("2/000/463/535.gph") == (2, 463535) and areas.tile_of("index.bin") is None
    assert areas.tile_corner(0, 1071) == (144.0, -46.0)
    assert areas.l0_of(148, -33) == areas.l0_of(151, -34) == 1342


def test_search_index_keeps_what_people_search_for(fake_build, mods, tmp_path):
    build, _, counts = fake_build
    _, search_index = mods
    assert counts == {"places": 3, "streets": 2, "addresses": 3, "skipped": 4, "bad_lines": 1}
    out = tmp_path / "cell"
    out.mkdir()
    got = search_index.slice_cell(build / "search.sqlite", "151_-34", out)
    assert got == {"places": 3, "streets": 1, "addresses": 2}
    db = sqlite3.connect(out / "places.sqlite")
    rows = db.execute("SELECT id, type, name, alt, kind, locality, state, postcode, lat, lon FROM places ORDER BY id").fetchall()
    assert rows == [
        (1, "locality", "Newtown", None, "place:suburb", "Sydney", "NSW", None, -33897000, 151179000),
        (2, "place", "Caltex", "Caltex Newtown", "amenity:fuel", "Newtown", "NSW", "2042", -33890000, 151180000),
        (3, "street", "King Street", None, "highway:primary", "Newtown", "NSW", None, -33893000, 151180000),
    ]
    assert dict(db.execute("SELECT k, v FROM meta")) == {"format": "1", "cell": "151_-34"}
    db = sqlite3.connect(out / "addresses.sqlite")
    assert db.execute("SELECT * FROM streets").fetchall() == [(1, "King St", "Newtown", "NSW", "2042")]
    assert db.execute("SELECT * FROM addresses").fetchall() == [(1, "12", -33893100, 151180100), (1, "14", -33893200, 151180200)]
    # A phone's FTS4 index over it finds "12 King St Newtown" by its words.
    db.execute("CREATE VIRTUAL TABLE s USING fts4(name, locality, tokenize=unicode61)")
    db.execute("INSERT INTO s(docid, name, locality) SELECT id, name, locality FROM streets")
    assert db.execute("SELECT docid FROM s WHERE s MATCH 'king newtown'").fetchall() == [(1,)]


def test_a_build_is_cut_into_squares(fake_build, mods, cuts):
    areas, _ = mods
    build, tiles, _ = fake_build
    index = areas.run(build, threads=1)
    assert not (build / "areas.part").exists()
    assert json.loads((build / "areas" / "index.json").read_text()) == index
    assert sorted(index["cells"]) == ["148_-33", "150_-35", "151_-34"]
    assert sorted(cuts) == ["148_-33", "150_-35", "151_-34"]
    sydney = index["cells"]["151_-34"]
    assert sydney["box"] == [151, -34, 152, -33] and sydney["l0"] == 1342
    assert index["cells"]["150_-35"]["l0"] is None   # no motorway tile there
    assert index["search"] is True and index["build"] is None

    # Routing: exactly this square's level-1 and level-2 tiles, byte for byte.
    with tarfile.open(build / "areas" / "151_-34" / "route.tar") as tar:
        assert sorted(tar.getnames()) == sorted(tiles[1:4])
        for m in tar:
            assert tar.extractfile(m).read() == _gph(m.name)
    with tarfile.open(build / "areas" / "l0" / "1342.tar") as tar:
        assert tar.getnames() == [tiles[0]] and tar.extractfile(tiles[0]).read() == _gph(tiles[0])
    # Every file's size and SHA-256 are right.
    for cell, entry in index["cells"].items():
        for kind, info in entry["files"].items():
            name = {"map": "map.pmtiles", "route": "route.tar", "places": "places.sqlite", "addresses": "addresses.sqlite"}[kind]
            body = (build / "areas" / cell / name).read_bytes()
            assert (len(body), hashlib.sha256(body).hexdigest()) == (info["bytes"], info["sha256"]), (cell, kind)
    assert set(index["base"]) == {"cameras", "chargers"}
    assert (build / "areas" / "base" / "cameras.json").read_text().startswith('[{"lat":-33.9')
    t = index["totals"]
    assert t["squares"] == 3 and t["bytes"] == t["map"] + t["route"] + t["places"] + t["addresses"] + t["l0"] + t["base"]


def test_the_same_build_makes_the_same_routing_bytes(fake_build, mods, cuts, tmp_path):
    areas, _ = mods
    build, _, _ = fake_build
    first = areas.run(build, threads=1)
    shutil.rmtree(build / "areas")
    second = areas.run(build, threads=1)
    for cell in first["cells"]:
        assert first["cells"][cell]["files"]["route"] == second["cells"][cell]["files"]["route"]
    assert first["l0"] == second["l0"]


def test_a_stopped_run_picks_up_where_it_left_off(fake_build, mods, cuts):
    areas, _ = mods
    build, _, _ = fake_build
    areas.run(build, threads=1)
    # As if stopped after two squares: their folders are done, the index isn't written.
    os.replace(build / "areas", build / "areas.part")
    (build / "areas.part" / "index.json").unlink()
    shutil.rmtree(build / "areas.part" / "148_-33")
    (build / "areas.part" / ".148_-33.tmp").mkdir()   # a half-made square
    cuts.clear()
    index = areas.run(build, threads=1)
    assert cuts == ["148_-33"]
    assert sorted(index["cells"]) == ["148_-33", "150_-35", "151_-34"]
    assert not (build / "areas" / ".148_-33.tmp").exists()


def test_without_search_the_squares_still_come(fake_build, mods, cuts):
    areas, _ = mods
    build, _, _ = fake_build
    (build / "search.sqlite").unlink()
    index = areas.run(build, threads=1, only={"151_-34"})
    assert index["search"] is False and list(index["cells"]) == ["151_-34"]
    assert set(index["cells"]["151_-34"]["files"]) == {"map", "route"}
