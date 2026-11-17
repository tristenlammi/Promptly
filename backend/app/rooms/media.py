"""Rooms media: GIFs (your own and the GIF library's), saved GIFs, a space's
own emoji, and link previews.

**GIFs.** Your own are ordinary attachments marked ``animated``. A GIF from
the library (GIPHY or KLIPY) rides on the message as ``meta.gif``: a
reference, never a copy. Both libraries' terms say the same thing: searches
and GIFs go straight from the person's browser to the library, no proxying
and no copies kept by the app. So this server never fetches from them; it
only checks that what a page sends really points at the library
(:func:`clean_gif`), so ``meta.gif`` can't be used to make everyone's
browser load a picture from somewhere else.

**Link previews.** The opposite: this server fetches the page (the SSRF-safe
fetch, never a private address), keeps a small picture of its own, and
people's browsers only ever talk to this server.

**Custom emoji.** A space's admins add an image with a ``:name:``.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import re
import shutil
import uuid
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.storage import absolute_path

from . import core, service
from . import settings as rooms_settings
from .models import Room, RoomAttachment, RoomEmoji, RoomMessage, RoomSavedGif

logger = logging.getLogger("promptly.rooms.media")


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


# ================================================================== GIF library

# Where each library serves from. A ``meta.gif`` address must be https on one
# of these (or a subdomain), nothing else.
PROVIDER_HOSTS: dict[str, tuple[str, ...]] = {
    "giphy": ("giphy.com",),
    "klipy": ("klipy.com",),
}
PROVIDER_NAMES = {"giphy": "GIPHY", "klipy": "KLIPY"}


def _provider_url(provider: str, url: Any) -> str | None:
    if not isinstance(url, str) or len(url) > 600:
        return None
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
            return None
    except ValueError:
        return None
    for base in PROVIDER_HOSTS.get(provider, ()):
        if host == base or host.endswith("." + base):
            return url.strip()
    return None


def clean_gif(raw: dict[str, Any], provider: str | None) -> dict[str, Any]:
    """A library GIF as a message may carry it, or a 400. ``provider`` is the
    library that's on now (None: search is off, so none can be sent)."""
    if not provider:
        raise _bad("GIF search isn't on for this server")
    if raw.get("provider") != provider:
        raise _bad("That GIF is from a library this server doesn't use")
    url = _provider_url(provider, raw.get("url"))
    if not url:
        raise _bad("That isn't a GIF from the library")
    preview = _provider_url(provider, raw.get("preview_url")) if raw.get("preview_url") else None
    page = _provider_url(provider, raw.get("page_url")) if raw.get("page_url") else None

    def side(v: Any) -> int | None:
        return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 4096 else None

    return {
        "provider": provider,
        "id": re.sub(r"[^A-Za-z0-9_-]", "", str(raw.get("id") or ""))[:64],
        "url": url,
        "preview_url": preview,
        "page_url": page,
        "width": side(raw.get("width")),
        "height": side(raw.get("height")),
        "title": " ".join(str(raw.get("title") or "").split())[:120],
    }


# ================================================================== saved GIFs

MAX_SAVED = 200
MAX_SAVED_BYTES = 15 * 1024 * 1024


def saved_path(g: RoomSavedGif) -> str:
    return f"rooms/saved/{g.user_id}/{g.id}"


def saved_out(g: RoomSavedGif) -> dict:
    if g.source == "provider":
        return {"id": str(g.id), "source": "provider", "gif": g.data.get("gif"), "width": g.width, "height": g.height}
    return {
        "id": str(g.id),
        "source": "own",
        "url": core.signed_url("roomsaved", g.id, f"/api/rooms/saved-gifs/{g.id}/file"),
        "filename": g.filename,
        "mime": g.mime,
        "size": g.size,
        "width": g.width,
        "height": g.height,
    }


async def list_saved(db: AsyncSession, user: User) -> list[dict]:
    rows = (
        await db.execute(select(RoomSavedGif).where(RoomSavedGif.user_id == user.id).order_by(RoomSavedGif.created_at.desc()))
    ).scalars()
    return [saved_out(g) for g in rows]


