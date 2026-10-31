"""The Habits item (kind ``habits``): the model, the streak / rate / score
engine for every schedule type, the day boundary, skips, every action,
to_text, reminders, the AI tool schemas and one end-to-end API flow."""
from __future__ import annotations

import json
import math
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.habits import SPEC
from app.items.kinds.habits import engine as E
from app.items.kinds.habits.models import HabitsData
from app.items.kinds.habits.reminders import reminders
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Europe/London")
TODAY = date(2026, 6, 17)  # a Wednesday
assert TODAY.weekday() == 2


def D(s: str) -> date:
    return date.fromisoformat(s)


def habit(hid="h", *, type="yes_no", kind="daily", start="2026-06-01", logs=None, **kw) -> dict:
    """A validated habit. ``logs``: {day: value | "s" (skipped)}."""
    sched = {"kind": kind}
    for k in ("days", "times", "every"):
        if k in kw:
            sched[k] = kw.pop(k)
    raw_logs = []
    for day, v in (logs or {}).items():
        if v == "s":
            raw_logs.append({"day": day, "value": 0, "skipped": True, "reason": "sick"})
        else:
            raw_logs.append({"day": day, "value": v})
    raw = {"id": hid, "name": kw.pop("name", hid.title()), "type": type, "schedule": sched, "start_date": start, "logs": raw_logs, **kw}
    return HabitsData.model_validate({"habits": [raw]}).model_dump(mode="json")["habits"][0]


def span(a: str, b: str, v=1) -> dict:
    return {d.isoformat(): v for d in E.days(D(a), D(b))}


def ctx_at(now: datetime) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


NOW = datetime(2026, 6, 17, 8, 0, tzinfo=TZ)


def data_with(*habits, **settings) -> dict:
    return HabitsData.model_validate({"habits": list(habits), "settings": settings}).model_dump(mode="json")


async def act(data: dict, name: str, args: dict | None = None, now: datetime = NOW):
    from app.items.service import run_action

    out = await run_action(ctx_at(now), SPEC, data, name, args or {})
    # Every write must leave a valid file.
    clean = SPEC.validate(data)
    data.clear()
    data.update(clean)
    return out


# ------------------------------------------------------------------ model


def test_template_and_defaults():
    t = SPEC.template(ctx_at(NOW))
    assert SPEC.validate(t) == t
    assert t["habits"] == [] and t["settings"]["day_ends_at"] == 0 and t["settings"]["onboarded"] is False
    assert "Health" in t["settings"]["areas"]
    # Old / partial files load.
    assert SPEC.validate({})["settings"]["week_start"] == 0
    h = SPEC.validate({"habits": [{"id": "a", "name": "A"}]})["habits"][0]
    assert h["type"] == "yes_no" and h["schedule"]["kind"] == "daily" and h["logs"] == []


