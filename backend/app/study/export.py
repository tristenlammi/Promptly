"""Study in "Export my library": each subject as a readable Markdown file
(the map, where you are on it, what was added for you, the report, the
sources, then every step you answered: what was asked, what you answered and
how it went) and ``study.json`` with all of them for other programs.

Only the person's own subjects, as they are when the export is made. The
answer keys and the teacher's hidden notes stay behind: what is exported is
what was on your screen.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.study import service
from app.study.models import StudySubject

_STATE = {"new": "not started", "learning": "learning", "mastered": "learned", "known": "already knew"}


def _md(s: dict[str, Any]) -> str:
    lines = [f"# {s['title']}", ""]
    if s["goal"]:
        lines += [f"Why: {s['goal']}", ""]
    lines += [f"{s['progress']['done']} of {s['progress']['total']} ideas learned ({s['status']}). Pitched at: {s['level']}. Depth: {s['depth']}.", ""]
    if s["summary"]:
        lines += [s["summary"], ""]
    for u in s["units"]:
        lines += [f"## {u['title']}", ""]
        for c in u["concepts"]:
            mark = "x" if c["state"] in ("mastered", "known") else " "
            extra = f" ({_STATE[c['state']]}, {round(c['mastery'] * 100)}%)"
            lines.append(f"- [{mark}] **{c['title']}**{extra}: {c['summary']}")
            if c["reason"]:
                lines.append(f"  - Added for you: {c['reason']}")
        if u["capstone"]:
            lines += ["", f"Unit task: {u['capstone']['status']} ({u['capstone']['met']} of {u['capstone']['points']} points)."]
        lines.append("")
    rep = s["report"]
    if rep["shaky"]:
        lines += ["## Worth another look", ""] + [f"- {x['title']}: {x['why']}" for x in rep["shaky"]] + [""]
    if rep["next"]:
        lines += ["## What could come next", ""] + [f"- {x['title']}: {x['why']}" for x in rep["next"]] + [""]
    if s["sources"]:
        lines += ["## Sources", ""] + [f"{x['n']}. {x['title']}" + (f" <{x['url']}>" if x["url"] else "") for x in s["sources"]] + [""]
    return "\n".join(lines)


async def study_export(db: AsyncSession, user: Any) -> dict[str, Any] | None:
    """``{"subjects": [...]}`` (each with ``markdown``), or None with no subjects."""
    from app.study.router import _cap_view, _iso, report_view

    subs = list(
        (await db.execute(select(StudySubject).where(StudySubject.user_id == user.id, StudySubject.trashed_at.is_(None)).order_by(StudySubject.created_at))).scalars()
    )
    out = []
    for s in subs:
        if s.status in ("building", "failed"):
            continue
        concepts = await service.concepts_of(db, s.id)
        rep = await report_view(db, s)
        item = {
            "title": s.title, "goal": s.goal, "level": s.level, "depth": s.depth, "status": s.status, "summary": s.summary,
            "archived": s.archived, "created_at": _iso(s.created_at), "last_studied_at": _iso(s.last_studied_at),
            "progress": rep["subject"]["progress"],
            "units": [
                {
                    "title": u.title, "summary": u.summary, "capstone": _cap_view(u.capstone),
                    "concepts": [
                        {
                            "title": c.title, "summary": c.summary, "objectives": c.objectives or [], "state": c.state, "mastery": round(c.mastery, 3),
                            "mastered_at": _iso(c.mastered_at), "next_review_at": _iso(c.due_at), "origin": c.origin, "reason": c.reason,
                        }
                        for c in concepts if c.unit_id == u.id
                    ],
                }
                for u in await service.units_of(db, s.id)
            ],
            "capstone": _cap_view(s.capstone),
            "report": {"shaky": [{"title": x["title"], "why": x["why"]} for x in rep["shaky"]], "next": rep["next"], "totals": rep["totals"]},
            "sources": rep["sources"],
        }
        item["steps"] = await steps_export(db, s.id, {c.id: c.title for c in concepts})
        item["markdown"] = _md(item) + ("\n" + steps_md(item["steps"]) if item["steps"] else "")
        out.append(item)
    return {"format": 1, "subjects": out} if out else None


# --------------------------------------------------------- steps and answers

#: The most steps of one subject that are written out (the newest are kept).
MAX_STEPS = 3000

_KIND = {
    "explain": "Explanation", "predict": "What do you think?", "mcq": "Quick check", "order_steps": "Put in order",
    "match_pairs": "Match them up", "spot_error": "Spot the mistake", "worked_example": "Work it through",
    "explain_back": "In your own words", "scenario": "Use it", "teach_student": "You're the teacher", "capstone": "Put it together",
    "explore": "Try it yourself", "write_code": "Write the code",
}
_ASKED = ("title", "body_md", "setup_md", "scenario_md", "problem_md", "intro_md", "opening_md", "task_md", "question_md", "prompt_md")


def _texts(rows: Any) -> dict[str, str]:
    return {r["id"]: r.get("text") or r.get("label") or "" for r in rows or [] if isinstance(r, dict) and "id" in r}


def step_asked(kind: str, pub: dict[str, Any]) -> str:
    """What the step put to the learner, as plain text."""
    # A capstone's title is its name (the idea column), not part of the task.
    parts = [str(pub[k]).strip() for k in _ASKED if pub.get(k) and not (kind == "capstone" and k == "title")]
    if pub.get("options"):
        parts.append("\n".join(f"- {o['text']}" for o in pub["options"]))
    if pub.get("lines"):
        parts.append("\n".join(f"{i}. {x['text']}" for i, x in enumerate(pub["lines"], 1)))
    if pub.get("items"):
        parts.append("\n".join(f"- {x['text']}" for x in pub["items"]))
    if pub.get("left"):
        parts.append("Match: " + "; ".join(x["text"] for x in pub["left"]) + "\nWith: " + "; ".join(x["text"] for x in pub.get("right") or []))
    for st in pub.get("steps") or []:
        if isinstance(st, dict) and st.get("text_md"):
            parts.append(("(for you) " if st.get("blank") else "") + st["text_md"])
    if kind == "write_code" and pub.get("starter"):
        parts.append("Starting from:\n" + pub["starter"])
    if isinstance(pub.get("figure"), dict) and pub["figure"].get("title"):
        parts.append(f"(A figure to work: {pub['figure']['title']})")
    return "\n\n".join(p for p in parts if p)


def step_answer(kind: str, pub: dict[str, Any], answer: dict[str, Any] | None, turns: list[dict[str, Any]]) -> str:
    """What the learner answered, in words (their own text as they wrote it)."""
    a = answer or {}
    if a.get("dont_know"):
        return "I don't know"
    if kind in ("mcq", "predict"):
        return _texts(pub.get("options")).get(a.get("option_id"), "")
    if kind == "spot_error":
        return _texts(pub.get("lines")).get(a.get("line_id"), "")
    if kind == "order_steps":
        names = _texts(pub.get("items"))
        return "\n".join(f"{i}. {names.get(x, '')}" for i, x in enumerate(a.get("order") or [], 1))
    if kind == "match_pairs":
        left, right = _texts(pub.get("left")), _texts(pub.get("right"))
        return "\n".join(f"- {left.get(k, '')} → {right.get(v, '')}" for k, v in (a.get("pairs") or {}).items())
    if kind == "worked_example":
        out = []
        for st in pub.get("steps") or []:
            if st.get("blank"):
                out.append(_texts(st.get("options")).get((a.get("blanks") or {}).get(st["id"]), ""))
        return "\n".join(f"- {x}" for x in out)
    if kind == "teach_student":
        return "\n".join(f"{'Me' if t.get('role') == 'learner' else pub.get('student_name', 'Student')}: {t.get('text', '')}" for t in turns or [])
    if kind == "explore":
        fig = pub.get("figure") or {}
        if "part_id" in a:
            return _texts(fig.get("parts")).get(a["part_id"], "")
        if "value" in a:
            return f"{a['value']}{(' ' + fig['unit']) if fig.get('unit') else ''}"
        labels = {c["name"]: c.get("label") or c["name"] for c in (fig.get("params") or fig.get("inputs") or [])}
        return ", ".join(f"{labels.get(k, k)} = {v}" for k, v in (a.get("values") or {}).items())
    if kind == "write_code":
        return str(a.get("code") or "")
    return str(a.get("text") or "")


async def steps_export(db: AsyncSession, subject_id: Any, titles: dict[Any, str]) -> list[dict[str, Any]]:
    """Every step of a subject that was answered, oldest first: what was
    asked, what the learner answered and how it went. The answer key and the
    teacher's hidden notes are not exported, only the feedback that was shown."""
    from app.study.models import StudySession, StudyStep
    from app.study.router import _iso

    rows = (
        await db.execute(
            select(StudyStep, StudySession.kind)
            .join(StudySession, StudySession.id == StudyStep.session_id)
            .where(StudyStep.subject_id == subject_id, StudyStep.status == "answered")
            .order_by(StudyStep.created_at.desc(), StudyStep.position.desc())
            .limit(MAX_STEPS)
        )
    ).all()
    out = []
    for st, session_kind in reversed(rows):
        pub = (st.payload or {}).get("public") or {}
        grade = st.grade or {}
        placement = st.role == "placement"
        out.append({
            "at": _iso(st.answered_at or st.created_at), "session": session_kind, "role": st.role or "lesson", "kind": st.kind,
            "idea": pub.get("title") if st.kind == "capstone" else titles.get(st.concept_id, ""),
            "asked": step_asked(st.kind, pub),
            "answer": step_answer(st.kind, pub, st.answer, st.turns or []) if st.kind != "explain" else None,
            "outcome": grade.get("outcome"),
            # The quick check gives no feedback when it is taken; nor does its export.
            "feedback": None if placement else (grade.get("feedback_md") or None),
            "mix_up": None if placement else grade.get("misconception"),
            "hints_used": st.hints_used, "confidence": st.confidence,
            "questions": [{"who": x.get("role"), "text": x.get("text")} for x in (st.asks or [])],
        })
    return out


