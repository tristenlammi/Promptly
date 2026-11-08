"""Find stray passwords: secrets sitting in someone's own Mail, Files and Photos, so they
can be moved into the vault and the plain copy binned. ``stray`` does the spotting.

What's kept here is where something was found (which message or file), what kind of thing
it is and how many. Never the secret, a hash of it, or the masked preview: the preview is
worked out again from the source each time the list is asked for, and the secret only
leaves when the person opens one finding. Only the asker's own mail, files and photos are
read, never anything shared with them. Nothing goes near a model, nothing but counts goes
to the log, and the vault itself is never read: it can't be, the server has no key.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, delete, func, or_, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, get_db
from app.db_types import UUIDPKMixin
from app.passwords import schemas as s
from app.passwords import stray
from app.passwords.deps import SCOPE_MAIL_CODES, VaultSession, parse_uuid, policy, require_enabled, require_session
from app.passwords.router import _QuietRoute

logger = logging.getLogger("promptly.passwords.stray")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

SOURCES = ("mail", "file", "photo")
SCAN_JOB = "pw_stray_scan_job"
BATCH = 200
# On demand: as long as it takes on most mailboxes. What's left over, the hourly pass picks up.
FULL_BUDGET = 20 * 60.0
# Hourly: a few seconds a person, and only what's newer than last time.
TICK_BUDGET = 20.0
TICK_LIMITS = {"mail": 1000, "file": 300, "photo": 600}
# A scan that started this long ago and never finished is taken to have died.
STALE_SCAN = timedelta(minutes=30)
MAX_READ = 512 * 1024
LIST_LIMIT = 200
SKIP_FOLDERS = ("trash", "spam")

# Cheap first cut in Postgres, so only messages and files with a hint of a secret come
# back to be read properly. It only has to never miss what ``stray`` would find.
_PG_HINT = (
    r"pass ?words?|passwd|passwort|kennwort|contrase|mot de passe|senha|wachtwoord|l.senord|passord|"
    r"\mpwd?\M|api[ _-]?key|secret|token|private key|recovery|backup|scratch code|otpauth|wi-?fi|wlan|wpa|ssid|psk|"
    r"network key|akia|asia|aiza|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk_live_|sk_test_|rk_live_|\msk-|\mhf_|\mnpm_|"
    r"sg\.|-----begin|wifi:"
)
_PG_PHOTO_HINT = _PG_HINT + r"|authenticator|2fa|two.factor|2-step|totp|mfa"
_PG_NAME = (
    r"pass ?words?|passwd|login|credential|creds|kennw|passw|contrase|mots? de passe|bitwarden|lastpass|1password|"
    r"dashlane|keeper|nordpass|roboform|enpass|proton ?pass|promptly-vault-|recovery|backup.?code|codes.de.secours|"
    r"\.(kdbx|kdb|1pux|1pif|opvault|agilekeychain|psafe3|keychain|keychain-db)$|^\.env|\.env$|pgpass|netrc|npmrc|pypirc|"
    r"htpasswd|git-credentials|^id_(rsa|dsa|ecdsa|ed25519)$"
)
_TEXT_NAME = re.compile(
    r"\.(?:txt|text|csv|tsv|json|env|ini|conf|cfg|yaml|yml|toml|properties|md|xml|log|sh|ps1|bat|pem|key)$|^\.env|"
    r"^\.?(?:pgpass|netrc|npmrc|pypirc|htpasswd|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)$",
    re.IGNORECASE,
)
_PG_TEXT_NAME = (
    r"\.(txt|text|csv|tsv|json|env|ini|conf|cfg|yaml|yml|toml|properties|md|xml|log|sh|ps1|bat|pem|key)$|^\.env|"
    r"^\.?(pgpass|netrc|npmrc|pypirc|htpasswd|git-credentials)$|^id_(rsa|dsa|ecdsa|ed25519)$"
)
# Photos the browser can decode, so the device can read a QR from the original.
_DECODABLE = ("image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp")
MAX_IMAGE = 30 * 1024 * 1024


# ------------------------------------------------------------------ tables


class PwStrayFinding(UUIDPKMixin, Base):
    """Where something that looks like a secret was found. Never what it was."""

    __tablename__ = "pw_stray_findings"
    __table_args__ = (UniqueConstraint("user_id", "source", "source_id", "kind", name="uq_pw_stray_finding"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(8), nullable=False)  # mail | file | photo
    # A mail message's or a file's id. No foreign key across the two: a finding whose
    # source has gone is dropped when it's next listed or scanned.
    source_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    hits: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    found_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ignored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwStrayState(Base):
    """How far each source has been read, by date, so the hourly pass reads only what's new."""

    __tablename__ = "pw_stray_state"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    cursors: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ reading the sources


