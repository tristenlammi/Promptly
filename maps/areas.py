"""Offline packs for phones: the new build cut into 1-degree squares.

    areas.py <build dir> [--threads N] [--cells 151_-34,150_-34] [--bbox w,s,e,n]

For each square with roads (id ``<west>_<south>``, e.g. ``151_-34``), into
``<build>/areas/<square>/``:

- ``map.pmtiles``: the map, cut out of ``basemap.pmtiles`` (no download).
- ``route.tar``: the square's Valhalla tiles, level 1 (1 degree) and level 2
  (0.25 degree), copied out of ``valhalla_tiles.tar`` by offset. Untar it into
  a tile folder.
- ``places.sqlite`` and ``addresses.sqlite``: search (see search_index.py),
  when the search step wrote ``search.sqlite``.

Shared, in ``<build>/areas/``:

- ``l0/<tile id>.tar``: Valhalla's level-0 (motorway) tiles, 4 degrees each.
  Each square names the one it needs.
- ``base/cameras.json`` and ``base/chargers.json``, for all of Australia.
- ``index.json``: every square with its box, each file's bytes and SHA-256,
  and its level-0 tile. Written last: no index, no packs.

Everything comes from this one build, so a phone's routing tiles always match
each other. The work goes into ``areas.part`` and a stopped run picks up where
it left off. Python's standard library only, plus the ``pmtiles`` tool.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tarfile
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import search_index  # noqa: E402

FORMAT = 1
PMTILES = os.environ.get("PMTILES", "pmtiles")
# Valhalla's tile levels: (level, size in degrees).
LEVELS = {0: 4.0, 1: 1.0, 2: 0.25}
# Shrinks a square's box a hair, so the map doesn't take its neighbours' edge tiles.
EDGE = 1e-6


def tile_of(name: str) -> tuple[int, int] | None:
    """(level, tile id) from a member name like ``2/000/823/456.gph``."""
    if not name.endswith(".gph"):
        return None
    parts = name[: -len(".gph")].split("/")
    try:
        level = int(parts[0])
        tile = int("".join(parts[1:]))
    except ValueError:
        return None
    return (level, tile) if level in LEVELS else None


def tile_corner(level: int, tile: int) -> tuple[float, float]:
    """The tile's south-west corner (lon, lat)."""
    size = LEVELS[level]
    columns = round(360 / size)
    row, col = divmod(tile, columns)
    return -180 + col * size, -90 + row * size


def tile_path(level: int, tile: int) -> str:
    """Valhalla's own file name for a tile (GraphTile::FileSuffix)."""
    size = LEVELS[level]
    biggest = round(360 / size) * round(180 / size) - 1
    width = len(str(biggest))
    width += (3 - width % 3) % 3
    digits = str(tile).zfill(width)
    return f"{level}/" + "/".join(digits[i:i + 3] for i in range(0, width, 3)) + ".gph"


def l0_of(cx: int, cy: int) -> int:
    """The level-0 tile a square sits in."""
    return math.floor((cy + 90) / 4) * 90 + math.floor((cx + 180) / 4)


def read_tiles(tar_path: Path) -> list[tuple[int, int, str, int, int, int]]:
    """Every tile in the build's tar: (level, tile, name, offset, size, mtime)."""
    out = []
    with tarfile.open(tar_path, "r:") as tar:
        for m in tar:
            got = tile_of(m.name) if m.isfile() else None
            if got:
                out.append((got[0], got[1], m.name, m.offset_data, m.size, int(m.mtime)))
    return out


def write_tar(src: Path, members: list[tuple[str, int, int, int]], dest: Path) -> None:
    """A small tar of some of ``src``'s members, read by offset. The same
    members always make the same bytes."""
    with open(src, "rb") as raw, tarfile.open(dest, "w", format=tarfile.USTAR_FORMAT) as out:
        for name, offset, size, mtime in sorted(members):
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = size, mtime, 0o644
            raw.seek(offset)
            out.addfile(info, _Slice(raw, size))


class _Slice:
    def __init__(self, raw, size: int) -> None:  # noqa: ANN001
        self.raw, self.left = raw, size

    def read(self, n: int = -1) -> bytes:
        n = self.left if n < 0 else min(n, self.left)
        data = self.raw.read(n)
        self.left -= len(data)
        return data


def digest(path: Path) -> dict[str, object]:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": h.hexdigest()}


def cut_map(basemap: Path, cx: int, cy: int, dest: Path) -> None:
    box = f"{cx + EDGE:.6f},{cy + EDGE:.6f},{cx + 1 - EDGE:.6f},{cy + 1 - EDGE:.6f}"
    subprocess.run(
        [PMTILES, "extract", str(basemap), str(dest), f"--bbox={box}", "--download-threads=1", "--quiet"],
        check=True, stdout=subprocess.DEVNULL,
    )


def build_cell(job: dict) -> dict:
    """One square, into ``<out>/<cell>`` (via a temporary folder)."""
    build, out, cell = Path(job["build"]), Path(job["out"]), job["cell"]
    final = out / cell
    done = final / "cell.json"
    if done.is_file():
        return json.loads(done.read_text(encoding="utf-8"))
    cx, cy = search_index.parse_cell(cell)
    tmp = out / f".{cell}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    started = time.monotonic()
    cut_map(build / "basemap.pmtiles", cx, cy, tmp / "map.pmtiles")
    write_tar(build / "valhalla_tiles.tar", [tuple(t) for t in job["tiles"]], tmp / "route.tar")
    counts = {}
    if job["search"]:
        counts = search_index.slice_cell(build / "search.sqlite", cell, tmp)
    files = {"map": digest(tmp / "map.pmtiles"), "route": digest(tmp / "route.tar")}
    if job["search"]:
        files["places"] = digest(tmp / "places.sqlite")
        files["addresses"] = digest(tmp / "addresses.sqlite")
    entry = {
        "box": [cx, cy, cx + 1, cy + 1],
        "l0": job["l0"],
        "files": files,
        "counts": counts,
        "seconds": round(time.monotonic() - started, 2),
    }
    (tmp / "cell.json").write_text(json.dumps(entry, separators=(",", ":")), encoding="utf-8")
    shutil.rmtree(final, ignore_errors=True)
    os.replace(tmp, final)
    return entry


