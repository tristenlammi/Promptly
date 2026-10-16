"""Reading a Google Takeout (WP-10.1, Part C §4.9).

A Takeout is one or more ``.zip`` / ``.tgz`` parts. Everything sits under
``Takeout/<product>/``; Photos is ``Takeout/Google Photos/`` with a folder per
year ("Photos from 2019") and per album, and beside each photo a JSON
"sidecar" holding what Google knew: when it was taken (``photoTakenTime``,
which includes any date the person corrected in Google Photos), where
(``geoData``), its description, whether it was a favourite, archived or in
the trash.

Google never documented the sidecar format, so matching follows what real
exports do (the GooglePhotosTakeoutHelper projects' long experience):

* the sidecar is the photo's name plus ``.json`` (older exports) or
  ``.supplemental-metadata.json`` (newer);
* sidecar names are cut to 51 characters — the suffix shrinks to
  ``.suppl…``, ``.s``, ``.`` and long photo names lose their tail;
* a second photo with the same name, ``IMG(1).jpg``, has its counter moved:
  ``IMG.jpg(1).json``, ``IMG.jpg.supplemental-metadata(1).json`` or
  ``IMG.jpg(1).supplemental-metadata.json``;
* an edited copy (``IMG-edited.jpg``, ``-bearbeitet``, ``-modifié``…) and a
  Live Photo's video (``IMG.MOV`` beside ``IMG.HEIC``) share the original's;
* the sidecar's ``title`` is the original name, a last resort.

And a photo split from its sidecar across parts is normal — so every part is
indexed before anything is matched. Albums hold copies of photos that are
also in the year folders: a photo (same name and size) is imported once and
put in its albums.
"""
from __future__ import annotations

import json
import re
import tarfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

# Localised "-edited" and the effects Google adds (an edited copy shares the
# original's sidecar).
EXTRA_SUFFIXES = (
    "-edited", "-effects", "-motion", "-animation", "-smile", "-collage", "-mix",
    "-edytowane", "-bearbeitet", "-bewerkt", "-編集済み", "-编辑", "-modificato", "-modifié",
    "-ha editado", "-editada", "-editado", "-editat",
)
# Sidecar files that aren't about one photo.
_NOT_SIDECARS = {"print-subscriptions.json", "shared_album_comments.json", "user-generated-memory-titles.json"}
_PHOTOS_PRODUCT = re.compile(r"^google (photos|fotos|foto)$", re.IGNORECASE)
_DRIVE_PRODUCT = re.compile(r"^(drive|google drive)$", re.IGNORECASE)
_YEAR_FOLDER = re.compile(r"(^|\D)(18|19|20)\d{2}$")
_TRASH_FOLDERS = {"trash", "bin", "papierkorb", "corbeille", "papelera", "cestino", "prullenbak"}
_JSON_MAX = 2 * 1024 * 1024
_COUNTER = re.compile(r"\((\d+)\)$")


@dataclass
class Member:
    part: int  # index into the job's parts
    name: str  # the member's name inside its archive
    path: str  # under Takeout/, e.g. "Google Photos/Holiday/IMG_1.jpg"
    size: int


@dataclass
class Sidecar:
    folder: str
    filename: str
    base: str  # the media name it names (maybe cut short)
    counter: int | None
    data: dict[str, Any]


@dataclass
class Scan:
    members: list[Member] = field(default_factory=list)
    # "Google Photos/<folder>/<file>.json" → parsed JSON
    json: dict[str, Any] = field(default_factory=dict)


def _media_exts() -> dict[str, str]:
    """Extension → canonical MIME for every photo and video type uploads take."""
    from app.files.media_meta import RAW_MIMES
    from app.files.safety import _ALLOWED_EXTS

    out = {}
    for ext, (mime, *_rest) in _ALLOWED_EXTS.items():
        if mime.startswith(("image/", "video/")) or mime in RAW_MIMES:
            if mime != "image/svg+xml":
                out[ext] = mime
    return out


def _norm(name: str) -> str | None:
    """A member's path under ``Takeout/`` (None for anything else)."""
    n = name.replace("\\", "/").lstrip("./")
    if n.endswith("/"):
        return None
    head, _, rest = n.partition("/")
    if head.lower() != "takeout" or not rest:
        return None
    return rest


def scan_part(path: Path, part: int) -> Scan:
    """List one part and read its small JSON members (sync — run in a thread)."""
    out = Scan()
    for name, size, read in _iter_archive(path):
        rel = _norm(name)
        if rel is None:
            continue
        out.members.append(Member(part=part, name=name, path=rel, size=size))
        product = rel.split("/", 1)[0]
        if rel.lower().endswith(".json") and _PHOTOS_PRODUCT.match(product) and size <= _JSON_MAX:
            try:
                out.json[rel] = json.loads(read())
            except (ValueError, UnicodeDecodeError):
                pass
    return out


