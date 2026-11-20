"""Study, phase 2: spaced reviews, the daily nudge, capstones and the report,
and the loose ends (trash, level lock, rate count, usage).

The rules first (pure), then the same scripted model and simulated learners
as ``test_study_learners.py``: a forgotten concept really does come back, a
weak capstone really does reopen what it showed to be weak.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from tests import study_kit as kit
from tests.test_study_api import API, H, client, lesson, mk_user, nxt, ready  # noqa: F401 — client is a fixture

UTC = timezone.utc


@pytest.fixture
def model(monkeypatch):
    return kit.install(monkeypatch)


# -------------------------------------------------------------------- rules


def test_what_a_review_answer_is_worth():
    from app.study import rules as r

    assert r.review_rating("wrong") == r.AGAIN
    assert r.review_rating("correct", dont_know=True) == r.AGAIN
    assert r.review_rating("partial", confidence=3) == r.HARD
    assert r.review_rating("correct", hints=1, confidence=3) == r.HARD  # needed a hint
    assert r.review_rating("correct", confidence=1) == r.HARD  # a guess
    assert r.review_rating("correct") == r.GOOD
    assert r.review_rating("correct", confidence=2) == r.GOOD
    assert r.review_rating("correct", confidence=3) == r.EASY
    assert r.first_rating("lesson") == r.GOOD and r.first_rating("known") == r.EASY and r.first_rating("test_out") == r.EASY


def test_a_review_is_never_the_same_kind_twice_running():
    from app.study import rules as r

    c = r.ConceptState(id="a", position=1, nature="principle")
    last = None
    kinds = []
    for reps in range(9):
        k = r.review_kind(c, reps, last)
        assert k != last and k != "predict"
        kinds.append(k)
        last = k
    assert kinds[2] == "explain_back" and kinds.count("explain_back") == 3  # every third time, in their own words
    assert set(kinds) - {"explain_back"} <= set(r.RECOGNITION)


def test_reviews_take_subjects_in_turn():
    from app.study import rules as r

    due = [("a1", "A"), ("a2", "A"), ("a3", "A"), ("b1", "B"), ("c1", "C")]
    assert r.interleave(due) == ["a1", "b1", "c1", "a2", "a3"]
    assert r.interleave(due, limit=2) == ["a1", "b1"]
    assert r.interleave([]) == []


def test_the_schedule_is_the_flashcards_engine():
    from app.items.kinds.flashcards import fsrs
    from app.study import reviews

    assert reviews.fsrs is fsrs
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    learned = reviews.first_card("c", "lesson", now, UTC)
    known = reviews.first_card("c", "known", now, UTC)
    assert learned["state"] == "review" and learned["reps"] == 1
    d1, d2 = reviews.days_until(learned, now, UTC), reviews.days_until(known, now, UTC)
    assert 1 <= d1 < d2  # something already known comes back later than something just learned
    later = now + timedelta(days=d1)
    assert reviews.days_until(learned, later, UTC) == 0
    good = reviews.rate(learned, "c", 3, later, UTC)
    again = reviews.rate(learned, "c", 1, later, UTC)
    assert reviews.days_until(good, later, UTC) > d1  # remembered: the gap grows
    assert reviews.days_until(again, later, UTC) < reviews.days_until(good, later, UTC) and again["lapses"] == 1
    # One that slipped and was learned again keeps its history.
    back = reviews.first_card("c", "lesson", later + timedelta(days=1), UTC, old=again)
    assert back["lapses"] == 1 and back["reps"] == 3


def test_what_a_capstone_answer_means():
    from app.study import rules as r

    assert r.capstone_outcome(4, 4) == "correct" and r.capstone_outcome(4, 3) == "correct"
    assert r.capstone_outcome(4, 2) == "partial" and r.capstone_outcome(5, 2) == "partial"
    assert r.capstone_outcome(4, 1) == "wrong" and r.capstone_outcome(0, 0) == "wrong"
    per = r.capstone_by_concept(["a", "a", "b", "c"], [0, 2])
    assert per == {"a": "partial", "b": "correct", "c": "wrong"}
    assert r.capstone_settled({"status": "passed"}) and r.capstone_settled({"status": "closed"})
    assert not r.capstone_settled({"status": "open"}) and not r.capstone_settled(None)
    cs = [r.ConceptState(id=str(i), position=i, mastery=m) for i, m in enumerate([0.9, 0.7, 0.8, 0.75, 0.95])]
    unit_of = {"0": "u1", "1": "u1", "2": "u2", "3": "u2", "4": "u3"}
    assert r.capstone_pick(cs, unit_of, limit=4) == ["1", "3", "4", "0"]  # the least solid of each unit first


def test_when_the_nudge_goes():
    from app.study import rules as r

    at = 17 * 60
    assert not r.nudge_due(at - 1, at, sent_today=False)
    assert r.nudge_due(at, at, sent_today=False) and r.nudge_due(at + 180, at, sent_today=False)
    assert not r.nudge_due(at + 181, at, sent_today=False)  # never hours late
    assert not r.nudge_due(at + 5, at, sent_today=True)  # once a day
    quiet = dict(due=0, lesson_open=False, studied_today=False, recent_subject=False)
    assert not r.nudge_wanted(**quiet)
    assert r.nudge_wanted(**{**quiet, "due": 2}) and r.nudge_wanted(**{**quiet, "lesson_open": True}) and r.nudge_wanted(**{**quiet, "recent_subject": True})
    assert not r.nudge_wanted(due=5, lesson_open=True, studied_today=True, recent_subject=True)  # they already did


def test_days_in_a_row():
    from app.study import rules as r

    assert r.streak([], 100) == 0
    assert r.streak([100], 100) == 1 and r.streak([98, 99, 100], 100) == 3
    assert r.streak([98, 99], 100) == 2  # today isn't over: yesterday's run still stands
    assert r.streak([97, 98], 100) == 0 and r.streak([96, 98, 99, 100], 100) == 3


# ------------------------------------------------------------------ reviews


async def concepts(db, subject):
    from app.study import service

    rows = await service.concepts_of(db, subject.id)
    for r in rows:
        await db.refresh(r)
    return rows


async def overdue(db, rows, days=1):
    """Move these concepts' reviews into the past, as if time had gone by."""
    now = datetime.now(UTC)
    for c in rows:
        await db.refresh(c)
        c.due_at = now - timedelta(days=days)
        c.fsrs = {**c.fsrs, "due": c.due_at.isoformat(), "last_review": (now - timedelta(days=days + 4)).isoformat()}
    await db.commit()


