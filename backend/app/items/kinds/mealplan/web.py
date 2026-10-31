"""Recipe import over the web, and the kind's own endpoints
(``/api/items/k/mealplan/…``):

  ``POST /import``  ``{url}`` or ``{text}`` → ``{recipe}`` (a draft, not saved)
  ``POST /parse``   ``{lines}`` → ``{ingredients}`` (the editor's save path)

Pages are fetched server-side through :func:`app.net.safe_fetch.safe_fetch`
(SSRF-safe: public addresses only, every redirect re-checked, size and
time capped)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.deps import get_current_user
from app.auth.models import User
from app.items.kinds.mealplan import parse

logger = logging.getLogger("promptly.items.mealplan")

MAX_PAGE_BYTES = 6 * 1024 * 1024
TIMEOUT_S = 12.0
_HEADERS = {
    # Plenty of recipe sites refuse an unnamed client.
    "User-Agent": "Mozilla/5.0 (compatible; PromptlyRecipeImport/1.0; +https://github.com/promptly)",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "en;q=0.9,*;q=0.5",
}


class ImportFailed(Exception):
    """A message for the person."""


async def fetch_page(url: str) -> str:
    from app.net.safe_fetch import ResponseTooLargeError, UnsafeURLError, safe_fetch

    u = (url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        u = "https://" + u
    try:
        res = await safe_fetch("GET", u, timeout_seconds=TIMEOUT_S, max_bytes=MAX_PAGE_BYTES, headers=_HEADERS)
    except UnsafeURLError as e:
        raise ImportFailed("That address can't be fetched (it isn't a public web page).") from e
    except ResponseTooLargeError as e:
        raise ImportFailed("That page is too big to import.") from e
    except Exception as e:  # noqa: BLE001 — timeouts, TLS, DNS…
        logger.info("recipe fetch failed for %s: %r", u, e)
        raise ImportFailed("Couldn't reach that page. Check the link, or paste the recipe text instead.") from e
    if res.status_code >= 400:
        raise ImportFailed(f"The site answered {res.status_code}. Some sites block imports — paste the recipe text instead.")
    try:
        return res.text
    except Exception:  # noqa: BLE001
        return res.content.decode("utf-8", "replace")


async def fetch_recipe(url: str) -> dict:
    """The recipe on ``url`` as a draft (raises :class:`ImportFailed`)."""
    page = await fetch_page(url)
    draft = parse.recipe_from_html(page, url.strip())
    if draft is None:
        title = parse.page_title(page)
        raise ImportFailed(
            f"No recipe data found on {('“' + title + '”') if title else 'that page'}. "
            "Paste the recipe text instead, or ask the assistant to read the page."
        )
    if not draft.get("source_url"):
        draft["source_url"] = url.strip()[:1000]
    return draft


router = APIRouter()


class ImportIn(BaseModel):
    url: str | None = Field(None, max_length=2000)
    text: str | None = Field(None, max_length=60_000)


@router.post("/import")
async def import_recipe(payload: ImportIn, user: User = Depends(get_current_user)) -> dict:
    if payload.url and payload.url.strip():
        try:
            return {"recipe": await fetch_recipe(payload.url), "source": "web"}
        except ImportFailed as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    if payload.text and payload.text.strip():
        draft = parse.recipe_from_text(payload.text)
        if not draft["ingredients"] and not draft["steps"]:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Couldn't find ingredients or steps in that text.")
        return {"recipe": draft, "source": "text"}
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Give a link or paste the recipe text.")


class ParseIn(BaseModel):
    lines: list[str] = Field(default_factory=list, max_length=200)


@router.post("/parse")
async def parse_lines(payload: ParseIn, user: User = Depends(get_current_user)) -> dict:
    lines = [line[:500] for line in payload.lines]
    return {"ingredients": parse.parse_ingredient_lines(lines)}
