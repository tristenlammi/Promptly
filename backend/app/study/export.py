"""Study in "Export my library": each subject as a readable Markdown file
(the map, where you are on it, what was added for you, the report, the
sources) and ``study.json`` with all of them for other programs.

Only the person's own subjects, as they are when the export is made. The
teacher's steps and your answers to them are not exported: the map and your
progress are what you take with you.
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
        item["markdown"] = _md(item)
        out.append(item)
    return {"format": 1, "subjects": out} if out else None
