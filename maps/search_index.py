"""Offline search for phones: Australia's named places, streets, localities and
house numbers, cut into 1-degree squares.

    ... addresses.py gnaf.zip | search_index.py build search.sqlite
    search_index.py slice search.sqlite 151_-34 <out dir>

``build`` reads Photon's import stream (the same lines Photon imports, G-NAF
included) and writes one national SQLite file. ``slice`` copies one square
out of it as two small files a phone merges into its own search database:

- ``places.sqlite``: named places, streets and localities.
- ``addresses.sqlite``: house numbers, keyed to the streets they're on.

Row ids are the square's own (1, 2, 3 ...): a phone gives each square's rows
their own range when it merges them. Neither file carries a full-text index,
because the phone builds one FTS4 index over everything it has. Coordinates
are whole microdegrees. Python's standard library only.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
from pathlib import Path

FORMAT = 1

STATES = {
    "Australian Capital Territory": "ACT",
    "New South Wales": "NSW",
    "Northern Territory": "NT",
    "Queensland": "QLD",
    "South Australia": "SA",
    "Tasmania": "TAS",
    "Victoria": "VIC",
    "Western Australia": "WA",
    "Other Territories": "OT",
}
# Named things nobody drives to.
SKIP = {
    ("boundary", "timezone"), ("boundary", "maritime"), ("boundary", "political"),
    ("boundary", "census"), ("boundary", "statistical"), ("boundary", "postal_code"),
    ("boundary", "marker"), ("boundary", "border_zone"), ("boundary", "hazard"),
}
LOCALITY_TYPES = {"city", "town", "village", "suburb", "locality", "district", "county", "state", "country"}
ALT_NAMES = ("alt_name", "short_name", "official_name", "old_name", "loc_name")

NATIONAL = """
CREATE TABLE places(
  id INTEGER PRIMARY KEY, cx INTEGER NOT NULL, cy INTEGER NOT NULL, type TEXT NOT NULL,
  name TEXT NOT NULL, alt TEXT, kind TEXT, number TEXT, street TEXT, locality TEXT,
  state TEXT, postcode TEXT, lat INTEGER NOT NULL, lon INTEGER NOT NULL, rank INTEGER NOT NULL);
CREATE UNIQUE INDEX places_street ON places(cx, cy, name, locality) WHERE type = 'street';
CREATE TABLE streets(
  id INTEGER PRIMARY KEY, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
  name TEXT NOT NULL, locality TEXT, state TEXT, postcode TEXT);
CREATE TABLE addresses(street INTEGER NOT NULL, number TEXT NOT NULL, lat INTEGER NOT NULL, lon INTEGER NOT NULL);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
"""

PLACES = """
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
-- type: street | locality | place. kind: OSM's key:value (amenity:fuel).
-- rank: Photon's importance x 100000. lat, lon: microdegrees.
CREATE TABLE places(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, alt TEXT, kind TEXT,
  number TEXT, street TEXT, locality TEXT, state TEXT, postcode TEXT,
  lat INTEGER NOT NULL, lon INTEGER NOT NULL, rank INTEGER NOT NULL);
"""

ADDRESSES = """
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT, state TEXT, postcode TEXT);
-- One row per house number on a street. lat, lon: microdegrees.
CREATE TABLE addresses(
  street INTEGER NOT NULL, number TEXT NOT NULL, lat INTEGER NOT NULL, lon INTEGER NOT NULL,
  PRIMARY KEY(street, number)) WITHOUT ROWID;
