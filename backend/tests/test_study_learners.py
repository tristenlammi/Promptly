"""Simulated learners: the course really does change with the learner.

The same six-concept subject, the same scripted model, three learners:

* a **strong** one gets through in few steps, and fewer still after a
  placement check that shows they know it;
* a **weak** one, who misses twice on every concept, is given more
  explanation and more practice, and still finishes;
* one with a **fixed wrong idea** on one concept gets a new concept added to
  the map for it, has to learn that first, and is told why.

No answer the model gives decides any of that: the fake model only writes
steps and grades by a keyword; the rules do the rest.
"""
from __future__ import annotations

import pytest

from tests import study_kit as kit


@pytest.fixture
def model(monkeypatch):
    return kit.install(monkeypatch)


async def concepts(db, subject):
    from app.study import service

    rows = await service.concepts_of(db, subject.id)
    for r in rows:
        await db.refresh(r)
    return rows


async def test_strong_learner_is_quick(db, user, model):
    s = await kit.make_subject(db, user)
    out = await kit.run_course(db, user, s, kit.strong)
    assert out["complete"]
    rows = await concepts(db, s)
    assert all(c.state == "mastered" and c.mastery >= 0.7 for c in rows)
    teaching = [k for k in out["kinds"] if k[2] != "recall"]
    assert len(teaching) == 3 * len(rows)  # explain, a check, their own words
    assert not [c for c in out["changes"] if c["type"] == "gap_added"]
    assert any(k[2] == "recall" for k in out["kinds"])  # earlier ideas came back


async def test_placement_shortens_the_course_for_someone_who_knows_it(db, user, model):
    cold = await kit.make_subject(db, user)
    cold_run = await kit.run_course(db, user, cold, kit.strong)

    placed = await kit.make_subject(db, user, placement="all")
    rows = await concepts(db, placed)
    known = [c for c in rows if c.state == "known"]
    likely = [c for c in rows if c.state == "new" and c.mastery >= 0.6]
    assert known and len(known) + len(likely) == len(rows)
    run = await kit.run_course(db, user, placed, kit.strong)
    assert run["complete"]
    assert run["steps"] < cold_run["steps"] / 2
    assert not [k for k in run["kinds"] if k[1] == "explain"]  # nothing they know is explained
    # Each "likely known" concept took exactly one answer in their own words.
    assert len([k for k in run["kinds"] if k[2] == ""]) == len(likely)


async def test_placement_changes_nothing_for_a_beginner(db, user, model):
    s = await kit.make_subject(db, user, placement="none")
    rows = await concepts(db, s)
    assert s.status == "active" and all(c.state == "new" and c.mastery == 0 for c in rows)


async def test_weak_learner_gets_more_and_still_finishes(db, user, model):
    strong_s = await kit.make_subject(db, user)
    strong_run = await kit.run_course(db, user, strong_s, kit.strong)

    s = await kit.make_subject(db, user)
    out = await kit.run_course(db, user, s, kit.weak)
    assert out["complete"]
    assert out["steps"] > 2 * strong_run["steps"]
    assert out["sessions"] > strong_run["sessions"]
    first = [k for k in out["kinds"] if k[0] == "Concept 1" and k[2] == ""]
    explains = [k for k in first if k[1] == "explain"]
    assert len(explains) == 3  # explained again, each time after a miss
    # Every explanation after a miss took a different angle.
    from app.study import service
    from app.study.models import StudyStep
    from sqlalchemy import select

    rows = await concepts(db, s)
    c1 = rows[0]
    steps_ = (await db.execute(select(StudyStep).where(StudyStep.concept_id == c1.id, StudyStep.kind == "explain").order_by(StudyStep.created_at))).scalars().all()
    assert [x.payload["public"]["angle"] for x in steps_] == ["plain", "analogy", "example"]
    assert await service.concepts_of(db, s.id)


