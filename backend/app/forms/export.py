"""Answers as text: one cell per question, safe to open in a spreadsheet.

The shapes answers are stored in (``form_responses.answers``, keyed by
question id) — the answer side writes these, everything that shows or
exports answers reads them through :func:`answer_text`:

* short answer / paragraph: ``"text"``
* multiple choice / dropdown: ``"<option id>"`` or ``{"other": "text"}``
* checkboxes: ``["<option id>", …, {"other": "text"}]``
* linear scale / rating: an integer
* date: ``"YYYY-MM-DD"``, ``"YYYY-MM-DDTHH:MM"`` or ``"--MM-DD"`` (no year)
* time: ``"HH:MM"`` (time of day) or ``"HH:MM:SS"`` (a duration)
* file upload: ``[{"id": "<upload id>", "name": "receipt.jpg"}, …]``

Anything that doesn't fit its question's shape (the question's type was
changed after people answered) is shown as plain text, so old answers are
never lost.

Every value that a spreadsheet could read as a formula (starting with
``= + - @``, a tab or a carriage return) gets a leading ``'``.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import datetime
from typing import Any, Iterable

from app.forms.definition import questions

_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


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


def _labels(question: dict[str, Any]) -> dict[str, str]:
    return {
        str(o.get("id")): (o.get("label") or "").strip() or "(no label)"
        for o in (question.get("config") or {}).get("options") or []
    }


def answer_text(question: dict[str, Any], value: Any) -> str:
    """One answer as readable text (not yet neutralised)."""
    if value is None:
        return ""
    kind = question.get("kind")
    if kind in ("multiple_choice", "dropdown"):
        if isinstance(value, str):
            return _labels(question).get(value, value)
        if isinstance(value, dict) and isinstance(value.get("other"), str):
            return f"Other: {value['other']}"
        return _plain(value)
    if kind == "checkboxes":
        if isinstance(value, list):
            labels = _labels(question)
            parts = []
            for v in value:
                if isinstance(v, str):
                    parts.append(labels.get(v, v))
                elif isinstance(v, dict) and isinstance(v.get("other"), str):
                    parts.append(f"Other: {v['other']}")
                else:
                    parts.append(_plain(v))
            return "; ".join(parts)
        return _plain(value)
    if kind == "file_upload":
        if isinstance(value, list):
            names = [
                str(v.get("name") or "file") if isinstance(v, dict) else _plain(v) for v in value
            ]
            return "; ".join(names)
        return _plain(value)
    return _plain(value)


def _when(d: datetime | None) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S") if d else ""


def table(definition: dict[str, Any], responses: Iterable[Any], *, who: dict[Any, str] | None = None) -> list[list[str]]:
    """Header row + one row per response: Response #, Submitted, Edited,
    Email (typed, if any), Account (if any), then every question in order
    — deleted ones last-known title marked "(deleted question)"."""
    qs = questions(definition, include_deleted=True)
    rows = list(responses)
    has_email = any(getattr(r, "email", None) for r in rows)
    has_account = any(getattr(r, "respondent_id", None) for r in rows)
    header = ["Response #", "Submitted", "Edited"]
    if has_email:
        header.append("Email")
    if has_account:
        header.append("Account")
    for q in qs:
        title = (q.get("title") or "").strip() or "Untitled question"
        header.append(f"{title} (deleted question)" if q.get("deleted") else title)
    out = [header]
    for r in rows:
        line = [str(r.number), _when(r.submitted_at), _when(r.edited_at)]
        if has_email:
            line.append(r.email or "")
        if has_account:
            line.append((who or {}).get(r.respondent_id, "") if r.respondent_id else "")
        answers = r.answers or {}
        for q in qs:
            line.append(answer_text(q, answers.get(q.get("id"))))
        out.append(line)
    return [[neutralise(c) for c in row] for row in out]


def responses_csv(definition: dict[str, Any], responses: Iterable[Any], *, who: dict[Any, str] | None = None) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerows(table(definition, responses, who=who))
    # A BOM so Excel opens it as UTF-8.
    return ("﻿" + buf.getvalue()).encode("utf-8")


def form_zip(definition: dict[str, Any], responses: Iterable[Any], *, who: dict[Any, str] | None = None) -> bytes:
    """A form's download: ``form.json`` (the questions) and
    ``responses.csv`` (the answers)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("form.json", json.dumps(definition, ensure_ascii=False, indent=2))
        z.writestr("responses.csv", responses_csv(definition, responses, who=who))
    return buf.getvalue()


__all__ = ["answer_text", "form_zip", "neutralise", "responses_csv", "table"]
