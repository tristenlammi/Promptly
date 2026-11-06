"""Where Passwords meets the rest of Promptly: codes and sign-in links from Mail,
security emails, plus-address rules, documents from Files, a reminder in Calendar and
the self-host warnings.

None of this reads the vault. It reads what the server already has: mail, files and
backups. The client compares what it gets with the vault on its own side, so the
server never learns which sites you have logins for.
"""
from __future__ import annotations

import html as html_lib
import logging
import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import FileResponse
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.passwords import schemas as s
from app.passwords.deps import SCOPE_MAIL_CODES, VaultSession, parse_uuid, require_enabled, require_session
from app.passwords.models import PwAccount
from app.passwords.router import _QuietRoute

logger = logging.getLogger("promptly.passwords")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

CODE_WINDOW = timedelta(minutes=10)
SECURITY_WINDOW = timedelta(days=30)
# What a Send can hold is the same scale; a scan bigger than this belongs elsewhere.
MAX_DOCUMENT_BYTES = 100 * 1024 * 1024


# ------------------------------------------------------------------ reading a message

# Words that say a number in this line is a code, in the languages the classifier knows.
_CODE_WORDS = re.compile(
    r"\b(code|codes|otp|passcode|one[- ]time|verification|verify|verifying|pin|2fa|two[- ]factor|authentication|security code|login code|sign[- ]in code|"
    r"c[oó]digo|verificaci[oó]n|bestätigung\w*|sicherheitscode|anmeldecode|verifizierungscode|kod|doğrulama|vérification|codice|verifica)\b"
    r"|コード|認証|验证码|驗證碼|인증|код|رمز",
    re.IGNORECASE,
)
# A code of another kind, even though it's called one.
_OTHER_CODE = re.compile(r"\b(promo|coupon|discount|voucher|gift|referral|invite|zip|post(al)? ?code|order|invoice|tracking)\b", re.IGNORECASE)
# Lines where a number means something else.
_NOT_A_CODE = re.compile(
    r"\b(order|invoice|receipt|tracking|reference|ref|ticket|customer|account (number|no)|member|phone|tel|fax|call|price|total|amount|"
    r"booking|flight|zip|postcode|postal|street|unit|suite|copyright|expires? (in|at|on)|valid for|minutes?|hours?|coupon|promo|discount|voucher|gift)\b"
    r"|[$€£¥#]\s*\d",
    re.IGNORECASE,
)
_DIGITS = r"\d{3}[- ]\d{3}|\d{4,8}"
_MIXED = r"[A-Z0-9]{4,8}(?:-[A-Z0-9]{3,6})?"
_CANDIDATE = re.compile(rf"(?<![\w./:@#%$€£-])({_DIGITS}|{_MIXED})(?![\w/@%-])")
_TAG = re.compile(r"<(script|style)\b.*?</\1>|<[^>]+>", re.IGNORECASE | re.DOTALL)
_HREF = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)
_LINK_WORDS = re.compile(r"\b(sign[- ]?in|log[- ]?in|magic link|verify your|confirm your (email|address|account)|one[- ]click)\b", re.IGNORECASE)
_LINK_PATH = re.compile(r"(login|log-in|signin|sign-in|magic|verify|confirm|auth|token|session|activate)", re.IGNORECASE)
_LINK_NOT = re.compile(r"(unsubscribe|privacy|terms|help|support|preferences|tracking|\.png|\.jpg|\.gif)", re.IGNORECASE)


def plain_text(body_text: str, body_html: str) -> str:
    if body_text.strip():
        return body_text[:200_000]
    # Bounded: a code's near the top of a message, and these patterns slow down on huge input.
    body_html = body_html[:200_000]
    return html_lib.unescape(_TAG.sub(" ", re.sub(r"(?i)<(br|/p|/div|/tr|/h\d)\b[^>]*>", "\n", body_html)))


def _usable(candidate: str, *, labelled: bool) -> str | None:
    bare = candidate.replace("-", "").replace(" ", "")
    if bare.isdigit():
        # A year needs saying outright; otherwise it's the date in a footer.
        if len(bare) == 4 and bare[:2] in ("19", "20") and not labelled:
            return None
        return candidate
    # Mixed codes need both, or they're just a capitalised word.
    if any(c.isdigit() for c in bare) and any(c.isalpha() for c in bare):
        return candidate
    return None


def extract_code(subject: str, text: str) -> str | None:
    """The likeliest one-time code in a message, or None. Plain patterns, no AI, and
    wrong answers cost little: it's a suggestion someone reads before clicking."""
    best: tuple[int, str] | None = None
    subject_says = bool(_CODE_WORDS.search(subject))
    sources: list[tuple[str, int]] = [(subject, 0)]
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()][:80]
    said = False
    for i, line in enumerate(lines):
        sources.append((line, i + 1))
    for line, order in sources:
        says = bool(_CODE_WORDS.search(line))
        if says:
            said = True
        # The code often sits on its own line, just after the words about it.
        if not (says or said or subject_says):
            continue
        if _OTHER_CODE.search(line) or (_NOT_A_CODE.search(line) and not says):
            continue
        for m in _CANDIDATE.finditer(line):
            value = _usable(m.group(1), labelled=says)
            if value is None:
                continue
            score = (0 if says else 20) + (0 if value.replace("-", "").replace(" ", "").isdigit() else 5) + order
            # On a line of its own is how most of them are sent.
            if line == m.group(1):
                score -= 15
            if best is None or score < best[0]:
                best = (score, value)
    return best[1] if best else None


