"""Who runs a home, and what happens to it when its owner goes.

**Roles.** A home has one ``owner``, any number of ``coowner``s the owner
picked, and ``member``s. Members *use* the home: its devices, its speakers,
the assistant. Owners and co-owners *set it up*: brands and devices, rooms,
names, boxes, music, who's in it. Three things are the owner's alone:
choosing co-owners, passing the home on, and deleting it (so a co-owner can
never remove the owner or take the home).

**A home is never left without an owner.** An owner who wants out either
passes the home to someone in it (:func:`pass_on`) or deletes it
(:func:`wipe_home`). When an admin deletes an owner's account
(:func:`before_user_deleted`) nobody is there to choose, and an admin never
sees inside a home, so it's decided here: the longest-standing co-owner
takes it, else the longest-standing member, else (nobody else in it) the
home is wiped.

**Wiping** takes every box out of the home and asks each to forget what the
home put on it: the brands and bridges that were added (and with them the
devices and their sign-ins), linked music services, and the rooms
(:func:`wipe_box`). A box that's offline is marked (``wipe_pending``) and
does it the moment it next connects, before anything on it is shown to
anyone (``relay.py`` holds its devices back until then). What can't be
reached from here: what a device or bridge itself remembers about having
been paired, and the box's own history files.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import builtin, codes, relay
from .access import COOWNER, MEMBER, OWNER, RUNS_IT, manages  # noqa: F401
from .models import Home, HomeBox, HomeMember

logger = logging.getLogger("promptly.home.manage")

# One list of who runs a home, shared with automations (``access.py``).
can_manage = manages


# ------------------------------------------------------------------ who's next


async def heirs(db: AsyncSession, home_id: uuid.UUID, *, leaving: uuid.UUID) -> list[tuple[User, str]]:
    """Everyone else in the home, best new owner first: co-owners, then
    members; the longest-standing first; switched-off accounts last."""
    rows = (
        await db.execute(
            select(User, HomeMember.role)
            .join(HomeMember, HomeMember.user_id == User.id)
            .where(HomeMember.home_id == home_id, HomeMember.user_id != leaving)
            .order_by(User.disabled.asc(), (HomeMember.role != COOWNER).asc(), HomeMember.created_at.asc(), User.created_at.asc())
        )
    ).all()
    return [(u, r) for u, r in rows]


async def pass_on(db: AsyncSession, home: Home, to: uuid.UUID, *, stay: bool) -> None:
    """The home is ``to``'s now. The old owner stays on as a co-owner, or
    leaves. Commits nothing; raises ``LookupError`` if ``to`` isn't in it."""
    new = await db.get(HomeMember, (home.id, to))
    if new is None or to == home.owner_id:
        raise LookupError("not in this home")
    old = await db.get(HomeMember, (home.id, home.owner_id))
    new.role = OWNER
    home.owner_id = to
    if old is not None:
        if stay:
            old.role = COOWNER
        else:
            await db.delete(old)
    await db.flush()
    # Its automations run as the home's owner, and would go with the old
    # owner's account: they are the new owner's now.
    from . import automations

    await automations.rehome(db, home.id, to)


# ------------------------------------------------------------------ wiping


async def wipe_box(box_id: uuid.UUID) -> bool:
    """Ask a connected box to forget what its home put on it. ``True`` once
    nothing of the home's is left that matters (no brand or bridge, no linked
    music service); ``False`` if the box didn't answer or something stayed.
    Holds no database connection."""
    try:
        for entry in await relay.request(box_id, "entries.list", {}) or []:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                try:
                    await relay.request(box_id, "entries.remove", {"entry": entry["id"]}, timeout=relay.SETUP_S)
                except relay.BoxSaidNo:
                    pass  # counted below, by looking again
        try:
            status = await relay.request(box_id, "music.status", {})
        except relay.BoxSaidNo:
            status = None  # no music service on this box
        for source in (status or {}).get("sources") or [] if isinstance(status, dict) else []:
            if isinstance(source, dict) and isinstance(source.get("id"), str):
                try:
                    await relay.request(box_id, "music.unlink", {"source": source["id"]}, timeout=relay.SETUP_S)
                except relay.BoxSaidNo:
                    pass
        live = relay.link(box_id)
        for area in list(live.areas) if live is not None else []:
            try:
                await relay.request(box_id, "areas.delete", {"area": area.get("id")})
            except relay.BoxSaidNo:
                pass  # an empty room left behind tells nobody anything
        left = await relay.request(box_id, "entries.list", {}) or []
        try:
            status = await relay.request(box_id, "music.status", {})
        except relay.BoxSaidNo:
            status = None
        linked = (status or {}).get("sources") if isinstance(status, dict) else None
        return not left and not linked
    except relay.BoxOffline:
        return False


async def _wiped(box_id: uuid.UUID) -> None:
    from app.database import SessionLocal

    async with SessionLocal() as db:
        box = await db.get(HomeBox, box_id)
        if box is not None and box.wipe_pending:
            box.wipe_pending = False
            box.snapshot = None
            await db.commit()