def test_model_normalises_and_refuses():
    d = SPEC.validate(
        {
            "habits": [
                {
                    "id": "a",
                    "name": "A",
                    "target": 5,
                    "schedule": {"kind": "weekdays", "days": [4, 0, 0, 9]},
                    "reminders": ["09:00", "07:30", "09:00"],
                    "logs": [{"day": "2026-06-02", "value": 1}, {"day": "2026-06-01"}, {"day": "2026-06-02", "value": 0, "note": "later wins"}],
                }
            ]
        }
    )
    h = d["habits"][0]
    assert h["target"] == 1  # yes/no is always 1
    assert h["schedule"]["days"] == [0, 4]
    assert h["reminders"] == ["07:30", "09:00"]
    assert [x["day"] for x in h["logs"]] == ["2026-06-01", "2026-06-02"] and h["logs"][1]["note"] == "later wins"
    assert SPEC.validate({"habits": [{"id": "a", "name": "A", "schedule": {"kind": "weekdays", "days": []}}]})["habits"][0]["schedule"]["kind"] == "daily"
    with pytest.raises(ValidationError):
        SPEC.validate({"habits": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"habits": [{"id": "a", "name": "A", "reminders": ["25:00"]}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"habits": [{"id": "a", "name": "A", "color": "red"}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"settings": {"day_ends_at": 9}})


# ------------------------------------------------------------- day-based


def test_daily_streaks_today_pending_never_breaks():
    logs = {**span("2026-06-01", "2026-06-05"), **span("2026-06-07", "2026-06-09"), **span("2026-06-14", "2026-06-16")}
    h = habit(logs=logs)
    cur, best = E.streaks(E.unit_statuses(h, TODAY))
    assert (cur, best) == (3, 5)
    assert E.day_statuses(h, TODAY)[-1] == (TODAY, E.PENDING)
    # Done today → it counts.
    h = habit(logs={**logs, "2026-06-17": 1})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (4, 5)
    # Yesterday missed → broken.
    h = habit(logs=span("2026-06-01", "2026-06-15"))
    assert E.streaks(E.unit_statuses(h, TODAY)) == (0, 15)


def test_skipped_days_are_neutral():
    h = habit(start="2026-06-10", logs={**span("2026-06-10", "2026-06-11"), "2026-06-12": "s", **span("2026-06-13", "2026-06-16")})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (6, 6)
    assert E.completion_rate(h, TODAY, None) == 1.0
    # A skipped today isn't pending, and doesn't break either.
    h = habit(start="2026-06-14", logs={**span("2026-06-14", "2026-06-16"), "2026-06-17": "s"})
    assert E.day_statuses(h, TODAY)[-1][1] == E.SKIPPED
    assert E.streaks(E.unit_statuses(h, TODAY)) == (3, 3)


def test_weekday_schedule_off_days_dont_break():
    # Mon / Wed / Fri from Mon 1 June; Wed 3 June missed; a Tuesday log is a bonus.
    done = ["2026-06-01", "2026-06-05", "2026-06-08", "2026-06-10", "2026-06-12", "2026-06-15", "2026-06-02"]
    h = habit(kind="weekdays", days=[0, 2, 4], logs={d: 1 for d in done})
    sts = dict(E.day_statuses(h, TODAY))
    assert sts[D("2026-06-02")] == E.OFF and sts[D("2026-06-03")] == E.MISSED and sts[TODAY] == E.PENDING
    assert E.streaks(E.unit_statuses(h, TODAY)) == (5, 5)
    assert E.completion_rate(h, TODAY, None) == round(6 / 7, 4)
    wk = {r["weekday"]: r for r in E.weekday_breakdown(h, TODAY)}
    assert wk["Wed"]["done"] == 1 and wk["Wed"]["total"] == 2 and wk["Tue"]["total"] == 0 and wk["Mon"]["rate"] == 1.0


def test_every_n_days_counts_from_the_start():
    h = habit(kind="every_n_days", every=3, start="2026-06-02", logs={d: 1 for d in ["2026-06-02", "2026-06-05", "2026-06-08", "2026-06-11", "2026-06-14"]})
    start = E.start_of(h)
    assert E.is_due(h, D("2026-06-05"), start) and not E.is_due(h, D("2026-06-06"), start) and E.is_due(h, TODAY, start)
    assert E.streaks(E.unit_statuses(h, TODAY)) == (5, 5)
    h = habit(kind="every_n_days", every=3, start="2026-06-02", logs={d: 1 for d in ["2026-06-02", "2026-06-08", "2026-06-11"]})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (0, 2)  # 14 June missed


# --------------------------------------------------------- period-based


def test_per_week_counts_weeks_and_the_current_week_is_pending():
    w1 = ["2026-06-01", "2026-06-03", "2026-06-05"]
    w2_short = ["2026-06-09", "2026-06-11"]
    w3 = ["2026-06-15", "2026-06-16"]
    h = habit(kind="per_week", times=3, logs={d: 1 for d in w1 + w2_short + w3})
    ps = E.periods(h, TODAY)
    assert [p["status"] for p in ps] == [E.DONE, E.MISSED, E.PENDING]
    assert ps[-1]["done"] == 2 and ps[-1]["left"] == 5 and ps[-1]["required"] == 3
    assert E.streaks(E.unit_statuses(h, TODAY)) == (0, 1)
    assert E.streak_unit(h) == "weeks"
    # A full second week → current 2 with this week still pending.
    h = habit(kind="per_week", times=3, logs={d: 1 for d in w1 + w2_short + ["2026-06-13"] + w3})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (2, 2)
    # Today's third check-off completes this week.
    h = habit(kind="per_week", times=3, logs={d: 1 for d in w1 + w2_short + ["2026-06-13"] + w3 + ["2026-06-17"]})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (3, 3)


def test_per_week_current_week_breaks_once_unreachable():
    # 7×/week needs every day; Monday this week was missed → can't be reached.
    h = habit(kind="per_week", times=7, start="2026-06-15", logs={"2026-06-16": 1})
    assert E.periods(h, TODAY)[-1]["status"] == E.MISSED


def test_per_week_skips_shrink_the_target():
    w1 = {d: 1 for d in ["2026-06-01", "2026-06-03", "2026-06-05"]}
    # Whole week skipped → neutral, the streak passes through.
    h = habit(kind="per_week", times=3, logs={**w1, **span("2026-06-08", "2026-06-14", "s"), **{d: 1 for d in ["2026-06-15", "2026-06-16", "2026-06-17"]}})
    assert [p["status"] for p in E.periods(h, TODAY)] == [E.DONE, E.NEUTRAL, E.DONE]
    assert E.streaks(E.unit_statuses(h, TODAY)) == (2, 2)
    # Four days skipped: ceil(3 × 3/7) = 2 needed.
    w2 = {**{d: "s" for d in ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-12"]}, "2026-06-11": 1, "2026-06-13": 1}
    h = habit(kind="per_week", times=3, logs={**w1, **w2})
    p2 = E.periods(h, TODAY)[1]
    assert p2["required"] == 2 and p2["status"] == E.DONE
    # Two skipped: ceil(3 × 5/7) = 3 still needed.
    w2 = {"2026-06-08": "s", "2026-06-09": "s", "2026-06-11": 1, "2026-06-13": 1}
    h = habit(kind="per_week", times=3, logs={**w1, **w2})
    p2 = E.periods(h, TODAY)[1]
    assert p2["required"] == 3 and p2["status"] == E.MISSED


def test_per_week_partial_first_week_and_week_start():
    # Starting on a Thursday: 4 days left in that week → ceil(3 × 4/7) = 2.
    h = habit(kind="per_week", times=3, start="2026-06-04", logs={"2026-06-05": 1, "2026-06-06": 1})
    first = E.periods(h, TODAY)[0]
    assert first["required"] == 2 and first["status"] == E.DONE
    # Weeks starting on Sunday.
    assert E.period_of(TODAY, "per_week", 6) == (D("2026-06-14"), D("2026-06-20"))
    assert E.period_of(TODAY, "per_week", 0) == (D("2026-06-15"), D("2026-06-21"))
    h = habit(kind="per_week", times=2, start="2026-06-07", logs={"2026-06-07": 1, "2026-06-13": 1})
    assert [p["status"] for p in E.periods(h, TODAY, 6)][:1] == [E.DONE]  # Sun 7 – Sat 13
    assert E.periods(h, TODAY, 0)[0]["required"] == 1  # Monday weeks: only Sun 7 in week one


def test_per_month():
    may = {f"2026-05-{d:02d}": 1 for d in range(1, 31, 3)}  # 10 days
    june = {f"2026-06-{d:02d}": 1 for d in (2, 5, 9, 12)}
    h = habit(kind="per_month", times=10, start="2026-05-01", logs={**may, **june})
    ps = E.periods(h, TODAY)
    assert [p["status"] for p in ps] == [E.DONE, E.PENDING]
    assert ps[1]["done"] == 4 and ps[1]["left"] == 14
    assert E.streaks(E.unit_statuses(h, TODAY)) == (1, 1) and E.streak_unit(h) == "months"
    assert E.completion_rate(h, TODAY, None) == 1.0  # the pending month only counts what's done


# ------------------------------------------------------------------- avoid


def test_avoid_habits_count_clean_days_and_slips():
    h = habit(type="avoid", start="2026-06-10", logs={"2026-06-12": 1})
    sts = dict(E.day_statuses(h, TODAY))
    assert sts[D("2026-06-11")] == E.DONE and sts[D("2026-06-12")] == E.MISSED and sts[TODAY] == E.PENDING
    assert E.streaks(E.unit_statuses(h, TODAY)) == (4, 4)
    # Confirming today clean counts it.
    h = habit(type="avoid", start="2026-06-10", logs={"2026-06-12": 1, "2026-06-17": 0})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (5, 5)
    # A slip today breaks today.
    h = habit(type="avoid", start="2026-06-10", logs={"2026-06-17": 2})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (0, 7)
    # A limit: up to 1 a day is fine.
    h = habit(type="avoid", start="2026-06-10", limit=1, logs={"2026-06-12": 1})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (7, 7)
    st = E.habit_stats(habit(type="avoid", start="2026-06-10", logs={"2026-06-12": 1}), TODAY)
    assert st["slip_days"] == 1 and st["last_slip"] == "2026-06-12" and st["clean_days"] == 4


def test_count_and_duration_need_the_target():
    h = habit(type="count", target=8, unit="glasses", start="2026-06-15", logs={"2026-06-15": 8, "2026-06-16": 5})
    sts = dict(E.day_statuses(h, TODAY))
    assert sts[D("2026-06-15")] == E.DONE and sts[D("2026-06-16")] == E.MISSED
    assert E.fraction(h, h["logs"][1], D("2026-06-16"), TODAY) == 0.625
    h = habit(type="duration", target=20, start="2026-06-16", logs={"2026-06-16": 25})
    assert E.streaks(E.unit_statuses(h, TODAY)) == (1, 1) and E.describe_goal(h) == "20 min"


# --------------------------------------------------------------- the score


def test_score_follows_loops_half_life():
    # Daily: 13 done days in a row → exactly half strength (m^13 = 0.5).
    h = habit(start="2026-06-05", logs=span("2026-06-05", "2026-06-17"))
    assert math.isclose(E.score(h, TODAY), 0.5, abs_tol=1e-9)
    # Skips and a not-yet-done today leave it unchanged.
    h = habit(start="2026-06-03", logs={"2026-06-03": "s", "2026-06-04": "s", **span("2026-06-05", "2026-06-17")})
    assert math.isclose(E.score(h, TODAY), 0.5, abs_tol=1e-9)
    h = habit(start="2026-06-04", logs=span("2026-06-04", "2026-06-16"))
    assert math.isclose(E.score(h, TODAY), 0.5, abs_tol=1e-9)
    # A miss pulls it down, but not to zero.
    h = habit(start="2026-06-04", logs={**span("2026-06-04", "2026-06-15")})
    s = E.score(h, D("2026-06-16"))
    assert 0.35 < s < 0.5
    # Partial counts score partially.
    full = E.score(habit(type="count", target=10, start="2026-06-10", logs=span("2026-06-10", "2026-06-16", 10)), TODAY)
    half = E.score(habit(type="count", target=10, start="2026-06-10", logs=span("2026-06-10", "2026-06-16", 5)), TODAY)
    assert math.isclose(half, full / 2, rel_tol=1e-9)


def test_score_for_weekday_and_weekly_schedules():
    # Mon/Wed/Fri: per occurrence m = 0.5^(1 / (13·√(3/7))).
    days = [d for d in E.days(D("2026-05-04"), D("2026-06-15")) if d.weekday() in (0, 2, 4)]
    h = habit(kind="weekdays", days=[0, 2, 4], start="2026-05-04", logs={d.isoformat(): 1 for d in days})
    m = 0.5 ** (1 / (13 * math.sqrt(3 / 7)))
    assert math.isclose(E.score(h, TODAY), 1 - m ** len(days), rel_tol=1e-9)
    # 3× a week, kept up for eight weeks → strong.
    h = habit(kind="per_week", times=3, start="2026-04-20", logs={d.isoformat(): 1 for d in E.days(D("2026-04-20"), D("2026-06-15")) if d.weekday() in (0, 2, 4)})
    s = E.score(h, TODAY)
    assert 0.7 < s < 1
    series = [v for _, v in E.score_series(h, TODAY)]
    assert all(0 <= v <= 1 for v in series)


# ------------------------------------------------------- the day boundary


def test_day_boundary():
    late = datetime(2026, 6, 17, 2, 30, tzinfo=TZ)
    assert E.logical_today(late, 3) == D("2026-06-16")
    assert E.logical_today(late, 0) == D("2026-06-17")
    assert E.logical_today(datetime(2026, 6, 17, 3, 0, tzinfo=TZ), 3) == D("2026-06-17")
    assert E.logical_day_of("2026-06-17T01:00:00+01:00", 3) == D("2026-06-16")


async def test_logging_after_midnight_counts_for_the_day_before():
    data = data_with(habit(start="2026-06-10"), day_ends_at=3)
    out = await act(data, "log_habit", {"habit": "h"}, now=datetime(2026, 6, 17, 1, 30, tzinfo=TZ))
    assert out.result["day"] == "2026-06-16"
    assert data["habits"][0]["logs"][-1]["day"] == "2026-06-16"
    # And "today" for the streak is still the 16th until 3 am.
    with pytest.raises(ActionError):
        await act(data, "log_habit", {"habit": "h", "day": "2026-06-17"}, now=datetime(2026, 6, 17, 1, 30, tzinfo=TZ))


# ------------------------------------------------------------ perfect days


def test_perfect_days():
    a = habit("a", start="2026-06-14", logs=span("2026-06-14", "2026-06-17"))
    b = habit("b", start="2026-06-14", logs={"2026-06-14": 1, "2026-06-16": 1})
    c = habit("c", kind="per_week", times=2, start="2026-06-14")  # flexible: not part of perfect days
    d = habit("d", start="2026-06-01", archived=True)
    pd = E.perfect_days(data_with(a, b, c, d), TODAY)
    assert pd["total"] == 2 and pd["current_streak"] == 1 and pd["best_streak"] == 1 and pd["today"] == E.PENDING
    b2 = habit("b", start="2026-06-14", logs={"2026-06-14": 1, "2026-06-15": 1, "2026-06-16": 1, "2026-06-17": 1})
    pd = E.perfect_days(data_with(a, b2), TODAY)
    assert pd["total"] == 4 and pd["current_streak"] == 4 and pd["today"] == E.DONE


# ---------------------------------------------------------------- actions


async def test_create_edit_archive_delete_reorder():
    data = SPEC.template(ctx_at(NOW))
    out = await act(
        data,
        "create_habit",
        {
            "name": "Drink water",
            "emoji": "💧",
            "type": "count",
            "target": 8,
            "unit": "glasses",
            "time_of_day": "anytime",
            "intention": "After each bathroom break, I'll refill my bottle",
            "reminders": ["10:00", "15:00"],
        },
    )
    assert out.result["id"] == "drink-water" and "Drink water" in out.summary
    h = data["habits"][0]
    assert h["start_date"] == "2026-06-17" and h["created_at"].startswith("2026-06-17T08:00") and h["target"] == 8
    out = await act(
        data,
        "create_habits",
        {
            "habits": [
                {"name": "Drink water"},
                {"name": "Gym", "schedule": {"kind": "per_week", "times": 3}, "area": "Fitness"},
                {"name": "Read", "type": "duration", "time_of_day": "evening"},
                {"name": "Phone in bed", "type": "avoid"},
            ]
        },
    )
    assert out.result["ids"] == ["drink-water-2", "gym", "read", "phone-in-bed"]
    assert next(x for x in data["habits"] if x["id"] == "read")["target"] == 10  # default 10 minutes
    await act(data, "edit_habit", {"habit": "gym", "schedule": {"kind": "weekdays", "days": [0, 3]}, "name": "Gym session"})
    gym = next(x for x in data["habits"] if x["id"] == "gym")
    assert gym["name"] == "Gym session" and gym["schedule"]["days"] == [0, 3] and gym["area"] == "Fitness"
    await act(data, "archive_habit", {"habit": "Gym session"})
    assert gym["id"] in [x["id"] for x in data["habits"] if x["archived"]]
    await act(data, "archive_habit", {"habit": "gym", "archived": False})
    await act(data, "reorder_habits", {"order": ["read", "gym"]})
    assert [x["id"] for x in data["habits"]][:3] == ["read", "gym", "drink-water"]
    out = await act(data, "delete_habit", {"habit": "drink-water-2"})
    assert "drink-water-2" not in [x["id"] for x in data["habits"]]
    with pytest.raises(ActionError, match="No habit"):
        await act(data, "edit_habit", {"habit": "nope", "name": "x"})
    with pytest.raises(ActionError, match="several"):
        await act(data, "log_habit", {"habit": "i"})  # matches "Drink water", "Gym session", "Phone in bed"…
    with pytest.raises(ActionError, match="Bad arguments"):
        await act(data, "create_habit", {"name": ""})


async def test_log_unlog_add_and_refusals():
    data = data_with(
        habit("water", type="count", target=8, start="2026-06-10"),
        habit("smoke", type="avoid", start="2026-06-10"),
        habit("walk", start="2026-06-15"),
    )
    out = await act(data, "log_habit", {"habit": "water", "value": 3})
    assert out.result["value"] == 3
    out = await act(data, "log_habit", {"habit": "water", "add": True})
    assert out.result["value"] == 4 and "4/8" in out.summary
    out = await act(data, "log_habit", {"habit": "water", "add": True, "value": 4, "note": "hot day"})
    water = data["habits"][0]
    assert water["logs"][-1]["value"] == 8 and water["logs"][-1]["note"] == "hot day"
    assert E.today_status(water, TODAY)["done"]
    # Avoid: a slip, then a clean day.
    out = await act(data, "log_habit", {"habit": "smoke", "add": True})
    assert "1 slip" in out.summary
    out = await act(data, "log_habit", {"habit": "smoke", "day": "2026-06-16", "value": 0})
    assert out.summary.endswith("clean on 2026-06-16")
    # Logging before the start moves the start back.
    await act(data, "log_habit", {"habit": "walk", "day": "2026-06-12"})
    assert data["habits"][2]["start_date"] == "2026-06-12"
    # The future can't be logged.
    with pytest.raises(ActionError, match="hasn't happened"):
        await act(data, "log_habit", {"habit": "walk", "day": "2026-06-18"})
    # Setting a count to 0 clears the day.
    await act(data, "log_habit", {"habit": "water", "day": "2026-06-11", "value": 2})
    await act(data, "log_habit", {"habit": "water", "day": "2026-06-11", "value": 0})
    assert "2026-06-11" not in [x["day"] for x in data["habits"][0]["logs"]]
    await act(data, "unlog_habit", {"habit": "walk", "day": "2026-06-12"})
    with pytest.raises(ActionError, match="Nothing is logged"):
        await act(data, "unlog_habit", {"habit": "walk", "day": "2026-06-12"})
    out = await act(
        data,
        "log_habits",
        {"entries": [{"habit": "walk", "day": f"2026-06-{d}"} for d in (14, 15, 16)] + [{"habit": "walk"}]},
    )
    assert len(out.result) == 4
    walk = data["habits"][2]
    assert E.streaks(E.unit_statuses(walk, TODAY)) == (4, 4)


async def test_skip_ranges_ahead_and_keeps_done_days():
    data = data_with(habit("a", start="2026-06-01", logs={"2026-06-17": 1}), habit("b", kind="weekdays", days=[0], start="2026-06-01"))
    out = await act(data, "skip_habit", {"day": "2026-06-17", "until": "2026-06-23", "reason": "Holiday"})
    a, b = data["habits"]
    assert out.result["already_done_kept"] == 1
    assert [x for x in a["logs"] if x["day"] == "2026-06-17"][0]["skipped"] is False
    assert sum(1 for x in a["logs"] if x["skipped"]) == 6  # 18–23
    assert [x["day"] for x in b["logs"] if x["skipped"]] == ["2026-06-22"]  # only its Monday
    assert a["logs"][-1]["reason"] == "Holiday"
    with pytest.raises(ActionError, match="before"):
        await act(data, "skip_habit", {"habits": ["a"], "day": "2026-06-20", "until": "2026-06-19"})
    with pytest.raises(ActionError, match="120"):
        await act(data, "skip_habit", {"habits": ["a"], "day": "2026-06-01", "until": "2026-12-01"})


async def test_settings_and_reviews():
    data = SPEC.template(ctx_at(NOW))
    out = await act(data, "set_settings", {"day_ends_at": 3, "week_start": 6, "evening_summary": True, "evening_time": "20:30"})
    s = data["settings"]
    assert s["day_ends_at"] == 3 and s["week_start"] == 6 and s["evening_time"] == "20:30" and s["onboarded"] is True
    assert out.result == {"day_ends_at": 3, "week_start": 6, "evening_summary": True, "evening_time": "20:30"}
    with pytest.raises(ActionError):
        await act(data, "set_settings", {"evening_time": "8pm"})
    out = await act(data, "write_review", {"wins": "Walked daily", "insights": "**Mornings** work best."})
    assert out.result["week"] == "2026-06-14"  # Sunday-start week
    await act(data, "write_review", {"week": "2026-06-16", "focus": "Read before bed"})
    assert len(data["reviews"]) == 1 and data["reviews"][0]["wins"] == "Walked daily" and data["reviews"][0]["focus"] == "Read before bed"


async def test_read_only_stats_review_and_risk():
    data = data_with(
        habit("walk", name="Walk", start="2026-06-01", logs=span("2026-06-01", "2026-06-16")),
        habit("read", name="Read", start="2026-06-01", logs={**span("2026-06-01", "2026-06-15"), "2026-06-13": "s"}),
        habit("gym", name="Gym", kind="per_week", times=3, start="2026-06-01", logs={d: 1 for d in ["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-10", "2026-06-12"]}),
        habit("old", name="Old", start="2026-06-01", archived=True),
    )
    before = json.dumps(data, sort_keys=True)
    out = await act(data, "habit_stats")
    res = out.result
    assert res["today"] == "2026-06-17" and [h["id"] for h in res["habits"]] == ["walk", "read", "gym"]
    walk = res["habits"][0]
    assert walk["current_streak"] == 16 and walk["best_streak"] == 16 and walk["streak_unit"] == "days" and walk["rate_7d"] == 1.0
    assert 0 < walk["score"] <= 100 and walk["today"]["due"] and not walk["today"]["done"]
    gym = res["habits"][2]
    assert gym["current_streak"] == 2 and gym["streak_unit"] == "weeks" and gym["today"]["period"]["required"] == 3
    assert "perfect_days" in res
    one = (await act(data, "habit_stats", {"habit": "Read"})).result
    assert len(one["habits"]) == 1 and one["habits"][0]["skipped_days"] == 1
    # The review data for last week (Mon 8 – Sun 14).
    wk = (await act(data, "weekly_review_data", {"week": "2026-06-10"})).result
    assert wk["week"] == "2026-06-08" and wk["complete"] is True
    rows = {r["id"]: r for r in wk["habits"]}
    assert rows["walk"]["done"] == 7 and rows["walk"]["rate"] == 1.0
    assert rows["read"]["done"] == 6 and rows["read"]["skipped"] and rows["read"]["rate"] == 1.0
    assert rows["gym"]["done"] == 3 and rows["gym"]["expected"] == 3
    # 13 June: Read was skipped, so Walk alone made it perfect.
    assert set(wk["wins"]) == {"Walk", "Read", "Gym"} and wk["perfect_days"] == 7
    # At risk today: Read missed yesterday (never miss twice) beats Walk's streak.
    risk = (await act(data, "at_risk_habits")).result["at_risk"]
    assert [r["id"] for r in risk][:2] == ["read", "walk"]
    assert "never miss twice" in risk[0]["reason"] and "16-day streak" in risk[1]["reason"]
    assert json.dumps(data, sort_keys=True) == before  # read-only


async def test_at_risk_weekly_target_without_slack():
    # 3× a week, none done by Friday → 3 needed in 3 days left (Fri, Sat, Sun).
    data = data_with(habit("gym", kind="per_week", times=3, start="2026-06-08", logs={d: 1 for d in ["2026-06-08", "2026-06-10", "2026-06-12"]}))
    fri = datetime(2026, 6, 19, 9, 0, tzinfo=TZ)
    risk = (await act(data, "at_risk_habits", now=fri)).result["at_risk"]
    assert risk and risk[0]["id"] == "gym" and "today is required" in risk[0]["reason"]
    assert (await act(data, "at_risk_habits")).result["at_risk"] == []  # Wednesday: plenty of slack


# --------------------------------------------------------------- to_text


def test_to_text():
    data = data_with(
        habit("walk", name="Walk", emoji="🚶", intention="After lunch, I will walk 10 minutes", logs=span("2026-06-01", "2026-06-16")),
        habit("smoke", name="Smoking", type="avoid", logs={"2026-06-05": 1}),
        habit("old", name="Old habit", archived=True),
    )
    data["habits"][0]["logs"][-1]["note"] = "Lovely sunset"
    data["reviews"] = [{"week": "2026-06-08", "wins": "Walked every day", "insights": "Lunch walks stick."}]
    data = SPEC.validate(data)
    text = SPEC.to_text(data)
    assert "🚶 Walk" in text and "After lunch" in text and "Smoking" in text and "quitting" in text
    assert "Archived: Old habit" in text and "Lovely sunset" in text and "Walked every day" in text
    assert "Streak" in text and "strength" in text
    assert len(text) <= 20_000


# -------------------------------------------------------------- reminders


def _keys(data, now=NOW):
    return [r.key for r in reminders(SPEC.validate(data), ctx_at(now))]


def test_reminders_only_while_still_to_do():
    data = data_with(habit("walk", name="Walk", start="2026-06-01", reminders=["09:00", "07:00"], intention="After breakfast, I will walk"))
    keys = _keys(data)
    assert "habit:walk:2026-06-17:09:00" in keys and "habit:walk:2026-06-17:07:00" not in keys  # 07:00 has passed
    assert sum(k.endswith(":09:00") for k in keys) == 8  # today … +7 days, within the horizon
    rs = reminders(SPEC.validate(data), ctx_at(NOW))
    assert rs[0].body == "After breakfast, I will walk" and rs[0].title == "Walk"
    assert [r.due_at for r in rs] == sorted(r.due_at for r in rs)
    # Done today → today's reminder goes; tomorrow's stays.
    data["habits"][0]["logs"] = [{"day": "2026-06-17", "value": 1}]
    keys = _keys(data)
    assert "habit:walk:2026-06-17:09:00" not in keys and "habit:walk:2026-06-18:09:00" in keys
    # Skipped days (planned ahead) → none.
    data["habits"][0]["logs"] = [{"day": "2026-06-18", "value": 0, "skipped": True}]
    assert "habit:walk:2026-06-18:09:00" not in _keys(data)
    # Archived → none; master switch off → none.
    data["habits"][0]["archived"] = True
    assert _keys(data) == []
    data["habits"][0]["archived"] = False
    data["settings"]["reminders_on"] = False
    assert _keys(data) == []


def test_reminders_follow_the_schedule():
    data = data_with(
        habit("mon", kind="weekdays", days=[0], reminders=["09:00"]),
        habit("gym", kind="per_week", times=2, reminders=["18:00"], logs={"2026-06-15": 1, "2026-06-16": 1}),
        review_reminder=False,
    )
    keys = _keys(data)
    assert [k for k in keys if k.startswith("habit:mon")] == ["habit:mon:2026-06-22:09:00"]
    gym = [k for k in keys if k.startswith("habit:gym")]
    # This week's target is met → nothing until next week.
    assert gym and all(k >= "habit:gym:2026-06-22" for k in gym)


def test_reminder_times_before_the_day_boundary_fall_after_midnight():
    data = data_with(habit("late", reminders=["01:00"]), day_ends_at=3)
    rs = reminders(SPEC.validate(data), ctx_at(NOW))
    first = next(r for r in rs if r.key == "habit:late:2026-06-17:01:00")
    assert first.due_at == datetime(2026, 6, 18, 1, 0, tzinfo=TZ)


def test_evening_summary_and_weekly_review_reminders():
    data = data_with(habit("walk", name="Walk"), habit("read", name="Read"), evening_summary=True, evening_time="21:00")
    rs = {r.key: r for r in reminders(SPEC.validate(data), ctx_at(NOW))}
    assert rs["summary:2026-06-17"].title == "2 habits still to do" and "Walk, Read" in rs["summary:2026-06-17"].body
    assert "review:2026-06-15" in rs and rs["review:2026-06-15"].due_at == datetime(2026, 6, 21, 18, 0, tzinfo=TZ)
    data["habits"][0]["logs"] = [{"day": "2026-06-17", "value": 1}]
    data["habits"][1]["logs"] = [{"day": "2026-06-17", "value": 1}]
    data["reviews"] = [{"week": "2026-06-15", "wins": "All good"}]
    keys = _keys(data)
    assert "summary:2026-06-17" not in keys and "summary:2026-06-18" in keys and "review:2026-06-15" not in keys


# --------------------------------------------------------------- AI tools


def test_tools_have_no_refs_and_cover_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names
    assert {"create_habits", "log_habit", "skip_habit", "habit_stats", "at_risk_habits", "weekly_review_data", "read_other_item"} <= names
    assert "$ref" not in json.dumps(tools)
    read_only = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert {"habit_stats", "weekly_review_data", "at_risk_habits"} <= read_only and "log_habit" not in read_only
    assert SPEC.reads == ("journal", "health") and len(SPEC.ai_suggestions) >= 4
    assert "Gollwitzer" in SPEC.ai_brief and "66" in SPEC.ai_brief


def test_identity():
    assert (SPEC.kind, SPEC.name, SPEC.suffix, SPEC.color, SPEC.icon, SPEC.category) == (
        "habits", "Habits", ".habits", "#7B6CD9", "circle-check-big", "Habits & journal",
    )
    assert 5 <= len(SPEC.highlights) <= 8 and SPEC.replaces.startswith("Replaces")


# ------------------------------------------------------------ end to end


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_end_to_end_api_flow(client, db, user):
    from sqlalchemy import select

    from app.items.models import ItemReminder

    r = await client.post("/api/items/store/habits", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "habits", "title": "My habits"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "My habits.habits" and item["data"]["habits"] == []

    r = await client.post(
        f"/api/items/{fid}/actions/create_habit",
        headers=_auth(user),
        json={"args": {"name": "Meditate", "emoji": "🧘", "type": "duration", "target": 5, "reminders": ["12:00"], "intention": "After I brush my teeth, I will sit for 1 minute"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["result"]["id"] == "meditate" and r.json()["revision"] == 2
    rows = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert any(x.key.startswith("habit:meditate:") for x in rows)

    r = await client.post(f"/api/items/{fid}/actions/log_habit", headers=_auth(user), json={"args": {"habit": "Meditate", "value": 7}})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["current_streak"] == 1
    r = await client.post(f"/api/items/{fid}/actions/habit_stats", headers=_auth(user), json={})
    assert r.status_code == 200 and r.json()["result"]["habits"][0]["today"]["done"] is True
    r = await client.post(f"/api/items/{fid}/actions/log_habit", headers=_auth(user), json={"args": {"habit": "nope"}})
    assert r.status_code == 400 and "No habit" in r.json()["detail"]

    # A direct UI save (the Today check-off path) is validated and stored.
    r2 = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    data = r2["data"]
    data["habits"][0]["name"] = "Meditation"
    data["settings"]["onboarded"] = True
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": r2["revision"]})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["habits"][0]["name"] == "Meditation"
    bad = dict(data)
    bad["habits"] = [{**data["habits"][0], "type": "sometimes"}]
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": bad, "base_revision": r.json()["revision"]})
    assert r.status_code == 400

    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Meditation" in row.content_text and "After I brush my teeth" in row.content_text


def test_stats_cover_years_quickly():
    import time

    logs = {d.isoformat(): 1 for d in E.days(D("2018-01-01"), D("2026-06-16")) if d.day % 5}
    h = habit(start="2018-01-01", logs=logs)
    t = time.perf_counter()
    st = E.habit_stats(h, TODAY)
    assert time.perf_counter() - t < 1.0
    assert st["best_streak"] >= 1 and st["rate_all"] is not None
    assert len(json.dumps(h)) < 400_000


# ============================================================ fix pass
# Eras (schedule history), the every-N-days anchor, import/export, the
# timer, reminder options for weekly targets, archiving, text_now and the
# Python↔TS parity fixtures.

FIXTURES = __import__("pathlib").Path(__file__).with_name("habits_engine_fixtures.json")


def fixture_outputs(h: dict, today: str, ws: int) -> dict:
    """What the parity fixtures compare (engine.ts ``fixtureOutputs`` is the same)."""
    t = D(today)
    units = E.unit_statuses(h, t, ws)
    cur, best = E.streaks(units)
    series = E.score_series(h, t)
    return {
        "current": cur,
        "best": best,
        "units": ",".join(units),
        "days": "".join(s[0] for _, s in E.day_statuses(h, t)),
        "score": round(series[-1][1], 4) if series else 0,
        "rate_all": E.completion_rate(h, t, None, ws),
        "rate_30": E.completion_rate(h, t, 30, ws),
        "weekdays": " ".join(f"{r['done']}/{r['total']}" for r in E.weekday_breakdown(h, t)),
    }


def test_parity_fixtures_match_the_python_engine():
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))
    assert len(cases) >= 12
    for c in cases:
        h = SPEC.validate({"habits": [c["habit"]]})["habits"][0]
        got = fixture_outputs(h, c["today"], c["week_start"])
        assert got == c["expected"], c["name"]


async def test_editing_the_schedule_keeps_past_days_under_old_rules():
    data = data_with(habit("run", start="2026-06-01", logs=span("2026-06-01", "2026-06-16")))
    before = E.habit_stats(data["habits"][0], TODAY)
    assert before["current_streak"] == 16 and before["rate_all"] == 1.0
    out = await act(data, "edit_habit", {"habit": "run", "schedule": {"kind": "per_week", "times": 3}})
    h = data["habits"][0]
    assert "from today" in out.summary and out.result["history"] == "from_today"
    assert h["history"] == [
        {"until": "2026-06-17", "type": "yes_no", "target": 1.0, "limit": 0, "schedule": {"kind": "daily", "days": [], "times": 3, "every": 2}, "anchor_date": "2026-06-01"}
    ]
    after = E.habit_stats(h, TODAY)
    assert after["rate_all"] == 1.0 and after["streak_unit"] == "weeks"
    # 16 daily units, then this (pending) week → still a 16-unit run.
    assert after["current_streak"] == 16
    # Past days under daily rules are still "done", not re-judged as a week.
    assert E.day_statuses(h, TODAY)[0] == (D("2026-06-01"), E.DONE)
    # A second edit the same day doesn't add another era.
    await act(data, "edit_habit", {"habit": "run", "schedule": {"kind": "per_week", "times": 4}})
    assert len(data["habits"][0]["history"]) == 1
    # Non-rule edits never create eras.
    await act(data, "edit_habit", {"habit": "run", "name": "Run!", "emoji": "🏃"})
    assert len(data["habits"][0]["history"]) == 1
    # apply_to_past re-judges everything with the new rules.
    out = await act(data, "edit_habit", {"habit": "run", "type": "count", "target": 2, "apply_to_past": True})
    h = data["habits"][0]
    assert h["history"] == [] and out.result["history"] == "rewrote_past"
    assert E.habit_stats(h, TODAY)["rate_all"] in (None, 0.0)  # 1 of 2 → nothing met


async def test_raising_a_target_doesnt_fail_old_days():
    data = data_with(habit("water", type="count", target=4, start="2026-06-10", logs=span("2026-06-10", "2026-06-16", 4)))
    await act(data, "edit_habit", {"habit": "water", "target": 8})
    st = E.habit_stats(data["habits"][0], TODAY)
    assert st["current_streak"] == 7 and st["rate_all"] == 1.0
    await act(data, "log_habit", {"habit": "water", "value": 6}, now=datetime(2026, 6, 17, 23, 0, tzinfo=TZ))
    assert E.today_status(data["habits"][0], TODAY)["done"] is False  # today's rule is 8


async def test_backfilling_before_the_start_never_shifts_every_n_days():
    data = data_with(habit("plants", kind="every_n_days", every=3, start="2026-06-11"))
    h = data["habits"][0]
    due = [d for d in E.days(D("2026-06-11"), D("2026-06-20")) if E.is_due(h, d, E.start_of(h))]
    await act(data, "log_habit", {"habit": "plants", "day": "2026-06-06"})
    h = data["habits"][0]
    assert h["start_date"] == "2026-06-06" and h["anchor_date"] == "2026-06-11"
    due2 = [d for d in E.days(D("2026-06-11"), D("2026-06-20")) if E.is_due(h, d, E.start_of(h))]
    assert due == due2 == [D("2026-06-11"), D("2026-06-14"), D("2026-06-17"), D("2026-06-20")]
    # Switching to a new cadence starts it today.
    await act(data, "edit_habit", {"habit": "plants", "schedule": {"kind": "every_n_days", "every": 2}})
    h = data["habits"][0]
    assert h["anchor_date"] == "2026-06-17" and h["history"][-1]["anchor_date"] == "2026-06-11"
    assert E.is_due(h, D("2026-06-19"), E.start_of(h)) and E.config_on(h, D("2026-06-14"))["schedule"]["every"] == 3


async def test_full_habit_refuses_clearly_and_archive_makes_room():
    from app.items.kinds.habits.models import MAX_LOGS

    first = D("2014-01-01")
    logs = [{"day": (first + timedelta(days=i)).isoformat(), "value": 1} for i in range(MAX_LOGS)]
    data = data_with({"id": "big", "name": "Big", "start_date": "2014-01-01", "logs": logs})
    with pytest.raises(ActionError, match="Archive older data"):
        await act(data, "log_habit", {"habit": "big"})
    data["reviews"] = [{"week": "2015-01-05", "wins": "old"}, {"week": "2026-06-08", "wins": "new"}]
    data = SPEC.validate(data)
    kept, arch = SPEC.archive(data, ctx_at(NOW), "2020-01-01")
    kept, arch = SPEC.validate(kept), SPEC.validate(arch)
    kh, ah = kept["habits"][0], arch["habits"][0]
    assert kh["logs"][0]["day"] >= "2020-01-01" and ah["logs"][-1]["day"] < "2020-01-01"
    assert len(kh["logs"]) + len(ah["logs"]) == MAX_LOGS
    assert kh["start_date"] == "2020-01-01" and kh["anchor_date"] == "2014-01-01"
    assert ah["archived"] and ah["end_date"] == "2019-12-31" and arch["settings"]["reminders_on"] is False
    assert [r["week"] for r in kept["reviews"]] == ["2026-06-08"] and [r["week"] for r in arch["reviews"]] == ["2015-01-05"]
    # The archive's days after its end don't count as missed.
    st = E.habit_stats(ah, TODAY)
    assert st["rate_all"] == 1.0 and st["today"]["due"] is False
    await act(kept, "log_habit", {"habit": "big"})  # room again
    with pytest.raises(ActionError, match="nothing before"):
        SPEC.archive(kept, ctx_at(NOW), "2000-01-01")


def test_active_timer_and_new_fields_validate():
    data = data_with(habit("med", type="duration", target=10, active_timer={"started_at": "2026-06-17T08:00:00+01:00", "day": "2026-06-17"}, reminder_days=[4, 0, 9], remind_when_behind=True))
    h = data["habits"][0]
    assert h["active_timer"]["day"] == "2026-06-17" and h["reminder_days"] == [0, 4]
    with pytest.raises(ValidationError):
        data_with(habit("x", active_timer={"started_at": "", "day": "nope"}))
    # Old files without the new fields still load.
    old = {"habits": [{"id": "o", "name": "Old", "logs": [{"day": "2026-06-01"}]}]}
    assert SPEC.validate(old)["habits"][0]["history"] == []


def test_weekly_reminders_on_chosen_days_or_only_when_behind():
    gym = habit("gym", kind="per_week", times=3, reminders=["18:00"], start="2026-06-01")
    data = data_with(gym, review_reminder=False)
    assert len([k for k in _keys(data) if k.startswith("habit:gym")]) == 8  # nags daily by default
    data["habits"][0]["reminder_days"] = [0, 2, 4]  # Mon / Wed / Fri
    keys = [k for k in _keys(data) if k.startswith("habit:gym")]
    assert keys == ["habit:gym:2026-06-17:18:00", "habit:gym:2026-06-19:18:00", "habit:gym:2026-06-22:18:00", "habit:gym:2026-06-24:18:00"]
    data["habits"][0]["reminder_days"] = []
    data["habits"][0]["remind_when_behind"] = True
    data["habits"][0]["logs"] = [{"day": "2026-06-15", "value": 1}]
    keys = [k[len("habit:gym:"):][:10] for k in _keys(data) if k.startswith("habit:gym")]
    # 1 done by Wed (pace needs 1) → fine Wed–Thu; Fri needs 2; next week Mon/Tue need 0.
    assert keys[:3] == ["2026-06-19", "2026-06-20", "2026-06-21"] and "2026-06-22" not in keys and "2026-06-24" in keys


def test_to_text_uses_the_owners_now():
    from app.items.spec import _TEXT_NOW

    data = data_with(habit("walk", name="Walk", start="2026-06-01", logs=span("2026-06-01", "2026-06-16")))
    tok = _TEXT_NOW.set(datetime(2026, 6, 17, 8, 0, tzinfo=TZ))
    try:
        text = SPEC.to_text(data)
    finally:
        _TEXT_NOW.reset(tok)
    assert "Streak 16 days" in text and "[" + "✓" * 13 + "?]" in text


# ------------------------------------------------------------- import

LOOP_HABITS = """Position,Name,Type,Question,Description,FrequencyNumerator,FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?,Category
001,Meditate,YES_NO,Did you meditate this morning?,,1,1,#FF8F00,,,,false,
002,Wake up early,YES_NO,Did you wake up before 6am?,,2,3,#00897B,,,,false,
003,"Foo, Bar",YES_NO,Did you do foo bar?,,3,7,#303F9F,,,,true,"Health, Wellness"
004,Water,NUMERICAL,,,1,1,#039BE5,glasses,AT_LEAST,8,false,Health
005,Coffee,NUMERICAL,,,1,1,#8E24AA,cups,AT_MOST,2,false,
"""

LOOP_CHECKMARKS = """Date,Meditate,Wake up early,"Foo, Bar",Water,Coffee,
2026-06-16,YES_MANUAL,NO,SKIP,8000,1000,
2026-06-15,YES_MANUAL,YES_AUTO,YES_MANUAL,5000,3000,
2026-06-14,UNKNOWN,YES_MANUAL,UNKNOWN,UNKNOWN,UNKNOWN,
2026-06-20,YES_MANUAL,UNKNOWN,UNKNOWN,UNKNOWN,UNKNOWN,
"""

LOOP_SINGLE = """Date,Value,Notes
2026-06-16,YES_MANUAL,Felt calm
2026-06-13,YES_MANUAL,
"""


async def test_import_loop_export_preview_then_import():
    data = data_with(habit("med", name="Meditate", start="2026-06-15", logs={"2026-06-15": 1}))
    files = [
        {"name": "Loop Habits CSV 2026-06-17/Habits.csv", "content": LOOP_HABITS},
        {"name": "Loop Habits CSV 2026-06-17/Checkmarks.csv", "content": LOOP_CHECKMARKS},
        {"name": "Loop Habits CSV 2026-06-17/001 Meditate/Checkmarks.csv", "content": LOOP_SINGLE},
        {"name": "Loop Habits CSV 2026-06-17/Scores.csv", "content": "Date,Meditate\n2026-06-16,0.5\n"},
    ]
    snapshot = json.dumps(data, sort_keys=True)
    prev = (await act(data, "preview_import", {"files": files})).result
    assert json.dumps(data, sort_keys=True) == snapshot  # a preview changes nothing
    assert [h["name"] for h in prev["matched_habits"]] == ["Meditate"]
    assert {h["name"] for h in prev["new_habits"]} == {"Wake up early", "Foo, Bar", "Water", "Coffee"}
    assert prev["logs_kept"] == 1  # 06-15 was already logged
    assert any("2 times in 3 days" in w for w in prev["warnings"])
    formats = [f["format"] for f in prev["files"]]
    assert {"loop_habits", "loop_combined", "scores", "duplicate"} <= set(formats)

    out = await act(data, "import_history", {"files": files})
    assert "Imported" in out.summary and "4 new habits" in out.summary
    by = {h["name"]: h for h in data["habits"]}
    med = by["Meditate"]
    assert [lg["day"] for lg in med["logs"]] == ["2026-06-15", "2026-06-16"]  # the future 06-20 is dropped
    assert next(lg for lg in med["logs"] if lg["day"] == "2026-06-16")["note"] == "Felt calm"
    wake = by["Wake up early"]
    assert wake["schedule"]["kind"] == "per_week" and wake["schedule"]["times"] == 5
    assert [lg["day"] for lg in wake["logs"]] == ["2026-06-14"]  # NO / YES_AUTO aren't check-offs
    assert wake["start_date"] == "2026-06-14"
    foo = by["Foo, Bar"]
    assert foo["archived"] and foo["area"] == "Health, Wellness" and foo["schedule"] == {"kind": "per_week", "days": [], "times": 3, "every": 2}
    assert [(lg["day"], lg["skipped"]) for lg in foo["logs"]] == [("2026-06-15", False), ("2026-06-16", True)]
    water = by["Water"]
    assert water["type"] == "count" and water["target"] == 8 and water["unit"] == "glasses"
    assert [lg["value"] for lg in water["logs"]] == [5, 8]  # Loop's thousandths
    coffee = by["Coffee"]
    assert coffee["type"] == "avoid" and coffee["limit"] == 2 and [lg["value"] for lg in coffee["logs"]] == [3, 1]
    assert coffee["color"] == "#8E24AA" and "Did you" in wake["notes"]
    # Importing again adds nothing new (dedupe by name + day).
    again = (await act(data, "preview_import", {"files": files})).result
    assert again["new_habits"] == [] and again["logs_added"] == 0


async def test_import_loop_per_habit_files_only_and_backfill_anchor():
    data = data_with(habit("med", name="Meditate", kind="every_n_days", every=2, start="2026-06-15"))
    files = [{"name": "Loop/001 Meditate/Checkmarks.csv", "content": LOOP_SINGLE}]
    await act(data, "import_history", {"files": files})
    med = data["habits"][0]
    assert [lg["day"] for lg in med["logs"]] == ["2026-06-13", "2026-06-16"]
    assert med["start_date"] == "2026-06-13" and med["anchor_date"] == "2026-06-15"
    with pytest.raises(ActionError, match="Nothing to import"):
        await act(data, "import_history", {"files": [{"name": "Checkmarks.csv", "content": LOOP_SINGLE}]})


async def test_import_generic_csv_and_round_trip_of_our_export():
    data = data_with(habit("walk", name="Walk", start="2026-06-10", logs={"2026-06-12": 1}))
    # The exact header the Habits tab's Export writes.
    ours = (
        "habit,habit_id,date,value,note,skipped,reason\n"
        "Walk,walk,2026-06-12,1,Sunny,false,\n"
        "Walk,walk,2026-06-13,0,,true,Sick\n"
        "Pages,pages,2026-06-14,12,\"A good, long chapter\",false,\n"
        "Pages,pages,2026-06-15,20,,false,\n"
    )
    out = await act(data, "import_history", {"files": [{"name": "habits-export.csv", "content": ours}], "overwrite": True})
    by = {h["id"]: h for h in data["habits"]}
    assert by["walk"]["logs"][0]["note"] == "Sunny" and by["walk"]["logs"][1]["skipped"] and by["walk"]["logs"][1]["reason"] == "Sick"
    assert by["pages"]["type"] == "count" and by["pages"]["target"] == 20 and by["pages"]["logs"][0]["note"] == "A good, long chapter"
    assert out.result["logs_replaced"] == 1
    # A plain date,habit,value sheet with yes/no words and semicolons.
    simple = "Date;Habit;Value\n2026-06-16;Floss;yes\n2026-06-15;Floss;no\n16/06/2026;Floss;yes\n"
    await act(data, "import_history", {"files": [{"name": "floss.csv", "content": simple}]})
    floss = next(h for h in data["habits"] if h["name"] == "Floss")
    assert floss["type"] == "yes_no" and [lg["day"] for lg in floss["logs"]] == ["2026-06-16"]
    with pytest.raises(ActionError, match="Nothing to import"):
        await act(data, "import_history", {"files": [{"name": "x.csv", "content": "foo,bar\n1,2\n"}]})


async def test_import_and_era_flow_over_the_api(client, db, user):
    r = await client.post("/api/items/store/habits", headers=_auth(user))
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "habits", "title": "Imported"})
    fid = r.json()["file_id"]
    files = [{"name": "Habits.csv", "content": LOOP_HABITS}, {"name": "Checkmarks.csv", "content": LOOP_CHECKMARKS}]
    r = await client.post(f"/api/items/{fid}/actions/preview_import", headers=_auth(user), json={"args": {"files": files}})
    assert r.status_code == 200, r.text
    assert len(r.json()["result"]["new_habits"]) == 5 and r.json()["data"]["habits"] == []
    r = await client.post(f"/api/items/{fid}/actions/import_history", headers=_auth(user), json={"args": {"files": files}})
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["habits"]) == 5 and r.json()["data"]["settings"]["onboarded"] is True
    r = await client.post(f"/api/items/{fid}/actions/edit_habit", headers=_auth(user), json={"args": {"habit": "Meditate", "type": "duration", "target": 10}})
    assert r.status_code == 200, r.text
    med = next(h for h in r.json()["data"]["habits"] if h["name"] == "Meditate")
    assert med["history"][0]["type"] == "yes_no" and med["type"] == "duration"
