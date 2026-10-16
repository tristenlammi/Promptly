"""Reading a folder of photos, or an Apple export (WP-10.3, Part C §4.9).

The same import run as a Takeout (``imports.run``) — only the reading
differs:

* **A folder** (any zip or tgz of one: an old drive, a camera card): every
  photo and video goes to Camera Uploads by the date inside it, else the
  file's own date in the archive (meaningful here, unlike a Takeout's);
  everything else keeps its folders under "Imported – <archive>".
* **An Apple export.** Photos for Mac's "Export Unmodified Original" (with
  "Export IPTC as XMP") writes the original files — a Live Photo as its
  still and its video, paired again here as an iPhone upload is — and an
  XMP sidecar beside each with the date, place and description. An iCloud
  Photos download (privacy.apple.com) has the originals, which carry their
  own dates, and CSV lists of photo details; those are read when their
  columns are recognised (``imgName`` + ``originalCreationDate``) and
  otherwise ignored — the photo's own date always comes first. Apple hasn't
  documented either format, so this reads only what it's sure of.

Junk is left out: ``__MACOSX/``, ``.DS_Store``, ``._*``, ``Thumbs.db``,
``desktop.ini``.

* **A Promptly export** (WP-10.4) is a folder like any other, plus a
  ``<name>.json`` beside each photo in Google Takeout's sidecar shape —
  read for its date, place, description, favourite, archived and
  ``promptly.albums`` (so albums come back) — and its own ``README.txt`` /
  ``albums.json``, left out. Its files keep their folders from ``My files``.
"""
from __future__ import annotations

import csv
import io
import re
import tarfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}
_SIDE_MAX = 2 * 1024 * 1024
_CSV_MAX = 64 * 1024 * 1024


@dataclass
class Entry:
    part: int
    name: str  # inside the archive
    path: str  # cleaned relative path
    size: int
    mtime: str | None  # naive local ISO (zip) or None
    mtime_epoch: int | None  # tar's UTC seconds


@dataclass
class FolderScan:
    entries: list[Entry] = field(default_factory=list)
    xmp: dict[str, bytes] = field(default_factory=dict)  # path → XMP bytes
    json: dict[str, bytes] = field(default_factory=dict)  # media path → its .json sidecar
    csvs: list[bytes] = field(default_factory=list)


def _clean(name: str) -> str | None:
    n = name.replace("\\", "/").lstrip("./")
    if not n or n.endswith("/"):
        return None
    segs = n.split("/")
    if segs[0] == "__MACOSX" or any(s.startswith("._") for s in segs) or segs[-1].lower() in _JUNK_NAMES:
        return None
    return n


def scan_part(path: Path, part: int) -> FolderScan:
    out = FolderScan()
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = _clean(info.filename)
                if rel is None:
                    continue
                y, mo, d, h, mi, s = info.date_time
                local = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}" if y >= 1980 else None
                _take(out, part, info.filename, rel, info.file_size, local, None, lambda i=info: zf.read(i))
        return out
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile():
                continue
            rel = _clean(m.name)
            if rel is None:
                continue
            _take(out, part, m.name, rel, m.size, None, int(m.mtime) if m.mtime else None,
                  lambda m=m: tf.extractfile(m).read())  # type: ignore[union-attr]


    return out


def _take(out: FolderScan, part: int, name: str, rel: str, size: int, local: str | None, epoch: int | None, read) -> None:  # noqa: ANN001
    low = rel.lower()
    if low.endswith(".xmp") and size <= _SIDE_MAX:
        out.xmp[rel] = read()
        return
    if low.endswith(".json") and size <= _SIDE_MAX and _is_media_name(rel[: -len(".json")]):
        out.json[rel[: -len(".json")]] = read()
        return
    if low.endswith(".csv") and size <= _CSV_MAX:
        out.csvs.append(read())
        # (a CSV is also kept as a file below — it may be someone's data)
    out.entries.append(Entry(part, name, rel, size, local, epoch))


def _is_media_name(name: str) -> bool:
    from app.imports.takeout import _media_exts

    return "." in name and ("." + name.rsplit(".", 1)[-1].lower()) in _media_exts()


