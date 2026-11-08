"""P Maps offline areas (``/api/maps/offline``): what each person keeps on
their phones for when there's no signal, and links to the packs.

The ``maps`` container cuts every map build into 1-degree squares ("cells",
id ``<west>_<south>``, e.g. ``151_-34``): a map, routing tiles and search for
each, plus shared level-0 routing tiles, cameras and chargers. They're listed
in ``<build>/areas/index.json`` (see ``maps/areas.py``). An area here is a set
of those squares: a framed view, a route's corridor, or around a place.

Everything is owner-scoped: another person's area is a 404. The packs are the
same for everyone (like the basemap), but every download is a signed ``/m/``
link issued to the person asking, naming the build it's from, so a phone never
mixes routing tiles from two builds without noticing.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import _bearer
from app.auth.models import User
from app.database import get_db

from . import data
from .models import MapOfflineArea

router = APIRouter(prefix="/offline")

MAX_AREAS = 30
MAX_CELLS = 400
MAX_DEVICES = 10
SHAPE_MAX_CHARS = 20_000
CORRIDOR_KM = 10.0
SAMPLE_KM = 2.0
ATTRIBUTION = "© OpenStreetMap contributors · Protomaps · Addresses: G-NAF © Geoscape Australia"
FILE_NAMES = {"map": "map.pmtiles", "route": "route.tar", "places": "places.sqlite", "addresses": "addresses.sqlite"}
CELL = re.compile(r"^-?\d{1,3}_-?\d{1,2}$")


async def _maps_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The web session, or the phone's app password (scope ``maps``)."""
    from .router import maps_user

    return await maps_user(request, credentials, db)


# ---- The packs on disk ------------------------------------------------------


class _Index:
    key: tuple[str, float] | None = None
    value: dict[str, Any] | None = None


_index = _Index()


def index() -> dict[str, Any] | None:
    """The live build's ``areas/index.json``, or None when it has no packs."""
    build = data.current_build()
    if not build:
        return None
    path = data.root() / build / "areas" / "index.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if _index.key != (build, mtime):
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(loaded, dict) or not isinstance(loaded.get("cells"), dict):
            return None
        _index.key, _index.value = (build, mtime), loaded
    return _index.value


def enabled() -> bool:
    """Not turned off with ``MAPS_OFFLINE=0`` in the maps container."""
    return data.status().get("offline") is not False


def build_tag(build: str) -> int:
    from app.files.media_urls import version_tag

    return version_tag("offline", build)


def state() -> dict[str, Any]:
    """For the admin panel and the phone: off | building | waiting | failed | ready."""
    st = data.status()
    idx = index()
    build = data.current_build()
    if st.get("offline") is False:
        name = "off"
    elif idx is not None:
        name = "ready"
    elif st.get("state") == "building":
        name = "building"
    elif build and (data.root() / build / "areas.failed").exists():
        name = "failed"
    elif st.get("state") == "off" and not build:
        name = "off"
    else:
        # This build was made before packs were turned on: the next refresh has them.
        name = "waiting"
    totals = (idx or {}).get("totals") or {}
    return {"state": name, "squares": totals.get("squares", 0) if idx else 0, "bytes": totals.get("bytes", 0) if idx else 0}


def file_path(kind: str, west: int, south: int, tile: int) -> tuple[str, str] | None:
    """(build, path under the build) of a file that's in the live build's
    packs; None if it isn't (or packs are off)."""
    idx = index()
    build = data.current_build()
    if idx is None or not build:
        return None
    if kind in FILE_NAMES:
        cell = f"{west}_{south}"
        files = ((idx["cells"].get(cell) or {}).get("files") or {})
        if kind not in files:
            return None
        rel = f"areas/{cell}/{FILE_NAMES[kind]}"
    elif kind == "l0":
        if str(tile) not in (idx.get("l0") or {}):
            return None
        rel = f"areas/l0/{tile}.tar"
    elif kind in ("cameras", "chargers"):
        if kind not in (idx.get("base") or {}):
            return None
        rel = f"areas/base/{kind}.json"
    else:
        return None
    return (build, rel) if (data.root() / build / rel).is_file() else None


# ---- Squares from a box, a route or a place -----------------------------------


def _cell(cx: int, cy: int) -> str:
    return f"{cx}_{cy}"


