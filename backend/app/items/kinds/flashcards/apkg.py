"""Reading Anki packages (``.apkg`` / ``.colpkg``) — server side, stdlib only.

An ``.apkg`` is a zip holding a SQLite collection plus the deck's media:

* ``collection.anki21`` (Anki 2.1, schema 11) or ``collection.anki2``
  (2.0 / "Support older Anki versions" exports). Newer Anki (2.1.50+)
  writes ``collection.anki21b`` — zstd-compressed, which Python's stdlib
  can't read, so we say how to re-export instead.
* ``media`` — JSON ``{"0": "photo.jpg", …}``; the numbered members are the
  files.

What becomes of it: notes → cards (Basic, Basic + reversed / optional
reversed, type-in and Cloze note types; other multi-template types keep
their first two templates), fields → front / back / note with HTML turned
into Markdown (no HTML survives — the app renders Markdown only), tags,
decks (``A::B``), suspended cards, and — when asked — the review history
(``revlog``) **replayed through our FSRS-6** so each card starts with the
stability / difficulty / due date its history earns. A card with no
history but Anki review state gets an estimate from its interval.

Nothing is extracted to disk under a name from the archive (no path
traversal); every read is size-capped (zip bombs), and the database is
opened read-only.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone, tzinfo
from urllib.parse import quote

from . import fsrs
from .cloze import ClozeError, review_keys, validate_cloze
from .importer import _html_to_text
from .models import MAX_CARDS

MAX_APKG_BYTES = 100 * 1024 * 1024  # the reverse proxy's body limit
MAX_COLLECTION_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 100_000
MAX_MEDIA_MAP_BYTES = 8 * 1024 * 1024
MAX_MEDIA_FILE_BYTES = 16 * 1024 * 1024
MAX_MEDIA_TOTAL_BYTES = 400 * 1024 * 1024
MAX_MEDIA_FILES = 3000
MAX_REVLOG_ROWS = 3_000_000
LOG_KEEP = 50_000  # newest imported review-log entries kept for stats

MEDIA_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".webm",
}
AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".webm"}

ANKI21B_HELP = (
    "This package is in the newer Anki format (collection.anki21b, compressed with zstd), which can't be read here. "
    "In Anki choose File → Export…, pick \"Anki Deck Package (*.apkg)\", tick \"Support older Anki versions\" "
    "(the Anki 2.1.x compatible format) and import that file."
)


class AnkiError(ValueError):
    """A package we can't read — the message goes to the person."""


@dataclass
class Package:
    format: str
    cards: list[dict] = field(default_factory=list)
    logs: list[dict] = field(default_factory=list)
    decks: list[str] = field(default_factory=list)
    notes: int = 0
    skipped: int = 0
    truncated: int = 0
    reviews_total: int = 0
    reviews_dropped: int = 0
    media_map: dict[str, str] = field(default_factory=dict)  # filename → zip member
    media_needed: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ zip


def _copy_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int, dest) -> int:  # noqa: ANN001
    """Stream one member into ``dest`` (a file object), at most ``limit``
    bytes — the size in the zip header can lie, so count while reading."""
    if info.file_size > limit:
        raise AnkiError("Part of that package is too large to import.")
    n = 0
    with zf.open(info) as src:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            n += len(chunk)
            if n > limit:
                raise AnkiError("Part of that package is too large to import.")
            dest.write(chunk)
    return n


def read_member(path: str, member: str, limit: int = MAX_MEDIA_FILE_BYTES) -> bytes:
    import io

    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(member)
        buf = io.BytesIO()
        _copy_member(zf, info, limit, buf)
        return buf.getvalue()


# ----------------------------------------------------------------- text

_IMG = re.compile(r"<img\b[^>]*?\bsrc\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))[^>]*>", re.I)
_SOUND = re.compile(r"\[sound:([^\]\n]{1,300})\]")
_SCRIPT = re.compile(r"(?is)<(script|style)\b[^>]*>.*?</\1\s*>")
_MEDIA_REF = re.compile(r"!\[([^\]]*)\]\(anki-media:([^)\s]+)\)")


def _safe_alt(name: str) -> str:
    return re.sub(r"[\[\]()\n]", "", os.path.splitext(os.path.basename(name))[0])[:80]


