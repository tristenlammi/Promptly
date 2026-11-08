"""Telling people about new answers (WP-F1.4).

Who hears about a form's answers: its owner (each answer, unless they
chose otherwise) and anyone else who can see the answers and asked to
(``form_notify.mode``: ``each`` / ``daily`` / ``off``). Everyone is checked
against :func:`app.forms.access.form_access` at send time.

What they hear is **counts only** — "BBQ RSVP · 6 new answers", never a word
anyone wrote in an answer (a stranger's words don't belong on a lock
screen). Each push is a running total with the tag ``form:<id>``, so on the
device it replaces the last one; the inbox keeps one unread row per form
(``dispatch.RULES['form_response'].coalesce``).

* **Each time** — pushed straight away, at most once a minute per person
  and form: answers inside that minute become one trailing push with the
  total.
* **Once a day** — held for the daily summary (``notifications/loops.py``),
  where it reads "6 new answers in Forms". Held pushes coalesce per form.
* **Daily email** (``email_daily``) — one email a day at the person's
  Today summary time, counts only, through the server's SMTP
  (:func:`send_email_digests`, the ``forms_digest`` cron).
* **Closed** — the owner hears once when a form closes by itself (its
  closing time: :func:`close_tick`; its answer limit: inline in submit).
  ``forms.close_pushed_at`` keeps that to once until it opens again.

Looking at the Responses tab (``POST /forms/{id}/seen``) resets "new": the
counts restart, the held push for that form is dropped and its inbox row is
marked read.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms.access import form_access, is_closed
from app.forms.models import Form, FormNotify, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User

logger = logging.getLogger("promptly.forms.notify")

UTC = timezone.utc
Mode = Literal["each", "daily", "off"]
MODES: tuple[str, ...] = ("each", "daily", "off")
#: Seconds between two "new answers" pushes to one person for one form.
PUSH_GAP = 60
CATEGORY = "form_response"


def responses_url(shell_id: uuid.UUID) -> str:
    return f"/files/form/{shell_id}?tab=responses"


def tag_for(form_id: uuid.UUID) -> str:
    return f"form:{form_id}"


def _title(form: Form) -> str:
    return str((form.definition or {}).get("title") or "Untitled form")


def answers_words(n: int) -> str:
    return f"{n} new answer" if n == 1 else f"{n} new answers"


# --------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------
async def row_for(db: AsyncSession, form: Form, user_id: uuid.UUID) -> FormNotify | None:
    return await db.get(FormNotify, (form.id, user_id))


def default_mode(shell: UserFile, user_id: uuid.UUID) -> str:
    """The owner hears about each answer; others only when they ask."""
    return "each" if shell.user_id == user_id else "off"


async def settings_for(db: AsyncSession, shell: UserFile, form: Form, user: User) -> dict[str, Any]:
    from app.calendars.reach import smtp_ready

    row = await row_for(db, form, user.id)
    return {
        "mode": row.mode if row is not None else default_mode(shell, user.id),
        "email_daily": bool(row.email_daily) if row is not None else False,
        "can_email": await smtp_ready(db),
    }


async def _ensure_row(db: AsyncSession, shell: UserFile, form: Form, user_id: uuid.UUID) -> FormNotify:
    row = await row_for(db, form, user_id)
    if row is None:
        row = FormNotify(form_id=form.id, user_id=user_id, mode=default_mode(shell, user_id))
        db.add(row)
        await db.flush()
    return row


async def set_settings(
    db: AsyncSession, shell: UserFile, form: Form, user: User, *, mode: str | None, email_daily: bool | None
) -> FormNotify:
    """Change your own notification choice for a form (the caller commits)."""
    row = await _ensure_row(db, shell, form, user.id)
    if mode is not None:
        row.mode = mode
    if email_daily is not None:
        if email_daily and not row.email_daily:
            # The first email covers from now, not everything ever.
            row.emailed_at = datetime.now(UTC)
        row.email_daily = email_daily
    return row


async def mark_seen(db: AsyncSession, shell: UserFile, form: Form, user: User) -> None:
    """You looked at the answers: "new" starts again from now, and the held
    push and the unread inbox row for this form go. The caller commits."""
    from app.notifications.models import Notification, PushHeld

    row = await _ensure_row(db, shell, form, user.id)
    row.seen_at = datetime.now(UTC)
    row.last_push_count = 0
    await db.execute(
        PushHeld.__table__.delete().where(
            PushHeld.user_id == user.id, PushHeld.category == CATEGORY, PushHeld.tag == tag_for(form.id)
        )
    )
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user.id,
            Notification.category == CATEGORY,
            Notification.url == responses_url(shell.id),
            Notification.read_at.is_(None),
        )
        .values(read_at=datetime.now(UTC))
    )


# --------------------------------------------------------------------
# Counting "new"
# --------------------------------------------------------------------
async def unseen_count(db: AsyncSession, form_id: uuid.UUID, user_id: uuid.UUID) -> int:
    """Answers this person hasn't seen: since they last opened the
    Responses tab (all of them when they never have)."""
    seen = await db.scalar(
        select(FormNotify.seen_at).where(FormNotify.form_id == form_id, FormNotify.user_id == user_id)
    )
    q = select(func.count()).select_from(FormResponse).where(
        FormResponse.form_id == form_id, FormResponse.deleted_at.is_(None)
    )
    if seen is not None:
        q = q.where(FormResponse.submitted_at > seen)
    return int(await db.scalar(q) or 0)


async def recipients(db: AsyncSession, shell: UserFile, form: Form) -> list[tuple[User, str]]:
    """(person, mode) for everyone who hears about this form's answers now:
    the owner unless they turned it off, and others who asked — each still
    able to see the answers."""
    from app.auth.models import User as UserModel

    rows = {
        uid: mode
        for uid, mode in (
            await db.execute(select(FormNotify.user_id, FormNotify.mode).where(FormNotify.form_id == form.id))
        ).all()
    }
    wanted: dict[uuid.UUID, str] = {}
    owner_mode = rows.get(shell.user_id, "each")
    if owner_mode != "off":
        wanted[shell.user_id] = owner_mode
    for uid, mode in rows.items():
        if uid != shell.user_id and mode in ("each", "daily"):
            wanted[uid] = mode
    if not wanted:
        return []
    people = (
        await db.execute(select(UserModel).where(UserModel.id.in_(list(wanted)), UserModel.disabled.is_(False)))
    ).scalars().all()
    out: list[tuple[User, str]] = []
    for person in people:
        if await form_access(db, shell, person) != "none":
            out.append((person, wanted[person.id]))
    return out


# --------------------------------------------------------------------
# New answers
# --------------------------------------------------------------------
async def push_new_answers(db: AsyncSession, shell: UserFile, form: Form, user_id: uuid.UUID, mode: str) -> int:
    """One push of the running total to one person (0 when nothing's new).
    ``daily`` holds it for the daily summary instead of sending it."""
    from app.notifications.dispatch import notify_user

    n = await unseen_count(db, form.id, user_id)
    if n <= 0:
        return 0
    await notify_user(
        user_id=user_id,
        category=CATEGORY,
        title=_title(form),
        body=answers_words(n),
        url=responses_url(shell.id),
        tag=tag_for(form.id),
        extra={"count": n},
        summary=mode == "daily",
    )
    await db.execute(
        text(
            "INSERT INTO form_notify (form_id, user_id, mode, last_push_count) VALUES (:f, :u, :m, :n) "
            "ON CONFLICT (form_id, user_id) DO UPDATE SET last_push_count = :n"
        ),
        {"f": form.id, "u": user_id, "m": default_mode(shell, user_id), "n": n},
    )
    await db.commit()
    return n


async def gate(form_id: uuid.UUID, user_id: uuid.UUID) -> float | None:
    """When to push "new answers" to this person: ``0`` now, ``>0`` in that
    many seconds (one trailing push for a burst), ``None`` when that
    trailing push is already planned. A Redis outage means "now"."""
    from app.redis_client import redis

    key = f"forms:push:{form_id}:{user_id}"
    try:
        if await redis.set(key, "1", ex=PUSH_GAP, nx=True):
            return 0
        if await redis.set(f"forms:push-trail:{form_id}:{user_id}", "1", ex=PUSH_GAP + 30, nx=True):
            left = await redis.pttl(key)
            return max(1.0, (left or 0) / 1000)
        return None
    except Exception:  # noqa: BLE001 — never lose a push to a Redis blip
        logger.warning("forms: push gate unavailable", exc_info=True)
        return 0


async def _trailing(form_id: uuid.UUID, user_id: uuid.UUID, delay: float) -> None:
    from app.database import SessionLocal
    from app.redis_client import redis

    await asyncio.sleep(delay)
    try:
        await redis.delete(f"forms:push-trail:{form_id}:{user_id}")
        await redis.set(f"forms:push:{form_id}:{user_id}", "1", ex=PUSH_GAP)
    except Exception:  # noqa: BLE001
        pass
    async with SessionLocal() as db:
        form = await db.get(Form, form_id)
        shell = await db.get(UserFile, form.file_id) if form is not None else None
        if form is None or shell is None or shell.trashed_at is not None:
            return
        for person, mode in await recipients(db, shell, form):
            if person.id == user_id and mode == "each":
                await push_new_answers(db, shell, form, user_id, mode)


async def after_answer(form_id: uuid.UUID) -> None:
    """A new answer was saved: tell everyone who wants to know."""
    from app.background import spawn
    from app.database import SessionLocal

    try:
        async with SessionLocal() as db:
            form = await db.get(Form, form_id)
            shell = await db.get(UserFile, form.file_id) if form is not None else None
            if form is None or shell is None or shell.trashed_at is not None:
                return
            for person, mode in await recipients(db, shell, form):
                if mode == "daily":
                    await push_new_answers(db, shell, form, person.id, mode)
                    continue
                wait = await gate(form.id, person.id)
                if wait == 0:
                    await push_new_answers(db, shell, form, person.id, mode)
                elif wait is not None:
                    spawn(_trailing(form.id, person.id, wait), name=f"form-push-{form.id}-{person.id}")
    except Exception:  # noqa: BLE001 — an answer is saved whatever happens here
        logger.exception("forms: telling people about an answer failed")


def answer_arrived(form_id: uuid.UUID) -> None:
    """Fire-and-forget from the submit route (after its commit)."""
    from app.background import spawn

    spawn(after_answer(form_id), name=f"form-answer-{form_id}")


# --------------------------------------------------------------------
# Closing by itself
# --------------------------------------------------------------------
async def tell_closed(db: AsyncSession, form: Form, shell: UserFile, *, why: Literal["time", "full"]) -> bool:
    """Tell the owner once that their form closed by itself. Commits."""
    from app.notifications.dispatch import notify_user

    claimed = (
        await db.execute(
            update(Form)
            .where(Form.id == form.id, Form.close_pushed_at.is_(None))
            .values(close_pushed_at=datetime.now(UTC))
            .returning(Form.id)
        )
    ).first()
    await db.commit()
    if claimed is None:
        return False
    n = int(form.response_count or 0)
    words = "1 answer" if n == 1 else f"{n} answers"
    body = (
        f"It reached its closing time with {words}."
        if why == "time"
        else f"It has all the answers it was taking ({words}), so it stopped taking more."
    )
    await notify_user(
        user_id=shell.user_id,
        category=CATEGORY,
        title=f"“{_title(form)}” closed",
        body=body,
        url=responses_url(shell.id),
        tag=f"form-closed:{form.id}",
        extra={"kind": "closed"},
    )
    return True


async def close_tick(db: AsyncSession, now: datetime | None = None) -> int:
    """The ``forms_close_tick`` cron: forms whose closing time has passed
    (and whose owner hasn't been told)."""
    now = now or datetime.now(UTC)
    rows = (
        await db.execute(
            select(Form, UserFile)
            .join(UserFile, UserFile.id == Form.file_id)
            .where(
                Form.accepting.is_(True),
                Form.close_at.is_not(None),
                Form.close_at <= now,
                Form.close_pushed_at.is_(None),
                UserFile.trashed_at.is_(None),
                UserFile.source_kind == GeneratedKind.FORM.value,
            )
            .limit(500)
        )
    ).all()
    told = 0
    for form, shell in rows:
        try:
            told += int(await tell_closed(db, form, shell, why="time"))
        except Exception:  # noqa: BLE001 — one form mustn't stop the rest
            logger.exception("forms: closing push for %s failed", form.id)
            await db.rollback()
    return told


def reopened(form: Form) -> None:
    """Settings changed: a form that's open again can be "closed" again later."""
    if not is_closed(form):
        form.close_pushed_at = None


# --------------------------------------------------------------------
# The daily email
# --------------------------------------------------------------------
async def _send_mail(db: AsyncSession, **kw: Any) -> None:
    """The instance's own SMTP (a seam for tests)."""
    from app.mfa.smtp import send_message

    await send_message(db, **kw)


def _digest_due(local_now: datetime, at: str) -> datetime:
    hh, mm = (int(x) for x in at.split(":"))
    return datetime.combine(local_now.date(), time(hh, mm), tzinfo=local_now.tzinfo)


async def send_email_digests(db: AsyncSession, now: datetime | None = None) -> int:
    """The ``forms_digest`` cron: for each person with a daily email on,
    once their Today summary time has come, one email listing each form's
    new answers since the last email (counts only). Returns emails sent."""
    from app.auth.models import User as UserModel
    from app.calendars.reach import site_origin, smtp_ready
    from app.notifications import quiet
    from app.today.push import prefs as today_prefs

    now = now or datetime.now(UTC)
    if not await smtp_ready(db):
        return 0
    user_ids = list(
        (await db.execute(select(FormNotify.user_id).where(FormNotify.email_daily.is_(True)).distinct())).scalars()
    )
    sent = 0
    for uid in user_ids:
        try:
            user = await db.get(UserModel, uid)
            if user is None or user.disabled or not user.email:
                continue
            tz = quiet.zone_of(user.settings)
            local = now.astimezone(tz)
            due = _digest_due(local, (await today_prefs(db, user))["time"])
            if local < due:
                continue
            claimed = (
                await db.execute(
                    text(
                        "WITH prev AS (SELECT form_id, emailed_at FROM form_notify WHERE user_id = :u "
                        "AND email_daily AND (emailed_at IS NULL OR emailed_at < :due) FOR UPDATE) "
                        "UPDATE form_notify f SET emailed_at = :now FROM prev "
                        "WHERE f.form_id = prev.form_id AND f.user_id = :u RETURNING f.form_id, prev.emailed_at"
                    ),
                    {"u": uid, "due": due.astimezone(UTC), "now": now},
                )
            ).all()
            await db.commit()
            if not claimed:
                continue
            found: list[tuple[str, uuid.UUID]] = []
            for form_id, prev in claimed:
                form = await db.get(Form, form_id)
                shell = await db.get(UserFile, form.file_id) if form is not None else None
                if form is None or shell is None or shell.trashed_at is not None:
                    continue
                if await form_access(db, shell, user) == "none":
                    continue
                since = prev or (now - timedelta(days=1))
                n = int(
                    await db.scalar(
                        select(func.count())
                        .select_from(FormResponse)
                        .where(
                            FormResponse.form_id == form.id,
                            FormResponse.deleted_at.is_(None),
                            FormResponse.submitted_at > since,
                            FormResponse.submitted_at <= now,
                        )
                    )
                    or 0
                )
                if n:
                    found.append((f"{_title(form)}: {answers_words(n)} ({form.response_count or 0} in all)", shell.id))
            if not found:
                continue
            origin = (await site_origin(db)).rstrip("/")
            body = ["Here's what came in since yesterday.", ""]
            for line, shell_id in found:
                body += [line, f"{origin}{responses_url(shell_id)}", ""]
            body += ["You get this because you asked for a daily email of new answers. Change it on a form's Responses tab."]
            total = len(found)
            subject = "New answers to your form" if total == 1 else f"New answers to {total} of your forms"
            await _send_mail(db, to=user.email, subject=subject, text_body="\n".join(body))
            sent += 1
        except Exception:  # noqa: BLE001 — one person mustn't stop the rest
            logger.exception("forms: daily email for %s failed", uid)
            await db.rollback()
    return sent


# --------------------------------------------------------------------
# Today
# --------------------------------------------------------------------
async def today_section(db: AsyncSession, user: User, now: datetime, tz: Any) -> dict[str, Any] | None:
    """Today's Forms card: forms with answers you haven't seen, and your
    forms closing today. None when there's nothing to say."""
    watched = select(FormNotify.form_id).where(FormNotify.user_id == user.id, FormNotify.mode.in_(("each", "daily")))
    owned_off = select(FormNotify.form_id).where(FormNotify.user_id == user.id, FormNotify.mode == "off")
    # Your forms (unless you turned their news off) and forms you follow.
    candidates = (
        select(Form.id)
        .join(UserFile, UserFile.id == Form.file_id)
        .where(
            UserFile.trashed_at.is_(None),
            UserFile.source_kind == GeneratedKind.FORM.value,
            or_(and_(UserFile.user_id == user.id, Form.id.not_in(owned_off)), Form.id.in_(watched)),
        )
    )
    base = select(Form, UserFile).join(UserFile, UserFile.id == Form.file_id).where(UserFile.trashed_at.is_(None))
    # New answers per form, for this person (since they last looked).
    new_q = (
        select(FormResponse.form_id, func.count())
        .outerjoin(FormNotify, and_(FormNotify.form_id == FormResponse.form_id, FormNotify.user_id == user.id))
        .where(
            FormResponse.deleted_at.is_(None),
            or_(FormNotify.seen_at.is_(None), FormResponse.submitted_at > FormNotify.seen_at),
            FormResponse.form_id.in_(candidates),
        )
        .group_by(FormResponse.form_id)
    )
    new_counts = {fid: int(n) for fid, n in (await db.execute(new_q)).all()}
    local_day: date = now.astimezone(tz).date()
    day_end = datetime.combine(local_day + timedelta(days=1), time(0, 0), tzinfo=tz).astimezone(UTC)
    closing_ids = select(Form.id).where(
        Form.accepting.is_(True), Form.close_at.is_not(None), Form.close_at > now, Form.close_at < day_end
    )
    rows = (
        await db.execute(
            base.where(or_(Form.id.in_(list(new_counts) or [uuid.UUID(int=0)]), and_(UserFile.user_id == user.id, Form.id.in_(closing_ids))))
            .order_by(Form.last_response_at.desc().nulls_last())
            .limit(50)
        )
    ).all()
    new_items: list[dict[str, Any]] = []
    closing: list[dict[str, Any]] = []
    for form, shell in rows:
        if await form_access(db, shell, user) == "none":
            continue
        n = new_counts.get(form.id, 0)
        if n:
            new_items.append(
                {"title": _title(form), "new": n, "total": int(form.response_count or 0), "url": responses_url(shell.id)}
            )
        if (
            shell.user_id == user.id
            and form.accepting
            and form.close_at is not None
            and now < form.close_at < day_end
            and not is_closed(form, now=now)
        ):
            closing.append({"title": _title(form), "closes_at": form.close_at.isoformat(), "url": responses_url(shell.id)})
    if not new_items and not closing:
        return None
    new_items.sort(key=lambda i: -i["new"])
    return {
        "url": "/forms",
        "new_total": sum(i["new"] for i in new_items),
        "forms": new_items[:5],
        "more": max(0, len(new_items) - 5),
        "closing": closing[:3],
    }


__all__ = [
    "CATEGORY",
    "MODES",
    "PUSH_GAP",
    "after_answer",
    "answer_arrived",
    "answers_words",
    "close_tick",
    "gate",
    "mark_seen",
    "push_new_answers",
    "recipients",
    "reopened",
    "responses_url",
    "send_email_digests",
    "set_settings",
    "settings_for",
    "tag_for",
    "tell_closed",
    "today_section",
    "unseen_count",
]