def _parse_cell(cell: str) -> tuple[int, int]:
    west, south = cell.split("_", 1)
    return int(west), int(south)


def box_cells(west: float, south: float, east: float, north: float) -> list[str]:
    x0, y0 = math.floor(west), math.floor(south)
    x1, y1 = max(math.ceil(east), x0 + 1), max(math.ceil(north), y0 + 1)
    return [_cell(x, y) for y in range(y0, y1) for x in range(x0, x1)]


def _to_cell_m(lat: float, lon: float, cx: int, cy: int) -> float:
    """Metres from a point to the nearest edge of a square (0 inside it)."""
    return data.distance_m(lat, lon, min(max(lat, cy), cy + 1), min(max(lon, cx), cx + 1))


def near_cells(lat: float, lon: float, km: float) -> set[str]:
    """Squares within ``km`` of a point."""
    pad_lat = km / 111.0
    pad_lon = pad_lat / max(0.05, math.cos(math.radians(lat)))
    out = set()
    for cell in box_cells(lon - pad_lon, lat - pad_lat, lon + pad_lon, lat + pad_lat):
        cx, cy = _parse_cell(cell)
        if _to_cell_m(lat, lon, cx, cy) <= km * 1000:
            out.add(cell)
    return out


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    """A quick distance, close enough over a few kilometres."""
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(b[0] - a[0], (b[1] - a[1]) * k) * 111_195.0


def samples(line: list[tuple[float, float]], every_km: float = SAMPLE_KM) -> list[tuple[float, float]]:
    """Points every ``every_km`` along the line, plus both ends. No point of
    the line is further than half a step from one of them."""
    if not line:
        return []
    out = [line[0]]
    step = every_km * 1000
    since = 0.0
    for a, b in zip(line, line[1:]):
        gap = _metres(a, b)
        if gap <= 0:
            continue
        at = step - since
        while at <= gap:
            t = at / gap
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            at += step
        since = (since + gap) % step
    if out[-1] != line[-1]:
        out.append(line[-1])
    return out


def corridor_cells(line: list[tuple[float, float]], km: float = CORRIDOR_KM) -> set[str]:
    """Squares within ``km`` of a route: points every 2 km, 10 km either side."""
    out: set[str] = set()
    for lat, lon in samples(line):
        out |= near_cells(lat, lon, km)
    return out


def encode_polyline(points: list[tuple[float, float]], precision: int = 6) -> str:
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def _ranked(points: list[tuple[float, float]]) -> list[int]:
    """Visvalingam-Whyatt: how long each point survives as the line is
    simplified (higher keeps longer; both ends always stay). O(n log n), so a
    huge or odd shape can't hold up the server."""
    import heapq

    n = len(points)
    rank = [0] * n
    rank[0] = rank[-1] = n
    prev, nxt = list(range(-1, n - 1)), list(range(1, n + 1))

    def area(i: int) -> float:
        (ay, ax), (by, bx), (cy, cx) = points[prev[i]], points[i], points[nxt[i]]
        return abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay))

    current = [0.0] * n
    heap = []
    for i in range(1, n - 1):
        current[i] = area(i)
        heap.append((current[i], i))
    heapq.heapify(heap)
    order, floor = 0, 0.0
    while heap:
        a, i = heapq.heappop(heap)
        if rank[i] or a != current[i]:
            continue
        floor = max(floor, a)
        order += 1
        rank[i] = order
        p, q = prev[i], nxt[i]
        nxt[p], prev[q] = q, p
        for j in (p, q):
            if 0 < j < n - 1 and not rank[j]:
                current[j] = max(area(j), floor)
                heapq.heappush(heap, (current[j], j))
    return rank


