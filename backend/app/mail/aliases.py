"""Aliases on a domain you own: a different address for every login.

Promptly Mail isn't a mail server. You point a domain (or a subdomain) you own at
your mail provider with a catch-all, so mail to anything@thatdomain lands in a
mailbox Mail already reads. This module then:

* notices which alias a new email was sent to (To, Cc, Delivered-To, X-Original-To
  and friends), counts it, and flags a sender that doesn't look like the first
  one the alias heard from: a sign the address was sold or leaked;
* moves new mail for an alias you've turned off to Trash, or a folder you chose,
  through the same moves rules use (a client can't refuse mail);
* finishes the setup check when its test message arrives;
* swaps the From line when you reply from an alias.

What the server holds here is plaintext on purpose: the alias address is needed to
route mail. It never holds the login's site or name: those stay in the vault, and
the vault compares them itself (passwords/SECURITY.md).
"""
from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.parser import BytesHeaderParser
from email.policy import default as default_policy
from email.utils import formataddr, getaddresses, make_msgid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import rules
from .alias_models import MailAlias, MailAliasDomain, MailAliasHit
from .models import MailAccount, MailFolder, MailMessage

# ------------------------------------------------------------------ addresses

MAX_DOMAINS = 10
MAX_ALIASES = 5000
CHECK_PREFIX = "promptly-check-"
CHECK_SENDER_PREFIX = "promptly-sender-"
CHECK_WAIT = timedelta(minutes=10)
# No 0/o, 1/l/i: an alias gets read out over the phone sometimes.
RANDOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
SEPARATORS = (".", "-", "_")
_DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_LOCAL = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
# Not yours to catch everything for, however it's set up.
SHARED_PROVIDERS = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
    "mail.com", "zoho.com", "yandex.com", "fastmail.com", "tutanota.com", "tuta.io", "hey.com",
})
# Two-part endings where the name is the label before them. Not the whole Public
# Suffix List: this only has to say whether two senders are the same business.
_TWO_PART = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "org.nz", "net.nz", "co.jp", "ne.jp", "or.jp", "com.br", "net.br", "com.mx", "com.ar", "co.za", "co.in",
    "net.in", "org.in", "com.sg", "com.hk", "com.tw", "com.cn", "co.kr", "com.tr", "co.il", "com.my", "co.id", "com.ph",
})
# A sender address can be any of these.
_ENVELOPE_HEADERS = ("Delivered-To", "X-Original-To", "X-Forwarded-To", "Envelope-To", "X-Envelope-To", "X-Original-Recipient", "To", "Cc")


def clean_domain(raw: str) -> str | None:
    d = raw.strip().lower().rstrip(".").removeprefix("@")
    try:
        d = d.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    if not _DOMAIN.match(d) or d in SHARED_PROVIDERS or any(d.endswith("." + p) for p in SHARED_PROVIDERS):
        return None
    return d


def clean_word(raw: str) -> str:
    """Letters and digits only, lower case, short. Empty is allowed: then it's all random."""
    return re.sub(r"[^a-z0-9]+", "", raw.lower())[:20]


def random_part(length: int) -> str:
    return "".join(secrets.choice(RANDOM_ALPHABET) for _ in range(max(3, min(12, length))))


def make_local(word: str, length: int, separator: str) -> str:
    """``shop.k7m2``: a word you'll recognise, then a part nobody can guess."""
    w = clean_word(word)
    sep = separator if separator in SEPARATORS else "."
    if not w:
        return random_part(max(length, 8))
    return f"{w}{sep}{random_part(length)}"


