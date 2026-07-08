"""Link unfurl — fetch a URL's title / description / favicon so the note
editor can render rich link previews (favicon + title hover card).

    GET /api/links/unfurl?url=<http(s) url>   →  LinkPreview

SSRF-safe: every fetch goes through :func:`app.net.safe_fetch.safe_fetch`,
which validates the URL (and every redirect hop) against the private-range
allowlist — so this endpoint can't be turned into a pivot to internal
services. Auth-gated so it's not an open proxy. Results are cached in
process with a short TTL to keep repeat hovers cheap; the frontend also
caches per-URL via react-query.

Only the stdlib ``html.parser`` is used — no new dependency to keep the
self-host footprint small.
"""
from __future__ import annotations

import logging
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.auth.deps import get_current_user
from app.auth.models import User
from app.net.safe_fetch import (
    ResponseTooLargeError,
    UnsafeURLError,
    safe_fetch,
)

logger = logging.getLogger("promptly.links.unfurl")

router = APIRouter()

_CACHE_TTL = 3600.0  # 1 hour — link metadata is effectively static
_CACHE_MAX = 512
_MAX_HTML_BYTES = 512 * 1024
_cache: dict[str, tuple[float, "LinkPreview"]] = {}


class LinkPreview(BaseModel):
    url: str
    title: str | None = None
    description: str | None = None
    favicon: str | None = None
    image: str | None = None
    site_name: str | None = None


class _MetaParser(HTMLParser):
    """Pull ``<title>``, OpenGraph/Twitter/meta description and the best
    ``<link rel=icon>`` out of a page's ``<head>`` — tolerant of malformed
    markup (stdlib parser never raises on bad tags)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self._in_title = False
        self.og: dict[str, str] = {}
        self.meta_desc: str | None = None
        self.icon_href: str | None = None
        self._icon_rank = -1

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            content = a.get("content")
            if not content:
                return
            if key.startswith("og:"):
                self.og.setdefault(key[3:], content)
            elif key == "description":
                self.meta_desc = self.meta_desc or content
            elif key == "twitter:image":
                self.og.setdefault("image", content)
            elif key == "twitter:title":
                self.og.setdefault("title", content)
        elif tag == "link":
            rel = (a.get("rel") or "").lower()
            href = a.get("href")
            if href and "icon" in rel:
                # Prefer apple-touch-icon (bigger, cleaner) > plain icon.
                rank = 2 if "apple-touch" in rel else 1
                if rank > self._icon_rank:
                    self._icon_rank = rank
                    self.icon_href = href

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title and data.strip():
            self.title = data.strip()


def _abs(base: str, href: str | None) -> str | None:
    """Resolve ``href`` against ``base`` and keep only http(s)."""
    if not href:
        return None
    try:
        resolved = urljoin(base, href.strip())
    except ValueError:
        return None
    return resolved if urlparse(resolved).scheme in ("http", "https") else None


@router.get("/unfurl", response_model=LinkPreview)
async def unfurl(
    url: str = Query(..., max_length=2048),
    user: User = Depends(get_current_user),
) -> LinkPreview:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        # Not fetchable — hand back the bare host so the card still renders.
        return LinkPreview(url=url, title=parsed.netloc or url)

    now = time.time()
    hit = _cache.get(url)
    if hit is not None and now - hit[0] < _CACHE_TTL:
        return hit[1]

    # Sensible fallback if the fetch fails/blocks: host as the title +
    # the well-known favicon path (which the browser can still load).
    preview = LinkPreview(
        url=url,
        title=parsed.netloc,
        favicon=f"{parsed.scheme}://{parsed.netloc}/favicon.ico",
    )
    try:
        resp = await safe_fetch(
            "GET", url, max_bytes=_MAX_HTML_BYTES, timeout_seconds=8.0
        )
        ctype = resp.headers.get("content-type", "").lower()
        if "html" in ctype or ctype == "":
            parser = _MetaParser()
            try:
                parser.feed(resp.text[:_MAX_HTML_BYTES])
            except Exception:  # noqa: BLE001 — never let bad markup 500
                logger.debug("unfurl parse error for %s", url, exc_info=True)
            title = (
                parser.og.get("title")
                or (parser.title or "").strip()
                or parsed.netloc
            )
            desc = parser.og.get("description") or parser.meta_desc
            preview = LinkPreview(
                url=url,
                title=title[:300] if title else parsed.netloc,
                description=desc.strip()[:400] if desc else None,
                favicon=_abs(url, parser.icon_href)
                or f"{parsed.scheme}://{parsed.netloc}/favicon.ico",
                image=_abs(url, parser.og.get("image")),
                site_name=(parser.og.get("site_name") or "").strip()[:120]
                or None,
            )
    except (UnsafeURLError, ResponseTooLargeError) as e:
        logger.info("unfurl declined for %s: %s", url, e)
    except Exception as e:  # noqa: BLE001 — a preview is best-effort
        logger.info("unfurl failed for %s: %s", url, type(e).__name__)

    # Crude cap: clear wholesale rather than track LRU order — the cache is
    # a nicety, not a correctness requirement.
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()
    _cache[url] = (now, preview)
    return preview


__all__ = ["router"]