async def _room_for_saving(db: AsyncSession, user: User) -> None:
    count = await db.scalar(select(func.count()).select_from(RoomSavedGif).where(RoomSavedGif.user_id == user.id))
    if (count or 0) >= MAX_SAVED:
        raise _bad(f"You've saved {MAX_SAVED} GIFs, which is the most you can keep. Remove one first.")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


async def save_attachment(db: AsyncSession, user: User, att_id: uuid.UUID) -> RoomSavedGif:
    """Keep your own copy of a GIF someone sent. You must be able to see the
    message it's on; the copy is yours from then on."""
    att = await db.get(RoomAttachment, att_id)
    if att is None or att.message_id is None or att.removed_at is not None:
        raise core.not_found("GIF")
    msg = await db.get(RoomMessage, att.message_id)
    if msg is None or msg.deleted_at is not None:
        raise core.not_found("GIF")
    await core.load_room(db, att.room_id, user)  # 404 if you can't see it
    if not (att.mime.startswith("image/") and (att.animated or att.mime == "image/gif")):
        raise _bad("Only GIFs can be saved")
    if att.size > MAX_SAVED_BYTES:
        raise _bad("That GIF is too big to save (15 MB at most)")
    src = absolute_path(service.att_path(att))
    if not src.exists():
        raise core.not_found("GIF")
    digest = _sha256(src)
    for g in (await db.execute(select(RoomSavedGif).where(RoomSavedGif.user_id == user.id, RoomSavedGif.source == "own"))).scalars():
        if g.data.get("sha256") == digest:
            return g  # already saved
    await _room_for_saving(db, user)
    g = RoomSavedGif(
        id=uuid.uuid4(),
        user_id=user.id,
        source="own",
        filename=att.filename,
        mime=att.mime,
        size=att.size,
        width=att.width,
        height=att.height,
        data={"sha256": digest},
    )
    dst = absolute_path(saved_path(g))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    db.add(g)
    await db.flush()
    return g


async def save_provider_gif(db: AsyncSession, user: User, gif: dict[str, Any]) -> RoomSavedGif:
    for g in (await db.execute(select(RoomSavedGif).where(RoomSavedGif.user_id == user.id, RoomSavedGif.source == "provider"))).scalars():
        have = g.data.get("gif") or {}
        if have.get("provider") == gif["provider"] and (have.get("id") or have.get("url")) == (gif["id"] or gif["url"]):
            return g
    await _room_for_saving(db, user)
    g = RoomSavedGif(id=uuid.uuid4(), user_id=user.id, source="provider", width=gif.get("width"), height=gif.get("height"), data={"gif": gif})
    db.add(g)
    await db.flush()
    return g


async def my_saved(db: AsyncSession, user: User, saved_id: uuid.UUID) -> RoomSavedGif:
    g = await db.get(RoomSavedGif, saved_id)
    if g is None or g.user_id != user.id:
        raise core.not_found("GIF")
    return g


def remove_saved_file(g: RoomSavedGif) -> None:
    if g.source != "own":
        return
    try:
        absolute_path(saved_path(g)).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


async def attach_saved(db: AsyncSession, room: Room, user: User, g: RoomSavedGif) -> RoomAttachment:
    """One of your saved GIFs as a fresh attachment in ``room``, ready to send."""
    if g.source != "own":
        raise _bad("That one is sent as a GIF from the library")
    src = absolute_path(saved_path(g))
    if not src.exists():
        raise core.not_found("GIF")
    # A file attached to a message like any other: the same limits.
    from . import uploads

    await uploads.ensure_not_waiting(db, user)
    await uploads.ensure_storage(db, user, g.size, lock=True)
    att = RoomAttachment(
        id=uuid.uuid4(),
        room_id=room.id,
        uploader_id=user.id,
        filename=g.filename or "saved.gif",
        mime=g.mime,
        size=g.size,
    )
    dst = absolute_path(service.att_path(att))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    service._thumbnail(att, dst)
    db.add(att)
    await db.flush()
    return att


# ================================================================== custom emoji

EMOJI_NAME = re.compile(r"^[a-z0-9_]{2,30}$")
CUSTOM_REACTION = re.compile(r"^:([a-z0-9_]{2,30}):$")
_EMOJI_EXTS = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
EMOJI_MAX_EDGE = 1024


def emoji_dir(space_id: uuid.UUID) -> str:
    return f"rooms/emoji/{space_id}"