"""


def cell_of(lon: float, lat: float) -> tuple[int, int]:
    return math.floor(lon), math.floor(lat)


def cell_name(cx: int, cy: int) -> str:
    return f"{cx}_{cy}"


def parse_cell(name: str) -> tuple[int, int]:
    west, south = name.split("_", 1)
    return int(west), int(south)


def _fast(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA cache_size=-262144")
    db.execute("PRAGMA temp_store=MEMORY")


def _text(value: object, limit: int = 200) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:limit] or None


def _names(raw: object) -> tuple[str | None, str | None]:
    """The name people use here, and the others it goes by."""
    if not isinstance(raw, dict):
        return None, None
    main = _text(raw.get("name:en")) or _text(raw.get("name"))
    others: list[str] = []
    for key in ("name", *ALT_NAMES):
        for value in str(raw.get(key) or "").split(";"):
            value = _text(value)
            if value and value != main and value not in others:
                others.append(value)
    return main, (" · ".join(others)[:400] or None)


def _locality(address: dict) -> str | None:
    for key in ("suburb", "city", "town", "village", "locality", "district"):
        value = _text(address.get(key))
        if value:
            return value
    return None


def _state(address: dict) -> str | None:
    value = _text(address.get("state"))
    return STATES.get(value or "", value)


class Builder:
    """Writes the national file from the stream, one Photon place at a time."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.db = sqlite3.connect(path, isolation_level=None)
        _fast(self.db)
        self.db.executescript(NATIONAL)
        self.db.execute("BEGIN")
        self.streets: dict[tuple, int] = {}
        self.counts = {"places": 0, "streets": 0, "addresses": 0, "skipped": 0, "bad_lines": 0}

    def add(self, c: dict) -> None:
        centroid = c.get("centroid")
        if not (isinstance(centroid, list) and len(centroid) == 2):
            self.counts["skipped"] += 1
            return
        try:
            lon, lat = float(centroid[0]), float(centroid[1])
        except (TypeError, ValueError):
            self.counts["skipped"] += 1
            return
        if not (-180 <= lon < 180 and -90 <= lat < 90):
            self.counts["skipped"] += 1
            return
        key, value = c.get("osm_key") or "", c.get("osm_value") or ""
        if (key, value) in SKIP:
            self.counts["skipped"] += 1
            return
        cx, cy = cell_of(lon, lat)
        address = c.get("address") if isinstance(c.get("address"), dict) else {}
        name, alt = _names(c.get("name"))
        number = _text(c.get("housenumber"), 40)
        street = _text(address.get("street"))
        locality = _locality(address)
        state = _state(address)
        postcode = _text(c.get("postcode") or address.get("postcode"), 12)
        mlat, mlon = round(lat * 1e6), round(lon * 1e6)

        if not name:
            if not (number and street):
                self.counts["skipped"] += 1
                return
            skey = (cx, cy, street, locality, postcode)
            sid = self.streets.get(skey)
            if sid is None:
                sid = len(self.streets) + 1
                self.streets[skey] = sid
                self.db.execute(
                    "INSERT INTO streets(id, cx, cy, name, locality, state, postcode) VALUES (?,?,?,?,?,?,?)",
                    (sid, cx, cy, street, locality, state, postcode),
                )
                self.counts["streets"] += 1
            self.db.execute("INSERT INTO addresses(street, number, lat, lon) VALUES (?,?,?,?)", (sid, number, mlat, mlon))
            self.counts["addresses"] += 1
            return

        kind = f"{key}:{value}" if key else None
        if c.get("address_type") == "street" or key == "highway":
            kind_type = "street"
        elif c.get("address_type") in LOCALITY_TYPES or key == "place":
            kind_type = "locality"
        else:
            kind_type = "place"
        try:
            rank = max(0, min(100000, round(float(c.get("importance") or 0) * 100000)))
        except (TypeError, ValueError):
            rank = 0
        cur = self.db.execute(
            "INSERT OR IGNORE INTO places(cx, cy, type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cx, cy, kind_type, name, alt, kind, number, street, locality, state, postcode, mlat, mlon, rank),
        )
        if cur.rowcount:
            self.counts["places"] += 1
        else:
            self.counts["skipped"] += 1   # the same street again, in the same locality

    def line(self, raw: str) -> None:
        raw = raw.lstrip()
        if not raw.startswith('{"type":"Place"'):
            return
        try:
            doc = json.loads(raw)
        except ValueError:
            self.counts["bad_lines"] += 1
            return
        for c in doc.get("content") or ():
            if isinstance(c, dict):
                self.add(c)

    def finish(self) -> dict[str, int]:
        self.db.executemany("INSERT INTO meta(k, v) VALUES (?, ?)", [("format", str(FORMAT))])
        self.db.execute("COMMIT")
        self.db.execute("DROP INDEX places_street")
        self.db.execute("CREATE INDEX places_cell ON places(cx, cy)")
        self.db.execute("CREATE INDEX streets_cell ON streets(cx, cy)")
        self.db.execute("CREATE INDEX addresses_street ON addresses(street)")
        self.db.close()
        return self.counts