def extract_link(subject: str, text: str, body_html: str) -> str | None:
    if not (_LINK_WORDS.search(subject) or _LINK_WORDS.search(text[:4000])):
        return None
    urls = [html_lib.unescape(u) for u in _HREF.findall(body_html)] + _URL.findall(text)
    for u in urls:
        if not u.lower().startswith("https://") or _LINK_NOT.search(u):
            continue
        parts = urlsplit(u)
        if not parts.hostname or "@" in parts.netloc:
            continue
        if _LINK_PATH.search(parts.path) or len(parts.path) + len(parts.query) >= 24:
            return u
    return None


# Mail that says something happened to an account. English and the commonest others.
_SECURITY_PHRASES: list[tuple[str, re.Pattern[str]]] = [
    ("password_changed", re.compile(r"password (was |has been |is )?(changed|updated|reset)|changed your password|contraseña (ha sido )?(cambiada|actualizada)|passwort (wurde )?geändert|mot de passe (a été )?modifié", re.IGNORECASE)),
    ("new_signin", re.compile(r"new (sign[- ]?in|log[- ]?in|device)|signed in (from|on) a new|sign[- ]?in attempt|login attempt|unusual (sign[- ]?in|activity|login)|neue anmeldung|nuevo inicio de sesión|nouvelle connexion", re.IGNORECASE)),
]


def security_kind(subject: str) -> str | None:
    for kind, pattern in _SECURITY_PHRASES:
        if pattern.search(subject):
            return kind
    return None


def _domain_of(addr: str) -> str:
    return addr.rsplit("@", 1)[-1].strip().lower() if "@" in addr else ""


# ------------------------------------------------------------------ mail endpoints


class MailCode(s._Base):
    id: uuid.UUID
    from_name: str
    from_domain: str
    at: datetime
    code: str | None
    link: str | None


class SecurityEvent(s._Base):
    id: uuid.UUID
    kind: str
    from_name: str
    from_domain: str
    subject: str
    at: datetime


def _check_mail_scope(session: VaultSession) -> None:
    if session.device is not None and SCOPE_MAIL_CODES not in (session.device.scopes or []):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This device can't read mail codes.")