def steps_md(steps: list[dict[str, Any]]) -> str:
    """The steps as a readable section of the subject's file."""
    if not steps:
        return ""
    lines = ["## What you did", "", "Every step you answered, oldest first.", ""]
    for i, s in enumerate(steps, 1):
        head = _KIND.get(s["kind"], s["kind"])
        where = {"placement": " (quick check)", "recall": " (looking back)", "review": " (review)", "test_out": " (testing out)", "capstone": " (task)"}.get(s["role"], "")
        lines += [f"### {i}. {head}{where}: {s['idea'] or 'the course'}", ""]
        if s["at"]:
            lines += [f"_{s['at'][:16].replace('T', ' ')}_", ""]
        if s["asked"]:
            lines += [s["asked"], ""]
        if s["answer"] is not None:
            lines += ["**Your answer:**", "", s["answer"] or "(nothing)", ""]
        if s["outcome"]:
            sure = {1: ", guessing", 2: ", fairly sure", 3: ", sure"}.get(s["confidence"], "")
            hints = f", {s['hints_used']} hint{'s' if s['hints_used'] != 1 else ''}" if s["hints_used"] else ""
            lines += [f"**Result:** {({'correct': 'right', 'partial': 'partly right', 'wrong': 'not right'}).get(s['outcome'], s['outcome'])}{sure}{hints}", ""]
        if s["mix_up"]:
            lines += [f"The mix-up: {s['mix_up']}", ""]
        if s["feedback"]:
            lines += [s["feedback"], ""]
        for q in s["questions"]:
            lines += [f"> {'You asked' if q['who'] == 'learner' else 'The teacher'}: {q['text']}", ""]
    return "\n".join(lines)
