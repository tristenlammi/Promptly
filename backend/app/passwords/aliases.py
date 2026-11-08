"""Aliases on your own domain, from the vault: set up a domain, make an alias for a
login, see what each alias gets, turn one off.

The tables and the mail side are in ``app/mail/aliases.py``. Nothing here reads
the vault: the client sends the alias's word (which ends up in the address anyway)
and, if you like, the vault item's opaque id. Never the site or the login's name.
"""
from __future__ import annotations

import asyncio
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.mail import aliases as al
from app.mail.models import MailAccount, MailFolder
from app.passwords import schemas as s
from app.passwords.deps import SCOPE_MAIL_CODES, VaultSession, require_enabled, require_session
from app.passwords.router import _QuietRoute

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])
CHECK_EVERY = timedelta(minutes=1)


def _mail_scope(session: VaultSession) -> None:
    """What an alias has received is read from mail, like mail codes."""
    if session.device is not None and SCOPE_MAIL_CODES not in (session.device.scopes or []):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This device can't read mail.")


async def _my_domain(db: AsyncSession, session: VaultSession, domain_id: uuid.UUID) -> al.MailAliasDomain:
    row = await db.get(al.MailAliasDomain, domain_id)
    if row is None or row.user_id != session.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


async def _my_account(db: AsyncSession, session: VaultSession, account_id: uuid.UUID) -> MailAccount:
    row = await db.get(MailAccount, account_id)
    if row is None or row.user_id != session.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That mailbox isn't one of yours.")
    return row


async def _my_alias(db: AsyncSession, session: VaultSession, alias_id: uuid.UUID) -> al.MailAlias:
    row = await db.get(al.MailAlias, alias_id)
    if row is None or row.user_id != session.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


def _expire_check(d: al.MailAliasDomain, account_email: str) -> None:
    if d.status == "checking" and d.check_started_at and datetime.now(timezone.utc) - d.check_started_at > al.CHECK_WAIT:
        d.status, d.check_local = "failed", ""
        d.status_detail = (
            f"The test message didn't arrive within {int(al.CHECK_WAIT.total_seconds() // 60)} minutes. Check that the catch-all "
            f"sends mail for {d.domain} to {account_email}, and look in that mailbox's Spam."
        )


async def _domain_out(db: AsyncSession, d: al.MailAliasDomain) -> dict[str, Any]:
    account = await db.get(MailAccount, d.account_id)
    email = account.email if account else ""
    _expire_check(d, email)
    count = await db.scalar(select(func.count()).select_from(al.MailAlias).where(al.MailAlias.domain_id == d.id))
    return {
        "id": str(d.id), "domain": d.domain, "account_id": str(d.account_id), "account_email": email,
        "word_style": d.word_style, "random_len": d.random_len, "separator": d.separator,
        "off_folder_id": str(d.off_folder_id) if d.off_folder_id else None,
        "status": d.status, "status_detail": d.status_detail, "checked_at": d.checked_at.isoformat() if d.checked_at else None,
        "send_as": d.send_as, "send_as_detail": d.send_as_detail, "aliases": count or 0,
    }


# ------------------------------------------------------------------ domains


@router.get("/aliases/accounts")
async def alias_accounts(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict[str, str]]:
    """Your connected mailboxes, to pick where an alias domain's mail lands."""
    rows = (await db.execute(select(MailAccount).where(MailAccount.user_id == session.user.id).order_by(MailAccount.position, MailAccount.created_at))).scalars()
    return [{"id": str(a.id), "email": a.email} for a in rows]