def emoji_path(e: RoomEmoji) -> str:
    return f"{emoji_dir(e.space_id)}/{e.id}"


def emoji_out(e: RoomEmoji) -> dict:
    return {
        "id": str(e.id),
        "name": e.name,
        "url": core.signed_url("roomemoji", e.id, f"/api/rooms/emojis/{e.id}/file"),
        "animated": bool(e.animated),
        "created_by": str(e.created_by) if e.created_by else None,
    }


async def emojis_for(db: AsyncSession, space_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict]]:
    """Each space's emoji, for the page (bootstrap)."""
    out: dict[uuid.UUID, list[dict]] = {}
    if not space_ids:
        return out
    rows = (await db.execute(select(RoomEmoji).where(RoomEmoji.space_id.in_(space_ids)).order_by(RoomEmoji.name))).scalars()
    for e in rows:
        out.setdefault(e.space_id, []).append(emoji_out(e))
    return out


def clean_emoji_name(raw: str) -> str:
    name = (raw or "").strip().strip(":").lower().replace("-", "_").replace(" ", "_")
    if not EMOJI_NAME.match(name):
        raise _bad("An emoji's name is 2 to 30 letters, numbers or underscores")
    return name


async def _name_free(db: AsyncSession, space_id: uuid.UUID, name: str, *, but: uuid.UUID | None = None) -> None:
    q = select(RoomEmoji.id).where(RoomEmoji.space_id == space_id, RoomEmoji.name == name)
    if but is not None:
        q = q.where(RoomEmoji.id != but)
    if (await db.execute(q)).first() is not None:
        raise _bad(f"This space already has an emoji called :{name}:", status.HTTP_409_CONFLICT)


