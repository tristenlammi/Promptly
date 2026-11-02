"""Who's who for one viewer: their contacts, matched to Promptly accounts
(by an email on the contact, else by name), with the Photos person linked
to each contact and what they are to the viewer ("Wife").

The same matching the calendar's people suggestions always used
(:func:`app.calendars.sharing.contact_people` now calls this), shared by the
person page and the people picker. Only the viewer's own contacts files and
own Photos people are read; nothing of anyone else's.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User


@dataclass
class Person:
    """One person as the viewer knows them — any of the three parts may be missing."""

    user: User | None = None
    # How the account was found: "email" / "name" (from the contact), "me".
    match: str | None = None
    file_id: uuid.UUID | None = None
    contact: dict | None = None
    person_id: uuid.UUID | None = None
    person_name: str | None = None
    cover: uuid.UUID | None = None  # the Photos face shown for them
    label: str | None = None  # what they are to the viewer ("Wife")

    @property
    def contact_name(self) -> str | None:
        if self.contact is None:
            return None
        from app.items.kinds.contacts.logic import display_name

        return display_name(self.contact) or None

    @property
    def name(self) -> str:
        return self.contact_name or self.person_name or (self.user.username if self.user else "") or "Someone"


def _emails(c: dict) -> list[str]:
    return [(e.get("value") or "").strip().lower() for e in c.get("emails", []) if (e.get("value") or "").strip()]


def _names(c: dict) -> list[str]:
    from app.items.kinds.contacts.logic import display_name

    out = [display_name(c), c.get("first") or "", c.get("nickname") or ""]
    return [n.strip().lower() for n in out if n and n.strip()]


async def match_accounts(
    db: AsyncSession, viewer: User, contacts: list[dict], *, include_self: bool = False
) -> dict[str, tuple[User, str]]:
    """Contact id → (the Promptly account they are, "email" | "name").

    An email on the contact wins; else the contact's name, first name or
    nickname equal to a username. Disabled accounts never match."""
    emails = {e for c in contacts for e in _emails(c)}
    names = {n for c in contacts for n in _names(c)}
    if not emails and not names:
        return {}
    q = select(User).where(
        User.disabled.is_(False),
        or_(func.lower(User.email).in_(sorted(emails) or [""]), func.lower(User.username).in_(sorted(names) or [""])),
    )
    if not include_self:
        q = q.where(User.id != viewer.id)
    users = list((await db.execute(q)).scalars())
    by_email = {(u.email or "").lower(): u for u in users if u.email}
    by_name = {(u.username or "").lower(): u for u in users}
    out: dict[str, tuple[User, str]] = {}
    for c in contacts:
        u = next((by_email[e] for e in _emails(c) if e in by_email), None)
        if u is not None:
            out[c["id"]] = (u, "email")
            continue
        for n in _names(c):
            if n in by_name:
                out[c["id"]] = (by_name[n], "name")
                break
    return out


_PEOPLE_SQL = (
    "SELECT p.id, p.name, p.hidden, p.contact_file_id, p.contact_id, p.linked_user_id, r.label, "
    "COALESCE(p.cover_id, (SELECT f.id FROM photo_faces f WHERE f.person_id = p.id "
    "  ORDER BY f.size_px * f.score DESC LIMIT 1)) AS cover "
    "FROM photo_people p "
    "LEFT JOIN photo_relationships r ON r.person_id = p.id AND r.viewer_user_id = :u "
    "WHERE p.user_id = :u AND p.kind = 'person'"
)


async def photo_people(db: AsyncSession, viewer: User, where: str = "", **params: Any) -> list[Any]:
    """The viewer's own Photos people (with their relationship label and face)."""
    sql = _PEOPLE_SQL + (f" AND {where}" if where else "")
    return list((await db.execute(text(sql), {"u": viewer.id, **params})).all())


def _attach(p: Person, row: Any) -> None:
    p.person_id = row.id
    p.person_name = row.name
    p.cover = row.cover
    if row.label:
        p.label = row.label


async def directory(db: AsyncSession, viewer: User) -> list[Person]:
    """Everyone in the viewer's Contacts (with their account when matched),
    plus the named people in their Photos who aren't a contact."""
    from app.items import service as items

    out: list[Person] = []
    for row, doc in await items.list_items(db, viewer, "contacts", archives=False):
        for c in (doc.data or {}).get("contacts", []):
            if c.get("id"):
                out.append(Person(file_id=row.id, contact=c))
    matched = await match_accounts(db, viewer, [p.contact for p in out if p.contact])
    for p in out:
        hit = matched.get(p.contact["id"]) if p.contact else None
        if hit:
            p.user, p.match = hit
    by_contact = {(str(p.file_id), p.contact["id"]): p for p in out if p.contact}
    for r in await photo_people(db, viewer):
        if r.linked_user_id == viewer.id:
            continue  # that's you
        target = by_contact.get((str(r.contact_file_id), r.contact_id)) if r.contact_id else None
        if target is None and r.linked_user_id:
            target = next((p for p in out if p.user is not None and p.user.id == r.linked_user_id), None)
        if target is not None:
            if target.person_id is None:
                _attach(target, r)
            continue
        if r.name and not r.hidden:
            p = Person()
            _attach(p, r)
            out.append(p)
    return out


async def complete(db: AsyncSession, viewer: User, p: Person) -> Person:
    """Fill in what's missing of one person from what's known: the account a
    contact matches, the Photos person linked to the contact or account, and
    the viewer's contact for an account."""
    if p.contact is not None and p.user is None:
        hit = (await match_accounts(db, viewer, [p.contact], include_self=True)).get(p.contact["id"])
        if hit:
            p.user, p.match = hit
            if p.user.id == viewer.id:
                p.match = "me"
    if p.user is not None and p.contact is None and p.user.id != viewer.id:
        mine = [q for q in await directory(db, viewer) if q.user is not None and q.user.id == p.user.id and q.contact is not None]
        mine.sort(key=lambda q: q.match != "email")
        if mine:
            q = mine[0]
            p.file_id, p.contact, p.match = q.file_id, q.contact, q.match
            if p.person_id is None and q.person_id is not None:
                p.person_id, p.person_name, p.cover = q.person_id, q.person_name, q.cover
                p.label = p.label or q.label
    if p.person_id is None and p.contact is not None:
        rows = await photo_people(db, viewer, "p.contact_file_id = :f AND p.contact_id = :c", f=p.file_id, c=p.contact["id"])
        if rows:
            _attach(p, rows[0])
    if p.person_id is None and p.user is not None:
        rows = await photo_people(db, viewer, "p.linked_user_id = :t", t=p.user.id)
        if rows:
            _attach(p, rows[0])
    return p
