"""Ask your Drive — indexing a person's files for AI search (WP-5.1).

Opt-in per person (``user.settings["drive_ai"]``), because the embedder may
be a cloud API: turning it on sends the text of your files to it. Folders
(Generated Files and Chat Uploads included) and whole kinds of file can be
left out. What's indexed:

* Promptly Docs, Sheets and Whiteboards (their searchable text);
* uploaded Office files (the text read from them in WP-4.3);
* PDFs and text files;

— your own files, not in the trash, outside excluded folders and the
Templates folder. Images, audio and video aren't (yet).

A background pass (like the chat indexer) picks up new and changed files a
few at a time, under the embedding gate's background lease, so it never
holds up someone waiting on a chat. ``drive_index_state`` remembers the
text hash and embedding model each file was indexed with; an unchanged file
is never re-embedded, and when a workspace already holds vectors for the
exact same content (same file, same hash, same model) they're copied.

Readers search it through :func:`app.custom_models.retrieval.retrieve_drive_context`
with the shared read rule, so a file someone shared with you counts.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal

logger = logging.getLogger("promptly.files.drive_index")

SETTINGS_KEY = "drive_ai"
INDEXABLE_KINDS = ("document", "sheet", "whiteboard", "rendered_pdf")
MAX_TEXT_CHARS = 400_000
# Bumped when what's stored with a chunk changes (v2: PDF page, sheet tab
# and row for citations — WP-5.2), so every file is rebuilt once.
INDEX_FORMAT = "v2"
_PAGE_RE = re.compile(r"--- Page (\d+) ---")
_SHEET_MARK_RE = re.compile(r"\[tab: ([^\]]+)\]|\[row (\d+)\]")
BATCH_PER_USER = 8
_ACTIVE_SLEEP = 5.0
_IDLE_SLEEP = 60.0


# ------------------------------------------------------------------ settings


CHAT_MODES = ("auto", "always", "off")
# Kinds of file a person can leave out, as ``_kind_sql`` sorts them.
KIND_GROUPS = ("docs", "sheets", "whiteboards", "pdfs", "office", "text")


def drive_settings(user: Any) -> dict:
    raw = (getattr(user, "settings", None) or {}).get(SETTINGS_KEY) or {}
    mode = raw.get("chat_mode")
    return {
        "enabled": bool(raw.get("enabled")),
        "excluded_folder_ids": [str(x) for x in raw.get("excluded_folder_ids") or []],
        "excluded_kinds": [k for k in raw.get("excluded_kinds") or [] if k in KIND_GROUPS],
        # How chats use the index (WP-5.2): ``auto`` — the assistant looks
        # things up when a question is about your files; ``always`` — every
        # reply checks your files first; ``off`` — chats don't.
        "chat_mode": mode if mode in CHAT_MODES else "auto",
    }


def chat_mode_for(user: Any) -> str:
    """``off`` unless AI search is on; then the person's chat mode."""
    s = drive_settings(user)
    return s["chat_mode"] if s["enabled"] else "off"


async def save_drive_settings(
    db: AsyncSession,
    user: Any,
    *,
    enabled: bool,
    excluded_folder_ids: list[str],
    chat_mode: str | None = None,
    excluded_kinds: list[str] | None = None,
) -> dict:
    """Store the choice; turning it off removes every Drive chunk of the
    user's files at once (nothing of theirs stays with the embedder's
    vectors), and newly left-out folders and kinds lose theirs."""
    before = drive_settings(user)
    kinds = before["excluded_kinds"] if excluded_kinds is None else [k for k in excluded_kinds if k in KIND_GROUPS]
    settings = dict(getattr(user, "settings", None) or {})
    settings[SETTINGS_KEY] = {
        "enabled": bool(enabled),
        "excluded_folder_ids": list(dict.fromkeys(excluded_folder_ids)),
        "excluded_kinds": list(dict.fromkeys(kinds)),
        "chat_mode": chat_mode if chat_mode in CHAT_MODES else before["chat_mode"],
    }
    user.settings = settings
    flag_modified(user, "settings")
    await db.flush()
    if not enabled:
        await forget_user(db, user.id)
    elif set(excluded_folder_ids) - set(before["excluded_folder_ids"]) or set(kinds) - set(before["excluded_kinds"]):
        await _drop_ineligible(db, user)
    return drive_settings(user)