def _iter_archive(path: Path) -> Iterator[tuple[str, int, Any]]:
    """(name, size, read()) for each file in a zip or tar(.gz)."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                yield info.filename, info.file_size, (lambda i=info: zf.read(i))
        return
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile():
                continue
            yield m.name, m.size, (lambda m=m: tf.extractfile(m).read())  # type: ignore[union-attr]


def open_member(path: Path, member: str):  # noqa: ANN201 — a binary file object
    """Read one member (for the import itself)."""
    if zipfile.is_zipfile(path):
        zf = zipfile.ZipFile(path)
        return zf.open(member)
    tf = tarfile.open(path, "r:*")
    f = tf.extractfile(member)
    if f is None:
        raise KeyError(member)
    return f


# ------------------------------------------------------------------ matching


def sidecar_key(filename: str) -> tuple[str, int | None]:
    """The media name a sidecar's file name points at, and its counter:
    ``IMG.jpg.supplemental-metadata(1).json`` → ("IMG.jpg", 1)."""
    s = filename[: -len(".json")] if filename.lower().endswith(".json") else filename
    counter = None
    m = _COUNTER.search(s)
    if m:
        counter, s = int(m.group(1)), s[: m.start()]
    head, dot, seg = s.rpartition(".")
    if dot and head and (seg == "" or "supplemental-metadata".startswith(seg.lower())):
        # ".supplemental-metadata" or what's left of it after the 51-character cut.
        s = head
    m = _COUNTER.search(s)
    if m and counter is None:
        counter, s = int(m.group(1)), s[: m.start()]
    return s, counter


def split_counter(name: str) -> tuple[str, int | None]:
    """``IMG(1).jpg`` → ("IMG.jpg", 1)."""
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    m = _COUNTER.search(stem)
    if not m:
        return name, None
    base = stem[: m.start()]
    return (f"{base}.{ext}" if dot else base), int(m.group(1))


def strip_extra(name: str) -> str | None:
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for extra in EXTRA_SUFFIXES:
        if stem.lower().endswith(extra):
            stem = stem[: -len(extra)]
            return f"{stem}.{ext}" if dot else stem
    return None


def _stem(name: str) -> str:
    return name.rpartition(".")[0] or name


class FolderMatcher:
    """Photos and sidecars of one folder (across parts)."""

    def __init__(self, sidecars: list[Sidecar]):
        self.sidecars = sidecars
        self.exact: dict[tuple[str, int | None], Sidecar] = {}
        self.by_title: dict[str, list[Sidecar]] = {}
        for sc in sidecars:
            self.exact.setdefault((sc.base.lower(), sc.counter), sc)
            title = str(sc.data.get("title") or "").lower()
            if title:
                self.by_title.setdefault(title, []).append(sc)

    def match(self, media_name: str) -> tuple[Sidecar | None, str]:
        base, n = split_counter(media_name)
        tries = [base]
        unextra = strip_extra(base)
        if unextra:
            tries.append(unextra)
        for b in tries:
            sc = self.exact.get((b.lower(), n)) or (self.exact.get((b.lower(), None)) if n is None else None)
            if sc:
                return sc, "name"
        # Cut short at 51 characters: the sidecar's base is a prefix.
        for b in tries:
            best = None
            for sc in self.sidecars:
                if sc.counter == n and len(sc.base) >= 20 and b.lower().startswith(sc.base.lower()):
                    if best is None or len(sc.base) > len(best.base):
                        best = sc
            if best:
                return best, "truncated"
        # A Live Photo's video, or an extension Google changed: same stem.
        for b in tries:
            stem = _stem(b).lower()
            same = [sc for sc in self.sidecars if sc.counter == n and _stem(sc.base).lower() == stem]
            if same:
                return same[0], "stem"
        hits = self.by_title.get(media_name.lower()) or self.by_title.get(base.lower()) or []
        if len(hits) == 1:
            return hits[0], "title"
        return None, ""


def _when(data: dict[str, Any]) -> int | None:
    for key in ("photoTakenTime", "creationTime"):
        try:
            ts = int(str((data.get(key) or {}).get("timestamp")))
        except (TypeError, ValueError):
            continue
        if ts > 0:
            return ts
    return None


def _where(data: dict[str, Any]) -> tuple[float, float] | None:
    for key in ("geoData", "geoDataExif"):
        g = data.get(key) or {}
        try:
            lat, lon = float(g.get("latitude") or 0), float(g.get("longitude") or 0)
        except (TypeError, ValueError):
            continue
        if lat or lon:  # 0,0 means "no location"
            return round(lat, 6), round(lon, 6)
    return None


def build_plan(scans: list[Scan]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(plan, report) from every part's scan."""
    exts = _media_exts()
    members = [m for s in scans for m in s.members]
    jsons: dict[str, Any] = {}
    for s in scans:
        jsons.update(s.json)

    folders: dict[str, list[Member]] = {}
    drive: list[Member] = []
    skipped = {"other_products": 0, "trash": 0, "unsupported": 0}
    products: dict[str, int] = {}
    for m in members:
        product, _, rest = m.path.partition("/")
        if not rest:
            continue  # Takeout's own archive_browser.html, not a product
        if _PHOTOS_PRODUCT.match(product):
            folder, _, fname = rest.rpartition("/")
            if fname.lower().endswith(".json") or fname.lower().endswith(".html"):
                continue
            folders.setdefault(folder, []).append(m)
        elif _DRIVE_PRODUCT.match(product):
            drive.append(m)
        else:
            products[product] = products.get(product, 0) + 1
            skipped["other_products"] += 1

    # Sidecars and album titles, by folder.
    sidecars: dict[str, list[Sidecar]] = {}
    album_titles: dict[str, str] = {}
    for rel, data in jsons.items():
        if not isinstance(data, dict):
            continue
        _product, _, rest = rel.partition("/")
        folder, _, fname = rest.rpartition("/")
        if fname.lower() in _NOT_SIDECARS:
            continue
        if _when(data) is None and "title" in data and "photoTakenTime" not in data:
            album_titles[folder] = str(data.get("title") or "").strip()  # the album's own metadata.json
            continue
        base, counter = sidecar_key(fname)
        sidecars.setdefault(folder, []).append(Sidecar(folder, fname, base, counter, data))

    photos: list[dict[str, Any]] = []
    first_seen: dict[tuple[str, int], int] = {}  # (name, size) → index in photos
    albums: dict[str, list[int]] = {}
    how: dict[str, int] = {"name": 0, "truncated": 0, "stem": 0, "title": 0, "none": 0}
    unmatched: list[str] = []
    years: list[int] = []
    for folder in sorted(folders, key=lambda f: (not _YEAR_FOLDER.search(f), f)):
        leaf = folder.rsplit("/", 1)[-1]
        if leaf.lower() in _TRASH_FOLDERS:
            skipped["trash"] += len(folders[folder])
            continue
        is_album = folder in album_titles or not _YEAR_FOLDER.search(leaf)
        title = album_titles.get(folder) or leaf
        matcher = FolderMatcher(sidecars.get(folder, []))
        for m in folders[folder]:
            fname = m.path.rsplit("/", 1)[-1]
            ext = ("." + fname.rsplit(".", 1)[-1].lower()) if "." in fname else ""
            if ext not in exts:
                skipped["unsupported"] += 1
                continue
            key = (fname.lower(), m.size)
            if key in first_seen:
                # The same photo in a year folder and an album: once, in both.
                if is_album:
                    albums.setdefault(title, []).append(first_seen[key])
                continue
            sc, method = matcher.match(fname)
            how[method or "none"] += 1
            data = sc.data if sc else {}
            if data.get("trashed"):
                skipped["trash"] += 1
                continue
            if sc is None and len(unmatched) < 20:
                unmatched.append(m.path)
            taken = _when(data) if sc else None
            if taken is None:
                y = _YEAR_FOLDER.search(leaf)
                if y and not is_album:
                    years.append(int(y.group(0)[-4:]))
            where = _where(data) if sc else None
            idx = len(photos)
            first_seen[key] = idx
            photos.append({
                "part": m.part, "member": m.name, "name": fname, "size": m.size, "mime": exts[ext],
                "taken": taken, "lat": where[0] if where else None, "lon": where[1] if where else None,
                "description": (str(data.get("description") or "").strip() or None) if sc else None,
                "favorite": bool(data.get("favorited")), "archived": bool(data.get("archived")),
                "folder_year": int(_YEAR_FOLDER.search(leaf).group(0)[-4:]) if _YEAR_FOLDER.search(leaf) else None,
            })
            if taken:
                from datetime import datetime, timezone

                years.append(datetime.fromtimestamp(taken, tz=timezone.utc).year)
            if is_album:
                albums.setdefault(title, []).append(idx)

    drive_files = []
    for m in drive:
        _product, _, rest = m.path.partition("/")
        drive_files.append({"part": m.part, "member": m.name, "path": rest, "size": m.size})

    plan = {"photos": photos, "albums": albums, "drive": drive_files}
    videos = sum(1 for p in photos if p["mime"].startswith("video/"))
    report = {
        "photos": len(photos) - videos,
        "videos": videos,
        "bytes": sum(p["size"] for p in photos) + sum(d["size"] for d in drive_files),
        "with_details": len(photos) - how["none"],
        "matched_by": how,
        "unmatched_sample": unmatched,
        "albums": sorted(({"title": t, "count": len(set(ix))} for t, ix in albums.items()), key=lambda a: a["title"].lower()),
        "years": [min(years), max(years)] if years else None,
        "favorites": sum(1 for p in photos if p["favorite"]),
        "archived": sum(1 for p in photos if p["archived"]),
        "drive_files": len(drive_files),
        "skipped": skipped,
        "other_products": sorted(products),
        "parts": len(scans),
    }
    return plan, report


__all__ = ["FolderMatcher", "Member", "Scan", "build_plan", "open_member", "scan_part", "sidecar_key", "split_counter", "strip_extra"]