def simplified_shape(line: list[tuple[float, float]]) -> str:
    """The route as polyline6, simplified (keeping its most telling points)
    until it's at most 20 KB."""
    shape = encode_polyline(line)
    if len(shape) <= SHAPE_MAX_CHARS or len(line) < 3:
        return shape
    rank = _ranked(line)
    cut = sorted(rank)
    # The most points that still fit: keep a point if its rank is above the cut.
    lo, hi, best = 2, min(len(line), SHAPE_MAX_CHARS // 2), encode_polyline([line[0], line[-1]])
    while lo <= hi:
        k = (lo + hi) // 2
        floor = cut[-k]
        got = encode_polyline([p for p, r in zip(line, rank) if r >= floor])
        if len(got) <= SHAPE_MAX_CHARS:
            best, lo = got, k + 1
        else:
            hi = k - 1
    return best


# ---- Sizes --------------------------------------------------------------------


def _bytes(idx: dict[str, Any] | None, cells: list[str], with_addresses: bool) -> dict[str, Any]:
    """Download size for these squares: their own files, the level-0 tiles
    they need (once each), and the shared base."""
    if idx is None:
        return {"bytes": None, "addresses_bytes": None}
    total = addresses = 0
    level0: set[str] = set()
    for cell in cells:
        entry = idx["cells"].get(cell)
        if not entry:
            continue
        files = entry.get("files") or {}
        for kind in ("map", "route", "places"):
            total += int((files.get(kind) or {}).get("bytes") or 0)
        addresses += int((files.get("addresses") or {}).get("bytes") or 0)
        if entry.get("l0") is not None:
            level0.add(str(entry["l0"]))
    total += sum(int((idx.get("l0") or {}).get(t, {}).get("bytes") or 0) for t in level0)
    total += sum(int(b.get("bytes") or 0) for b in (idx.get("base") or {}).values())
    if with_addresses:
        total += addresses
    return {"bytes": total, "addresses_bytes": addresses}


def _known(idx: dict[str, Any] | None, cells: set[str] | list[str]) -> list[str]:
    """The squares that have packs (the sea and empty desert don't), in order."""
    got = [c for c in cells if idx is None or c in idx["cells"]]
    return sorted(got, key=lambda c: (-_parse_cell(c)[1], _parse_cell(c)[0]))


def _too_big(n: int) -> HTTPException:
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"That's too big an area for one download ({n} squares; the most is {MAX_CELLS}). Zoom in, or save it as two areas.",
    )


# ---- API --------------------------------------------------------------------


class Box(BaseModel):
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)

    @model_validator(mode="after")
    def _ordered(self) -> "Box":
        if self.east <= self.west or self.north <= self.south:
            raise ValueError("The box's east must be past its west, and its north past its south.")
        return self


