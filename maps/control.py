"""The maps container's small control door (port 8003, Docker network only).

Promptly's backend reads the map data folder read-only, so choosing maps goes
through here: this container owns ``/data``.

    GET  /state     what's chosen, what's live, what's building, disk space
    PUT  /regions   {"regions": [...]}: the maps to keep (replaces the list);
                    {"id": ..., "keep": true} keeps one already chosen as it is
    POST /retry     try a failed build again now

A changed list is picked up by entry.sh within a few seconds. Downloads are
only ever taken from the two public map mirrors (regions.valid_region).
Python's standard library only.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import regions

DATA = regions.DATA
MAX_BODY = 40_000_000  # outlines of big countries are a few hundred KB each
MAX_REGIONS = 40
_sizes: dict[str, int] = {}


def _json(path: Path) -> dict | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _build_bytes(name: str) -> int:
    """A finished build never changes, so its size is worked out once."""
    if name not in _sizes:
        try:
            out = subprocess.run(["du", "-sb", str(DATA / name)], capture_output=True, text=True, timeout=120).stdout
            _sizes.clear()
            _sizes[name] = int(out.split()[0])
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            return 0
    return _sizes[name]


def _downloading() -> dict | None:
    """How far the map-file downloads are, while that step runs."""
    folder = DATA / "next" / "osm"
    try:
        files = list(folder.iterdir())
    except OSError:
        return None
    return {"bytes": sum(f.stat().st_size for f in files if f.is_file()), "files": len(files)}


def state() -> dict:
    plan = regions.plan()
    try:
        current = (DATA / "current").read_text(encoding="utf-8").strip()
    except OSError:
        current = ""
    manifest = _json(DATA / current / "manifest.json") if current and "/" not in current else None
    status = _json(DATA / "status.json") or {"state": "starting"}
    disk = shutil.disk_usage(DATA)
    live = None
    if manifest is not None:
        listed = manifest.get("regions")
        if not isinstance(listed, list):
            # Built before maps were chosen: it is whatever the plan says now.
            listed = [{"id": r["id"], "name": r["name"]} for r in plan["regions"]] if plan["legacy_ok"] else []
        live = {
            "build": current,
            "built_at": manifest.get("built_at"),
            "regions": listed,
            "signature": manifest.get("signature"),
            "bytes": _build_bytes(current),
        }
    return {
        "managed": "env" if plan["source"] == "env" else "ui",
        "chosen": plan["source"] != "none",
        "wanted": [{"id": r["id"], "name": r["name"]} for r in plan["regions"]],
        "signature": plan["signature"],
        "live": live,
        "status": status,
        "downloading": _downloading() if status.get("state") == "building" and status.get("step") == "osm" else None,
        "disk": {"free": disk.free, "total": disk.total},
        "offline": os.environ.get("MAPS_OFFLINE", "1") != "0",
    }


def set_regions(body: dict) -> tuple[int, dict]:
    if regions.env_region() is not None:
        return 409, {"error": "This server's map is set in .env (MAPS_PBF_URL, MAPS_PHOTON_URL, MAPS_BBOX). Take those lines out to choose maps here."}
    wanted = body.get("regions")
    if not isinstance(wanted, list) or len(wanted) > MAX_REGIONS:
        return 400, {"error": "regions must be a list"}
    seen: set[str] = set()
    clean = []
    have = {r["id"]: r for r in (regions.read_choice() or {"regions": []})["regions"] if isinstance(r, dict) and "id" in r}
    for r in wanted:
        # {"id": ..., "keep": true}: a map already chosen stays exactly as it is.
        if isinstance(r, dict) and r.get("keep"):
            if r.get("id") not in have:
                return 400, {"error": f"{r.get('id')}: not a map this server has"}
            if r["id"] not in seen:
                seen.add(r["id"])
                clean.append(have[r["id"]])
            continue
        why = regions.valid_region(r)
        if why:
            return 400, {"error": f"{r.get('id') if isinstance(r, dict) else '?'}: {why}"}
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        clean.append({
            "id": r["id"],
            "name": r["name"].strip(),
            "pbf": r["pbf"],
            "photon": [{"url": p["url"], "countries": sorted(set(p["countries"]))} for p in r["photon"]],
            "clip": bool(r.get("clip")),
            "gnaf": bool(r.get("gnaf")),
            **({"geometry": r["geometry"]} if r.get("geometry") else {"bbox": r["bbox"]}),
        })
    regions.write_choice(clean)
    return 200, state()


def retry() -> tuple[int, dict]:
    (DATA / ".kick").write_text(str(time.time()), encoding="utf-8")
    return 200, {"ok": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "promptly-maps"

    def log_message(self, *args: object) -> None:  # quiet: state is polled
        pass

    def _send(self, code: int, doc: dict) -> None:
        raw = json.dumps(doc, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_BODY:
                return None
            doc = json.loads(self.rfile.read(length))
        except (ValueError, OSError):
            return None
        return doc if isinstance(doc, dict) else None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/state":
            return self._send(200, state())
        self._send(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        if self.path != "/regions":
            return self._send(404, {"error": "not found"})
        body = self._body()
        if body is None:
            return self._send(400, {"error": "bad request"})
        self._send(*set_regions(body))

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/retry":
            return self._send(*retry())
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8003), Handler).serve_forever()
