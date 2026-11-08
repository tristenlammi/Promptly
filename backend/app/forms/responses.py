"""Answering a form through its link (WP-F1.3): what the answer page is
sent, and taking an answer — new or changed.

Everything starts from the link token. :func:`load` finds the link, the
form and whether it can take an answer from this person
(:func:`app.forms.access.answer_state`); a dead link of any kind — unknown,
turned off, in the trash, link answers switched off by the admin — is the
same ``"gone"``, which the router answers with the same 404.

Taking an answer happens under the form's row lock (``SELECT … FOR
UPDATE``): the closing rules, "one answer per person", the per-option
places and the response number are all decided there, so two people can't
take the last place at the same moment. Submits are idempotent on the
page's ``submit_id``: a retry after a lost signal gets the first answer's
result back instead of a second answer.

Nothing here commits except :func:`submit` / :func:`edit` / :func:`report`.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.files.models import FileShareLink, UserFile
from app.forms import abuse
from app.forms import answering as ans
from app.forms.access import answer_state, form_for_shell, link_answers_allowed
from app.forms.models import Form, FormOptionCount, FormReport, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User

GONE_MESSAGE = "This form doesn't exist or its link was turned off."
CLOSED_MESSAGE = "This form isn't taking answers any more."
BUSY_MESSAGE = "Lots of answers are arriving. Try again in a minute."
ASSET_TTL_SECONDS = 6 * 3600


class Refusal(Exception):
    """An answer the form won't take: an HTTP status, a stable ``code`` the
    page acts on, and words it can show."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}


def gone() -> Refusal:
    return Refusal(404, "gone", GONE_MESSAGE)


@dataclass
class AnswerCtx:
    link: FileShareLink | None
    shell: UserFile | None
    form: Form | None
    state: str


async def load(db: AsyncSession, token: str, user: User | None, *, lock: bool = False) -> AnswerCtx:
    """The link, its form, and whether ``user`` (None: signed out) can
    answer it now. ``lock`` takes the form's row lock (submits)."""
    link = None
    if token and len(token) <= 64:
        link = (
            await db.execute(
                select(FileShareLink).where(FileShareLink.token == token, FileShareLink.resource_type == "form")
            )
        ).scalar_one_or_none()
    shell = await db.get(UserFile, link.resource_id) if link is not None else None
    form = await form_for_shell(db, shell, lock=lock) if shell is not None else None
    state = answer_state(
        form=form, shell=shell, link=link, user=user, link_answers_allowed=await link_answers_allowed(db)
    )
    return AnswerCtx(link=link, shell=shell, form=form, state=state)


# --------------------------------------------------------------------
# Pictures, through the link only
# --------------------------------------------------------------------
def _asset_sig(token: str, asset_id: uuid.UUID, exp: int) -> str:
    key = get_settings().SECRET_KEY.encode("utf-8")
    return hmac.new(key, f"form-answer-asset:v1:{token}:{asset_id}:{exp}".encode("utf-8"), hashlib.sha256).hexdigest()


