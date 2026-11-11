"""AI search over notes (N2.1): finding a note by what it means, not only the
words in it ("wifi" finds the note about the router password).

Three people decide, in this order:

* **The admin**, for all of Promptly — Mail's rule (``mail/search.py``): left
  alone it's on when the indexing model runs on this network and off when it's
  a cloud service; turning it on for a cloud model is agreeing to that one
  provider, and it drops back to off if the indexer changes. Notes have their
  own switch, apart from Mail's: notes are more personal.
* **Each person**, for their own notes ("Find notes by meaning",
  ``user.settings.notes.ai_search``; on unless they turn it off). With a cloud
  indexer that's each person choosing whether their notes go there.
* **A shared note follows its owner**: the words are theirs. If the owner opted
  out, nobody finds it by meaning; words still work for everyone on it.

Every read joins ``notes`` through :func:`access.visible_predicate`, so a
stranger, a removed member or a trashed note never comes back. Nothing here
tells an admin anything about anyone's notes: :func:`counts` is two numbers.
"""
from __future__ import annotations

import logging
import time
import uuid

from sqlalchemy import Float, cast, literal, literal_column, select, table, text
from sqlalchemy import column as column_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import UserDefinedType

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.custom_models.embedding import SUPPORTED_DIMS, EmbedderUnavailable, embed_texts, normalise_for_embedding, vector_literal
from app.custom_models.embedding_gate import mark_background
from app.mail.search import Config, is_local
from app.models_config.models import ModelProvider

from . import access
from .models import Note

logger = logging.getLogger("promptly.notes.search")

BATCH = 32
TEXT_CHARS = 4000
# Further than this and it's not really about what you asked (Mail's figure;
# tune on real notes).
MAX_DISTANCE = 0.62
RELATED = 8
# Notes whose owner said no: their words are theirs to keep out.
_OPTED_OUT = "(SELECT u.id FROM users u WHERE (u.settings #>> '{notes,ai_search}') = 'false')"


async def config(db: AsyncSession) -> Config:
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        return Config(on=False)
    provider = await db.get(ModelProvider, settings.embedding_provider_id) if settings.embedding_provider_id else None
    dim = settings.embedding_dim or 0
    if provider is None or not settings.embedding_model_id or dim not in SUPPORTED_DIMS:
        return Config(on=False, choice=settings.notes_ai_search)
    local = is_local(provider)
    if local:
        on = settings.notes_ai_search is not False
    else:
        on = settings.notes_ai_search is True and settings.notes_ai_search_provider == provider.id
    return Config(on=on, choice=settings.notes_ai_search, local=local, provider=provider, model=settings.embedding_model_id, dim=dim, ready=True)


async def set_choice(db: AsyncSession, on: bool) -> Config:
    """The admin's switch. Turning it off removes every note vector at once."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        settings = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(settings)
        await db.flush()
    current = await config(db)
    settings.notes_ai_search = on
    settings.notes_ai_search_provider = current.provider.id if on and current.provider else None
    if not on:
        await db.execute(text("DELETE FROM note_vectors"))
    await db.commit()
    return await config(db)


async def counts(db: AsyncSession) -> tuple[int, int]:
    """How much of the server's notes are indexed: (indexed, total). Two
    numbers, nobody's notes."""
    row = (await db.execute(text(
        "SELECT count(*), count(v.note_id) FROM notes n LEFT JOIN note_vectors v ON v.note_id = n.id "
        "WHERE n.trashed_at IS NULL AND n.search_text <> ''"
    ))).one()
    return int(row[1]), int(row[0])


# ------------------------------------------------------------------ each person


def person_on(user: User) -> bool:
    """Your own "Find notes by meaning" (on unless you turned it off)."""
    notes = (user.settings or {}).get("notes")
    return not (isinstance(notes, dict) and notes.get("ai_search") is False)


async def set_person(db: AsyncSession, user: User, on: bool) -> None:
    """Turning it off takes your notes' vectors away now, not on the next run."""
    merged = dict(user.settings or {})
    notes = dict(merged.get("notes") or {}) if isinstance(merged.get("notes"), dict) else {}
    notes["ai_search"] = bool(on)
    merged["notes"] = notes
    user.settings = merged
    if not on:
        await db.execute(text("DELETE FROM note_vectors WHERE note_id IN (SELECT id FROM notes WHERE owner_id = :u)"), {"u": user.id})
    await db.commit()


async def forget(db: AsyncSession, note_ids: list[uuid.UUID]) -> None:
    """A note went to Trash: its vector goes with it."""
    if note_ids:
        await db.execute(text("DELETE FROM note_vectors WHERE note_id = ANY(:ids)"), {"ids": note_ids})


# ------------------------------------------------------------------ finding


