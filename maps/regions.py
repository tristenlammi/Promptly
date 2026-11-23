"""Which maps this server keeps: the plan refresh.sh builds from.

    regions.py plan              the plan, as JSON (see ``plan``)
    regions.py search <plan>     Photon's import stream for the plan, on stdout

The choice is ``/data/regions.json``, written by control.py when an admin
picks maps in Promptly. Three older ways still work and are never overridden
by a missing file:

- ``MAPS_PBF_URL`` / ``MAPS_PHOTON_URL`` / ``MAPS_BBOX`` in ``.env``: one map,
  built exactly as before. The picker is read-only while they're set.
- Map data built before there was a choice (a live build with no region list,
  or a first build under way): that was Australia, so it becomes the choice.
- Nothing at all: no map is downloaded until somebody chooses.

Python's standard library only.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

DATA = Path(os.environ.get("MAPS_DATA", "/data"))
CHOICE = "regions.json"

OSM_HOSTS = ("https://download.geofabrik.de/",)
SEARCH_HOSTS = ("https://download1.graphhopper.com/public/",)

AUSTRALIA_PBF = "https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf"
AUSTRALIA_PHOTON = "https://download1.graphhopper.com/public/australia-oceania/australia/photon-dump-australia-1.0-latest.jsonl.zst"
AUSTRALIA_BBOX = [112.0, -44.5, 154.5, -9.0]
# Places G-NAF covers: Australia and its outlying territories.
GNAF_COUNTRIES = {"au", "nf", "cx", "cc", "hm"}


def australia() -> dict:
    """Australia the way it was always built: the whole dump, the old box."""
    return {
        "id": "australia",
        "name": "Australia",
        "pbf": AUSTRALIA_PBF,
        "bbox": AUSTRALIA_BBOX,
        "photon": [{"url": AUSTRALIA_PHOTON, "countries": []}],
        "clip": False,
        "gnaf": True,
    }


def slug(region_id: str) -> str:
    return region_id.replace("/", "_")


def signature(ids: list[str]) -> str:
    return ",".join(sorted(ids))


def read_choice(data: Path = DATA) -> dict | None:
    try:
        doc = json.loads((data / CHOICE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("regions"), list) else None


def write_choice(regions: list[dict], data: Path = DATA, **extra: object) -> None:
    from datetime import datetime, timezone

    doc = {"version": 1, "regions": regions, "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **extra}
    tmp = data / (CHOICE + ".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, data / CHOICE)


def env_region(env: dict | None = None) -> dict | None:
    """The one map named in .env, if any of its three settings is there."""
    env = os.environ if env is None else env
    pbf, photon, bbox = (env.get(k, "").strip() for k in ("MAPS_PBF_URL", "MAPS_PHOTON_URL", "MAPS_BBOX"))
    if not (pbf or photon or bbox):
        return None
    try:
        box = [float(x) for x in bbox.split(",")] if bbox else AUSTRALIA_BBOX
        if len(box) != 4:
            raise ValueError
    except ValueError:
        box = AUSTRALIA_BBOX
    name = env.get("MAPS_REGION_NAME", "").strip() or ("Your own map (set in .env)" if pbf else "Australia")
    return {
        "id": "custom" if pbf else "australia",
        "name": name,
        "pbf": pbf or AUSTRALIA_PBF,
        "bbox": box,
        "bbox_arg": bbox or ",".join(f"{x:g}" for x in AUSTRALIA_BBOX),
        "photon": [{"url": photon or AUSTRALIA_PHOTON, "countries": []}],
        "clip": False,
        # As before: the address file only goes with the default map.
        "gnaf": not pbf,
    }


def built_before_choosing(data: Path = DATA) -> bool:
    """Map data from before maps were chosen: a live build without a region
    list, or a first build that had started."""
    try:
        name = (data / "current").read_text(encoding="utf-8").strip()
    except OSError:
        name = ""
    if name and "/" not in name:
        try:
            manifest = json.loads((data / name / "manifest.json").read_text(encoding="utf-8"))
            if "regions" not in manifest:
                return True
        except (OSError, ValueError):
            pass
    nxt = data / "next"
    return nxt.is_dir() and not (nxt / ".signature").exists() and any(nxt.glob(".done-*"))


def plan(data: Path = DATA, env: dict | None = None) -> dict:
    """What to build. ``source`` is env | chosen | none; ``legacy_ok`` says a
    build without a region list counts as this plan (so nothing is rebuilt)."""
    one = env_region(env)
    if one is not None:
        regions = [one]
        raw = "|".join([one["pbf"], one["photon"][0]["url"], one["bbox_arg"]])
        sig = "env:" + hashlib.sha256(raw.encode()).hexdigest()[:16]
        return _finish({"source": "env", "signature": sig, "legacy_ok": True, "regions": regions, "bbox_arg": one["bbox_arg"]})
    choice = read_choice(data)
    if choice is None and built_before_choosing(data):
        write_choice([australia()], data, adopted=True)
        choice = read_choice(data)
    if choice is None:
        return _finish({"source": "none", "signature": "", "legacy_ok": False, "regions": []})
    regions = [r for r in choice["regions"] if valid_region(r) is None]
    ids = [r["id"] for r in regions]
    return _finish({"source": "chosen", "signature": signature(ids), "legacy_ok": ids == ["australia"], "regions": regions})


def _finish(doc: dict) -> dict:
    for r in doc["regions"]:
        r["slug"] = slug(r["id"])
    doc["gnaf"] = any(r.get("gnaf") for r in doc["regions"])
    features = [{"type": "Feature", "properties": {"id": r["id"]}, "geometry": shape(r)} for r in doc["regions"]]
    doc["area"] = {"type": "FeatureCollection", "features": features}
    doc["bounds"] = bounds(doc["regions"])
    return doc


def shape(region: dict) -> dict:
    geometry = region.get("geometry")
    if isinstance(geometry, dict) and geometry.get("type") in {"Polygon", "MultiPolygon"}:
        return geometry
    w, s, e, n = region["bbox"]
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def polygons(geometry: dict) -> list[list[list[list[float]]]]:
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else list(geometry["coordinates"])


def _box(ring: list[list[float]]) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bounds(regions: list[dict]) -> list[float] | None:
    """A box to open the map on: around each map's biggest piece, so Alaska's
    far islands don't make "the United States" the whole world."""
    boxes = []
    for r in regions:
        if r.get("bbox"):
            boxes.append(tuple(r["bbox"]))
            continue
        outer = [_box(p[0]) for p in polygons(shape(r)) if p and p[0]]
        if outer:
            boxes.append(max(outer, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])))
    if not boxes:
        return None
    return [round(v, 4) for v in (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))]


