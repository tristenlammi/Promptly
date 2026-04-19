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
* ``meta``    — the URL, original character count, and truncation
  flag, surfaced on the chip for transparency.

Per-turn cap: 4 fetches. Same rationale as ``web_search`` — three
"search → fetch → re-search" cycles is plenty; more usually means the
model is stuck in a loop.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.net.safe_fetch import (
    DEFAULT_MAX_BYTES,
    ResponseTooLargeError,
    UnsafeURLError,
    safe_fetch,
)

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


def _extract_with_trafilatura(html: str, url: str) -> tuple[str, str | None]:
    """Run trafilatura's main-content extractor in a worker thread.

    Returns ``(text, title)``. ``trafilatura.extract`` is CPU-bound
    (HTML parsing), so callers ``await asyncio.to_thread`` this to
    keep the event loop responsive on big pages.
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

    return text, title


def _fallback_title(html: str) -> str:
    m = _TITLE_RE.search(html)
    if not m:
        return _DEFAULT_TITLE
    raw = re.sub(r"\s+", " ", m.group(1)).strip()
    return raw[:200] or _DEFAULT_TITLE


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
        "URL as a citation row so the chip stays in sync with `web_search`."
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
    max_per_turn = 4

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        url = args.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ToolError("`url` is required and must be a string")
        url = url.strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ToolError("`url` must be an http(s) URL")

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
            raise ToolError(
                f"Refusing to fetch {url!r}: {e.reason}. URL must be a "
                "public http(s) address."
            ) from e
        except ResponseTooLargeError as e:
            raise ToolError(
                f"Page is too large to fetch (>{_MAX_HTML_BYTES // 1024} KB). "
                "Try a more specific URL or summarise from the search snippet."
            ) from e
        except Exception as e:  # noqa: BLE001 — network / parse errors
            raise ToolError(f"Fetch failed: {type(e).__name__}: {e}") from e

        if not response.is_success:
            raise ToolError(
                f"Fetch returned HTTP {response.status_code} for {url!r}. "
                "The page is unreachable or blocking automated requests."
            )

        # Use the *final* URL (after redirects) for the citation so the
        # user sees what was actually read, not what was requested.
        final_url = str(response.url)
        try:
            html = response.text
        except Exception as e:  # noqa: BLE001 — broken encoding etc.
            raise ToolError(
                f"Couldn't decode page body ({type(e).__name__})."
            ) from e

        if not html:
            raise ToolError(
                f"Fetch returned an empty body for {url!r}."
            )

        text, title = await asyncio.to_thread(
            _extract_with_trafilatura, html, final_url
        )
        if not title:
            title = _fallback_title(html)

        original_chars = len(text)
        truncated = original_chars > _MAX_TEXT_CHARS
        if truncated:
            text = text[:_MAX_TEXT_CHARS].rstrip() + "\n\n... [truncated]"

        if not text.strip():
            raise ToolError(
                f"Couldn't extract readable text from {url!r}. The page "
                "may be JavaScript-rendered or behind a paywall — tell "
                "the user and stop."
            )

        body = (
            f"Title: {title}\n"
            f"URL: {final_url}\n"
            "----\n"
            f"{text}"
        )

        snippet = re.sub(r"\s+", " ", text[:240]).strip()

        logger.info(
            "fetch_url ok user=%s url=%s chars=%d truncated=%s",
            ctx.user.id,
            final_url[:120],
            original_chars,
            truncated,
        )

        return ToolResult(
            content=body,
            sources=[{"title": title, "url": final_url, "snippet": snippet}],
            meta={
                "url": final_url,
                "title": title,
                "original_chars": original_chars,
                "truncated": truncated,
            },
        )


__all__ = ["FetchUrlTool"]
