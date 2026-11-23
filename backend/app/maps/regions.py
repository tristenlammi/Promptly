"""Which maps this server keeps (P Maps): the list an admin picks from, what
each would cost in disk and time, and the door to the maps container.

The list is Geofabrik's index of OpenStreetMap extracts (countries, and the
parts of big ones), joined to GraphHopper's Photon search files by country
code. Both are fetched at most once a day and kept in Redis, with a short
built-in list for when neither can be reached. The maps container does the
downloading and building (``maps/control.py``, ``maps/refresh.sh``); this
module only tells it what to keep. Nothing about anyone's searches, routes or
places is sent anywhere: these are the same public downloads P Maps always
made.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger("promptly.maps.regions")

INDEX_URL = "https://download.geofabrik.de/index-v1-nogeom.json"
OSM_HOST = "https://download.geofabrik.de/"
PHOTON_ROOT = "https://download1.graphhopper.com/public/"
CACHE_KEY = "maps:regions:catalog:v2"
FRESH_SECONDS = 86_400
KEEP_SECONDS = 90 * 86_400
MAX_REGIONS = 12
_UA = {"User-Agent": "promptly-maps"}
_TIMEOUT = httpx.Timeout(25.0, connect=8.0)

_memory: dict[str, Any] = {"at": 0.0, "catalog": None}
_lock = asyncio.Lock()


class RegionError(Exception):
    """Something the admin should be told, in plain words."""

    def __init__(self, message: str, code: int = 400) -> None:
        super().__init__(message)
        self.message, self.code = message, code


# ---- The built-in list ----------------------------------------------------------

# (id, name, continent, Geofabrik path, country code, Photon path, box)
_BUILTIN = [
    ("australia", "Australia", "Australia and Oceania", "australia-oceania/australia", "au", "australia-oceania/australia", [112.0, -44.5, 154.5, -9.0]),
    ("new-zealand", "New Zealand", "Australia and Oceania", "australia-oceania/new-zealand", "nz", "australia-oceania/new-zealand", [165.5, -48.0, 179.0, -33.5]),
    ("great-britain", "Great Britain", "Europe", "europe/great-britain", "gb", "europe/british-islands", [-8.7, 49.8, 1.9, 60.9]),
    ("ireland-and-northern-ireland", "Ireland and Northern Ireland", "Europe", "europe/ireland-and-northern-ireland", "ie", "europe/ireland", [-10.8, 51.3, -5.3, 55.5]),
    ("germany", "Germany", "Europe", "europe/germany", "de", "europe/germany", [5.8, 47.2, 15.1, 55.1]),
    ("france", "France", "Europe", "europe/france", "fr", "europe/france-monacco", [-5.3, 41.3, 9.7, 51.2]),
    ("spain", "Spain", "Europe", "europe/spain", "es", "europe/spain", [-9.4, 35.9, 4.4, 43.9]),
    ("italy", "Italy", "Europe", "europe/italy", "it", "europe/italy", [6.6, 36.6, 18.6, 47.1]),
    ("netherlands", "Netherlands", "Europe", "europe/netherlands", "nl", "europe/netherlands", [3.3, 50.7, 7.3, 53.6]),
    ("canada", "Canada", "North America", "north-america/canada", "ca", "north-america/canada", [-141.1, 41.6, -52.5, 83.2]),
    ("mexico", "Mexico", "North America", "north-america/mexico", "mx", "north-america/mexico", [-118.5, 14.5, -86.6, 32.8]),
    ("india", "India", "Asia", "asia/india", "in", "asia/india", [68.0, 6.5, 97.5, 35.7]),
    ("japan", "Japan", "Asia", "asia/japan", "jp", "asia/japan", [122.9, 24.0, 146.0, 45.6]),
    ("brazil", "Brazil", "South America", "south-america/brazil", "br", "south-america/brazil", [-74.0, -33.8, -34.7, 5.3]),
    ("south-africa", "South Africa", "Africa", "africa/south-africa", "za", "africa/southern-africa", [16.4, -34.9, 32.9, -22.1]),
]

_CONTINENTS = {
    "africa": "Africa",
    "antarctica": "Antarctica",
    "asia": "Asia",
    "australia-oceania": "Australia and Oceania",
    "central-america": "Central America",
    "europe": "Europe",
    "north-america": "North America",
    "south-america": "South America",
    "russia": "Russia",
}


# Geofabrik extracts that carry no country code of their own but are plainly
# these countries (cut along the extract's outline).
_EXTRA_CODES = {
    "great-britain": ["gb"],
    "britain-and-ireland": ["gb", "ie", "im"],
    "isle-of-man": ["im"],
    "guernsey-jersey": ["gg", "je"],
    "dach": ["de", "at", "ch"],
    "south-africa-and-lesotho": ["za", "ls"],
    "azores": ["pt"],
    "canary-islands": ["es"],
}


def photon_url(path: str) -> str:
    return f"{PHOTON_ROOT}{path}/photon-dump-{path.rsplit('/', 1)[-1]}-1.0-latest.jsonl.zst"


@lru_cache(maxsize=1)
def sizes() -> dict[str, dict[str, float]]:
    """Download sizes in MB as measured when this was shipped (they grow a few
    percent a year): ``osm`` by Geofabrik id, ``photon`` by GraphHopper path."""
    try:
        doc = json.loads((Path(__file__).parent / "region_sizes.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        doc = {}
    return {"osm": doc.get("osm") or {}, "photon": doc.get("photon") or {}}


def builtin_catalog() -> dict[str, Any]:
    regions = []
    for rid, name, continent, osm_path, code, photon_path, box in _BUILTIN:
        regions.append({
            "id": rid, "name": name, "parent": None, "parent_name": None, "continent": continent, "kind": "country",
            "pbf": f"{OSM_HOST}{osm_path}-latest.osm.pbf", "outline": None, "bbox": box,
            "photon": [{"path": photon_path, "countries": [code]}], "clip": False,
        })
    return {"source": "builtin", "fetched_at": None, "regions": regions}


# ---- Building the list from the two indexes -------------------------------------


def _codes(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    return [v for v in value or [] if isinstance(v, str)]


def parse_photon_listing(html: str) -> list[tuple[str, list[str]]]:
    """(path, country codes) for each row of a GraphHopper listing page."""
    rows = re.findall(
        r'<td><a href="https://download1\.graphhopper\.com/public/([a-z0-9/-]+)/index\.html">[^<]*</a></td>\s*<td[^>]*>[^<]*</td>\s*<td>([^<]*)</td>',
        html,
    )
    return [(path, [c.strip().lower() for c in codes.split(",") if re.fullmatch(r"\s*[A-Za-z]{2}\s*", c)]) for path, codes in rows]


def photon_by_country(listings: list[tuple[str, list[str]]]) -> dict[str, str]:
    """Each country's smallest search file (its own, else a shared one)."""
    best: dict[str, tuple[int, str]] = {}
    for path, codes in listings:
        for code in codes:
            if code not in best or len(codes) < best[code][0]:
                best[code] = (len(codes), path)
    return {code: path for code, (_, path) in best.items()}