def parse_json_sidecar(raw: bytes) -> dict[str, Any]:
    """Google Takeout's sidecar shape (a Promptly export writes it too)."""
    import json

    try:
        d = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(d, dict):
        return {}
    out: dict[str, Any] = {}
    ts = (d.get("photoTakenTime") or {}).get("timestamp") if isinstance(d.get("photoTakenTime"), dict) else None
    if ts and str(ts).isdigit() and int(ts) > 0:
        out["when"] = int(ts)
    geo = d.get("geoData") if isinstance(d.get("geoData"), dict) else {}
    lat, lon = geo.get("latitude"), geo.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat or lon):
        out["lat"], out["lon"] = float(lat), float(lon)
    if isinstance(d.get("description"), str) and d["description"].strip():
        out["description"] = d["description"].strip()[:2000]
    out["favorite"] = d.get("favorited") is True
    out["archived"] = d.get("archived") is True
    extra = d.get("promptly") if isinstance(d.get("promptly"), dict) else {}
    out["albums"] = [str(a)[:200] for a in (extra.get("albums") or []) if isinstance(a, str) and a.strip()]
    return out


# ------------------------------------------------------------------ XMP


_XMP_DATE_KEYS = ("DateTimeOriginal", "DateCreated", "CreateDate")


def _xmp_value(text: str, key: str) -> str | None:
    """A property's value, written as an attribute or as an element (an
    rdf:Alt/Seq's first item for dc:title/description)."""
    m = re.search(rf'[\w]+:{key}\s*=\s*"([^"]*)"', text)
    if m:
        return m.group(1)
    m = re.search(rf"<[\w]+:{key}\b[^>]*>(.*?)</[\w]+:{key}>", text, re.S)
    if not m:
        return None
    inner = m.group(1)
    li = re.search(r"<rdf:li\b[^>]*>(.*?)</rdf:li>", inner, re.S)
    value = (li.group(1) if li else inner).strip()
    return re.sub(r"<[^>]+>", "", value).strip() or None


def _gps(value: str | None) -> float | None:
    """XMP GPS: "26,23.4000S" (degrees,minutes + N/S/E/W) or a decimal."""
    if not value:
        return None
    v = value.strip()
    sign = -1 if v[-1:].upper() in ("S", "W") else 1
    v = v.rstrip("NSEWnsew")
    try:
        if "," in v:
            parts = [float(p) for p in v.split(",")]
            deg = parts[0] + (parts[1] / 60 if len(parts) > 1 else 0) + (parts[2] / 3600 if len(parts) > 2 else 0)
        else:
            deg = float(v)
    except ValueError:
        return None
    return round(sign * deg, 6)


