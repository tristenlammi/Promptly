"""Answers as text: one cell per question, safe to open in a spreadsheet.

The shapes answers are stored in (``form_responses.answers``, keyed by
question id, as ``app.forms.answering.check_one`` cleans them) — everything
that shows or exports answers reads them through :func:`answer_text`:

* short answer / paragraph: ``"text"``
* multiple choice / dropdown: ``{"option": "<option id>"}`` or
  ``{"other": "text"}``
* checkboxes: ``{"options": ["<option id>", …], "other": "text"?}``
* linear scale / rating: an integer
* date: ``"YYYY-MM-DD"``, ``"YYYY-MM-DDTHH:MM"``, ``"MM-DD"`` or
  ``"MM-DDTHH:MM"`` (no year)
* time: ``"HH:MM"`` (time of day) or ``"H:MM:SS"`` (a duration)
* file upload: ``[{"id": "<upload id>", "name": "receipt.jpg"}, …]``
* grids: ``{"rows": {"<row id>": "<column id>"}}`` (checkbox grid: a list)
* location: ``{"text": "12 Smith St, Hobart", "lat"?, "lon"?, "picked"}``

Older shapes (a bare option id, a list of ids) are read too. Anything that
doesn't fit its question's shape (the question's type was changed after
people answered) is shown as plain text, so old answers are never lost.

Every text value that a spreadsheet could read as a formula (starting with
``= + - @``, a tab or a carriage return) gets a leading ``'``; the xlsx also
stores every text cell as text, never as a formula.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import datetime, timezone, tzinfo
from typing import Any, Callable, Iterable

from app.forms.definition import questions

_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
#: Question kinds whose answers are whole numbers (written as numbers in xlsx).
NUMBER_KINDS = ("linear_scale", "rating")


def neutralise(value: str) -> str:
    """A cell value no spreadsheet will run as a formula."""
    if value and value.startswith(_FORMULA_START):
        return "'" + value
    return value


def _plain(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def labels(question: dict[str, Any]) -> dict[str, str]:
    """``{option id: label}`` (a blank label reads "(no label)")."""
    return {
        str(o.get("id")): (o.get("label") or "").strip() or "(no label)"
        for o in (question.get("config") or {}).get("options") or []
    }


def _choice_part(names: dict[str, str], v: Any) -> str:
    if isinstance(v, str):
        return names.get(v, v)
    if isinstance(v, dict) and isinstance(v.get("other"), str):
        return f"Other: {v['other']}"
    return _plain(v)


GRID_KINDS = ("choice_grid", "checkbox_grid")


def grid_rows(question: dict[str, Any]) -> list[tuple[str, str]]:
    """A grid's rows as ``(id, label)`` (a blank label reads "Row n")."""
    return [
        (str(r.get("id")), (r.get("label") or "").strip() or f"Row {n}")
        for n, r in enumerate((question.get("config") or {}).get("rows") or [], start=1)
    ]


def grid_columns(question: dict[str, Any]) -> dict[str, str]:
    return {
        str(c.get("id")): (c.get("label") or "").strip() or f"Column {n}"
        for n, c in enumerate((question.get("config") or {}).get("columns") or [], start=1)
    }


def grid_cell(question: dict[str, Any], value: Any, row_id: str) -> str:
    """One row of a grid answer: the column picked, or the columns ticked
    joined with ", " (a sheet or export cell)."""
    if not isinstance(value, dict) or not isinstance(value.get("rows"), dict):
        return ""
    x = value["rows"].get(row_id)
    cols = grid_columns(question)
    if isinstance(x, list):
        return ", ".join(cols.get(str(c), str(c)) for c in x)
    if isinstance(x, str):
        return cols.get(x, x)
    return ""