def field_to_markdown(raw: str, refs: set[str]) -> str:
    """One Anki field (HTML) as Markdown. Local images and ``[sound:…]``
    become ``![…](anki-media:<name>)`` placeholders (filled in with Drive
    ids, or dropped, by the caller); web images stay as links."""
    s = _SCRIPT.sub("", raw or "")

    def img(m: re.Match) -> str:
        src = html.unescape(m.group(1) or m.group(2) or m.group(3) or "").strip()
        if not src:
            return ""
        if src.lower().startswith(("http://", "https://")):
            return f"\n![]({quote(src, safe=':/?&=#%.-_~')})\n"
        if "/" in src or "\\" in src or src.startswith("."):
            return ""
        refs.add(src)
        return f"\n![{_safe_alt(src)}](anki-media:{quote(src)})\n"

    def sound(m: re.Match) -> str:
        name = html.unescape(m.group(1)).strip()
        if not name or "/" in name or "\\" in name:
            return ""
        refs.add(name)
        return f"\n![audio: {_safe_alt(name)}](anki-media:{quote(name)})\n"

    s = _IMG.sub(img, s)
    s = _SOUND.sub(sound, s)
    s = _html_to_text(s).replace("\xa0", " ")
    s = re.sub(r"[ \t]+\n", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def fill_media(text: str, ids: dict[str, str]) -> str:
    """Placeholders → ``drive:<file id>`` (or gone when the file wasn't stored)."""
    from urllib.parse import unquote

    def sub(m: re.Match) -> str:
        fid = ids.get(unquote(m.group(2)))
        return f"![{m.group(1)}](drive:{fid})" if fid else ""

    return re.sub(r"\n{3,}", "\n\n", _MEDIA_REF.sub(sub, text or "")).strip()


# ------------------------------------------------------------ collection


def _notetypes(con: sqlite3.Connection, col_models: str) -> dict[int, dict]:
    out: dict[int, dict] = {}
    try:
        models = json.loads(col_models or "{}") or {}
    except ValueError:
        models = {}
    if isinstance(models, dict) and models:
        for mid, m in models.items():
            tmpls = m.get("tmpls") or []
            q0 = (tmpls[0].get("qfmt") or "") if tmpls else ""
            out[int(mid)] = {
                "name": str(m.get("name") or ""),
                "cloze": m.get("type") == 1,
                "typein": "{{type:" in q0,
                "templates": len(tmpls),
            }
        return out
    # Schema 18 (notetypes / templates tables, protobuf configs).
    try:
        rows = con.execute("SELECT id, name, config FROM notetypes").fetchall()
    except sqlite3.Error:
        return out
    for ntid, name, config in rows:
        cfg = bytes(config or b"")
        tmpls = con.execute("SELECT ord, config FROM templates WHERE ntid = ? ORDER BY ord", (ntid,)).fetchall()
        q0 = bytes(tmpls[0][1] or b"") if tmpls else b""
        out[int(ntid)] = {
            "name": str(name or ""),
            "cloze": cfg[:2] == b"\x08\x01",  # NotetypeConfig.kind = KIND_CLOZE
            "typein": b"{{type:" in q0,
            "templates": len(tmpls),
        }
    return out


def _decks(con: sqlite3.Connection, col_decks: str) -> dict[int, str]:
    try:
        decks = json.loads(col_decks or "{}") or {}
    except ValueError:
        decks = {}
    if isinstance(decks, dict) and decks:
        return {int(k): str(v.get("name") or "Default") for k, v in decks.items()}
    try:
        return {int(i): str(n or "Default").replace("\x1f", "::") for i, n in con.execute("SELECT id, name FROM decks")}
    except sqlite3.Error:
        return {}


def _deck_path(name: str) -> str:
    parts = [p.strip()[:120] for p in (name or "").split("::") if p.strip()]
    return "::".join(parts) or "Default"


def _approx_review(card_row: dict, crt: int, cfg: fsrs.Config, key: str) -> dict:
    """An Anki review card without history: stability ≈ its interval,
    difficulty from its ease factor (2.5 → ~4, 1.3 → 10), due from Anki's
    day number."""
    ivl = max(1, int(card_row["ivl"] or 1))
    factor = int(card_row["factor"] or 2500)
    diff = min(max(10 - (factor - 1300) / 200, 1.0), 10.0)
    base = datetime.fromtimestamp(crt, cfg.tz).date() if crt else date(2006, 1, 1)
    due_day = base + timedelta(days=int(card_row["due"] or 0))
    due = fsrs.day_start(due_day.toordinal(), cfg)
    last = fsrs.day_start((due_day - timedelta(days=ivl)).toordinal(), cfg)
    return {
        **fsrs.new_srs(key), "state": "review", "stability": float(ivl), "difficulty": round(diff, 4),
        "due": fsrs.iso(due), "last_review": fsrs.iso(last), "reps": int(card_row["reps"] or 0),
        "lapses": int(card_row["lapses"] or 0), "step": None,
    }


def _card_id(guid: str, used: set[str]) -> str:
    h = hashlib.sha1(("anki:" + (guid or "")).encode("utf-8")).hexdigest()
    cid, n = f"a{h[:12]}", 1
    while cid in used:
        n += 1
        cid = f"a{h[:12]}{n}"
    used.add(cid)
    return cid


def read_package(path: str, settings: dict, tz: tzinfo, *, history: bool = True) -> Package:
    """Parse the ``.apkg`` at ``path``. Raises :class:`AnkiError`."""
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise AnkiError("That isn't an Anki package (.apkg) — it should be a zip file.") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MEMBERS:
            raise AnkiError("That package holds too many files.")
        names = {i.filename: i for i in infos}
        member = next((n for n in ("collection.anki21", "collection.anki2") if n in names), None)
        if member is None:
            if "collection.anki21b" in names:
                raise AnkiError(ANKI21B_HELP)
            raise AnkiError("No Anki collection inside that file — is it an .apkg exported from Anki?")
        media_map: dict[str, str] = {}
        if "media" in names:
            import io

            buf = io.BytesIO()
            _copy_member(zf, names["media"], MAX_MEDIA_MAP_BYTES, buf)
            try:
                raw = json.loads(buf.getvalue().decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                raw = None
                if "collection.anki21b" in names:
                    raise AnkiError(ANKI21B_HELP)
            if isinstance(raw, dict):
                media_map = {str(v): str(k) for k, v in raw.items() if str(k) in names}
        fd, tmp = tempfile.mkstemp(suffix=".anki")
        try:
            with os.fdopen(fd, "wb") as out:
                _copy_member(zf, names[member], MAX_COLLECTION_BYTES, out)
            pkg = _read_collection(tmp, settings, tz, history=history)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    pkg.format = member.split(".")[-1]
    if pkg.format == "anki2" and "collection.anki21b" in names and pkg.notes <= 1:
        raise AnkiError(ANKI21B_HELP)
    pkg.media_map = media_map
    missing = [n for n in pkg.media_needed if n not in media_map]
    if missing:
        pkg.warnings.append(f"{len(missing)} media file{'s' if len(missing) != 1 else ''} referenced by cards aren't in the package.")
    return pkg


def _read_collection(path: str, settings: dict, tz: tzinfo, *, history: bool) -> Package:
    with open(path, "rb") as f:
        if f.read(16) != b"SQLite format 3\x00":
            raise AnkiError("The collection inside that package isn't a database Anki 2.1 writes. " + ANKI21B_HELP)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        con.row_factory = sqlite3.Row
        try:
            col = con.execute("SELECT crt, models, decks FROM col LIMIT 1").fetchone()
        except sqlite3.Error as e:
            raise AnkiError("That Anki collection couldn't be read.") from e
        if col is None:
            raise AnkiError("That Anki collection is empty.")
        crt = int(col["crt"] or 0)
        types = _notetypes(con, col["models"])
        decks = _decks(con, col["decks"])
        cfg = fsrs.config_from(settings or {}, tz)
        pkg = Package(format="")
        cards_by_note: dict[int, list[dict]] = {}
        for r in con.execute("SELECT id, nid, did, odid, ord, type, queue, due, ivl, factor, reps, lapses FROM cards ORDER BY id"):
            cards_by_note.setdefault(int(r["nid"]), []).append(dict(r))
        revlog: dict[int, list[tuple[int, int, int, int, int]]] = {}
        if history:
            n = 0
            for r in con.execute("SELECT id, cid, ease, ivl, type, time FROM revlog ORDER BY id"):
                n += 1
                if n > MAX_REVLOG_ROWS:
                    pkg.warnings.append(f"Only the first {MAX_REVLOG_ROWS:,} reviews were read.")
                    break
                revlog.setdefault(int(r["cid"]), []).append((int(r["id"]), int(r["ease"]), int(r["ivl"]), int(r["type"]), int(r["time"] or 0)))
            pkg.reviews_total = min(n, MAX_REVLOG_ROWS)
        used: set[str] = set()
        deck_paths: dict[str, None] = {}
        logs: list[tuple[int, dict]] = []
        for note in con.execute("SELECT id, guid, mid, tags, flds FROM notes ORDER BY id"):
            pkg.notes += 1
            if len(pkg.cards) >= MAX_CARDS:
                pkg.truncated += 1
                continue
            acards = cards_by_note.get(int(note["id"]))
            if not acards:
                pkg.skipped += 1
                continue
            nt = types.get(int(note["mid"]), {"cloze": False, "typein": False, "templates": 1, "name": ""})
            fields = str(note["flds"] or "").split("\x1f")
            refs: set[str] = set()
            md = [field_to_markdown(f, refs) for f in fields]
            front = md[0] if md else ""
            back = md[1] if len(md) > 1 else ""
            extra = "\n\n".join(x for x in md[2:] if x)
            is_cloze = nt["cloze"] or bool(re.search(r"\{\{c\d+::", front))
            ords = {int(c["ord"]) for c in acards}
            if is_cloze:
                typ = "cloze"
                try:
                    validate_cloze(front)
                except ClozeError:
                    pkg.skipped += 1
                    continue
            elif max(ords) >= 1 and back:
                typ = "reversed"
            elif nt["typein"]:
                typ = "typein"
            else:
                typ = "basic"
            if not front.strip() or (typ != "cloze" and not back.strip()):
                pkg.skipped += 1
                continue
            if len(front) > 8000 or len(back) > 8000 or len(extra) > 4000:
                if "Some very long fields were shortened." not in pkg.warnings:
                    pkg.warnings.append("Some very long fields were shortened.")
                front, back, extra = front[:8000], back[:8000], extra[:4000]
            first = min(acards, key=lambda c: int(c["ord"]))
            did = int(first["odid"] or 0) or int(first["did"] or 0)
            path_ = _deck_path(decks.get(did, "Default"))
            deck_paths[path_] = None
            cid = _card_id(str(note["guid"] or note["id"]), used)
            keys = review_keys(typ, front)
            srs_by_key: dict[str, dict] = {}
            suspended = bool(acards) and all(int(c["queue"]) == -1 for c in acards)
            for ac in acards:
                o = int(ac["ord"])
                key = f"c{o + 1}" if typ == "cloze" else ("f" if o == 0 else "r" if o == 1 else None)
                if key is None or key not in keys:
                    continue
                srs = fsrs.new_srs(key)
                hist = revlog.get(int(ac["id"]), [])
                for rid, ease, ivl, rtype, ms in hist:
                    when = datetime.fromtimestamp(rid / 1000, tz)
                    if rtype in (4, 5) or ease == 0:
                        if ivl == 0 and rtype == 4:  # "Forget" / reset to new
                            srs = fsrs.new_srs(key)
                        continue
                    if ease not in (1, 2, 3, 4):
                        continue
                    nxt, lf = fsrs.review(srs, ease, when, cfg, f"{cid}/{key}")
                    srs = nxt
                    logs.append((rid, {"c": cid, "k": key, "t": fsrs.iso(when), "d": min(max(ms, 0), 3_600_000), **lf}))
                if not hist and int(ac["type"]) == 2:
                    srs = _approx_review(ac, crt, cfg, key)
                srs_by_key[key] = srs
            tags = [t for t in str(note["tags"] or "").split() if t][:30]
            pkg.cards.append({
                "id": cid, "deck": path_, "type": typ, "front": front, "back": back, "note": extra,
                "tags": tags, "suspended": suspended,
                "srs": [srs_by_key.get(k) or fsrs.new_srs(k) for k in keys],
                "created": fsrs.iso(datetime.fromtimestamp(int(note["id"]) / 1000, timezone.utc).astimezone(tz)),
            })
            for r in refs:
                if r not in pkg.media_needed:
                    pkg.media_needed.append(r)
        logs.sort(key=lambda x: x[0])
        if len(logs) > LOG_KEEP:
            pkg.reviews_dropped = len(logs) - LOG_KEEP
            logs = logs[-LOG_KEEP:]
        pkg.logs = [e for _, e in logs]
        pkg.decks = list(deck_paths)
        return pkg
    finally:
        con.close()


def is_audio(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in AUDIO_EXTS
