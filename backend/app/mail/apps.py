"""Mail and the rest of Promptly: answering invites, filing attachments, making tasks
and contacts, and what Today and Ctrl+K show."""
from __future__ import annotations

import copy
import io
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import compose, invites, search
from .models import MailAccount, MailInvite, MailMessage, MailOutbox

ANSWERS = {"going": "accepted", "maybe": "said maybe to", "declined": "declined"}


def queue(db: AsyncSession, account: MailAccount, user: User, message: Any, recipients: list[str], send_at: datetime) -> MailOutbox:
    item = MailOutbox(account_id=account.id, user_id=user.id, raw=message.as_bytes().decode("utf-8", "surrogateescape"), recipients=recipients, send_at=send_at)
    db.add(item)
    return item


# ---- calendar invites


async def answer_invite(db: AsyncSession, user: User, account: MailAccount, message: MailMessage, answer: str) -> dict[str, Any]:
    """Puts it in your calendar (or takes it out) and tells the organiser."""
    from app.calendars import service

    invite = message.invite
    if not invite or invite.get("cancelled") or invite.get("method") not in ("REQUEST", "PUBLISH"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="This invite can't be answered.")
    row = await db.get(MailInvite, (user.id, invite["uid"]))
    if row is None:
        row = MailInvite(user_id=user.id, uid=invite["uid"], status=answer, sequence=-1)
        db.add(row)
    changed = int(invite.get("sequence") or 0) > row.sequence
    if row.event_id and (answer == "declined" or changed):
        await _remove_event(db, user, row)
    if answer != "declined" and row.event_id is None:
        organiser = invite.get("organizer") or {}
        who = organiser.get("name") or organiser.get("addr") or message.from_addr
        notes = f"Invited by {who}.\n\n{invite.get('description') or ''}".strip()
        event = await service.create_event(db, user, service.EventFields(
            title=invite["title"], description=notes[:4000], location=invite.get("location") or "", all_day=invite["all_day"],
            start=invite["start"], end=invite.get("end"),
        ), ping_guests=False)
        row.event_id = event.id
    row.status, row.sequence = answer, int(invite.get("sequence") or 0)

    organiser_addr = ((invite.get("organizer") or {}).get("addr") or "").strip()
    told = bool(organiser_addr and "@" in organiser_addr and organiser_addr.lower() != account.email.lower() and invite.get("method") == "REQUEST")
    if told:
        me = next((a["addr"] for a in invite.get("attendees") or [] if a["addr"].lower() == account.email.lower()), account.email)
        calendar = invites.reply_ics(invite, email=me, name=account.display_name, status=answer)
        sent = compose.build(account, compose.Draft(
            to=[organiser_addr], cc=[], subject=f"{ANSWERS[answer].capitalize()}: {invite['title']}",
            text=f"{account.display_name or account.email} {ANSWERS[answer]} this invitation.",
            files=[compose.File("invite.ics", "text/calendar", calendar.encode(), {"method": "REPLY"})],
        ))
        queue(db, account, user, sent, [organiser_addr], datetime.now(timezone.utc))
    await db.execute(text("UPDATE mail_messages SET needs_reply = false WHERE account_id = :a AND thread_key = :k"), {"a": account.id, "k": message.thread_key})
    await db.commit()
    return await invite_state(db, user, invite["uid"]) | {"told_organiser": told}


async def _remove_event(db: AsyncSession, user: User, row: MailInvite) -> None:
    from app.calendars import service

    try:
        await service.delete_event(db, user, row.event_id)
    except HTTPException:
        pass  # Already gone from the calendar.
    row.event_id = None


async def remove_cancelled(db: AsyncSession, user: User, uid: str) -> None:
    row = await db.get(MailInvite, (user.id, uid))
    if row is not None and row.event_id:
        await _remove_event(db, user, row)
    if row is not None:
        row.status = "declined"
    await db.commit()