async def wipe_marked(box_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Wipe each of these (already marked ``wipe_pending``) that's connected
    now. Returns the ones still waiting: offline, or something wouldn't go.
    Call after the commit, with no session open."""
    waiting: list[uuid.UUID] = []
    for box_id in box_ids:
        live = relay.link(box_id)
        if live is None:
            waiting.append(box_id)
            continue
        live.hold = True
        live.entities, live.note, live.got_snapshot = {}, None, False  # its rooms are kept: they're what to delete
        if await wipe_box(box_id):
            await _wiped(box_id)
            # A fresh line, so what it says next is the whole (empty) picture.
            await relay.drop(box_id, relay.CLOSE_AGAIN)
        else:
            waiting.append(box_id)
    return waiting


async def pending(box_id: uuid.UUID) -> bool:
    """Is this box waiting to forget a home it left? Its own short session."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        box = await db.get(HomeBox, box_id)
        return bool(box is not None and box.wipe_pending)


_wiping: set[uuid.UUID] = set()


def wipe_when_ready(box_id: uuid.UUID) -> None:
    """A held box has said what it has (so its Home Assistant is up): wipe it
    now, in the background, once."""
    if box_id in _wiping:
        return
    _wiping.add(box_id)

    async def run() -> None:
        try:
            if await wipe_marked([box_id]):
                logger.warning("box %s still has something of the home it left; its devices stay hidden until that's gone", box_id)
        except Exception:  # noqa: BLE001
            logger.exception("wiping box %s failed", box_id)
        finally:
            _wiping.discard(box_id)

    asyncio.get_running_loop().create_task(run())


async def release(db: AsyncSession, box: HomeBox, *, new_code: bool) -> str | None:
    """Take a box out of its home, marked to forget that home's devices.
    Commits nothing. With ``new_code`` it gets a fresh claim code (returned,
    shown once) for whoever has it next; the server's own box never does."""
    code = codes.new_claim_code() if new_code and not builtin.is_builtin(box.id) else None
    box.home_id = None
    box.name = None
    box.snapshot = None
    box.claimed_by = None
    box.claimed_at = None
    box.wipe_pending = True
    if code is not None:
        box.claim_hash = codes.claim_digest(code)
    return code


async def wipe_home(db: AsyncSession, home: Home) -> list[uuid.UUID]:
    """Delete a home: its boxes are released and marked to be wiped, and the
    home and who was in it go. Commits nothing. Returns the boxes to hand to
    :func:`after_wipe` once the caller has committed."""
    boxes = (await db.execute(select(HomeBox).where(HomeBox.home_id == home.id).with_for_update())).scalars().all()
    ids = [b.id for b in boxes]
    for box in boxes:
        # No code is shown to anyone here: an admin makes a new setup for a
        # separate box before it's used again.
        await release(db, box, new_code=False)
    await db.flush()
    # Its automations and everyone's layout of its page go with it (the
    # database drops the rows); stop watching its devices for them.
    from . import automations

    automations.forget(home.id)
    await db.delete(home)
    await db.flush()
    return ids


async def after_wipe(home_id: uuid.UUID, box_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Tell the boxes they've left, then wipe the ones that are connected."""
    for box_id in box_ids:
        await relay.tell(box_id, None)
    relay.bump(home_id)
    return await wipe_marked(box_ids)


# ------------------------------------------------------------------ an account going


async def owned_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    return len((await db.execute(select(Home.id).where(Home.owner_id == user_id))).all())


async def before_user_deleted(db: AsyncSession, user: User) -> dict[str, Any]:
    """Settle every home ``user`` owns before their account goes (nobody is
    there to choose, and an admin doesn't see inside a home): it passes to
    its longest-standing co-owner, else its longest-standing member; a home
    with nobody else in it is wiped. Commits nothing. Returns counts for the
    audit line and ``wipe``: what to pass to :func:`after_user_deleted`."""
    passed = wiped = 0
    wipe: list[tuple[uuid.UUID, list[uuid.UUID]]] = []
    homes = (await db.execute(select(Home).where(Home.owner_id == user.id).with_for_update())).scalars().all()
    for home in homes:
        next_up = await heirs(db, home.id, leaving=user.id)
        if next_up:
            await pass_on(db, home, next_up[0][0].id, stay=False)
            relay.bump(home.id)
            passed += 1
        else:
            wipe.append((home.id, await wipe_home(db, home)))
            wiped += 1
    return {"passed": passed, "wiped": wiped, "wipe": wipe}


def after_user_deleted(settled: dict[str, Any]) -> None:
    """After the commit: wipe the boxes of homes that went, in the
    background (an admin's click doesn't wait on someone's box)."""
    wipe = settled.get("wipe") or []
    if not wipe:
        return

    async def run() -> None:
        for home_id, box_ids in wipe:
            try:
                await after_wipe(home_id, box_ids)
            except Exception:  # noqa: BLE001
                logger.exception("wiping the boxes of a deleted home failed")

    try:
        asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        pass
