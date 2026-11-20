"""The source pack a subject is taught from.

Two places only: the web (when the learner left "research the web" on), and
the learner's **own** files and notes that they attached. Nothing else is
read — never Rooms or Porch, never anything shared by someone else.

Web pages are other people's words: they are stored as excerpts and only
ever shown to the model as data (``app.study.ai.sources_block``).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.study")

MAX_WEB = 6
MAX_FILES = 5
MAX_NOTES = 10
WEB_EXCERPT = 3500
OWN_EXCERPT = 12000
PAGE_TIMEOUT_S = 10.0
PAGE_BYTES = 3 * 1024 * 1024


@dataclass
class Found:
    kind: str  # web | file | note
    title: str
    excerpt: str
    url: str | None = None
    file_id: uuid.UUID | None = None
    note_id: uuid.UUID | None = None


def queries_for(title: str, goal: str, level: str) -> list[str]:
    t = " ".join(title.split())[:120]
    who = {"child": " for kids", "teen": " for students"}.get(level, "")
    qs = [f"{t} explained{who}", f"{t} key concepts fundamentals", f"{t} common misconceptions mistakes"]
    g = " ".join((goal or "").split())[:80]
    if g:
        qs.append(f"{t} {g}")
    return qs


async def own_files(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[Any]:
    """The learner's own, untrashed files among ``ids`` (others are dropped silently)."""
    from app.files.models import UserFile

    if not ids:
        return []
    rows = (await db.execute(select(UserFile).where(UserFile.id.in_(ids[:MAX_FILES]), UserFile.user_id == user.id, UserFile.trashed_at.is_(None)))).scalars().all()
    return list(rows)


async def own_notes(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[Any]:
    from app.notes.models import Note

    if not ids:
        return []
    rows = (await db.execute(select(Note).where(Note.id.in_(ids[:MAX_NOTES]), Note.owner_id == user.id, Note.trashed_at.is_(None)))).scalars().all()
    return list(rows)


async def read_own(db: AsyncSession, user: User, attached: dict[str, Any]) -> list[Found]:
    from app.files.drive_index import file_text_for

    def ids(key: str) -> list[uuid.UUID]:
        out = []
        for x in attached.get(key) or []:
            try:
                out.append(uuid.UUID(str(x)))
            except ValueError:
                pass
        return out

    found: list[Found] = []
    for f in await own_files(db, user, ids("file_ids")):
        try:
            text = (await file_text_for(db, f)) or ""
        except Exception:  # noqa: BLE001 — an unreadable file is skipped
            logger.info("study: couldn't read an attached file", exc_info=True)
            text = ""
        if text.strip():
            found.append(Found("file", (f.filename or "File")[:300], text.strip()[:OWN_EXCERPT], file_id=f.id))
    for n in await own_notes(db, user, ids("note_ids")):
        text = (n.search_text or n.body_text or "").strip()
        if text:
            found.append(Found("note", (n.title or "Note")[:300], text[:OWN_EXCERPT], note_id=n.id))
    return found


async def fetch_text(url: str) -> str:
    """A public page's readable text ("" when it can't be had). SSRF-safe."""
    from app.net.safe_fetch import safe_fetch

    try:
        res = await safe_fetch(
            "GET", url, timeout_seconds=PAGE_TIMEOUT_S, max_bytes=PAGE_BYTES,
            headers={"User-Agent": "Mozilla/5.0 (compatible; PromptlyStudy/1.0)", "Accept": "text/html,*/*;q=0.5"},
        )
        if res.status_code >= 400 or "html" not in (res.headers.get("content-type") or "html"):
            return ""
        html = res.text
    except Exception:  # noqa: BLE001 — blocked, slow, too big, not public
        return ""

    def extract() -> str:
        try:
            import trafilatura

            return trafilatura.extract(html, include_comments=False, include_tables=False) or ""
        except Exception:  # noqa: BLE001
            return ""

    return (await asyncio.to_thread(extract)).strip()


async def search(db: AsyncSession, user: User, query: str) -> list[Any]:
    from app.search.service import run_search_with_failover

    try:
        results, _used = await run_search_with_failover(db, user, query, count=5, budget_s=20)
        return list(results)
    except Exception:  # noqa: BLE001 — no provider, all failed
        logger.info("study: web search failed", exc_info=True)
        return []


async def read_web(db: AsyncSession, user: User, title: str, goal: str, level: str) -> list[Found]:
    """Up to MAX_WEB pages about the subject, best-ranked first across the queries."""
    seen: set[str] = set()
    ranked: list[Any] = []
    per_query = [await search(db, user, q) for q in queries_for(title, goal, level)]
    for rank in range(5):
        for results in per_query:
            if rank < len(results):
                r = results[rank]
                u = (r.url or "").split("#")[0]
                if u and u not in seen:
                    seen.add(u)
                    ranked.append(r)
    picked = ranked[: MAX_WEB + 3]
    texts = await asyncio.gather(*(fetch_text(r.url) for r in picked))
    found: list[Found] = []
    for r, text in zip(picked, texts):
        body = text if len(text) >= 400 else (r.snippet or "")
        if len(body) < 80:
            continue
        found.append(Found("web", (r.title or r.url)[:300], body[:WEB_EXCERPT], url=r.url[:2000]))
        if len(found) >= MAX_WEB:
            break
    return found
