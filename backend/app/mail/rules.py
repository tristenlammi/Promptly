"""Filing mail: moving it out of a folder, and the rules that label it as it arrives.

A rule only ever labels mail and files it in your own Archive. It can't send
anything anywhere, so a forged sender can't get more than a misfiled email.
"""
from __future__ import annotations

import uuid
from typing import Iterable

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import MailAccount, MailFolder, MailLabel, MailMessage, MailOp, MailRule, MailThreadLabel

# What a label never shows, and what a rule never looks at.
HIDDEN_FROM_LABELS = {"trash", "spam", "drafts"}
NOT_FOR_RULES = HIDDEN_FROM_LABELS | {"sent"}
STAY_PUT = {"sent", "drafts"}


def normalise(kind: str, value: str) -> str | None:
    """The form a rule is stored and compared in, or None if it can't match sensibly."""
    v = value.strip().lower()
    if kind == "from":
        return v if "@" in v.strip("@") and " " not in v else None
    if kind == "domain":
        v = v.lstrip("@")
        return v if "." in v.strip(".") and "@" not in v and " " not in v else None
    if kind == "subject":
        return v if 3 <= len(v) <= 200 else None
    return None


def matches(rule: MailRule, from_addr: str, subject: str) -> bool:
    addr = from_addr.lower()
    if rule.kind == "from":
        return addr == rule.value
    if rule.kind == "domain":
        return addr.endswith("@" + rule.value)
    return rule.value in subject.lower()


def condition(kind: str, value: str):
    """The same test as ``matches``, for mail that's already here."""
    addr = func.lower(MailMessage.from_addr)
    if kind == "from":
        return addr == value
    if kind == "domain":
        return addr.endswith("@" + value, autoescape=True)
    return func.lower(MailMessage.subject).contains(value, autoescape=True)


# Colours for labels that come from a mailbox.
_COLOURS = ("#D97757", "#C9A227", "#6B9E78", "#4F9DA6", "#5B7FBF", "#8E6FB5", "#C2668A", "#8A7F73")
# Views and system places some providers list as ordinary folders.
_NOT_A_LABEL_PREFIXES = ("[gmail]", "[google mail]")
_NOT_A_LABEL_NAMES = {"notes", "outbox", "conversation history", "sync issues", "calendar", "contacts", "tasks", "journal"}
MAX_LABELS = 100


def label_name_for(folder_path: str) -> str | None:
    """What a mailbox folder is called as a label, or None if it shouldn't be one."""
    path = folder_path.strip()
    lowered = path.lower()
    if not path or lowered.startswith(_NOT_A_LABEL_PREFIXES) or lowered in _NOT_A_LABEL_NAMES:
        return None
    return path[:60]


async def sync_folder_labels(db: AsyncSession, account_id: uuid.UUID) -> None:
    """Every folder of your own shows as a label. The same name in two mailboxes is
    one label. Nothing in the mailbox changes by this."""
    user_id = await db.scalar(select(MailAccount.user_id).where(MailAccount.id == account_id))
    folders = (await db.execute(
        select(MailFolder).where(MailFolder.account_id == account_id, MailFolder.role == "other", MailFolder.label_id.is_(None), MailFolder.label_off.is_(False))
    )).scalars().all()
    if not folders or user_id is None:
        return
    labels = (await db.execute(select(MailLabel).where(MailLabel.user_id == user_id))).scalars().all()
    named = {x.name.lower(): x for x in labels}
    for folder in folders:
        name = label_name_for(folder.path)
        if name is None:
            continue
        label = named.get(name.lower())
        if label is None:
            if len(named) >= MAX_LABELS:
                return
            label = MailLabel(user_id=user_id, name=name, color=_COLOURS[len(named) % len(_COLOURS)])
            db.add(label)
            await db.flush()
            named[name.lower()] = label
        folder.label_id = label.id


async def destination(db: AsyncSession, account_id: uuid.UUID, label_id: uuid.UUID) -> MailFolder | None:
    """Where in the mailbox a conversation under this label belongs: the label's own
    folder if it came from there, so Gmail stays in step, or otherwise the Archive."""
    own = await db.scalar(select(MailFolder).where(MailFolder.account_id == account_id, MailFolder.label_id == label_id).limit(1))
    return own or await archive_folder(db, account_id)


async def archive_folder(db: AsyncSession, account_id: uuid.UUID) -> MailFolder | None:
    """Gmail has no Archive: there, archiving means leaving only All Mail."""
    folders = (await db.execute(select(MailFolder).where(MailFolder.account_id == account_id, MailFolder.role.in_(("archive", "all"))))).scalars().all()
    return next((f for f in folders if f.role == "archive"), folders[0] if folders else None)