def valid_region(r: object) -> str | None:
    """Why this isn't a map we'd build, or None. Downloads only ever come
    from the two public map mirrors."""
    import re

    if not isinstance(r, dict):
        return "not an object"
    if not isinstance(r.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9/_-]{0,79}", r["id"]) or ".." in r["id"]:
        return "bad id"
    if not isinstance(r.get("name"), str) or not r["name"].strip() or len(r["name"]) > 120:
        return "bad name"
    pbf = r.get("pbf")
    if not isinstance(pbf, str) or not pbf.startswith(OSM_HOSTS) or not pbf.endswith(".osm.pbf") or not _plain(pbf):
        return "the map file isn't on download.geofabrik.de"
    photon = r.get("photon")
    if not isinstance(photon, list) or not photon or len(photon) > 12:
        return "no search file"
    for p in photon:
        if not isinstance(p, dict) or not isinstance(p.get("url"), str):
            return "bad search file"
        if not p["url"].startswith(SEARCH_HOSTS) or not p["url"].endswith(".jsonl.zst") or not _plain(p["url"]):
            return "the search file isn't on download1.graphhopper.com"
        countries = p.get("countries")
        if not isinstance(countries, list) or any(not isinstance(c, str) or not re.fullmatch(r"[a-z]{2}", c) for c in countries):
            return "bad country list"
    geometry, bbox = r.get("geometry"), r.get("bbox")
    if geometry is not None:
        if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            return "bad outline"
        try:
            for poly in polygons(geometry):
                for ring in poly:
                    for x, y in ring:
                        if not (-180 <= float(x) <= 180 and -90 <= float(y) <= 90):
                            return "bad outline"
            if not polygons(geometry) or not polygons(geometry)[0] or len(polygons(geometry)[0][0]) < 4:
                return "bad outline"
        except (TypeError, ValueError, IndexError):
            return "bad outline"
    elif not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox) and bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        return "no outline"
    return None