async def invite_state(db: AsyncSession, user: User, uid: str) -> dict[str, Any]:
    row = await db.get(MailInvite, (user.id, uid))
    if row is None:
        return {"answer": None, "event_url": None}
    return {"answer": row.status, "event_url": f"/calendar?event={row.event_id}" if row.event_id else None}


# ---- files


async def save_to_files(db: AsyncSession, request: Request, user: User, name: str, mime: str, data: bytes) -> Any:
    """Through the one upload path, so an attachment gets every check an upload does."""
    from app.files import blobstore
    from app.files.router import ingest_staged
    from app.files.system_folders import ensure_mail_attachments

    folder = await ensure_mail_attachments(db, user)
    await db.commit()
    staged = await blobstore.stage_upload(io.BytesIO(data))
    try:
        return await ingest_staged(
            db, request=request, user=user, staged=staged, filename=name, declared_mime=mime, scope="mine", folder_id=folder.id,
            route=None, on_conflict="keep_both", workspace_id=None, last_modified=None, exact_folder=True,
        )
    finally:
        blobstore.blobstore.discard(staged)


async def files_to_attach(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[compose.File]:
    """Files you can read, for attaching. Someone else's is simply not found."""
    import asyncio

    from app.files.access import can_read
    from app.files.models import UserFile
    from app.files.office import is_shell
    from app.files.storage import absolute_path

    out = []
    for fid in ids:
        row = await db.get(UserFile, fid)
        if row is None or row.trashed_at is not None or not await can_read(db, fid, user.id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="One of those files wasn't found.")
        if is_shell(row):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"{row.filename} is a Promptly document. Download it as a file first, then attach that.")
        out.append(compose.File(row.filename, row.mime_type or "application/octet-stream", await asyncio.to_thread(absolute_path(row.storage_path).read_bytes)))
    return out


# ---- tasks and contacts


async def _run_app_action(db: AsyncSession, user: User, kind: str, action: str, args: dict[str, Any]) -> None:
    from app.items import service
    from app.items.registry import get_spec

    row, _ = await service.open_app(db, user, kind)
    row, doc, _access = await service.load(db, user, row.id, lock=True)
    spec = get_spec(kind)
    data = copy.deepcopy(doc.data)
    ctx = service.make_context(db, user, row.id, spec)
    await service.run_action(ctx, spec, data, action, args)
    await service.save_data(db, user, row, doc, data, base_revision=None)
    await db.commit()


async def make_task(db: AsyncSession, user: User, account_id: uuid.UUID, key: str, title: str, summary: str, sender: str) -> None:
    notes = "\n".join(x for x in (f"From {sender}." if sender else "", summary, f"/mail?open={account_id}/{key}") if x)
    await _run_app_action(db, user, "tasks", "add_tasks", {"tasks": [{"title": title[:500] or "Follow up on an email", "notes": notes}]})


async def add_contact(db: AsyncSession, user: User, name: str, addr: str) -> None:
    await _run_app_action(db, user, "contacts", "add_contacts", {
        "contacts": [{"full_name": name or addr.split("@")[0], "emails": [{"label": "work", "value": addr}]}], "on_duplicate": "skip",
    })


async def known_people(db: AsyncSession, user: User, addrs: list[str]) -> dict[str, dict[str, Any]]:
    """Who these addresses are to you, with a picture if there is one: the contact's
    own photo, their Promptly picture, or their face from your Photos."""
    from app.people.directory import _emails, directory
    from app.people.router import _crop
    from app.rooms.core import user_out

    wanted = {a.strip().lower() for a in addrs}
    out: dict[str, dict[str, Any]] = {}
    for person in await directory(db, user):
        contact = person.contact
        if not contact:
            continue
        for addr in _emails(contact):
            if addr in wanted and addr not in out:
                account = user_out(person.user) if person.user else {}
                out[addr] = {
                    "name": person.contact_name or "",
                    "photo": contact.get("photo") or account.get("avatar_url") or _crop(person.cover, user),
                }
    return out