async def review_one(db, user, how, confidence=2):
    from app.study import service

    se = await service.start_review(db, user)
    st = await service.next_step(db, user, se, None)
    res = await kit.answer(db, user, st, how, confidence)
    return se, st, res


async def test_reviews_bring_a_forgotten_concept_back(db, user, model):
    from app.study import service

    s = await kit.make_subject(db, user)
    await kit.run_course(db, user, s, kit.strong)
    rows = await concepts(db, s)
    now = datetime.now(UTC)
    assert all(c.fsrs and c.fsrs["state"] == "review" and c.due_at > now for c in rows)  # everything learned is on a schedule
    assert await service.due_rows(db, user) == []
    with pytest.raises(service.StudyError) as e:
        await service.start_review(db, user)
    assert e.value.code == "nothing_due"

    c1 = rows[0]
    # Remembered: it goes further out.
    await overdue(db, [c1])
    se, st, res = await review_one(db, user, "good", 3)
    assert st.role == "review" and st.concept_id == c1.id and "spaced REVIEW" in model.calls[-1]["prompt"]
    assert "Already done on this concept" in model.calls[-1]["prompt"]  # so the question is a new one
    rv = next(c for c in res["changes"] if c["type"] == "review")
    assert rv["rating"] == 4 and rv["next_days"] >= 2
    assert await service.next_step(db, user, se, None) is None
    await db.refresh(se)
    assert se.status == "done" and se.summary == {"reviewed": 1, "remembered": 1, "slipped": 0, "reopened": [], "left": 0}
    first_kind = st.kind

    # Forgotten: it comes back sooner, and when it keeps slipping it is taught again.
    reopened = False
    kinds = [first_kind]
    for _ in range(4):
        await overdue(db, [c1])
        se, st, res = await review_one(db, user, "bad", 3)
        kinds.append(st.kind)
        rv = next(c for c in res["changes"] if c["type"] == "review")
        assert rv["rating"] == 1
        if any(c["type"] == "relearn" for c in res["changes"]):
            reopened = True
            break
        assert rv["next_days"] <= 2  # a slip: back within a day or two
    assert reopened
    assert all(a != b for a, b in zip(kinds, kinds[1:]))  # never the same kind of question twice running
    await db.refresh(c1)
    await db.refresh(s)
    assert c1.state == "learning" and c1.due_at is None and s.status == "active"
    assert await service.due_rows(db, user) == []

    out = await kit.run_course(db, user, s, kit.strong)
    assert out["complete"] and not [k for k in out["kinds"] if k[2] == "capstone"]  # the tasks were already done
    await db.refresh(c1)
    assert c1.state == "mastered" and c1.due_at > datetime.now(UTC) and c1.fsrs["lapses"] >= 1  # its history went with it


