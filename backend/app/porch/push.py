"""Porch's push notifications (build §6, WP-P1.7).

One category, ``porch`` (``notifications/dispatch.RULES``: holdable by quiet
hours, summary-capable), with ``extra={"kind": …}`` so held pushes are
counted per kind ("4 new posts and 2 comments in Porch"). Push only
(``inbox=False``, like Rooms): Porch's own Activity tab is the list.

Who gets what, each person at most one push per thing:

* **post** — a new post from someone you turned on ("Notify me when they
  post", ``porch_alerts``) or in a group whose bell you set to "All new
  posts" (``porch_group_members.notify``, Everyone's settings row too);
* **mention** — you're @mentioned in a post or comment;
* **tag** — you're tagged in a photo and need to say yes (Show it / Not me);
* **comment** — on your post; **reply** — to your comment;
* **reaction** — to your post or comment (default: Daily summary);
* **invite** — to a group (Join / Not now);
* **birthday** — someone in one of your groups (or someone you turned on)
  has a birthday today, at the Today summary time;
* **removed** — an admin took down your post or comment, or took your post
  out of a group (always on);
* **report** — something in a group you run was reported (always on; the
  group's owner and admins, Everyone's server admins; WP-P2.0).

Each kind is On / Daily summary / Off for each person
(``porch_profiles.push``); "Daily summary" passes ``summary=True`` so the
push is held for the summary. Everything passes ``actor_user_id``, so a
block either way drops it centrally, and only people who can see the post
(``access.audience_ids``) are ever told about it. Your own actions never
notify you. A push never breaks the request that caused it.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Iterable
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import SessionLocal

from . import access, core, deps
from .models import PorchAlert, PorchComment, PorchGroup, PorchGroupMember, PorchPost, PorchPostGroup, PorchPostMedia, PorchProfile

logger = logging.getLogger("promptly.porch.push")

#: The kinds a person chooses for, in the order Settings shows them.
KINDS = ("post", "comment", "reply", "mention", "tag", "invite", "reaction", "birthday")
MODES = ("on", "summary", "off")
DEFAULTS: dict[str, str] = {k: "on" for k in KINDS} | {"reaction": "summary"}
ICON = "/item-icons/porch-192.png"
#: Birthdays go this long before the Today summary time, so a "Daily
#: summary" one is held in time to ride in it.
BIRTHDAY_LEAD = timedelta(minutes=10)


# ------------------------------------------------------------------ modes


def modes_of(raw: Any) -> dict[str, str]:
    """A person's mode per kind (``porch_profiles.push``), defaults filled in."""
    raw = raw if isinstance(raw, dict) else {}
    return {k: (raw.get(k) if raw.get(k) in MODES else DEFAULTS[k]) for k in KINDS}


async def _modes(db: AsyncSession, user_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, dict[str, str]]:
    ids = set(user_ids)
    if not ids:
        return {}
    rows = dict((await db.execute(select(PorchProfile.user_id, PorchProfile.push).where(PorchProfile.user_id.in_(ids)))).all())
    return {u: modes_of(rows.get(u)) for u in ids}


