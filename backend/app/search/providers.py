"""Search provider adapters.

Each adapter accepts a `SearchProvider` ORM row (for its config/API key) and
returns a normalised `list[SearchResult]`. All provider-specific errors are
mapped to `SearchError` so callers can handle failures uniformly.

Every outbound HTTP request goes through ``safe_fetch`` instead of plain
``httpx`` so a misconfigured provider URL can't be turned into an SSRF
pivot — the SearXNG endpoint in particular is admin-configurable to a
URL of their choosing, which is exactly the kind of input you don't
want connecting straight to ``http://localhost:6379``.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.auth.utils import decrypt_secret
from app.config import get_settings
from app.net.safe_fetch import (
    ResponseTooLargeError,
    UnsafeURLError,
    safe_fetch,
)
from app.search.models import SearchProvider
from app.search.schemas import SearchResult

logger = logging.getLogger("promptly.search")

# Default timeout for outbound search API calls. Kept snappy — we don't want
# a slow search provider to stall chat responses.
SEARCH_TIMEOUT_SECONDS = 10.0
# Search responses are mostly JSON and shouldn't run more than a few hundred
# KB. Bound liberally at 4 MB so a misbehaving provider can't tee a giant
# blob into the chat backend.
SEARCH_MAX_BYTES = 4 * 1024 * 1024


class SearchError(Exception):
    """Raised when a search provider request fails."""


def _api_key(provider: SearchProvider) -> str | None:
    """Return the decrypted API key from `config.api_key`, if any.

    SearXNG doesn't need a key; Brave/Tavily do. Keys are stored encrypted
    (Fernet) under the same secret as model-provider keys so admins can
    rotate `SECRET_KEY` once to cycle everything.
    """
    raw = (provider.config or {}).get("api_key")
    if not raw:
        return None
    try:
        return decrypt_secret(raw)
    except ValueError as e:
        raise SearchError(f"Unable to decrypt API key for {provider.name!r}: {e}") from e


def _result_count(provider: SearchProvider, override: int | None) -> int:
    if override is not None:
        return max(1, min(20, override))
    cfg_count = (provider.config or {}).get("result_count")
    if isinstance(cfg_count, int) and cfg_count > 0:
        return min(cfg_count, 20)
    return get_settings().SEARCH_RESULT_COUNT


# ------------------------------------------------------------------
# Common helpers
# ------------------------------------------------------------------
async def _safe_request(
    method: str,
    url: str,
    *,
    provider_label: str,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json: Any = None,
) -> httpx.Response:
    """Wrap ``safe_fetch`` and translate its errors into ``SearchError``.

    Centralised so every provider gets the same SSRF guard, body cap,
    and timeout — and so a single place owns the "what does the user
    see when the search backend is misconfigured" message.
    """
    try:
        return await safe_fetch(
            method,
            url,
            timeout_seconds=SEARCH_TIMEOUT_SECONDS,
            max_bytes=SEARCH_MAX_BYTES,
            headers=headers,
            params=params,
            json=json,
        )
    except UnsafeURLError as e:
        raise SearchError(
            f"{provider_label} request refused by SSRF guard ({e.reason})"
        ) from e
    except ResponseTooLargeError as e:
        raise SearchError(
            f"{provider_label} response exceeded the {SEARCH_MAX_BYTES // 1024} KB cap"
        ) from e
    except httpx.HTTPError as e:
        raise SearchError(f"{provider_label} request failed: {e}") from e


def _check_status(provider_label: str, resp: httpx.Response) -> None:
    """``raise_for_status`` analogue that surfaces a clean SearchError."""
    if resp.is_success:
        return
    body_preview = resp.text[:200]
    raise SearchError(
        f"{provider_label} error {resp.status_code}: {body_preview}"
    )


# ------------------------------------------------------------------
# SearXNG
# ------------------------------------------------------------------
async def _search_searxng(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    cfg = provider.config or {}
    base = (cfg.get("url") or get_settings().SEARXNG_URL).rstrip("/")
    url = f"{base}/search"
    params = {
        "q": query,
        "format": "json",
        # SearXNG accepts `num_results` via the built-in proxy param.
        "num_results": count,
    }

    resp = await _safe_request("GET", url, provider_label="SearXNG", params=params)
    _check_status("SearXNG", resp)

    try:
        data: dict[str, Any] = resp.json()
    except ValueError as e:
        # SearXNG returns 403/HTML if json format isn't enabled in settings.yml.
        raise SearchError(
            "SearXNG returned non-JSON. Ensure `json` is in settings.yml `search.formats`."
        ) from e

    items = data.get("results") or []
    out: list[SearchResult] = []
    for r in items[:count]:
        if not isinstance(r, dict):
            continue
        out.append(
            SearchResult(
                title=str(r.get("title") or "").strip() or r.get("url", ""),
                url=str(r.get("url") or ""),
                snippet=str(r.get("content") or "").strip(),
            )
        )
    return out


# ------------------------------------------------------------------
# Brave
# ------------------------------------------------------------------
async def _search_brave(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    api_key = _api_key(provider)
    if not api_key:
        # Fall back to the environment key so the out-of-box experience
        # works if the user set BRAVE_SEARCH_API_KEY but no DB row.
        api_key = get_settings().BRAVE_SEARCH_API_KEY or None
    if not api_key:
        raise SearchError("Brave Search requires an API key")

    url = "https://api.search.brave.com/res/v1/web/search"
    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": api_key,
    }
    params = {"q": query, "count": count}

    resp = await _safe_request(
        "GET", url, provider_label="Brave Search", headers=headers, params=params
    )
    _check_status("Brave Search", resp)

    data = resp.json().get("web", {}).get("results", []) or []
    out: list[SearchResult] = []
    for r in data[:count]:
        if not isinstance(r, dict):
            continue
        out.append(
            SearchResult(
                title=str(r.get("title") or "").strip(),
                url=str(r.get("url") or ""),
                snippet=str(r.get("description") or "").strip(),
            )
        )
    return out


# ------------------------------------------------------------------
# Tavily
# ------------------------------------------------------------------
async def _search_tavily(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    api_key = _api_key(provider) or get_settings().TAVILY_API_KEY
    if not api_key:
        raise SearchError("Tavily requires an API key")

    url = "https://api.tavily.com/search"
    payload = {
        "api_key": api_key,
        "query": query,
        "max_results": count,
        "search_depth": (provider.config or {}).get("search_depth", "basic"),
    }

    resp = await _safe_request("POST", url, provider_label="Tavily", json=payload)
    _check_status("Tavily", resp)

    data = resp.json().get("results", []) or []
    out: list[SearchResult] = []
    for r in data[:count]:
        if not isinstance(r, dict):
            continue
        out.append(
            SearchResult(
                title=str(r.get("title") or "").strip(),
                url=str(r.get("url") or ""),
                snippet=str(r.get("content") or r.get("snippet") or "").strip(),
            )
        )
    return out


# ------------------------------------------------------------------
# Google Programmable Search Engine (PSE / Custom Search JSON API)
# ------------------------------------------------------------------
# Free tier is 100 queries/day, which is plenty for ~10 users on an
# auto-mode setup (most chat turns don't search). Two config keys:
# ``api_key`` (encrypted) and ``cx`` (the Search Engine ID — public
# identifier, not a secret). Optional ``safe`` ("active" | "off") and
# ``result_count``. The endpoint caps ``num`` at 10 per request, so we
# clamp accordingly.
async def _search_google_pse(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    cfg = provider.config or {}
    api_key = _api_key(provider)
    cx = (cfg.get("cx") or "").strip()
    if not api_key:
        raise SearchError("Google PSE requires an API key")
    if not cx:
        raise SearchError(
            "Google PSE requires a `cx` (Search Engine ID) in the provider config"
        )

    url = "https://www.googleapis.com/customsearch/v1"
    params: dict[str, Any] = {
        "key": api_key,
        "cx": cx,
        "q": query,
        # Custom Search JSON API hard-caps `num` at 10. Anything higher
        # would just be silently truncated by Google.
        "num": min(count, 10),
        "safe": cfg.get("safe", "active"),
    }

    resp = await _safe_request(
        "GET", url, provider_label="Google PSE", params=params
    )
    _check_status("Google PSE", resp)

    items = resp.json().get("items", []) or []
    out: list[SearchResult] = []
    for r in items[:count]:
        if not isinstance(r, dict):
            continue
        out.append(
            SearchResult(
                title=str(r.get("title") or "").strip(),
                url=str(r.get("link") or ""),
                snippet=str(r.get("snippet") or "").strip(),
            )
        )
    return out


# ------------------------------------------------------------------
# Result post-processing: URL canonicalisation + dedup
# ------------------------------------------------------------------
# Tracking parameters the providers happily echo back. Stripping these
# means a marketing-tagged copy of a URL collides with the canonical
# version during dedup, so we don't end up citing the same article
# three times because Brave / SearXNG / Google all returned different
# UTM strings.
_TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "gclid",
        "gclsrc",
        "fbclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "ref",
        "ref_src",
        "_hsenc",
        "_hsmi",
        "yclid",
    }
)


def _canonicalise_url(raw: str) -> str:
    """Return a stable form of ``raw`` suitable as a dedup key.

    Rules: lowercase scheme + host, drop the leading ``www.`` on the
    host (a vendor that wants to call out the bare-domain version
    explicitly is welcome to a different host entirely), drop any
    fragment (browsers fragment all the time and it's never part of
    document identity), and strip the tracking-parameter set above.
    Everything else (path, remaining query, port) is preserved so we
    don't accidentally collapse two different pages into one.
    """
    if not raw:
        return ""
    try:
        parts = urlsplit(raw.strip())
    except ValueError:
        return raw

    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    netloc = host
    if parts.port is not None:
        netloc = f"{host}:{parts.port}"

    # Filter the query string. ``parse_qsl`` keeps duplicate keys, which
    # we want to preserve for non-tracking params (some sites rely on
    # repeated keys for arrays).
    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in _TRACKING_PARAMS
    ]
    query = urlencode(kept)

    return urlunsplit((scheme, netloc, parts.path, query, ""))


def _dedupe_results(results: list[SearchResult]) -> list[SearchResult]:
    """Drop empty / duplicate results, preserving the provider's order.

    Quality-ish filters: empty URL, empty title, or duplicate canonical
    URL all get filtered. The first occurrence wins on dupes — which is
    usually the highest-ranked one given providers return results in
    relevance order.
    """
    seen: set[str] = set()
    out: list[SearchResult] = []
    for r in results:
        if not r.url or not r.title.strip():
            continue
        key = _canonicalise_url(r.url)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# ------------------------------------------------------------------
# Dispatcher
# ------------------------------------------------------------------
_ADAPTERS = {
    "searxng": _search_searxng,
    "brave": _search_brave,
    "tavily": _search_tavily,
    "google_pse": _search_google_pse,
}


async def run_search(
    provider: SearchProvider, query: str, count: int | None = None
) -> list[SearchResult]:
    """Execute a search against the given provider.

    Always returns a (possibly empty) list of `SearchResult` with
    duplicates and empty rows already filtered out. Raises
    `SearchError` on transport / auth failures so callers can decide
    whether to surface the error or fall back silently.
    """
    adapter = _ADAPTERS.get(provider.type)
    if adapter is None:
        raise SearchError(f"Unsupported search provider type: {provider.type!r}")

    n = _result_count(provider, count)
    logger.info(
        "Running search via %s (provider=%s) n=%d q=%r",
        provider.type,
        provider.name,
        n,
        query[:80],
    )
    raw = await adapter(provider, query, n)
    deduped = _dedupe_results(raw)
    if len(deduped) != len(raw):
        logger.debug(
            "Dedup pass dropped %d/%d results from %s",
            len(raw) - len(deduped),
            len(raw),
            provider.type,
        )
    return deduped


__all__ = [
    "SearchError",
    "canonicalise_url",
    "run_search",
]


# Public alias — keeps the chat-router import out of the underscored
# private name without changing the legacy implementation symbol.
canonicalise_url = _canonicalise_url
