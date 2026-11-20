"""Study — the API (``/api/study``). The contract is ``docs/study-api.md``.

Every route is the signed-in person's own data: a subject that isn't theirs
is a 404, for an admin as much as anyone. Nothing here streams.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.study import reminders, rules, service, steps
from app.study.models import (
    DEPTHS,
    LEVELS,
    StudyConcept,
    StudyMisconception,
    StudySession,
    StudyStep,
    StudySubject,
    StudyUnit,
)

router = APIRouter()


def _http(e: service.StudyError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.message})


async def _quotas(request: Request, user: User, db: AsyncSession) -> None:
    """Study's own rate count (a lesson spends many calls), chat's budget check."""
    from app.chat.router import _enforce_send_quotas
    from app.rate_limit import enforce_user_study_rate

    await _enforce_send_quotas(request, user, db, rate=enforce_user_study_rate)


# -------------------------------------------------------------------- views


def _iso(d: Any) -> str | None:
    return d.isoformat() if d else None


def _is_due(c: StudyConcept, now: datetime | None = None) -> bool:
    return c.state in ("mastered", "known") and c.due_at is not None and c.due_at <= (now or datetime.now(timezone.utc))


def concept_view(c: StudyConcept, by_id: dict[str, StudyConcept]) -> dict[str, Any]:
    locked = c.state not in ("mastered", "known") and any(
        by_id[p].state not in ("mastered", "known") for p in (c.prereqs or []) if p in by_id
    )
    return {
        "id": str(c.id), "unit_id": str(c.unit_id), "position": c.position, "title": c.title, "summary": c.summary,
        "objectives": c.objectives or [], "nature": c.nature, "prereqs": [p for p in (c.prereqs or []) if p in by_id],
        "mastery": round(c.mastery, 3), "state": c.state, "locked": locked,
        "origin": c.origin, "reason": c.reason, "gap_for": str(c.gap_for) if c.gap_for else None,
        "steps_done": c.steps_done, "sources": c.source_ns or [], "tool": c.tool or "",
        "last_seen_at": _iso(c.last_seen_at), "mastered_at": _iso(c.mastered_at),
        # Reviews: when it next comes back, whether that is now, and how often it has slipped.
        "due_at": _iso(c.due_at) if c.state in ("mastered", "known") else None, "due": _is_due(c),
        "reviews": int((c.fsrs or {}).get("reps") or 0), "lapses": int((c.fsrs or {}).get("lapses") or 0),
    }


def progress_of(concepts: list[StudyConcept]) -> dict[str, Any]:
    done = sum(1 for c in concepts if c.state in ("mastered", "known"))
    return {
        "total": len(concepts), "done": done, "learning": sum(1 for c in concepts if c.state == "learning"),
        "percent": round(100 * done / len(concepts)) if concepts else 0,
    }


def subject_card(s: StudySubject, concepts: list[StudyConcept]) -> dict[str, Any]:
    nxt = rules.pick_concept([service._state(c) for c in concepts]) if s.status in ("active", "placement") else None
    by_id = {str(c.id): c for c in concepts}
    return {
        "id": str(s.id), "title": s.title, "goal": s.goal, "prior": s.prior, "depth": s.depth, "level": s.level,
        "status": s.status, "summary": s.summary, "use_web": s.use_web, "archived": s.archived,
        "build": {"stage": s.build_stage, "progress": s.build_progress, "error": s.build_error},
        "progress": progress_of(concepts),
        "next_concept": {"id": nxt.id, "title": by_id[nxt.id].title} if nxt else None,
        "next_capstone": None,  # filled by _card (it needs the units)
        "due_count": sum(1 for c in concepts if _is_due(c)) if s.status in ("active", "complete") and not s.archived else 0,
        "capstone": _cap_view(s.capstone),
        "code_lang": s.code_lang, "shared_from": s.shared_from,
        "created_at": _iso(s.created_at), "updated_at": _iso(s.updated_at), "last_studied_at": _iso(s.last_studied_at),
    }


def _cap_view(cap: dict[str, Any] | None) -> dict[str, Any] | None:
    if not cap:
        return None
    return {k: cap.get(k) for k in ("status", "tries", "outcome", "met", "points", "at")}


async def _card(db: AsyncSession, s: StudySubject, concepts: list[StudyConcept]) -> dict[str, Any]:
    out = subject_card(s, concepts)
    out["next_capstone"] = await service.next_capstone(db, s, concepts)
    return out


def step_view(st: StudyStep) -> dict[str, Any]:
    key = st.payload.get("key", {})
    hints = key.get("hints") or []
    answered = st.status == "answered"
    placement = st.role == "placement"
    out: dict[str, Any] = {
        "id": str(st.id), "session_id": str(st.session_id), "concept_id": str(st.concept_id), "position": st.position,
        "kind": st.kind, "role": st.role, "status": st.status, "graded": st.kind != "explain",
        "public": steps.public_view(st.payload),
        "hints_shown": hints[: st.hints_used],
        "hints_left": 0 if placement or st.role == "test_out" else max(0, len(hints) - st.hints_used),
        "confidence": st.confidence, "answer": st.answer, "turns": st.turns, "asks": st.asks,
        "grade": None, "reveal": None,
        # A code task whose own answer failed its checks: answered, counted for nothing.
        "void": answered and st.kind != "explain" and not st.grade,
        "created_at": _iso(st.created_at), "answered_at": _iso(st.answered_at),
    }
    if st.kind == "teach_student":
        said = sum(1 for t in st.turns if t["role"] == "learner")
        over = said >= st.payload["public"]["max_turns"] or any(t.get("resolved") for t in st.turns)
        out["turns_left"] = 0 if over else st.payload["public"]["max_turns"] - said
    if answered and st.grade:
        g = st.grade
        out["grade"] = {"outcome": g["outcome"]} if placement else {
            "outcome": g["outcome"], "feedback_md": g.get("feedback_md", ""), "misconception": g.get("misconception"),
            "detail": g.get("detail") or {}, "gap_concept_id": g.get("gap_concept_id"),
        }
    if answered and not placement:
        out["reveal"] = steps.reveal_view(st.kind, st.payload)
    return out


def session_view(se: StudySession, steps_: list[StudyStep] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(se.id), "subject_id": str(se.subject_id), "kind": se.kind, "status": se.status,
        "started_at": _iso(se.started_at), "ended_at": _iso(se.ended_at), "summary": se.summary,
        "target_steps": rules.SESSION_STEPS if se.kind == "lesson" else len(se.plan.get("queue") or se.plan.get("probes") or []),
        "focus_concept_id": se.plan.get("focus"),
    }
    if steps_ is not None:
        out["steps"] = [step_view(s) for s in steps_]
    return out


async def _subject_full(db: AsyncSession, s: StudySubject) -> dict[str, Any]:
    concepts = await service.concepts_of(db, s.id)
    by_id = {str(c.id): c for c in concepts}
    units = list((await db.execute(select(StudyUnit).where(StudyUnit.subject_id == s.id).order_by(StudyUnit.position))).scalars())
    srcs = await service.sources_of(db, s.id)
    misc = list(
        (await db.execute(select(StudyMisconception).where(StudyMisconception.subject_id == s.id).order_by(StudyMisconception.last_seen_at.desc()))).scalars()
    )
    active = (
        await db.execute(
            select(StudySession).where(StudySession.subject_id == s.id, StudySession.status == "active", StudySession.kind != "review")
            .order_by(StudySession.started_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    out = await _card(db, s, concepts)
    out["units"] = [
        {
            "id": str(u.id), "position": u.position, "title": u.title, "summary": u.summary, "capstone": _cap_view(u.capstone),
            "concepts": [concept_view(c, by_id) for c in concepts if c.unit_id == u.id],
        }
        for u in units
    ]
    out["sources"] = [
        {"n": x.n, "kind": x.kind, "title": x.title, "url": x.url, "file_id": str(x.file_id) if x.file_id else None, "note_id": str(x.note_id) if x.note_id else None}
        for x in srcs
    ]
    out["misconceptions"] = [
        {"id": str(m.id), "concept_id": str(m.concept_id), "label": m.label, "detail": m.detail, "resolved": m.resolved, "last_seen_at": _iso(m.last_seen_at)}
        for m in misc
    ]
    out["active_session"] = session_view(active) if active else None
    return out


# ------------------------------------------------------------------ schemas


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RemindIn(_In):
    on: bool
    time: str = Field(default=reminders.DEFAULT_TIME, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class PrefsIn(_In):
    level: Literal["child", "teen", "adult"] | None = None
    remind: RemindIn | None = None


class ReviewIn(_In):
    subject_id: uuid.UUID | None = None


class SubjectIn(_In):
    title: str = Field(min_length=2, max_length=200)
    goal: str = Field(default="", max_length=1000)
    prior: str = Field(default="", max_length=1000)
    depth: Literal["overview", "solid", "deep"] = "solid"
    level: Literal["child", "teen", "adult"] | None = None
    use_web: bool = True
    file_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5)
    note_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)


class SubjectPatch(_In):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    archived: bool | None = None
    # Who it is pitched at; the next step written uses the new level.
    level: Literal["child", "teen", "adult"] | None = None


class ShareIn(_In):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=10)


class LessonIn(_In):
    concept_id: uuid.UUID | None = None
    test_out: bool = False


class AnswerIn(_In):
    answer: dict[str, Any] = Field(default_factory=dict)
    confidence: Literal[1, 2, 3] | None = None


class TurnIn(_In):
    text: str = Field(min_length=1, max_length=2000)


class AskIn(_In):
    mode: Literal["question", "simpler", "analogy", "example", "deeper"] = "question"
    question: str | None = Field(default=None, max_length=2000)


# -------------------------------------------------------------------- prefs


def _locked(user: User) -> str | None:
    """The level an admin has fixed for this person, if they have."""
    return user.study_level_lock if user.study_level_lock in LEVELS else None


def _level(user: User) -> str:
    return service.level_of(user)


def _level_locked() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "level_locked", "message": "Who Study is pitched at is set for your account. Ask an admin to change it."})


def _prefs(user: User) -> dict[str, Any]:
    return {
        "level": _level(user), "level_locked": _locked(user) is not None, "levels": list(LEVELS), "depths": list(DEPTHS),
        "remind": reminders.prefs(user),
    }


@router.get("/prefs")
async def get_prefs(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _prefs(user)


@router.put("/prefs")
async def put_prefs(body: PrefsIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    mine = dict((user.settings or {}).get("study") or {})
    if body.level is not None:
        if _locked(user) and body.level != _locked(user):
            raise _level_locked()
        mine["level"] = body.level
    if body.remind is not None:
        mine["remind"] = {"on": body.remind.on, "time": reminders.clock(body.remind.time)}
    user.settings = {**(user.settings or {}), "study": mine}
    await db.commit()
    return _prefs(user)


@router.get("/voice")
async def get_voice(user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Whether steps can be read aloud / answered by speaking here (the
    optional voice containers). The player hides voice when both are false."""
    from app.study import voice

    return await voice.available()


