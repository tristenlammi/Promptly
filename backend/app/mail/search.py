"""AI search: finding mail by what it means, not only the words in it.

The admin decides for all of Promptly. Left alone, it's on when the indexing model
runs on this network and off when it's a cloud service, because then every email
goes to that service. Turning it on for a cloud model is agreeing to that one
provider: if the indexer later changes, it goes back off until the admin says so.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.custom_models.embedding import SUPPORTED_DIMS, EmbedderUnavailable, embed_texts, normalise_for_embedding, vector_literal
from app.custom_models.embedding_gate import mark_background
from app.database import SessionLocal
from app.models_config.models import ModelProvider

from .models import MailFolder, MailMessage

logger = logging.getLogger("promptly.mail.search")

BATCH = 16
IDLE_S = 30
BACKOFF_S = 60
BODY_CHARS = 4000
# Further than this and it's not really about what you asked.
MAX_DISTANCE = 0.62
NEVER_INDEXED = ("trash", "spam", "drafts")


def is_local(provider: ModelProvider) -> bool:
    """On this network, so mail never leaves it? When unsure, no."""
    if provider.type == "ollama" and not provider.base_url:
        return True
    host = (urlparse(provider.base_url or "").hostname or "").lower()
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # "ollama" is a container here; a name with a dot is only local if it says so.
        return "." not in host or host.endswith((".local", ".lan", ".internal", ".localhost", ".home.arpa"))
    return address.is_private or address.is_loopback


@dataclass
class Config:
    on: bool
    choice: bool | None = None
    local: bool = False
    provider: ModelProvider | None = None
    model: str = ""
    dim: int = 0
    # Set up, so the switch does something.
    ready: bool = False


async def config(db: AsyncSession) -> Config:
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        return Config(on=False)
    provider = await db.get(ModelProvider, settings.embedding_provider_id) if settings.embedding_provider_id else None
    dim = settings.embedding_dim or 0
    if provider is None or not settings.embedding_model_id or dim not in SUPPORTED_DIMS:
        return Config(on=False, choice=settings.mail_ai_search)
    local = is_local(provider)
    if local:
        on = settings.mail_ai_search is not False
    else:
        on = settings.mail_ai_search is True and settings.mail_ai_search_provider == provider.id
    return Config(on=on, choice=settings.mail_ai_search, local=local, provider=provider, model=settings.embedding_model_id, dim=dim, ready=True)


async def set_choice(db: AsyncSession, on: bool) -> Config:
    """Turning it off removes what was made for it straight away."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    current = await config(db)
    settings.mail_ai_search = on
    settings.mail_ai_search_provider = current.provider.id if on and current.provider else None
    if not on:
        await db.execute(text("DELETE FROM mail_vectors"))
    await db.commit()
    return await config(db)


async def counts(db: AsyncSession) -> tuple[int, int]:
    """How much of the mail on this server is indexed. No one's mail, just numbers."""
    row = (await db.execute(text(
        "SELECT count(*) FILTER (WHERE f.role <> ALL(:never)), count(v.message_id) FROM mail_messages m "
        "JOIN mail_folders f ON f.id = m.folder_id LEFT JOIN mail_vectors v ON v.message_id = m.id"
    ), {"never": list(NEVER_INDEXED)})).one()
    return int(row[1]), int(row[0])


def _as_text(m: MailMessage) -> str:
    return normalise_for_embedding(f"From: {m.from_name} {m.from_addr}\nSubject: {m.subject}\n\n{m.body_text[:BODY_CHARS]}")


async def nearest(db: AsyncSession, accounts: list[uuid.UUID], query: str, limit: int = 30) -> list[uuid.UUID]:
    """The emails closest in meaning, in these mailboxes only. Empty if AI search is
    off or the model can't answer: the search still works, on words alone."""
    if not accounts or not query.strip():
        return []
    cfg = await config(db)
    if not cfg.on:
        return []
    try:
        vectors = await embed_texts(provider=cfg.provider, model_id=cfg.model, texts=[query], dimensions=cfg.dim, fast=True)
    except Exception as e:  # noqa: BLE001 — words alone still find things
        logger.info("Mail search without AI: %s", type(e).__name__)
        return []
    if not vectors:
        return []
    column = f"embedding_{cfg.dim}"
    rows = await db.execute(text(
        f"SELECT message_id FROM mail_vectors WHERE account_id = ANY(:ids) AND model = :model AND {column} IS NOT NULL "
        f"AND {column} <=> CAST(:q AS vector) < :far ORDER BY {column} <=> CAST(:q AS vector) LIMIT :n"
    ), {"ids": accounts, "model": cfg.model, "q": vector_literal(vectors[0]), "far": MAX_DISTANCE, "n": limit})
    return [r[0] for r in rows]


async def index_some(db: AsyncSession) -> int:
    """Index the next few emails, newest first. How many it did."""
    cfg = await config(db)
    if not cfg.on:
        await db.execute(text("DELETE FROM mail_vectors"))
        await db.commit()
        return 0
    # A different model's vectors can't be compared with this one's.
    await db.execute(text("DELETE FROM mail_vectors WHERE model <> :m"), {"m": cfg.model})
    rows = (await db.execute(
        select(MailMessage).join(MailFolder, MailFolder.id == MailMessage.folder_id)
        .where(MailFolder.role.not_in(NEVER_INDEXED), MailMessage.id.not_in(select(text("message_id FROM mail_vectors"))))
        .order_by(MailMessage.sent_at.desc()).limit(BATCH)
    )).scalars().all()
    if not rows:
        await db.commit()
        return 0
    found = await embed_texts(provider=cfg.provider, model_id=cfg.model, texts=[_as_text(m) for m in rows], dimensions=cfg.dim)
    column = f"embedding_{cfg.dim}"
    for m, vector in zip(rows, found, strict=True):
        await db.execute(text(
            f"INSERT INTO mail_vectors (message_id, account_id, model, {column}) VALUES (:id, :account, :model, CAST(:v AS vector)) "
            f"ON CONFLICT (message_id) DO NOTHING"
        ), {"id": m.id, "account": m.account_id, "model": cfg.model, "v": vector_literal(vector)})
    await db.commit()
    return len(rows)


async def run_indexer() -> None:
    """Background work inside the mail worker: never holds up syncing or the app."""
    mark_background()
    while True:
        try:
            async with SessionLocal() as db:
                done = await index_some(db)
            await asyncio.sleep(1 if done else IDLE_S)
        except asyncio.CancelledError:
            raise
        except EmbedderUnavailable:
            await asyncio.sleep(BACKOFF_S)
        except Exception as e:  # noqa: BLE001 — try again later; mail keeps working
            logger.warning("Mail indexing failed: %s", type(e).__name__)
            await asyncio.sleep(BACKOFF_S)