async def nearest(db: AsyncSession, user: User | uuid.UUID, query: str, limit: int = 30, *, extra=None) -> list[uuid.UUID]:  # noqa: ANN001
    """The notes closest in meaning that ``user`` can open, nearest first.
    Empty when AI search is off or the model can't answer: word search still
    works. ``extra`` narrows it further (a SQLAlchemy condition on Note)."""
    uid = user.id if isinstance(user, User) else user
    if not query.strip():
        return []
    cfg = await config(db)
    if not cfg.on:
        return []
    try:
        vectors = await embed_texts(provider=cfg.provider, model_id=cfg.model, texts=[normalise_for_embedding(query[:500])], dimensions=cfg.dim, fast=True)
    except Exception as e:  # noqa: BLE001 — words alone still find things
        logger.info("Notes search without AI: %s", type(e).__name__)
        return []
    if not vectors:
        return []
    column = f"embedding_{cfg.dim}"
    nv = table("note_vectors", column_("note_id"), column_("model"))
    distance = literal_column(f"note_vectors.{column}").op("<=>", return_type=Float)(cast(literal(vector_literal(vectors[0])), _Vector()))
    stmt = (
        select(Note.id)
        .join(nv, nv.c.note_id == Note.id)
        .where(
            access.visible_predicate(uid),
            nv.c.model == cfg.model,
            literal_column(f"note_vectors.{column}").is_not(None),
            Note.owner_id.not_in(select(User.id).where(User.settings[("notes", "ai_search")].astext == "false")),
            distance < MAX_DISTANCE,
        )
        .order_by(distance)
        .limit(limit)
    )
    if extra is not None:
        stmt = stmt.where(extra)
    return list((await db.execute(stmt)).scalars())


class _Vector(UserDefinedType):
    """Just enough of pgvector's type for a CAST."""

    cache_ok = True

    def get_col_spec(self, **kw) -> str:  # noqa: ANN003
        return "vector"


# ------------------------------------------------------------------ indexing


def _as_text(title: str, body: str) -> str:
    return normalise_for_embedding(f"{title}\n{body}"[:TEXT_CHARS])


async def index_some(db: AsyncSession) -> int:
    """Embed the next few stale notes (no vector, another model, or changed
    words). How many it did."""
    cfg = await config(db)
    if not cfg.on:
        await db.execute(text("DELETE FROM note_vectors"))
        await db.commit()
        return 0
    # Another model's vectors can't be compared with this one's; trashed
    # notes, emptied ones and opted-out owners' don't belong here.
    await db.execute(text("DELETE FROM note_vectors WHERE model <> :m"), {"m": cfg.model})
    await db.execute(text(
        "DELETE FROM note_vectors v USING notes n WHERE n.id = v.note_id "
        f"AND (n.trashed_at IS NOT NULL OR n.search_text = '' OR n.owner_id IN {_OPTED_OUT})"
    ))
    rows = (await db.execute(text(
        "SELECT n.id, n.title, n.search_text, md5(n.search_text) FROM notes n "
        "LEFT JOIN note_vectors v ON v.note_id = n.id "
        f"WHERE n.trashed_at IS NULL AND n.search_text <> '' AND n.owner_id NOT IN {_OPTED_OUT} "
        "AND (v.note_id IS NULL OR v.text_hash <> md5(n.search_text)) "
        "ORDER BY n.updated_at DESC LIMIT :n"
    ), {"n": BATCH})).all()
    if not rows:
        await db.commit()
        return 0
    # search_text starts with the title; embedding it once is enough.
    found = await embed_texts(
        provider=cfg.provider, model_id=cfg.model, texts=[normalise_for_embedding(r[2][:TEXT_CHARS]) for r in rows], dimensions=cfg.dim,
    )
    column = f"embedding_{cfg.dim}"
    others = ", ".join(f"embedding_{d} = NULL" for d in sorted(SUPPORTED_DIMS) if d != cfg.dim)
    for r, vector in zip(rows, found, strict=True):
        await db.execute(text(
            f"INSERT INTO note_vectors (note_id, model, text_hash, updated_at, {column}) "
            "VALUES (:id, :model, :h, now(), CAST(:v AS vector)) "
            f"ON CONFLICT (note_id) DO UPDATE SET model = EXCLUDED.model, text_hash = EXCLUDED.text_hash, "
            f"updated_at = now(), {others + ', ' if others else ''}{column} = EXCLUDED.{column}"
        ), {"id": r[0], "model": cfg.model, "h": r[3], "v": vector_literal(vector)})
    await db.commit()
    return len(rows)


async def index_tick(budget_s: float = 50.0) -> int:
    """The arq cron, every minute: batches until nothing is stale or the
    budget is spent. Background work: never holds up a person's search."""
    from app.database import SessionLocal

    mark_background()
    done = 0
    start = time.monotonic()
    while time.monotonic() - start < budget_s:
        try:
            async with SessionLocal() as db:
                n = await index_some(db)
        except EmbedderUnavailable:
            break
        except Exception as e:  # noqa: BLE001 — next minute tries again; notes keep working
            logger.warning("Notes indexing failed: %s", type(e).__name__)
            break
        done += n
        if n < BATCH:
            break
    return done


__all__ = ["MAX_DISTANCE", "RELATED", "config", "counts", "forget", "index_some", "index_tick", "nearest", "person_on", "set_choice", "set_person"]