async def people_matching(db: AsyncSession, user: User, typed: str) -> list[dict[str, str]]:
    """Contacts first in the To box: they're who you've said you know."""
    from app.people.directory import _emails, directory

    out = []
    for person in await directory(db, user):
        if not person.contact:
            continue
        name = person.contact_name or ""
        for addr in _emails(person.contact):
            if typed in addr or typed in name.lower():
                out.append({"name": name, "addr": addr})
    return out[:8]


# ---- Today and Ctrl+K


async def today_section(db: AsyncSession, user: User) -> dict[str, Any] | None:
    from .router import _NEEDS_REPLY, _NOT_SNOOZED_M, _my_account_ids

    accounts = await _my_account_ids(db, user)
    if not accounts:
        return None
    unread = await db.scalar(text(
        f"SELECT count(DISTINCT (m.account_id, m.thread_key)) FROM mail_messages m JOIN mail_folders f ON f.id = m.folder_id "
        f"WHERE m.account_id = ANY(:accounts) AND f.role = 'inbox' AND NOT m.seen AND {_NOT_SNOOZED_M}"
    ), {"accounts": accounts}) or 0
    waiting = (await db.execute(text(
        f"SELECT DISTINCT ON (m.account_id, m.thread_key) m.account_id, m.thread_key, m.subject, m.from_name, m.from_addr, m.summary, m.sent_at "
        f"FROM mail_messages m JOIN mail_folders f ON f.id = m.folder_id WHERE m.account_id = ANY(:accounts) AND f.role = 'inbox' "
        f"AND {_NEEDS_REPLY.replace('account_id', 'm.account_id', 1).replace('thread_key', 'm.thread_key', 1)} AND {_NOT_SNOOZED_M} "
        f"ORDER BY m.account_id, m.thread_key, m.sent_at DESC"
    ), {"accounts": accounts})).all()
    waiting = sorted(waiting, key=lambda r: r.sent_at, reverse=True)
    if not unread and not waiting:
        return None
    return {
        "url": "/mail", "unread": int(unread), "needs_reply": len(waiting),
        "items": [
            {"from": r.from_name or r.from_addr, "subject": r.subject or "(No subject)", "summary": r.summary, "url": f"/mail?open={r.account_id}/{r.thread_key}"}
            for r in waiting[:4]
        ],
    }


async def quick_search(db: AsyncSession, user: User, term: str, limit: int) -> list[dict[str, str]]:
    """Exact words first, then anything AI search found, one row per conversation."""
    from .router import _SEARCHABLE, _my_account_ids

    accounts = await _my_account_ids(db, user)
    if not accounts:
        return []
    from app.chat.router import partial_word_query

    partial = partial_word_query(term)
    query = "(websearch_to_tsquery('simple', :q) || to_tsquery('simple', :partial))" if partial else "websearch_to_tsquery('simple', :q)"
    ids = list((await db.execute(text(
        f"SELECT id FROM mail_messages WHERE account_id = ANY(:ids) AND {_SEARCHABLE} @@ {query} ORDER BY sent_at DESC LIMIT :n"
    ), {"ids": accounts, "q": term, "n": limit * 4, **({"partial": partial} if partial else {})})).scalars())
    ids += [i for i in await search.nearest(db, accounts, term, limit=limit) if i not in ids]
    if not ids:
        return []
    rows = {m.id: m for m in (await db.execute(select(MailMessage).where(MailMessage.id.in_(ids)))).scalars()}
    out, seen = [], set()
    for i in ids:
        m = rows.get(i)
        if m is None or (m.account_id, m.thread_key) in seen:
            continue
        seen.add((m.account_id, m.thread_key))
        out.append({"id": str(m.id), "subject": m.subject or "(No subject)", "from": m.from_name or m.from_addr, "at": m.sent_at.isoformat(), "url": f"/mail?open={m.account_id}/{m.thread_key}"})
    return out[:limit]
