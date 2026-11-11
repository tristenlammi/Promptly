"""Quiz results for the people who can open a form's Responses (WP-F2.3/4).

* :func:`stats` — the Summary's Scores strip: average, median, top score,
  a histogram, how many still to mark, released or not, and per question
  how often it was right ("Most missed" is the three lowest).
* :func:`ranked` — the Scores view: every answer's score, best first.
* :func:`set_marks` — the owner marks a paragraph, or overrides an
  automatic mark (``by: "owner"``), under the form lock.
* :func:`release` — "Release scores": every answer with nothing left to
  mark (or the chosen ones) can now be seen by the person who sent it;
  signed-in people get one push ("Your score is ready"), counts and the
  form's title only.

Scores are answers: they follow ``form_access`` like every other answer.
Admins get nothing here. No respondent ever sees another's score.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from statistics import median
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.forms import quiz
from app.forms.models import Form, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User
    from app.files.models import UserFile

#: Histogram buckets at most (a 100-point quiz is grouped).
MAX_BINS = 11


def _live(form: Form):
    return (FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))


async def stats(db: AsyncSession, form: Form) -> dict[str, Any]:
    """The Scores strip. Only answers that have been marked count."""
    defn = form.definition or {}
    total_max = quiz.total_points(defn)
    rows = (
        await db.execute(select(FormResponse.number, FormResponse.grading, FormResponse.released_at).where(*_live(form)))
    ).all()
    scores: list[int] = []
    pending = released = unreleased = 0
    right: dict[str, list[int]] = {}
    for _n, g, rel in rows:
        if not g:
            continue
        if int(g.get("pending") or 0):
            pending += 1
        if rel is not None:
            released += 1
        else:
            unreleased += 1
        scores.append(quiz.score_of(g) or 0)
        for qid, it in (g.get("items") or {}).items():
            if it.get("points") is None:
                continue
            ok = 1 if it.get("right") is True else 0
            right.setdefault(qid, [0, 0])
            right[qid][0] += ok
            right[qid][1] += 1
    hist = _histogram(scores, total_max)
    per_q = []
    for item in quiz.marked_questions(defn):
        got = right.get(item["id"])
        if not got or not got[1]:
            continue
        per_q.append({
            "id": item["id"],
            "title": (item.get("title") or "").strip() or "Untitled question",
            "right_pct": round(100 * got[0] / got[1]),
            "answered": got[1],
        })
    most_missed = sorted([p for p in per_q if p["right_pct"] < 100], key=lambda p: (p["right_pct"], p["title"]))[:3]
    return {
        "max": total_max,
        "marked": len(scores),
        "average": round(sum(scores) / len(scores), 1) if scores else None,
        "median": median(scores) if scores else None,
        "top": max(scores) if scores else None,
        "histogram": hist,
        "pending": pending,
        "released": released,
        "unreleased": unreleased,
        "release": (form.quiz or {}).get("release", "now"),
        "questions": per_q,
        "most_missed": most_missed,
    }


def _histogram(scores: list[int], top: int) -> list[dict[str, Any]]:
    """Counts per score (or per range of scores for a long quiz)."""
    if top <= 0:
        return []
    if top + 1 <= MAX_BINS:
        return [{"label": str(v), "from": v, "to": v, "count": sum(1 for s in scores if s == v)} for v in range(top + 1)]
    width = -(-(top + 1) // MAX_BINS)
    out = []
    lo = 0
    while lo <= top:
        hi = min(top, lo + width - 1)
        out.append({"label": f"{lo}–{hi}", "from": lo, "to": hi, "count": sum(1 for s in scores if lo <= s <= hi)})
        lo = hi + 1
    return out


async def ranked(db: AsyncSession, form: Form) -> list[dict[str, Any]]:
    """Every marked answer, best score first (ties: first to answer)."""
    from app.forms.results import names_of, who

    rows = (
        await db.execute(select(FormResponse).where(*_live(form), FormResponse.grading.is_not(None)))
    ).scalars().all()
    names = await names_of(db, {r.respondent_id for r in rows if r.respondent_id})
    out = [
        {
            "number": r.number,
            "who": who(r, names),
            "score": quiz.score_of(r.grading) or 0,
            "max": int((r.grading or {}).get("max") or 0),
            "pending": int((r.grading or {}).get("pending") or 0),
            "released": r.released_at is not None,
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        }
        for r in rows
    ]
    out.sort(key=lambda x: (-x["score"], x["number"]))
    return out


def marks_view(r: FormResponse) -> dict[str, Any] | None:
    """One answer's marks for the people who can see the answers:
    ``{score, max, pending, released, items}``."""
    g = r.grading
    if not g:
        return None
    return {
        "score": quiz.score_of(g) or 0,
        "max": int(g.get("max") or 0),
        "pending": int(g.get("pending") or 0),
        "released": r.released_at is not None,
        "items": g.get("items") or {},
    }


class MarkError(ValueError):
    pass


async def set_marks(db: AsyncSession, form: Form, number: int, marks: dict[str, Any]) -> FormResponse | None:
    """``{qid: points | null}`` on one answer (``null`` hands a question
    back to automatic marking). ``form`` must be locked. None when there's
    no such answer."""
    if form.quiz is None:
        raise MarkError("This form isn't a quiz.")
    r = (
        await db.execute(select(FormResponse).where(*_live(form), FormResponse.number == number))
    ).scalar_one_or_none()
    if r is None:
        return None
    defn = form.definition or {}
    by_id = {i["id"]: i for i in quiz.marked_questions(defn)}
    g = r.grading or quiz.mark(defn, r.answers or {})
    for qid, pts in marks.items():
        item = by_id.get(qid)
        if item is None:
            raise MarkError("That question isn't marked in this quiz.")
        if pts is None:
            # Back to automatic: mark it again as if nobody had touched it.
            fresh = quiz.mark(defn, r.answers or {})
            g = {**g, "items": {**(g.get("items") or {}), qid: fresh["items"].get(qid)}}
            g = quiz._totals(g)
            continue
        if isinstance(pts, bool) or not isinstance(pts, int) or pts < 0 or pts > quiz.item_max(item):
            raise MarkError(f"Give between 0 and {quiz.item_max(item)} points.")
        g = quiz.with_owner_mark(g, item, pts)
    r.grading = g
    r.score = quiz.score_of(g)
    # The linked sheet's Score cell follows (a new seq).
    r.seq = (await db.execute(text("SELECT nextval('form_response_seq')"))).scalar_one()
    return r


async def release(
    db: AsyncSession, form: Form, numbers: list[int] | None = None
) -> tuple[dict[str, int], set[uuid.UUID]]:
    """"Release scores": answers with nothing left to mark (all, or the
    chosen ones) are released; answers still waiting stay. Returns the
    counts and the signed-in people to tell. ``form`` must be locked; the
    caller commits, then calls :func:`tell_released`."""
    if form.quiz is None:
        raise MarkError("This form isn't a quiz.")
    q = select(FormResponse).where(*_live(form), FormResponse.released_at.is_(None), FormResponse.grading.is_not(None))
    if numbers:
        q = q.where(FormResponse.number.in_(numbers))
    rows = (await db.execute(q)).scalars().all()
    now = datetime.now(timezone.utc)
    done = waiting = 0
    people: set[uuid.UUID] = set()
    for r in rows:
        if int((r.grading or {}).get("pending") or 0):
            waiting += 1
            continue
        r.released_at = now
        done += 1
        if r.respondent_id is not None:
            people.add(r.respondent_id)
    return {"released": done, "still_to_mark": waiting}, people


async def tell_released(db: AsyncSession, shell: UserFile, form: Form, people: set[uuid.UUID]) -> int:
    """One push to each signed-in person whose score was just released:
    the ``invite`` category (the one Send uses), the form's title only."""
    from app.forms.service import live_link
    from app.notifications.dispatch import notify_user

    if not people:
        return 0
    link = await live_link(db, shell)
    title = (form.definition or {}).get("title") or "Untitled form"
    url = f"/f/{link.token}?result=1" if link is not None else None
    sent = 0
    for uid in people:
        await notify_user(
            user_id=uid,
            category="invite",
            title="Your score is ready",
            body=f"“{title}”",
            url=url,
            tag=f"form-score:{form.id}",
        )
        sent += 1
    return sent


async def to_mark(db: AsyncSession, form_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Answers waiting for a hand mark, per form (Home cards and Today)."""
    if not form_ids:
        return {}
    rows = await db.execute(
        text(
            "SELECT form_id, count(*) FROM form_responses WHERE form_id = ANY(:ids) AND deleted_at IS NULL "
            "AND grading IS NOT NULL AND COALESCE((grading->>'pending')::int, 0) > 0 GROUP BY form_id"
        ),
        {"ids": form_ids},
    )
    return {fid: int(n) for fid, n in rows.all()}


__all__ = ["MarkError", "marks_view", "ranked", "release", "set_marks", "stats", "tell_released", "to_mark"]