async def test_a_review_runs_over_every_subject_in_turn(client, db, model):
    from app.study import service
    from app.study.models import StudyStep, StudySubject

    u, other = await mk_user(db, "ana"), await mk_user(db, "ben")
    a = await db.get(StudySubject, uuid.UUID(await ready(client, db, u, title="Tides")))
    b = await db.get(StudySubject, uuid.UUID(await ready(client, db, u, title="Knots")))
    for s in (a, b):
        await kit.run_course(db, u, s, kit.strong)
    assert (await client.post(f"{API}/reviews", json={}, headers=H(u))).json()["detail"]["code"] == "nothing_due"
    await overdue(db, (await concepts(db, a))[:2] + (await concepts(db, b))[:2])

    home = (await client.get(f"{API}/subjects", headers=H(u))).json()
    assert home["due_total"] == 4 and sorted(c["due_count"] for c in home["subjects"]) == [2, 2]
    full = (await client.get(f"{API}/subjects/{a.id}", headers=H(u))).json()
    assert [c["due"] for c in full["units"][0]["concepts"]] == [True, True, False]

    r = await client.post(f"{API}/reviews", json={}, headers=H(u))
    assert r.status_code == 200, r.text
    se = r.json()["session"]
    assert se["kind"] == "review" and se["target_steps"] == 4
    assert (await client.post(f"{API}/reviews", json={}, headers=H(u))).json()["session"]["id"] == se["id"]  # the one in progress
    assert (await client.post(f"{API}/sessions/{se['id']}/next", headers=H(other))).status_code == 404
    seen = []
    for _ in range(2):
        out = await nxt(client, u, se["id"])
        seen.append(out["subject"]["title"])
        assert out["step"]["role"] == "review" and out["concept"]["due"] is True
        row = await db.get(StudyStep, uuid.UUID(out["step"]["id"]))
        ans = await client.post(f"{API}/steps/{row.id}/answer", json={"answer": kit.answer_for(row, "good"), "confidence": 2}, headers=H(u))
        assert ans.status_code == 200, ans.text
        assert [c["rating"] for c in ans.json()["changes"] if c["type"] == "review"] == [3]
        assert ans.json()["concept"]["due"] is False
    assert sorted(seen) == ["Knots", "Tides"]  # one from each, not two from the same
    ended = (await client.post(f"{API}/sessions/{se['id']}/end", headers=H(u))).json()["session"]
    assert ended["summary"]["reviewed"] == 2 and ended["summary"]["left"] == 2

    # One subject's reviews only.
    one = (await client.post(f"{API}/reviews", json={"subject_id": str(b.id)}, headers=H(u))).json()["session"]
    assert one["target_steps"] == 1 and (await nxt(client, u, one["id"]))["subject"]["title"] == "Knots"
    assert (await client.post(f"{API}/reviews", json={"subject_id": str(a.id)}, headers=H(other))).status_code == 404
    assert len(await service.due_rows(db, u)) == 2

    from app.study.router import today_section

    assert (await today_section(db, u))["due_count"] == 2  # both subjects are finished; the card is there for the reviews
    stats = (await client.get(f"{API}/subjects", headers=H(u))).json()["stats"]
    assert stats == {"today": True, "week": 1, "streak": 1, "total": 1}