def _plain(url: str) -> bool:
    import re

    return bool(re.fullmatch(r"https://[A-Za-z0-9./_-]+", url)) and ".." not in url


# ---- Photon's import stream ---------------------------------------------------


def _inside(x: float, y: float, rings: list) -> bool:
    """Even-odd over every ring of every polygon: holes come out right."""
    inside = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


class Rule:
    """One map's say over one search file: these countries, and inside the
    outline when the map is only part of a country."""

    def __init__(self, countries: list[str], region: dict) -> None:
        self.countries = set(countries)
        self.rings = None
        if region.get("clip"):
            geometry = shape(region)
            self.rings = [ring for poly in polygons(geometry) for ring in poly]
            boxes = [_box(r) for r in self.rings]
            self.box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))

    def keeps(self, place: dict) -> bool:
        if self.countries and (place.get("country_code") or "").lower() not in self.countries:
            return False
        if self.rings is None:
            return True
        point = place.get("centroid")
        if not isinstance(point, list) or len(point) != 2:
            return False
        x, y = point
        w, s, e, n = self.box
        return w <= x <= e and s <= y <= n and _inside(x, y, self.rings)


def sources(regions: list[dict]) -> dict[str, list[Rule]]:
    """Each search file once, with every map that wants part of it."""
    out: dict[str, list[Rule]] = {}
    for region in regions:
        for p in region["photon"]:
            out.setdefault(p["url"], []).append(Rule(p["countries"], region))
    return out


def filter_lines(lines, rules: list[Rule], out, *, header: bool) -> int:  # noqa: ANN001
    """Copies one dump's lines to ``out``: its header only when asked (a
    stream has one), its places only where a rule keeps them."""
    whole = any(not r.countries and r.rings is None for r in rules)
    kept = 0
    for line in lines:
        if not line.lstrip().startswith('{"type":"Place"'):
            if header and line.strip():
                out.write(line)
            continue
        if whole:
            out.write(line)
            kept += 1
            continue
        # Cheap look before parsing: most lines of a shared file belong to
        # another country.
        wanted = {c for r in rules for c in r.countries}
        if wanted and all(r.countries for r in rules) and not any(f'"country_code":"{c}"' in line for c in wanted):
            continue
        doc = json.loads(line)
        content = [p for p in doc.get("content") or [] if any(r.keeps(p) for r in rules)]
        if not content:
            continue
        kept += len(content)
        if len(content) != len(doc["content"]):
            doc["content"] = content
            line = json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n"
        out.write(line)
    return kept


def search_stream(doc: dict, out) -> None:  # noqa: ANN001
    first = True
    for url, rules in sources(doc["regions"]).items():
        fetch = subprocess.Popen(["curl", "-fsSL", "--retry", "5", url], stdout=subprocess.PIPE)
        unpack = subprocess.Popen(["zstd", "-dc"], stdin=fetch.stdout, stdout=subprocess.PIPE, text=True, encoding="utf-8")
        fetch.stdout.close()
        kept = filter_lines(unpack.stdout, rules, out, header=first)
        first = False
        if unpack.wait() != 0 or fetch.wait() != 0:
            raise SystemExit(f"search: the download of {url} stopped early")
        print(f"search: {kept} places from {url.rsplit('/', 1)[-1]}", file=sys.stderr, flush=True)
    out.flush()


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "plan":
        json.dump(plan(), sys.stdout, separators=(",", ":"))
        return 0
    if len(argv) == 3 and argv[1] == "search":
        sys.stdout.reconfigure(encoding="utf-8")
        search_stream(json.loads(Path(argv[2]).read_text(encoding="utf-8")), sys.stdout)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
