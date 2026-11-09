"""The Responses tab (WP-F1.4): the summary, every answer to one question,
one answer at a time, deleting answers, and downloads.

The summary is worked out in SQL over the ``answers`` jsonb (a handful of
grouped queries for the whole form, however many questions it has), so a
form with thousands of answers is still quick to refetch every 10 seconds.

Answers are other people's words: everything here goes back as plain text
for the page to show escaped. Nothing here goes to chat or AI (that's
WP-F1.7, where answers are marked as outside content).

Deleting an answer gives back what it took: its places on limited options
(``form_option_counts``), its count towards an answer limit, its size on
the owner's storage, and the files sent with it (WP-F1.6). Response
numbers are never reused.

Files people sent come back as cards with short-lived signed links (a
tile for pictures, a download for everything), never as their content.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import UserFile
from app.forms import answering as ans
from app.forms.definition import questions
from app.forms.export import GRID_KINDS, NUMBER_KINDS, answer_text, grid_columns, grid_rows, labels
from app.forms.models import Form, FormOptionCount, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User

TEXT_KINDS = ("short_text", "paragraph")
CHOICE_KINDS = ("multiple_choice", "dropdown", "checkboxes")
#: Newest text answers shown per question in the summary.
SUMMARY_TEXTS = 5
#: Rows in one page of a question's answers.
PAGE = 50
#: Days / times listed per question in the summary.
MAX_GROUPS = 100

_LIVE = "r.form_id = :f AND r.deleted_at IS NULL"


# --------------------------------------------------------------------
# Who answered
# --------------------------------------------------------------------
async def names_of(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Account names (the display name people chose, else the username)."""
    from app.auth.models import User as UserModel

    if not ids:
        return {}
    out: dict[uuid.UUID, str] = {}
    for u in (await db.execute(select(UserModel).where(UserModel.id.in_(ids)))).scalars():
        settings = u.settings if isinstance(u.settings, dict) else {}
        out[u.id] = str(settings.get("display_name") or u.username)
    return out


def who(r: Any, names: dict[uuid.UUID, str]) -> dict[str, Any]:
    """``{kind, name}``: an account, a typed email (not checked), someone
    with the link, or an account that has since gone."""
    if r.respondent_id is not None:
        return {"kind": "account", "name": names.get(r.respondent_id) or "Someone on this server"}
    if r.source == "server":
        return {"kind": "gone", "name": "An account that was removed"}
    if r.email:
        return {"kind": "email", "name": r.email}
    return {"kind": "link", "name": "Someone with the link"}


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