async def test_a_fixed_wrong_idea_adds_a_concept_for_the_gap(db, user, model):
    def learner(step, concept, n):
        if concept.title == "Concept 3" and n == 0:
            return "misc", 3  # sure, and wrong in the telling way
        return "good", 3

    s = await kit.make_subject(db, user)
    out = await kit.run_course(db, user, s, learner)
    assert out["complete"]
    added = [c for c in out["changes"] if c["type"] == "gap_added"]
    assert len(added) == 1 and added[0]["reason"]

    rows = await concepts(db, s)
    by_title = {c.title: c for c in rows}
    gap = next(c for c in rows if c.origin == "gap")
    target = by_title["Concept 3"]
    assert gap.gap_for == target.id and gap.reason == added[0]["reason"]
    assert str(gap.id) in target.prereqs
    assert by_title["Concept 2"].position < gap.position < target.position
    assert gap.unit_id == target.unit_id
    assert len(rows) == 7 and model.tasks().count("gap") == 1

    # The gap was taught before the course went back to the concept it was for.
    order = [k[0] for k in out["kinds"] if k[2] == ""]
    first_gap = order.index(gap.title)
    last_gap = len(order) - 1 - order[::-1].index(gap.title)
    c3 = [i for i, t in enumerate(order) if t == "Concept 3"]
    assert c3[0] < first_gap and all(i < first_gap or i > last_gap for i in c3) and c3[-1] > last_gap
    assert gap.state == "mastered" and target.state == "mastered"

    # The wrong idea was recorded against the concept, and cleared once learned.
    from app.study.models import StudyMisconception
    from sqlalchemy import select

    m = (await db.execute(select(StudyMisconception).where(StudyMisconception.concept_id == target.id))).scalars().all()
    assert len(m) == 1 and m[0].label == kit.MISC and m[0].resolved


async def test_gaps_are_capped_per_concept(db, user, model):
    """Someone who never gets Concept 1 gets its two gap concepts, no more."""
    def learner(step, concept, n):
        return ("bad", 2) if concept.title == "Concept 1" else ("good", 3)

    s = await kit.make_subject(db, user)
    out = await kit.run_course(db, user, s, learner, max_steps=60)
    assert not out["complete"]
    rows = await concepts(db, s)
    from app.study import rules

    assert len([c for c in rows if c.origin == "gap"]) == rules.MAX_GAPS_PER_CONCEPT
    assert out["sessions"] > 1  # parked, the lesson ended, they came back


async def test_a_gap_that_is_already_on_the_map_is_not_added(db, user, model):
    model.gap_title = "concept 2"  # the model proposes something that is there already

    def learner(step, concept, n):
        return ("misc", 3) if concept.title == "Concept 3" and n == 0 else ("good", 3)

    s = await kit.make_subject(db, user)
    out = await kit.run_course(db, user, s, learner)
    assert out["complete"] and not [c for c in out["changes"] if c["type"] == "gap_added"]
    assert len(await concepts(db, s)) == 6


async def test_test_out_masters_a_concept_in_one_step(db, user, model):
    from app.study import service

    s = await kit.make_subject(db, user)
    rows = await concepts(db, s)
    se = await service.start_lesson(db, s, concept_id=rows[0].id, test_out=True)
    st = await service.next_step(db, user, se, s)
    assert st.role == "test_out" and st.kind == "scenario"
    res = await kit.answer(db, user, st, "good", 3)
    assert {"type": "mastered", "concept_id": str(rows[0].id), "title": "Concept 1", "by": "test_out"} in res["changes"]

    # Failing a test-out costs nothing but teaches from there.
    se = await service.start_lesson(db, s, concept_id=rows[1].id, test_out=True)
    st = await service.next_step(db, user, se, s)
    await kit.answer(db, user, st, "bad", 2)
    nxt = await service.next_step(db, user, se, s)
    assert nxt.concept_id == rows[1].id and nxt.kind == "explain" and nxt.role == ""