async def _allowed(db: AsyncSession, ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """The ones Porch is on for."""
    want = set(ids)
    if not want:
        return set()
    s = await deps.settings(db)
    q = select(User.id).where(User.id.in_(want), deps.allowed_clause(s, User.id))
    return set((await db.execute(q)).scalars())


# ------------------------------------------------------------------ sending


def _icon(u: User | None) -> str:
    return (u.avatar_url if u is not None else None) or ICON


async def _send(
    *,
    to: uuid.UUID,
    kind: str,
    mode: str,
    title: str,
    body: str,
    url: str,
    tag: str,
    actor: User | None,
    extra: dict[str, Any] | None = None,
) -> bool:
    """One push, unless this person turned the kind off. Never raises."""
    from app.notifications import dispatch

    if mode == "off" or (actor is not None and actor.id == to):
        return False
    try:
        await dispatch.notify_user(
            user_id=to,
            category="porch",
            title=title[:120],
            body=body[:300],
            url=url,
            tag=tag,
            actor_user_id=actor.id if actor is not None else None,
            inbox=False,
            extra={"kind": kind, "icon": _icon(actor), **(extra or {})},
            summary=mode == "summary",
        )
    except Exception:  # noqa: BLE001 — a push never breaks anything
        logger.warning("porch push failed", exc_info=True)
        return False
    return True


def _snippet(s: str | None, n: int = 140) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


async def _what(db: AsyncSession, post: PorchPost) -> str:
    """The push's body for a post: its words, else what it is."""
    if post.kind == "life_event" and post.life_event:
        words = _snippet(str(post.life_event.get("title") or ""))
        if words:
            return words
    if post.body:
        return _snippet(post.body)
    if post.kind in ("photo", "video"):
        n = len((await db.execute(select(PorchPostMedia.id).where(PorchPostMedia.post_id == post.id))).all())
        if post.kind == "video":
            return "A video" if n <= 1 else f"{n} videos"
        return "A photo" if n <= 1 else f"{n} photos"
    if post.link:
        return _snippet(str(post.link.get("title") or post.link.get("url") or ""))
    return "A new post"


def _post_url(post: PorchPost) -> str:
    return f"/porch/p/{post.id}"


def _post_tag(post: PorchPost) -> str:
    return f"porch:post:{post.id}"


async def _guarded(name: str, coro) -> int:  # noqa: ANN001
    try:
        return await coro
    except Exception:  # noqa: BLE001 — a push never breaks the request
        logger.warning("porch %s pushes failed", name, exc_info=True)
        return 0


# ------------------------------------------------------------------ posts


async def _group_rows(db: AsyncSession, post: PorchPost) -> tuple[list[PorchGroup], dict[uuid.UUID, list[PorchGroupMember]]]:
    gids = list((await db.execute(select(PorchPostGroup.group_id).where(PorchPostGroup.post_id == post.id))).scalars())
    groups = list((await db.execute(select(PorchGroup).where(PorchGroup.id.in_(gids), PorchGroup.deleted_at.is_(None)))).scalars()) if gids else []
    rows: dict[uuid.UUID, list[PorchGroupMember]] = {g.id: [] for g in groups}
    if groups:
        q = select(PorchGroupMember).where(PorchGroupMember.group_id.in_([g.id for g in groups]), PorchGroupMember.status == "member")
        for m in (await db.execute(q)).scalars():
            rows[m.group_id].append(m)
    return groups, rows


async def post_created(db: AsyncSession, post: PorchPost, mentioned: Iterable[str | uuid.UUID], tagged: Iterable[uuid.UUID], *, created: bool) -> int:
    """A new post (``created``) or a changed one: tag requests, mentions,
    and — for a new post — "All new posts" bells and "Notify me when they
    post". Returns how many pushes went."""
    return await _guarded("post", _post_created(db, post, mentioned, tagged, created=created))


async def _post_created(db: AsyncSession, post: PorchPost, mentioned: Iterable[str | uuid.UUID], tagged: Iterable[uuid.UUID], *, created: bool) -> int:
    author = await db.get(User, post.author_id)
    if author is None or post.deleted_at is not None:
        return 0
    audience = await access.audience_ids(db, post) - {author.id}
    tagged_ = {u for u in tagged if u in audience}
    mentioned_ = {uuid.UUID(str(m)) for m in mentioned} & audience - tagged_
    followers: set[uuid.UUID] = set()
    groups: list[PorchGroup] = []
    rows: dict[uuid.UUID, list[PorchGroupMember]] = {}
    if created:
        groups, rows = await _group_rows(db, post)
        alerts = set((await db.execute(select(PorchAlert.user_id).where(PorchAlert.author_id == author.id))).scalars())
        bells = {m.user_id for ms in rows.values() for m in ms if m.notify == "all"}
        followers = (alerts | bells) & audience - tagged_ - mentioned_
    who = tagged_ | mentioned_ | followers
    if not who:
        return 0
    modes = await _modes(db, who)
    name = core.display_name(author)
    what = await _what(db, post)
    sent = 0
    for uid in tagged_:
        from app.notifications.actions import buttons

        tag_ids = (await db.execute(text("SELECT id FROM porch_tags WHERE post_id = :p AND tagged_user_id = :u AND status = 'pending' LIMIT 1"), {"p": post.id, "u": uid})).scalar()
        u = await db.get(User, uid)
        extra = buttons(u, ("porch_tag_yes", str(tag_ids)), ("porch_tag_no", str(tag_ids))) if (u is not None and tag_ids) else None
        sent += await _send(
            to=uid, kind="tag", mode=modes[uid]["tag"], title=f"{name} tagged you in a photo", body="It shows once you say yes.",
            url="/porch/activity", tag=f"porch:tag:{post.id}", actor=author, extra=extra,
        )
    for uid in mentioned_:
        sent += await _send(
            to=uid, kind="mention", mode=modes[uid]["mention"], title=f"{name} mentioned you in a post", body=what,
            url=_post_url(post), tag=_post_tag(post), actor=author,
        )
    if followers:
        # "Mum posted in Family": a group of the post that's also theirs
        # (a specific group before Everyone; never one they're not in).
        names: dict[uuid.UUID, str] = {}
        for g in sorted(groups, key=lambda g: g.kind == "everyone"):
            members = {m.user_id for m in rows.get(g.id, [])}
            for uid in followers:
                if uid not in names and (g.kind == "everyone" or uid in members):
                    names[uid] = f"{g.emoji} {g.name}".strip()
        for uid in followers:
            where = f" in {names[uid]}" if uid in names else ""
            sent += await _send(
                to=uid, kind="post", mode=modes[uid]["post"], title=f"{name} posted{where}", body=what,
                url=_post_url(post), tag=_post_tag(post), actor=author,
            )
    return sent


# ------------------------------------------------------------------ comments


async def comment_added(db: AsyncSession, post: PorchPost, c: PorchComment, parent: PorchComment | None, *, mentioned: Iterable[str | uuid.UUID] | None = None) -> int:
    """A new comment: the post's author ("commented on your post"), the
    person replied to ("replied to your comment"), anyone @mentioned. With
    ``mentioned`` (an edit), only those newly mentioned."""
    return await _guarded("comment", _comment_added(db, post, c, parent, mentioned))


async def _comment_added(db: AsyncSession, post: PorchPost, c: PorchComment, parent: PorchComment | None, mentioned: Iterable[str | uuid.UUID] | None) -> int:
    actor = await db.get(User, c.author_id)
    if actor is None:
        return 0
    audience = await access.audience_ids(db, post)
    audience = (audience - {post.author_id}) | (await _allowed(db, [post.author_id]))
    audience.discard(actor.id)
    plan: dict[uuid.UUID, str] = {}
    if mentioned is None:
        if post.author_id in audience:
            plan[post.author_id] = "comment"
        if parent is not None and parent.author_id in audience:
            plan.setdefault(parent.author_id, "reply")
        new_mentions = c.mentions or []
    else:
        new_mentions = list(mentioned)
    for m in new_mentions:
        uid = uuid.UUID(str(m))
        if uid in audience:
            plan.setdefault(uid, "mention")
    if not plan:
        return 0
    modes = await _modes(db, plan)
    name = core.display_name(actor)
    words = _snippet(c.body)
    titles = {"comment": f"{name} commented on your post", "reply": f"{name} replied to your comment", "mention": f"{name} mentioned you in a comment"}
    sent = 0
    for uid, kind in plan.items():
        sent += await _send(
            to=uid, kind=kind, mode=modes[uid][kind], title=titles[kind], body=words,
            url=_post_url(post), tag=_post_tag(post), actor=actor,
        )
    return sent


# ------------------------------------------------------------------ reactions


async def reacted(db: AsyncSession, post: PorchPost, actor: User, emoji: str, *, comment: PorchComment | None = None) -> int:
    """A first reaction to your post or comment."""
    return await _guarded("reaction", _reacted(db, post, actor, emoji, comment))


async def _reacted(db: AsyncSession, post: PorchPost, actor: User, emoji: str, comment: PorchComment | None) -> int:
    owner = comment.author_id if comment is not None else post.author_id
    if owner == actor.id or owner not in (await access.audience_ids(db, post)) | {post.author_id}:
        return 0
    if not await _allowed(db, [owner]):
        return 0
    modes = await _modes(db, [owner])
    name = core.display_name(actor)
    what = "your comment" if comment is not None else "your post"
    body = _snippet(comment.body) if comment is not None else await _what(db, post)
    return int(
        await _send(
            to=owner, kind="reaction", mode=modes[owner]["reaction"], title=f"{name} reacted {emoji} to {what}", body=body,
            url=_post_url(post), tag=_post_tag(post), actor=actor,
        )
    )


# ------------------------------------------------------------------ invites


async def invited(db: AsyncSession, inviter: User, group: PorchGroup, user_ids: Iterable[uuid.UUID]) -> int:
    """You're invited to a group: Join / Not now on the push."""
    return await _guarded("invite", _invited(db, inviter, group, user_ids))


async def _invited(db: AsyncSession, inviter: User, group: PorchGroup, user_ids: Iterable[uuid.UUID]) -> int:
    from app.notifications.actions import buttons

    ids = [u for u in dict.fromkeys(user_ids) if u != inviter.id]
    if not ids:
        return 0
    modes = await _modes(db, ids)
    n = await access.member_count(db, group)
    label = f"{group.emoji} {group.name}".strip()
    sent = 0
    for uid in ids:
        u = await db.get(User, uid)
        if u is None:
            continue
        sent += await _send(
            to=uid, kind="invite", mode=modes[uid]["invite"], title=f"{core.display_name(inviter)} invited you to {label}",
            body=f"{n} {'person' if n == 1 else 'people'} in it. Join to see its posts.", url="/porch/groups",
            tag=f"porch:invite:{group.id}", actor=inviter,
            extra=buttons(u, ("porch_join", str(group.id)), ("porch_decline", str(group.id))),
        )
    return sent


# ------------------------------------------------------------------ removals


async def removed(db: AsyncSession, author_id: uuid.UUID, *, what: str, scope: str, reason: str, group: str | None = None) -> int:
    """An admin took down your post or comment: you're told why (always —
    it isn't one of the kinds you choose). ``scope``: ``everyone`` (a
    server admin, out of Everyone), ``group`` (a group's admin, out of
    ``group`` only) or ``all`` (a comment)."""

    async def go() -> int:
        if not await _allowed(db, [author_id]):
            return 0
        if scope == "everyone":
            title = f"Your {what} was removed from Everyone"
        elif scope == "group" and group:
            title = f"Your {what} was removed from {group}"
        else:
            title = f"Your {what} was removed"
        by = "By the person who runs this Promptly." if scope == "everyone" or not group else f"By an admin of {group}."
        body = f"The reason given: {_snippet(reason)}" if reason.strip() else by
        return int(await _send(to=author_id, kind="removed", mode="on", title=title, body=body, url="/porch/activity", tag=f"porch:removed:{uuid.uuid4()}", actor=None))

    return await _guarded("removal", go())


# ------------------------------------------------------------------ stories (WP-P2.1)


async def story_mentioned(db: AsyncSession, story: Any, mentioned: Iterable[str | uuid.UUID]) -> int:
    """"Sam mentioned you in a story" — the only push a story sends
    (decision S3: nothing for a new story). Only people who can see it."""

    async def go() -> int:
        author = await db.get(User, story.author_id)
        if author is None or story.deleted_at is not None:
            return 0
        audience = await access.story_audience_ids(db, story) - {author.id}
        who = {uuid.UUID(str(m)) for m in mentioned} & audience
        who &= await _allowed(db, who)
        if not who:
            return 0
        modes = await _modes(db, who)
        name = core.display_name(author)
        sent = 0
        for uid in who:
            sent += await _send(
                to=uid, kind="mention", mode=modes[uid]["mention"], title=f"{name} mentioned you in a story",
                body="See it before it's gone (stories last a day).", url=f"/porch/stories/{author.id}",
                tag=f"porch:story:{story.id}", actor=author,
            )
        return sent

    return await _guarded("story", go())


# ------------------------------------------------------------------ reports (WP-P2.0)


async def reported(db: AsyncSession, group: PorchGroup, admin_ids: Iterable[uuid.UUID]) -> int:
    """Something in a group you run was reported: which group, never who
    reported it or what it says (always on; quiet hours may hold it)."""

    async def go() -> int:
        sent = 0
        for uid in await _allowed(db, admin_ids):
            sent += await _send(
                to=uid, kind="report", mode="on", title=f"Something in {group.name} was reported",
                body=f"Open {group.name}'s Reports to look at it.", url=f"/porch/g/{group.id}?tab=reports",
                tag=f"porch:report:{group.id}", actor=None,
            )
        return sent

    return await _guarded("report", go())


# ------------------------------------------------------------------ birthdays


async def _birthday_people(db: AsyncSession, user: User, today: date) -> list[User]:
    """People with a birthday today who show it, in one of your own groups
    (not just Everyone) or someone you turned on — never anyone blocked."""
    from app.people import blocks

    from .today import _is_birthday

    s = await deps.settings(db)
    mine = select(PorchGroupMember.group_id).join(PorchGroup, PorchGroup.id == PorchGroupMember.group_id).where(
        PorchGroupMember.user_id == user.id, PorchGroupMember.status == "member", PorchGroup.deleted_at.is_(None), PorchGroup.kind == "custom",
    )
    shares = select(PorchGroupMember.user_id).where(PorchGroupMember.status == "member", PorchGroupMember.group_id.in_(mine))
    alerts = select(PorchAlert.author_id).where(PorchAlert.user_id == user.id)
    q = (
        select(User, PorchProfile.birthday)
        .join(PorchProfile, PorchProfile.user_id == User.id)
        .where(
            PorchProfile.show_birthday.is_(True),
            PorchProfile.birthday.is_not(None),
            User.id != user.id,
            deps.allowed_clause(s, User.id),
            (User.id.in_(shares)) | (User.id.in_(alerts)),
        )
        .order_by(User.username)
    )
    hidden = await blocks.hidden_ids(db, user.id)
    return [u for u, b in (await db.execute(q)).all() if b is not None and u.id not in hidden and _is_birthday(b, today)]


async def birthdays_for(db: AsyncSession, user: User, today: date) -> int:
    """Today's birthday pushes for one person (the loop claimed the day)."""
    modes = (await _modes(db, [user.id]))[user.id]
    if modes["birthday"] == "off":
        return 0
    sent = 0
    for other in (await _birthday_people(db, user, today))[:6]:
        name = core.display_name(other)
        sent += await _send(
            to=user.id, kind="birthday", mode=modes["birthday"], title=f"It's {name}'s birthday today",
            body=f"Post something for {name}.", url=f"/porch/new?for={other.id}", tag=f"porch:birthday:{other.id}:{today.isoformat()}",
            actor=other,
        )
    return sent


async def _claim_birthdays(db: AsyncSession, user_id: uuid.UUID, day: date) -> bool:
    got = (
        await db.execute(
            text(
                "UPDATE porch_profiles SET birthday_pushed_on = :d WHERE user_id = :u "
                "AND birthday_pushed_on IS DISTINCT FROM :d RETURNING user_id"
            ),
            {"u": user_id, "d": day},
        )
    ).first()
    await db.commit()
    return got is not None


async def birthdays_once(db: AsyncSession, now: datetime | None = None) -> int:
    """One pass: everyone with Porch whose birthday time has come today and
    who hasn't had today's birthday pushes yet."""
    from app.notifications import quiet
    from app.today import push as today_push

    now = now or datetime.now(timezone.utc)
    s = await deps.settings(db)
    q = (
        select(User, PorchProfile.birthday_pushed_on, PorchProfile.push)
        .join(PorchProfile, PorchProfile.user_id == User.id)
        .where(deps.allowed_clause(s, User.id))
    )
    rows = (await db.execute(q)).all()
    if not rows:
        return 0
    tasks = await today_push._tasks_settings(db)
    sent = 0
    for u, done_on, raw in rows:
        try:
            if modes_of(raw)["birthday"] == "off":
                continue
            tz = quiet.zone_of(u.settings)
            local = now.astimezone(tz)
            if done_on == local.date():
                continue
            _on, at = today_push._from_tasks(tasks[u.id]) if u.id in tasks else today_push._from_account(u)
            hh, mm = (int(x) for x in at.split(":"))
            due = max(datetime.combine(local.date(), time(hh, mm), tzinfo=tz) - BIRTHDAY_LEAD, datetime.combine(local.date(), time(0, 0), tzinfo=tz))
            if local < due:
                continue
            if await _claim_birthdays(db, u.id, local.date()):
                sent += await birthdays_for(db, u, local.date())
        except Exception:  # noqa: BLE001 — one person mustn't stop the rest
            logger.exception("porch birthdays for %s failed", u.id)
            await db.rollback()
    return sent


_TICK_S = 120


async def _loop() -> None:
    logger.info("Porch birthday loop started")
    while True:
        try:
            async with SessionLocal() as db:
                await birthdays_once(db)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("porch birthday pass failed")
        await asyncio.sleep(_TICK_S)


def start_porch_loops() -> asyncio.Task:
    """Started from ``main.py``'s lifespan (one backend worker by design)."""
    return asyncio.create_task(_loop(), name="porch_birthdays")


# ------------------------------------------------------------------ push buttons


async def do_action(db: AsyncSession, user: User, action: str, target: str) -> str:
    """A button on a Porch push (``notifications/actions.perform``): Join /
    Not now on an invite, Show it / Not me on a tag. Commits. Raises
    ``LookupError`` when the thing is gone or no longer yours to answer."""
    if not await deps.allowed(db, user):
        raise LookupError("porch off")
    try:
        tid = uuid.UUID(target)
    except ValueError as exc:
        raise LookupError("bad target") from exc
    if action in ("porch_join", "porch_decline"):
        g = await db.get(PorchGroup, tid)
        m = await access.membership(db, tid, user.id)
        if g is None or g.deleted_at is not None or m is None or m.status != "invited":
            raise LookupError("no invite")
        label = f"{g.emoji} {g.name}".strip()
        if action == "porch_decline":
            await db.delete(m)
            await db.commit()
            await core.publish([user.id], {"type": "invite", "group_id": str(g.id)})
            return f"You said not now to {label}"
        m.status, m.role, m.in_feed, m.joined_at = "member", "member", True, core.now()
        await db.commit()
        ids = await access.group_member_ids(db, g)
        await core.publish(ids, {"type": "group", "group_id": str(g.id)})
        return f"You joined {label}"
    if action in ("porch_tag_yes", "porch_tag_no"):
        from .models import PorchTag

        t = await db.get(PorchTag, tid)
        if t is None or t.tagged_user_id != user.id or not await access.can_see_post(db, user, t.post_id):
            raise LookupError("no tag")
        if action == "porch_tag_yes":
            if t.status == "declined":
                raise LookupError("declined")
            t.status, t.decided_at = "approved", core.now()
            msg = "Your tag shows on the photo now"
        else:
            t.status, t.decided_at = "declined", core.now()
            msg = "The tag won't show"
        await db.commit()
        post = await db.get(PorchPost, t.post_id)
        if post is not None:
            await core.publish(await access.audience_ids(db, post), {"type": "post_change", "post_id": str(post.id)})
        await core.publish([user.id], {"type": "activity"})
        return msg
    raise LookupError("unknown action")


__all__ = [
    "DEFAULTS", "KINDS", "MODES", "birthdays_for", "birthdays_once", "comment_added", "do_action", "invited", "modes_of",
    "post_created", "reacted", "removed", "start_porch_loops",
]
