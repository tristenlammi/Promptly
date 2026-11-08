"""Answering a form: the path walk and the answer checks done on every submit.

The answer page (``frontend/src/components/forms/logic.ts``, through
``FormRenderer``) walks the same path and makes the same checks while
someone types, so a person sees a problem under the question. The server
does it all again here, because a request can be made by hand:

* :func:`walk_path` re-walks the sections from the answers themselves. Only
  answers to questions on that path are kept (a hand-made request can't
  slip in answers to a section it never reached), and "required" is checked
  only there — but everywhere there (it can't be skipped either).
* :func:`check_answers` checks each kept answer against its question's
  settings and returns the cleaned answers.

**The walk must match ``logic.ts::nextSection`` exactly**: when a section
ends, the last question in it with branching on whose chosen option has a
``go_to`` decides; otherwise the section's own ``after``. ``continue`` is
the next section (or the end), ``submit`` ends the form, and a section id
jumps there — a jump to the same or an earlier section ends the form, so a
form can never loop.

Answer shapes, by kind: short_text / paragraph a string;
multiple_choice ``{option: id}`` or ``{other: text}``; dropdown
``{option: id}``; checkboxes ``{options: [id…], other?: text}``;
linear_scale / rating a whole number; date ``YYYY-MM-DD`` (``THH:MM`` with
time; ``MM-DD…`` without the year); time ``HH:MM`` or a duration
``H:MM:SS``; file_upload upload ids (WP-F1.6).
"""
from __future__ import annotations

import calendar
import copy
import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.forms.definition import QUESTION_KINDS, json_size

BRANCHING_KINDS = ("multiple_choice", "dropdown")
LIMITED_KINDS = ("multiple_choice", "checkboxes", "dropdown")

# File questions take answers once uploads land (WP-F1.6). Until then the
# answer page doesn't show them: they're left out of what a respondent is
# sent, never required, and any answer to them is dropped.
UPLOADS_OPEN = False

MAX_ANSWERS_BYTES = 64 * 1024
OTHER_MAX = 500
SHORT_MAX = 1000
EMAIL_MAX = 254

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_URL = re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.IGNORECASE)
_NUMBER = re.compile(r"^-?\d+([.,]\d+)?$")
_DATE_Y = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_DATE_YT = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$")
_DATE_N = re.compile(r"^(\d{2})-(\d{2})$")
_DATE_NT = re.compile(r"^(\d{2})-(\d{2})T(\d{2}):(\d{2})$")
_TIME = re.compile(r"^(\d{2}):(\d{2})$")
_DURATION = re.compile(r"^\d{1,3}:[0-5]\d:[0-5]\d$")


class AnswerError(ValueError):
    """An answer the form can't take. ``str()`` is shown under the
    question ``question_id`` (``"_email"`` for the email box)."""

    def __init__(self, message: str, *, question_id: str | None = None) -> None:
        super().__init__(message)
        self.question_id = question_id


# --------------------------------------------------------------------
# Sections and the path
# --------------------------------------------------------------------
@dataclass
class Section:
    id: str | None
    index: int
    item: dict[str, Any] | None
    items: list[dict[str, Any]] = field(default_factory=list)
    after: str = "continue"


def sections_of(defn: dict[str, Any]) -> list[Section]:
    """The form's sections, deleted items left out (``model.ts::sectionsOf``)."""
    out = [Section(id=None, index=0, item=None, after=defn.get("after") or "continue")]
    for it in defn.get("items") or []:
        if it.get("deleted"):
            continue
        if it.get("kind") == "section":
            out.append(
                Section(
                    id=it.get("id"),
                    index=len(out),
                    item=it,
                    after=(it.get("config") or {}).get("after") or "continue",
                )
            )
        else:
            out[-1].items.append(it)
    return out


def next_section(sections: list[Section], index: int, answers: dict[str, Any]) -> int | str:
    """Where section ``index`` leads: an index, or ``"submit"``."""
    sec = sections[index]
    target: str | None = None
    for q in sec.items:
        if q.get("kind") not in BRANCHING_KINDS:
            continue
        cfg = q.get("config") or {}
        if not cfg.get("branching"):
            continue
        v = answers.get(q.get("id"))
        chosen = None
        if isinstance(v, dict) and "option" in v:
            chosen = next((o for o in cfg.get("options") or [] if o.get("id") == v.get("option")), None)
        if chosen and chosen.get("go_to"):
            target = chosen["go_to"]
    where = target if target is not None else (sec.after or "continue")
    if where == "submit":
        return "submit"
    if where == "continue":
        return index + 1 if index + 1 < len(sections) else "submit"
    to = next((s.index for s in sections if s.id == where), -1)
    return to if to > index else "submit"