def registrable(domain: str) -> str:
    parts = [p for p in domain.lower().strip(".").split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    tail = ".".join(parts[-2:])
    return ".".join(parts[-3:]) if tail in _TWO_PART else tail


def brand(domain: str) -> str:
    """``email.shop.co.uk`` -> ``shop``."""
    return registrable(domain).split(".")[0]


def same_business(a: str, b: str) -> bool:
    """Loose on purpose: ``amazonses.com`` mails for ``amazon.com``, and
    ``mail.example.com`` for ``example.com``. A miss costs a flag you can clear."""
    ba, bb = brand(a), brand(b)
    if not ba or not bb:
        return False
    if ba == bb:
        return True
    shorter, longer = sorted((ba, bb), key=len)
    return len(shorter) >= 4 and shorter in longer


def domain_of(addr: str) -> str:
    return addr.rsplit("@", 1)[-1].strip().lower() if "@" in addr else ""


def recipients(raw: bytes) -> list[str]:
    """Every address this email says it went to, from the headers only. A catch-all
    keeps the alias in To, or in Delivered-To / X-Original-To when it was a Bcc."""
    try:
        headers = BytesHeaderParser(policy=default_policy).parsebytes(raw[:256 * 1024])
    except Exception:  # noqa: BLE001 — a broken header just means no alias found
        return []
    out: list[str] = []
    for name in _ENVELOPE_HEADERS:
        try:
            values = [str(v) for v in headers.get_all(name, [])]
        except Exception:  # noqa: BLE001
            continue
        for _, addr in getaddresses(values):
            a = addr.strip().lower()
            if "@" in a and a not in out:
                out.append(a)
    return out[:200]


# ------------------------------------------------------------------ mail arriving


def _msg_key(m: MailMessage) -> str:
    return (m.message_id or f"id:{m.id}")[:500]


async def _off_target(db: AsyncSession, domain: MailAliasDomain) -> MailFolder | None:
    if domain.off_folder_id:
        chosen = await db.get(MailFolder, domain.off_folder_id)
        if chosen is not None and chosen.account_id == domain.account_id:
            return chosen
    return await db.scalar(select(MailFolder).where(MailFolder.account_id == domain.account_id, MailFolder.role == "trash").limit(1))


async def _finish_check(db: AsyncSession, domain: MailAliasDomain, m: MailMessage, folder: MailFolder) -> None:
    now = datetime.now(timezone.utc)
    domain.status, domain.checked_at, domain.check_local = "ok", now, ""
    domain.status_detail = "The test arrived in Spam. Mark it as not spam so alias mail reaches your Inbox." if folder.role == "spam" else ""
    sent_from = domain.check_from.lower()
    if sent_from.endswith("@" + domain.domain):
        if m.from_addr.lower() == sent_from:
            domain.send_as, domain.send_as_detail = "ok", ""
        else:
            domain.send_as = "rewritten"
            domain.send_as_detail = (
                f"Your provider changed the sender to {m.from_addr[:120] or 'another address'}. Replies from an alias would show "
                "that address instead. Most providers let you add the domain as a 'send as' address in their settings."
            )
    m.seen = True


async def on_arrival(db: AsyncSession, account_id: uuid.UUID, folder: MailFolder, arrived: list[tuple[MailMessage, list[str]]], fresh: bool) -> set[uuid.UUID]:
    """Runs as mail is copied in, before rules. Returns what it filed away, which then
    doesn't go through rules or interrupt anyone. ``fresh``: new mail, as opposed to
    older mail being copied in for the first time."""
    if not arrived or folder.role in ("sent", "drafts", "trash"):
        return set()
    account = await db.get(MailAccount, account_id)
    if account is None:
        return set()
    domains = {
        d.domain: d
        for d in (await db.execute(select(MailAliasDomain).where(MailAliasDomain.account_id == account_id, MailAliasDomain.user_id == account.user_id))).scalars()
    }
    if not domains:
        return set()
    filed: set[uuid.UUID] = set()
    for m, said in arrived:
        to = said or [p.get("addr", "").lower() for p in [*(m.to_addrs or []), *(m.cc_addrs or [])]]
        ours = [a for a in to if domain_of(a) in domains]
        for addr in ours:
            domain = domains[domain_of(addr)]
            local = addr.split("@", 1)[0]
            if domain.check_local and local == domain.check_local:
                await _finish_check(db, domain, m, folder)
                # Tidied away: you don't need to read it.
                trash = await db.scalar(select(MailFolder).where(MailFolder.account_id == account_id, MailFolder.role == "trash").limit(1))
                if folder.role == "inbox" and trash is not None and m.message_id:
                    rules.move(db, {folder.id: folder}, [m], trash)
                filed.add(m.id)
                break
            alias = await db.scalar(select(MailAlias).where(MailAlias.user_id == account.user_id, MailAlias.domain_id == domain.id, MailAlias.address == addr))
            if alias is None:
                continue
            await _record(db, alias, m, account_id, fresh, folder, domain, filed)
            break
    return filed


async def _record(db: AsyncSession, alias: MailAlias, m: MailMessage, account_id: uuid.UUID, fresh: bool, folder: MailFolder, domain: MailAliasDomain, filed: set[uuid.UUID]) -> None:
    sender = domain_of(m.from_addr)[:253]
    # Your own replies from the alias aren't someone else having it.
    own = sender == domain.domain
    unlike = False
    if sender and not own:
        if not alias.baseline:
            alias.baseline = registrable(sender)
        elif not same_business(sender, alias.baseline) and not any(same_business(sender, ok) for ok in alias.allowed_senders or []):
            unlike = True
    statement = insert(MailAliasHit).values(alias_id=alias.id, msg_key=_msg_key(m), account_id=account_id, sender_domain=sender, sent_at=m.sent_at, unlike=unlike)
    first_time = (await db.execute(statement.on_conflict_do_nothing().returning(MailAliasHit.alias_id))).first() is not None
    if not first_time:
        return
    if unlike and alias.flagged_at is None:
        alias.flagged_at, alias.flagged_sender = datetime.now(timezone.utc), sender
    # Off: new mail goes, once. Moving it back yourself keeps it where you put it.
    if not alias.enabled and folder.role == "inbox" and (fresh or (alias.disabled_at and m.sent_at >= alias.disabled_at)):
        target = await _off_target(db, domain)
        if target is not None and m.message_id:
            rules.move(db, {folder.id: folder}, [m], target)
            filed.add(m.id)


# ------------------------------------------------------------------ replying from an alias


async def alias_for_sending(db: AsyncSession, user: User, account: MailAccount, address: str) -> tuple[MailAlias, MailAliasDomain]:
    a = address.strip().lower()
    found = (await db.execute(
        select(MailAlias, MailAliasDomain).join(MailAliasDomain, MailAliasDomain.id == MailAlias.domain_id)
        .where(MailAlias.user_id == user.id, MailAlias.address == a, MailAliasDomain.account_id == account.id)
    )).first()
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="That alias isn't one of yours on this mailbox.")
    return found[0], found[1]


