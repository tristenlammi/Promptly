"""``fetch_url`` — pull main-content text from a single URL.

Phase D1 companion to :class:`WebSearchTool`. The model uses this when
a search result snippet looks promising but isn't enough to answer the
question — it asks the host to fetch the page, strip boilerplate, and
hand back the readable body. ``trafilatura`` does the heavy lifting
(extracts main content, drops nav / ads / scripts); we wrap it in
``safe_fetch`` so an attacker can't pivot a chat session into an SSRF
probe by asking the AI to "go look at http://localhost:6379".

Output shape:

* ``content``  — the model-facing string: title, URL, and the cleaned
  body capped at ~6 000 characters (about 1 500 tokens). Above that we
  truncate with a ``... [truncated]`` marker so the model knows it
  can't see the rest.
* ``sources`` — a single citation row using the page's ``<title>`` and
  the *final* URL (post-redirect) so the inline ``[n]`` chip points
  the user at what was actually read, not what was requested.
* ``meta``    — the URL, original character count, truncation flag, and
  the ``links`` list (in-content outbound links) surfaced on the chip.

In-content links are appended to ``content`` and returned in ``meta`` so
the model can follow a citation chain — read the page, then fetch a
source it links to — which is what makes multi-hop research feel agentic
rather than one-shot. Every followed link is re-checked by ``safe_fetch``.

Per-turn cap: 6 fetches — enough for a search → fetch → follow → follow
chain. Same rationale as ``web_search``; beyond that the model is usually
stuck in a loop.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from sqlalchemy import select

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.chat.tools.validation import clean_model_text
from app.net.safe_fetch import (
    DEFAULT_MAX_BYTES,
    ResponseTooLargeError,
    UnsafeURLError,
    safe_fetch,
)
from app.search.models import SearchProvider
from app.search.providers import tavily_extract

logger = logging.getLogger("promptly.tools.fetch_url")

# Cap the extracted text so a 50 KB article doesn't wipe out the
# remaining context budget. ~6 000 chars is roughly 1 500 tokens,
# which leaves plenty of room for follow-up reasoning.
_MAX_TEXT_CHARS = 6_000
# Hard byte cap on the raw HTML download (smaller than safe_fetch's
# default to keep our quota tighter on a frequently-used tool).
_MAX_HTML_BYTES = 1_500_000  # 1.5 MB
# How long we'll wait on a single page before giving up. Pages that
# slow ought to be summarised by the model from the search snippet
# rather than blocking the chat reply.
_TIMEOUT_SECONDS = 12.0

# Used as a fallback "title" when trafilatura can't get one and the
# HTML doesn't have a parseable <title>.
_DEFAULT_TITLE = "(untitled page)"

# Quick & dirty <title> sniff for the fallback path. trafilatura
# extracts this cleanly when it works; this regex only runs if it
# didn't and we need *something* on the citation chip.
_TITLE_RE = re.compile(
    r"<title[^>]*>\s*(.*?)\s*</title>", re.IGNORECASE | re.DOTALL
)


def _extract_with_trafilatura(
    html: str, url: str
) -> tuple[str, str | None, list[dict[str, str]]]:
    """Run trafilatura's main-content extractor in a worker thread.

    Returns ``(text, title, links)``. ``trafilatura.extract`` is CPU-bound
    (HTML parsing), so callers ``await asyncio.to_thread`` this to keep the
    event loop responsive on big pages.

    ``links`` are in-content outbound links discovered during a second
    extraction pass (main content only — nav / ads / boilerplate already
    stripped). Surfacing them lets the model follow a citation chain
    ("read the linked spec / source") by calling ``fetch_url`` again,
    which is what turns a one-hop fetch into agentic browsing.
    """
    # Imported lazily so a missing wheel surfaces only when the tool
    # is actually invoked, not at module import time. Should never
    # fire in production (the dep is in requirements.txt) but keeps
    # the rest of the chat router importable in dev environments
    # that haven't run pip install yet.
    import trafilatura  # type: ignore[import-not-found]

    text = trafilatura.extract(
        html,
        url=url,
        include_comments=False,
        include_tables=True,
        favor_recall=False,
        no_fallback=False,
    ) or ""

    title: str | None = None
    try:
        meta = trafilatura.extract_metadata(html)
    except Exception:  # noqa: BLE001 — trafilatura's metadata path can throw
        meta = None
    if meta is not None:
        title = (getattr(meta, "title", None) or "").strip() or None

    # Second pass keeping links, rendered as Markdown so anchor text +
    # href come back as [text](url). Best-effort: if this trafilatura
    # version rejects the kwargs, we simply surface no links.
    links: list[dict[str, str]] = []
    try:
        md = trafilatura.extract(
            html,
            url=url,
            include_links=True,
            output_format="markdown",
            include_comments=False,
            include_tables=False,
            favor_recall=False,
            no_fallback=False,
        ) or ""
        for m in re.finditer(r"\[([^\]]{1,120})\]\((https?://[^\s)]+)\)", md):
            anchor = re.sub(r"\s+", " ", m.group(1)).strip()
            href = m.group(2).strip()
            if href:
                links.append({"title": anchor, "url": href})
    except Exception:  # noqa: BLE001 — link pass is best-effort
        links = []

    return text, title, links


# --- In-content link surfacing (agentic "follow the source") -----------------
# How many discovered links to hand back. Enough to give the model real
# choice of where to dig next without bloating the tool result.
_LINK_LIMIT = 10
# Social / auth / commerce endpoints are never worth following as a source.
_LINK_SKIP_HOSTS = frozenset({
    "facebook.com", "twitter.com", "x.com", "linkedin.com", "instagram.com",
    "youtube.com", "youtu.be", "pinterest.com", "reddit.com", "t.co",
    "tiktok.com", "threads.net", "whatsapp.com",
})
_LINK_SKIP_SUBSTR = (
    "/login", "/signin", "/sign-in", "/register", "/signup", "/sign-up",
    "/subscribe", "/cart", "/checkout", "/privacy", "/terms", "/cookie",
)


def _norm_link(u: str) -> str:
    """Drop the fragment + a trailing slash so a followed link matches the
    dispatcher's cross-hop dedup cache key on the model's next fetch_url."""
    u = u.split("#", 1)[0].strip()
    if len(u) > 1 and u.endswith("/"):
        u = u[:-1]
    return u


def _filter_discovered_links(
    links: list[dict[str, str]], page_url: str, request_url: str
) -> list[dict[str, str]]:
    """Clean, de-junk, and dedupe the harvested links, bounded to _LINK_LIMIT.

    Drops the page's own URL, non-http(s) links, obvious social/auth/commerce
    endpoints, and duplicates (first occurrence wins so the ordering the model
    sees is stable).
    """
    from urllib.parse import urlparse

    seen: set[str] = {_norm_link(page_url), _norm_link(request_url)}
    out: list[dict[str, str]] = []
    for link in links:
        url = _norm_link(str(link.get("url") or ""))
        if not url.lower().startswith(("http://", "https://")):
            continue
        if url in seen:
            continue
        low = url.lower()
        try:
            host = (urlparse(url).hostname or "").lower()
        except Exception:  # noqa: BLE001 — malformed URL
            continue
        if host.startswith("www."):
            host = host[4:]
        if host in _LINK_SKIP_HOSTS:
            continue
        if any(s in low for s in _LINK_SKIP_SUBSTR):
            continue
        seen.add(url)
        title = (str(link.get("title") or "")).strip()[:120] or url
        out.append({"title": title, "url": url})
        if len(out) >= _LINK_LIMIT:
            break
    return out


def _fallback_title(html: str) -> str:
    m = _TITLE_RE.search(html)
    if not m:
        return _DEFAULT_TITLE
    raw = re.sub(r"\s+", " ", m.group(1)).strip()
    return raw[:200] or _DEFAULT_TITLE


def _title_from_url(url: str) -> str:
    """Cheap human-ish title from a URL's last path segment, used when a
    Tavily-extracted page has no HTML ``<title>`` of its own."""
    try:
        from urllib.parse import urlparse

        parts = [p for p in urlparse(url).path.split("/") if p]
        if parts:
            slug = parts[-1].rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
            if slug:
                return slug[:120]
        return urlparse(url).hostname or _DEFAULT_TITLE
    except Exception:  # noqa: BLE001
        return _DEFAULT_TITLE


async def _tavily_provider(ctx: ToolContext) -> SearchProvider | None:
    """Any enabled Tavily provider visible to the user, for Extract fallback."""
    rows = (
        (
            await ctx.db.execute(
                select(SearchProvider).where(
                    (
                        (SearchProvider.user_id == ctx.user.id)
                        | (SearchProvider.user_id.is_(None))
                    )
                    & (SearchProvider.enabled.is_(True))
                    & (SearchProvider.type == "tavily")
                )
            )
        )
        .scalars()
        .all()
    )
    return rows[0] if rows else None


class FetchUrlTool(Tool):
    name = "fetch_url"
    category = "search"
    description = (
        "Fetch a public web page and return its readable main-content "
        "text (boilerplate, nav, ads, and scripts stripped). Use this "
        "as a follow-up to `web_search` when a snippet looks like the "
        "right page but you need the full article to answer accurately. "
        "Refuses non-public addresses (localhost, RFC1918, etc.) and "
        "caps the page size — if you get back a truncation marker, the "
        "rest of the page is unavailable, do not invent it. Returns the "
        "URL as a citation row so the chip stays in sync with `web_search`, "
        "and lists other links found on the page — call `fetch_url` again on "
        "one of those to follow a source deeper when the page cites or links "
        "the detail you actually need."
    )
    prompt_hint = (
        "Read a single web page and get its cleaned-up main text back. "
        "Best paired with `web_search` — search first, fetch only the "
        "URL(s) you actually need to read in full."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": (
                    "The fully-qualified http(s) URL to fetch. Must be "
                    "a public address — internal / loopback URLs are "
                    "refused."
                ),
                "format": "uri",
                "maxLength": 2048,
            },
        },
        "required": ["url"],
        "additionalProperties": False,
    }
    # Raised from 4 to 6 to accommodate a citation chain: search → fetch →
    # follow a discovered link → follow again. Each fetch is still SSRF-
    # guarded and size-capped, so the extra budget only costs latency/quota.
    max_per_turn = 6
    # The fetch itself is capped at 12s; the margin covers redirects
    # plus trafilatura extraction on a large page.
    timeout_seconds = 30.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        url = args.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ToolError("`url` is required and must be a string")
        url = url.strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ToolError("`url` must be an http(s) URL")

        # --- Attempt 1: direct fetch + local extraction (free). ---
        # ``block_reason`` is set when the direct path fails in a way
        # Tavily Extract might get past (anti-bot 4xx, empty body/text).
        # It stays None on a clean success. SSRF refusals never set it —
        # bypassing the guard via a third party would defeat it.
        text: str | None = None
        title: str | None = None
        final_url = url
        block_reason: str | None = None
        via_tavily = False
        discovered_links: list[dict[str, str]] = []

        try:
            response = await safe_fetch(
                "GET",
                url,
                timeout_seconds=_TIMEOUT_SECONDS,
                max_bytes=min(_MAX_HTML_BYTES, DEFAULT_MAX_BYTES),
                headers={
                    # Some sites return a different (often empty) body
                    # for unknown UAs. Pretend to be a generic browser
                    # so we get the same HTML the user would see.
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; PromptlyBot/1.0; "
                        "+https://github.com/anthropics) "
                        "fetch_url chat tool"
                    ),
                    "Accept": (
                        "text/html,application/xhtml+xml,application/xml;"
                        "q=0.9,*/*;q=0.8"
                    ),
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
        except UnsafeURLError as e:
            # Intentional block — do NOT fall back to a third-party
            # fetcher, that would defeat the SSRF guard.
            raise ToolError(
                f"Refusing to fetch {url!r}: {e.reason}. URL must be a "
                "public http(s) address."
            ) from e
        except ResponseTooLargeError:
            block_reason = (
                f"Page is too large to fetch directly (>{_MAX_HTML_BYTES // 1024} KB)."
            )
            response = None
        except Exception as e:  # noqa: BLE001 — network / parse errors
            block_reason = f"Fetch failed: {type(e).__name__}: {e}"
            response = None

        if response is not None:
            if not response.is_success:
                block_reason = (
                    f"HTTP {response.status_code} — the page is unreachable "
                    "or blocking automated requests."
                )
            else:
                final_url = str(response.url)
                try:
                    html = response.text
                except Exception:  # noqa: BLE001 — broken encoding etc.
                    html = ""
                if html:
                    text, title, discovered_links = await asyncio.to_thread(
                        _extract_with_trafilatura, html, final_url
                    )
                    if not title:
                        title = _fallback_title(html)
                    if not (text and text.strip()):
                        block_reason = "no readable text extracted"
                        text = None
                else:
                    block_reason = "empty body"

        # --- Attempt 2: Tavily Extract fallback (1 credit / 5 URLs). ---
        # Only when the direct path was blocked/empty AND a Tavily
        # provider is configured. This is what makes tesla.com /
        # cars.com etc. — which 403 a self-hosted crawler — actually
        # readable, because Tavily fetches from its own infra.
        if (text is None or not text.strip()) and block_reason is not None:
            provider = await _tavily_provider(ctx)
            if provider is not None:
                extracted = await tavily_extract(provider, url)
                if extracted and extracted.strip():
                    text = extracted
                    title = _title_from_url(url)
                    final_url = url
                    via_tavily = True
                    logger.info(
                        "fetch_url: direct path blocked (%s); recovered via "
                        "Tavily Extract for %s",
                        block_reason,
                        url[:120],
                    )

        if text is None or not text.strip():
            # Both paths failed. Surface the original block reason so the
            # model knows it's a dead page, not a transient hiccup.
            raise ToolError(
                f"Couldn't read {url!r} ({block_reason or 'no content'}). "
                "The page is likely JavaScript-rendered, paywalled, or "
                "hard-blocking automated access — answer from the search "
                "snippet instead of retrying this URL."
            )

        # Page text is adversarial input: strip control characters and
        # the zero-width / bidi-override code points that can hide
        # instructions inside otherwise innocent-looking prose before
        # it's handed to the model or persisted as a citation.
        text = clean_model_text(text)
        title = clean_model_text(title or "").strip() or _title_from_url(final_url)

        original_chars = len(text)
        truncated = original_chars > _MAX_TEXT_CHARS
        if truncated:
            text = text[:_MAX_TEXT_CHARS].rstrip() + "\n\n... [truncated]"

        body = (
            f"Title: {title}\n"
            f"URL: {final_url}\n"
            "----\n"
            f"{text}"
        )

        # Surface in-content links so the model can follow a source deeper
        # (a fresh fetch_url call). Each is still re-guarded by safe_fetch,
        # so this only widens *choice*, not trust.
        followable = _filter_discovered_links(discovered_links, final_url, url)
        if followable:
            link_lines = "\n".join(
                f"[L{i}] {link['title']} — {link['url']}"
                for i, link in enumerate(followable, start=1)
            )
            body = (
                f"{body}\n\n----\n"
                "Links found on this page (call fetch_url on any you want to "
                f"read next):\n{link_lines}"
            )

        snippet = re.sub(r"\s+", " ", text[:240]).strip()

        logger.info(
            "fetch_url ok user=%s url=%s chars=%d truncated=%s via_tavily=%s",
            ctx.user.id,
            final_url[:120],
            original_chars,
            truncated,
            via_tavily,
        )

        return ToolResult(
            content=body,
            sources=[{"title": title, "url": final_url, "snippet": snippet}],
            meta={
                "url": final_url,
                "title": title,
                "original_chars": original_chars,
                "truncated": truncated,
                "via_tavily": via_tavily,
                "links": followable,
            },
        )


__all__ = ["FetchUrlTool"]
