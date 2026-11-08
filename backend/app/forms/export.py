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
from typing import Any, Iterable

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


def answer_text(question: dict[str, Any], value: Any) -> str:
    """One answer as readable text (not yet neutralised)."""
    if value is None:
        return ""
    kind = question.get("kind")
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
    for q in qs:
        title = (q.get("title") or "").strip() or "Untitled question"
        header.append(f"{title} (deleted question)" if q.get("deleted") else title)
    out: list[list[Any]] = [[neutralise(h) for h in header]]
    for r in rows:
        line: list[Any] = [r.number if typed else str(r.number), when(r.submitted_at, tz), when(r.edited_at, tz)]
        if has_email:
            line.append(neutralise(r.email or ""))
        if has_account:
            line.append(neutralise((who or {}).get(r.respondent_id, "") if r.respondent_id else ""))
        answers = r.answers or {}
        for q in qs:
            v = answers.get(q.get("id"))
            if typed and q.get("kind") in NUMBER_KINDS and isinstance(v, int) and not isinstance(v, bool):
                line.append(v)
            else:
                line.append(neutralise(answer_text(q, v)))
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
    "NUMBER_KINDS",
    "answer_text",
    "form_zip",
    "labels",
    "neutralise",
    "responses_csv",
    "responses_xlsx",
    "table",
    "when",
]
