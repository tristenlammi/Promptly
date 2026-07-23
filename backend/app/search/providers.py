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
    """Raised when a search provider request fails.

    ``status_code`` carries the upstream HTTP status when the failure was an
    error *response* (vs a transport error / timeout, where it's ``None``).
    ``permanent`` marks failures that won't fix themselves on a retry — auth
    (401/403), quota/billing (402/429) — so the failover layer can pause the
    provider for a while and alert an admin rather than hammering it on every
    search.
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code

    @property
    def permanent(self) -> bool:
        return self.status_code in (401, 402, 403, 429)


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
        f"{provider_label} error {resp.status_code}: {body_preview}",
        status_code=resp.status_code,
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
# OpenRouter web search
# ------------------------------------------------------------------
# OpenRouter has no standalone search endpoint — its web search is a *plugin*
# on a chat completion (results powered by Exa, or native search for
# Anthropic/OpenAI/Google/Perplexity/xAI models). So we run a minimal
# completion with the ``web`` plugin forced on and harvest the ``url_citation``
# annotations the model attaches. This runs the search on OpenRouter's
# infrastructure (not the self-host's IP), which is the whole point: it isn't
# subject to the CAPTCHA/rate-limit walls that block SearXNG's scraping.
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# ``openrouter/auto`` always resolves (OpenRouter routes it) so a stale model
# slug can't break search; the token count here is tiny, and the Exa search
# fee dominates cost, so the model choice barely matters. Admins can pin a
# specific cheap model via ``config.model``.
_OPENROUTER_DEFAULT_MODEL = "openrouter/auto"
# The plugin call includes a model generation, so give it more room than the
# snappy 10 s used for pure search APIs.
_OPENROUTER_TIMEOUT_SECONDS = 30.0

# Small TTL cache for the instance's OpenRouter *model-provider* key so search
# can reuse it (see _instance_openrouter_key) without a DB hit on every query.
_OR_KEY_CACHE: dict[str, object] = {"key": None, "at": 0.0}
_OR_KEY_TTL_SECONDS = 60.0


async def _instance_openrouter_key() -> str | None:
    """Reuse the OpenRouter key the admin already configured in Admin → Models
    (a ``ModelProvider`` row) so search doesn't ask for it twice. Cached briefly
    so a busy search path (Deep Research fans out many queries) doesn't re-query
    + re-decrypt each time."""
    import time

    now = time.monotonic()
    if (
        _OR_KEY_CACHE["key"] is not None
        and now - float(_OR_KEY_CACHE["at"]) < _OR_KEY_TTL_SECONDS  # type: ignore[arg-type]
    ):
        return str(_OR_KEY_CACHE["key"])

    key: str | None = None
    try:
        # Local imports keep providers.py's import-time deps minimal.
        from sqlalchemy import select

        from app.database import SessionLocal
        from app.models_config.models import ModelProvider

        async with SessionLocal() as s:
            row = (
                (
                    await s.execute(
                        select(ModelProvider)
                        .where(
                            ModelProvider.type == "openrouter",
                            ModelProvider.enabled.is_(True),
                            ModelProvider.api_key.is_not(None),
                        )
                        .limit(1)
                    )
                )
                .scalars()
                .first()
            )
        if row and row.api_key:
            key = decrypt_secret(row.api_key)
    except Exception:  # noqa: BLE001 — best-effort reuse; caller falls back
        key = None

    # Only cache a hit — leaving a miss uncached means a freshly-added
    # OpenRouter model provider is picked up on the next search, not in 60 s.
    if key is not None:
        _OR_KEY_CACHE["key"] = key
        _OR_KEY_CACHE["at"] = now
    return key


async def _search_openrouter(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    # Key precedence: this provider's own key → the OpenRouter key already set
    # up in Admin → Models → the env var. So an admin who's using OpenRouter
    # for chat can add search with no key at all.
    api_key = (
        _api_key(provider)
        or await _instance_openrouter_key()
        or get_settings().OPENROUTER_API_KEY
    )
    if not api_key:
        raise SearchError("OpenRouter search requires an API key")
    model = (provider.config or {}).get("model") or _OPENROUTER_DEFAULT_MODEL

    body = {
        "model": model,
        "plugins": [
            {
                "id": "web",
                "engine": "exa",
                "max_results": count,
                "search_prompt": "Relevant, up-to-date web results:",
            }
        ],
        "messages": [
            {
                "role": "user",
                "content": (
                    f"Search the web for: {query}\n"
                    "Briefly list the most relevant, recent sources you find."
                ),
            }
        ],
        # Enough tokens for the model to actually cite several sources (that's
        # what populates the annotations we harvest) without a long essay.
        "max_tokens": 800,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # OpenRouter asks integrators to identify themselves; also surfaces
        # Promptly on the OpenRouter activity dashboard.
        "HTTP-Referer": "https://chatpromptly.com",
        "X-Title": "Promptly",
    }
    try:
        async with httpx.AsyncClient(timeout=_OPENROUTER_TIMEOUT_SECONDS) as client:
            resp = await client.post(_OPENROUTER_URL, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise SearchError(f"OpenRouter request failed: {e}") from e
    _check_status("OpenRouter", resp)

    try:
        data = resp.json()
    except ValueError as e:
        raise SearchError("OpenRouter returned non-JSON") from e

    out: list[SearchResult] = []
    seen: set[str] = set()
    for choice in data.get("choices", []) or []:
        message = (choice or {}).get("message") or {}
        for ann in message.get("annotations") or []:
            if not isinstance(ann, dict) or ann.get("type") != "url_citation":
                continue
            cite = ann.get("url_citation") or {}
            url = str(cite.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            out.append(
                SearchResult(
                    title=str(cite.get("title") or url).strip(),
                    url=url,
                    snippet=str(cite.get("content") or "").strip(),
                )
            )
            if len(out) >= count:
                return out
    return out


# ------------------------------------------------------------------
# Ollama Web Search (hosted)
# ------------------------------------------------------------------
# Ollama's hosted search REST API (https://docs.ollama.com/capabilities/
# web-search). Not the local Ollama runtime — the search runs on
# ollama.com, authenticated with an API key from a (free) ollama.com
# account. Generous free tier, so it's a natural zero-cost upgrade over
# self-hosted SearXNG for instances that already lean on Ollama. The
# endpoint caps ``max_results`` at 10 per request, so we clamp.
_OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search"


async def _search_ollama(
    provider: SearchProvider, query: str, count: int
) -> list[SearchResult]:
    api_key = _api_key(provider)
    if not api_key:
        raise SearchError(
            "Ollama web search requires an API key from ollama.com"
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {"query": query, "max_results": max(1, min(count, 10))}

    resp = await _safe_request(
        "POST",
        _OLLAMA_SEARCH_URL,
        provider_label="Ollama",
        headers=headers,
        json=payload,
    )
    _check_status("Ollama", resp)

    try:
        data = resp.json()
    except ValueError as e:
        raise SearchError("Ollama returned non-JSON") from e

    out: list[SearchResult] = []
    for r in (data.get("results") or [])[:count]:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "").strip()
        if not url:
            continue
        out.append(
            SearchResult(
                title=str(r.get("title") or url).strip(),
                url=url,
                snippet=str(r.get("content") or "").strip(),
            )
        )
    return out


# ------------------------------------------------------------------
# Dispatcher
# ------------------------------------------------------------------
_ADAPTERS = {
    "searxng": _search_searxng,
    "brave": _search_brave,
    "tavily": _search_tavily,
    "google_pse": _search_google_pse,
    "openrouter": _search_openrouter,
    "ollama": _search_ollama,
}


async def tavily_extract(provider: SearchProvider, url: str) -> str | None:
    """Fetch a page's readable content via Tavily's Extract API.

    Direct ``fetch_url`` gets 403'd by DataDome/Cloudflare-protected
    sites (tesla.com, cars.com, most retailers). Tavily runs the fetch
    from its own infrastructure and hands back cleaned text, so it
    sails past the anti-bot walls a self-hosted crawler can't. Only
    meaningful for a ``tavily`` provider; returns ``None`` for any
    other type or when nothing usable comes back (caller then keeps
    whatever error it already had).

    Costs 1 Tavily credit per 5 URLs — negligible next to a whole
    turn's search spend, and only spent as a *fallback* after the free
    direct fetch already failed.
    """
    if provider.type != "tavily":
        return None
    api_key = _api_key(provider) or get_settings().TAVILY_API_KEY
    if not api_key:
        return None
    try:
        resp = await _safe_request(
            "POST",
            "https://api.tavily.com/extract",
            provider_label="Tavily",
            json={
                "api_key": api_key,
                "urls": [url],
                # Advanced depth renders more of the page (heavier JS,
                # tables) and gets past more anti-bot walls than basic.
                # Costs 2 credits/5 URLs vs 1 — worth it as a fallback
                # that only fires after the free direct fetch failed.
                "extract_depth": "advanced",
            },
        )
        if not resp.is_success:
            return None
        data = resp.json()
    except (SearchError, ValueError):
        return None
    results = data.get("results") if isinstance(data, dict) else None
    if not results:
        return None
    first = results[0] if isinstance(results, list) else None
    if not isinstance(first, dict):
        return None
    text = str(first.get("raw_content") or first.get("content") or "").strip()
    return text or None


_OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch"


async def ollama_web_fetch(provider: SearchProvider, url: str) -> str | None:
    """Fetch a page's readable content via Ollama's hosted web_fetch API.

    Same job as :func:`tavily_extract` — the fetch runs on ollama.com's
    infrastructure, so it can get past anti-bot walls that 403 a
    self-hosted crawler. Free tier (same ollama.com API key as the
    search adapter). Only meaningful for an ``ollama`` provider;
    returns ``None`` for any other type or when nothing usable comes
    back, so the caller keeps whatever error it already had.
    """
    if provider.type != "ollama":
        return None
    api_key = _api_key(provider)
    if not api_key:
        return None
    try:
        resp = await _safe_request(
            "POST",
            _OLLAMA_FETCH_URL,
            provider_label="Ollama",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"url": url},
        )
        if not resp.is_success:
            return None
        data = resp.json()
    except (SearchError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    text = str(data.get("content") or "").strip()
    return text or None


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