def build_catalog(features: list[dict[str, Any]], photon: dict[str, str]) -> list[dict[str, Any]]:
    """Geofabrik's extracts that are a country or part of one, each with where
    its search data comes from. Continents and odd groupings ("Alps") have no
    country code and are left out, as is anything GraphHopper has no file for."""
    props = {f["properties"]["id"]: f["properties"] for f in features if isinstance(f.get("properties"), dict) and f["properties"].get("id")}

    def chain(p: dict[str, Any]) -> list[dict[str, Any]]:
        out, seen = [], set()
        while p and p["id"] not in seen:
            seen.add(p["id"])
            out.append(p)
            p = props.get(p.get("parent") or "")
        return out

    regions = []
    for rid, p in props.items():
        pbf = (p.get("urls") or {}).get("pbf")
        if not isinstance(pbf, str) or not pbf.startswith(OSM_HOST) or not re.fullmatch(r"[a-z0-9][a-z0-9/_-]{0,79}", rid):
            continue
        line = chain(p)
        own = [c.lower() for c in _codes(p.get("iso3166-1:alpha2"))]
        codes, clip = own, False
        if not codes:
            # Part of a country: its ISO 3166-2 code, or the country above it.
            codes = sorted({c.split("-")[0].lower() for c in _codes(p.get("iso3166-2"))})
            for up in line[1:]:
                if codes:
                    break
                codes = [c.lower() for c in _codes(up.get("iso3166-1:alpha2"))]
            codes = codes or _EXTRA_CODES.get(rid, [])
            clip = True
        if not codes or any(c not in photon for c in codes):
            continue
        by_path: dict[str, list[str]] = {}
        for c in codes:
            by_path.setdefault(photon[c], []).append(c)
        parent = props.get(p.get("parent") or "")
        top = line[-1]
        outline = (p.get("urls") or {}).get("geojson")
        regions.append({
            "id": rid,
            "name": str(p.get("name") or rid)[:120],
            "parent": parent["id"] if parent and len(line) > 2 else None,
            "parent_name": str(parent.get("name"))[:120] if parent and len(line) > 2 else None,
            "continent": _CONTINENTS.get(top["id"], str(top.get("name") or "")),
            "kind": "part" if clip else "country",
            "pbf": pbf,
            "outline": outline if isinstance(outline, str) and outline.startswith(OSM_HOST) else None,
            "bbox": None,
            "photon": [{"path": path, "countries": sorted(cs)} for path, cs in sorted(by_path.items())],
            "clip": clip,
        })
    regions.sort(key=lambda r: (r["continent"], r["parent_name"] or r["name"], r["kind"] != "country", r["name"]))
    return regions


