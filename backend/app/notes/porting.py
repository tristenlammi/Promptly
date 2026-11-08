"""Notes moving in and out (N1.6).

**In** (``imports.run`` calls :func:`existing_refs` and :func:`make_note`):
a note read from Google Keep (``imports.keep``) or from a Promptly export
becomes yours with its colour, pin, archive, labels (#tags), checklist
(ticks and indents), pictures and recordings, and its Keep dates. Each
carries an ``import_ref`` (unique per owner), so importing the same thing
again skips what's already in.

**Out** (``files.library_export`` calls :func:`export_plan` and
:func:`export_files`): every note you own (not the ones shared with you —
they're their owner's) as ``Promptly/Notes/<title>.md`` — front-matter
(colour, pinned, archived, labels, dates, reminder, shared with), the body
as Markdown, a list as ``- [ ]`` / ``- [x]``, pictures and recordings
linked to where they are in the export — and ``Promptly/Notes/notes.json``
in Keep's shape with a ``promptly`` block, so the folder importer can bring
an export back whole.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import attachments as attach
from . import body as B
from . import service
from .models import Note, NoteAttachment, NoteItem, NoteMember, NoteUserState

logger = logging.getLogger("promptly.notes.porting")

NOTES_DIR = "Promptly/Notes/"
NOTES_JSON = NOTES_DIR + "notes.json"


# ================================================================== in


async def existing_refs(db: AsyncSession, user_id: uuid.UUID, specs: list[dict[str, Any]]) -> set[str]:
    """The refs among ``specs`` this person already has a note for (by
    ``import_ref``, or — an export brought back into the same account — the
    note's own id)."""
    refs = [s["ref"] for s in specs if s.get("ref")]
    have: set[str] = set()
    for i in range(0, len(refs), 1000):
        batch = refs[i : i + 1000]
        have.update(
            r for r in (
                await db.execute(select(Note.import_ref).where(Note.owner_id == user_id, Note.import_ref.in_(batch)))
            ).scalars() if r
        )
    ids: dict[uuid.UUID, str] = {}
    for s in specs:
        try:
            if s.get("id"):
                ids[uuid.UUID(str(s["id"]))] = s["ref"]
        except ValueError:
            continue
    if ids:
        mine = (
            await db.execute(select(Note.id).where(Note.owner_id == user_id, Note.id.in_(list(ids))))
        ).scalars().all()
        have.update(ids[i] for i in mine)
    return have


def _when(epoch: float | None) -> datetime | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


async def make_note(
    db: AsyncSession,
    user: User,
    spec: dict[str, Any],
    files: list[tuple[uuid.UUID, str, str | None]],
    *,
    transcribe: bool,
) -> tuple[Note, list[uuid.UUID]]:
    """One imported note, not yet committed. ``files``: (file id, kind,
    transcript) of its pictures and recordings, already yours. Returns the
    note and its recordings' attachment ids (for the worker)."""
    from app.tags.items_sync import tag_ids_for

    tag_ids: list[uuid.UUID] = []
    if spec.get("labels"):
        found = await tag_ids_for(db, user.id, list(spec["labels"]))
        tag_ids = list(dict.fromkeys(found.values()))
    body_doc = spec.get("body_doc") if spec.get("kind") == "text" else None
    try:
        if body_doc is not None:
            body_doc = B.clean_doc(body_doc)
            if body_doc is not None:
                B.checked_text(B.doc_text(body_doc))
    except B.BodyError:
        # Too long (or not a body we can keep): its plain text, cut to fit.
        text = B.doc_text(body_doc) if isinstance(body_doc, dict) and body_doc.get("type") == "doc" else ""
        body_doc = B.text_doc(text[: B.MAX_TEXT - 100])
    note, _made = await service.create(
        db, user, note_id=None, kind=spec.get("kind") or "text", title=str(spec.get("title") or "")[:300],
        body_doc=body_doc if spec.get("kind") != "list" else None,
        text=None if spec.get("kind") == "text" else "",
        items=[{"text": i["text"], "checked": bool(i.get("checked")), "indent": bool(i.get("indent"))} for i in spec.get("items") or []],
        color=spec.get("color") or "default", tag_ids=tag_ids, pinned=bool(spec.get("pinned")),
        archived=bool(spec.get("archived")), source="import",
    )
    note.import_ref = str(spec["ref"])[:200]
    audio: list[uuid.UUID] = []
    for file_id, kind, transcript in files:
        try:
            att, _new = await attach.add(
                db, user, note, attachment_id=uuid.uuid4(), file_id=file_id, kind=kind, transcribe=transcribe and not transcript,
            )
        except Exception:  # noqa: BLE001 — a file that can't go in a note leaves the note without it
            logger.info("import: file %s not attached to a note", file_id, exc_info=True)
            continue
        if att.kind == "audio":
            if transcript:
                att.transcript, att.transcript_state = transcript, "done"
                att.transcribed_at = datetime.now(timezone.utc)
            audio.append(att.id)
    if files:
        await db.flush()
        await service.refresh_search_text(db, note)
    created, edited = _when(spec.get("created")), _when(spec.get("edited"))
    if created is not None:
        note.created_at = created
    if edited is not None or created is not None:
        note.updated_at = edited or created
    st = await service.state_for(db, note.id, user.id)
    if edited is not None or created is not None:
        # Your order follows Keep's: the last edited first, after what you
        # made here since.
        st.position = -(edited or created).timestamp()
    await db.flush()
    return note, audio


# ================================================================== out


def _safe(name: str) -> str:
    n = "".join(ch if ch not in '/\\:*?"<>|\x00' and ord(ch) >= 32 else "_" for ch in (name or "")).strip().strip(".")
    return n[:120] or "Untitled note"


async def export_plan(db: AsyncSession, user: User) -> list[str]:
    """The ids of the notes an export writes: yours, not in the trash."""
    return [
        str(i)
        for i in (
            await db.execute(
                select(Note.id).where(Note.owner_id == user.id, Note.trashed_at.is_(None)).order_by(Note.created_at)
            )
        ).scalars()
    ]


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def _yaml_str(v: str) -> str:
    return json.dumps(v, ensure_ascii=False)


def _rel(arc: str) -> str:
    """An export path, as a link from ``Promptly/Notes/``."""
    return "../" + arc[len("Promptly/"):] if arc.startswith("Promptly/") else arc


async def export_files(
    db: AsyncSession, user_id: uuid.UUID, note_ids: list[str], arc_of: dict[str, str], in_photos: set[str]
) -> list[tuple[str, bytes, float]]:
    """(arcname, bytes, modified epoch) for every note's ``.md`` and the one
    ``notes.json``. ``arc_of``: file id → its path in the export (only your
    own files are there); ``in_photos``: the ones in your Photos library."""
    from app.imports.keep import KEEP_COLOR

    from .convert import note_markdown
    from .reminders import live_for

    user = await db.get(User, user_id)
    if user is None or not note_ids:
        return []
    ids = [uuid.UUID(i) for i in note_ids]
    notes = (
        await db.execute(select(Note).where(Note.id.in_(ids), Note.owner_id == user_id, Note.trashed_at.is_(None)).order_by(Note.created_at))
    ).scalars().all()
    if not notes:
        return []
    nids = [n.id for n in notes]
    items: dict[uuid.UUID, list[NoteItem]] = {}
    for it in (await db.execute(select(NoteItem).where(NoteItem.note_id.in_(nids)).order_by(NoteItem.position, NoteItem.created_at))).scalars():
        items.setdefault(it.note_id, []).append(it)
    atts: dict[uuid.UUID, list[NoteAttachment]] = {}
    for a in (
        await db.execute(select(NoteAttachment).where(NoteAttachment.note_id.in_(nids)).order_by(NoteAttachment.position))
    ).scalars():
        atts.setdefault(a.note_id, []).append(a)
    states = {
        s.note_id: s for s in (
            await db.execute(select(NoteUserState).where(NoteUserState.note_id.in_(nids), NoteUserState.user_id == user_id))
        ).scalars()
    }
    members: dict[uuid.UUID, list[uuid.UUID]] = {}
    for m in (await db.execute(select(NoteMember).where(NoteMember.note_id.in_(nids)))).scalars():
        members.setdefault(m.note_id, []).append(m.user_id)
    who: dict[uuid.UUID, str] = {}
    member_ids = {u for v in members.values() for u in v}
    if member_ids:
        for u in (await db.execute(select(User).where(User.id.in_(member_ids)))).scalars():
            who[u.id] = u.username or u.email or "someone"
    labels = await service._labels(db, user, nids)  # noqa: SLF001 — the same per-person labels the app shows
    reminders: dict[uuid.UUID, str] = {}
    try:
        for nid, rem in (await live_for(db, user, nids)).items():
            reminders[nid] = rem.get("at") or (f"{rem['due']}T{rem['time']}" if rem.get("time") else str(rem["due"]))
    except Exception:  # noqa: BLE001 — reminders we can't read are left out, never the notes
        logger.warning("export: reminders not read", exc_info=True)

    out: list[tuple[str, bytes, float]] = []
    seen: set[str] = {NOTES_JSON.lower()}
    records: list[dict[str, Any]] = []
    for n in notes:
        title = service.display_title(n)
        arc = NOTES_DIR + _safe(title) + ".md"
        i = 1
        while arc.lower() in seen:
            arc = NOTES_DIR + f"{_safe(title)} ({i}).md"
            i += 1
        seen.add(arc.lower())
        st = states.get(n.id)
        its = items.get(n.id, [])
        names = [lb["name"] for lb in labels.get(n.id, [])]
        files = []
        for a in atts.get(n.id, []):
            fid = str(a.file_id) if a.file_id else None
            if not fid or fid not in arc_of:
                continue  # someone else's file, or gone
            files.append((a, arc_of[fid], fid in in_photos))
        shared = [who[u] for u in members.get(n.id, []) if u in who]

        # ---- the .md
        fm = ["---", f"title: {_yaml_str(title)}", f"type: {n.kind}", f"color: {n.color}",
              f"pinned: {'true' if st and st.pinned else 'false'}",
              f"archived: {'true' if st and st.archived_at else 'false'}"]
        if names:
            fm.append("labels: [" + ", ".join(_yaml_str(x) for x in names) + "]")
        fm.append(f"created: {_iso(n.created_at)}")
        fm.append(f"edited: {_iso(n.updated_at)}")
        if n.id in reminders:
            fm.append(f"reminder: {reminders[n.id]}")
        if shared:
            fm.append("shared_with: [" + ", ".join(_yaml_str(x) for x in shared) + "]")
        fm.append("---")
        md = "\n".join(fm) + "\n\n"
        if n.title.strip():
            md += f"# {n.title.strip()}\n\n"
        body = note_markdown(n, its).strip("\n")
        if body:
            md += body + "\n"
        for a, path, _lib in files:
            name = path.rsplit("/", 1)[-1]
            if a.kind == "image":
                md += f"\n![{name}](<{_rel(path)}>)\n"
            else:
                md += f"\n[Recording: {name}](<{_rel(path)}>)\n"
                if a.transcript:
                    md += "\n> " + a.transcript.strip().replace("\n", "\n> ") + "\n"
        out.append((arc, md.encode("utf-8"), n.updated_at.timestamp()))

        # ---- its notes.json record (Keep's shape, plus ours)
        rec: dict[str, Any] = {
            "title": n.title,
            "color": KEEP_COLOR.get(n.color, "DEFAULT"),
            "isPinned": bool(st and st.pinned),
            "isArchived": bool(st and st.archived_at),
            "isTrashed": False,
            "createdTimestampUsec": int(n.created_at.timestamp() * 1_000_000),
            "userEditedTimestampUsec": int(n.updated_at.timestamp() * 1_000_000),
            "labels": [{"name": x} for x in names],
            "attachments": [{"filePath": _rel(p), "mimetype": ""} for _a, p, _l in files],
        }
        if n.kind == "list":
            rec["listContent"] = [{"text": it.text, "isChecked": it.checked} for it in its if it.text.strip()]
        else:
            rec["textContent"] = n.body_text
        rec["promptly"] = {
            "id": str(n.id),
            "ref": n.import_ref or f"promptly:{n.id}",
            "kind": n.kind,
            "color": n.color,
            "markdown": arc[len(NOTES_DIR):],
            "body_doc": n.body_doc if n.kind == "text" else None,
            "items": [{"text": it.text, "checked": it.checked, "indent": it.parent_id is not None} for it in its if it.text.strip()]
            if n.kind == "list" else None,
            "labels": names,
            "attachments": [
                {"path": p[len("Promptly/"):], "kind": a.kind, "inPhotos": lib, **({"transcript": a.transcript} if a.transcript else {})}
                for a, p, lib in files
            ],
            "reminder": reminders.get(n.id),
            "sharedWith": shared,
        }
        records.append(rec)
    out.append((NOTES_JSON, json.dumps({"notes": records}, ensure_ascii=False, indent=1).encode("utf-8"), datetime.now(timezone.utc).timestamp()))
    return out


__all__ = ["NOTES_DIR", "NOTES_JSON", "existing_refs", "export_files", "export_plan", "make_note"]