def asset_url(token: str, asset_id: uuid.UUID | str) -> str:
    """A picture of the form for the answer page: signed for this link (an
    ``<img>`` can't send a sign-in header), rounded to the hour so it stays
    cached, and dead once the link is."""
    aid = uuid.UUID(str(asset_id))
    exp = (int(time.time()) // 3600 + 1) * 3600 + ASSET_TTL_SECONDS
    return f"/api/f/{token}/asset/{aid}?exp={exp}&sig={_asset_sig(token, aid, exp)}"


def verify_asset(token: str, asset_id: uuid.UUID, exp: int, sig: str) -> bool:
    if exp < time.time():
        return False
    return hmac.compare_digest(_asset_sig(token, asset_id, exp), sig or "")


def _asset_urls(token: str, defn: dict[str, Any]) -> dict[str, str]:
    from app.forms.definition import asset_ids

    return {a: asset_url(token, a) for a in sorted(asset_ids(defn))}


# --------------------------------------------------------------------
# What the page is sent
# --------------------------------------------------------------------
async def _taken(db: AsyncSession, form_id: uuid.UUID) -> dict[tuple[str, str], int]:
    rows = await db.execute(
        select(FormOptionCount.question_id, FormOptionCount.option_id, FormOptionCount.taken).where(
            FormOptionCount.form_id == form_id
        )
    )
    return {(q, o): int(n or 0) for q, o, n in rows}


async def latest_by(db: AsyncSession, form: Form, user: User) -> FormResponse | None:
    return (
        await db.execute(
            select(FormResponse)
            .where(
                FormResponse.form_id == form.id,
                FormResponse.respondent_id == user.id,
                FormResponse.deleted_at.is_(None),
            )
            .order_by(FormResponse.submitted_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def _mine(r: FormResponse) -> dict[str, Any]:
    return {
        "number": r.number,
        "answers": r.answers or {},
        "email": r.email,
        "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        "edited_at": r.edited_at.isoformat() if r.edited_at else None,
    }


def _display_name(user: User) -> str:
    settings = user.settings if isinstance(getattr(user, "settings", None), dict) else {}
    return str(settings.get("display_name") or user.username or "you")


async def page(db: AsyncSession, ctx: AnswerCtx, user: User | None, token: str) -> dict[str, Any]:
    """``GET /api/f/{token}`` for a link that isn't gone."""
    form, shell = ctx.form, ctx.shell
    assert form is not None and shell is not None
    defn = form.definition or {}
    if ctx.state == "sign_in":
        # Nothing about the form to someone who can't answer it.
        return {"state": "sign_in", "audience": form.audience}
    if ctx.state == "closed":
        top = {
            "title": defn.get("title") or "Untitled form",
            "description": defn.get("description") or "",
            "theme": defn.get("theme") or {},
            "after": "continue",
            "version": defn.get("version", 1),
            "items": [],
        }
        return {
            "state": "closed",
            "audience": form.audience,
            "definition": top,
            "asset_urls": _asset_urls(token, top),
            "closed_message": form.closed_message or "",
        }
    respondent_defn = ans.respondent_definition(defn)
    previous = await latest_by(db, form, user) if user is not None else None
    return {
        "state": "open",
        "audience": form.audience,
        "definition": respondent_defn,
        "asset_urls": _asset_urls(token, respondent_defn),
        "settings": {
            # The email box is for people answering without an account.
            "collect_email": bool(form.collect_email and form.audience == "link" and user is None),
            "allow_edit": bool(form.allow_edit),
            "allow_another": bool(form.allow_another),
            "one_per_person": bool(form.one_per_person),
            "show_remaining": bool(form.show_remaining),
            "confirmation": form.confirmation or "",
        },
        "remaining": ans.remaining(respondent_defn, await _taken(db, form.id)),
        "start_token": abuse.start_token(form.id),
        "respondent": {"name": _display_name(user)} if user is not None else None,
        "answered": previous is not None,
        "mine": _mine(previous) if previous is not None and form.allow_edit else None,
        "closes_at": form.close_at.isoformat() if form.close_at else None,
    }


# --------------------------------------------------------------------
# Taking an answer
# --------------------------------------------------------------------
@dataclass
class Incoming:
    answers: Any
    submit_id: uuid.UUID | None
    start_token: str | None
    email: str | None = None
    website: str | None = None
    edit: str | None = None


def _check_start(form: Form, token: str | None) -> None:
    verdict = abuse.check_start(form.id, token)
    if verdict == "fast":
        raise Refusal(422, "too_fast", "That was quick! Wait a moment, then send it again.")
    if verdict == "old":
        raise Refusal(409, "start_expired", "This page has been open a long time. Reload it to send your answer.")
    if verdict != "ok":
        raise Refusal(400, "bad_start", "This page is out of date. Reload it to send your answer.")


def _invalid(exc: ans.AnswerError) -> Refusal:
    return Refusal(422, "invalid", str(exc), question_id=exc.question_id)


async def _counts_for_update(
    db: AsyncSession, form: Form, keys: set[tuple[str, str]]
) -> dict[tuple[str, str], FormOptionCount]:
    if not keys:
        return {}
    rows = (
        await db.execute(
            select(FormOptionCount).where(
                FormOptionCount.form_id == form.id,
                FormOptionCount.question_id.in_({q for q, _ in keys}),
            )
        )
    ).scalars().all()
    return {(r.question_id, r.option_id): r for r in rows if (r.question_id, r.option_id) in keys}


def _option_label(defn: dict[str, Any], qid: str, oid: str) -> str:
    for i in defn.get("items") or []:
        if i.get("id") == qid:
            for o in (i.get("config") or {}).get("options") or []:
                if o.get("id") == oid:
                    return o.get("label") or "That option"
    return "That option"


async def _take_places(
    db: AsyncSession, form: Form, new: list[tuple[str, str]], old: list[tuple[str, str]] | None = None
) -> None:
    """Move the option counters from ``old`` picks to ``new`` ones, refusing
    with ``full`` when a new pick has no place left. The form row must be
    locked: that lock is what makes the counters safe."""
    defn = form.definition or {}
    limits = ans.limited_options(defn)
    old = old or []
    rows = await _counts_for_update(db, form, set(new) | set(old))
    gained = [p for p in new if p not in old]
    for q, o in gained:
        limit = limits.get(q, {}).get(o)
        if limit is None:
            continue
        row = rows.get((q, o))
        if (row.taken if row else 0) + 1 > limit:
            raise Refusal(
                409,
                "full",
                f"“{_option_label(defn, q, o)}” just filled up. Pick another option.",
                question_id=q,
                option_id=o,
            )
    for q, o in [p for p in old if p not in new]:
        row = rows.get((q, o))
        if row is not None and row.taken > 0:
            row.taken -= 1
    for q, o in gained:
        row = rows.get((q, o))
        if row is None:
            row = FormOptionCount(form_id=form.id, question_id=q, option_id=o, taken=0)
            db.add(row)
            rows[(q, o)] = row
        row.taken = (row.taken or 0) + 1


async def _grow_shell(db: AsyncSession, shell_id: uuid.UUID, delta: int) -> None:
    # The answers count against the owner's storage. A core UPDATE, so the
    # form doesn't jump to the top of Recent with every answer.
    if delta:
        await db.execute(
            update(UserFile)
            .where(UserFile.id == shell_id)
            .values(size_bytes=func.greatest(UserFile.size_bytes + delta, 0))
        )


def _size(answers: dict[str, Any]) -> int:
    return len(json.dumps(answers, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


async def _tell_owner_busy(form: Form, shell: UserFile) -> None:
    from app.notifications.dispatch import notify_user

    if not await abuse.first_busy_this_hour(form.id):
        return
    title = (form.definition or {}).get("title") or "Your form"
    # Forms' own category (WP-F1.4): the owner's switch for their forms
    # covers it, and it may wait out quiet hours (system alerts never do,
    # and they're for server admins).
    await notify_user(
        user_id=shell.user_id,
        category="form_response",
        title=f"“{title}” is getting lots of answers",
        body="Some people were asked to try again in a minute. If that's unexpected, close the form or reset its link.",
        url=f"/files/form/{shell.id}?tab=settings",
        tag=f"form-busy:{form.id}",
        extra={"kind": "busy"},
    )


def _result(token: str, form: Form, r: FormResponse, *, user: User | None) -> dict[str, Any]:
    out: dict[str, Any] = {"number": r.number, "edit_token": None}
    if user is None and form.allow_edit and r.respondent_id is None:
        out["edit_token"] = abuse.edit_token(form.id, r.submit_id)
    return out


async def submit(
    db: AsyncSession, token: str, body: Incoming, user: User | None, *, ip: str
) -> dict[str, Any]:
    """Take a new answer. Returns ``{number, edit_token}`` (the token only
    for a link answer with editing on: shown once, on the confirmation).
    Raises :class:`Refusal`."""
    ctx = await load(db, token, user, lock=True)
    if ctx.state == "gone":
        raise gone()
    form, shell = ctx.form, ctx.shell
    assert form is not None and shell is not None
    if ctx.state == "sign_in":
        raise Refusal(403, "sign_in", "Sign in to answer this form.")
    if ctx.state == "closed":
        raise Refusal(409, "closed", form.closed_message or CLOSED_MESSAGE)
    if body.website:
        # The honeypot: a person never sees it. Looks like it worked; nothing kept.
        return {"number": (form.next_number or 1), "edit_token": None}
    _check_start(form, body.start_token)
    if body.submit_id is None:
        raise Refusal(400, "bad_request", "This page is out of date. Reload it to send your answer.")

    existing = (
        await db.execute(
            select(FormResponse).where(FormResponse.form_id == form.id, FormResponse.submit_id == body.submit_id)
        )
    ).scalar_one_or_none()
    if existing is not None:
        # The same answer sent again (a retry after a lost signal).
        if existing.respondent_id is not None and (user is None or existing.respondent_id != user.id):
            return {"number": existing.number, "edit_token": None}
        return _result(token, form, existing, user=user)

    if await abuse.person_over(form.id, user_id=user.id if user else None, ip=ip):
        raise Refusal(429, "busy", BUSY_MESSAGE)
    if form.audience == "link" and await abuse.form_over(form.id):
        await _tell_owner_busy(form, shell)
        raise Refusal(429, "busy", BUSY_MESSAGE)

    if user is not None and form.one_per_person and await latest_by(db, form, user) is not None:
        raise Refusal(
            409,
            "already_answered",
            "You've already answered this form.",
            can_edit=bool(form.allow_edit),
        )

    defn = form.definition or {}
    try:
        clean, path = ans.check_answers(defn, body.answers)
        email = None
        if form.collect_email and form.audience == "link" and user is None:
            email = ans.check_email(body.email)
    except ans.AnswerError as exc:
        raise _invalid(exc) from None

    await _take_places(db, form, ans.picks(defn, clean))
    now = datetime.now(timezone.utc)
    r = FormResponse(
        id=uuid.uuid4(),
        form_id=form.id,
        number=form.next_number or 1,
        respondent_id=user.id if user is not None else None,
        email=email,
        source="server" if user is not None else "link",
        answers=clean,
        path=path,
        submit_id=body.submit_id,
        submitted_at=now,
    )
    if user is None:
        r.edit_token_hash = abuse.hash_edit_token(abuse.edit_token(form.id, body.submit_id))
    db.add(r)
    form.next_number = (form.next_number or 1) + 1
    form.response_count = (form.response_count or 0) + 1
    form.last_response_at = now
    await db.flush()
    await _grow_shell(db, shell.id, _size(clean))
    out = _result(token, form, r, user=user)
    await db.commit()
    await abuse.note_answer(
        form.id, user_id=user.id if user else None, ip=ip, link_form=form.audience == "link"
    )
    # Tell the owner (and anyone following it): counts only (WP-F1.4).
    from app.forms import notify

    notify.answer_arrived(form.id)
    # …and the linked sheet gets the row (WP-F1.5).
    from app.forms.sheet import sync_soon

    sync_soon(form)
    if form.max_responses is not None and (form.response_count or 0) >= form.max_responses:
        try:
            await notify.tell_closed(db, form, shell, why="full")
        except Exception:  # noqa: BLE001 — the answer is saved whatever happens here
            import logging

            logging.getLogger("promptly.forms").exception("forms: closing push failed")
    return out


async def find_mine(db: AsyncSession, form: Form, user: User | None, edit: str | None) -> FormResponse | None:
    """The answer someone may change: by its edit token, else their latest
    as a signed-in person."""
    if edit:
        if len(edit) > 100:
            return None
        return (
            await db.execute(
                select(FormResponse).where(
                    FormResponse.form_id == form.id,
                    FormResponse.edit_token_hash == abuse.hash_edit_token(edit),
                    FormResponse.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    if user is not None:
        return await latest_by(db, form, user)
    return None


def _closed_for_edits(form: Form) -> bool:
    # Changing an answer doesn't add one, so a form that's only full still
    # takes changes; switched off or past its time, it doesn't.
    now = datetime.now(timezone.utc)
    return not form.accepting or (form.close_at is not None and form.close_at <= now)


async def mine(db: AsyncSession, token: str, user: User | None, edit: str | None) -> dict[str, Any]:
    """``GET /api/f/{token}/mine``: your answer, to change it."""
    ctx = await load(db, token, user)
    if ctx.state in ("gone", "sign_in"):
        raise gone()
    form = ctx.form
    assert form is not None
    if not form.allow_edit:
        raise gone()
    r = await find_mine(db, form, user, edit)
    if r is None:
        raise gone()
    if _closed_for_edits(form):
        raise Refusal(409, "closed", form.closed_message or CLOSED_MESSAGE)
    return {**_mine(r), "start_token": abuse.start_token(form.id)}


async def edit(db: AsyncSession, token: str, body: Incoming, user: User | None) -> dict[str, Any]:
    """``PUT /api/f/{token}/mine``: change your answer (signed in, or with
    the edit token from the confirmation)."""
    ctx = await load(db, token, user, lock=True)
    if ctx.state in ("gone", "sign_in"):
        raise gone()
    form, shell = ctx.form, ctx.shell
    assert form is not None and shell is not None
    if not form.allow_edit:
        raise gone()
    r = await find_mine(db, form, user, body.edit)
    if r is None:
        raise gone()
    if _closed_for_edits(form):
        raise Refusal(409, "closed", form.closed_message or CLOSED_MESSAGE)
    _check_start(form, body.start_token)
    defn = form.definition or {}
    try:
        clean, path = ans.check_answers(defn, body.answers)
        email = r.email
        if form.collect_email and form.audience == "link" and r.respondent_id is None:
            email = ans.check_email(body.email)
    except ans.AnswerError as exc:
        raise _invalid(exc) from None
    old = dict(r.answers or {})
    await _take_places(db, form, ans.picks(defn, clean), ans.picks(defn, old))
    delta = _size(clean) - _size(old)
    r.answers = clean
    r.path = path
    r.email = email
    r.edited_at = datetime.now(timezone.utc)
    # A new seq: the linked Sheet rewrites this row (WP-F1.5).
    r.seq = (await db.execute(text("SELECT nextval('form_response_seq')"))).scalar_one()
    await db.flush()
    await _grow_shell(db, shell.id, delta)
    await db.commit()
    from app.forms.sheet import sync_soon

    sync_soon(form)
    return {"number": r.number}


# --------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------
async def report(db: AsyncSession, token: str, reason: str) -> None:
    """"Report this form": kept for Admin → Forms, and the admins told."""
    from app.auth.models import User as UserModel
    from app.notifications.dispatch import notify_user

    ctx = await load(db, token, None)
    if ctx.state == "gone" or ctx.form is None or ctx.shell is None or ctx.form.audience != "link":
        raise gone()
    form, shell = ctx.form, ctx.shell
    db.add(FormReport(id=uuid.uuid4(), form_id=form.id, reason=(reason or "").strip()[:1000]))
    await db.commit()
    owner = await db.get(UserModel, shell.user_id)
    title = (form.definition or {}).get("title") or "Untitled form"
    admins = (
        await db.execute(select(UserModel.id).where(UserModel.role == "admin", UserModel.disabled.is_(False)))
    ).scalars().all()
    for admin_id in admins:
        # Never the reporter's words on a lock screen: Admin → Forms shows them.
        await notify_user(
            user_id=admin_id,
            category="system_alert",
            title="A form was reported",
            body=f"Someone reported “{title}”{f' (made by {owner.username})' if owner else ''}. See Admin → Forms.",
            url="/admin?tab=forms",
            tag=f"form-report:{form.id}",
        )


__all__ = [
    "BUSY_MESSAGE",
    "CLOSED_MESSAGE",
    "GONE_MESSAGE",
    "AnswerCtx",
    "Incoming",
    "Refusal",
    "asset_url",
    "edit",
    "find_mine",
    "gone",
    "latest_by",
    "load",
    "mine",
    "page",
    "report",
    "submit",
    "verify_asset",
]