async def _recent(db: AsyncSession, user: User, since: datetime, limit: int):
    from app.mail.models import MailFolder, MailMessage
    from app.mail.router import _my_account_ids

    accounts = await _my_account_ids(db, user)
    if not accounts:
        return []
    return (
        (
            await db.execute(
                select(MailMessage)
                .join(MailFolder, MailFolder.id == MailMessage.folder_id)
                .where(
                    MailMessage.account_id.in_(accounts),
                    MailFolder.role.not_in(("trash", "spam", "drafts", "sent")),
                    MailMessage.sent_at >= since,
                )
                .order_by(MailMessage.sent_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )


@router.get("/mail/codes", response_model=list[MailCode])
async def mail_codes(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[MailCode]:
    """Likely codes and sign-in links from the last ten minutes, for this user only. The
    page you're on isn't sent: the client matches sender to site itself."""
    _check_mail_scope(session)
    response.headers["Cache-Control"] = "no-store"
    now = datetime.now(timezone.utc)
    out: list[MailCode] = []
    for m in await _recent(db, session.user, now - CODE_WINDOW, 25):
        text = plain_text(m.body_text, m.body_html)
        code = extract_code(m.subject, text)
        link = extract_link(m.subject, text, m.body_html)
        if code or link:
            out.append(MailCode(id=m.id, from_name=m.from_name, from_domain=_domain_of(m.from_addr), at=m.sent_at, code=code, link=link))
    return out[:10]


@router.get("/mail/security-events", response_model=list[SecurityEvent])
async def mail_security_events(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[SecurityEvent]:
    """Sender domains and subjects of messages about an account, to match on the client."""
    _check_mail_scope(session)
    response.headers["Cache-Control"] = "no-store"
    out: list[SecurityEvent] = []
    for m in await _recent(db, session.user, datetime.now(timezone.utc) - SECURITY_WINDOW, 1000):
        kind = security_kind(m.subject)
        if kind:
            out.append(SecurityEvent(id=m.id, kind=kind, from_name=m.from_name, from_domain=_domain_of(m.from_addr), subject=m.subject[:200], at=m.sent_at))
    return out[:50]


class PlusRule(s._Base):
    address: str = Field(max_length=320)


@router.post("/mail/plus-rule", status_code=status.HTTP_201_CREATED)
async def plus_rule(body: PlusRule, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Mail sent to me+shop@… gets its own label, which shows who passed the address on."""
    from app.mail import rules
    from app.mail.models import MailLabel, MailRule
    from app.mail.router import _my_account_ids

    _check_mail_scope(session)
    if not await _my_account_ids(db, session.user):
        raise HTTPException(status.HTTP_409_CONFLICT, "Set up Mail first.")
    address = rules.normalise("to", body.address)
    m = re.match(r"^[^@+]+\+([^@]+)@", address or "")
    if address is None or m is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't a plus-address.")
    name = f"Plus addresses/{m.group(1)}"[:60]
    label = await db.scalar(select(MailLabel).where(MailLabel.user_id == session.user.id, MailLabel.name == name))
    if label is None:
        label = MailLabel(user_id=session.user.id, name=name)
        db.add(label)
        await db.flush()
    exists = await db.scalar(select(MailRule.id).where(MailRule.label_id == label.id, MailRule.kind == "to", MailRule.value == address))
    if exists is None:
        db.add(MailRule(user_id=session.user.id, label_id=label.id, kind="to", value=address))
    await db.commit()
    return {"label": name}


# ------------------------------------------------------------------ documents from Files


class DriveFile(s._Base):
    id: uuid.UUID
    name: str
    size_bytes: int
    mime_type: str


async def _my_file(db: AsyncSession, file_id: str, user: User):
    from app.files.models import UserFile

    row = await db.get(UserFile, parse_uuid(file_id))
    # Your own files only: a shared one isn't yours to move, and may not be yours to read.
    if row is None or row.user_id != user.id or row.trashed_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.get("/drive/files", response_model=list[DriveFile])
async def drive_files(q: str = "", session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[DriveFile]:
    from app.files.models import UserFile

    query = select(UserFile).where(UserFile.user_id == session.user.id, UserFile.trashed_at.is_(None), UserFile.size_bytes > 0, UserFile.size_bytes <= MAX_DOCUMENT_BYTES)
    if q.strip():
        query = query.where(func.lower(UserFile.original_filename).contains(q.strip().lower()[:100], autoescape=True))
    rows = (await db.execute(query.order_by(UserFile.created_at.desc()).limit(50))).scalars().all()
    return [DriveFile(id=r.id, name=r.original_filename, size_bytes=r.size_bytes, mime_type=r.mime_type) for r in rows]


@router.get("/drive/files/{file_id}/content")
async def drive_content(file_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Encrypted on the client from here on. The original stays until you say otherwise."""
    from app.files import storage

    row = await _my_file(db, file_id, session.user)
    if row.size_bytes > MAX_DOCUMENT_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "That file's too big to move into the vault.")
    path = storage.UPLOAD_ROOT / row.storage_path
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That file has no contents here.")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/drive/files/{file_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
async def drive_trash(file_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Into Files' own Trash, where it can still be got back for its usual time."""
    from app.files import router as files

    row = await _my_file(db, file_id, session.user)
    await files.trash_file(row.id, db=db, user=session.user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ a reminder in Calendar


class Reminder(s._Base):
    on: date


@router.post("/reminder", status_code=status.HTTP_201_CREATED)
async def add_reminder(body: Reminder, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Calendar can be read by the server, so the words are the same for everything."""
    from app.calendars.models import CalEvent
    from app.calendars.core import ensure_personal

    cal = await ensure_personal(db, session.user)
    start = datetime.combine(body.on, time(0, 0), tzinfo=timezone.utc)
    event = CalEvent(calendar_id=cal.id, created_by=session.user.id, title="Document expires soon", all_day=True, start_at=start, end_at=start + timedelta(days=1))
    db.add(event)
    await db.commit()
    return {"id": str(event.id)}


# ------------------------------------------------------------------ self-host survival


class Survival(s._Base):
    is_admin: bool
    kit_confirmed: bool
    kit_confirmed_at: datetime | None
    offsite_configured: bool
    last_backup_at: datetime | None
    backup_age_days: int | None


@router.get("/survival", response_model=Survival)
async def survival(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Survival:
    """What could lose you this vault, as far as the server can tell."""
    from app.backups.models import BackupRun, OffsiteBackupConfig

    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == session.user.id))
    last = await db.scalar(select(func.max(BackupRun.created_at)).where(BackupRun.status == "ok", BackupRun.kind.in_(("nightly", "manual", "offsite"))))
    cfg = await db.get(OffsiteBackupConfig, 1)
    enabled = bool(cfg and getattr(cfg, "enabled", False))
    age = (datetime.now(timezone.utc) - last).days if last else None
    return Survival(
        is_admin=session.user.role == "admin",
        kit_confirmed=bool(account and account.kit_confirmed_at),
        kit_confirmed_at=account.kit_confirmed_at if account else None,
        offsite_configured=enabled,
        last_backup_at=last,
        backup_age_days=age,
    )


__all__ = ["router", "extract_code", "extract_link", "security_kind", "plain_text"]