def move(db: AsyncSession, folders: dict[uuid.UUID, MailFolder], messages: Iterable[MailMessage], target: MailFolder, even_sent: bool = False) -> None:
    """Moved here at once. The mailbox follows through ``mail_ops``."""
    by_folder: dict[uuid.UUID, list[MailMessage]] = {}
    for m in messages:
        by_folder.setdefault(m.folder_id, []).append(m)
    for folder_id, rows in by_folder.items():
        source = folders[folder_id]
        if (source.role in STAY_PUT and not even_sent) or folder_id == target.id:
            continue
        uids = [m.uid for m in rows if m.uid is not None]
        if uids:
            db.add(MailOp(account_id=target.account_id, kind="move", folder_path=source.path, uids=uids, target_path=target.path))
        # Moved here a moment ago, so it has no number here yet. Changes go out in
        # order, so by the time this one runs it'll be here to find.
        unnumbered = [m.message_id for m in rows if m.uid is None and m.message_id]
        if unnumbered:
            db.add(MailOp(account_id=target.account_id, kind="move_found", folder_path=source.path, uids=unnumbered, target_path=target.path))
        for m in rows:
            m.folder_id, m.uid = target.id, None


async def add_label(db: AsyncSession, label_id: uuid.UUID, account_id: uuid.UUID, thread_key: str) -> None:
    """Puts a conversation under this label, and only this one."""
    statement = insert(MailThreadLabel).values(label_id=label_id, account_id=account_id, thread_key=thread_key)
    await db.execute(statement.on_conflict_do_update(index_elements=["account_id", "thread_key"], set_={"label_id": label_id}))


async def clear_label(db: AsyncSession, account_id: uuid.UUID, thread_key: str) -> None:
    await db.execute(delete(MailThreadLabel).where(MailThreadLabel.account_id == account_id, MailThreadLabel.thread_key == thread_key))


async def file_away(db: AsyncSession, account_id: uuid.UUID, label_id: uuid.UUID, messages: Iterable[MailMessage], roles: tuple[str, ...] | None = ("inbox",)) -> None:
    """Out of where it was in the real mailbox too, so other mail apps agree. A mailbox
    with nowhere to put it keeps it there, and Promptly's Inbox still leaves it out."""
    target = await destination(db, account_id, label_id)
    if target is None:
        return
    folders = {f.id: f for f in (await db.execute(select(MailFolder).where(MailFolder.account_id == account_id))).scalars()}
    move(db, folders, [m for m in messages if roles is None or folders[m.folder_id].role in roles], target)


async def apply_to_new(db: AsyncSession, account_id: uuid.UUID, folder: MailFolder, messages: list[MailMessage]) -> set[uuid.UUID]:
    """Runs as mail arrives. A reply follows its conversation to its label. Otherwise
    a rule takes mail newer than itself, so older mail coming in later stays where it
    is. Returns what a rule filed, which doesn't need to interrupt anyone."""
    # What's in All Mail is your archive coming in, not mail arriving.
    if not messages or folder.role in NOT_FOR_RULES or folder.role == "all":
        return set()
    owner = select(MailAccount.user_id).where(MailAccount.id == account_id).scalar_subquery()
    found = (await db.execute(select(MailRule).where(MailRule.user_id == owner).order_by(MailRule.created_at))).scalars().all()
    placed = dict((await db.execute(
        select(MailThreadLabel.thread_key, MailThreadLabel.label_id).where(MailThreadLabel.account_id == account_id, MailThreadLabel.thread_key.in_({m.thread_key for m in messages}))
    )).all())
    leaving: list[tuple[MailMessage, uuid.UUID]] = []
    quiet: set[uuid.UUID] = set()
    for m in messages:
        if m.thread_key in placed:
            leaving.append((m, placed[m.thread_key]))
            continue
        rule = next((r for r in found if matches(r, m.from_addr, m.subject) and m.sent_at >= r.created_at), None)
        if rule is not None:
            await add_label(db, rule.label_id, account_id, m.thread_key)
            placed[m.thread_key] = rule.label_id
            quiet.add(m.id)
            leaving.append((m, rule.label_id))
    # Without a Message-ID the move couldn't be recognised when it lands.
    if folder.role == "inbox":
        for m, label_id in leaving:
            target = await destination(db, account_id, label_id)
            if m.message_id and target is not None:
                move(db, {folder.id: folder}, [m], target)
    return quiet