def _grid_text(question: dict[str, Any], value: Any) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("rows"), dict):
        return _plain(value)
    known = dict(grid_rows(question))
    parts = []
    order = [rid for rid, _ in grid_rows(question)] + [k for k in value["rows"] if k not in known]
    for rid in order:
        cell = grid_cell(question, value, rid)
        if cell:
            parts.append(f"{known.get(rid, '(removed row)')}: {cell}")
    return "; ".join(parts)


def location_spot(value: Any) -> str:
    """A picked place's spot as ``lat, lon`` text (empty for a typed one)."""
    if isinstance(value, dict) and value.get("picked") and isinstance(value.get("lat"), (int, float))             and isinstance(value.get("lon"), (int, float)):
        return f"{value['lat']}, {value['lon']}"
    return ""


def answer_text(question: dict[str, Any], value: Any) -> str:
    """One answer as readable text (not yet neutralised)."""
    if value is None:
        return ""
    kind = question.get("kind")
    if kind in GRID_KINDS:
        return _grid_text(question, value)
    if kind == "location":
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            return value["text"]
        return _plain(value)
    if kind in ("multiple_choice", "dropdown"):
        names = labels(question)
        if isinstance(value, dict) and isinstance(value.get("option"), str):
            return names.get(value["option"], value["option"])
        if isinstance(value, (str, dict)):
            return _choice_part(names, value)
        return _plain(value)
    if kind == "checkboxes":
        names = labels(question)
        parts: list[str] = []
        if isinstance(value, dict) and ("options" in value or "other" in value):
            for v in value.get("options") or []:
                parts.append(_choice_part(names, v))
            if isinstance(value.get("other"), str):
                parts.append(f"Other: {value['other']}")
            return "; ".join(parts)
        if isinstance(value, list):
            return "; ".join(_choice_part(names, v) for v in value)
        return _plain(value)
    if kind == "file_upload":
        if isinstance(value, list):
            names_ = [str(v.get("name") or "file") if isinstance(v, dict) else _plain(v) for v in value]
            return "; ".join(names_)
        return _plain(value)
    return _plain(value)


def question_columns(question: dict[str, Any]) -> list[tuple[str, str, Callable[[Any], str]]]:
    """The columns one question takes in a download and the linked Sheet:
    ``(key, title, text of an answer)``. One per question (key
    ``q:<id>``), except a grid: one per row, titled "Question [Row]" like
    Google, keyed ``q:<id>:<row id>``. Deleted questions say so."""
    qid = question.get("id")
    title = (question.get("title") or "").strip() or "Untitled question"
    gone = " (deleted question)" if question.get("deleted") else ""
    if question.get("kind") in GRID_KINDS:
        return [
            (f"q:{qid}:{rid}", f"{title} [{label}]{gone}", (lambda v, rid=rid: grid_cell(question, v, rid)))
            for rid, label in grid_rows(question)
        ]
    if question.get("kind") == "location":
        # The place as words, and its spot when one was picked (text: it
        # opens nowhere by itself).
        return [
            (f"q:{qid}", f"{title}{gone}", lambda v: answer_text(question, v)),
            (f"q:{qid}:map", f"{title} (map){gone}", location_spot),
        ]
    return [(f"q:{qid}", f"{title}{gone}", lambda v: answer_text(question, v))]


