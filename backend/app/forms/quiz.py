"""Quizzes (Forms phase 2, WP-F2.3): marking answers, and what a
respondent may see of their own marks.

Small and honest: family trivia, a times-tables check, a first-aid
refresher. A question earns points when its answer matches the key:

* multiple choice / dropdown: ``{options: [id…]}`` — any of them is right;
* checkboxes: ``{options: [id…]}`` — exactly that set (all or nothing);
* short answer: ``{accept: [text…]}`` (≤ 20) — matched ignoring case,
  extra spaces and trailing full stops, and as numbers when the question
  takes a number;
* multiple-choice grid ``{rows: {row: column}}`` and checkbox grid
  ``{rows: {row: [column…]}}`` — points for each row right;
* paragraph: no key, **marked by hand** (pending until it is).

"Other…" is never right by itself (the owner can mark it by hand); a blank
answer to a quiz question scores 0. Other kinds can't be marked.

:func:`mark` is pure: it re-marks every automatic part from the answers,
and keeps an owner's mark only when that question's answer didn't change.

``grading`` (stored on the response) is::

    {max, auto, manual, pending,
     items: {qid: {points, max, right: true|false|null, by: "auto"|"owner",
                   rows?: {row: bool}}}}

``points`` is null while a paragraph waits to be marked. ``score`` is
``auto + manual``.
"""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.forms.definition import QUESTION_KINDS

#: Kinds a quiz can mark (paragraph by hand, the rest automatically).
AUTO_KINDS = ("multiple_choice", "dropdown", "checkboxes", "short_text", "choice_grid", "checkbox_grid")
MARKABLE_KINDS = AUTO_KINDS + ("paragraph",)
MAX_POINTS = 100
MAX_ACCEPT = 20
FEEDBACK_CHARS = 500


class QuizSettings(BaseModel):
    """``forms.quiz`` (null: not a quiz)."""

    model_config = ConfigDict(extra="forbid")

    release: str = Field(default="now", pattern=r"^(now|later)$")
    show_score: bool = True
    show_right_wrong: bool = True
    show_answers: bool = False
    show_points: bool = False


DEFAULT_SETTINGS = QuizSettings().model_dump()


# --------------------------------------------------------------------
# The key on a question (validated with the definition)
# --------------------------------------------------------------------
def _ids(raw: Any) -> list[str]:
    out: list[str] = []
    for x in raw if isinstance(raw, list) else []:
        if isinstance(x, str) and x not in out:
            out.append(x)
    return out


