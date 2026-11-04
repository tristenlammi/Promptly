"""The map data the ``maps`` container builds: which build is live, what state
the build is in, and the cameras and chargers it extracted."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings

_EARTH_M = 6_371_000.0


def root() -> Path:
    return Path(get_settings().MAPS_DATA_DIR)


def current_build() -> str | None:
    """The live build's folder name. Only ever one path segment."""
    try:
        name = (root() / "current").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        return None
    return name


def basemap_path() -> Path | None:
    """This server's map, if it has one: the live build's, or an older
    admin-provided file (``MAP_PMTILES``, ``uploads/.maps/basemap.pmtiles``)."""
    import os

    from app.files import storage

    build = current_build()
    if build:
        path = root() / build / "basemap.pmtiles"
        if path.is_file():
            return path
    raw = (os.environ.get("MAP_PMTILES") or "").strip()
    path = Path(raw) if raw else storage.UPLOAD_ROOT / ".maps" / "basemap.pmtiles"
    return path if path.is_file() else None


def basemap_tag(path: Path) -> int:
    from app.files.media_urls import version_tag

    stat = path.stat()
    return version_tag(path.name, stat.st_size, int(stat.st_mtime))


def manifest() -> dict[str, Any] | None:
    build = current_build()
    if not build:
        return None
    try:
        return json.loads((root() / build / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def status() -> dict[str, Any]:
    try:
        return json.loads((root() / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"state": "off"}


@dataclass
class _Pois:
    build: str | None = None
    cameras: list[dict[str, Any]] | None = None
    chargers: list[dict[str, Any]] | None = None


_cache = _Pois()


def _load(name: str) -> list[dict[str, Any]]:
    build = current_build()
    if build != _cache.build:
        _cache.build, _cache.cameras, _cache.chargers = build, None, None
    held = getattr(_cache, name)
    if held is not None:
        return held
    rows: list[dict[str, Any]] = []
    if build:
        try:
            rows = json.loads((root() / build / f"{name}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            rows = []
    setattr(_cache, name, rows)
    return rows


def cameras() -> list[dict[str, Any]]:
    return _load("cameras")


def chargers() -> list[dict[str, Any]]:
    return _load("chargers")


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_M * math.asin(min(1.0, math.sqrt(a)))


def decode_polyline(encoded: str, precision: int = 6) -> list[tuple[float, float]]:
    """(lat, lon) pairs from Valhalla's encoded shape."""
    points: list[tuple[float, float]] = []
    index = lat = lon = 0
    factor = 10.0**precision
    while index < len(encoded):
        for is_lon in (False, True):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lon:
                lon += delta
            else:
                lat += delta
        points.append((lat / factor, lon / factor))
    return points


def in_box(rows: list[dict[str, Any]], box: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    west, south, east, north = box
    return [r for r in rows if south <= r["lat"] <= north and west <= r["lon"] <= east]


def near_line(rows: list[dict[str, Any]], line: list[tuple[float, float]], within_m: float) -> list[dict[str, Any]]:
    """Rows within ``within_m`` of the line, in the order you'd reach them,
    each with how far along the line it is (``along_m``)."""
    if not line:
        return []
    # A point every kilometre or so is plenty for "near the route", and a
    # long drive has tens of thousands of shape points.
    samples: list[tuple[float, float, float]] = [(line[0][0], line[0][1], 0.0)]
    along = since = 0.0
    for a, b in zip(line, line[1:]):
        step = distance_m(a[0], a[1], b[0], b[1])
        along += step
        since += step
        if since >= min(within_m, 1000.0):
            samples.append((b[0], b[1], along))
            since = 0.0
    samples.append((line[-1][0], line[-1][1], along))
    pad_lat = within_m / 111_000.0
    south = min(s[0] for s in samples) - pad_lat
    north = max(s[0] for s in samples) + pad_lat
    pad_lon = pad_lat / max(0.2, math.cos(math.radians((south + north) / 2)))
    west = min(s[1] for s in samples) - pad_lon
    east = max(s[1] for s in samples) + pad_lon
    out: list[dict[str, Any]] = []
    for row in in_box(rows, (west, south, east, north)):
        best = min(samples, key=lambda s: (s[0] - row["lat"]) ** 2 + ((s[1] - row["lon"]) * math.cos(math.radians(row["lat"]))) ** 2)
        off = distance_m(best[0], best[1], row["lat"], row["lon"])
        if off <= within_m:
            out.append({**row, "along_m": round(best[2]), "off_m": round(off)})
    out.sort(key=lambda r: r["along_m"])
    return out
