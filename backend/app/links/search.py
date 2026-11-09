"""The picker behind "Link…" and ``[[`` mentions: things across apps.

Only things the person can see come back — their own Drive files, albums
they're in, their own app files (tasks, contacts, trips, recipes, journal,
budget), events they can see (not free/busy-only), their Photos people,
accounts on this Promptly and items in workspaces they're a member of.
Each result is ``{kind, id, title, subtitle, href}``; the id is what a
mention or a link stores.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import refs

KIND_ORDER = ("event", "task", "contact", "person", "user", "file", "photo", "album", "trip", "recipe", "journal", "txn", "witem")
KIND_ORDER = (*KIND_ORDER, "note")  # Notes (app/notes)


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _hit(q: str, *texts: Any) -> bool:
    return any(q in str(t or "").lower() for t in texts)


def _r(kind: str, id_: str, title: str, subtitle: str = "", href: str | None = None) -> dict:
    return {"kind": kind, "id": id_, "label": refs.LABELS[kind], "title": title or refs.LABELS[kind], "subtitle": subtitle, "href": href}


async def _app_things(db: AsyncSession, user: User, q: str, limit: int, kinds: set[str]) -> list[dict]:
    from app.crossapp.shares import _day_text
    from app.items import service as items
    from app.items.kinds.contacts.logic import display_name

    out: list[dict] = []
    wanted = {refs.IN_ITEM[k]: k for k in kinds if k in refs.IN_ITEM}
    for app, kind in wanted.items():
        n = 0
        for row, doc in await items.list_items(db, user, app, limit=5, archives=False):
            data = doc.data or {}
            fid = row.id
            if kind == "task":
                seq = [(t["id"], t.get("title", ""), ("Done" if t.get("done") else "Task") + (f" · due {_day_text(t['due'])}" if t.get("due") else ""))
                       for t in data.get("tasks", []) if _hit(q, t.get("title"), t.get("notes"))]
            elif kind == "contact":
                seq = [(c["id"], display_name(c), " · ".join(x for x in ("Contact", c.get("company") or "") if x))
                       for c in data.get("contacts", []) if _hit(q, display_name(c), c.get("nickname"), c.get("company"))]
            elif kind == "trip":
                seq = [(t["id"], t.get("title", ""), "Trip" + (f" · {_day_text(t['start'])}" if t.get("start") else ""))
                       for t in data.get("trips", []) if _hit(q, t.get("title"), *[d.get("name") for d in t.get("destinations", [])])]
            elif kind == "recipe":
                seq = [(r["id"], r.get("title", ""), "Recipe") for r in data.get("recipes", []) if _hit(q, r.get("title"))]
            elif kind == "journal":
                seq = [(e["id"], e.get("title") or f"Journal · {_day_text(e.get('date'))}", f"Journal entry · {_day_text(e.get('date'))}")
                       for e in sorted(data.get("entries", []), key=lambda e: e.get("date") or "", reverse=True)
                       if _hit(q, e.get("title"), e.get("body"), e.get("date"))]
            else:  # txn
                seq = [(t["id"], t.get("payee") or t.get("description") or "Transaction",
                        f"Transaction · {_day_text(t.get('date'))} · {int(t.get('amount_cents') or 0) / 100:,.2f}")
                       for t in sorted(data.get("transactions", []), key=lambda t: t.get("date") or "", reverse=True)
                       if _hit(q, t.get("payee"), t.get("description"), t.get("notes"))]
            for sid, title, sub in seq:
                if not refs.valid(kind, f"{fid}:{sid}"):
                    continue
                out.append(_r(kind, f"{fid}:{sid}", title, sub))
                n += 1
                if n >= limit:
                    break
            if n >= limit:
                break
    return out


async def search(db: AsyncSession, user: User, q: str, limit: int = 6, kinds: set[str] | None = None) -> list[dict]:
    term = (q or "").strip().lower()
    if len(term) < 1:
        return []
    want = set(kinds or KIND_ORDER) & set(KIND_ORDER)
    out: list[dict] = []
    pat = _like(term)

    if "event" in want:
        from app.calendars import lookup

        for e in (await lookup.search(db, user, term, limit=limit * 2)):
            if e.get("busy_only"):
                continue
            from app.crossapp.shares import _day_text

            out.append(_r("event", str(e["event_id"]), e.get("title") or "Event", f"Event · {_day_text(e.get('start'))}"))
            if sum(1 for r in out if r["kind"] == "event") >= limit:
                break

    out += await _app_things(db, user, term, limit, want)

    if "person" in want:
        from app.people.directory import photo_people

        for r in await photo_people(db, user, "p.name ILIKE :pat", pat=pat):
            if r.name:
                out.append(_r("person", str(r.id), r.name, "Person" + (f" · {r.label}" if r.label else "")))
    if "user" in want and len(term) >= 2:
        rows = (
            await db.execute(
                select(User).where(User.disabled.is_(False), User.username.ilike(pat, escape="\\")).order_by(User.username).limit(limit)
            )
        ).scalars()
        out += [_r("user", str(u.id), u.username, "Person on Promptly") for u in rows]

    if want & {"file", "photo"}:
        from app.files.generated_kinds import HIDDEN_KINDS
        from app.files.models import UserFile
        from app.files.office_templates import office_title

        rows = (
            await db.execute(
                select(UserFile)
                .where(
                    UserFile.user_id == user.id,
                    UserFile.trashed_at.is_(None),
                    # Never a hidden row: a form's pictures, files people
                    # sent with form answers, the AI's text mirrors.
                    or_(
                        UserFile.source_kind.is_(None),
                        UserFile.source_kind.not_in(["item", *sorted(HIDDEN_KINDS)]),
                    ),
                    UserFile.filename.ilike(pat, escape="\\"),
                )
                .order_by(UserFile.updated_at.desc())
                .limit(limit * 2)
            )
        ).scalars()
        for f in rows:
            media = (f.mime_type or "").startswith(("image/", "video/"))
            kind = "photo" if media else "file"
            if kind in want:
                label = "Photo" if media else ("Form" if f.source_kind == "form" else "File")
                out.append(_r(kind, str(f.id), office_title(f), label))

    if "album" in want:
        from app.photos.album_models import Album, AlbumMember

        mine = select(AlbumMember.album_id).where(AlbumMember.user_id == user.id)
        rows = (
            await db.execute(
                select(Album)
                .where(or_(Album.owner_id == user.id, Album.id.in_(mine)), Album.title.ilike(pat, escape="\\"))
                .order_by(Album.updated_at.desc())
                .limit(limit)
            )
        ).scalars()
        out += [_r("album", str(a.id), a.title, "Album") for a in rows]

    if "witem" in want:
        from app.chat.models import Workspace, WorkspaceItem
        from app.chat.shares import list_accessible_workspace_ids
        from app.workspaces.visibility import item_visible_to

        ws_ids = await list_accessible_workspace_ids(user, db)
        if ws_ids:
            rows = (
                await db.execute(
                    select(WorkspaceItem, Workspace.title)
                    .join(Workspace, Workspace.id == WorkspaceItem.workspace_id)
                    .where(
                        WorkspaceItem.workspace_id.in_(ws_ids),
                        Workspace.trashed_at.is_(None),
                        WorkspaceItem.trashed_at.is_(None),
                        WorkspaceItem.kind != "container",
                        item_visible_to(user.id),
                        WorkspaceItem.title.ilike(pat, escape="\\"),
                    )
                    .order_by(WorkspaceItem.updated_at.desc())
                    .limit(limit)
                )
            ).all()
            out += [_r("witem", str(it.id), it.title, f"{refs.witem_kind(it.kind)} · {wt}") for it, wt in rows]

    if "note" in want:
        from app.notes.access import visible_predicate
        from app.notes.models import Note
        from app.notes.service import display_title

        rows = (
            await db.execute(
                select(Note)
                .where(visible_predicate(user.id), or_(Note.title.ilike(pat, escape="\\"), Note.search_text.ilike(pat, escape="\\")))
                .order_by(Note.updated_at.desc())
                .limit(limit)
            )
        ).scalars()
        out += [_r("note", str(n.id), display_title(n), "Note", f"/notes/n/{n.id}") for n in rows]

    order = {k: i for i, k in enumerate(KIND_ORDER)}
    per: dict[str, int] = {}
    final: list[dict] = []
    for r in sorted(out, key=lambda r: (order.get(r["kind"], 99), not r["title"].lower().startswith(term))):
        per[r["kind"]] = per.get(r["kind"], 0) + 1
        if per[r["kind"]] <= limit:
            final.append(r)
    return final