class Around(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    km: float = Field(default=30, ge=1, le=200)


class AreaBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["view", "route", "around"] = "view"
    box: Box | None = None
    # The route: one encoded polyline6, or one per leg.
    shape: str | list[str] | None = None
    around: Around | None = None
    with_addresses: bool = True

    @model_validator(mode="after")
    def _has_its_part(self) -> "AreaBody":
        need = {"view": self.box, "route": self.shape, "around": self.around}[self.kind]
        if not need:
            raise ValueError({"view": "A view needs its box.", "route": "A route needs its shape.", "around": "Around a place needs the place."}[self.kind])
        if isinstance(self.shape, list) and not 1 <= len(self.shape) <= 25:
            raise ValueError("A route has 1 to 25 legs.")
        shapes = [self.shape] if isinstance(self.shape, str) else (self.shape or [])
        if sum(len(s) for s in shapes) > 2_000_000:
            raise ValueError("That route is too long.")
        return self


class AreaPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    with_addresses: bool | None = None


class DeviceReport(BaseModel):
    device_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    name: str = Field(min_length=1, max_length=80)
    # removed: the phone deleted the area (its entry goes).
    state: Literal["waiting", "downloading", "ready", "update", "failed", "no_space", "removed"]
    build: str | None = Field(default=None, max_length=40)
    bytes: int = Field(default=0, ge=0, le=1 << 50)


def _decode(shapes: list[str]) -> list[tuple[float, float]]:
    line: list[tuple[float, float]] = []
    for shape in shapes:
        try:
            line += data.decode_polyline(shape)
        except (IndexError, ValueError):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That isn't a route shape.") from None
    if not line or any(not (-90 <= lat <= 90 and -180 <= lon <= 180) for lat, lon in line):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That isn't a route shape.")
    return line


def _area(a: MapOfflineArea, idx: dict[str, Any] | None) -> dict[str, Any]:
    devices = [{"device_id": k, **v} for k, v in (a.devices or {}).items()]
    devices.sort(key=lambda d: d.get("at") or "", reverse=True)
    return {
        "id": str(a.id),
        "name": a.name,
        "kind": a.kind,
        "box": {"west": a.west, "south": a.south, "east": a.east, "north": a.north},
        "shape": a.shape,
        "cells": list(a.cells or []),
        "squares": len(a.cells or []),
        "with_addresses": a.with_addresses,
        **_bytes(idx, list(a.cells or []), a.with_addresses),
        "devices": devices,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


async def _own(db: AsyncSession, user: User, area_id: uuid.UUID) -> MapOfflineArea:
    row = await db.get(MapOfflineArea, area_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Offline area not found")
    return row


@router.get("")
async def overview(db: AsyncSession = Depends(get_db), user: User = Depends(_maps_user)) -> dict[str, Any]:
    """Whether this server has packs, and your areas."""
    idx = await asyncio.to_thread(index)
    on = await asyncio.to_thread(enabled)
    st = await asyncio.to_thread(data.status)
    rows = (await db.execute(
        select(MapOfflineArea).where(MapOfflineArea.user_id == user.id).order_by(MapOfflineArea.created_at.desc())
    )).scalars().all()
    ready = on and idx is not None
    return {
        "enabled": on,
        "ready": ready,
        "building": on and not ready and st.get("state") == "building",
        "build": (idx.get("build") or data.current_build()) if ready else None,
        "built_at": idx.get("built_at") if ready else None,
        "search": bool(idx.get("search")) if ready else False,
        "attribution": ATTRIBUTION,
        "max_areas": MAX_AREAS,
        "areas": [_area(a, idx if ready else None) for a in rows],
    }


@router.get("/estimate")
async def estimate(
    west: float = Query(ge=-180, le=180),
    south: float = Query(ge=-90, le=90),
    east: float = Query(ge=-180, le=180),
    north: float = Query(ge=-90, le=90),
    addresses: bool = True,
    user: User = Depends(_maps_user),
) -> dict[str, Any]:
    """The squares and download size for a box (the live size under the frame)."""
    _ = user
    if east <= west or north <= south:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That isn't a box.")
    idx = await asyncio.to_thread(index)
    cells = _known(idx, box_cells(west, south, east, north))
    return {
        "ready": idx is not None,
        "cells": cells,
        "squares": len(cells),
        "too_big": len(cells) > MAX_CELLS,
        "max_squares": MAX_CELLS,
        **_bytes(idx, cells, addresses),
    }


@router.post("/areas", status_code=status.HTTP_201_CREATED)
async def create_area(body: AreaBody, db: AsyncSession = Depends(get_db), user: User = Depends(_maps_user)) -> dict[str, Any]:
    if not await asyncio.to_thread(enabled):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Offline maps aren't turned on on this server.")
    count = (await db.execute(select(func.count()).select_from(MapOfflineArea).where(MapOfflineArea.user_id == user.id))).scalar_one()
    if count >= MAX_AREAS:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"You have {MAX_AREAS} offline areas, the most there can be. Delete one first.")
    name = " ".join(body.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Give the area a name.")
    idx = await asyncio.to_thread(index)
    shape = None
    if body.kind == "view":
        b = body.box
        assert b is not None
        box = (b.west, b.south, b.east, b.north)
        found: set[str] | list[str] = box_cells(*box)
    elif body.kind == "route":
        shapes = [body.shape] if isinstance(body.shape, str) else list(body.shape or [])

        def work() -> tuple[set[str], str, tuple[float, float, float, float]]:
            line = _decode(shapes)
            lats, lons = [p[0] for p in line], [p[1] for p in line]
            return corridor_cells(line), simplified_shape(line), (min(lons), min(lats), max(lons), max(lats))

        found, shape, box = await asyncio.to_thread(work)
    else:
        a = body.around
        assert a is not None
        found = near_cells(a.lat, a.lon, a.km)
        pad = a.km / 111.0
        pad_lon = pad / max(0.05, math.cos(math.radians(a.lat)))
        box = (max(-180.0, a.lon - pad_lon), max(-90.0, a.lat - pad), min(180.0, a.lon + pad_lon), min(90.0, a.lat + pad))
    cells = _known(idx, found)
    if len(cells) > MAX_CELLS:
        raise _too_big(len(cells))
    if not cells:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="There's no map data in that area.")
    row = MapOfflineArea(
        user_id=user.id, name=name, kind=body.kind, west=box[0], south=box[1], east=box[2], north=box[3],
        shape=shape, cells=cells, with_addresses=body.with_addresses, devices={},
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _area(row, idx)


@router.patch("/areas/{area_id}")
async def edit_area(area_id: uuid.UUID, body: AreaPatch, db: AsyncSession = Depends(get_db), user: User = Depends(_maps_user)) -> dict[str, Any]:
    row = await _own(db, user, area_id)
    if body.name is not None:
        name = " ".join(body.name.split())
        if not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Give the area a name.")
        row.name = name
    if body.with_addresses is not None:
        row.with_addresses = body.with_addresses
    await db.commit()
    await db.refresh(row)
    return _area(row, await asyncio.to_thread(index))


@router.delete("/areas/{area_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_area(area_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_maps_user)) -> Response:
    row = await _own(db, user, area_id)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/areas/{area_id}/device")
async def report_device(area_id: uuid.UUID, body: DeviceReport, db: AsyncSession = Depends(get_db), user: User = Depends(_maps_user)) -> dict[str, Any]:
    """A phone says what it has of this area."""
    row = await _own(db, user, area_id)
    devices = dict(row.devices or {})
    devices.pop(body.device_id, None)
    if body.state != "removed":
        devices[body.device_id] = {
            "name": " ".join(body.name.split())[:80] or "Phone",
            "state": body.state,
            "build": body.build,
            "bytes": body.bytes,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        # The phones heard from most recently.
        while len(devices) > MAX_DEVICES:
            oldest = min(devices, key=lambda k: devices[k].get("at") or "")
            devices.pop(oldest)
    row.devices = devices
    await db.commit()
    await db.refresh(row)
    return _area(row, await asyncio.to_thread(index))


@router.get("/files")
async def files(
    cells: str = Query(min_length=1, max_length=MAX_CELLS * 9),
    addresses: bool = True,
    user: User = Depends(_maps_user),
) -> dict[str, Any]:
    """Signed links to download these squares (and the shared files they
    need), with each file's size and SHA-256. Links last a day or two; ask
    again when one runs out. Every link names the build: when a new build goes
    live, old links stop working and this lists the new files."""
    from app.files import media_urls

    wanted = [c for c in dict.fromkeys(c.strip() for c in cells.split(",")) if c]
    if not wanted or len(wanted) > MAX_CELLS or any(not CELL.match(c) for c in wanted):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Ask for 1 to {MAX_CELLS} squares, as west_south (e.g. 151_-34).")
    if not await asyncio.to_thread(enabled):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Offline maps aren't turned on on this server.")
    idx = await asyncio.to_thread(index)
    build = data.current_build()
    if idx is None or not build:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Your server is still building its maps. Try again later.")
    ver = build_tag(build)

    def link(kind: str, **where: int) -> str:
        return media_urls.sign_offline(user.id, user.token_version, kind, ver, **where)

    out: list[dict[str, Any]] = []
    missing: list[str] = []
    level0: set[str] = set()
    for cell in wanted:
        entry = idx["cells"].get(cell)
        if not entry:
            missing.append(cell)
            continue
        cx, cy = _parse_cell(cell)
        for kind in FILE_NAMES:
            info = (entry.get("files") or {}).get(kind)
            if not info or (kind == "addresses" and not addresses):
                continue
            out.append({"cell": cell, "kind": kind, "bytes": info["bytes"], "sha256": info["sha256"], "url": link(kind, west=cx, south=cy)})
        if entry.get("l0") is not None:
            level0.add(str(entry["l0"]))
    for tile in sorted(level0, key=int):
        info = (idx.get("l0") or {}).get(tile)
        if info:
            out.append({"cell": None, "kind": "l0", "tile": int(tile), "bytes": info["bytes"], "sha256": info["sha256"], "url": link("l0", tile=int(tile))})
    for kind, info in sorted((idx.get("base") or {}).items()):
        out.append({"cell": None, "kind": kind, "bytes": info["bytes"], "sha256": info["sha256"], "url": link(kind)})
    return {
        "build": idx.get("build") or build,
        "built_at": idx.get("built_at"),
        "expires_at": datetime.fromtimestamp(media_urls.offline_expiry(), tz=timezone.utc).isoformat(),
        "files": out,
        "missing": missing,
        "bytes": sum(f["bytes"] for f in out),
    }
