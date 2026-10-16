"""Export my library (WP-10.4, Part C P8): everything you own, as an
ordinary folder tree you can take anywhere.

``POST /api/files/exports`` works out the whole tree in one go — every live
file you own under its folders, with its original name, empty folders
kept — and splits it into parts of the size you chose. Nothing is copied:
each part is a zip **written as it downloads** from a signed link
(``/api/m/…``, rendition ``export``, the part number as its version), so a
200 GB library needs no spare 200 GB on the server. A part that stops
half-way is simply downloaded again.

What's inside a part, under ``Promptly/``:

* ``My files/…`` — the files as they are. Documents become ``.docx``
  (``docx_writer``), spreadsheets ``.xlsx`` and whiteboards
  ``.excalidraw``, as their own downloads do. Each file keeps its modified
  time.
* Beside every photo and video, ``<name>.json`` in Google Takeout's sidecar
  shape (``photoTakenTime``, ``geoData``, ``description``, ``favorited``,
  ``archived``, plus ``promptly.albums``) — what other photo tools import —
  and ``<name>.xmp`` (date, place, description) for Lightroom, digiKam,
  darktable and the like. The date and place are yours (corrections
  included; a location you removed is left out).
* ``albums.json`` and ``README.txt`` in the first part.

A Promptly export imported as "A folder of photos" comes back with its
dates, places, favourites and albums (``imports.folders``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from xml.sax.saxutils import escape, quoteattr

from sqlalchemy import select
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import storage

logger = logging.getLogger("promptly.files.library_export")

PART_SIZES_GB = (2, 10, 50)
TTL_SECONDS = 7 * 24 * 3600
ROOT = "Promptly/"
FILES = ROOT + "My files/"
_KEY = "promptly:export:{}"
_USER_KEY = "promptly:export-of:{}"
_SIDECAR_BYTES = 2048  # what a part budgets for each sidecar
_CHUNK = 1024 * 1024
_GB = 1024 ** 3

# Already compressed: stored, not deflated again.
_STORED_EXTS = frozenset(
    ".jpg .jpeg .png .gif .webp .heic .heif .avif .mp4 .mov .m4v .3gp .webm .mkv .mp3 .m4a .aac .ogg .opus .flac "
    ".zip .gz .tgz .bz2 .xz .7z .rar .pdf .docx .xlsx .pptx .odt .ods .odp .dng .cr2 .cr3 .nef .arw".split()
)


def plans_dir() -> Path:
    return storage.UPLOAD_ROOT / "derived" / "exports"


def plan_path(export_id: uuid.UUID | str) -> Path:
    return plans_dir() / f"{uuid.UUID(str(export_id))}.json"


# ------------------------------------------------------------------ planning


async def plan(db: AsyncSession, user: Any, part_gb: int) -> dict[str, Any]:
    """Every entry, in parts. An entry is ``{"a": arcname, "k": kind, …}``
    with kind ``blob`` (``p`` storage path), ``doc`` / ``shell`` (``f``
    file id, exported as it's written) or ``dir``; ``s`` its size, ``t``
    its modified time (epoch), and ``m`` a photo's sidecar details."""
    from app.files.generated_kinds import GeneratedKind
    from app.files.models import FileFolder, FileMedia, UserFile
    from app.files.office import is_shell
    from app.files.router import _drive_listing_filter
    from app.imports.models import FileImportMeta
    from app.photos.album_models import Album, AlbumItem
    from app.photos.library import user_zone
    from app.photos.models import PhotoAsset

    zone = user_zone(user)
    seen: set[str] = set()

    def unique(arcname: str) -> str:
        name, i = arcname, 1
        while name.lower() in seen:
            if arcname.endswith("/"):
                name = f"{arcname[:-1]} ({i})/"
            else:
                head, _, base = arcname.rpartition("/")
                stem, dot, ext = base.rpartition(".")
                base = f"{stem} ({i}).{ext}" if dot and stem else f"{base} ({i})"
                name = f"{head}/{base}" if head else base
            i += 1
        seen.add(name.lower())
        return name

    # The folder tree, from the top of My files down (a folder in a
    # trashed one is left out with it).
    rows = (
        await db.execute(
            select(FileFolder.id, FileFolder.name, FileFolder.parent_id).where(
                FileFolder.user_id == user.id, FileFolder.trashed_at.is_(None)
            )
        )
    ).all()
    children: dict[uuid.UUID | None, list[tuple[uuid.UUID, str]]] = {}
    for fid, name, parent in rows:
        children.setdefault(parent, []).append((fid, name))
    paths: dict[uuid.UUID | None, str] = {None: FILES}
    order: list[uuid.UUID] = []
    frontier: list[uuid.UUID | None] = [None]
    while frontier:
        nxt: list[uuid.UUID | None] = []
        for parent in frontier:
            for fid, name in sorted(children.get(parent, []), key=lambda c: c[1].lower()):
                paths[fid] = unique(paths[parent] + _safe(name) + "/")
                order.append(fid)
                nxt.append(fid)
        frontier = nxt

    files = (
        await db.execute(
            select(UserFile)
            # Not its search text (up to 256 KB a file): a big library would
            # hold all of it at once.
            .options(defer(UserFile.content_text))
            .where(UserFile.user_id == user.id, UserFile.trashed_at.is_(None), _drive_listing_filter())
        )
    ).scalars().all()
    files = [f for f in files if f.folder_id in paths]
    ids = [f.id for f in files]

    media: dict[uuid.UUID, Any] = {}
    imported: dict[uuid.UUID, Any] = {}
    archived: set[uuid.UUID] = set()
    albums_of: dict[uuid.UUID, list[str]] = {}
    album_rows: list[Any] = []
    for i in range(0, len(ids), 5000):
        batch = ids[i : i + 5000]
        media.update({m.file_id: m for m in (await db.execute(select(FileMedia).where(FileMedia.file_id.in_(batch)))).scalars()})
        imported.update({m.file_id: m for m in (await db.execute(select(FileImportMeta).where(FileImportMeta.file_id.in_(batch)))).scalars()})
        archived.update(
            (await db.execute(select(PhotoAsset.file_id).where(PhotoAsset.file_id.in_(batch), PhotoAsset.archived_at.is_not(None)))).scalars()
        )
    album_rows = (await db.execute(select(Album).where(Album.owner_id == user.id).order_by(Album.title))).scalars().all()
    album_items: dict[uuid.UUID, list[uuid.UUID]] = {}
    if album_rows:
        for album_id, file_id in (
            await db.execute(
                select(AlbumItem.album_id, AlbumItem.file_id)
                .where(AlbumItem.album_id.in_([a.id for a in album_rows]))
                .order_by(AlbumItem.added_at)
            )
        ).all():
            album_items.setdefault(album_id, []).append(file_id)
    title_of = {a.id: a.title for a in album_rows}
    for album_id, fids in album_items.items():
        for fid in fids:
            albums_of.setdefault(fid, []).append(title_of[album_id])

    entries: list[dict[str, Any]] = []
    arc_of: dict[uuid.UUID, str] = {}
    holding: set[uuid.UUID | None] = set()
    counts = {"files": 0, "documents": 0, "photos": 0, "folders": len(order)}
    for f in sorted(files, key=lambda f: (paths[f.folder_id], f.filename.lower())):
        folder = paths[f.folder_id]
        mtime = int((f.client_mtime or f.modified_at or f.updated_at or f.created_at).timestamp())
        if f.source_kind == GeneratedKind.DOCUMENT.value:
            stem = f.filename.rsplit(".", 1)[0] if "." in f.filename else f.filename
            arc = unique(folder + _safe(stem or "Untitled") + ".docx")
            entries.append({"a": arc, "k": "doc", "f": str(f.id), "s": int(f.size_bytes or 0), "t": mtime})
            counts["documents"] += 1
        elif is_shell(f):
            stem = f.filename.rsplit(".", 1)[0] if "." in f.filename else f.filename
            ext = ".xlsx" if f.source_kind == GeneratedKind.SHEET.value else ".excalidraw"
            arc = unique(folder + _safe(stem or "Untitled") + ext)
            entries.append({"a": arc, "k": "shell", "f": str(f.id), "s": int(f.size_bytes or 0), "t": mtime})
            counts["documents"] += 1
        elif f.storage_path:
            arc = unique(folder + _safe(f.filename))
            entry: dict[str, Any] = {"a": arc, "k": "blob", "p": f.storage_path, "s": int(f.size_bytes or 0), "t": mtime}
            m = media.get(f.id)
            if m is not None and m.kind in ("image", "raw", "video"):
                entry["m"] = _sidecar_meta(f, m, imported.get(f.id), f.id in archived, albums_of.get(f.id, []), zone)
                unique(arc + ".json")
                unique(arc + ".xmp")
                counts["photos"] += 1
            entries.append(entry)
        else:
            continue
        arc_of[f.id] = arc
        holding.add(f.folder_id)
        counts["files"] += 1
    # Empty folders come back as they were.
    parents = {p for p, kids in children.items() if kids}
    for fid in order:
        if fid not in holding and fid not in parents:
            entries.append({"a": paths[fid], "k": "dir", "s": 0, "t": 0})

    albums = [
        {
            "title": a.title, "description": a.description,
            "items": [arc_of[fid][len(ROOT):] for fid in album_items.get(a.id, []) if fid in arc_of],
        }
        for a in album_rows
    ]

    # Parts: in order, each up to the chosen size (a bigger single file
    # gets a part of its own).
    limit = int(part_gb) * _GB
    parts: list[list[dict[str, Any]]] = [[]]
    used = 0
    for e in entries:
        size = e["s"] + (2 * _SIDECAR_BYTES if "m" in e else 0) + 512
        if parts[-1] and used + size > limit:
            parts.append([])
            used = 0
        parts[-1].append(e)
        used += size
    return {
        "user_id": str(user.id), "created": time.time(), "part_gb": int(part_gb),
        "parts": parts, "albums": albums, "counts": counts,
        "bytes": sum(e["s"] for e in entries), "zone": str(zone) if zone else None,
    }


def _safe(name: str) -> str:
    """A path segment any computer can write: no slashes, no ``..``."""
    n = (name or "").replace("/", "_").replace("\\", "_").replace("\x00", "").strip()
    return n if n not in ("", ".", "..") else "_"


def _sidecar_meta(row: Any, m: Any, imported: Any, archived: bool, albums: list[str], zone: Any) -> dict[str, Any]:
    taken = m.taken_at_override or m.taken_at
    offset = None if m.taken_at_override else m.tz_offset
    if m.location_hidden:
        lat = lon = None
    elif m.lat_override is not None and m.lon_override is not None:
        lat, lon = m.lat_override, m.lon_override
    else:
        lat, lon = m.lat, m.lon
    if offset is None and taken is not None:
        # Where it has no zone of its own, the owner's (as Photos shows it).
        local = taken.astimezone(zone) if zone is not None else taken.astimezone(timezone.utc)
        offset = int(local.utcoffset().total_seconds() // 60) if local.utcoffset() is not None else 0
    return {
        "title": row.filename,
        "taken": int(taken.timestamp()) if taken else None,
        "offset": offset,
        "lat": lat, "lon": lon,
        "description": imported.description if imported is not None else None,
        "favorite": row.starred_at is not None,
        "archived": archived,
        "albums": albums,
        "camera": " ".join(x for x in (m.make, m.model) if x) or None,
    }


def sidecar_json(meta: dict[str, Any]) -> bytes:
    """Google Takeout's sidecar shape, so other photo tools read it too."""
    out: dict[str, Any] = {"title": meta["title"], "description": meta.get("description") or ""}
    if meta.get("taken") is not None:
        when = datetime.fromtimestamp(meta["taken"], tz=timezone.utc)
        out["photoTakenTime"] = {"timestamp": str(meta["taken"]), "formatted": when.strftime("%b %d, %Y, %I:%M:%S %p UTC")}
    if meta.get("lat") is not None and meta.get("lon") is not None:
        out["geoData"] = {"latitude": meta["lat"], "longitude": meta["lon"], "altitude": 0.0, "latitudeSpan": 0.0, "longitudeSpan": 0.0}
    if meta.get("favorite"):
        out["favorited"] = True
    if meta.get("archived"):
        out["archived"] = True
    out["promptly"] = {
        "albums": meta.get("albums") or [],
        "tzOffsetMinutes": meta.get("offset"),
        "camera": meta.get("camera"),
    }
    return json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8")


def _xmp_gps(value: float, pos: str, neg: str) -> str:
    ref = pos if value >= 0 else neg
    v = abs(value)
    deg = int(v)
    return f"{deg},{(v - deg) * 60:.6f}{ref}"


def sidecar_xmp(meta: dict[str, Any]) -> bytes:
    attrs = []
    if meta.get("taken") is not None:
        off = meta.get("offset") or 0
        local = datetime.fromtimestamp(meta["taken"], tz=timezone(timedelta(minutes=off)))
        stamp = local.isoformat()
        attrs += [f"exif:DateTimeOriginal={quoteattr(stamp)}", f"photoshop:DateCreated={quoteattr(stamp)}"]
    if meta.get("lat") is not None and meta.get("lon") is not None:
        attrs += [
            f"exif:GPSLatitude={quoteattr(_xmp_gps(meta['lat'], 'N', 'S'))}",
            f"exif:GPSLongitude={quoteattr(_xmp_gps(meta['lon'], 'E', 'W'))}",
        ]
    body = ""
    if meta.get("description"):
        body = (
            "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">"
            + escape(meta["description"])
            + "</rdf:li></rdf:Alt></dc:description>"
        )
    return (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:exif="http://ns.adobe.com/exif/1.0/"\n'
        '    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"'
        + "".join(f"\n    {a}" for a in attrs)
        + ">\n   "
        + body
        + "\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n"
    ).encode("utf-8")


def readme(state: dict[str, Any]) -> bytes:
    c = state["counts"]
    when = datetime.fromtimestamp(state["created"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    n = len(state["parts"])
    return (
        f"Your Promptly library, exported {when}.\n\n"
        f"{c['files']:,} files in {c['folders']:,} folders, in {n} part{'s' if n != 1 else ''}. Unzip every part into the\n"
        "same place and they come together as one folder tree.\n\n"
        "My files/   everything you own, in its folders, with its original name and date.\n"
        "            Documents are .docx, spreadsheets .xlsx, whiteboards .excalidraw\n"
        "            (open them at excalidraw.com).\n"
        "            Beside each photo and video:\n"
        "              <name>.json  date taken, place, description, favourite, archived and\n"
        "                           albums, in Google Takeout's format — photo apps that\n"
        "                           import a Takeout read these;\n"
        "              <name>.xmp   date, place and description for Lightroom, digiKam,\n"
        "                           darktable and similar.\n"
        "albums.json  your albums and the photos in each.\n\n"
        "To bring it into another Promptly: Files -> Import -> A folder of photos, and add\n"
        "the parts. Dates, places, favourites and albums come with it.\n"
    ).encode("utf-8")


# ------------------------------------------------------------------ state


async def _redis():
    from app.redis_client import redis

    return redis


async def create(user: Any, planned: dict[str, Any]) -> str:
    """Store the plan; a new export replaces your last one."""
    export_id = str(uuid.uuid4())
    path = plan_path(export_id)
    await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
    await asyncio.to_thread(path.write_text, json.dumps(planned), "utf-8")
    r = await _redis()
    old = await r.get(_USER_KEY.format(user.id))
    if old:
        await discard(old.decode() if isinstance(old, bytes) else old)
    summary = {
        "user_id": str(user.id), "created": planned["created"], "part_gb": planned["part_gb"],
        "counts": planned["counts"], "bytes": planned["bytes"],
        "parts": [{"n": i + 1, "files": sum(1 for e in p if e["k"] != "dir"), "bytes": sum(e["s"] for e in p)} for i, p in enumerate(planned["parts"])],
    }
    await r.set(_KEY.format(export_id), json.dumps(summary), ex=TTL_SECONDS)
    await r.set(_USER_KEY.format(user.id), export_id, ex=TTL_SECONDS)
    return export_id


async def load(export_id: str) -> dict[str, Any] | None:
    raw = await (await _redis()).get(_KEY.format(export_id))
    return json.loads(raw) if raw else None


async def current_for(user_id: uuid.UUID) -> str | None:
    raw = await (await _redis()).get(_USER_KEY.format(user_id))
    if not raw:
        return None
    return raw.decode() if isinstance(raw, bytes) else raw


async def discard(export_id: str) -> None:
    r = await _redis()
    state = await load(export_id)
    await r.delete(_KEY.format(export_id))
    if state and (await current_for(uuid.UUID(state["user_id"]))) == export_id:
        await r.delete(_USER_KEY.format(state["user_id"]))
    try:
        plan_path(export_id).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def part_name(state: dict[str, Any], n: int) -> str:
    day = datetime.fromtimestamp(state["created"], tz=timezone.utc).strftime("%Y-%m-%d")
    return f"promptly-export-{day}-{n:03d}.zip"


def sweep() -> int:
    """Plans of exports past their week (Redis has already forgotten them)."""
    root = plans_dir()
    if not root.is_dir():
        return 0
    cutoff = time.time() - TTL_SECONDS - 3600
    n = 0
    for p in root.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            continue
    return n


# ------------------------------------------------------------------ writing


class _Sink:
    """Where zipfile writes; the stream drains it after every chunk."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []
        self.pos = 0

    def write(self, b) -> int:  # noqa: ANN001
        self.parts.append(bytes(b))
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = b"".join(self.parts)
        self.parts.clear()
        return out


def _info(arcname: str, mtime: int, zone: Any, compress: int) -> zipfile.ZipInfo:
    when = datetime.fromtimestamp(max(mtime, 315532800), tz=timezone.utc)  # zip dates start in 1980
    local = when.astimezone(zone) if zone is not None else when
    info = zipfile.ZipInfo(arcname, date_time=local.timetuple()[:6])
    info.compress_type = compress
    info.external_attr = (0o40755 << 16) | 0x10 if arcname.endswith("/") else 0o100644 << 16
    # The exact UTC time too (Info-ZIP's extended timestamp), so unzip
    # tools set it whatever the zone.
    info.extra = struct.pack("<HHBl", 0x5455, 5, 1, int(when.timestamp()))
    return info


async def stream_part(export_id: str, n: int) -> AsyncIterator[bytes]:
    """Part ``n`` (1-based), as it's written."""
    from zoneinfo import ZoneInfo

    planned = json.loads(await asyncio.to_thread(plan_path(export_id).read_text, "utf-8"))
    entries = planned["parts"][n - 1]
    zone = ZoneInfo(planned["zone"]) if planned.get("zone") else None
    sink = _Sink()
    zf = zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True)  # type: ignore[arg-type]
    missing: list[str] = []
    try:
        if n == 1:
            zf.writestr(_info(ROOT + "README.txt", int(planned["created"]), zone, zipfile.ZIP_DEFLATED), readme(planned))
            zf.writestr(
                _info(ROOT + "albums.json", int(planned["created"]), zone, zipfile.ZIP_DEFLATED),
                json.dumps(planned["albums"], ensure_ascii=False, indent=2).encode("utf-8"),
            )
            yield sink.take()
        for e in entries:
            arc = e["a"]
            if e["k"] == "dir":
                zf.writestr(_info(arc, int(planned["created"]), zone, zipfile.ZIP_STORED), b"")
            elif e["k"] in ("doc", "shell"):
                data, fallback = await _office_bytes(e)
                if data is None:
                    missing.append(arc[len(ROOT):])
                    continue
                if fallback:
                    arc = arc[: -len(".docx")] + ".html"
                zf.writestr(_info(arc, e["t"], zone, zipfile.ZIP_DEFLATED if arc.endswith(".excalidraw") else zipfile.ZIP_STORED), data)
            else:
                src_path = storage.absolute_path(e["p"])
                try:
                    src = await asyncio.to_thread(open, src_path, "rb")
                except OSError:
                    missing.append(arc[len(ROOT):])
                    continue
                compress = zipfile.ZIP_STORED if Path(arc).suffix.lower() in _STORED_EXTS else zipfile.ZIP_DEFLATED
                try:
                    dest = zf.open(_info(arc, e["t"], zone, compress), "w", force_zip64=True)
                    try:
                        while True:
                            chunk = await asyncio.to_thread(src.read, _CHUNK)
                            if not chunk:
                                break
                            await asyncio.to_thread(dest.write, chunk)
                            yield sink.take()
                    finally:
                        dest.close()
                finally:
                    src.close()
                meta = e.get("m")
                if meta:
                    zf.writestr(_info(arc + ".json", e["t"], zone, zipfile.ZIP_DEFLATED), sidecar_json(meta))
                    zf.writestr(_info(arc + ".xmp", e["t"], zone, zipfile.ZIP_DEFLATED), sidecar_xmp(meta))
            yield sink.take()
        if missing:
            zf.writestr(
                _info(ROOT + f"Not exported (part {n}).txt", int(time.time()), zone, zipfile.ZIP_DEFLATED),
                ("These couldn't be read when this part was made:\n\n" + "\n".join(missing) + "\n").encode("utf-8"),
            )
        zf.close()
        yield sink.take()
    except BaseException:
        # Usually the download was stopped; it's started again from the top.
        logger.info("export %s part %s stopped", export_id, n, exc_info=True)
        raise


async def _office_bytes(e: dict[str, Any]) -> tuple[bytes | None, bool]:
    """A document as .docx (its standalone .html page if that fails —
    the bool), a sheet as .xlsx, a whiteboard as .excalidraw — from what
    they are now."""
    from app.database import SessionLocal
    from app.files.models import UserFile
    from app.files.office import content_for_shell, export_for_download

    async with SessionLocal() as db:
        row = await db.get(UserFile, uuid.UUID(e["f"]))
        if row is None or row.trashed_at is not None:
            return None, False
        if e["k"] == "shell":
            entity = await content_for_shell(db, row)
            if entity is None:
                return None, False
            data, _name, _mime = await asyncio.to_thread(export_for_download, row, entity)
            return data, False
        from app.files import page_setup
        from app.files.docx_writer import html_to_docx
        from app.files.documents_router import _current_document_html, _current_document_state, _html_page, _inline_document_images

        state = await _current_document_state(db, row)
        html_text = await _inline_document_images(db, row, await _current_document_html(db, row, state))
        title = row.filename.rsplit(".", 1)[0] if "." in row.filename else row.filename
    try:
        return await asyncio.to_thread(html_to_docx, html_text, title=title, page=page_setup.from_update(state)), False
    except Exception:  # noqa: BLE001 — never lose a document over its formatting
        logger.warning("export: %s as .docx failed; its page instead", e["f"], exc_info=True)
        return _html_page(html_text, title=title).encode("utf-8"), True


__all__ = [
    "PART_SIZES_GB", "create", "current_for", "discard", "load", "part_name", "plan", "plan_path",
    "sidecar_json", "sidecar_xmp", "stream_part", "sweep",
]