# --------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------
async def summary(db: AsyncSession, form: Form, user: User | None = None) -> dict[str, Any]:
    """Per-question aggregates for the summary view (with ``user``: a strip
    of the newest files sent to each file question, linked for them)."""
    defn = form.definition or {}
    qs = [q for q in questions(defn, include_deleted=True)]
    params = {"f": form.id}

    total = int(
        await db.scalar(
            select(func.count()).select_from(FormResponse).where(
                FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None)
            )
        )
        or 0
    )
    first_last = (
        await db.execute(
            select(func.min(FormResponse.number), func.max(FormResponse.number)).where(
                FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None)
            )
        )
    ).one()

    async def grouped(sql: str, **extra: Any) -> list[Any]:
        return list((await db.execute(text(sql), {**params, **extra})).all())

    answered = {
        k: int(n)
        for k, n in await grouped(
            f"SELECT e.key, count(*) FROM form_responses r CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"WHERE {_LIVE} GROUP BY e.key"
        )
    }
    single: dict[str, dict[str, int]] = {}
    for k, o, n in await grouped(
        f"SELECT e.key, e.value->>'option', count(*) FROM form_responses r "
        f"CROSS JOIN LATERAL jsonb_each(r.answers) e "
        f"WHERE {_LIVE} AND jsonb_typeof(e.value) = 'object' AND e.value->>'option' IS NOT NULL "
        f"GROUP BY 1, 2"
    ):
        single.setdefault(k, {})[o] = int(n)
    for k, o, n in await grouped(
        f"SELECT e.key, o.value, count(*) FROM form_responses r "
        f"CROSS JOIN LATERAL jsonb_each(r.answers) e "
        f"CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'object' "
        f"AND jsonb_typeof(e.value->'options') = 'array' THEN e.value->'options' ELSE '[]'::jsonb END) o(value) "
        f"WHERE {_LIVE} GROUP BY 1, 2"
    ):
        single.setdefault(k, {})[o] = single.get(k, {}).get(o, 0) + int(n)
    others = {
        k: int(n)
        for k, n in await grouped(
            f"SELECT e.key, count(*) FROM form_responses r CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"WHERE {_LIVE} AND jsonb_typeof(e.value) = 'object' AND e.value->>'other' IS NOT NULL GROUP BY 1"
        )
    }
    numbers: dict[str, dict[int, int]] = {}
    for k, v, n in await grouped(
        f"SELECT e.key, e.value::text, count(*) FROM form_responses r CROSS JOIN LATERAL jsonb_each(r.answers) e "
        f"WHERE {_LIVE} AND jsonb_typeof(e.value) = 'number' GROUP BY 1, 2"
    ):
        try:
            numbers.setdefault(k, {})[int(float(v))] = int(n)
        except ValueError:
            continue

    date_ids = [q["id"] for q in qs if q.get("kind") == "date"]
    time_ids = [q["id"] for q in qs if q.get("kind") == "time"]
    strings: dict[str, dict[str, int]] = {}
    if date_ids or time_ids:
        for k, v, n in await grouped(
            f"SELECT e.key, CASE WHEN e.key = ANY(:dates) THEN split_part(e.value #>> '{{}}', 'T', 1) "
            f"ELSE e.value #>> '{{}}' END, count(*) FROM form_responses r "
            f"CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"WHERE {_LIVE} AND jsonb_typeof(e.value) = 'string' AND e.key = ANY(:keys) GROUP BY 1, 2",
            dates=date_ids,
            keys=date_ids + time_ids,
        ):
            strings.setdefault(k, {})[v] = int(n)

    # Grids (WP-F2.1): how many picked each column, per row. A choice
    # grid's row holds one column id, a checkbox grid's a list of them.
    grid_ids = [q["id"] for q in qs if q.get("kind") in GRID_KINDS]
    cells: dict[str, dict[str, dict[str, int]]] = {}
    row_answers: dict[str, dict[str, int]] = {}
    if grid_ids:
        for k, row, col, n in await grouped(
            f"SELECT e.key, g.key, c.value, count(*) FROM form_responses r "
            f"CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.value) = 'object' "
            f"AND jsonb_typeof(e.value->'rows') = 'object' THEN e.value->'rows' ELSE '{{}}'::jsonb END) g "
            f"CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.value) = 'array' THEN g.value "
            f"WHEN jsonb_typeof(g.value) = 'string' THEN jsonb_build_array(g.value) ELSE '[]'::jsonb END) c(value) "
            f"WHERE {_LIVE} AND e.key = ANY(:keys) GROUP BY 1, 2, 3",
            keys=grid_ids,
        ):
            cells.setdefault(k, {}).setdefault(row, {})[col] = int(n)
        for k, row, n in await grouped(
            f"SELECT e.key, g.key, count(*) FROM form_responses r "
            f"CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.value) = 'object' "
            f"AND jsonb_typeof(e.value->'rows') = 'object' THEN e.value->'rows' ELSE '{{}}'::jsonb END) g "
            f"WHERE {_LIVE} AND e.key = ANY(:keys) GROUP BY 1, 2",
            keys=grid_ids,
        ):
            row_answers.setdefault(k, {})[row] = int(n)

    latest_ids = [q["id"] for q in qs if q.get("kind") in TEXT_KINDS]
    latest: dict[str, list[dict[str, Any]]] = {}
    if latest_ids:
        by_id = {q["id"]: q for q in qs}
        for k, v, number, at in await grouped(
            f"SELECT key, value, number, submitted_at FROM ("
            f"SELECT e.key, e.value, r.number, r.submitted_at, "
            f"row_number() OVER (PARTITION BY e.key ORDER BY r.number DESC) AS rn "
            f"FROM form_responses r CROSS JOIN LATERAL jsonb_each(r.answers) e "
            f"WHERE {_LIVE} AND e.key = ANY(:keys)) s WHERE rn <= :n ORDER BY key, number DESC",
            keys=latest_ids,
            n=SUMMARY_TEXTS,
        ):
            # jsonb comes back decoded (the engine's json codec).
            latest.setdefault(k, []).append(
                {"number": number, "text": answer_text(by_id[k], v), "submitted_at": _iso(at)}
            )

    taken = {
        (q, o): int(n or 0)
        for q, o, n in (
            await db.execute(
                select(FormOptionCount.question_id, FormOptionCount.option_id, FormOptionCount.taken).where(
                    FormOptionCount.form_id == form.id
                )
            )
        ).all()
    }

    out_qs: list[dict[str, Any]] = []
    for q in qs:
        qid, kind = q["id"], q.get("kind")
        cfg = q.get("config") or {}
        block: dict[str, Any] = {
            "id": qid,
            "title": (q.get("title") or "").strip() or "Untitled question",
            "kind": kind,
            "deleted": bool(q.get("deleted")),
            "answered": answered.get(qid, 0),
        }
        if kind in CHOICE_KINDS:
            counts = single.get(qid, {})
            opts = []
            for o in cfg.get("options") or []:
                oid = str(o.get("id"))
                limit = o.get("limit")
                opts.append(
                    {
                        "id": oid,
                        "label": labels(q).get(oid, "(no label)"),
                        "count": counts.get(oid, 0),
                        "limit": int(limit) if limit else None,
                        "taken": taken.get((qid, oid), counts.get(oid, 0)) if limit else None,
                    }
                )
            block["options"] = opts
            block["other"] = others.get(qid, 0) if (cfg.get("other") or others.get(qid)) else None
        elif kind in NUMBER_KINDS:
            got = numbers.get(qid, {})
            lo = int(cfg.get("min", 1)) if kind == "linear_scale" else 1
            hi = int(cfg.get("max", 5))
            bins = [{"value": v, "count": got.get(v, 0)} for v in range(lo, hi + 1)]
            n = sum(c for v, c in got.items())
            block["bins"] = bins
            block["average"] = round(sum(v * c for v, c in got.items()) / n, 2) if n else None
            if kind == "linear_scale":
                block["min_label"] = cfg.get("min_label") or ""
                block["max_label"] = cfg.get("max_label") or ""
        elif kind in ("date", "time"):
            groups = sorted(strings.get(qid, {}).items())
            block["groups"] = [{"value": v, "count": c} for v, c in groups[:MAX_GROUPS]]
            block["more_groups"] = max(0, len(groups) - MAX_GROUPS)
        elif kind in GRID_KINDS:
            got = cells.get(qid, {})
            columns = grid_columns(q)
            block["columns"] = [{"id": cid, "label": label} for cid, label in columns.items()]
            block["rows"] = [
                {
                    "id": rid,
                    "label": label,
                    "answered": row_answers.get(qid, {}).get(rid, 0),
                    "counts": {cid: got.get(rid, {}).get(cid, 0) for cid in columns},
                }
                for rid, label in grid_rows(q)
            ]
        elif kind in TEXT_KINDS:
            block["latest"] = latest.get(qid, [])
        elif kind == "file_upload":
            from app.forms.uploads import strip_for

            block["files"] = await strip_for(db, form, user, qid) if user is not None else []
        out_qs.append(block)
    # Live questions in form order, then deleted ones that still have answers.
    live = [b for b in out_qs if not b["deleted"]]
    gone = [b for b in out_qs if b["deleted"] and b["answered"]]
    return {
        "total": total,
        "first_number": first_last[0],
        "latest_number": first_last[1],
        "questions": live + gone,
    }