async def use_from(db: AsyncSession, user: User, account: MailAccount, message: EmailMessage, address: str) -> None:
    """The alias goes on the From line. The envelope stays the mailbox's own, which
    is what providers check when you log in to send."""
    alias, domain = await alias_for_sending(db, user, account, address)
    if domain.send_as == "refused":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"{account.email}'s provider won't send as {domain.domain}. {domain.send_as_detail}".strip(),
        )
    message.replace_header("From", formataddr((account.display_name, alias.address)))
    # A Message-ID names the domain it came from: this one shouldn't name your mailbox's.
    message.replace_header("Message-ID", make_msgid(domain=domain.domain))


def sender_refused(code: int, text: str) -> bool:
    """Did the provider turn this down because of who it says it's from?"""
    t = text.lower()
    return code in (550, 551, 553, 554, 530, 535) and any(
        w in t for w in ("sender", "from", "not owned", "not allowed", "not permitted", "authori", "spoof", "5.7.1", "5.7.60", "send as", "sendas", "mailbox name")
    )


# ------------------------------------------------------------------ for Mail

router = APIRouter()


def _send_as_text(d: MailAliasDomain) -> str:
    return {
        "ok": "",
        "unknown": "Not checked yet: run the check in Passwords → Aliases.",
        "rewritten": d.send_as_detail,
        "refused": d.send_as_detail,
    }.get(d.send_as, "")


