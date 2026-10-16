"""Photo and video metadata (WP-7.3, Part C §4.3).

On the worker, each image or video gets a ``file_media`` row from ExifTool
(one long-lived ``-stay_open`` process, so a batch doesn't pay Perl's start-up
per file) and, for videos, ffprobe:

* **when it was taken**, by precedence — EXIF DateTimeOriginal (+ its
  OffsetTime); QuickTime's CreationDate (Apple, with offset) or CreateDate
  (UTC by the QuickTime spec); a Takeout sidecar (Stage 10); the file's
  modified time on the uploading device; the upload time. The source is
  always recorded;
* where (GPS), size and orientation, camera, a video's duration and codec;
* **Live Photos**: the Apple ContentIdentifier pairs a HEIC with its MOV;
  **motion photos** (Samsung's embedded video, Google's MotionPhoto /
  MicroVideo XMP) are flagged.

Originals are byte-exact (WP-0.5), so this can be run again any time; files
from before it are picked up by the media worker's sweep (WP-7.4). People's corrections to the
date and location live in ``*_override`` and win in :func:`effective`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger("promptly.files.media_meta")

_EXIFTOOL_TIMEOUT = 60
_FFPROBE_TIMEOUT = 60

# Camera originals (store tier) — metadata, no browser preview.
RAW_MIMES = frozenset(
    {"image/x-adobe-dng", "image/x-canon-cr2", "image/x-canon-cr3", "image/x-nikon-nef", "image/x-sony-arw"}
)


def media_kind(mime: str | None, filename: str | None = None) -> str | None:
    m = (mime or "").lower()
    if m in RAW_MIMES:
        return "raw"
    if m.startswith("image/") and m != "image/svg+xml":
        return "image"
    if m.startswith("video/"):
        return "video"
    return None


# ------------------------------------------------------------------ ExifTool


class _ExifTool:
    """One ``exiftool -stay_open`` process, shared by the worker's jobs
    (serialised — ExifTool handles one request at a time). Restarted if it
    dies or a request hangs."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def _start(self) -> subprocess.Popen:
        return subprocess.Popen(
            ["exiftool", "-stay_open", "True", "-@", "-"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def _kill(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
            except OSError:
                pass
        self._proc = None

    def run(self, args: list[str]) -> str:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._proc = self._start()
            proc = self._proc
            # A request that hangs (a pathological file) kills the process;
            # the next call starts a fresh one.
            timer = threading.Timer(_EXIFTOOL_TIMEOUT, self._kill)
            timer.start()
            try:
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write("\n".join(args) + "\n-execute\n")
                proc.stdin.flush()
                out: list[str] = []
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        raise RuntimeError("exiftool stopped")
                    if line.strip() == "{ready}":
                        break
                    out.append(line)
                return "".join(out)
            except Exception:
                self._kill()
                raise
            finally:
                timer.cancel()

    def close(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                try:
                    assert self._proc.stdin is not None
                    self._proc.stdin.write("-stay_open\nFalse\n")
                    self._proc.stdin.flush()
                    self._proc.wait(timeout=5)
                except Exception:  # noqa: BLE001
                    self._kill()
            self._proc = None


_exiftool = _ExifTool()


def read_tags(path: str) -> dict[str, Any]:
    """Every tag ExifTool finds, as ``"Group:Tag": value`` with numbers as
    numbers (``-n``)."""
    out = _exiftool.run(["-j", "-n", "-G", "-api", "LargeFileSupport=1", path])
    data = json.loads(out or "[]")
    return data[0] if data else {}


def probe_video(path: str) -> dict[str, Any]:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=_FFPROBE_TIMEOUT, check=False,
        )
        return json.loads(r.stdout or "{}")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        logger.warning("ffprobe failed on %s", path, exc_info=True)
        return {}


# ------------------------------------------------------------------ parsing

_DT_RE = re.compile(
    r"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$"
)


def _offset_minutes(s: str | None) -> int | None:
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if s == "Z":
        return 0
    m = re.match(r"^([+-])(\d{2}):?(\d{2})$", s)
    if not m:
        return None
    mins = int(m.group(2)) * 60 + int(m.group(3))
    return mins if m.group(1) == "+" else -mins


def parse_datetime(value: Any) -> tuple[datetime, int | None] | None:
    """ExifTool's "YYYY:MM:DD HH:MM:SS[.ss][±HH:MM]" → (naive wall time,
    offset minutes or None). None for empty / zero / impossible dates."""
    if not isinstance(value, str):
        return None
    m = _DT_RE.match(value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    if y < 1900 or mo == 0 or d == 0:
        return None
    try:
        dt = datetime(y, mo, d, h, mi, s, int((m.group(7) or "0")[:6].ljust(6, "0")))
    except ValueError:
        return None
    return dt, _offset_minutes(m.group(8))


def _aware(dt: datetime, offset: int | None) -> datetime:
    """Wall time + offset → UTC. Without an offset the wall time is kept as
    if it were UTC (and ``tz_offset`` stays empty) — what a phone showed."""
    if offset is None:
        return dt.replace(tzinfo=timezone.utc)
    return (dt - timedelta(minutes=offset)).replace(tzinfo=timezone.utc)


def _first(tags: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = tags.get(k)
        if v not in (None, "", "0000:00:00 00:00:00"):
            return v
    return None


def taken_from_tags(tags: dict[str, Any]) -> tuple[datetime, str, int | None] | None:
    # 1. EXIF DateTimeOriginal (with sub-seconds and offset when Composite
    #    has put them together).
    raw = _first(tags, "Composite:SubSecDateTimeOriginal", "EXIF:DateTimeOriginal")
    parsed = parse_datetime(raw)
    if parsed:
        dt, off = parsed
        if off is None:
            off = _offset_minutes(_first(tags, "EXIF:OffsetTimeOriginal", "EXIF:OffsetTime"))
        return _aware(dt, off), "exif", off
    # 2. QuickTime: Apple's CreationDate carries the local offset; CreateDate
    #    is UTC by the QuickTime spec.
    parsed = parse_datetime(_first(tags, "QuickTime:CreationDate"))
    if parsed:
        dt, off = parsed
        return _aware(dt, off), "quicktime", off
    parsed = parse_datetime(_first(tags, "QuickTime:CreateDate", "QuickTime:MediaCreateDate"))
    if parsed:
        dt, _off = parsed
        return dt.replace(tzinfo=timezone.utc), "quicktime", None
    return None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def location_from_tags(tags: dict[str, Any]) -> tuple[float, float] | None:
    lat = _num(_first(tags, "Composite:GPSLatitude", "EXIF:GPSLatitude"))
    lon = _num(_first(tags, "Composite:GPSLongitude", "EXIF:GPSLongitude"))
    if lat is None or lon is None:
        pos = _first(tags, "Composite:GPSPosition", "QuickTime:GPSCoordinates")
        if isinstance(pos, str):
            parts = pos.replace(",", " ").split()
            if len(parts) >= 2:
                lat, lon = _num(parts[0]), _num(parts[1])
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    return round(lat, 6), round(lon, 6)


def _dims(tags: dict[str, Any]) -> tuple[int | None, int | None]:
    size = _first(tags, "Composite:ImageSize")
    if isinstance(size, str):
        parts = re.split(r"[ x]", size.strip())
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            return int(parts[0]), int(parts[1])
    w = _num(_first(tags, "File:ImageWidth", "EXIF:ExifImageWidth", "QuickTime:ImageWidth"))
    h = _num(_first(tags, "File:ImageHeight", "EXIF:ExifImageHeight", "QuickTime:ImageHeight"))
    return (int(w) if w else None), (int(h) if h else None)


def motion_embedded(tags: dict[str, Any]) -> bool:
    for k, v in tags.items():
        name = k.split(":", 1)[-1]
        if name in ("MotionPhoto", "MicroVideo") and str(v) in ("1", "True", "true"):
            return True
        if name in ("EmbeddedVideoType", "MotionPhotoVideo", "EmbeddedVideoFile") and v:
            return True
    return False


def parse(tags: dict[str, Any], probe: dict[str, Any] | None = None) -> dict[str, Any]:
    """The ``file_media`` fields ExifTool's tags (and ffprobe's output) give."""
    out: dict[str, Any] = {}
    taken = taken_from_tags(tags)
    if taken:
        out["taken_at"], out["taken_at_source"], out["tz_offset"] = taken
    loc = location_from_tags(tags)
    if loc:
        out["lat"], out["lon"] = loc
    w, h = _dims(tags)
    orient = _num(_first(tags, "EXIF:Orientation", "IFD0:Orientation"))
    out["orientation"] = int(orient) if orient else None
    if orient and int(orient) in (5, 6, 7, 8) and w and h:
        w, h = h, w  # the size it's shown at
    out["width"], out["height"] = w, h
    make = _first(tags, "EXIF:Make", "QuickTime:Make", "QuickTime:Manufacturer")
    model = _first(tags, "EXIF:Model", "QuickTime:Model")
    out["make"] = str(make).strip()[:64] if make else None
    out["model"] = str(model).strip()[:96] if model else None
    cid = _first(tags, "MakerNotes:ContentIdentifier", "QuickTime:ContentIdentifier", "Apple:ContentIdentifier")
    out["content_identifier"] = str(cid)[:64] if cid else None
    out["motion_embedded"] = motion_embedded(tags)
    if probe:
        video = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), None)
        if video:
            out["codec"] = (video.get("codec_name") or "")[:32] or None
            vw, vh = video.get("width"), video.get("height")
            rotation = 0
            for sd in video.get("side_data_list", []) or []:
                if "rotation" in sd:
                    rotation = abs(int(_num(sd["rotation"]) or 0))
            rotation = rotation or abs(int(_num((video.get("tags") or {}).get("rotate")) or 0))
            if vw and vh:
                out["width"], out["height"] = (vh, vw) if rotation in (90, 270) else (vw, vh)
        dur = _num((probe.get("format") or {}).get("duration"))
        if dur:
            out["duration_ms"] = int(dur * 1000)
    if out.get("duration_ms") is None:
        dur = _num(_first(tags, "QuickTime:Duration", "Composite:Duration"))
        if dur:
            out["duration_ms"] = int(dur * 1000)
    return out


# ------------------------------------------------------------------ rows


async def extract_and_store(file_id: uuid.UUID | str) -> bool:
    """Fill (or refill) a file's ``file_media`` row. True if it's media."""
    import app.auth.models  # noqa: F401 — FK target, for a bare worker process
    from app.database import SessionLocal
    from app.files.models import FileMedia, UserFile
    from app.files.storage import absolute_path

    fid = uuid.UUID(str(file_id))
    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        if row is None:
            return False
        kind = media_kind(row.mime_type, row.filename)
        if kind is None:
            return False
        media = await db.get(FileMedia, fid) or FileMedia(file_id=fid, kind=kind)
        media.kind = kind
        fields: dict[str, Any] = {}
        try:
            path = str(absolute_path(row.storage_path))
            tags = await asyncio.to_thread(read_tags, path)
            probe = await asyncio.to_thread(probe_video, path) if kind == "video" else None
            fields = parse(tags, probe)
            media.error = None
        except Exception as exc:  # noqa: BLE001 — a bad file gets its row anyway, with the error
            logger.warning("metadata for %s failed", fid, exc_info=True)
            media.error = str(exc)[:500]
        # A camera that didn't record its zone (most older ones): its clock
        # was the owner's — the same rule Photos shows it by (WP-9.3).
        if fields.get("taken_at") is not None and fields.get("taken_at_source") == "exif" and fields.get("tz_offset") is None:
            from app.auth.models import User
            from app.photos.library import user_zone

            zone = user_zone(await db.get(User, row.user_id)) if row.user_id else None
            if zone is not None:
                fields["taken_at"] = fields["taken_at"].replace(tzinfo=zone).astimezone(timezone.utc)
        for k in (
            "lat", "lon", "width", "height", "orientation", "make", "model", "duration_ms", "codec",
            "content_identifier",
        ):
            setattr(media, k, fields.get(k))
        media.motion_embedded = bool(fields.get("motion_embedded"))
        # What an import knew (Takeout's JSON, WP-10.2): the photo's own
        # first — but a date a day or more from the camera's is one the
        # person corrected in Google Photos, and wins.
        from app.imports.models import FileImportMeta

        imported = await db.get(FileImportMeta, fid)
        if imported is not None and imported.taken_at is not None:
            own = fields.get("taken_at")
            if own is None or abs((own - imported.taken_at).total_seconds()) > 26 * 3600:
                fields["taken_at"], fields["taken_at_source"], fields["tz_offset"] = imported.taken_at, "sidecar", None
        if imported is not None and imported.lat is not None and media.lat is None:
            media.lat, media.lon = imported.lat, imported.lon
        if fields.get("taken_at"):
            media.taken_at, media.taken_at_source, media.tz_offset = (
                fields["taken_at"], fields["taken_at_source"], fields.get("tz_offset"),
            )
        elif row.client_mtime:
            media.taken_at, media.taken_at_source, media.tz_offset = row.client_mtime, "client", None
        else:
            media.taken_at, media.taken_at_source, media.tz_offset = row.created_at, "upload", None
        media.extracted_at = datetime.now(timezone.utc)
        db.add(media)
        await db.flush()
        await _pair_live_photo(db, row, media)
        from app.photos.library import sync as sync_photo

        await sync_photo(db, fid)
        if media.live_pair_file_id:
            await sync_photo(db, media.live_pair_file_id)
        await db.commit()
        return True


async def _pair_live_photo(db, row, media) -> None:  # noqa: ANN001
    """A Live Photo is a HEIC/JPEG and a MOV sharing Apple's
    ContentIdentifier — pair them (the owner's own files only)."""
    from sqlalchemy import select

    from app.files.models import FileMedia, UserFile

    if not media.content_identifier:
        return
    other = (
        await db.execute(
            select(FileMedia)
            .join(UserFile, UserFile.id == FileMedia.file_id)
            .where(
                FileMedia.content_identifier == media.content_identifier,
                FileMedia.file_id != media.file_id,
                FileMedia.kind != media.kind,
                UserFile.user_id == row.user_id,
                UserFile.trashed_at.is_(None),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if other is not None:
        media.live_pair_file_id = other.file_id
        other.live_pair_file_id = media.file_id


def effective(media, row) -> dict[str, Any]:  # noqa: ANN001 — FileMedia | None, UserFile
    """What to show: people's corrections over what the file says."""
    if media is None:
        return {"extracted": False}
    taken = media.taken_at_override or media.taken_at
    if media.location_hidden:
        loc = None
    elif media.lat_override is not None and media.lon_override is not None:
        loc = {"lat": media.lat_override, "lon": media.lon_override, "edited": True}
    elif media.lat is not None and media.lon is not None:
        loc = {"lat": media.lat, "lon": media.lon, "edited": False}
    else:
        loc = None
    camera = " ".join(x for x in (media.make, media.model) if x) or None
    if media.make and media.model and media.model.lower().startswith(media.make.lower()):
        camera = media.model
    return {
        "extracted": media.extracted_at is not None,
        "kind": media.kind,
        "taken_at": taken.isoformat() if taken else None,
        "taken_at_source": "edited" if media.taken_at_override else media.taken_at_source,
        "tz_offset": None if media.taken_at_override else media.tz_offset,
        "location": loc,
        "has_original_location": media.lat is not None,
        "width": media.width,
        "height": media.height,
        "orientation": media.orientation,
        "camera": camera,
        "duration_ms": media.duration_ms,
        "codec": media.codec,
        "live_pair_file_id": str(media.live_pair_file_id) if media.live_pair_file_id else None,
        "motion_embedded": media.motion_embedded,
        "error": media.error,
    }


__all__ = [
    "RAW_MIMES",
    "effective",
    "extract_and_store",
    "media_kind",
    "parse",
    "parse_datetime",
    "probe_video",
    "read_tags",
    "taken_from_tags",
]