async def add_emoji(db: AsyncSession, space_id: uuid.UUID, user: User, name: str, upload: UploadFile) -> RoomEmoji:
    """Store a space's new emoji (the caller has checked they're an admin).
    Only real PNG, JPEG, GIF or WebP images get in: the upload allowlist
    sniffs the bytes, and location and camera details are stripped."""
    from app.files.safety import UnsafeUploadError, sniff_and_validate, strip_image_metadata_in_place

    limits = await rooms_settings.load(db)
    name = clean_emoji_name(name)
    await _name_free(db, space_id, name)
    count = await db.scalar(select(func.count()).select_from(RoomEmoji).where(RoomEmoji.space_id == space_id))
    if (count or 0) >= limits["emoji_max_per_space"]:
        raise _bad(f"This space has {limits['emoji_max_per_space']} emoji, which is the most this server allows")
    filename = upload.filename or ""
    ext = Path(filename).suffix.lower()
    if ext not in _EMOJI_EXTS:
        raise _bad("An emoji is a PNG, JPEG, GIF or WebP image")
    max_bytes = limits["emoji_max_kb"] * 1024
    e = RoomEmoji(id=uuid.uuid4(), space_id=space_id, name=name, created_by=user.id)
    path = absolute_path(emoji_path(e))
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await upload.read(256 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise _bad(f"An emoji can be up to {limits['emoji_max_kb']} KB", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
                out.write(chunk)
        if size == 0:
            raise _bad("That file is empty")
        try:
            e.mime = sniff_and_validate(path, declared_filename=f"emoji{ext}", declared_mime=upload.content_type)
        except UnsafeUploadError as err:
            raise _bad("That isn't a picture this server can use as an emoji") from err
        from PIL import Image

        try:
            with Image.open(path) as img:
                e.width, e.height = img.size
                e.animated = bool(getattr(img, "is_animated", False)) and (getattr(img, "n_frames", 1) or 1) > 1
        except Exception as err:  # noqa: BLE001
            raise _bad("That picture couldn't be read") from err
        if max(e.width or 0, e.height or 0) > EMOJI_MAX_EDGE:
            raise _bad(f"An emoji can be up to {EMOJI_MAX_EDGE} pixels on a side")
        if not e.animated:
            strip_image_metadata_in_place(path, e.mime)
        e.size = path.stat().st_size
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    db.add(e)
    await db.flush()
    return e


async def rename_emoji(db: AsyncSession, e: RoomEmoji, name: str) -> None:
    name = clean_emoji_name(name)
    await _name_free(db, e.space_id, name, but=e.id)
    e.name = name


def remove_emoji_file(e: RoomEmoji) -> None:
    try:
        absolute_path(emoji_path(e)).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def remove_space_emoji_files(space_id: uuid.UUID) -> None:
    try:
        shutil.rmtree(absolute_path(emoji_dir(space_id)), ignore_errors=True)
    except ValueError:
        pass


async def check_reaction(db: AsyncSession, room: Room, emoji: str) -> None:
    """``:name:`` as a reaction must be one of this room's space's emoji."""
    m = CUSTOM_REACTION.match(emoji)
    if not m:
        if emoji.startswith(":") and emoji.endswith(":") and len(emoji) > 2:
            raise _bad("That emoji isn't in this space")
        return
    found = None
    if room.space_id is not None:
        found = (
            await db.execute(select(RoomEmoji.id).where(RoomEmoji.space_id == room.space_id, RoomEmoji.name == m.group(1)))
        ).first()
    if found is None:
        raise _bad("That emoji isn't in this space")


# ================================================================== link previews

PREVIEW_HTML_BYTES = 3 * 1024 * 1024
PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024
PREVIEW_EDGE = 640
PREVIEW_MAX_PIXELS = 40_000_000
PREVIEW_TIMEOUT = 6.0
PREVIEW_CACHE_S = 6 * 3600
PREVIEW_MISS_S = 30 * 60
PREVIEW_PER_10_MIN = 40
# A plain, generic client name: nothing about this server or its people.
_UA = "Mozilla/5.0 (compatible; LinkPreview/1.0)"

_URL = re.compile(r"https?://[^\s<>\"'`\]\)]+", re.I)
_CODE = re.compile(r"```[\s\S]*?```|`[^`\n]*`")


def first_link(body: str) -> str | None:
    """The first web address written in a message, outside code."""
    text = _CODE.sub(" ", body or "")
    # A Markdown link's address counts; its closing bracket doesn't.
    for m in _URL.finditer(text):
        url = m.group(0).rstrip(".,;:!?'\"")
        try:
            parts = urlsplit(url)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            continue
        if len(url) > 2000:
            continue
        return url
    return None


def preview_path(room_id: uuid.UUID, message_id: uuid.UUID) -> str:
    return f"{service.room_dir(room_id)}/prev-{message_id}.webp"


def forget_preview(m: RoomMessage) -> None:
    """A wiped message keeps no preview picture and no library GIF."""
    try:
        absolute_path(preview_path(m.room_id, m.id)).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass
    meta = dict(m.meta or {})
    if "preview" in meta or "gif" in meta:
        meta.pop("preview", None)
        meta.pop("gif", None)
        m.meta = meta


def wants_preview(m: RoomMessage) -> str | None:
    """The address to preview for this message, or None: only people's own
    plain messages, and never one that's already a card of another kind."""
    if m.kind != "user" or m.deleted_at is not None:
        return None
    meta = m.meta or {}
    if any(k in meta for k in ("place", "share", "event_id", "event_reminder", "gif", "call")):
        return None
    if isinstance(meta.get("preview"), dict) and meta["preview"].get("removed"):
        return None
    return first_link(m.body or "")


class _Head(HTMLParser):
    """Just enough HTML: the title and the ``<meta>`` tags pages describe
    themselves with (Open Graph, Twitter cards, plain description)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self.icon = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.done:
            return
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").strip().lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data: str) -> None:
        if self._in_title and len(self.title) < 400:
            self.title += data


def _text(v: Any, limit: int) -> str:
    s = re.sub(r"[\x00-\x1f\x7f]+", " ", str(v or ""))
    return " ".join(s.split())[:limit]


def parse_page(html: str, url: str) -> dict[str, Any]:
    """Title, description, site and picture address from a page's head."""
    p = _Head()
    try:
        p.feed(html[:600_000])
    except Exception:  # noqa: BLE001 - broken HTML: use what was read
        pass
    m = p.meta
    image = m.get("og:image:secure_url") or m.get("og:image") or m.get("twitter:image") or m.get("twitter:image:src") or ""
    if image:
        image = urljoin(url, image)
        try:
            if urlsplit(image).scheme not in ("http", "https"):
                image = ""
        except ValueError:
            image = ""
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    return {
        "title": _text(m.get("og:title") or m.get("twitter:title") or p.title, 200),
        "description": _text(m.get("og:description") or m.get("twitter:description") or m.get("description"), 300),
        "site": _text(m.get("og:site_name"), 60) or host,
        "image_src": image[:2000],
    }


def _thumb(raw: bytes) -> tuple[bytes, int, int] | None:
    """A small WEBP of a fetched picture, or None if it isn't one."""
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(raw)) as img:
            # Its size is in the header: a picture that would take hundreds of
            # megabytes to open isn't opened (it came from someone else's site).
            if img.width * img.height > PREVIEW_MAX_PIXELS:
                return None
            img.seek(0)
            img = ImageOps.exif_transpose(img)
            if img.width < 40 or img.height < 40:
                return None
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")
            img.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE))
            buf = io.BytesIO()
            img.save(buf, format="WEBP", quality=78, method=4)
            return buf.getvalue(), img.width, img.height
    except Exception:  # noqa: BLE001 - not a picture we can read
        return None