def clean_item_quiz(kind: str, config: dict[str, Any], raw: Any) -> dict[str, Any] | None:
    """An item's ``quiz`` normalised against its own options / rows /
    columns: unknown ids dropped (an option deleted since), shapes fixed.
    Raises ``ValueError`` (shown on the question) for a kind that can't be
    marked or a bad shape."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("This question's answer key isn't in a shape a form understands.")
    if kind not in MARKABLE_KINDS:
        raise ValueError("This kind of question can't have points in a quiz.")
    extra = set(raw) - {"points", "key", "feedback_right", "feedback_wrong", "suggested"}
    if extra:
        raise ValueError(f"This question's answer key has a setting a form doesn't know ({', '.join(sorted(extra))}).")
    points = raw.get("points", 1)
    if isinstance(points, bool) or not isinstance(points, int) or not 0 <= points <= MAX_POINTS:
        raise ValueError(f"Points must be a whole number from 0 to {MAX_POINTS}.")
    fr, fw = raw.get("feedback_right") or "", raw.get("feedback_wrong") or ""
    if not isinstance(fr, str) or not isinstance(fw, str):
        raise ValueError("Feedback must be text.")
    if len(fr) > FEEDBACK_CHARS or len(fw) > FEEDBACK_CHARS:
        raise ValueError(f"Feedback is too long (at most {FEEDBACK_CHARS} characters).")
    key_in = raw.get("key")
    key: dict[str, Any] | None = None
    if kind in ("multiple_choice", "dropdown", "checkboxes"):
        known = {str(o.get("id")) for o in config.get("options") or []}
        opts = [o for o in _ids((key_in or {}).get("options") if isinstance(key_in, dict) else None) if o in known]
        key = {"options": opts}
    elif kind == "short_text":
        acc: list[str] = []
        raw_acc = key_in.get("accept") if isinstance(key_in, dict) else None
        for a in raw_acc if isinstance(raw_acc, list) else []:
            if not isinstance(a, str):
                continue
            t = " ".join(a.split())[:300]
            if t and t not in acc:
                acc.append(t)
        if len(acc) > MAX_ACCEPT:
            raise ValueError(f"A question can accept at most {MAX_ACCEPT} answers.")
        key = {"accept": acc}
    elif kind in ("choice_grid", "checkbox_grid"):
        rows = {str(r.get("id")) for r in config.get("rows") or []}
        cols = {str(c.get("id")) for c in config.get("columns") or []}
        got = (key_in or {}).get("rows") if isinstance(key_in, dict) else None
        out: dict[str, Any] = {}
        for rid, v in (got or {}).items() if isinstance(got, dict) else []:
            if rid not in rows:
                continue
            if kind == "choice_grid":
                if isinstance(v, str) and v in cols:
                    out[rid] = v
            else:
                picked = [c for c in _ids(v) if c in cols]
                if picked:
                    out[rid] = picked
        # In the grid's own row order.
        order = [str(r.get("id")) for r in config.get("rows") or []]
        key = {"rows": {r: out[r] for r in order if r in out}}
    elif kind == "paragraph":
        key = None  # marked by hand
    out_q: dict[str, Any] = {"points": points, "key": key, "feedback_right": fr, "feedback_wrong": fw}
    if raw.get("suggested") is True:
        out_q["suggested"] = True
    return out_q


def has_key(item: dict[str, Any]) -> bool:
    """A question that counts in the quiz: points, and (unless it's marked
    by hand) a key with something in it."""
    q = item.get("quiz")
    if not isinstance(q, dict) or not q.get("points") or item.get("kind") not in MARKABLE_KINDS:
        return False
    if item.get("kind") == "paragraph":
        return True
    key = q.get("key") or {}
    return bool(key.get("options") or key.get("accept") or key.get("rows"))


def marked_questions(defn: dict[str, Any]) -> list[dict[str, Any]]:
    """The live questions a quiz marks, in form order."""
    return [i for i in defn.get("items") or [] if i.get("kind") in QUESTION_KINDS and not i.get("deleted") and has_key(i)]


def total_points(defn: dict[str, Any]) -> int:
    return sum(item_max(i) for i in marked_questions(defn))


def item_max(item: dict[str, Any]) -> int:
    q = item.get("quiz") or {}
    pts = int(q.get("points") or 0)
    if item.get("kind") in ("choice_grid", "checkbox_grid"):
        return pts * len((q.get("key") or {}).get("rows") or {})
    return pts


def key_signature(defn: dict[str, Any]) -> str:
    """What marking depends on (points and keys of every question): when it
    changes, answers already in are marked again."""
    parts = []
    for i in defn.get("items") or []:
        if i.get("kind") not in MARKABLE_KINDS:
            continue
        q = i.get("quiz") or {}
        cfg = i.get("config") or {}
        val = (cfg.get("validation") or {}).get("kind") if i.get("kind") == "short_text" else None
        parts.append([i.get("id"), bool(i.get("deleted")), q.get("points"), q.get("key"), val])
    return json.dumps(parts, sort_keys=True)


# --------------------------------------------------------------------
# Marking
# --------------------------------------------------------------------
_NUM = re.compile(r"^-?\d+([.,]\d+)?$")


def _norm(s: str) -> str:
    t = " ".join(str(s).split()).lower()
    while t.endswith((".", "。")):
        t = t[:-1].rstrip()
    return t


def short_answer_right(item: dict[str, Any], given: Any, accept: list[str]) -> bool:
    if not isinstance(given, str) or not given.strip():
        return False
    numeric = ((item.get("config") or {}).get("validation") or {}).get("kind") == "number"
    if numeric:
        g = given.strip().replace(",", ".", 1)
        if _NUM.match(given.strip()):
            for a in accept:
                a2 = a.strip().replace(",", ".", 1)
                if _NUM.match(a.strip()) and float(a2) == float(g):
                    return True
    g = _norm(given)
    return any(_norm(a) == g for a in accept)


def _auto(item: dict[str, Any], value: Any) -> dict[str, Any]:
    """An automatic mark for one answer (blank → 0)."""
    kind = item.get("kind")
    q = item.get("quiz") or {}
    key = q.get("key") or {}
    pts = int(q.get("points") or 0)
    mx = item_max(item)
    if kind in ("multiple_choice", "dropdown"):
        right = isinstance(value, dict) and isinstance(value.get("option"), str) and value["option"] in (key.get("options") or [])
        return {"points": pts if right else 0, "max": mx, "right": bool(right), "by": "auto"}
    if kind == "checkboxes":
        right = (
            isinstance(value, dict)
            and "other" not in value
            and isinstance(value.get("options"), list)
            and set(value["options"]) == set(key.get("options") or [])
        )
        return {"points": pts if right else 0, "max": mx, "right": bool(right), "by": "auto"}
    if kind == "short_text":
        right = short_answer_right(item, value, list(key.get("accept") or []))
        return {"points": pts if right else 0, "max": mx, "right": right, "by": "auto"}
    if kind in ("choice_grid", "checkbox_grid"):
        given = value.get("rows") if isinstance(value, dict) and isinstance(value.get("rows"), dict) else {}
        rows: dict[str, bool] = {}
        for rid, want in (key.get("rows") or {}).items():
            got = given.get(rid)
            if kind == "choice_grid":
                rows[rid] = isinstance(got, str) and got == want
            else:
                rows[rid] = isinstance(got, list) and set(got) == set(want or [])
        n = sum(1 for ok in rows.values() if ok)
        return {"points": n * pts, "max": mx, "right": n == len(rows) and n > 0, "by": "auto", "rows": rows}
    return {"points": 0, "max": mx, "right": False, "by": "auto"}


def _blank(item: dict[str, Any], value: Any) -> bool:
    from app.forms.answering import is_empty

    return is_empty(item, value)


def mark(
    defn: dict[str, Any],
    answers: dict[str, Any],
    previous: dict[str, Any] | None = None,
    previous_answers: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The grading for ``answers``. Automatic parts are always marked
    afresh; an owner's mark (``previous``) is kept only when that question's
    answer is the same as in ``previous_answers``."""
    prev_items = (previous or {}).get("items") or {}
    prev_answers = previous_answers or {}
    items: dict[str, Any] = {}
    auto = manual = pending = mx = 0
    for item in marked_questions(defn):
        qid = item["id"]
        value = answers.get(qid)
        before = prev_items.get(qid)
        same_answer = previous is not None and qid in prev_answers and prev_answers.get(qid) == value
        item_mx = item_max(item)
        mx += item_mx
        if isinstance(before, dict) and before.get("by") == "owner" and before.get("points") is not None and same_answer:
            pts = max(0, min(item_mx, int(before["points"])))
            items[qid] = {"points": pts, "max": item_mx, "right": _right(pts, item_mx), "by": "owner"}
            manual += pts
            continue
        if item.get("kind") == "paragraph":
            if value is None or _blank(item, value):
                items[qid] = {"points": 0, "max": item_mx, "right": False, "by": "auto"}
            else:
                items[qid] = {"points": None, "max": item_mx, "right": None, "by": "owner"}
                pending += 1
            continue
        got = _auto(item, value if value is not None and not _blank(item, value) else None)
        items[qid] = got
        auto += int(got["points"] or 0)
    return {"max": mx, "auto": auto, "manual": manual, "pending": pending, "items": items}