async def stats(db: AsyncSession, alias_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    if not alias_ids:
        return {}
    out: dict[uuid.UUID, dict[str, Any]] = {a: {"count": 0, "last_at": None, "senders": []} for a in alias_ids}
    rows = (await db.execute(
        select(MailAliasHit.alias_id, MailAliasHit.sender_domain, func.count(), func.max(MailAliasHit.sent_at), func.bool_or(MailAliasHit.unlike))
        .where(MailAliasHit.alias_id.in_(alias_ids)).group_by(MailAliasHit.alias_id, MailAliasHit.sender_domain)
    )).all()
    for alias_id, sender, n, last, unlike in rows:
        s = out[alias_id]
        s["count"] += n
        if s["last_at"] is None or last > s["last_at"]:
            s["last_at"] = last
        s["senders"].append({"domain": sender, "count": n, "last_at": last.isoformat(), "unlike": bool(unlike)})
    for s in out.values():
        s["senders"].sort(key=lambda x: -x["count"])
        s["senders"] = s["senders"][:20]
        s["last_at"] = s["last_at"].isoformat() if s["last_at"] else None
    return out


@router.get("/aliases/thread/{account_id}/{key}")
async def thread_aliases(account_id: uuid.UUID, key: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Which alias each email in a conversation went to. Your own mailbox only."""
    account = await db.get(MailAccount, account_id)
    if account is None or account.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    messages = (await db.execute(select(MailMessage.id, MailMessage.message_id).where(MailMessage.account_id == account_id, MailMessage.thread_key == key))).all()
    keys = {(mid or f"id:{rid}")[:500]: rid for rid, mid in messages}
    if not keys:
        return {"messages": {}, "aliases": {}}
    hits = (await db.execute(
        select(MailAliasHit.msg_key, MailAlias, MailAliasDomain)
        .join(MailAlias, MailAlias.id == MailAliasHit.alias_id).join(MailAliasDomain, MailAliasDomain.id == MailAlias.domain_id)
        .where(MailAliasHit.account_id == account_id, MailAliasHit.msg_key.in_(list(keys)), MailAlias.user_id == user.id)
    )).all()
    counted = await stats(db, list({a.id for _, a, _ in hits}))
    aliases: dict[str, Any] = {}
    by_message: dict[str, str] = {}
    for msg_key, alias, domain in hits:
        by_message[str(keys[msg_key])] = str(alias.id)
        aliases[str(alias.id)] = alias_out(alias, domain, counted.get(alias.id))
    return {"messages": by_message, "aliases": aliases}


def alias_out(alias: MailAlias, domain: MailAliasDomain, counted: dict[str, Any] | None) -> dict[str, Any]:
    c = counted or {"count": 0, "last_at": None, "senders": []}
    return {
        "id": str(alias.id), "address": alias.address, "domain_id": str(domain.id), "domain": domain.domain, "account_id": str(domain.account_id),
        "item_id": str(alias.item_id) if alias.item_id else None, "enabled": alias.enabled,
        "disabled_at": alias.disabled_at.isoformat() if alias.disabled_at else None, "created_at": alias.created_at.isoformat(),
        "baseline": alias.baseline, "allowed_senders": list(alias.allowed_senders or []),
        "flagged_at": alias.flagged_at.isoformat() if alias.flagged_at else None, "flagged_sender": alias.flagged_sender,
        "count": c["count"], "last_at": c["last_at"], "senders": c["senders"],
        "send_as": domain.send_as, "send_as_text": _send_as_text(domain),
    }


class AliasSwitch(BaseModel):
    enabled: bool


async def set_enabled(db: AsyncSession, alias: MailAlias, enabled: bool) -> None:
    if alias.enabled == enabled:
        return
    alias.enabled = enabled
    alias.disabled_at = None if enabled else datetime.now(timezone.utc)


@router.patch("/aliases/{alias_id}")
async def switch_alias(alias_id: uuid.UUID, body: AliasSwitch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    alias = await db.get(MailAlias, alias_id)
    if alias is None or alias.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Alias not found.")
    await set_enabled(db, alias, body.enabled)
    await db.commit()
    domain = await db.get(MailAliasDomain, alias.domain_id)
    return alias_out(alias, domain, (await stats(db, [alias.id])).get(alias.id))