def build(stream, path: Path) -> dict[str, int]:
    """The national file from a stream of Photon import lines."""
    part = path.with_name(path.name + ".part")
    part.unlink(missing_ok=True)
    builder = Builder(part)
    for raw in stream:
        builder.line(raw)
    counts = builder.finish()
    os.replace(part, path)
    return counts


def _new(path: Path, schema: str, cell: str) -> sqlite3.Connection:
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path, isolation_level=None)
    _fast(db)
    db.execute("PRAGMA page_size=4096")
    db.executescript(schema)
    db.execute("BEGIN")
    db.executemany("INSERT INTO meta(k, v) VALUES (?, ?)", [("format", str(FORMAT)), ("cell", cell)])
    return db


def _close(db: sqlite3.Connection) -> None:
    db.execute("COMMIT")
    db.execute("VACUUM")
    db.close()


def slice_cell(national: Path, cell: str, out: Path, *, places: bool = True, addresses: bool = True) -> dict[str, int]:
    """One square's ``places.sqlite`` and ``addresses.sqlite`` into ``out``."""
    cx, cy = parse_cell(cell)
    src = sqlite3.connect(f"file:{national}?mode=ro&immutable=1", uri=True)
    counts = {"places": 0, "streets": 0, "addresses": 0}
    try:
        if places:
            db = _new(out / "places.sqlite", PLACES, cell)
            rows = src.execute(
                "SELECT type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank"
                " FROM places WHERE cx = ? AND cy = ? ORDER BY type, name, locality, id",
                (cx, cy),
            )
            for i, row in enumerate(rows, 1):
                db.execute("INSERT INTO places VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (i, *row))
                counts["places"] = i
            _close(db)
        if addresses:
            db = _new(out / "addresses.sqlite", ADDRESSES, cell)
            local: dict[int, int] = {}
            rows = src.execute(
                "SELECT id, name, locality, state, postcode FROM streets WHERE cx = ? AND cy = ? ORDER BY name, locality, postcode",
                (cx, cy),
            )
            for i, (sid, *rest) in enumerate(rows, 1):
                local[sid] = i
                db.execute("INSERT INTO streets VALUES (?,?,?,?,?)", (i, *rest))
            counts["streets"] = len(local)
            got: list[tuple[int, str, int, int]] = []
            if local:
                rows = src.execute(
                    "SELECT a.street, a.number, a.lat, a.lon FROM addresses a JOIN streets s ON s.id = a.street"
                    " WHERE s.cx = ? AND s.cy = ?",
                    (cx, cy),
                )
                got = [(local[sid], number, lat, lon) for sid, number, lat, lon in rows]
                got.sort()
            db.executemany("INSERT OR IGNORE INTO addresses VALUES (?,?,?,?)", got)
            counts["addresses"] = db.execute("SELECT count(*) FROM addresses").fetchone()[0]
            _close(db)
    finally:
        src.close()
    return counts


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "build":
        stream = open(sys.stdin.fileno(), encoding="utf-8", errors="replace", newline="\n", buffering=1 << 20, closefd=False)
        counts = build(stream, Path(argv[1]))
        print("search_index: " + ", ".join(f"{k} {v}" for k, v in counts.items()), file=sys.stderr, flush=True)
        return 0
    if len(argv) == 4 and argv[0] == "slice":
        out = Path(argv[3])
        out.mkdir(parents=True, exist_ok=True)
        print(json.dumps(slice_cell(Path(argv[1]), argv[2], out)))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