def walk_path(defn: dict[str, Any], answers: dict[str, Any]) -> list[int]:
    """The sections someone with these answers passes through, in order."""
    sections = sections_of(defn)
    path = [0]
    for _ in range(len(sections)):
        n = next_section(sections, path[-1], answers)
        if n == "submit":
            break
        path.append(int(n))
    return path


# --------------------------------------------------------------------
# What a respondent is sent
# --------------------------------------------------------------------
def answerable(item: dict[str, Any]) -> bool:
    """A question someone can answer on the answer page now."""
    kind = item.get("kind")
    if kind not in QUESTION_KINDS or item.get("deleted"):
        return False
    return UPLOADS_OPEN or kind != "file_upload"


def respondent_definition(defn: dict[str, Any]) -> dict[str, Any]:
    """The definition as someone answering sees it: no deleted items, and
    no file questions until uploads open (WP-F1.6). Sections and branching
    are untouched, so the walk is the same on both sides."""
    out = copy.deepcopy(defn)
    out["items"] = [
        i
        for i in out.get("items") or []
        if not i.get("deleted") and (i.get("kind") != "file_upload" or UPLOADS_OPEN)
    ]
    return out


def hidden_questions(defn: dict[str, Any]) -> list[dict[str, Any]]:
    """Live questions the answer page leaves out for now (file questions
    before WP-F1.6) — the Send dialog tells the owner."""
    return [
        i
        for i in defn.get("items") or []
        if not i.get("deleted") and i.get("kind") in QUESTION_KINDS and not answerable(i)
    ]


def limited_options(defn: dict[str, Any]) -> dict[str, dict[str, int]]:
    """``{question_id: {option_id: limit}}`` for every option with places."""
    out: dict[str, dict[str, int]] = {}
    for i in defn.get("items") or []:
        if i.get("deleted") or i.get("kind") not in LIMITED_KINDS:
            continue
        for o in (i.get("config") or {}).get("options") or []:
            if o.get("limit"):
                out.setdefault(i["id"], {})[o["id"]] = int(o["limit"])
    return out


def remaining(defn: dict[str, Any], taken: dict[tuple[str, str], int]) -> dict[str, dict[str, int]]:
    """Places left on each limited option (never below 0)."""
    return {
        qid: {oid: max(0, limit - taken.get((qid, oid), 0)) for oid, limit in opts.items()}
        for qid, opts in limited_options(defn).items()
    }


def picks(defn: dict[str, Any], answers: dict[str, Any]) -> list[tuple[str, str]]:
    """Every option these (clean) answers choose, as (question, option).
    All of them are counted, not only limited ones, so a limit added after
    people have answered starts from the right number."""
    kinds = {
        i.get("id"): i.get("kind")
        for i in defn.get("items") or []
        if i.get("kind") in LIMITED_KINDS
    }
    out: list[tuple[str, str]] = []
    for qid, v in answers.items():
        if qid not in kinds or not isinstance(v, dict):
            continue
        chosen = v.get("options") if isinstance(v.get("options"), list) else [v.get("option")]
        out.extend((qid, oid) for oid in chosen if isinstance(oid, str) and oid)
    return out


# --------------------------------------------------------------------
# Checking answers
# --------------------------------------------------------------------
def is_empty(item: dict[str, Any], v: Any) -> bool:
    """``logic.ts::isEmpty``."""
    if v is None:
        return True
    if isinstance(v, bool):
        return False
    if isinstance(v, str):
        return v.strip() == ""
    if isinstance(v, (int, float)):
        return isinstance(v, float) and math.isnan(v)
    if isinstance(v, list):
        return len(v) == 0
    if isinstance(v, dict):
        if item.get("kind") == "checkboxes":
            opts = v.get("options")
            return (not isinstance(opts, list) or len(opts) == 0) and "other" not in v
        return not v.get("option") and "other" not in v
    return False