def _right(points: int, mx: int) -> bool | None:
    if points >= mx and mx > 0:
        return True
    if points <= 0:
        return False
    return None  # part marks


def score_of(grading: dict[str, Any] | None) -> int | None:
    if not grading:
        return None
    return int(grading.get("auto") or 0) + int(grading.get("manual") or 0)


def with_owner_mark(grading: dict[str, Any], item: dict[str, Any], points: int) -> dict[str, Any]:
    """``grading`` with the owner's mark on one question (a paragraph, or
    an automatic mark overridden), the totals worked out again."""
    out = json.loads(json.dumps(grading or {"items": {}}))
    mx = item_max(item)
    pts = max(0, min(mx, int(points)))
    out.setdefault("items", {})[item["id"]] = {"points": pts, "max": mx, "right": _right(pts, mx), "by": "owner"}
    return _totals(out)


def _totals(g: dict[str, Any]) -> dict[str, Any]:
    auto = manual = pending = mx = 0
    for it in (g.get("items") or {}).values():
        mx += int(it.get("max") or 0)
        if it.get("points") is None:
            pending += 1
        elif it.get("by") == "owner":
            manual += int(it["points"])
        else:
            auto += int(it["points"])
    g.update({"max": mx, "auto": auto, "manual": manual, "pending": pending})
    return g