def plan(build: Path, only: set[str] | None, bbox: tuple[float, float, float, float] | None) -> tuple[dict, dict]:
    """The squares to cut, each with its routing tiles, and the level-0 tiles."""
    cells: dict[str, list] = {}
    level0: dict[int, tuple[str, int, int, int]] = {}
    for level, tile, name, offset, size, mtime in read_tiles(build / "valhalla_tiles.tar"):
        if level == 0:
            level0[tile] = (name, offset, size, mtime)
            continue
        lon, lat = tile_corner(level, tile)
        cx, cy = math.floor(lon + 1e-9), math.floor(lat + 1e-9)
        cells.setdefault(search_index.cell_name(cx, cy), []).append((name, offset, size, mtime))
    if only is not None:
        cells = {c: t for c, t in cells.items() if c in only}
    if bbox is not None:
        w, s, e, n = bbox
        cells = {c: t for c, t in cells.items() if w <= search_index.parse_cell(c)[0] < e and s <= search_index.parse_cell(c)[1] < n}
    return cells, level0


def run(build: Path, *, threads: int = 4, only: set[str] | None = None, bbox=None) -> dict:  # noqa: ANN001
    started = time.monotonic()
    out = build / "areas.part"
    out.mkdir(exist_ok=True)
    search = (build / "search.sqlite").is_file()
    cells, level0 = plan(build, only, bbox)
    jobs = []
    for cell, tiles in sorted(cells.items()):
        cx, cy = search_index.parse_cell(cell)
        l0 = l0_of(cx, cy)
        jobs.append({
            "build": str(build), "out": str(out), "cell": cell, "tiles": tiles, "search": search,
            "l0": l0 if l0 in level0 else None,
        })
    # The biggest squares first, so one city doesn't finish last on its own.
    jobs.sort(key=lambda j: -sum(t[2] for t in j["tiles"]))
    index_cells: dict[str, dict] = {}
    if threads > 1:
        with ProcessPoolExecutor(max_workers=threads) as pool:
            for job, entry in zip(jobs, pool.map(build_cell, jobs)):
                index_cells[job["cell"]] = entry
    else:
        for job in jobs:
            index_cells[job["cell"]] = build_cell(job)
    print(f"areas: {len(index_cells)} squares in {round(time.monotonic() - started)} s", file=sys.stderr, flush=True)

    shared_l0: dict[str, dict] = {}
    (out / "l0").mkdir(exist_ok=True)
    for tile in sorted({e["l0"] for e in index_cells.values() if e["l0"] is not None}):
        dest = out / "l0" / f"{tile}.tar"
        if not dest.is_file():
            write_tar(build / "valhalla_tiles.tar", [level0[tile]], dest.with_suffix(".part"))
            os.replace(dest.with_suffix(".part"), dest)
        lon, lat = tile_corner(0, tile)
        shared_l0[str(tile)] = {**digest(dest), "box": [lon, lat, lon + 4, lat + 4]}

    base: dict[str, dict] = {}
    (out / "base").mkdir(exist_ok=True)
    for name in ("cameras", "chargers"):
        src = build / f"{name}.json"
        if src.is_file():
            shutil.copyfile(src, out / "base" / f"{name}.json")
            base[name] = digest(out / "base" / f"{name}.json")

    for entry in index_cells.values():
        entry.pop("seconds", None)
    totals = {"squares": len(index_cells), "bytes": 0}
    for kind in ("map", "route", "places", "addresses"):
        totals[kind] = sum(e["files"].get(kind, {}).get("bytes", 0) for e in index_cells.values())
        totals["bytes"] += totals[kind]
    totals["l0"] = sum(e["bytes"] for e in shared_l0.values())
    totals["base"] = sum(e["bytes"] for e in base.values())
    totals["bytes"] += totals["l0"] + totals["base"]
    index = {
        "format": FORMAT,
        # The build's name and date are filled in when the build is swapped in.
        "build": None,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "search": search,
        "cells": dict(sorted(index_cells.items())),
        "l0": shared_l0,
        "base": base,
        "totals": totals,
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    final = build / "areas"
    shutil.rmtree(final, ignore_errors=True)
    os.replace(out, final)
    print("areas: " + json.dumps({**totals, "seconds": round(time.monotonic() - started)}), file=sys.stderr, flush=True)
    return index


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("build", type=Path)
    p.add_argument("--threads", type=int, default=int(os.environ.get("MAPS_BUILD_THREADS", "4")))
    p.add_argument("--cells", help="only these squares (for trying it out)")
    p.add_argument("--bbox", help="only squares in west,south,east,north (for trying it out)")
    args = p.parse_args(argv)
    only = set(args.cells.split(",")) if args.cells else None
    bbox = tuple(float(x) for x in args.bbox.split(",")) if args.bbox else None
    run(args.build, threads=args.threads, only=only, bbox=bbox)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