async def _own_hosts(db: AsyncSession) -> set[str]:
    from app.public_origin import configured_origins

    hosts = {"localhost", "127.0.0.1"}
    for o in await configured_origins(db):
        h = urlsplit(o).hostname
        if h:
            hosts.add(h.lower())
    return hosts


async def fetch_preview(url: str) -> dict[str, Any] | None:
    """Fetch a page and describe it: ``{title, description, site, image:
    (bytes, w, h) | None}``, or None when there's nothing worth a card.
    Every request goes through the SSRF-safe fetch."""
    from app.net.safe_fetch import ResponseTooLargeError, UnsafeURLError, safe_fetch

    headers = {"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5", "Accept-Language": "en"}
    try:
        r = await safe_fetch("GET", url, timeout_seconds=PREVIEW_TIMEOUT, max_bytes=PREVIEW_HTML_BYTES, headers=headers)
    except (UnsafeURLError, ResponseTooLargeError):
        return None
    except Exception:  # noqa: BLE001 - unreachable, slow, TLS trouble…
        logger.debug("preview fetch failed", exc_info=True)
        return None
    if r.status_code != 200:
        return None
    ctype = (r.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    if ctype.startswith("image/") and ctype != "image/svg+xml":
        img = _thumb(r.content)
        if img is None:
            return None
        name = _text(urlsplit(url).path.rsplit("/", 1)[-1], 120)
        return {"title": name or host, "description": "", "site": host, "image": img}
    if ctype not in ("text/html", "application/xhtml+xml"):
        return None
    try:
        html = r.text
    except Exception:  # noqa: BLE001
        return None
    page = parse_page(html, str(r.url) if getattr(r, "url", None) else url)
    if not page["title"]:
        return None
    image = None
    if page["image_src"]:
        try:
            ir = await safe_fetch(
                "GET", page["image_src"], timeout_seconds=PREVIEW_TIMEOUT, max_bytes=PREVIEW_IMAGE_BYTES, headers={"User-Agent": _UA, "Accept": "image/*"}
            )
            if ir.status_code == 200:
                image = _thumb(ir.content)
        except Exception:  # noqa: BLE001 - the words still make a card
            image = None
    return {"title": page["title"], "description": page["description"], "site": page["site"], "image": image}


def _cache_key(url: str) -> str:
    return "rooms:prev:" + hashlib.sha256(url.encode()).hexdigest()


async def _cached(url: str) -> dict[str, Any] | None | bool:
    """A recent result for this address: the preview, None (nothing to
    show), or False when it hasn't been looked up lately."""
    from app.redis_client import redis

    try:
        raw = await redis.get(_cache_key(url))
    except Exception:  # noqa: BLE001
        return False
    if not raw:
        return False
    try:
        d = json.loads(raw)
    except ValueError:
        return False
    if not d:
        return None
    img = d.pop("image_b64", None)
    d["image"] = (base64.b64decode(img), d.pop("w", 0), d.pop("h", 0)) if img else None
    return d


async def _remember(url: str, got: dict[str, Any] | None) -> None:
    from app.redis_client import redis

    try:
        if got is None:
            await redis.set(_cache_key(url), "{}", ex=PREVIEW_MISS_S)
            return
        d = {k: got[k] for k in ("title", "description", "site")}
        if got.get("image") and len(got["image"][0]) <= 200_000:
            d.update({"image_b64": base64.b64encode(got["image"][0]).decode(), "w": got["image"][1], "h": got["image"][2]})
        await redis.set(_cache_key(url), json.dumps(d), ex=PREVIEW_CACHE_S)
    except Exception:  # noqa: BLE001 - the cache is only a saving
        logger.debug("preview cache write failed", exc_info=True)


async def _allowed_now(user_id: uuid.UUID | None) -> bool:
    """A cap on how many pages one person can make this server fetch."""
    from app.redis_client import redis

    try:
        key = f"rooms:prevrl:{user_id}"
        n = await redis.incr(key)
        if n == 1:
            await redis.expire(key, 600)
        return n <= PREVIEW_PER_10_MIN
    except Exception:  # noqa: BLE001
        return True


async def build_preview(message_id: uuid.UUID) -> None:
    """After a message is sent or edited: look its first link up and put the
    card on it. Runs on its own, off the request."""
    from app.database import SessionLocal

    try:
        async with SessionLocal() as db:
            msg = await db.get(RoomMessage, message_id)
            if msg is None:
                return
            url = wants_preview(msg)
            have = (msg.meta or {}).get("preview") if isinstance((msg.meta or {}).get("preview"), dict) else None
            if url is None or (have and have.get("url") == url):
                if url is None and have and not have.get("removed"):
                    await _set_preview(db, message_id, None, expect_url=None)
                return
            if not (await rooms_settings.load(db))["link_previews"]:
                return
            if (urlsplit(url).hostname or "").lower() in await _own_hosts(db):
                # A link into this Promptly: it has its own cards.
                if have:
                    await _set_preview(db, message_id, None, expect_url=None)
                return
            author = msg.author_id
        got = await _cached(url)
        if got is False:
            if not await _allowed_now(author):
                return
            got = await fetch_preview(url)
            await _remember(url, got)
        async with SessionLocal() as db:
            await _set_preview(db, message_id, got, expect_url=url)
    except Exception:  # noqa: BLE001 - a preview is never worth an error
        logger.exception("link preview failed for %s", message_id)


async def _set_preview(db: AsyncSession, message_id: uuid.UUID, got: dict[str, Any] | None, *, expect_url: str | None) -> None:
    """Write the card onto the message (or take a stale one off) and tell
    everyone's open pages. ``expect_url``: skip if the message has changed
    since the look-up started."""
    msg = (await db.execute(select(RoomMessage).where(RoomMessage.id == message_id).with_for_update())).scalar_one_or_none()
    if msg is None or msg.deleted_at is not None:
        return
    meta = dict(msg.meta or {})
    old = meta.get("preview") if isinstance(meta.get("preview"), dict) else None
    if old and old.get("removed") and expect_url is not None:
        return
    if expect_url is not None and wants_preview(msg) != expect_url:
        return
    path = absolute_path(preview_path(msg.room_id, msg.id))
    if got is None:
        if not old:
            return
        meta.pop("preview", None)
        path.unlink(missing_ok=True)
    else:
        card: dict[str, Any] = {
            "url": expect_url,
            "title": got["title"],
            "description": got["description"],
            "site": got["site"],
            "image": False,
            "v": int((old or {}).get("v", 0)) + 1,
        }
        if got.get("image"):
            raw, w, h = got["image"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            card.update({"image": True, "w": w, "h": h})
        else:
            path.unlink(missing_ok=True)
        meta["preview"] = card
    msg.meta = meta
    await db.commit()
    await db.refresh(msg)
    room = await db.get(Room, msg.room_id)
    if room is not None:
        await core.publish(await core.member_ids(db, room), {"type": "message_edit", "message": await core.message_out(db, msg)})


async def remove_preview(db: AsyncSession, msg: RoomMessage) -> None:
    """The sender took the card off: it stays off, even after an edit."""
    meta = dict(msg.meta or {})
    old = meta.get("preview") if isinstance(meta.get("preview"), dict) else {}
    meta["preview"] = {"removed": True, "url": (old or {}).get("url")}
    msg.meta = meta
    try:
        absolute_path(preview_path(msg.room_id, msg.id)).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass
