"""Breach alerts: is one of your email addresses in a known data breach?

Uses Have I Been Pwned's ``breachedaccount`` API (v3) with a key the admin buys and
sets in Admin, Passwords. No key, no checks. Each person turns it on for themselves:
their addresses go from this server to HIBP, and that's theirs to agree to
(passwords/DECISIONS.md, D-ALERTS-3).

Checked: the account's own address and the person's connected Mail accounts. An arq
job works through them every ten minutes, no faster than the key's requests per
minute, each address about once a day. It keeps, per address, only the breach's name
and dates. A breach that wasn't there last time is pushed through the usual
notifications.

Breach data is from Have I Been Pwned (haveibeenpwned.com), licensed CC BY 4.0, which
asks for clear credit with a link wherever it's shown.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import decrypt_secret, encrypt_secret
from app.breach_watch.models import BreachAddress, BreachCatalog, BreachConfig, BreachHit, BreachWatch
from app.notifications.dispatch import notify_user

logger = logging.getLogger("promptly.breach_watch")

HIBP_BASE = "https://haveibeenpwned.com/api/v3"
USER_AGENT = "Promptly-Breach-Alerts"
ATTRIBUTION = "Breach data from Have I Been Pwned (haveibeenpwned.com), licensed CC BY 4.0."
RECHECK = timedelta(days=1)
RETRY_SOON = timedelta(hours=1)
# A run stays well inside the ten minutes between runs, so two never overlap.
RUN_SECONDS = 8 * 60
# A little slower than the key allows, since HIBP's clock isn't ours.
MARGIN = 1.1
MAX_RETRY_AFTER = 120
KEY_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")


class Stop(Exception):
    """Stop this run: the key's refused, or HIBP keeps saying slow down."""

    def __init__(self, reason: str, *, pause: timedelta | None = None, alert: bool = False) -> None:
        super().__init__(reason)
        self.reason, self.pause, self.alert = reason, pause, alert


def client() -> httpx.AsyncClient:
    """Tests swap this for one with a mock transport. Never the real API in a test."""
    return httpx.AsyncClient(base_url=HIBP_BASE, timeout=20, follow_redirects=False)


async def config(db: AsyncSession) -> BreachConfig:
    row = await db.get(BreachConfig, 1)
    if row is None:
        await db.execute(insert(BreachConfig).values(id=1).on_conflict_do_nothing())
        await db.flush()
        row = await db.get(BreachConfig, 1)
    return row


def seal_key(key: str) -> str:
    return encrypt_secret(key)


def key_of(cfg: BreachConfig) -> str | None:
    if not cfg.api_key_encrypted:
        return None
    try:
        return decrypt_secret(cfg.api_key_encrypted)
    except ValueError:
        return None  # SECRET_KEY changed: the admin sets it again.


def mask(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:1]}…@{domain}" if domain else "an address of yours"


def _clean(address: str | None) -> str | None:
    a = (address or "").strip().lower()
    return a if 3 <= len(a) <= 320 and "@" in a and " " not in a else None


async def addresses_for(db: AsyncSession, user: User) -> dict[str, str]:
    """What would be checked for this person: address -> where it's from."""
    from app.mail.models import MailAccount

    out: dict[str, str] = {}
    mine = _clean(user.email)
    if mine:
        out[mine] = "account"
    for email in (await db.execute(select(MailAccount.email).where(MailAccount.user_id == user.id))).scalars():
        a = _clean(email)
        if a and a not in out:
            out[a] = "mail"
    return out


async def sync_addresses(db: AsyncSession, user: User, now: datetime) -> None:
    """Bring the person's rows in line with their addresses now. A removed address takes its hits with it."""
    wanted = await addresses_for(db, user)
    have = {r.address: r for r in (await db.execute(select(BreachAddress).where(BreachAddress.user_id == user.id))).scalars()}
    for address, source in wanted.items():
        if address in have:
            have[address].source = source
        else:
            db.add(BreachAddress(user_id=user.id, address=address, source=source, next_check_at=now))
    gone = [a for a in have if a not in wanted]
    if gone:
        await db.execute(delete(BreachAddress).where(BreachAddress.user_id == user.id, BreachAddress.address.in_(gone)))
        await db.execute(delete(BreachHit).where(BreachHit.user_id == user.id, BreachHit.address.in_(gone)))
    await db.flush()


async def turn_on(db: AsyncSession, user: User) -> None:
    await db.execute(insert(BreachWatch).values(user_id=user.id).on_conflict_do_nothing())
    await sync_addresses(db, user, datetime.now(timezone.utc))


async def forget(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Off means forgotten: the addresses and what was found go."""
    await db.execute(delete(BreachHit).where(BreachHit.user_id == user_id))
    await db.execute(delete(BreachAddress).where(BreachAddress.user_id == user_id))
    await db.execute(delete(BreachWatch).where(BreachWatch.user_id == user_id))


# ------------------------------------------------------------------ talking to HIBP


async def query(http: httpx.AsyncClient, key: str, address: str, sleep=asyncio.sleep) -> list[dict[str, Any]] | None:  # noqa: ANN001
    """The breaches this address is in ([] for none), or None to try again later."""
    for _attempt in range(3):
        try:
            r = await http.get(
                f"/breachedaccount/{quote(address, safe='')}",
                params={"truncateResponse": "false"},
                headers={"hibp-api-key": key, "user-agent": USER_AGENT},
            )
        except httpx.HTTPError:
            return None
        if r.status_code == 404:
            return []
        if r.status_code == 200:
            try:
                got = r.json()
            except ValueError:
                return None
            return [b for b in got if isinstance(b, dict)] if isinstance(got, list) else None
        if r.status_code == 429:
            try:
                wait = int(r.headers.get("retry-after", "2"))
            except ValueError:
                wait = 2
            await sleep(min(max(wait, 1), MAX_RETRY_AFTER) + 1)
            continue
        if r.status_code == 401:
            raise Stop("Have I Been Pwned refused the key. Check it in Admin, Passwords.", alert=True)
        if r.status_code == 403:
            raise Stop("Have I Been Pwned refused the request (403).", pause=timedelta(hours=1))
        if r.status_code == 400:
            return []  # Not an address HIBP takes, so nothing it could know about.
        return None
    raise Stop("Have I Been Pwned kept saying too many requests.", pause=timedelta(minutes=10))


async def check_key(key: str) -> dict[str, Any] | None:
    """The key's plan and rate limit, from HIBP. None if HIBP couldn't be asked."""
    async with client() as http:
        try:
            r = await http.get("/subscription/status", headers={"hibp-api-key": key, "user-agent": USER_AGENT})
        except httpx.HTTPError:
            return None
    if r.status_code == 401:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Have I Been Pwned says that key isn't valid.")
    if r.status_code != 200:
        return None
    try:
        body = r.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


# ------------------------------------------------------------------ recording what came back


def _date(raw: Any) -> date | None:
    try:
        return date.fromisoformat(str(raw)[:10]) if raw else None
    except ValueError:
        return None


def _instant(raw: Any) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(raw).replace("Z", "+00:00")) if raw else None
    except ValueError:
        return None
    return d.replace(tzinfo=d.tzinfo or timezone.utc) if d else None


async def _catalog(db: AsyncSession, name: str, b: dict[str, Any]) -> None:
    classes = [str(c)[:80] for c in (b.get("DataClasses") or []) if isinstance(c, str)][:30]
    values = {
        "title": str(b.get("Title") or name)[:200],
        "domain": str(b.get("Domain") or "")[:200].lower(),
        "data_classes": classes,
        "verified": bool(b.get("IsVerified", True)),
    }
    await db.execute(insert(BreachCatalog).values(name=name, **values).on_conflict_do_update(index_elements=["name"], set_={**values, "updated_at": datetime.now(timezone.utc)}))


def _what(classes: list[str]) -> str:
    if not classes:
        return ""
    shown = ", ".join(c.lower() for c in classes[:5])
    return f" It exposed {shown}{' and more' if len(classes) > 5 else ''}."


async def record(db: AsyncSession, row: BreachAddress, breaches: list[dict[str, Any]], now: datetime) -> int:
    """Store names and dates, drop what HIBP no longer lists, and tell the person what's new.
    The first check of an address sends one summary rather than a push per old breach."""
    first = row.checked_at is None
    have = {h.name: h for h in (await db.execute(select(BreachHit).where(BreachHit.user_id == row.user_id, BreachHit.address == row.address))).scalars()}
    seen: set[str] = set()
    new: list[dict[str, Any]] = []
    for b in breaches:
        name = str(b.get("Name") or "")[:200]
        if not name or name in seen:
            continue
        seen.add(name)
        await _catalog(db, name, b)
        if name not in have:
            db.add(BreachHit(user_id=row.user_id, address=row.address, name=name, breach_date=_date(b.get("BreachDate")), added_date=_instant(b.get("AddedDate")), found_at=now))
            new.append(b)
    for name, hit in have.items():
        if name not in seen:
            await db.delete(hit)
    await db.flush()

    who = mask(row.address)
    if first:
        if not seen:
            return 0
        n = len(seen)
        await notify_user(
            user_id=row.user_id, category="passwords", title="Breach alerts are on",
            body=f"{who} is in {n} known data breach{'es' if n != 1 else ''}. Passwords, Security lists them and what to change. Source: Have I Been Pwned.",
            url="/passwords#/security", tag=f"pw-breach-first-{row.id}"[:120],
        )
        return 1
    if len(new) > 3:
        await notify_user(
            user_id=row.user_id, category="passwords", title=f"{who} is in {len(new)} new data breaches",
            body="Passwords, Security lists them, with the change helper for each site. Source: Have I Been Pwned.",
            url="/passwords#/security", tag=f"pw-breach-many-{row.id}"[:120],
        )
        return 1
    for b in new:
        title = str(b.get("Title") or b.get("Name"))[:80]
        when = _date(b.get("BreachDate"))
        site = str(b.get("Domain") or "").lower() or title
        classes = [c for c in (b.get("DataClasses") or []) if isinstance(c, str)]
        await notify_user(
            user_id=row.user_id, category="passwords", title=f"New data breach: {title}",
            body=(
                f"{who} was in the {title} breach{f' of {when.isoformat()}' if when else ''}.{_what(classes)} "
                f"If you have a login at {site}, change that password. Passwords, Security walks you through it. Source: Have I Been Pwned."
            ),
            url="/passwords#/security", tag=f"pw-breach-{b.get('Name')}"[:120],
        )
    return len(new)


# ------------------------------------------------------------------ the job


async def _passwords_on(db: AsyncSession) -> bool:
    """Passwords' own off switch stops this too. Read plainly: this module doesn't import Passwords."""
    row = (await db.execute(text("SELECT enabled FROM pw_settings WHERE id = 1"))).first()
    return True if row is None else bool(row[0])


async def run_checks(db: AsyncSession, *, sleep=asyncio.sleep, now: datetime | None = None, clock=time.monotonic) -> dict[str, Any]:  # noqa: ANN001
    """One run: due addresses, at most the key's rate, for at most RUN_SECONDS."""
    now = now or datetime.now(timezone.utc)
    cfg = await config(db)
    key = key_of(cfg)
    if not key:
        await db.commit()
        return {"skipped": "no key"}
    if not await _passwords_on(db):
        return {"skipped": "passwords off"}
    if cfg.paused_until and cfg.paused_until > now:
        return {"skipped": "paused"}
    for watch in (await db.execute(select(BreachWatch))).scalars().all():
        user = await db.get(User, watch.user_id)
        if user is not None:
            await sync_addresses(db, user, now)
    await db.commit()

    rpm = max(1, cfg.rpm or 1)
    interval = 60.0 / rpm * MARGIN
    budget = int(rpm * RUN_SECONDS / 60 / MARGIN)
    due = (
        await db.execute(
            select(BreachAddress)
            .join(BreachWatch, BreachWatch.user_id == BreachAddress.user_id)
            .join(User, User.id == BreachAddress.user_id)
            .where(BreachAddress.next_check_at <= now, User.disabled.is_(False))
            .order_by(BreachAddress.next_check_at, BreachAddress.id)
            .limit(budget)
        )
    ).scalars().all()
    started = clock()
    answers: dict[str, list[dict[str, Any]] | None] = {}
    calls = checked = notified = 0
    stopped: Stop | None = None
    async with client() as http:
        for row in due:
            if row.address not in answers:
                if clock() - started > RUN_SECONDS:
                    break
                if calls:
                    await sleep(interval)
                calls += 1
                try:
                    answers[row.address] = await query(http, key, row.address, sleep)
                except Stop as e:
                    stopped = e
                    break
            got = answers[row.address]
            if got is None:
                row.next_check_at = now + RETRY_SOON
            else:
                notified += await record(db, row, got, now)
                row.checked_at = now
                row.next_check_at = now + RECHECK
                checked += 1
            await db.commit()

    cfg = await config(db)
    cfg.last_run_at = now
    if stopped is not None:
        if stopped.alert and cfg.last_error != stopped.reason:
            await _tell_admins(db, stopped.reason)
        cfg.last_error = stopped.reason
        cfg.paused_until = now + stopped.pause if stopped.pause else None
    else:
        cfg.last_error = None
        cfg.paused_until = None
    await db.commit()
    return {"calls": calls, "checked": checked, "notified": notified, "stopped": stopped.reason if stopped else None}


async def _tell_admins(db: AsyncSession, reason: str) -> None:
    for uid in (await db.execute(select(User.id).where(User.role == "admin", User.disabled.is_(False)))).scalars():
        await notify_user(user_id=uid, category="system_alert", title="Breach alerts stopped", body=reason, url="/admin", tag="pw-breach-key")


async def breach_tick(ctx: Any = None) -> dict[str, Any]:
    """arq cron entry, every ten minutes."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        try:
            return await run_checks(db)
        except Exception:
            logger.exception("breach check run failed")
            raise


__all__ = ["run_checks", "breach_tick", "query", "record", "mask", "config", "key_of", "seal_key", "check_key", "addresses_for", "turn_on", "forget", "ATTRIBUTION", "KEY_PATTERN"]