async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    r = await client.get(url, headers=_UA, follow_redirects=True)
    r.raise_for_status()
    return r


async def fetch_catalog() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        index = (await _get(client, INDEX_URL)).json()
        root = parse_photon_listing((await _get(client, PHOTON_ROOT)).text)
        pages = await asyncio.gather(*[_get(client, f"{PHOTON_ROOT}{path}/") for path, _ in root], return_exceptions=True)
    listings = list(root)
    for page in pages:
        if not isinstance(page, BaseException):
            listings.extend(parse_photon_listing(page.text))
    regions = build_catalog(index.get("features") or [], photon_by_country(listings))
    if len(regions) < 50:
        raise ValueError("the region index came back nearly empty")
    return {"source": "geofabrik", "fetched_at": int(time.time()), "regions": regions}


async def catalog(*, refresh: bool = False) -> dict[str, Any]:
    """The list to choose from: today's, else the last one fetched, else the
    built-in one."""
    now = time.time()
    held = _memory["catalog"]
    if held and not refresh and now - _memory["at"] < FRESH_SECONDS:
        return held
    async with _lock:
        held = _memory["catalog"]
        if held and not refresh and time.time() - _memory["at"] < FRESH_SECONDS:
            return held
        from app.redis_client import redis

        stored = None
        try:
            raw = await redis.get(CACHE_KEY)
            stored = json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001 - Redis down is no reason to have no list
            stored = None
        if stored and not refresh and now - (stored.get("fetched_at") or 0) < FRESH_SECONDS:
            _memory.update(at=now, catalog=stored)
            return stored
        try:
            fresh = await fetch_catalog()
        except Exception as exc:  # noqa: BLE001 - any failure means "use what we have"
            logger.info("region list: couldn't fetch it (%s); using the %s copy", type(exc).__name__, "kept" if stored else "built-in")
            result = stored or builtin_catalog()
            # Try again in an hour rather than on every request.
            _memory.update(at=now - FRESH_SECONDS + 3600, catalog=result)
            return result
        try:
            await redis.set(CACHE_KEY, json.dumps(fresh, separators=(",", ":")), ex=KEEP_SECONDS)
        except Exception:  # noqa: BLE001
            pass
        _memory.update(at=now, catalog=fresh)
        return fresh


# ---- What a set of maps costs ---------------------------------------------------

# Measured on real builds, as multiples of the OpenStreetMap file's size: New
# Zealand (406 MB file: basemap 642 MB, routing 329 MB, search 724 MB, offline
# packs 1,077 MB, 4.4 GB at the peak, 12 minutes on 4 CPUs and a fast line),
# Monaco and Liechtenstein for the fixed part, and Australia's known totals
# for the address file. They are rough on purpose: road density, address
# coverage and coastline change them from country to country, and nothing the
# size of Germany or the United States has been built to check them.
ROUTING_PER_OSM = 1.0      # Valhalla's tile archive
BASEMAP_PER_OSM = 1.6      # the cut of the Protomaps basemap
SEARCH_PER_OSM = 1.8       # Photon's index
FIXED_MB = 15.0            # what even the smallest map takes
OFFLINE_PER_BUILD = 0.65   # offline packs for phones, on top of the rest
WORK_PER_OSM = 4.2         # scratch space while building (the files themselves, loose tiles, the offline search copy)
GNAF_DOWNLOAD_MB = 1700.0  # Australia's address file
GNAF_SEARCH_MB = 2600.0    # ...what it adds to the search index
GNAF_WORK_MB = 3500.0      # ...and to the scratch space
GNAF_MINUTES = 30.0
MINUTES_PER_GB = 25.0      # on the container's default 4 CPUs
MINUTES_FLAT = 4.0
MINUTES_PER_SHARED_GB = 5.5  # downloading and reading the search files (France's 1.6 GB for Monaco: 9 minutes)