# --------------------------------------------------------------------
# One question
# --------------------------------------------------------------------
def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def question_answers(
    db: AsyncSession,
    form: Form,
    question_id: str,
    *,
    before: int | None = None,
    search: str | None = None,
    user: User | None = None,
) -> dict[str, Any] | None:
    """Every answer to one question, newest first, a page at a time. Text
    questions can be searched. None for a question the form never had."""
    by_id = {q["id"]: q for q in questions(form.definition or {}, include_deleted=True)}
    q = by_id.get(question_id)
    if q is None:
        return None
    cond = [_LIVE, "jsonb_exists(r.answers, CAST(:q AS text))"]
    params: dict[str, Any] = {"f": form.id, "q": question_id, "lim": PAGE + 1}
    if before is not None:
        cond.append("r.number < :before")
        params["before"] = before
    search = (search or "").strip()[:200]
    if search:
        if q.get("kind") in TEXT_KINDS:
            cond.append("(r.answers ->> CAST(:q AS text)) ILIKE :pat ESCAPE '\\'")
        else:
            # "Other" text on choice questions.
            cond.append("(r.answers -> CAST(:q AS text) ->> 'other') ILIKE :pat ESCAPE '\\'")
        params["pat"] = _like(search)
    rows = (
        await db.execute(
            text(
                "SELECT r.number, r.submitted_at, r.respondent_id, r.email, r.source, r.answers -> CAST(:q AS text) "
                f"FROM form_responses r WHERE {' AND '.join(cond)} ORDER BY r.number DESC LIMIT :lim"
            ),
            params,
        )
    ).all()
    more = len(rows) > PAGE
    rows = rows[:PAGE]
    names = await names_of(db, {r.respondent_id for r in rows if r.respondent_id})
    cards = await _cards(db, form, user, [(q, r[5]) for r in rows])
    items = []
    for r in rows:
        value = r[5]  # decoded jsonb
        item = {
            "number": r.number,
            "submitted_at": _iso(r.submitted_at),
            "who": who(r, names),
            "text": answer_text(q, value),
        }
        if q.get("kind") == "file_upload":
            item["files"] = _files_of(value, cards, outside=r.source == "link")
        items.append(item)
    return {
        "question": {"id": question_id, "title": (q.get("title") or "").strip() or "Untitled question", "kind": q.get("kind"), "deleted": bool(q.get("deleted"))},
        "items": items,
        "next_before": items[-1]["number"] if more and items else None,
    }