@dataclass
class Source:
    """One message or file, read for a finding. ``text`` is None for a file that can't be read."""

    source: str
    id: uuid.UUID
    title: str
    detail: str
    at: datetime | None
    text: str | None
    subject: str = ""
    site: str = ""
    name: str = ""


def _domain(addr: str) -> str:
    return addr.rsplit("@", 1)[-1].strip().lower() if "@" in addr else ""


def _hits(src: Source) -> list[stray.Hit]:
    if src.source == "mail":
        return stray.scan_text(src.text or "", subject=src.subject)
    if src.source == "photo":
        return stray.scan_photo(src.text or "")
    return stray.scan_file(src.name, src.text)


async def _mail_accounts(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    from app.mail.models import MailAccount

    # Accounts are personal: nobody else's mail can turn up here.
    return list((await db.execute(select(MailAccount.id).where(MailAccount.user_id == user_id))).scalars())


def _mail_source(m: Any, folder_name: str) -> Source:
    from app.passwords.connections import plain_text

    return Source(
        "mail", m.id, (m.subject or "(no subject)")[:200], f"{_domain(m.from_addr) or m.from_name or 'Mail'} · {folder_name}", m.sent_at,
        plain_text(m.body_text, m.body_html), subject=m.subject or "", site=_domain(m.from_addr),
    )


def _read_small(file: Any) -> str | None:
    """A small text file nobody's extracted text from (a .env, say), straight off disk."""
    from app.files.storage import absolute_path

    try:
        with open(absolute_path(file.storage_path), "rb") as fh:
            data = fh.read(MAX_READ)
    except (OSError, ValueError):
        return None
    if data.count(b"\x00") > 4:
        return None
    return data.decode("utf-8", errors="replace")


async def _file_text(file: Any) -> str | None:
    # Drive's own text index first: what search already reads for Docs, Sheets, Office and PDFs.
    if file.content_text:
        return file.content_text
    name = file.original_filename or file.filename or ""
    if file.size_bytes <= MAX_READ and (_TEXT_NAME.search(name) or (file.mime_type or "").startswith("text/")):
        return await asyncio.to_thread(_read_small, file)
    return None


async def _file_source(file: Any) -> Source:
    name = file.original_filename or file.filename or "file"
    return Source("file", file.id, name[:200], "Files", file.modified_at, await _file_text(file), name=name)


def _media(mime: str | None) -> bool:
    m = (mime or "").lower()
    return m.startswith(("image/", "video/", "audio/"))


async def load_source(db: AsyncSession, user_id: uuid.UUID, source: str, source_id: uuid.UUID) -> Source | None:
    """The message or file, if it's still this person's own and not in a Trash."""
    if source == "mail":
        from app.mail.models import MailFolder, MailMessage

        accounts = await _mail_accounts(db, user_id)
        if not accounts:
            return None
        row = (
            await db.execute(
                select(MailMessage, MailFolder.name, MailFolder.role)
                .join(MailFolder, MailFolder.id == MailMessage.folder_id)
                .where(MailMessage.id == source_id, MailMessage.account_id.in_(accounts))
            )
        ).first()
        if row is None or row[2] in SKIP_FOLDERS:
            return None
        return _mail_source(row[0], row[1])

    from app.files.models import UserFile

    file = await db.get(UserFile, source_id)
    if file is None or file.user_id != user_id or file.trashed_at is not None:
        return None
    if source == "file":
        if _media(file.mime_type):
            return None
        return await _file_source(file)
    words = await db.scalar(
        text("SELECT t.text FROM photo_text t JOIN photo_assets p ON p.file_id = t.file_id WHERE t.file_id = :f AND p.user_id = :u"),
        {"f": source_id, "u": user_id},
    )
    if words is None:
        return None
    name = file.original_filename or "photo"
    return Source("photo", file.id, name[:200], "Photos", file.created_at, words, name=name)


# ------------------------------------------------------------------ scanning


async def _record(db: AsyncSession, user_id: uuid.UUID, source: str, source_id: uuid.UUID, hits: list[stray.Hit]) -> int:
    """Brings one source's findings up to date. Ignored ones stay ignored."""
    kinds: dict[str, int] = {}
    for h in hits:
        kinds[h.kind] = kinds.get(h.kind, 0) + h.count
    for kind, n in kinds.items():
        stmt = insert(PwStrayFinding).values(id=uuid.uuid4(), user_id=user_id, source=source, source_id=source_id, kind=kind, hits=n)
        await db.execute(stmt.on_conflict_do_update(constraint="uq_pw_stray_finding", set_={"hits": n}))
    gone = delete(PwStrayFinding).where(
        PwStrayFinding.user_id == user_id, PwStrayFinding.source == source, PwStrayFinding.source_id == source_id, PwStrayFinding.ignored_at.is_(None)
    )
    if kinds:
        gone = gone.where(PwStrayFinding.kind.not_in(list(kinds)))
    await db.execute(gone)
    return len(kinds)


def _after(cursor: list[str] | None, ts_col: Any, id_col: Any):
    if not cursor:
        return None
    return tuple_(ts_col, id_col) > tuple_(datetime.fromisoformat(cursor[0]), uuid.UUID(cursor[1]))


async def _mail_batch(db: AsyncSession, user_id: uuid.UUID, cursor: list[str] | None, limit: int) -> tuple[list[str] | None, int, int]:
    from app.mail.models import MailFolder, MailMessage

    accounts = await _mail_accounts(db, user_id)
    if not accounts:
        return cursor, 0, 0
    q = (
        select(MailMessage, MailFolder.name)
        .join(MailFolder, MailFolder.id == MailMessage.folder_id)
        .where(
            MailMessage.account_id.in_(accounts),
            MailFolder.role.not_in(SKIP_FOLDERS),
            or_(
                MailMessage.subject.op("~*")(_PG_HINT),
                MailMessage.body_text.op("~*")(_PG_HINT),
                func.substr(MailMessage.body_html, 1, 200_000).op("~*")(_PG_HINT),
            ),
        )
    )
    after = _after(cursor, MailMessage.sent_at, MailMessage.id)
    if after is not None:
        q = q.where(after)
    rows = (await db.execute(q.order_by(MailMessage.sent_at, MailMessage.id).limit(limit))).all()
    found = 0
    for m, folder in rows:
        src = _mail_source(m, folder)
        found += await _record(db, user_id, "mail", m.id, _hits(src))
        cursor = [m.sent_at.isoformat(), str(m.id)]
    return cursor, len(rows), found


async def _file_batch(db: AsyncSession, user_id: uuid.UUID, cursor: list[str] | None, limit: int) -> tuple[list[str] | None, int, int]:
    from app.files.models import UserFile

    name = func.coalesce(UserFile.original_filename, UserFile.filename)
    q = select(UserFile).where(
        UserFile.user_id == user_id,
        UserFile.trashed_at.is_(None),
        ~func.lower(UserFile.mime_type).op("~")(r"^(image|video|audio)/"),
        or_(
            name.op("~*")(_PG_NAME),
            UserFile.content_text.op("~*")(_PG_HINT),
            (UserFile.content_text.is_(None) & (UserFile.size_bytes <= MAX_READ) & (name.op("~*")(_PG_TEXT_NAME) | UserFile.mime_type.ilike("text/%"))),
        ),
    )
    after = _after(cursor, UserFile.modified_at, UserFile.id)
    if after is not None:
        q = q.where(after)
    rows = (await db.execute(q.order_by(UserFile.modified_at, UserFile.id).limit(limit))).scalars().all()
    found = 0
    for f in rows:
        found += await _record(db, user_id, "file", f.id, _hits(await _file_source(f)))
        cursor = [f.modified_at.isoformat(), str(f.id)]
    return cursor, len(rows), found


async def _photo_batch(db: AsyncSession, user_id: uuid.UUID, cursor: list[str] | None, limit: int) -> tuple[list[str] | None, int, int]:
    sql = (
        "SELECT t.file_id, t.text, t.created_at FROM photo_text t "
        "JOIN photo_assets p ON p.file_id = t.file_id JOIN files f ON f.id = t.file_id "
        "WHERE p.user_id = :u AND f.user_id = :u AND f.trashed_at IS NULL AND t.text ~* :hint "
    )
    params: dict[str, Any] = {"u": user_id, "hint": _PG_PHOTO_HINT, "n": limit}
    if cursor:
        sql += "AND (t.created_at, t.file_id) > (:ts, :id) "
        params.update(ts=datetime.fromisoformat(cursor[0]), id=uuid.UUID(cursor[1]))
    rows = (await db.execute(text(sql + "ORDER BY t.created_at, t.file_id LIMIT :n"), params)).all()
    found = 0
    for file_id, words, at in rows:
        found += await _record(db, user_id, "photo", file_id, stray.scan_photo(words or ""))
        cursor = [at.isoformat(), str(file_id)]
    return cursor, len(rows), found


_BATCHES = {"mail": _mail_batch, "file": _file_batch, "photo": _photo_batch}


async def _state(db: AsyncSession, user_id: uuid.UUID) -> PwStrayState:
    st = await db.get(PwStrayState, user_id)
    if st is None:
        await db.execute(insert(PwStrayState).values(user_id=user_id, cursors={}).on_conflict_do_nothing())
        await db.flush()
        st = await db.get(PwStrayState, user_id)
    return st  # type: ignore[return-value]


async def _save(db: AsyncSession, user_id: uuid.UUID, **values: Any) -> None:
    """Written out each time, and committed, so a pass cut short keeps its place."""
    await db.execute(update(PwStrayState).where(PwStrayState.user_id == user_id).values(**values))
    await db.commit()


async def scan_user(db: AsyncSession, user_id: uuid.UUID, *, full: bool = False, budget: float = TICK_BUDGET, limits: dict[str, int] | None = None) -> dict[str, Any]:
    """Read what's new since last time (or everything, with ``full``), oldest first, in
    batches, until it's caught up or the time's up. The cursors move with each batch, so
    a pass cut short carries on from there next time."""
    st = await _state(db, user_id)
    cursors: dict[str, Any] = {} if full else {k: v for k, v in (st.cursors or {}).items() if k in SOURCES}
    await _save(db, user_id, cursors=cursors, started_at=_now())
    deadline = time.monotonic() + budget
    scanned = found = 0
    caught_up = True
    for source in SOURCES:
        done = 0
        while True:
            if time.monotonic() > deadline or (limits and done >= limits[source]):
                caught_up = False
                break
            size = min(BATCH, limits[source] - done) if limits else BATCH
            cursor, n, f = await _BATCHES[source](db, user_id, cursors.get(source), size)
            if cursor:
                cursors[source] = cursor
            done += n
            found += f
            await _save(db, user_id, cursors=dict(cursors))
            if n < size:
                break
        scanned += done
    await _save(db, user_id, cursors={**cursors, "caught_up": caught_up}, finished_at=_now())
    # Counts only: never what was found, or where.
    logger.info("stray scan: user=%s full=%s read=%d kinds_found=%d caught_up=%s", user_id, full, scanned, found, caught_up)
    return {"scanned": scanned, "found": found, "caught_up": caught_up}


async def run_scan_job(user_id: str) -> None:
    """The arq job behind "Find stray passwords"."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        await scan_user(db, uuid.UUID(user_id), full=True, budget=FULL_BUDGET)


async def tick() -> int:
    """Hourly, for everyone with a vault: whatever arrived since last time, a few seconds each."""
    from app.database import SessionLocal
    from app.passwords.models import PwAccount

    async with SessionLocal() as db:
        if not (await policy(db)).enabled:
            return 0
        users = list((await db.execute(select(PwAccount.user_id))).scalars())
        n = 0
        for uid in users:
            st = await db.get(PwStrayState, uid)
            if st and st.started_at and (st.finished_at is None or st.finished_at < st.started_at) and _now() - st.started_at < STALE_SCAN:
                continue  # one's running for them now
            try:
                await scan_user(db, uid, budget=TICK_BUDGET, limits=TICK_LIMITS)
                n += 1
            except Exception:  # noqa: BLE001 - one person's odd file mustn't stop everyone else's
                await db.rollback()
                logger.warning("stray scan: hourly pass failed for user=%s", uid, exc_info=True)
        return n


async def enqueue_scan(user_id: uuid.UUID) -> None:
    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        await pool.enqueue_job(SCAN_JOB, str(user_id), _job_id=f"pw-stray-{user_id}-{int(time.time())}")
        return
    except Exception:  # noqa: BLE001 - never lose the request
        logger.warning("stray scan: queue unavailable, scanning in the API process", exc_info=True)
    from app.background import spawn

    spawn(run_scan_job(str(user_id)), name=f"pw_stray_{user_id}")


# ------------------------------------------------------------------ the API


class Where(s._Base):
    title: str
    detail: str
    at: datetime | None


class FindingOut(s._Base):
    id: uuid.UUID
    source: str
    kind: str
    hits: int
    label: str
    preview: str
    where: Where
    found_at: datetime


class StrayOut(s._Base):
    count: int
    ignored: int
    scanning: bool
    caught_up: bool
    last_scan_at: datetime | None
    mail_hidden: bool
    findings: list[FindingOut]


class SecretOut(s._Base):
    kind: str
    value: str
    username: str
    label: str
    count: int


class FindingDetail(FindingOut):
    secrets: list[SecretOut]
    excerpt: str
    site: str
    name: str


def _mail_allowed(session: VaultSession) -> bool:
    """A browser or app connected without Mail codes doesn't get mail here either."""
    return session.device is None or SCOPE_MAIL_CODES in (session.device.scopes or [])


def _scanning(st: PwStrayState | None) -> bool:
    if st is None or st.requested_at is None or _now() - st.requested_at > STALE_SCAN:
        return False
    return st.finished_at is None or st.finished_at < st.requested_at


def _out(row: PwStrayFinding, src: Source, hits: list[stray.Hit]) -> FindingOut:
    return FindingOut(
        id=row.id, source=row.source, kind=row.kind, hits=sum(h.count for h in hits), label=hits[0].label,
        preview=stray.preview(hits[0]), where=Where(title=src.title, detail=src.detail, at=src.at), found_at=row.found_at,
    )


async def _current(db: AsyncSession, row: PwStrayFinding) -> tuple[Source, list[stray.Hit]] | None:
    """The finding as its source stands now. One that's no longer there is dropped."""
    src = await load_source(db, row.user_id, row.source, row.source_id)
    hits = [h for h in _hits(src) if h.kind == row.kind] if src else []
    if not hits:
        await db.delete(row)
        return None
    return src, hits  # type: ignore[return-value]


@router.get("/stray", response_model=StrayOut)
async def list_stray(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> StrayOut:
    response.headers["Cache-Control"] = "no-store"
    uid = session.user.id
    mail_ok = _mail_allowed(session)
    q = select(PwStrayFinding).where(PwStrayFinding.user_id == uid, PwStrayFinding.ignored_at.is_(None))
    if not mail_ok:
        q = q.where(PwStrayFinding.source != "mail")
    rows = (await db.execute(q.order_by(PwStrayFinding.found_at.desc(), PwStrayFinding.id).limit(LIST_LIMIT))).scalars().all()
    out: list[FindingOut] = []
    for row in rows:
        got = await _current(db, row)
        if got:
            out.append(_out(row, *got))
    await db.commit()
    total = len(out)
    if len(rows) == LIST_LIMIT:
        total = max(total, await db.scalar(select(func.count()).select_from(q.subquery())) or 0)
    ignored = await db.scalar(select(func.count()).where(PwStrayFinding.user_id == uid, PwStrayFinding.ignored_at.is_not(None))) or 0
    st = await db.get(PwStrayState, uid)
    return StrayOut(
        count=total, ignored=ignored, scanning=_scanning(st), caught_up=bool(st and (st.cursors or {}).get("caught_up")),
        last_scan_at=st.finished_at if st else None, mail_hidden=not mail_ok, findings=out,
    )


@router.get("/stray/count")
async def count_stray(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, int]:
    """For a badge: no sources are read, so it can be a little behind."""
    q = select(func.count()).where(PwStrayFinding.user_id == session.user.id, PwStrayFinding.ignored_at.is_(None))
    if not _mail_allowed(session):
        q = q.where(PwStrayFinding.source != "mail")
    return {"count": await db.scalar(q) or 0}


@router.post("/stray/scan", status_code=status.HTTP_202_ACCEPTED)
async def start_scan(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    st = await _state(db, session.user.id)
    if _scanning(st):
        return {"scanning": True}
    st.requested_at = _now()
    await db.commit()
    await enqueue_scan(session.user.id)
    return {"scanning": True}


async def _mine(db: AsyncSession, session: VaultSession, finding_id: str) -> PwStrayFinding:
    row = await db.get(PwStrayFinding, parse_uuid(finding_id))
    if row is None or row.user_id != session.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if row.source == "mail" and not _mail_allowed(session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This device can't read mail.")
    return row


@router.get("/stray/{finding_id}", response_model=FindingDetail)
async def open_stray(finding_id: str, response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> FindingDetail:
    """The one place a found secret leaves the server, when its owner opens it."""
    response.headers["Cache-Control"] = "no-store"
    row = await _mine(db, session, finding_id)
    got = await _current(db, row)
    if got is None:
        await db.commit()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That's not there any more.")
    src, hits = got
    base = _out(row, src, hits)
    return FindingDetail(
        **base.model_dump(),
        secrets=[SecretOut(kind=h.kind, value=h.value, username=h.username, label=h.label, count=h.count) for h in hits[:20]],
        excerpt=stray.excerpt(src.text or "", hits[0].line, subject=src.subject) if src.text else "",
        site=src.site,
        name=src.name,
    )


@router.get("/stray/{finding_id}/image")
async def stray_image(finding_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """A photo, for the device to read its QR. The server doesn't decode it."""
    from app.files.derivatives import rendition_path
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    row = await _mine(db, session, finding_id)
    if row.source != "photo" or await load_source(db, session.user.id, "photo", row.source_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    file = await db.get(UserFile, row.source_id)
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if file and (file.mime_type or "").lower() in _DECODABLE and file.size_bytes <= MAX_IMAGE:
        try:
            path = absolute_path(file.storage_path)
        except ValueError:
            path = None
        if path is not None and path.is_file():
            return FileResponse(path, media_type=file.mime_type, headers=headers)
    preview = rendition_path(row.source_id, "preview.webp")
    if preview.is_file():
        return FileResponse(preview, media_type="image/webp", headers=headers)
    raise HTTPException(status.HTTP_404_NOT_FOUND, "That photo has no picture here.")


@router.post("/stray/{finding_id}/ignore", status_code=status.HTTP_204_NO_CONTENT)
async def ignore_stray(finding_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Hidden for good, including from later scans."""
    row = await _mine(db, session, finding_id)
    row.ignored_at = _now()
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/stray/{finding_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
async def trash_stray(finding_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """The original into its own app's Trash: Mail's, or Files' (which Photos shares). It
    can be got back from there for the usual time."""
    row = await _mine(db, session, finding_id)
    uid = session.user.id
    if await load_source(db, uid, row.source, row.source_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That's not there any more.")
    if row.source == "mail":
        from app.mail import rules
        from app.mail.models import MailFolder, MailMessage

        message = await db.get(MailMessage, row.source_id)
        folders = {f.id: f for f in (await db.execute(select(MailFolder).where(MailFolder.account_id == message.account_id))).scalars()}  # type: ignore[union-attr]
        target = next((f for f in folders.values() if f.role == "trash"), None)
        if target is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "This mailbox has no Trash folder. Delete it in Mail instead.")
        rules.move(db, folders, [message], target)  # type: ignore[list-item]
        await db.commit()
    else:
        from app.files import router as files

        await files.trash_file(row.source_id, db=db, user=session.user)
    await db.execute(delete(PwStrayFinding).where(PwStrayFinding.user_id == uid, PwStrayFinding.source == row.source, PwStrayFinding.source_id == row.source_id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router", "scan_user", "run_scan_job", "tick", "PwStrayFinding", "PwStrayState", "SCAN_JOB"]