def _built_mb(osm_mb: float, *, gnaf: bool, offline: bool) -> float:
    built = FIXED_MB + osm_mb * (ROUTING_PER_OSM + BASEMAP_PER_OSM + SEARCH_PER_OSM) + (GNAF_SEARCH_MB if gnaf else 0)
    return built * (1 + OFFLINE_PER_BUILD) if offline else built


def _minutes(osm_mb: float, search_files_mb: float, *, gnaf: bool) -> float:
    return MINUTES_FLAT + osm_mb / 1000 * MINUTES_PER_GB + search_files_mb / 1000 * MINUTES_PER_SHARED_GB + (GNAF_MINUTES if gnaf else 0)


def public(region: dict[str, Any]) -> dict[str, Any]:
    """A list entry as the app sees it: no URLs, sizes in MB."""
    table = sizes()
    osm = table["osm"].get(region["id"])
    return {
        "id": region["id"],
        "name": region["name"],
        "parent": region["parent"],
        "parent_name": region["parent_name"],
        "continent": region["continent"],
        "kind": region["kind"],
        # The countries it covers (two-letter codes), so the picker can offer
        # the browser's own country first.
        "codes": sorted({c for p in region["photon"] for c in p["countries"]}),
        "download_mb": round(osm + sum(table["photon"].get(p["path"], 0) for p in region["photon"])) if osm else None,
        **estimate_one(region, osm),
    }


def estimate_one(region: dict[str, Any], osm_mb: float | None, *, offline: bool = True) -> dict[str, Any]:
    if not osm_mb:
        return {"disk_mb": None, "minutes": None}
    gnaf = region["id"] == "australia"
    shared = sum(sizes()["photon"].get(p["path"], 0) for p in region["photon"])
    return {"disk_mb": round(_built_mb(osm_mb, gnaf=gnaf, offline=offline)), "minutes": round(_minutes(osm_mb, shared, gnaf=gnaf))}


def estimate(regions: list[dict[str, Any]], osm_mb: dict[str, float], *, offline: bool, live_bytes: int, free_bytes: int | None) -> dict[str, Any]:
    """The whole set, built together next to the live one."""
    table = sizes()
    known = [r for r in regions if osm_mb.get(r["id"])]
    osm = sum(osm_mb[r["id"]] for r in known)
    gnaf = any(r["id"] == "australia" for r in regions)
    paths = {p["path"] for r in regions for p in r["photon"]}
    search_files = sum(table["photon"].get(p, 0) for p in paths)
    built = _built_mb(osm, gnaf=gnaf, offline=offline)
    work = osm * WORK_PER_OSM + (GNAF_WORK_MB if gnaf else 0)
    download = osm + search_files + osm * BASEMAP_PER_OSM + (GNAF_DOWNLOAD_MB if gnaf else 0)
    minutes = _minutes(osm, search_files, gnaf=gnaf)
    needs = int((built + work) * 1_000_000)
    return {
        "complete": len(known) == len(regions),
        "download_bytes": int(download * 1_000_000),
        # The search files (a small country can share one with a big
        # neighbour) are read as they download and never stored, so they count
        # towards the download but not towards the disk space below.
        "streamed_bytes": int(search_files * 1_000_000),
        "disk_after_bytes": int(built * 1_000_000),
        # Free space the build needs: the new set is built next to the live one.
        "disk_needed_bytes": needs,
        "disk_live_bytes": live_bytes,
        "free_bytes": free_bytes,
        "fits": None if free_bytes is None else needs * 1.1 < free_bytes,
        "minutes": round(minutes),
    }


async def measured_osm_mb(regions: list[dict[str, Any]]) -> dict[str, float]:
    """Today's size of each map file where the mirror answers quickly, else
    the shipped figure."""
    table = sizes()["osm"]
    out = {r["id"]: float(table[r["id"]]) for r in regions if table.get(r["id"])}

    async def head(client: httpx.AsyncClient, region: dict[str, Any]) -> None:
        try:
            r = await client.head(region["pbf"], headers=_UA, follow_redirects=True)
            size = int(r.headers.get("content-length") or 0)
            if r.status_code == 200 and size > 0:
                out[region["id"]] = size / 1_000_000
        except (httpx.HTTPError, ValueError):
            pass

    async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=4.0)) as client:
        await asyncio.gather(*[head(client, r) for r in regions[:MAX_REGIONS]])
    return out


# ---- The maps container ---------------------------------------------------------


