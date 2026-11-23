"""Choosing this server's maps (``/api/maps/regions``), for admins: the admin
panel's P Maps card and the first-time setup wizard both use it.

    GET  /api/maps/regions            what's chosen, installed and building; disk space
    GET  /api/maps/regions/catalog    the maps to choose from, with rough sizes
    POST /api/maps/regions/estimate   {ids}: what that whole set would cost
    PUT  /api/maps/regions            {ids}: keep exactly these maps
    POST /api/maps/regions/add        {ids}: these as well
    POST /api/maps/regions/remove     {ids}: not these any more
    POST /api/maps/regions/retry      try a failed build again now

Server configuration only: nothing here reads anyone's places, searches or
trips. The maps container does the work (``regions.control``); until an admin
chooses, it downloads nothing.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auth.deps import require_admin
from app.auth.models import User

from . import regions

router = APIRouter()

class Ids(BaseModel):
    ids: list[str] = Field(max_length=regions.MAX_REGIONS)


class Choice(Ids):
    # Go ahead even when the estimate says the disk is too small.
    force: bool = False


def _fail(exc: regions.RegionError) -> HTTPException:
    return HTTPException(exc.code, detail=exc.message)


async def _state() -> dict[str, Any] | None:
    try:
        return await regions.control("GET", "/state")
    except regions.RegionError as exc:
        raise _fail(exc) from None


def _off() -> HTTPException:
    return HTTPException(503, detail="P Maps isn't running on this server, so there's nowhere to put a map yet.")


@router.get("/regions")
async def state(admin: User = Depends(require_admin)) -> dict[str, Any]:
    _ = admin
    return regions.describe(await _state())


@router.get("/regions/catalog")
async def catalog(refresh: bool = Query(False), admin: User = Depends(require_admin)) -> dict[str, Any]:
    _ = admin
    doc = await regions.catalog(refresh=refresh)
    return {"source": doc["source"], "fetched_at": doc.get("fetched_at"), "regions": [regions.public(r) for r in doc["regions"]]}


async def _estimate(ids: list[str], state: dict[str, Any] | None) -> dict[str, Any]:
    listed = {r["id"]: r for r in (await regions.catalog())["regions"]}
    wanted = {r["id"] for r in (state or {}).get("wanted") or []}
    unknown = [i for i in ids if i not in listed and i not in wanted]
    if unknown:
        raise HTTPException(404, detail=f"No map called {unknown[0]} in the list.")
    chosen = [listed[i] for i in dict.fromkeys(ids) if i in listed]
    live = (state or {}).get("live") or {}
    disk = (state or {}).get("disk") or {}
    out = regions.estimate(
        chosen,
        await regions.measured_osm_mb(chosen),
        offline=bool((state or {}).get("offline", True)),
        live_bytes=int(live.get("bytes") or 0),
        free_bytes=disk.get("free"),
    )
    # A map kept from before that the list doesn't know can't be sized.
    out["complete"] = out["complete"] and len(chosen) == len(dict.fromkeys(ids))
    return out


@router.post("/regions/estimate")
async def estimate(body: Ids, admin: User = Depends(require_admin)) -> dict[str, Any]:
    """What keeping exactly these maps would cost. They're built together, so
    the numbers are for the whole set, not just the new one."""
    _ = admin
    return await _estimate(body.ids, await _state())


async def _apply(ids: list[str], force: bool) -> dict[str, Any]:
    state = await _state()
    if state is None:
        raise _off()
    if state.get("managed") == "env":
        raise HTTPException(409, detail="This server's map is set in its .env file (MAPS_PBF_URL, MAPS_PHOTON_URL, MAPS_BBOX). Take those lines out to choose maps here.")
    ids = list(dict.fromkeys(ids))
    keep = {r["id"] for r in state.get("wanted") or []} & set(ids)
    new = [i for i in ids if i not in keep]
    try:
        picked = {r["id"]: r for r in await regions.pick(new)}
        if new and not force:
            cost = await _estimate(ids, state)
            if cost["fits"] is False:
                raise HTTPException(
                    409,
                    detail=f"There isn't enough free disk space for that: it needs about {cost['disk_needed_bytes'] / 1e9:.0f} GB while it builds and this server has {(cost['free_bytes'] or 0) / 1e9:.0f} GB free.",
                )
        ordered = [picked[i] if i in picked else {"id": i} for i in ids]
        body = {"regions": await regions.records(ordered, keep)}
        return regions.describe(await regions.control("PUT", "/regions", body))
    except regions.RegionError as exc:
        raise _fail(exc) from None


@router.put("/regions")
async def choose(body: Choice, admin: User = Depends(require_admin)) -> dict[str, Any]:
    """Keep exactly these maps. An empty list takes them all away."""
    _ = admin
    return await _apply(body.ids, body.force)


@router.post("/regions/add")
async def add(body: Choice, admin: User = Depends(require_admin)) -> dict[str, Any]:
    _ = admin
    state = await _state()
    if state is None:
        raise _off()
    have = [r["id"] for r in state.get("wanted") or []]
    return await _apply(have + [i for i in body.ids if i not in have], body.force)


@router.post("/regions/remove")
async def remove(body: Ids, admin: User = Depends(require_admin)) -> dict[str, Any]:
    _ = admin
    state = await _state()
    if state is None:
        raise _off()
    return await _apply([r["id"] for r in state.get("wanted") or [] if r["id"] not in set(body.ids)], True)


@router.post("/regions/retry")
async def retry(admin: User = Depends(require_admin)) -> dict[str, Any]:
    _ = admin
    try:
        if await regions.control("POST", "/retry") is None:
            raise _off()
    except regions.RegionError as exc:
        raise _fail(exc) from None
    return {"ok": True}