def parse_xmp(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8", "replace")
    out: dict[str, Any] = {}
    for key in _XMP_DATE_KEYS:
        when = parse_date(_xmp_value(text, key))
        if when is not None:
            out["when"] = when
            break
    lat, lon = _gps(_xmp_value(text, "GPSLatitude")), _gps(_xmp_value(text, "GPSLongitude"))
    if lat is not None and lon is not None and (lat or lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
        out["lat"], out["lon"] = lat, lon
    desc = _xmp_value(text, "description") or _xmp_value(text, "title")
    if desc:
        out["description"] = desc[:2000]
    return out


# ------------------------------------------------------------------ dates

_FORMATS = (
    "%Y:%m:%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%A %B %d,%Y %I:%M %p %Z",
    "%A %B %d, %Y %I:%M %p %Z",
    "%A %B %d,%Y %I:%M %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
)


def parse_date(value: str | None) -> datetime | int | None:
    """An exact instant (an aware datetime → epoch seconds) when the text
    carries its zone, a naive datetime when it doesn't (the owner's zone
    decides it), None when it isn't a date we know how to read — never a
    guess."""
    if not value:
        return None
    v = value.strip()
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        dt = None
        for fmt in _FORMATS:
            try:
                dt = datetime.strptime(v, fmt)
                if "%Z" in fmt and v.upper().endswith(("GMT", "UTC")):
                    dt = dt.replace(tzinfo=timezone.utc)
                break
            except ValueError:
                continue
    if dt is None or not (1900 <= dt.year <= 2100):
        return None
    return int(dt.timestamp()) if dt.tzinfo else dt


# ------------------------------------------------------------------ CSV


def parse_csvs(blobs: list[bytes]) -> dict[str, dict[str, Any]]:
    """Name → details from any CSV whose columns are recognised."""
    out: dict[str, dict[str, Any]] = {}
    for raw in blobs:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            continue
        reader = csv.DictReader(io.StringIO(text))
        cols = {c.lower(): c for c in (reader.fieldnames or [])}
        name_col, date_col = cols.get("imgname"), cols.get("originalcreationdate")
        if not name_col or not date_col:
            continue
        for row in reader:
            name = (row.get(name_col) or "").strip()
            if not name:
                continue
            item: dict[str, Any] = {}
            when = parse_date(row.get(date_col))
            if when is not None:
                item["when"] = when
            for flag in ("favorite", "deleted", "hidden"):
                col = cols.get(flag)
                if col and (row.get(col) or "").strip().lower() in ("yes", "true", "1"):
                    item[flag] = True
            out[name.lower()] = item
    return out


_DASH_N = re.compile(r"-\d+(\.[^.]+)$")
_EXPORT_FILES = "Promptly/My files/"


def build_plan(scans: list[FolderScan], *, source: str, archive_names: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    from app.imports.takeout import _media_exts

    exts = _media_exts()
    xmp: dict[str, bytes] = {}
    sidecars: dict[str, bytes] = {}
    csv_blobs: list[bytes] = []
    for s in scans:
        xmp.update(s.xmp)
        sidecars.update(s.json)
        csv_blobs.extend(s.csvs)
    # A Promptly export: its files are under Promptly/My files/.
    export = any(e.path.startswith(_EXPORT_FILES) for s in scans for e in s.entries)
    details = parse_csvs(csv_blobs) if source == "apple" else {}
    xmp_lower = {k.lower(): v for k, v in xmp.items()}

    photos: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    albums: dict[str, list[int]] = {}
    with_details, skipped_deleted, years = 0, 0, []
    seen: set[tuple[str, int]] = set()
    for s in scans:
        for e in s.entries:
            fname = e.path.rsplit("/", 1)[-1]
            ext = ("." + fname.rsplit(".", 1)[-1].lower()) if "." in fname else ""
            if ext not in exts:
                path = e.path
                if export:
                    if not path.startswith(_EXPORT_FILES):
                        continue  # its README, albums.json, notes
                    path = path[len(_EXPORT_FILES):]
                files.append({"part": e.part, "member": e.name, "path": path, "size": e.size})
                continue
            key = (fname.lower(), e.size)
            if key in seen:
                continue
            seen.add(key)
            info: dict[str, Any] = {}
            stem = e.path.rsplit(".", 1)[0]
            raw = xmp_lower.get((stem + ".xmp").lower()) or xmp_lower.get((e.path + ".xmp").lower())
            if raw:
                info.update(parse_xmp(raw))
            side = parse_json_sidecar(sidecars[e.path]) if e.path in sidecars else {}
            for k in ("when", "lat", "lon", "description"):
                if k not in info and k in side:
                    info[k] = side[k]
            row = details.get(fname.lower()) or details.get(_DASH_N.sub(r"\1", fname).lower()) or {}
            if row.get("deleted"):
                skipped_deleted += 1
                continue
            if "when" not in info and "when" in row:
                info["when"] = row["when"]
            when = info.get("when")
            if info:
                with_details += 1
            photos.append({
                "part": e.part, "member": e.name, "name": fname, "size": e.size, "mime": exts[ext],
                "taken": when if isinstance(when, int) else None,
                "taken_naive": when.isoformat() if isinstance(when, datetime) else None,
                "lat": info.get("lat"), "lon": info.get("lon"), "description": info.get("description"),
                "favorite": bool(row.get("favorite") or side.get("favorite")), "archived": bool(side.get("archived")),
                "folder_year": None,
                # The file's own date in the archive: the last resort.
                "mtime_naive": e.mtime, "mtime": e.mtime_epoch,
            })
            for title in side.get("albums") or []:
                albums.setdefault(title, []).append(len(photos) - 1)
            if isinstance(when, int):
                years.append(datetime.fromtimestamp(when, tz=timezone.utc).year)
            elif isinstance(when, datetime):
                years.append(when.year)
            elif e.mtime:
                years.append(int(e.mtime[:4]))
    stem = re.sub(r"\.(zip|tgz|tar\.gz|tar)$", "", archive_names[0], flags=re.I) if archive_names else "archive"
    root = ("Imported – Apple " if source == "apple" else "Imported – ") + stem[:120]
    plan = {"photos": photos, "albums": albums, "drive": files, "files_root": root, "source": source}
    videos = sum(1 for p in photos if p["mime"].startswith("video/"))
    report = {
        "photos": len(photos) - videos, "videos": videos,
        "bytes": sum(p["size"] for p in photos) + sum(f["size"] for f in files),
        "with_details": with_details, "matched_by": {}, "unmatched_sample": [],
        "albums": sorted(({"title": t, "count": len(ix)} for t, ix in albums.items()), key=lambda a: a["title"].lower()),
        "years": [min(years), max(years)] if years else None,
        "favorites": sum(1 for p in photos if p["favorite"]), "archived": sum(1 for p in photos if p["archived"]),
        "drive_files": len(files), "files_root": root,
        "skipped": {"other_products": 0, "trash": skipped_deleted, "unsupported": 0}, "other_products": [],
        "parts": len(scans),
    }
    return plan, report


__all__ = ["build_plan", "parse_csvs", "parse_date", "parse_xmp", "scan_part"]