def _whole(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return None


def _fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def _clock_ok(hh: str, mm: str) -> bool:
    return int(hh) < 24 and int(mm) < 60


def _day_ok(year: int, month: int, day: int) -> bool:
    if not 1 <= month <= 12 or day < 1:
        return False
    return day <= calendar.monthrange(year, month)[1]


def check_one(item: dict[str, Any], v: Any) -> Any:
    """The cleaned answer to ``item`` (not empty), or :class:`AnswerError`
    in the words ``logic.ts::problemWith`` uses."""
    qid = item.get("id")
    cfg = item.get("config") or {}
    kind = item.get("kind")

    def bad(msg: str) -> AnswerError:
        return AnswerError(msg, question_id=qid)

    if kind == "short_text":
        if not isinstance(v, str):
            raise bad("Write your answer as text.")
        s = v.strip()
        val = cfg.get("validation") or {}
        vk = val.get("kind") or "any"
        if vk == "number":
            if not _NUMBER.match(s):
                raise bad("Enter a number.")
            n = float(s.replace(",", ".", 1))
            lo, hi = val.get("min"), val.get("max")
            if val.get("integer") and not n.is_integer():
                raise bad("Enter a whole number.")
            if lo is not None and n < lo:
                raise bad(f"Enter a number from {_fmt(lo)} to {_fmt(hi)}." if hi is not None else f"Enter {_fmt(lo)} or more.")
            if hi is not None and n > hi:
                raise bad(f"Enter a number from {_fmt(lo)} to {_fmt(hi)}." if lo is not None else f"Enter {_fmt(hi)} or less.")
        if vk == "email" and not _EMAIL.match(s):
            raise bad("Enter an email like name@example.com.")
        if vk == "url" and not _URL.match(s):
            raise bad("Enter a web link starting with https://")
        if cfg.get("min_length") and len(s) < cfg["min_length"]:
            raise bad(f"Write at least {cfg['min_length']} characters.")
        if cfg.get("max_length") and len(s) > cfg["max_length"]:
            raise bad(f"Keep it to {cfg['max_length']} characters or fewer.")
        if len(s) > SHORT_MAX:
            raise bad(f"Keep it to {SHORT_MAX} characters or fewer.")
        return s

    if kind == "paragraph":
        if not isinstance(v, str):
            raise bad("Write your answer as text.")
        s = v.strip()
        if cfg.get("min_length") and len(s) < cfg["min_length"]:
            raise bad(f"Write at least {cfg['min_length']} characters.")
        limit = int(cfg.get("max_length") or 5000)
        if len(s) > limit:
            raise bad(f"Keep it to {limit} characters or fewer.")
        return s

    options = {o.get("id") for o in cfg.get("options") or []}

    if kind in ("multiple_choice", "dropdown"):
        if not isinstance(v, dict) or len(v) != 1:
            raise bad("Pick one of the options.")
        if "option" in v:
            if not isinstance(v["option"], str) or v["option"] not in options:
                raise bad("That option isn't on the form any more. Pick another.")
            return {"option": v["option"]}
        if kind == "multiple_choice" and "other" in v and cfg.get("other"):
            other = v["other"]
            if not isinstance(other, str) or not other.strip():
                raise bad("Say what “Other” is.")
            if len(other.strip()) > OTHER_MAX:
                raise bad(f"Keep “Other” to {OTHER_MAX} characters or fewer.")
            return {"other": other.strip()}
        raise bad("Pick one of the options.")

    if kind == "checkboxes":
        if not isinstance(v, dict) or set(v) - {"options", "other"}:
            raise bad("Tick the options you want.")
        chosen = v.get("options", [])
        if not isinstance(chosen, list) or not all(isinstance(x, str) for x in chosen):
            raise bad("Tick the options you want.")
        if len(set(chosen)) != len(chosen):
            raise bad("An option was ticked twice.")
        if any(x not in options for x in chosen):
            raise bad("An option you ticked isn't on the form any more.")
        out: dict[str, Any] = {"options": list(chosen)}
        if "other" in v:
            other = v["other"]
            if not cfg.get("other"):
                raise bad("This question has no “Other”.")
            if not isinstance(other, str) or not other.strip():
                raise bad("Say what “Other” is.")
            if len(other.strip()) > OTHER_MAX:
                raise bad(f"Keep “Other” to {OTHER_MAX} characters or fewer.")
            out["other"] = other.strip()
        n = len(chosen) + (1 if "other" in out else 0)
        lo, hi = cfg.get("min_selected"), cfg.get("max_selected")
        if lo and hi and lo == hi and n != lo:
            raise bad(f"Tick exactly {lo}.")
        if lo and n < lo:
            raise bad(f"Tick at least {lo}.")
        if hi and n > hi:
            raise bad(f"Tick at most {hi}.")
        return out

    if kind == "linear_scale":
        n = _whole(v)
        lo, hi = int(cfg.get("min", 1)), int(cfg.get("max", 5))
        if n is None or not lo <= n <= hi:
            raise bad(f"Pick a number from {lo} to {hi}.")
        return n

    if kind == "rating":
        n = _whole(v)
        hi = int(cfg.get("max", 5))
        if n is None or not 1 <= n <= hi:
            raise bad(f"Pick from 1 to {hi}.")
        return n

    if kind == "date":
        if not isinstance(v, str):
            raise bad("Pick a full date.")
        with_year = cfg.get("include_year", True)
        with_time = cfg.get("include_time", False)
        if with_year:
            m = (_DATE_YT if with_time else _DATE_Y).match(v)
            if not m:
                raise bad("Pick a full date.")
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 1 or not _day_ok(y, mo, d):
                raise bad("Pick a full date.")
            date(y, mo, d)
            if with_time and not _clock_ok(m.group(4), m.group(5)):
                raise bad("Pick a time.")
        else:
            m = (_DATE_NT if with_time else _DATE_N).match(v)
            # A leap year, so 29 February counts (birthdays).
            if not m or not _day_ok(2024, int(m.group(1)), int(m.group(2))):
                raise bad("Pick a full date.")
            if with_time and not _clock_ok(m.group(3), m.group(4)):
                raise bad("Pick a time.")
        return v

    if kind == "time":
        if not isinstance(v, str):
            raise bad("Pick a time.")
        if (cfg.get("mode") or "time") == "duration":
            if not _DURATION.match(v):
                raise bad("Enter hours, minutes and seconds.")
            return v
        m = _TIME.match(v)
        if not m or not _clock_ok(m.group(1), m.group(2)):
            raise bad("Pick a time.")
        return v

    raise bad("This question can't take answers here.")


def check_answers(defn: dict[str, Any], raw: Any) -> tuple[dict[str, Any], list[int]]:
    """(clean answers, path): the path re-walked from ``raw``, only the
    answers on it, each checked, and every required question on it
    answered. Raises :class:`AnswerError` at the first problem, in form
    order."""
    if not isinstance(raw, dict):
        raise AnswerError("The answers didn't arrive in a shape the form understands.")
    if json_size(raw) > MAX_ANSWERS_BYTES:
        raise AnswerError("These answers are too long to send. Shorten the longest ones.")
    sections = sections_of(defn)
    path = walk_path(defn, raw)
    clean: dict[str, Any] = {}
    for idx in path:
        for item in sections[idx].items:
            if not answerable(item):
                continue
            v = raw.get(item["id"])
            if is_empty(item, v):
                if item.get("required"):
                    raise AnswerError("This question needs an answer.", question_id=item["id"])
                continue
            clean[item["id"]] = check_one(item, v)
    return clean, path


def check_email(raw: Any) -> str:
    """The email someone typed on a link form ("not checked" — only its shape)."""
    s = raw.strip() if isinstance(raw, str) else ""
    if not s:
        raise AnswerError("Enter your email address.", question_id="_email")
    if len(s) > EMAIL_MAX or not _EMAIL.match(s):
        raise AnswerError("Enter an email like name@example.com.", question_id="_email")
    return s


__all__ = [
    "MAX_ANSWERS_BYTES",
    "UPLOADS_OPEN",
    "AnswerError",
    "Section",
    "answerable",
    "check_answers",
    "check_email",
    "check_one",
    "hidden_questions",
    "is_empty",
    "limited_options",
    "next_section",
    "picks",
    "remaining",
    "respondent_definition",
    "sections_of",
    "walk_path",
]