# --------------------------------------------------------------------
# One answer
# --------------------------------------------------------------------
async def _live(db: AsyncSession, form: Form, number: int) -> FormResponse | None:
    return (
        await db.execute(
            select(FormResponse).where(
                FormResponse.form_id == form.id, FormResponse.number == number, FormResponse.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def _cards(
    db: AsyncSession, form: Form, user: User | None, pairs: list[tuple[dict[str, Any], Any]]
) -> dict[str, dict[str, Any]]:
    """Signed cards for every file in these (question, answer) pairs."""
    from app.forms.uploads import file_cards, ids_in

    if user is None:
        return {}
    ids = [i for q, v in pairs if q.get("kind") == "file_upload" for i in ids_in(v)]
    return await file_cards(db, form, user, ids) if ids else {}


def _files_of(value: Any, cards: dict[str, dict[str, Any]], *, outside: bool) -> list[dict[str, Any]]:
    """One answer's files, in the order they were sent. A file whose card
    is missing (deleted since) still shows its name."""
    from app.forms.uploads import ids_in

    names = {str(v.get("id")): str(v.get("name") or "file") for v in value or [] if isinstance(v, dict)} if isinstance(value, list) else {}
    out = []
    for i in ids_in(value):
        card = cards.get(i)
        out.append({**card, "outside": outside} if card else {"id": i, "name": names.get(i, "file"), "missing": True, "outside": outside})
    return out


async def one(db: AsyncSession, form: Form, number: int, user: User | None = None) -> dict[str, Any] | None:
    """One answer with its place among the rest (``‹ 3 of 12 ›``)."""
    r = await _live(db, form, number)
    if r is None:
        return None
    live = (FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))
    position = int(await db.scalar(select(func.count()).select_from(FormResponse).where(*live, FormResponse.number <= number)) or 0)
    total = int(await db.scalar(select(func.count()).select_from(FormResponse).where(*live)) or 0)
    prev = await db.scalar(select(func.max(FormResponse.number)).where(*live, FormResponse.number < number))
    nxt = await db.scalar(select(func.min(FormResponse.number)).where(*live, FormResponse.number > number))
    names = await names_of(db, {r.respondent_id} if r.respondent_id else set())
    answers = r.answers or {}
    all_qs = questions(form.definition or {}, include_deleted=True)
    cards = await _cards(db, form, user, [(q, answers.get(q["id"])) for q in all_qs])
    items = []
    for q in all_qs:
        qid = q["id"]
        if q.get("deleted") and qid not in answers:
            continue
        item = {
            "id": qid,
            "title": (q.get("title") or "").strip() or "Untitled question",
            "kind": q.get("kind"),
            "deleted": bool(q.get("deleted")),
            "answered": qid in answers,
            "text": answer_text(q, answers.get(qid)),
        }
        if q.get("kind") == "file_upload":
            item["files"] = _files_of(answers.get(qid), cards, outside=r.source == "link")
        items.append(item)
    items = [i for i in items if not i["deleted"]] + [i for i in items if i["deleted"]]
    return {
        "number": r.number,
        "position": position,
        "total": total,
        "prev": prev,
        "next": nxt,
        "who": who(r, names),
        "source": r.source,
        "submitted_at": _iso(r.submitted_at),
        "edited_at": _iso(r.edited_at),
        "answers": items,
    }


# --------------------------------------------------------------------
# Deleting
# --------------------------------------------------------------------
def _size(answers: dict[str, Any]) -> int:
    # The same measure submit grows the shell by.
    return len(json.dumps(answers, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


async def delete_one(db: AsyncSession, shell: UserFile, form: Form, number: int) -> bool:
    """Delete one answer for good. ``form`` must be locked (the counters
    are only safe under its row lock). The caller commits."""
    from app.forms.notify import reopened
    from app.forms.responses import _grow_shell

    r = await _live(db, form, number)
    if r is None:
        return False
    answers = dict(r.answers or {})
    picks = ans.picks(form.definition or {}, answers)
    if picks:
        rows = {
            (c.question_id, c.option_id): c
            for c in (
                await db.execute(
                    select(FormOptionCount).where(
                        FormOptionCount.form_id == form.id,
                        FormOptionCount.question_id.in_({q for q, _ in picks}),
                    )
                )
            ).scalars()
        }
        for key in picks:
            row = rows.get(key)
            if row is not None and row.taken > 0:
                row.taken -= 1
    form.response_count = max(0, (form.response_count or 0) - 1)
    form.updated_at = datetime.now(timezone.utc)
    # The files sent with it go too (WP-F1.6).
    from app.forms.uploads import drop_for_response

    await drop_for_response(db, r.id)
    await db.delete(r)
    await db.flush()
    await _grow_shell(db, shell.id, -_size(answers))
    reopened(form)
    return True


async def delete_all(db: AsyncSession, shell: UserFile, form: Form) -> int:
    """Delete every answer (the form row locked; the caller commits).
    Counters go back to zero; numbering carries on."""
    from app.forms.notify import reopened
    from app.forms.service import refresh_shell
    from app.forms.uploads import drop_for_form

    await drop_for_form(db, form.id)
    n = (
        await db.execute(delete(FormResponse).where(FormResponse.form_id == form.id).returning(FormResponse.id))
    ).all()
    await db.execute(delete(FormOptionCount).where(FormOptionCount.form_id == form.id))
    form.response_count = 0
    form.updated_at = datetime.now(timezone.utc)
    await refresh_shell(db, form, shell, rename=False)
    reopened(form)
    return len(n)


# --------------------------------------------------------------------
# Downloads
# --------------------------------------------------------------------
async def export(db: AsyncSession, shell: UserFile, form: Form, user: User, fmt: str) -> tuple[bytes, str, str]:
    """(bytes, filename, MIME) of every answer as CSV or Excel, times in the
    downloader's own time zone, formula-safe."""
    import asyncio

    from app.forms.export import responses_csv, responses_xlsx
    from app.notifications.quiet import zone_of

    rows = (
        await db.execute(
            select(FormResponse)
            .where(FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))
            .order_by(FormResponse.number)
        )
    ).scalars().all()
    names = await names_of(db, {r.respondent_id for r in rows if r.respondent_id})
    tz = zone_of(user.settings)
    title = str((form.definition or {}).get("title") or "Untitled form")
    safe = "".join(ch for ch in title if ch not in '\\/:*?"<>|\r\n\t').strip()[:120] or "Form"
    base = f"{safe} (Responses)"
    defn = form.definition or {}
    if fmt == "xlsx":
        data = await asyncio.to_thread(responses_xlsx, defn, rows, who=names, tz=tz)
        return data, f"{base}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    data = await asyncio.to_thread(responses_csv, defn, rows, who=names, tz=tz)
    return data, f"{base}.csv", "text/csv; charset=utf-8"


__all__ = [
    "delete_all",
    "delete_one",
    "export",
    "names_of",
    "one",
    "question_answers",
    "summary",
    "who",
]