@router.get("/aliases/domains")
async def list_domains(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    response.headers["Cache-Control"] = "no-store"
    rows = (await db.execute(select(al.MailAliasDomain).where(al.MailAliasDomain.user_id == session.user.id).order_by(al.MailAliasDomain.created_at))).scalars().all()
    out = [await _domain_out(db, d) for d in rows]
    await db.commit()
    return out


class DomainIn(s._Base):
    domain: str = Field(max_length=253)
    account_id: uuid.UUID


@router.post("/aliases/domains", status_code=status.HTTP_201_CREATED)
async def add_domain(body: DomainIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    name = al.clean_domain(body.domain)
    if name is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use a domain you own, like example.com or mail.example.com.")
    account = await _my_account(db, session, body.account_id)
    have = await db.scalar(select(func.count()).select_from(al.MailAliasDomain).where(al.MailAliasDomain.user_id == session.user.id))
    if (have or 0) >= al.MAX_DOMAINS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Up to {al.MAX_DOMAINS} alias domains.")
    row = al.MailAliasDomain(user_id=session.user.id, account_id=account.id, domain=name)
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "You've already added that domain.") from None
    await db.refresh(row)
    return await _domain_out(db, row)


class DomainPatch(s._Base):
    account_id: uuid.UUID | None = None
    word_style: Literal["word", "site", "custom", "none"] | None = None
    random_len: int | None = Field(default=None, ge=3, le=12)
    separator: Literal[".", "-", "_"] | None = None
    off_folder_id: uuid.UUID | None = None
    off_to_trash: bool | None = None


@router.patch("/aliases/domains/{domain_id}")
async def edit_domain(domain_id: uuid.UUID, body: DomainPatch, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    d = await _my_domain(db, session, domain_id)
    if body.account_id is not None and body.account_id != d.account_id:
        d.account_id = (await _my_account(db, session, body.account_id)).id
        # A different mailbox needs its own check, and its own folder.
        d.status, d.status_detail, d.send_as, d.send_as_detail, d.off_folder_id = "new", "", "unknown", "", None
    if body.word_style is not None:
        d.word_style = body.word_style
    if body.random_len is not None:
        d.random_len = body.random_len
    if body.separator is not None:
        d.separator = body.separator
    if body.off_to_trash:
        d.off_folder_id = None
    elif body.off_folder_id is not None:
        folder = await db.get(MailFolder, body.off_folder_id)
        if folder is None or folder.account_id != d.account_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That folder isn't in this domain's mailbox.")
        d.off_folder_id = folder.id
    await db.commit()
    return await _domain_out(db, d)


@router.delete("/aliases/domains/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_domain(domain_id: uuid.UUID, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Its aliases go too. Mail already in your mailbox stays; nothing is sent anywhere."""
    d = await _my_domain(db, session, domain_id)
    await db.delete(d)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/aliases/domains/{domain_id}/folders")
async def domain_folders(domain_id: uuid.UUID, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict[str, str]]:
    d = await _my_domain(db, session, domain_id)
    rows = (await db.execute(select(MailFolder).where(MailFolder.account_id == d.account_id, MailFolder.role.not_in(("sent", "drafts"))).order_by(MailFolder.path))).scalars()
    return [{"id": str(f.id), "name": f.name, "path": f.path, "role": f.role} for f in rows]


def _test_message(sender: str, to: str, domain: str) -> EmailMessage:
    m = EmailMessage()
    m["From"] = formataddr(("Promptly alias check", sender))
    m["To"] = to
    m["Subject"] = f"Promptly: checking aliases on {domain}"
    m["Date"] = formatdate(localtime=False)
    m["Message-ID"] = make_msgid(domain=domain)
    m.set_content(
        f"This message checks that mail to an address on {domain} reaches this mailbox.\n"
        "Promptly moves it to Trash once it's seen it. You don't need to do anything.\n"
    )
    return m


async def _send(account: MailAccount, message: EmailMessage, to: str) -> None:
    from app.mail import worker

    await worker._smtp_send(account, message.as_bytes(), [to])


@router.post("/aliases/domains/{domain_id}/check")
async def check_domain(domain_id: uuid.UUID, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Sends a test from the mailbox to a random address on the domain, with an
    address on the domain as the sender. Mail then sees whether it arrives (the
    catch-all works) and what the From line says when it does (send-as works)."""
    import aiosmtplib

    from app.mail import imap
    from app.net.internal_hosts import may_reach_private_network

    d = await _my_domain(db, session, domain_id)
    account = await _my_account(db, session, d.account_id)
    # One email a minute at most: it goes to an address on a domain someone typed.
    if d.check_started_at and datetime.now(timezone.utc) - d.check_started_at < CHECK_EVERY:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Give the last check a minute first.")
    try:
        await asyncio.to_thread(imap.check_host, account.smtp_host, may_reach_private_network(session.user))
    except imap.MailError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from None
    local = al.CHECK_PREFIX + secrets.token_hex(5)
    to = f"{local}@{d.domain}"
    sender = f"{al.CHECK_SENDER_PREFIX}{secrets.token_hex(4)}@{d.domain}"
    d.check_local, d.check_started_at, d.status, d.status_detail = local, datetime.now(timezone.utc), "checking", ""
    try:
        try:
            await _send(account, _test_message(sender, to, d.domain), to)
            d.check_from = sender
        except aiosmtplib.SMTPResponseException as e:
            if not al.sender_refused(e.code, e.message):
                raise
            d.send_as = "refused"
            d.send_as_detail = (
                f"Your provider refused to send as an address on {d.domain} ({e.code}). Replies from an alias won't work until "
                f"you add {d.domain} as a 'send as' address or alias domain in the provider's settings."
            )[:300]
            # Still worth knowing whether mail arrives.
            await _send(account, _test_message(account.email, to, d.domain), to)
            d.check_from = account.email
    except aiosmtplib.SMTPRecipientsRefused:
        d.status, d.check_local = "failed", ""
        d.status_detail = f"Your provider refused to send to {d.domain}. Check the domain's MX records point at your mail provider."
    except (aiosmtplib.SMTPException, OSError, imap.MailError) as e:
        d.status, d.check_local = "failed", ""
        d.status_detail = f"Couldn't send the test message ({type(e).__name__}). Check the mailbox can send from Mail."
    await db.commit()
    return await _domain_out(db, d)


# ------------------------------------------------------------------ aliases


@router.get("/aliases")
async def list_aliases(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    _mail_scope(session)
    response.headers["Cache-Control"] = "no-store"
    rows = (await db.execute(
        select(al.MailAlias, al.MailAliasDomain).join(al.MailAliasDomain, al.MailAliasDomain.id == al.MailAlias.domain_id)
        .where(al.MailAlias.user_id == session.user.id).order_by(al.MailAlias.created_at.desc()).limit(al.MAX_ALIASES)
    )).all()
    counted = await al.stats(db, [a.id for a, _ in rows])
    return [al.alias_out(a, d, counted.get(a.id)) for a, d in rows]


class AliasIn(s._Base):
    domain_id: uuid.UUID
    word: str = Field(default="", max_length=60)
    item_id: uuid.UUID | None = None


@router.post("/aliases", status_code=status.HTTP_201_CREATED)
async def make_alias(body: AliasIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """The word comes from the client (a random word, the site's name or your own, as
    you chose); the random part is made here."""
    d = await _my_domain(db, session, body.domain_id)
    have = await db.scalar(select(func.count()).select_from(al.MailAlias).where(al.MailAlias.user_id == session.user.id))
    if (have or 0) >= al.MAX_ALIASES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Up to {al.MAX_ALIASES} aliases.")
    for _ in range(8):
        local = al.make_local(body.word, d.random_len, d.separator)
        if local.startswith(("promptly-check", "promptly-sender")):
            continue
        row = al.MailAlias(user_id=session.user.id, domain_id=d.id, address=f"{local}@{d.domain}", item_id=body.item_id)
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            continue
        await db.refresh(row)
        return al.alias_out(row, d, None)
    raise HTTPException(status.HTTP_409_CONFLICT, "Couldn't find a free address. Try a longer random part.")


class AliasPatch(s._Base):
    enabled: bool | None = None
    item_id: uuid.UUID | None = None
    unlink: bool | None = None


@router.patch("/aliases/{alias_id}")
async def edit_alias(alias_id: uuid.UUID, body: AliasPatch, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    a = await _my_alias(db, session, alias_id)
    if body.enabled is not None:
        await al.set_enabled(db, a, body.enabled)
    if body.unlink:
        a.item_id = None
    elif body.item_id is not None:
        a.item_id = body.item_id
    await db.commit()
    d = await db.get(al.MailAliasDomain, a.domain_id)
    return al.alias_out(a, d, (await al.stats(db, [a.id])).get(a.id))


class AllowIn(s._Base):
    sender: str = Field(max_length=253)


@router.post("/aliases/{alias_id}/allow")
async def allow_sender(alias_id: uuid.UUID, body: AllowIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """'This sender is fine': it stops counting as a sign of a leak."""
    _mail_scope(session)
    a = await _my_alias(db, session, alias_id)
    sender = body.sender.strip().lower().removeprefix("@")
    if not sender or " " in sender or "." not in sender:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't a domain.")
    allowed = list(a.allowed_senders or [])
    if sender not in allowed:
        allowed.append(sender)
    a.allowed_senders = allowed[-50:]
    rows = (await db.execute(select(al.MailAliasHit).where(al.MailAliasHit.alias_id == a.id, al.MailAliasHit.unlike.is_(True)))).scalars().all()
    for r in rows:
        if any(al.same_business(r.sender_domain, ok) for ok in a.allowed_senders):
            r.unlike = False
    still = [r.sender_domain for r in rows if r.unlike]
    a.flagged_sender = still[0] if still else ""
    if not still:
        a.flagged_at = None
    await db.commit()
    d = await db.get(al.MailAliasDomain, a.domain_id)
    return al.alias_out(a, d, (await al.stats(db, [a.id])).get(a.id))


@router.delete("/aliases/{alias_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_alias(alias_id: uuid.UUID, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Forgotten here. Mail to it still arrives through the catch-all; it just isn't
    counted, flagged or moved any more. Turn it off instead to keep it out."""
    a = await _my_alias(db, session, alias_id)
    await db.delete(a)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