async def control(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """One call to the maps container. None when it isn't there (P Maps is off
    on this server, or the container is still starting)."""
    base = get_settings().MAPS_CONTROL_URL
    if not base:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=2.0)) as client:
            r = await client.request(method, f"{base}{path}", json=body)
    except httpx.HTTPError:
        return None
    try:
        doc = r.json()
    except ValueError:
        return None
    if r.status_code >= 400:
        raise RegionError(str(doc.get("error") or "The maps service refused that."), 409 if r.status_code == 409 else 400)
    return doc


_STEP_WEIGHT = {"osm": 10, "basemap": 10, "routing": 35, "addresses": 5, "search": 30, "places": 2, "areas": 8}


def describe(state: dict[str, Any] | None) -> dict[str, Any]:
    """The container's state as the app shows it."""
    if state is None:
        return {
            "available": False, "managed": "ui", "chosen": False, "regions": [], "ready": False, "building": False,
            "failed": False, "step": None, "step_number": None, "steps_total": None, "detail": None, "progress": None,
            "built_at": None, "disk": None, "offline": False,
        }
    status = state.get("status") or {}
    live = state.get("live") or {}
    wanted = {r["id"]: r["name"] for r in state.get("wanted") or []}
    have = {r["id"]: r["name"] for r in live.get("regions") or []}
    building = status.get("state") == "building"
    rows = []
    for rid, name in wanted.items():
        rows.append({"id": rid, "name": name, "state": "installed" if rid in have else ("building" if building else "waiting")})
    for rid, name in have.items():
        if rid not in wanted:
            rows.append({"id": rid, "name": name, "state": "removing"})
    steps = [s for s in status.get("steps") or [] if isinstance(s, str)]
    step = status.get("step") or None
    number = steps.index(step) + 1 if building and step in steps else None
    progress = None
    if number:
        total = sum(_STEP_WEIGHT.get(s, 5) for s in steps)
        progress = round(sum(_STEP_WEIGHT.get(s, 5) for s in steps[: number - 1]) / total, 2) if total else None
    disk = state.get("disk") or {}
    return {
        "available": True,
        "managed": state.get("managed") or "ui",
        "chosen": bool(state.get("chosen")) and bool(wanted or have),
        "regions": rows,
        "ready": bool(live),
        "building": building,
        "failed": status.get("state") == "failed",
        "step": step if building or status.get("state") == "failed" else None,
        "step_number": number,
        "steps_total": len(steps) if number else None,
        "detail": (status.get("detail") or None) if building else None,
        "progress": progress,
        "built_at": live.get("built_at"),
        "disk": {"free_bytes": disk.get("free"), "total_bytes": disk.get("total"), "maps_bytes": live.get("bytes") or 0},
        "offline": bool(state.get("offline")),
    }


async def pick(ids: list[str]) -> list[dict[str, Any]]:
    """The list entries for these ids, in the order asked."""
    if len(ids) > MAX_REGIONS:
        raise RegionError(f"That's a lot of maps for one server: {MAX_REGIONS} at most.")
    by_id = {r["id"]: r for r in (await catalog())["regions"]}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise RegionError(f"No map called {missing[0]} in the list.", 404)
    return [by_id[i] for i in dict.fromkeys(ids)]


async def _outline(client: httpx.AsyncClient, region: dict[str, Any]) -> dict[str, Any] | None:
    if not region.get("outline"):
        return None
    try:
        doc = (await _get(client, region["outline"])).json()
    except (httpx.HTTPError, ValueError):
        return None
    if isinstance(doc, dict) and doc.get("type") == "Feature":
        doc = doc.get("geometry")
    return doc if isinstance(doc, dict) and doc.get("type") in {"Polygon", "MultiPolygon"} else None


async def records(regions: list[dict[str, Any]], keep: set[str]) -> list[dict[str, Any]]:
    """What the maps container needs for each map. Ones it already has are
    kept as they are, so nothing about a built map changes under it."""
    out: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for region in regions:
            if region["id"] in keep:
                out.append({"id": region["id"], "keep": True})
                continue
            record: dict[str, Any] = {
                "id": region["id"],
                "name": region["name"],
                "pbf": region["pbf"],
                "photon": [{"url": photon_url(p["path"]), "countries": p["countries"]} for p in region["photon"]],
                "clip": region["clip"],
                "gnaf": region["id"] == "australia",
            }
            outline = await _outline(client, region)
            if outline is not None:
                record["geometry"] = outline
            elif region.get("bbox"):
                record["bbox"] = region["bbox"]
            else:
                raise RegionError("Couldn't reach the map download site for this map's outline. Try again in a few minutes.", 502)
            out.append(record)
    return out