def when(d: datetime | None, tz: tzinfo | None = None) -> str:
    if d is None:
        return ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(tz or timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def table(
    definition: dict[str, Any],
    responses: Iterable[Any],
    *,
    who: dict[Any, str] | None = None,
    tz: tzinfo | None = None,
    typed: bool = False,
) -> list[list[Any]]:
    """Header row + one row per response: Response #, Submitted, Edited,
    Email (typed, if any), Account (if any), then every question in order
    — deleted ones last, marked "(deleted question)". Times are in ``tz``
    (UTC when not given). Text is neutralised. ``typed``: Response # and
    scale/rating answers stay numbers (for xlsx)."""
    qs = questions(definition, include_deleted=True)
    qs = [q for q in qs if not q.get("deleted")] + [q for q in qs if q.get("deleted")]
    rows = list(responses)
    has_email = any(getattr(r, "email", None) for r in rows)
    has_account = any(getattr(r, "respondent_id", None) for r in rows)
    header = ["Response #", "Submitted", "Edited"]
    if has_email:
        header.append("Email (typed, not checked)")
    if has_account:
        header.append("Account")
    cols = [(q, col) for q in qs for col in question_columns(q)]
    for _q, (_key, title, _fn) in cols:
        header.append(title)
    out: list[list[Any]] = [[neutralise(h) for h in header]]
    for r in rows:
        line: list[Any] = [r.number if typed else str(r.number), when(r.submitted_at, tz), when(r.edited_at, tz)]
        if has_email:
            line.append(neutralise(r.email or ""))
        if has_account:
            line.append(neutralise((who or {}).get(r.respondent_id, "") if r.respondent_id else ""))
        answers = r.answers or {}
        for q, (_key, _title, fn) in cols:
            v = answers.get(q.get("id"))
            if typed and q.get("kind") in NUMBER_KINDS and isinstance(v, int) and not isinstance(v, bool):
                line.append(v)
            else:
                line.append(neutralise(fn(v)))
        out.append(line)
    return out


def responses_csv(
    definition: dict[str, Any], responses: Iterable[Any], *, who: dict[Any, str] | None = None, tz: tzinfo | None = None
) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerows(table(definition, responses, who=who, tz=tz))
    # A BOM so Excel opens it as UTF-8.
    return ("﻿" + buf.getvalue()).encode("utf-8")


def responses_xlsx(
    definition: dict[str, Any],
    responses: Iterable[Any],
    *,
    who: dict[Any, str] | None = None,
    tz: tzinfo | None = None,
    sheet_title: str = "Responses",
) -> bytes:
    """An Excel workbook: a bold, frozen header row and one row per answer.
    Every text cell is stored as text (``data_type="s"``), so even a value
    that slipped past :func:`neutralise` could never be a formula."""
    from openpyxl import Workbook
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    rows = table(definition, responses, who=who, tz=tz, typed=True)
    wb = Workbook()
    ws = wb.active
    name = (sheet_title or "Responses")[:31]
    for ch in '[]:*?/\\':
        name = name.replace(ch, "_")
    ws.title = name or "Responses"
    widths: dict[int, int] = {}
    for r_i, row in enumerate(rows, start=1):
        for c_i, value in enumerate(row, start=1):
            cell = ws.cell(row=r_i, column=c_i)
            if isinstance(value, int):
                cell.value = value
            else:
                text = ILLEGAL_CHARACTERS_RE.sub("", str(value))[:32_000]
                cell.value = text
                cell.data_type = "s"
            if r_i == 1:
                cell.font = Font(bold=True)
            else:
                cell.alignment = Alignment(vertical="top", wrap_text=isinstance(value, str) and len(value) > 60)
            widths[c_i] = max(widths.get(c_i, 0), min(60, len(str(value)) + 2))
    for c_i, w in widths.items():
        ws.column_dimensions[get_column_letter(c_i)].width = max(10, w)
    ws.freeze_panes = "A2"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def form_zip(
    definition: dict[str, Any], responses: Iterable[Any], *, who: dict[Any, str] | None = None, tz: tzinfo | None = None
) -> bytes:
    """A form's download: ``form.json`` (the questions) and
    ``responses.csv`` (the answers)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("form.json", json.dumps(definition, ensure_ascii=False, indent=2))
        z.writestr("responses.csv", responses_csv(definition, responses, who=who, tz=tz))
    return buf.getvalue()


__all__ = [
    "GRID_KINDS",
    "NUMBER_KINDS",
    "answer_text",
    "grid_cell",
    "grid_columns",
    "grid_rows",
    "location_spot",
    "question_columns",
    "form_zip",
    "labels",
    "neutralise",
    "responses_csv",
    "responses_xlsx",
    "table",
    "when",
]