async def forget_user(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(text("DELETE FROM knowledge_chunks WHERE drive_user_id = :u"), {"u": str(user_id)})
    await db.execute(text("DELETE FROM drive_index_state WHERE user_id = :u"), {"u": str(user_id)})


def _tree_cte(param: str = "roots") -> str:
    return f"""
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM file_folders WHERE id = ANY(CAST(:{param} AS uuid[]))
            UNION
            SELECT c.id FROM file_folders AS c JOIN tree ON c.parent_id = tree.id
        )"""


# ------------------------------------------------------------------ eligibility


async def _excluded_roots(db: AsyncSession, user: Any) -> list[uuid.UUID]:
    from app.files.models import FileFolder
    from app.files.system_folders import SystemKind

    ids = []
    for x in drive_settings(user)["excluded_folder_ids"]:
        try:
            ids.append(uuid.UUID(x))
        except ValueError:
            continue
    templates = (
        await db.execute(
            select(FileFolder.id).where(
                FileFolder.user_id == user.id, FileFolder.system_kind == SystemKind.TEMPLATES.value
            )
        )
    ).scalars().all()
    return ids + list(templates)


def _kind_sql(alias: str = "f") -> str:
    """Which of :data:`KIND_GROUPS` a file falls in."""
    from app.files.office_formats import LEGACY_OFFICE_ALLOWLIST, OFFICE_ALLOWLIST

    exts = "|".join(sorted(e.lstrip(".") for e in (*OFFICE_ALLOWLIST, *LEGACY_OFFICE_ALLOWLIST)))
    return f"""(CASE
        WHEN {alias}.source_kind = 'document' THEN 'docs'
        WHEN {alias}.source_kind = 'sheet' THEN 'sheets'
        WHEN {alias}.source_kind = 'whiteboard' THEN 'whiteboards'
        WHEN {alias}.source_kind = 'rendered_pdf' OR {alias}.mime_type = 'application/pdf'
             OR lower({alias}.filename) LIKE '%.pdf' THEN 'pdfs'
        WHEN lower({alias}.filename) ~ '[.]({exts})$' THEN 'office'
        ELSE 'text' END)"""


def _eligible_where(alias: str = "f") -> str:
    """Files of ``:u``, not trashed, of a kind that has text, outside the
    excluded folder trees (``tree`` CTE) and the left-out kinds (``:xk``)."""
    kinds = ", ".join(f"'{k}'" for k in INDEXABLE_KINDS)
    return f"""
        {alias}.user_id = :u
        AND {alias}.trashed_at IS NULL
        AND ({alias}.source_kind IS NULL OR {alias}.source_kind IN ({kinds}))
        AND ({alias}.folder_id IS NULL OR {alias}.folder_id NOT IN (SELECT id FROM tree))
        AND NOT ({_kind_sql(alias)} = ANY(CAST(:xk AS text[])))"""


async def _params(db: AsyncSession, user: Any) -> dict:
    """What :func:`_tree_cte` + :func:`_eligible_where` need."""
    return {
        "u": str(user.id),
        "roots": await _excluded_roots(db, user),
        "xk": drive_settings(user)["excluded_kinds"],
    }


async def _candidates(db: AsyncSession, user: Any, model: str, limit: int) -> list:
    """Files that are new, changed since they were indexed, or indexed with
    another embedding model — newest first."""
    from app.files.models import UserFile

    sql = text(
        f"""{_tree_cte()}
        SELECT f.id FROM files AS f
        LEFT JOIN drive_index_state AS s ON s.file_id = f.id
        WHERE {_eligible_where('f')}
          AND (s.file_id IS NULL
               OR s.indexed_at < f.modified_at
               OR (s.status = 'ready' AND s.embedding_model IS DISTINCT FROM :em))
        ORDER BY f.modified_at DESC
        LIMIT :lim"""
    )
    params = {**(await _params(db, user)), "em": model, "lim": limit}
    ids = (await db.execute(sql, params)).scalars().all()
    if not ids:
        return []
    rows = (await db.execute(select(UserFile).where(UserFile.id.in_(ids)))).scalars().all()
    order = {i: n for n, i in enumerate(ids)}
    return sorted(rows, key=lambda r: order[r.id])


def _file_text(file: Any) -> str | None:
    """The text to embed for a file, or None (nothing indexable)."""
    from app.custom_models.embedding import extract_text_for_embedding, is_text_extractable
    from app.files.office_formats import office_ext

    kind = file.source_kind or ""
    if kind in ("document", "sheet", "whiteboard") or office_ext(file.filename):
        return (file.content_text or "").strip() or None
    if is_text_extractable(file):
        try:
            return (extract_text_for_embedding(file) or "").strip() or None
        except Exception:  # noqa: BLE001 — unreadable = not indexable
            logger.info("drive index: couldn't read %s", file.id, exc_info=True)
            return None
    return None


async def _set_state(db: AsyncSession, file: Any, *, status: str, content_hash: str | None,
                     model: str | None, chunks: int = 0, error: str | None = None) -> None:
    from app.files.models import DriveIndexState

    st = await db.get(DriveIndexState, file.id)
    if st is None:
        st = DriveIndexState(file_id=file.id, user_id=file.user_id, status=status)
        db.add(st)
    st.status = status
    st.content_hash = content_hash
    st.embedding_model = model
    st.chunks = chunks
    st.error = error
    st.indexed_at = datetime.now(timezone.utc)


async def _copy_from_workspace(db: AsyncSession, file: Any, model: str) -> int:
    """Reuse a workspace's vectors for this exact file content (same blob
    hash the workspace indexed, same embedding model). Returns rows copied."""
    from app.custom_models.embedding import file_content_hash
    from app.files.storage import absolute_path

    if not file.storage_path or not absolute_path(file.storage_path).exists():
        return 0
    try:
        blob_hash = await asyncio.to_thread(file_content_hash, file)
    except OSError:
        return 0
    ws = (
        await db.execute(
            text(
                """
                SELECT wf.workspace_id FROM workspace_files AS wf
                WHERE wf.file_id = :fid AND wf.indexing_status = 'ready' AND wf.indexed_content_hash = :h
                UNION
                SELECT wi.workspace_id FROM workspace_items AS wi
                WHERE wi.ref_id = :fid AND wi.indexing_status = 'ready' AND wi.indexed_content_hash = :h
                LIMIT 1
                """
            ),
            {"fid": str(file.id), "h": blob_hash},
        )
    ).scalar()
    if ws is None:
        return 0
    res = await db.execute(
        text(
            """
            INSERT INTO knowledge_chunks
                (id, drive_user_id, user_file_id, chunk_index, text, tokens, embedding_model,
                 embedding_dim, metadata, embedding_768, embedding_1536)
            SELECT gen_random_uuid(), :u, kc.user_file_id, kc.chunk_index, kc.text, kc.tokens,
                   kc.embedding_model, kc.embedding_dim, kc.metadata, kc.embedding_768, kc.embedding_1536
            FROM knowledge_chunks AS kc
            WHERE kc.workspace_id = :ws AND kc.user_file_id = :fid AND kc.embedding_model = :em
            """
        ),
        {"u": str(file.user_id), "ws": str(ws), "fid": str(file.id), "em": model},
    )
    return res.rowcount or 0


async def _sheet_text(db: AsyncSession, file: Any) -> str | None:
    """A sheet as text a citation can point into: each tab under ``[tab: name]``
    and each row as ``[row N] a | b | c`` (N as the sheet shows it) — inline
    markers, because chunking collapses newlines."""
    from app.files.office import content_for_shell
    from app.workspaces.sheet_io import _grid, _shown, _tabs

    sheet = await content_for_shell(db, file)
    tabs = _tabs(getattr(sheet, "data", None))
    if not tabs:
        return (file.content_text or "").strip() or None
    out: list[str] = []
    for i, tab in enumerate(tabs):
        rows: dict[int, list[tuple[int, str]]] = {}
        for (r, c), cell in _grid(tab).items():
            text_ = _shown(cell.get("v")).strip()
            if text_:
                rows.setdefault(r, []).append((c, text_))
        if not rows:
            continue
        out.append(f"[tab: {tab.get('name') or f'Sheet{i + 1}'}]")
        for r in sorted(rows):
            out.append(f"[row {r + 1}] " + " | ".join(t for _c, t in sorted(rows[r])))
    return "\n".join(out) or None


async def file_text_for(db: AsyncSession, file: Any) -> str | None:
    """A file's readable text as the index sees it — a sheet tab by tab with
    row numbers, a PDF with its page breaks — for ``read_file`` (WP-5.3)."""
    if file.source_kind == "sheet":
        return await _sheet_text(db, file)
    return await asyncio.to_thread(_file_text, file)


def _annotate(chunks: list, kind: str) -> list:
    """Where each chunk starts, for citations: the PDF page, or the sheet
    tab and row (carried over from the chunk before when a chunk opens
    mid-page / mid-tab)."""
    from app.custom_models.embedding import Chunk

    if kind not in ("pdf", "sheet"):
        return chunks
    out = []
    page, tab, row = 1, None, None
    for ch in chunks:
        meta = dict(ch.metadata or {})
        if kind == "pdf":
            marks = list(_PAGE_RE.finditer(ch.text))
            starts_on_marker = bool(marks) and not ch.text[: marks[0].start()].strip()
            start_page = int(marks[0].group(1)) if starts_on_marker else page
            meta["page"] = start_page
            if marks:
                page = int(marks[-1].group(1))
        else:
            # The chunk's first row, under whichever tab is in force there.
            first: tuple[str | None, int | None] | None = None
            for m in _SHEET_MARK_RE.finditer(ch.text):
                if m.group(1) is not None:
                    tab, row = m.group(1).strip(), None
                else:
                    row = int(m.group(2))
                    if first is None:
                        first = (tab, row)
            start_tab, start_row = first if first is not None else (tab, row)
            meta["tab"] = start_tab
            if start_row is not None:
                meta["row"] = start_row
        out.append(Chunk(index=ch.index, text=ch.text, tokens=ch.tokens, metadata=meta))
    return out


def _kind_of(file: Any) -> str:
    from app.custom_models.embedding import _looks_pdf

    if file.source_kind == "sheet":
        return "sheet"
    if file.source_kind == "document":
        return "document"
    try:
        return "pdf" if _looks_pdf(file) else "file"
    except Exception:  # noqa: BLE001
        return "file"


async def index_file(db: AsyncSession, file: Any, cfg: Any) -> str:
    """Index one file into its owner's Drive scope. Returns the status."""
    from app.custom_models.ingestion import delete_existing_chunks, embed_text_to_chunks, insert_chunks

    kind = _kind_of(file)
    if kind == "sheet":
        body = await _sheet_text(db, file)
    else:
        body = await asyncio.to_thread(_file_text, file)
    if not body:
        await delete_existing_chunks(db, scope_kind="drive", scope_id=file.user_id, user_file_id=file.id, commit=False)
        await _set_state(db, file, status="skipped", content_hash=None, model=cfg.model_id)
        await db.commit()
        return "skipped"
    body = body[:MAX_TEXT_CHARS]
    title = os.path.splitext(file.filename or "")[0]
    full = f"{title}\n\n{body}" if title else body
    digest = hashlib.sha256((INDEX_FORMAT + full).encode("utf-8")).hexdigest()
    from app.files.models import DriveIndexState

    st = await db.get(DriveIndexState, file.id)
    if st is not None and st.status == "ready" and st.content_hash == digest and st.embedding_model == cfg.model_id:
        st.indexed_at = datetime.now(timezone.utc)  # touched, unchanged
        await db.commit()
        return "ready"
    await delete_existing_chunks(db, scope_kind="drive", scope_id=file.user_id, user_file_id=file.id, commit=False)
    # Workspace vectors carry no page / row positions — only reuse them for
    # files whose citations don't need any.
    copied = await _copy_from_workspace(db, file, cfg.model_id) if kind not in ("pdf", "sheet") else 0
    if copied:
        await _set_state(db, file, status="ready", content_hash=digest, model=cfg.model_id, chunks=copied)
        await db.commit()
        return "ready"
    await db.commit()  # release the advisory lock before the (slow) embed
    try:
        chunks, embeddings = await embed_text_to_chunks(full, provider=cfg.provider, model_id=cfg.model_id, dim=cfg.dim)
    except ValueError as exc:
        await _set_state(db, file, status="skipped", content_hash=digest, model=cfg.model_id, error=str(exc))
        await db.commit()
        return "skipped"
    chunks = _annotate(chunks, kind)
    await delete_existing_chunks(db, scope_kind="drive", scope_id=file.user_id, user_file_id=file.id, commit=False)
    await insert_chunks(
        db,
        scope_kind="drive",
        scope_id=file.user_id,
        user_file_id=file.id,
        chunks=chunks,
        embeddings=embeddings,
        embedding_model=cfg.model_id,
        embedding_dim=cfg.dim,
    )
    await _set_state(db, file, status="ready", content_hash=digest, model=cfg.model_id, chunks=len(chunks))
    await db.commit()
    return "ready"


async def prune(db: AsyncSession, user: Any) -> None:
    """Forget files that left the Drive index's reach — trashed, moved into
    an excluded folder, of a left-out kind — so their text stops turning up
    (and a restored file is indexed afresh)."""
    await _drop_ineligible(db, user)
    await db.commit()


async def _drop_ineligible(db: AsyncSession, user: Any) -> None:
    params = await _params(db, user)
    keep = f"""{_tree_cte()} SELECT f.id FROM files AS f WHERE {_eligible_where('f')}"""
    await db.execute(
        text(f"DELETE FROM knowledge_chunks WHERE drive_user_id = :u AND user_file_id NOT IN ({keep})"), params
    )
    await db.execute(
        text(f"DELETE FROM drive_index_state WHERE user_id = :u AND file_id NOT IN ({keep})"), params
    )


async def _opted_in_users(db: AsyncSession) -> list:
    from app.auth.models import User

    return list(
        (
            await db.execute(
                select(User)
                .where(text("(users.settings -> 'drive_ai' ->> 'enabled') = 'true'"))
                # Fresh settings, not a session's cached copy of the user.
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
    )


async def index_pass(db: AsyncSession, *, per_user: int = BATCH_PER_USER) -> int:
    """One round: a few changed files per opted-in user. Returns how many
    files it looked at (0 = nothing to do)."""
    from app.chat.semantic_search import get_embedding_config
    from app.custom_models.embedding import EmbedderUnavailable

    cfg = await get_embedding_config(db)
    if cfg is None:
        return 0
    done = 0
    for user in await _opted_in_users(db):
        await prune(db, user)
        for file in await _candidates(db, user, cfg.model_id, per_user):
            try:
                await index_file(db, file, cfg)
            except EmbedderUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad file mustn't stop the pass
                await db.rollback()
                logger.warning("drive index failed for %s", file.id, exc_info=True)
                await _set_state(db, file, status="failed", content_hash=None, model=cfg.model_id,
                                 error=f"{type(exc).__name__}: {exc}"[:500])
                await db.commit()
            done += 1
    return done


async def status_for(db: AsyncSession, user: Any) -> dict:
    """What the settings panel shows: how much of the Drive is searchable."""
    from app.chat.semantic_search import get_embedding_config

    cfg = await get_embedding_config(db)
    params = {**(await _params(db, user)), "em": cfg.model_id if cfg else ""}
    eligible = (
        await db.execute(text(f"{_tree_cte()} SELECT count(*) FROM files AS f WHERE {_eligible_where('f')}"), params)
    ).scalar() or 0
    counts = dict(
        (
            await db.execute(
                text(
                    f"""{_tree_cte()}
                    SELECT s.status, count(*) FROM drive_index_state AS s
                    JOIN files AS f ON f.id = s.file_id
                    WHERE {_eligible_where('f')} AND s.indexed_at >= f.modified_at
                    GROUP BY s.status"""
                ),
                params,
            )
        ).all()
    )
    up_to_date = sum(counts.values())
    return {
        **drive_settings(user),
        "embedder": (f"{cfg.provider.name} · {cfg.model_id}" if cfg else None),
        "eligible": int(eligible),
        "indexed": int(counts.get("ready", 0)),
        "skipped": int(counts.get("skipped", 0)),
        "failed": int(counts.get("failed", 0)),
        "pending": max(0, int(eligible) - int(up_to_date)),
    }


# ------------------------------------------------------------------ loop


async def _loop() -> None:
    from app.custom_models import embedding_gate
    from app.custom_models.embedding import EmbedderUnavailable

    embedding_gate.mark_background()
    logger.info("Drive indexer started")
    while True:
        try:
            async with SessionLocal() as db:
                done = await index_pass(db)
            await asyncio.sleep(_ACTIVE_SLEEP if done else _IDLE_SLEEP)
        except asyncio.CancelledError:
            raise
        except EmbedderUnavailable:
            await asyncio.sleep(_IDLE_SLEEP)
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("Drive index pass failed")
            await asyncio.sleep(_IDLE_SLEEP)


def start_drive_indexer() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="drive_indexer")


__all__ = [
    "CHAT_MODES",
    "chat_mode_for",
    "drive_settings",
    "file_text_for",
    "forget_user",
    "index_file",
    "index_pass",
    "save_drive_settings",
    "start_drive_indexer",
    "status_for",
]