# ------------------------------------------------------------------- nudges


async def test_the_daily_nudge(db, user, model, monkeypatch):
    from app.notifications import dispatch
    from app.study import reminders, service
    from app.study.models import StudyDay

    sent = []

    async def notify(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", notify)

    async def settings(**study):
        user.settings = {"timezone": "Australia/Sydney", "study": study}
        await db.commit()

    # 17:05 in Sydney (UTC+11 in November) is 06:05 UTC.
    day1 = datetime(2026, 11, 20, 6, 5, tzinfo=UTC)
    await settings(remind={"on": True, "time": "17:00"})
    assert await reminders.send_due(db, day1) == 0 and not sent  # nothing to study: quiet

    s = await kit.make_subject(db, user)
    assert await reminders.send_due(db, day1 - timedelta(minutes=6)) == 0  # 16:59: not yet
    assert await reminders.send_due(db, day1) == 1
    assert sent[-1]["category"] == "item_reminder" and sent[-1]["user_id"] == user.id
    assert sent[-1]["title"] == "Carry on with Tides" and sent[-1]["body"] == "Next: Concept 1"
    assert sent[-1]["url"] == f"/study/{s.id}/continue"
    assert await reminders.send_due(db, day1 + timedelta(minutes=20)) == 0  # once a day
    await db.refresh(user)
    assert user.settings["study_nudge_sent"] == "2026-11-20" and user.settings["study"]["remind"]["on"] is True

    day2 = day1 + timedelta(days=1)
    assert await reminders.send_due(db, day2 + timedelta(hours=3, minutes=5)) == 0  # 20:10: too late, never at night
    db.add(StudyDay(user_id=user.id, day=datetime(2026, 11, 21).date(), steps=3))
    await db.commit()
    assert await reminders.send_due(db, day2) == 0  # they've already studied today (their date, not UTC's)

    # Something learned has come due: that is what it says, and where it opens.
    day3 = day2 + timedelta(days=1)
    c = (await service.concepts_of(db, s.id))[0]
    c.state, c.mastery, c.due_at, c.fsrs = "mastered", 0.9, day3 - timedelta(hours=2), {"due": (day3 - timedelta(hours=2)).isoformat(), "reps": 1}
    await db.commit()
    assert await reminders.send_due(db, day3) == 1
    assert sent[-1]["title"] == "1 idea to review" and sent[-1]["url"] == "/study/review" and "Tides" in sent[-1]["body"]

    day4 = day3 + timedelta(days=1)
    await db.refresh(user)
    await settings(remind={"on": False, "time": "17:00"})
    assert await reminders.send_due(db, day4) == 0  # off
    assert len(sent) == 2


async def test_reminder_settings_over_the_api(client, db, model):
    u = await mk_user(db, "ana")
    p = (await client.get(f"{API}/prefs", headers=H(u))).json()
    assert p["remind"] == {"on": False, "time": "17:00"} and p["level_locked"] is False
    r = await client.put(f"{API}/prefs", json={"remind": {"on": True, "time": "07:30"}}, headers=H(u))
    assert r.status_code == 200 and r.json()["remind"] == {"on": True, "time": "07:30"} and r.json()["level"] == "adult"
    assert (await client.put(f"{API}/prefs", json={"remind": {"on": True, "time": "25:00"}}, headers=H(u))).status_code == 422
    r = await client.put(f"{API}/prefs", json={"level": "teen"}, headers=H(u))
    assert r.json()["level"] == "teen" and r.json()["remind"]["time"] == "07:30"  # one doesn't undo the other


# ---------------------------------------------------------------- capstones


async def test_a_course_ends_with_its_tasks_and_a_report(client, db, model):
    from app.study import service
    from app.study.models import StudySession, StudySubject

    u, other = await mk_user(db, "ana"), await mk_user(db, "ben")
    sid = await ready(client, db, u)
    s = await db.get(StudySubject, uuid.UUID(sid))
    r = (await client.get(f"{API}/subjects/{sid}/report", headers=H(u))).json()
    assert r["finished"] is False and r["next"] == [] and r["totals"]["concepts"] == 6
    assert (await client.post(f"{API}/subjects/{sid}/report/suggest", headers=H(u))).json()["detail"]["code"] == "not_ready"

    out = await kit.run_course(db, u, s, kit.strong)
    caps = [c for c in out["changes"] if c["type"] == "capstone"]
    assert [(c["scope"], c["outcome"], c["status"]) for c in caps] == [("unit", "correct", "passed"), ("unit", "correct", "passed"), ("final", "correct", "passed")]
    assert out["changes"][-1] == {"type": "subject_complete"}  # only after the final task
    units = await service.units_of(db, s.id)
    await db.refresh(s)
    assert all(x.capstone["status"] == "passed" and x.capstone["tries"] == 1 for x in units) and s.capstone["status"] == "passed"
    summaries = [x.summary for x in (await db.execute(select(StudySession).where(StudySession.subject_id == s.id).order_by(StudySession.started_at))).scalars()]
    assert sum(len(x["capstones"]) for x in summaries) == 3 and summaries[-1]["subject_complete"] is True

    full = (await client.get(f"{API}/subjects/{sid}", headers=H(u))).json()
    assert full["status"] == "complete" and full["capstone"]["status"] == "passed" and full["units"][0]["capstone"]["points"] == 3
    r = (await client.get(f"{API}/subjects/{sid}/report", headers=H(u))).json()
    assert r["finished"] is True and r["shaky"] == [] and r["added"] == []
    assert [len(x["solid"]) for x in r["units"]] == [3, 3] and r["capstone"]["status"] == "passed"
    assert [n["title"] for n in r["next"]] == ["Ocean currents", "Reading charts"]  # asked for once, when it finished
    assert r["totals"]["steps"] == out["steps"] and r["totals"]["lessons"] == out["sessions"]
    assert (await client.get(f"{API}/subjects/{sid}/report", headers=H(other))).status_code == 404
    again = await client.post(f"{API}/subjects/{sid}/report/suggest", headers=H(u))
    assert again.status_code == 200 and len(again.json()["next"]) == 2


async def test_a_weak_capstone_reopens_what_it_showed_to_be_weak(db, user, model):
    from app.study import service

    s = await kit.make_subject(db, user)
    tries = {"n": 0}

    def learner(step, concept, n):
        if step.role == "capstone":
            tries["n"] += 1
            return ("last", 2) if tries["n"] == 1 else ("good", 3)  # the first task: only one of its three points
        return "good", 3

    out = await kit.run_course(db, user, s, learner)
    assert out["complete"]
    caps = [c for c in out["changes"] if c["type"] == "capstone"]
    first = caps[0]
    assert first["outcome"] == "wrong" and first["status"] == "open" and len(first["reopened"]) == 2
    i = out["changes"].index(first)
    assert [c["type"] for c in out["changes"][i - 5 : i]].count("relearn") == 2  # the two ideas whose points were missing
    # Those two were taught again before the task came back, and it wasn't asked twice in one lesson.
    roles = [k[2] for k in out["kinds"]]
    at = roles.index("capstone")
    again = roles.index("capstone", at + 1)
    between = out["kinds"][at + 1 : again]
    assert len([k for k in between if k[2] == ""]) >= 2 and {k[0] for k in between if k[2] == ""} >= set(first["reopened"])
    units = await service.units_of(db, s.id)
    assert units[0].capstone["status"] == "passed" and units[0].capstone["tries"] == 2
    assert [c["status"] for c in caps] == ["open", "passed", "passed", "passed"]


async def test_a_capstone_that_never_passes_is_closed_and_the_course_moves_on(db, user, model):
    from app.study import rules, service

    s = await kit.make_subject(db, user)

    def learner(step, concept, n):
        return ("half", 2) if step.role == "capstone" else ("good", 3)

    out = await kit.run_course(db, user, s, learner, max_steps=600)
    assert out["complete"]
    units = await service.units_of(db, s.id)
    await db.refresh(s)
    assert all(u.capstone["status"] == "closed" and u.capstone["tries"] == rules.CAPSTONE_TRIES for u in units)
    assert s.capstone["status"] == "closed" and s.capstone["outcome"] == "partial"


async def test_i_dont_know_on_a_capstone(client, db, model):
    from app.study.models import StudyStep, StudySubject

    u = await mk_user(db, "ana")
    sid = await ready(client, db, u)
    s = await db.get(StudySubject, uuid.UUID(sid))
    # Play until the first capstone is the step waiting.
    se = await lesson(client, u, sid)
    step = None
    for _ in range(40):
        out = await nxt(client, u, se)
        if out["done"]:
            se = await lesson(client, u, sid)
            continue
        step = out["step"]
        if step["kind"] == "capstone":
            break
        row = await db.get(StudyStep, uuid.UUID(step["id"]))
        if row.kind == "teach_student":
            await client.post(f"{API}/steps/{row.id}/turn", json={"text": "GOOD: the moon pulls."}, headers=H(u))
        await client.post(f"{API}/steps/{row.id}/answer", json={"answer": kit.answer_for(row, "good"), "confidence": 3}, headers=H(u))
    assert step["kind"] == "capstone" and step["role"] == "capstone" and step["hints_left"] == 0
    pub = step["public"]
    assert pub["scope"] == "unit" and pub["title"] == "Unit 1" and len(pub["concepts"]) == 3 and "rubric" not in str(pub)
    r = await client.post(f"{API}/steps/{step['id']}/answer", json={"answer": {"dont_know": True}}, headers=H(u))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["step"]["grade"]["outcome"] == "wrong" and len(body["step"]["reveal"]["rubric"]) == 3
    assert len(body["step"]["reveal"]["rubric_concepts"]) == 3
    assert [c["type"] for c in body["changes"]].count("relearn") == 3 and body["subject_status"] == "active"
    await db.refresh(s)
    card = (await client.get(f"{API}/subjects/{sid}", headers=H(u))).json()
    assert card["units"][0]["capstone"]["status"] == "open" and card["progress"]["done"] == 0


async def test_the_card_says_when_a_task_is_next(db, user, model):
    from app.study import service
    from app.study.router import _card

    s = await kit.make_subject(db, user)
    rows = await service.concepts_of(db, s.id)
    assert (await _card(db, s, rows))["next_capstone"] is None
    units = await service.units_of(db, s.id)
    for c in rows:
        if c.unit_id == units[0].id:
            c.state, c.mastery = "mastered", 0.9
    await db.commit()
    card = await _card(db, s, await service.concepts_of(db, s.id))
    assert card["next_capstone"] == {"scope": "unit", "unit_id": str(units[0].id), "title": "Unit 1"}


# --------------------------------------------------------------- loose ends


async def test_an_admin_can_fix_the_level_but_sees_nothing(client, db, model):
    admin, u, free = await mk_user(db, "root", role="admin"), await mk_user(db, "kid"), await mk_user(db, "ana")
    r = await client.patch(f"/api/admin/users/{u.id}", json={"study_level_lock": "child"}, headers=H(admin))
    assert r.status_code == 200, r.text
    assert r.json()["study_level_lock"] == "child"
    assert (await client.patch(f"/api/admin/users/{u.id}", json={"study_level_lock": "child"}, headers=H(u))).status_code == 403
    await db.refresh(u)
    p = (await client.get(f"{API}/prefs", headers=H(u))).json()
    assert p["level"] == "child" and p["level_locked"] is True
    r = await client.put(f"{API}/prefs", json={"level": "adult"}, headers=H(u))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "level_locked"
    sid = await ready(client, db, u, level="adult")  # asked for adult: gets what the admin set
    assert (await client.get(f"{API}/subjects/{sid}", headers=H(u))).json()["level"] == "child"
    assert "child of about 8 to 11" in model.calls[0]["system"]
    r = await client.patch(f"{API}/subjects/{sid}", json={"level": "teen"}, headers=H(u))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "level_locked"
    assert (await client.patch(f"{API}/subjects/{sid}", json={"title": "Sea tides"}, headers=H(u))).status_code == 200  # the rest still works
    # The admin set the band; the subject itself is still not theirs to see.
    assert (await client.get(f"{API}/subjects/{sid}", headers=H(admin))).status_code == 404
    assert (await client.get(f"{API}/subjects/{sid}/report", headers=H(admin))).status_code == 404

    r = await client.patch(f"/api/admin/users/{u.id}", json={"study_level_lock": None}, headers=H(admin))
    assert r.status_code == 200 and r.json()["study_level_lock"] is None
    await db.refresh(u)
    assert (await client.patch(f"{API}/subjects/{sid}", json={"level": "teen"}, headers=H(u))).json()["level"] == "teen"

    # Someone with no lock changes a subject's level freely; the next step is pitched at it.
    mine = await ready(client, db, free)
    r = await client.patch(f"{API}/subjects/{mine}", json={"level": "teen"}, headers=H(free))
    assert r.status_code == 200 and r.json()["level"] == "teen"
    await nxt(client, free, await lesson(client, free, mine))
    assert "teenager of about 12 to 16" in model.calls[-1]["system"]
    assert (await client.patch(f"{API}/subjects/{mine}", json={"level": "toddler"}, headers=H(free))).status_code == 422


async def test_study_has_its_own_rate_count(client, db, model, monkeypatch):
    from limits import parse

    from app import rate_limit

    assert rate_limit._settings.RATE_LIMIT_STUDY_STEPS == "300/5 minutes"  # a lesson spends 15 to 25
    u = await mk_user(db, "ana")
    sid = await ready(client, db, u)
    se = await lesson(client, u, sid)
    monkeypatch.setattr(rate_limit, "_LIMIT_STUDY_STEPS", parse("2/minute"))
    rate_limit._settings.RATE_LIMIT_ENABLED = True
    try:
        codes = [(await client.post(f"{API}/sessions/{se}/next", headers=H(u))) for _ in range(3)]
        assert [r.status_code for r in codes] == [200, 200, 429]
        assert "Retry-After" in codes[2].headers and "short break" in codes[2].json()["detail"]
        # Chat's own count is untouched by a lesson: a message still goes.
        await rate_limit.enforce_user_message_rate(None, u)
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = False


async def test_studys_model_calls_count_as_the_learners_usage(db, user, monkeypatch):
    from app.billing.usage_context import bill_usage_to, billed_user
    from app.models_config import provider as providers
    from app.study import ai

    seen = []

    async def stream_chat(**kw):
        seen.append(billed_user())  # who the provider wrapper would bill
        yield '{"ok": true}'

    monkeypatch.setattr(providers.model_router, "stream_chat", stream_chat)
    bill_usage_to(None)  # as in a background build: no request said who
    out = await ai.raw_call(ai.Teacher(None, "m", user), "plan", system="s", messages=[{"role": "user", "content": "x"}], max_tokens=10)
    assert out == '{"ok": true}' and seen == [user.id]