# ----------------------------------------------------------------- subjects


@router.get("/subjects")
async def list_subjects(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    await service.catch_up(db, user)
    subs = list(
        (await db.execute(select(StudySubject).where(StudySubject.user_id == user.id, StudySubject.trashed_at.is_(None)).order_by(StudySubject.updated_at.desc()))).scalars()
    )
    concepts: dict[uuid.UUID, list[StudyConcept]] = {s.id: [] for s in subs}
    if subs:
        for c in (await db.execute(select(StudyConcept).where(StudyConcept.subject_id.in_(list(concepts))).order_by(StudyConcept.position))).scalars():
            concepts[c.subject_id].append(c)
    cards = [await _card(db, s, concepts[s.id]) for s in subs]
    return {"subjects": cards, "due_total": sum(c["due_count"] for c in cards), "stats": await service.stats(db, user)}


@router.post("/subjects", status_code=201)
async def create_subject(
    body: SubjectIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    data = body.model_dump()
    data["level"] = _locked(user) or body.level or _level(user)
    try:
        await service._teacher(db, user)  # say so now, not from the background
        s = await service.create_subject(db, user, data)
    except service.StudyError as e:
        raise _http(e) from e
    service.start_build(s.id)
    return subject_card(s, [])


@router.get("/subjects/{subject_id:uuid}")
async def get_subject(subject_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return await _subject_full(db, await service.get_subject(db, user, subject_id))
    except service.StudyError as e:
        raise _http(e) from e


@router.get("/subjects/{subject_id:uuid}/build")
async def get_build(subject_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
    except service.StudyError as e:
        raise _http(e) from e
    return {"status": s.status, "stage": s.build_stage, "progress": s.build_progress, "error": s.build_error}


@router.post("/subjects/{subject_id:uuid}/retry")
async def retry_subject(
    subject_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    try:
        s = await service.get_subject(db, user, subject_id)
        await service.retry_build(db, s)
    except service.StudyError as e:
        raise _http(e) from e
    service.start_build(s.id)
    return subject_card(s, [])


@router.patch("/subjects/{subject_id:uuid}")
async def patch_subject(
    subject_id: uuid.UUID, body: SubjectPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
    except service.StudyError as e:
        raise _http(e) from e
    if body.title is not None:
        s.title = body.title.strip()
    if body.archived is not None:
        s.archived = body.archived
    if body.level is not None:
        if _locked(user) and body.level != _locked(user):
            raise _level_locked()
        s.level = body.level
    await db.commit()
    return await _subject_full(db, s)


@router.delete("/subjects/{subject_id:uuid}")
async def delete_subject(subject_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
    except service.StudyError as e:
        raise _http(e) from e
    await service.trash_subject(db, s)  # 30 days in the trash, then gone
    return {"ok": True, "trashed": True}


@router.post("/subjects/{subject_id:uuid}/share")
async def share_subject(
    subject_id: uuid.UUID, body: ShareIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Give a copy of this course to other people. Each gets their own
    subject (the map and the sources, none of your progress or answers) and
    is told. What you and they do afterwards stays separate."""
    try:
        s = await service.get_subject(db, user, subject_id)
        return await service.share_subject(db, user, s, body.user_ids)
    except service.StudyError as e:
        raise _http(e) from e


@router.get("/subjects/{subject_id:uuid}/report")
async def get_report(subject_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
    except service.StudyError as e:
        raise _http(e) from e
    return await report_view(db, s)


@router.post("/subjects/{subject_id:uuid}/report/suggest")
async def suggest_next(
    subject_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Ask (again) what to learn next. Only once the subject is finished."""
    await _quotas(request, user, db)
    try:
        s = await service.get_subject(db, user, subject_id)
        if s.status != "complete":
            raise service.StudyError("not_ready", "This comes once the subject is finished.", 409)
        return {"next": await service.suggest_next(db, user, s)}
    except service.StudyError as e:
        raise _http(e) from e


async def report_view(db: AsyncSession, s: StudySubject) -> dict[str, Any]:
    """The subject's report: what is known, what is shaky, what was added
    along the way, the tasks, the sources and what could come next. Worked
    out from the rows each time, so it is always current."""
    concepts = await service.concepts_of(db, s.id)
    by_id = {str(c.id): c for c in concepts}
    units = await service.units_of(db, s.id)
    misc = list((await db.execute(select(StudyMisconception).where(StudyMisconception.subject_id == s.id).order_by(StudyMisconception.last_seen_at.desc()))).scalars())
    open_misc: dict[str, list[str]] = {}
    for m in misc:
        if not m.resolved:
            open_misc.setdefault(str(m.concept_id), []).append(m.label)
    steps_n = (await db.execute(select(func.count(StudyStep.id)).where(StudyStep.subject_id == s.id, StudyStep.status == "answered"))).scalar_one()
    sessions_n = (await db.execute(select(func.count(StudySession.id)).where(StudySession.subject_id == s.id, StudySession.kind == "lesson"))).scalar_one()

    def shaky_why(c: StudyConcept) -> str | None:
        if c.state not in ("mastered", "known"):
            return "Still being learned"
        if str(c.id) in open_misc:
            return "A mix-up showed up here: " + open_misc[str(c.id)][0]
        if int((c.fsrs or {}).get("lapses") or 0) > 0:
            return "Slipped in a review"
        if c.mastery < 0.75:
            return "Only just over the line"
        return None

    def row(c: StudyConcept) -> dict[str, Any]:
        return {"id": str(c.id), "title": c.title, "summary": c.summary, "mastery": round(c.mastery, 3), "state": c.state, "mastered_at": _iso(c.mastered_at), "steps": c.steps_done}

    shaky = [{**row(c), "why": w} for c in concepts if (w := shaky_why(c))]
    shaky_ids = {x["id"] for x in shaky}
    srcs = await service.sources_of(db, s.id)
    return {
        "subject": subject_card(s, concepts),
        "finished": s.status == "complete",
        "totals": {"concepts": len(concepts), "known_before": sum(1 for c in concepts if c.state == "known"), "steps": int(steps_n), "lessons": int(sessions_n)},
        "units": [
            {"id": str(u.id), "title": u.title, "capstone": _cap_view(u.capstone),
             "solid": [row(c) for c in concepts if c.unit_id == u.id and str(c.id) not in shaky_ids]}
            for u in units
        ],
        "shaky": shaky,
        "added": [
            {**row(c), "reason": c.reason, "for": by_id[str(c.gap_for)].title if c.gap_for and str(c.gap_for) in by_id else None}
            for c in concepts if c.origin == "gap"
        ],
        "capstone": _cap_view(s.capstone),
        "sources": [{"n": x.n, "kind": x.kind, "title": x.title, "url": x.url} for x in srcs],
        "next": (s.report or {}).get("next") or [],
    }


# ---------------------------------------------------------------- placement


@router.post("/subjects/{subject_id:uuid}/placement")
async def start_placement(
    subject_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    try:
        s = await service.get_subject(db, user, subject_id)
        se = await service.start_placement(db, user, s)
        st = await service.next_step(db, user, se, s)
    except service.StudyError as e:
        raise _http(e) from e
    return {"session": session_view(se), "step": step_view(st) if st else None}


@router.post("/subjects/{subject_id:uuid}/placement/skip")
async def skip_placement(subject_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
        await service.skip_placement(db, s)
    except service.StudyError as e:
        raise _http(e) from e
    return await _subject_full(db, s)


# ------------------------------------------------------------------ reviews


@router.post("/reviews")
async def start_review(body: ReviewIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """A review sitting over what is due (one subject, or all of them in
    turn). Returns the one in progress if there is one. 409 ``nothing_due``."""
    try:
        se = await service.start_review(db, user, body.subject_id)
    except service.StudyError as e:
        raise _http(e) from e
    return {"session": session_view(se)}


# ----------------------------------------------------------------- sessions


@router.post("/subjects/{subject_id:uuid}/sessions")
async def start_lesson(
    subject_id: uuid.UUID, body: LessonIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    try:
        s = await service.get_subject(db, user, subject_id)
        se = await service.start_lesson(db, s, concept_id=body.concept_id, test_out=body.test_out)
    except service.StudyError as e:
        raise _http(e) from e
    return {"session": session_view(se)}


async def _session_steps(db: AsyncSession, session_id: uuid.UUID) -> list[StudyStep]:
    return list((await db.execute(select(StudyStep).where(StudyStep.session_id == session_id).order_by(StudyStep.position))).scalars())


@router.get("/sessions/{session_id:uuid}")
async def get_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        se, _s = await service.get_session(db, user, session_id)
    except service.StudyError as e:
        raise _http(e) from e
    return {"session": session_view(se, await _session_steps(db, se.id))}


@router.post("/sessions/{session_id:uuid}/next")
async def next_step(
    session_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """The step to show now. The same step again until it is answered. When
    the session is over: ``{"done": true}`` with the session's summary."""
    await _quotas(request, user, db)
    try:
        se, s = await service.get_session(db, user, session_id)
        st = await service.next_step(db, user, se, s)
    except service.StudyError as e:
        raise _http(e) from e
    await db.refresh(se)
    concept = None
    of = s
    if st is not None:
        # A review can be on a concept from another of the person's subjects.
        of = s if st.subject_id == s.id else await db.get(StudySubject, st.subject_id)
        by_id = {str(c.id): c for c in await service.concepts_of(db, st.subject_id)}
        concept = concept_view(by_id[str(st.concept_id)], by_id)
    return {
        "done": st is None, "step": step_view(st) if st else None, "concept": concept, "session": session_view(se),
        "subject_status": s.status, "subject": {"id": str(of.id), "title": of.title},
    }


@router.post("/sessions/{session_id:uuid}/end")
async def end_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        se, s = await service.get_session(db, user, session_id)
        if se.kind == "placement":
            raise service.StudyError("bad_step", "Finish the placement check, or skip it.", 409)
        await service.end_session(db, se, s)
    except service.StudyError as e:
        raise _http(e) from e
    return {"session": session_view(se)}


# -------------------------------------------------------------------- steps


@router.post("/steps/{step_id:uuid}/answer")
async def answer(
    step_id: uuid.UUID, body: AnswerIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    try:
        out = await service.answer_step(db, user, step_id, body.answer, body.confidence)
    except service.StudyError as e:
        raise _http(e) from e
    st: StudyStep = out["step"]
    by_id = {str(c.id): c for c in await service.concepts_of(db, st.subject_id)}
    s = await db.get(StudySubject, st.subject_id)
    return {
        "step": step_view(st), "changes": out["changes"],
        "concept": concept_view(by_id[str(st.concept_id)], by_id),
        "progress": progress_of(list(by_id.values())), "subject_status": s.status,
    }


@router.post("/steps/{step_id:uuid}/hint")
async def hint(step_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return await service.hint(db, user, step_id)
    except service.StudyError as e:
        raise _http(e) from e


@router.post("/steps/{step_id:uuid}/turn")
async def turn(
    step_id: uuid.UUID, body: TurnIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    try:
        st = await service.student_turn(db, user, step_id, body.text)
    except service.StudyError as e:
        raise _http(e) from e
    return {"step": step_view(st)}


@router.post("/steps/{step_id:uuid}/ask")
async def ask(
    step_id: uuid.UUID, body: AskIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    await _quotas(request, user, db)
    try:
        return await service.ask_teacher(db, user, step_id, body.mode, body.question)
    except service.StudyError as e:
        raise _http(e) from e


# -------------------------------------------------------------------- today


async def today_section(db: AsyncSession, user: User) -> dict[str, Any] | None:
    """The Today card: the subject studied last, how far along, what's next."""
    s = (
        await db.execute(
            select(StudySubject)
            .where(
                StudySubject.user_id == user.id, StudySubject.status.in_(("active", "placement")),
                StudySubject.archived.is_(False), StudySubject.trashed_at.is_(None),
            )
            .order_by(func.coalesce(StudySubject.last_studied_at, StudySubject.created_at).desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    due = len(await service.due_rows(db, user))
    if s is None:
        # Nothing being learned, but things learned earlier have come due.
        return {"subject_id": None, "title": None, "status": None, "progress": None, "next_concept": None, "next_capstone": None,
                "last_studied_at": None, "due_count": due} if due else None
    concepts = await service.concepts_of(db, s.id)
    card = await _card(db, s, concepts)
    return {
        "subject_id": card["id"], "title": card["title"], "status": card["status"], "progress": card["progress"],
        "next_concept": card["next_concept"], "next_capstone": card["next_capstone"], "last_studied_at": card["last_studied_at"],
        "due_count": due,
    }