def score_text(grading: dict[str, Any] | None) -> str:
    """"7 / 10", or "7 / 10 (2 to mark)" — the Sheet's Score cell."""
    if not grading:
        return ""
    s = f"{score_of(grading)} / {int(grading.get('max') or 0)}"
    n = int(grading.get("pending") or 0)
    return f"{s} ({n} to mark)" if n else s


# --------------------------------------------------------------------
# What a respondent sees
# --------------------------------------------------------------------
def key_text(item: dict[str, Any]) -> str:
    """The right answer in words (for "show the correct answers")."""
    from app.forms.export import grid_columns, grid_rows, labels

    q = item.get("quiz") or {}
    key = q.get("key") or {}
    kind = item.get("kind")
    if kind in ("multiple_choice", "dropdown", "checkboxes"):
        names = labels(item)
        joiner = " or " if kind != "checkboxes" else ", "
        return joiner.join(names.get(o, o) for o in key.get("options") or [])
    if kind == "short_text":
        acc = key.get("accept") or []
        return acc[0] if acc else ""
    if kind in ("choice_grid", "checkbox_grid"):
        cols = grid_columns(item)
        rows = dict(grid_rows(item))
        parts = []
        for rid, want in (key.get("rows") or {}).items():
            got = ", ".join(cols.get(c, c) for c in want) if isinstance(want, list) else cols.get(want, want)
            parts.append(f"{rows.get(rid, rid)}: {got}")
        return "; ".join(parts)
    return ""


def respondent_result(defn: dict[str, Any], settings: dict[str, Any] | None, grading: dict[str, Any] | None,
                      released: bool) -> dict[str, Any]:
    """One person's own result, filtered by the owner's switches. Nothing
    of anyone else's, ever."""
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    if not released or not grading:
        return {"released": False}
    out: dict[str, Any] = {"released": True, "pending": int(grading.get("pending") or 0)}
    if s["show_score"]:
        out["score"] = score_of(grading)
        out["max"] = int(grading.get("max") or 0)
    show_feedback = s["show_right_wrong"] or s["show_answers"]
    items = []
    g_items = grading.get("items") or {}
    for item in marked_questions(defn):
        got = g_items.get(item["id"])
        if not got:
            continue
        q = item.get("quiz") or {}
        row: dict[str, Any] = {"id": item["id"], "title": (item.get("title") or "").strip() or "Untitled question",
                               "waiting": got.get("points") is None}
        if s["show_right_wrong"]:
            row["right"] = got.get("right")
        if s["show_points"]:
            row["points"] = got.get("points")
            row["max"] = got.get("max")
        if s["show_answers"] and item.get("kind") != "paragraph":
            row["correct"] = key_text(item)
        if show_feedback and got.get("points") is not None:
            if got.get("right") is True and q.get("feedback_right"):
                row["feedback"] = q["feedback_right"]
            elif got.get("right") is False and q.get("feedback_wrong"):
                row["feedback"] = q["feedback_wrong"]
        items.append(row)
    if s["show_right_wrong"] or s["show_points"] or s["show_answers"] or any("feedback" in r for r in items):
        out["items"] = items
    return out


__all__ = [
    "AUTO_KINDS",
    "DEFAULT_SETTINGS",
    "MARKABLE_KINDS",
    "QuizSettings",
    "clean_item_quiz",
    "has_key",
    "item_max",
    "key_signature",
    "key_text",
    "mark",
    "marked_questions",
    "respondent_result",
    "score_of",
    "score_text",
    "short_answer_right",
    "total_points",
    "with_owner_mark",
]
