"""The Workout item (app/items/kinds/workout): the catalog, the model, the
science (e1RM, loads, plates, warm-ups, PRs, volume), every action, the
text, reminders, the AI tools and an end-to-end API flow."""
from __future__ import annotations

import asyncio
import copy
import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.workout import SPEC, reminders, to_text
from app.items.kinds.workout import science as sci
from app.items.kinds.workout.catalog import EQUIPMENT, LOG_CODES, MUSCLES, PATTERNS, builtin, catalog_payload
from app.items.kinds.workout.models import LB, WorkoutData, expand
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Europe/London")
NOW = datetime(2026, 11, 2, 9, 30, tzinfo=TZ)  # a Monday


def _ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)


def _fresh(**settings) -> dict:
    d = SPEC.validate(SPEC.template(_ctx()))
    d["settings"].update(settings)
    return SPEC.validate(d)


def run(data: dict, name: str, args: dict | None = None, now: datetime = NOW):
    """Run an action like the framework does and keep the data validated."""
    from app.items import service

    out = asyncio.run(service.run_action(_ctx(now), SPEC, data, name, args or {}))
    # Stored compactly, read back with every field (as the actions see it).
    clean = expand(SPEC.validate(data))
    data.clear()
    data.update(clean)
    return out


def _refused(data: dict, name: str, args: dict, needle: str) -> None:
    with pytest.raises(ActionError) as e:
        run(data, name, args)
    assert needle.lower() in str(e.value).lower(), str(e.value)


def _history(data: dict) -> dict:
    """Two bench sessions and a row session last week."""
    run(data, "log_workout", {"date": "2026-10-26", "exercises": [
        {"exercise": "bench", "set_count": 3, "reps": 8, "load": 80},
        {"exercise": "barbell row", "set_count": 3, "reps": 10, "load": 60},
    ]})
    run(data, "log_workout", {"date": "2026-10-29", "exercises": [{"exercise": "bench", "set_count": 3, "reps": 10, "load": 80}]})
    return data


# ------------------------------------------------------------------ catalog


def test_catalog_is_big_complete_and_consistent():
    cat = builtin()
    assert 150 <= len(cat) <= 200
    names = [e["name"] for e in cat.values()]
    assert len(set(names)) == len(names)
    for e in cat.values():
        assert e["log"] in LOG_CODES.values()
        assert e["pattern"] in PATTERNS
        for m in e["primary"] + e["secondary"]:
            assert m in MUSCLES, (e["id"], m)
        for alt in e["needs"]:
            for n in alt:
                assert n in EQUIPMENT, (e["id"], n)
        if e["log"] == "weight_reps" and e["pattern"] != "cardio":
            assert e["primary"], e["id"]
    for key in ("back_squat", "deadlift", "bench_press", "ohp", "pullup", "lat_pulldown", "leg_press", "plank", "run"):
        assert key in cat
    payload = catalog_payload()
    assert payload["muscles"]["chest"]["mav"] == [12, 20]
    json.dumps(payload)  # JSON-able


def test_volume_landmarks_are_ordered():
    for m, lm in MUSCLES.items():
        assert lm["mv"] <= lm["mev"] <= lm["mav"][0] <= lm["mav"][1] <= lm["mrv"], m


# -------------------------------------------------------------------- model


def test_template_and_old_files_load():
    d = SPEC.validate(SPEC.template(_ctx()))
    assert d["settings"]["units"] == "kg" and d["settings"]["onboarded"] is False
    assert d["active"] is None and d["workouts"] == [] and len(d["settings"]["plates"]) == 7
    assert SPEC.validate({}) == d  # an empty / old file still loads with defaults


def test_model_bounds_and_normalisation():
    d = _fresh()
    d["planned"] = [{"id": "a", "date": "2026-11-05", "exercises": [{"id": "x", "exercise_id": "bench_press", "reps_min": 12, "reps_max": 8}]},
                    {"id": "b", "date": "2026-11-03"}]
    out = SPEC.validate(d)
    assert [s["id"] for s in out["planned"]] == ["b", "a"]  # sorted by date
    rx = out["planned"][1]["exercises"][0]
    assert (rx["reps_min"], rx["reps_max"]) == (8, 12)
    with pytest.raises(ValidationError):
        SPEC.validate({**d, "planned": [{"id": "x", "date": "5 Nov"}]})
    with pytest.raises(ValidationError):
        SPEC.validate({**d, "settings": {**d["settings"], "units": "stone"}})
    with pytest.raises(ValidationError):
        SPEC.validate({**d, "workouts": [{"id": f"w{i}", "date": "2026-01-01"} for i in range(2501)]})


def test_sets_are_stored_compactly():
    d = _fresh()
    d["workouts"] = [{"id": "w", "date": "2026-10-01", "exercises": [{"id": "e", "exercise_id": "bench_press", "sets": [{"id": "t", "kg": 60, "reps": 5}]}]}]
    s = SPEC.validate(d)["workouts"][0]["exercises"][0]["sets"][0]
    # Finished workouts keep only what's not a default (no tick, no tick time).
    assert s == {"id": "t", "kg": 60.0, "reps": 5}
    # A decade of 4×/week training fits easily.
    w = s.copy()
    big = {"id": "w", "date": "2026-10-01", "name": "Upper A", "started_at": NOW.isoformat(), "ended_at": NOW.isoformat(),
           "exercises": [{"id": f"e{i}", "exercise_id": "bench_press", "sets": [dict(w, id=f"t{j}", rir=2, at=NOW.isoformat()) for j in range(4)]} for i in range(6)]}
    size = len(json.dumps(SPEC.validate({**d, "workouts": [dict(big, id=f"w{k}") for k in range(2080)]})))
    assert size < SPEC.max_bytes


# ------------------------------------------------------------------ science


def test_e1rm_formulas_and_their_inverse():
    assert sci.e1rm(100, 1) == 100
    assert sci.e1rm(100, 10) == pytest.approx(133.33, abs=0.01)  # Epley
    assert sci.e1rm(100, 10, formula="brzycki") == pytest.approx(133.33, abs=0.01)
    assert sci.e1rm(100, 8, reserve=2) == sci.e1rm(100, 10)  # the internal margin counts as reps
    assert sci.e1rm(100, 30) is None and sci.e1rm(None, 5) is None and sci.e1rm(100, 0) is None
    one = sci.e1rm(80, 8, 2)
    assert sci.load_for(one, 8, 2) == pytest.approx(80)
    assert sci.load_for(one, 5, 2) > 80 > sci.load_for(one, 12, 2)
    assert sci.load_for(120, 5, 0, "brzycki") == pytest.approx(120 * 32 / 36)


def test_loads_round_to_the_kit():
    st = _fresh()["settings"]
    bench = builtin()["bench_press"]
    assert sci.round_load(81.4, bench, st) == 82.5  # 1.25 kg plates → 2.5 kg steps
    assert sci.round_load(81.2, bench, st) == 80.0
    assert sci.round_load(10, bench, st) == 20.0  # never below the empty bar
    assert sci.round_load(83, bench, st, "down") == 82.5
    db = builtin()["db_curl"]
    assert sci.round_load(13.1, db, st) == 14.0
    home = dict(st, equipment=["dumbbell", "bench"], dumbbells_kg=[5.0, 7.5, 10.0, 12.5])
    assert sci.round_load(30, builtin()["db_bench"], home) == 12.5
    assert sci.round_load(13, builtin()["goblet_squat"], dict(st, equipment=["kettlebell"])) == 12.0
    assert sci.round_load(47, builtin()["lat_pulldown"], st) == 45.0
    assert sci.round_load(40, builtin()["plank"], st) == 40  # nothing to round
    lb = _fresh()
    run(lb, "set_profile", {"units": "lb"})
    st_lb = lb["settings"]
    v = sci.round_load(100, bench, st_lb)  # 100 kg ≈ 220.5 lb → 220 lb (45 bar + 2×(45+35+5+2.5))
    assert sci.to_unit(v, st_lb) == 220.0


def test_increment_plate_maths_and_warmups():
    st = _fresh()["settings"]
    cat = builtin()
    assert sci.increment(cat["back_squat"], st) == 2.5
    assert sci.increment(cat["bench_press"], st) == 2.5  # 1.25 nominal, but the bar jumps 2.5
    assert sci.increment(cat["db_curl"], st) == 2.0
    pl = sci.plates_per_side(102.5, st)
    assert pl["per_side"] == [25.0, 15.0, 1.25] and pl["remainder_kg"] == 0 and pl["loaded_kg"] == 102.5
    short = sci.plates_per_side(101, dict(st, plates=[{"kg": 20, "pairs": 2}, {"kg": 2.5, "pairs": 1}]))
    assert short["per_side"] == [20.0, 20.0] and short["remainder_kg"] == pytest.approx(1.0)  # can't make 101
    wu = sci.warmups(100, cat["back_squat"], st)
    assert wu[0] == {"kg": 20.0, "reps": 10} and [w["reps"] for w in wu] == [10, 5, 3, 2]
    assert all(a["kg"] < b["kg"] for a, b in zip(wu, wu[1:])) and wu[-1]["kg"] < 100
    assert [w["reps"] for w in sci.warmups(30, cat["db_bench"], st)] == [10, 5]
    assert sci.warmups(60, cat["plank"], st) == []


def test_exercise_lookup_is_forgiving():
    d = _fresh()
    f = lambda q: (sci.find_exercise(d, q) or {}).get("id")  # noqa: E731
    assert f("bench") == "bench_press"
    assert f("Bench Press (Barbell)") == "bench_press"
    assert f("squat") == "back_squat"
    assert f("db curl") == "db_curl"
    assert f("pull ups") == "pullup"
    assert f("RDL") == "rdl"
    assert f("incline dumbbell press") == "db_incline_bench"
    assert f("lateral raises") == "db_lateral_raise"
    assert f("zzz quantum lift") is None


def test_records_new_records_and_volume():
    d = _history(_fresh())
    rec = sci.records(d, "bench_press")["bench_press"]
    assert rec["e1rm"]["value"] == pytest.approx(sci.e1rm(80, 10), abs=0.1) and rec["e1rm"]["date"] == "2026-10-29"
    assert rec["10rm"]["value"] == 80 and rec["volume"]["value"] == 2400
    w = {"id": "new", "date": "2026-11-02", "exercises": [{"id": "e", "exercise_id": "bench_press", "sets": [{"id": "a", "kg": 85, "reps": 6}]}]}
    prs = sci.new_records(d, w)
    kinds = {p["kind"] for p in prs}
    assert "5rm" in kinds and "3rm" not in kinds and "1rm" not in kinds  # the most specific rep max
    vol = sci.weekly_volume(d, date(2026, 10, 26))
    assert vol["chest"] == 6 and vol["triceps"] == 3  # secondary ½
    assert vol["upper_back"] == 3 and vol["biceps"] == 1.5
    assert sci.landmark_status("chest", 6) == "below_mev"
    assert sci.landmark_status("chest", 14) == "in_mav"
    assert sci.landmark_status("chest", 25) == "above_mrv"


def test_suggestions_use_history_or_calibrate():
    d = _history(_fresh(bodyweight_kg=80, sex="male"))
    bench = builtin()["bench_press"]
    s = sci.suggest(d, bench, 5, today=NOW.date())
    one = sci.e1rm(80, 10, sci.RESERVE)
    # The e1RM it reports is the strict one their records show; the load
    # maths reads working sets with the internal margin.
    assert s["basis"] == "recent" and s["e1rm_kg"] == pytest.approx(sci.e1rm(80, 10), abs=0.1)
    assert s["e1rm_kg"] == sci.records(d, "bench_press")["bench_press"]["e1rm"]["value"]
    assert s["load_kg"] == sci.round_load(sci.load_for(one, 5, 2), bench, d["settings"])
    assert "progression" not in s  # last time was 10s: not comparable with a 5-rep target
    assert "rir" not in s and all("rir" not in x for x in s["last"]["sets"])
    assert sci.suggest(d, bench, 10, today=NOW.date())["progression"]["action"] == "add_load"
    squat = sci.suggest(d, builtin()["back_squat"], 5, today=NOW.date())
    assert squat["calibrate"] is True and 40 <= squat["load_kg"] <= 80
    assert sci.starting_load(builtin()["back_squat"], dict(d["settings"], sex="female"), 5, 2) < sci.starting_load(builtin()["back_squat"], d["settings"], 5, 2)


def test_double_progression():
    d = _fresh()
    bench = builtin()["bench_press"]
    we = {"sets": [{"kg": 80, "reps": 12}, {"kg": 80, "reps": 12}]}
    p = sci.progression(d, bench, we, (8, 12))
    assert p["action"] == "add_load" and p["load_kg"] == 82.5 and p["reps"] == 8
    we = {"sets": [{"kg": 80, "reps": 12}, {"kg": 80, "reps": 10}]}
    assert sci.progression(d, bench, we, (8, 12))["action"] == "add_reps"
    # A legacy RIR stored on old sets is ignored: reps at the load decide.
    we = {"sets": [{"kg": 80, "reps": 12, "rir": 0}, {"kg": 80, "reps": 12, "rir": 0}]}
    assert sci.progression(d, bench, we, (8, 12))["action"] == "add_load"


# ------------------------------------------------------------------ actions


def test_set_profile_and_unit_switch():
    d = _fresh()
    out = run(d, "set_profile", {"units": "lb", "bodyweight": 176, "goal": "strength", "experience": "intermediate", "days_per_week": 4, "equipment": ["barbell", "rack", "bench"]})
    st = d["settings"]
    assert st["units"] == "lb" and st["onboarded"] and st["bodyweight_kg"] == pytest.approx(176 * LB, abs=0.01)
    assert st["bar_kg"] == pytest.approx(45 * LB, abs=0.001) and round(st["plates"][0]["kg"] / LB) == 45
    assert "176" in out.summary and out.result["settings"]["bodyweight"] == 176.0
    run(d, "set_profile", {"plates": [45, 25, 10, 5, 2.5], "bar": 35})
    assert sci.to_unit(d["settings"]["bar_kg"], d["settings"]) == 35 and len(d["settings"]["plates"]) == 5
    _refused(d, "set_profile", {}, "Nothing to change")


def _work(d: dict, i: int = 0, kind: str = "working") -> list[dict]:
    """The live workout's sets of one type for its ``i``-th exercise."""
    return [s for s in d["active"]["exercises"][i]["sets"] if s["type"] == kind]


def test_plan_week_stores_no_loads_and_replaces_the_week():
    d = _history(_fresh(bodyweight_kg=80))
    args = {"sessions": [
        {"date": "2026-11-03", "name": "Upper A", "time": "18:00", "exercises": [
            {"exercise": "bench_press", "sets": 3, "reps_min": 6, "reps_max": 8},
            {"exercise": "One-Arm Row (Dumbbell)", "sets": 3, "reps_min": 8, "reps_max": 12},
            {"exercise": "lateral raise", "sets": 3, "reps": 15, "superset": "a"},
        ]},
        {"date": "2026-11-05", "name": "Lower A", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]},
    ]}
    out = run(d, "plan_week", args)
    assert "Planned 2 sessions" in out.summary
    up = next(s for s in d["planned"] if s["name"] == "Upper A")
    bench, row, lat = up["exercises"]
    # Plans hold sets × reps only — never a load, never a calibration note.
    assert all(rx["load_kg"] is None and rx["load_pct"] is None for s in d["planned"] for rx in s["exercises"])
    assert bench.get("target_rir") is None and "rir" not in out.result["sessions"][0]["exercises"][0]
    assert row.get("target_rir") is None and "Calibration" not in row["notes"]
    assert lat["superset"] == "A"
    sess = out.result["sessions"][0]
    assert sess["est_minutes"] > 10 and all("load" not in x for x in sess["exercises"])
    # The logger suggests the load instead: 80 × 10 vs a 6-8 range → via the e1RM.
    run(d, "start_session", {"session_id": up["id"]})
    want = sci.round_load(sci.load_for(sci.e1rm(80, 10, 2), 7, 2), builtin()["bench_press"], d["settings"])
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d, 0)} == {(None, want)}
    assert {s["suggest_kg"] for s in _work(d, 1)} == {None}  # a never-logged row: no guess
    run(d, "discard_session", {})
    # Planning the same week again replaces it.
    run(d, "plan_week", {"sessions": [{"date": "2026-11-04", "name": "Full body", "exercises": [{"exercise": "deadlift", "sets": 2, "reps": 5}]}]})
    assert [s["name"] for s in d["planned"]] == ["Full body"]
    _refused(d, "plan_week", {"program_id": "nope", "sessions": args["sessions"]}, "No program")
    # RIR / RPE targets aren't a thing any more: refused with the fields that are.
    _refused(d, "plan_week", {"sessions": [{"date": "2026-11-04", "exercises": [{"exercise": "bench", "reps": 5, "rir": 2}]}]}, "Unknown field 'rir'")
    _refused(d, "suggest_loads", {"items": [{"exercise": "bench", "reps": 5, "rpe": 8}]}, "Unknown field 'rpe'")
    _refused(d, "plan_week", {"sessions": [{"date": "2026-11-04", "exercises": [{"exercise": "quantum curl"}]}]}, "don't know")


def test_create_program_double_progression_and_deloads():
    d = _history(_fresh(bodyweight_kg=80))
    out = run(d, "create_program", {"name": "Hypertrophy 1", "weeks": 5, "goal": "hypertrophy", "days": [
        {"weekday": 0, "name": "Upper", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10},
                                                      {"exercise": "lateral raise", "sets": 3, "reps_min": 12, "reps_max": 20}]},
        {"weekday": 3, "name": "Lower", "time": "07:00", "exercises": [{"exercise": "squat", "sets": 3, "reps": 8}]},
    ]})
    assert "5 weeks" in out.summary and "deload week 5" in out.summary
    prog = d["programs"][0]
    assert prog["status"] == "active" and [w["deload"] for w in prog["weeks"]] == [False] * 4 + [True]
    uppers = [s for s in d["planned"] if s["name"].startswith("Upper")]
    assert len(uppers) == 5 and uppers[0]["date"] == "2026-11-02" and uppers[1]["date"] == "2026-11-09"
    # No loads in any week: the logger works out each one when it's trained.
    assert all(rx["load_kg"] is None for s in d["planned"] for rx in s["exercises"])
    assert all(rx.get("target_rir") is None for s in d["planned"] for rx in s["exercises"])
    run(d, "start_session", {"session_id": uppers[0]["id"]})
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d)} == {(None, 82.5)}  # 80 × 10, 10, 10 at the top of 8-10 → + the increment
    run(d, "discard_session", {})
    sets_lat = [u["exercises"][1]["sets"] for u in uppers[:4]]
    assert sets_lat[0] == 3 and sets_lat[-1] > 3  # isolation work gains sets
    dl = uppers[4]
    assert dl["deload"] and dl["exercises"][0]["sets"] == 2  # deload: half the sets ...
    assert "lighter" in dl["exercises"][0]["notes"]
    run(d, "start_session", {"session_id": dl["id"]})
    assert d["active"]["deload"] is True and all(s["suggest_kg"] < 80 for s in _work(d))  # ... and lighter than last time
    run(d, "discard_session", {})
    # The old progression name still works.
    run(d, "create_program", {"name": "Old", "weeks": 1, "progression": "rir_ramp", "start_date": "2027-03-01",
                              "days": [{"weekday": 0, "name": "Day", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]}]})
    # A new program finishes the old one; linear keeps the same sets × reps (the logger adds the load).
    run(d, "create_program", {"name": "LP", "weeks": 3, "progression": "linear", "start_date": "2026-12-07",
                              "days": [{"weekday": 0, "name": "Day", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]}]})
    assert d["programs"][0]["status"] == "done"
    lp = [s["exercises"][0] for s in d["planned"] if s.get("program_id") == d["programs"][2]["id"]]
    assert [(rx["sets"], rx["reps_min"], rx["load_kg"]) for rx in lp] == [(3, 5, None)] * 3


def test_routines_and_scheduling():
    d = _fresh()
    out = run(d, "save_routine", {"name": "Push", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 6, "reps_max": 10}, {"exercise": "triceps pushdown", "sets": 3, "reps": 12}]})
    rid = out.result["routine_id"]
    assert d["routines"][0]["exercises"][0].get("load_kg") is None  # left to history
    out = run(d, "schedule_sessions", {"routine_id": rid, "weekdays": [0, 3], "weeks": 2, "start_date": "2026-11-02", "time": "06:30"})
    assert out.result["dates"] == ["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]
    assert all(s["name"] == "Push" and s["time"] == "06:30" for s in d["planned"])
    run(d, "save_routine", {"routine_id": rid, "name": "Push v2", "exercises": [{"exercise": "ohp", "sets": 4, "reps": 6}]})
    assert d["routines"][0]["name"] == "Push v2" and len(d["routines"]) == 1
    _refused(d, "schedule_sessions", {"routine_id": "nope", "dates": ["2026-11-02"]}, "No routine")
    _refused(d, "schedule_sessions", {"routine_id": rid}, "Give dates")
    run(d, "delete_routine", {"routine_id": rid})
    assert d["routines"] == []
    _refused(d, "delete_routine", {"routine_id": rid}, "No routine")


def test_edit_and_delete_sessions():
    d = _fresh()
    run(d, "plan_week", {"sessions": [{"date": "2026-11-03", "name": "Upper", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}, {"exercise": "ohp", "sets": 3, "reps": 8}]}]})
    sid = d["planned"][0]["id"]
    out = run(d, "edit_session", {"session_id": sid, "date": "2026-11-04", "time": "17:30",
                                  "changes": [{"exercise": "bench", "sets": 4, "reps": 6}],
                                  "remove": ["ohp"], "add": [{"exercise": "pull ups", "sets": 3, "reps_min": 5, "reps_max": 8}]})
    s = d["planned"][0]
    assert s["date"] == "2026-11-04" and s["time"] == "17:30" and "moved" in out.summary
    assert [rx["exercise_id"] for rx in s["exercises"]] == ["bench_press", "pullup"]
    assert s["exercises"][0]["sets"] == 4 and s["exercises"][0]["reps_max"] == 6 and s["exercises"][0].get("target_rir") is None
    assert all(rx["load_kg"] is None for rx in s["exercises"])
    _refused(d, "edit_session", {"session_id": sid, "changes": [{"exercise": "bench", "load": 62.5}]}, "Unknown field 'load'")
    _refused(d, "edit_session", {"session_id": sid, "changes": [{"exercise": "deadlift", "sets": 2}]}, "isn't in that session")
    _refused(d, "edit_session", {"session_id": sid}, "Nothing to change")
    _refused(d, "edit_session", {"session_id": "nope", "name": "x"}, "No planned session")
    run(d, "edit_session", {"session_id": sid, "status": "skipped"})
    assert d["planned"][0]["status"] == "skipped"
    run(d, "plan_week", {"replace_existing": False, "sessions": [{"date": "2026-11-20", "exercises": []}, {"date": "2026-11-27", "exercises": []}]})
    out = run(d, "delete_sessions", {"from_date": "2026-11-10", "to_date": "2026-11-30"})
    assert out.result["removed"] == 2 and len(d["planned"]) == 1
    _refused(d, "delete_sessions", {"from_date": "2027-01-01"}, "No sessions matched")
    _refused(d, "delete_sessions", {}, "Say which")


def test_log_workout_from_chat_shorthand_links_the_plan_and_reports_prs():
    d = _history(_fresh())
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Push day", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]}]})
    out = run(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 8, "load": 90}], "duration_min": 50})
    w = d["workouts"][-1]
    assert w["date"] == "2026-11-02" and w["name"] == "Push day" and w["duration_s"] == 3000 and w.get("effort") is None  # no session RPE
    assert [s["kg"] for s in w["exercises"][0]["sets"]] == [90, 90, 90]
    assert d["planned"][0]["status"] == "done" and d["planned"][0]["workout_id"] == w["id"]
    # One headline PR per exercise (e1RM here), the 5RM kept as detail.
    assert "1 PR:" in out.summary and out.result["pr_count"] == 1
    assert [(p["kind"], p["headline"]) for p in out.result["prs"]] == [("e1rm", True), ("5rm", False)]
    # lb, explicit sets, other set types.
    out = run(d, "log_workout", {"date": "2026-11-01", "unit": "lb", "exercises": [
        {"exercise": "deadlift", "sets": [{"load": 135, "reps": 5, "type": "warmup"}, {"load": 315, "reps": 5}]},
        {"exercise": "plank", "sets": [{"seconds": 60}]},
    ]})
    dl = d["workouts"][-2] if d["workouts"][-1]["date"] == "2026-11-02" else d["workouts"][-1]
    sets = next(we for we in dl["exercises"] if we["exercise_id"] == "deadlift")["sets"]
    assert sets[0]["type"] == "warmup" and sets[1]["kg"] == pytest.approx(315 * LB, abs=0.01) and sets[1].get("rir") is None
    assert out.result["prs"] == []  # a first time isn't a record
    _refused(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 2}]}, "needs reps")
    _refused(d, "log_workout", {"exercises": [{"exercise": "flarp", "reps": 3}]}, "don't know")
    wid = d["workouts"][-1]["id"]
    run(d, "delete_workout", {"workout_id": wid})
    assert all(w["id"] != wid for w in d["workouts"]) and d["planned"][0]["status"] == "planned"
    _refused(d, "delete_workout", {"workout_id": wid}, "No workout")


def test_live_session_start_log_finish():
    d = _history(_fresh(bodyweight_kg=80))
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Upper", "exercises": [
        {"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}, {"exercise": "db curl", "sets": 2, "reps": 12}]}]})
    out = run(d, "start_session", {})
    a = d["active"]
    assert "Started Upper" in out.summary and a["session_id"] == d["planned"][0]["id"]
    bench = a["exercises"][0]
    warm = [s for s in bench["sets"] if s.get("type") == "warmup"]
    work = [s for s in bench["sets"] if s.get("type", "working") == "working"]
    assert warm and warm[0]["suggest_kg"] == 20 and warm[0]["kg"] is None
    assert len(work) == 3 and all(not s["done"] for s in bench["sets"])
    assert {(s["kg"], s["suggest_kg"]) for s in work} == {(None, 82.5)}  # 80 × 10 at the top of 8-10 → + the increment
    # A never-logged curl: no suggestion, no warm-ups.
    assert {(s["kg"], s["suggest_kg"]) for s in a["exercises"][1]["sets"]} == {(None, None)}
    assert not any(s["type"] == "warmup" for s in a["exercises"][1]["sets"])
    _refused(d, "start_session", {}, "already running")
    # From chat during the workout: fills the unticked sets (and drops their suggestion).
    run(d, "log_sets", {"exercise": "bench", "set_count": 2, "reps": 10, "load": 82.5})
    work = [s for s in d["active"]["exercises"][0]["sets"] if s["type"] == "working"]
    assert [s["done"] for s in work] == [True, True, False] and work[0]["kg"] == 82.5
    assert work[0]["suggest_kg"] is None and work[2]["suggest_kg"] == 82.5
    run(d, "log_sets", {"exercise": "plank", "sets": [{"seconds": 45}]})
    assert d["active"]["exercises"][-1]["exercise_id"] == "plank"
    out = run(d, "finish_session", {"notes": "felt strong"}, now=NOW + timedelta(minutes=55))
    w = d["workouts"][-1]
    assert d["active"] is None and w["duration_s"] == 55 * 60 and w["notes"] == "felt strong"
    assert len([s for s in w["exercises"][0]["sets"]]) == 2  # unticked sets dropped (warm-ups too)
    assert all(we["exercise_id"] != "db_curl" for we in w["exercises"])  # nothing ticked → gone
    assert d["planned"][0]["status"] == "done" and d["planned"][0]["workout_id"] == w["id"]
    assert "Finished Upper" in out.summary and out.result["duration_min"] == 55
    assert any(p["exercise_id"] == "bench_press" for p in out.result["prs"])
    _refused(d, "finish_session", {}, "No workout is running")


def test_start_empty_or_from_a_routine_finish_needs_a_set_and_discard():
    d = _fresh()
    run(d, "start_session", {"empty": True, "name": "Quick pump"})
    assert d["active"]["exercises"] == [] and d["active"]["name"] == "Quick pump"
    _refused(d, "finish_session", {}, "No sets are ticked")
    run(d, "discard_session")
    assert d["active"] is None
    _refused(d, "discard_session", {}, "No workout")
    rid = run(d, "save_routine", {"name": "Arms", "exercises": [{"exercise": "db curl", "sets": 2, "reps": 10}]}).result["routine_id"]
    run(d, "start_session", {"routine_id": rid})
    assert d["active"]["name"] == "Arms" and len(d["active"]["exercises"][0]["sets"]) == 2
    # log_sets with no live session and no workout today makes one.
    run(d, "discard_session")
    run(d, "log_sets", {"exercise": "pushup", "set_count": 3, "reps": 20})
    assert d["workouts"][-1]["date"] == "2026-11-02" and len(d["workouts"][-1]["exercises"][0]["sets"]) == 3
    run(d, "log_sets", {"exercise": "pushup", "reps": 15})
    assert len(d["workouts"]) == 1 and len(d["workouts"][-1]["exercises"][0]["sets"]) == 4


def test_swap_exercise_everywhere():
    d = _history(_fresh(bodyweight_kg=80))
    run(d, "create_program", {"name": "B", "weeks": 2, "days": [{"weekday": 1, "name": "Day", "exercises": [{"exercise": "ohp", "sets": 3, "reps": 8}]}]})
    out = run(d, "swap_exercise", {"from_exercise": "ohp", "to_exercise": "landmine press"})
    assert out.result["swapped"] == 2
    assert all(s["exercises"][0]["exercise_id"] == "landmine_press" and s["exercises"][0]["load_kg"] is None for s in d["planned"])
    run(d, "start_session", {"session_id": d["planned"][0]["id"]})
    run(d, "swap_exercise", {"from_exercise": "landmine press", "to_exercise": "db shoulder press", "scope": "active"})
    assert d["active"]["exercises"][0]["exercise_id"] == "db_shoulder_press"
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d)} == {(None, None)}  # never logged: no guess
    _refused(d, "swap_exercise", {"from_exercise": "ohp", "to_exercise": "ohp"}, "same exercise")
    _refused(d, "swap_exercise", {"from_exercise": "deadlift", "to_exercise": "rdl", "scope": "active"}, "isn't in")


def test_custom_exercises():
    d = _fresh()
    out = run(d, "add_custom_exercise", {"name": "Sandbag Clean", "primary": ["glutes", "hamstrings"], "secondary": ["traps"], "equipment": "bodyweight", "pattern": "olympic", "log": "weight_reps", "compound": True})
    eid = out.result["exercise_id"]
    assert eid == "c_sandbag_clean" and sci.find_exercise(d, "sandbag clean")["id"] == eid
    _refused(d, "add_custom_exercise", {"name": "sandbag clean", "primary": ["glutes"]}, "already in the library")
    _refused(d, "add_custom_exercise", {"name": "Bench Press (Barbell)", "primary": ["chest"]}, "already")
    run(d, "log_workout", {"exercises": [{"exercise": eid, "set_count": 3, "reps": 5, "load": 40}]})
    out = run(d, "delete_custom_exercise", {"exercise": eid})
    assert "Archived" in out.summary and d["exercises"][0]["archived"]
    run(d, "add_custom_exercise", {"name": "Tyre Flip", "primary": ["glutes"]})
    run(d, "delete_custom_exercise", {"exercise": "Tyre Flip"})
    assert [c["name"] for c in d["exercises"]] == ["Sandbag Clean"]
    _refused(d, "delete_custom_exercise", {"exercise": "bench"}, "built in")


def test_list_exercises_respects_equipment_and_avoid():
    d = _fresh(equipment=["dumbbell", "bench", "pullup_bar"], avoid_exercises=["pullup"])
    res = run(d, "list_exercises", {"muscle": "lats"}).result
    ids = [e["id"] for e in res["exercises"]]
    assert "db_row" in ids and "lat_pulldown" not in ids and "barbell_row" not in ids
    assert ids[-1] == "pullup" or next(e for e in res["exercises"] if e["id"] == "pullup").get("avoid")
    every = run(d, "list_exercises", {"query": "row", "available_only": False, "limit": 200}).result
    assert {"barbell_row", "seated_cable_row", "db_row"} <= {e["id"] for e in every["exercises"]}


def test_read_only_analysis_actions():
    d = _history(_fresh(bodyweight_kg=80))
    prog = run(d, "get_progress", {"exercise": "bench"}).result
    assert len(prog["sessions"]) == 2 and prog["sessions"][-1]["best_set"] == "80 kg × 10"
    assert prog["e1rm_change_pct"] > 0 and prog["records"]["10rm"]["value"] == "80 kg"
    assert run(d, "get_progress", {"exercise": "deadlift"}).result["sessions"] == []
    prs = run(d, "get_prs").result["records"]
    assert "Bench Press (Barbell)" in prs and "Bent-Over Row (Barbell)" in prs
    vol = run(d, "weekly_volume_by_muscle", {"week_of": "2026-10-28"}).result["weeks"][0]
    assert vol["week_of"] == "2026-10-26" and vol["muscles"]["chest"]["sets"] == 6 and vol["muscles"]["chest"]["status"] == "below_mev"
    run(d, "plan_week", {"sessions": [{"date": "2026-11-03", "exercises": [{"exercise": "bench", "sets": 10, "reps": 8}]}]})
    planned = run(d, "weekly_volume_by_muscle", {"source": "planned"}).result["weeks"][0]
    assert planned["muscles"]["chest"]["sets"] == 10
    sug = run(d, "suggest_loads", {"items": [{"exercise": "bench", "reps": 5}, {"exercise": "squat", "reps": 5}, {"exercise": "pull-up", "reps": 8}]}).result["suggestions"]
    assert sug[0]["basis"] == "recent" and sug[0]["load"].endswith(" kg") and sug[0]["plates_per_side"]
    assert sug[0]["last"]["sets"][0] == {"kg": 80.0, "reps": 10}
    assert sug[1]["calibrate"] is True and "rir" not in sug[1] and "RIR" not in sug[1]["note"]
    assert "added weight" in sug[2]["note"]  # pull-ups: the load is added weight
    pm = run(d, "plate_math", {"load": 100}).result
    assert pm["per_side"] == [25.0, 15.0] and pm["loaded"] == "100 kg" and pm["warmups"]
    summ = run(d, "get_summary").result
    assert summ["total_workouts"] == 2 and summ["workouts_per_week_last_8"][1] == 2 and summ["week_streak"] == 1
    assert summ["next_session"]["date"] == "2026-11-03"


def test_actions_are_deterministic_for_the_same_input():
    a = _history(_fresh())
    b = copy.deepcopy(a)
    args = {"sessions": [{"date": "2026-11-03", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]}]}
    run(a, "plan_week", args)
    run(b, "plan_week", args)
    assert a == b
    run(a, "start_session", {"session_id": a["planned"][0]["id"]})
    run(b, "start_session", {"session_id": b["planned"][0]["id"]})
    assert a["active"] == b["active"]


def test_planned_list_makes_room_by_dropping_old_sessions():
    d = _fresh()
    d["planned"] = [{"id": f"o{i}", "date": (date(2024, 1, 1) + timedelta(days=i)).isoformat(), "status": "done"} for i in range(600)]
    d = SPEC.validate(d)
    run(d, "plan_week", {"sessions": [{"date": "2026-11-03", "exercises": []}]})
    assert len(d["planned"]) == 600 and d["planned"][-1]["date"] == "2026-11-03" and d["planned"][0]["id"] == "o1"


# ---------------------------------------------------------- text & reminders


def test_to_text_has_the_facts_newest_first():
    soon = (date.today() + timedelta(days=1)).isoformat()
    d = _history(_fresh(bodyweight_kg=80, injuries="left knee — no deep lunges"))
    run(d, "plan_week", {"sessions": [{"date": soon, "name": "Upper A", "exercises": [{"exercise": "bench", "sets": 3, "reps": 5}]}]})
    run(d, "start_session", {"empty": True, "name": "Arms"})
    t = to_text(d)
    assert "left knee" in t and "bodyweight 80 kg" in t
    assert "IN PROGRESS: Arms" in t and f"{soon} Upper A: Bench Press (Barbell) 3×5" in t
    assert "Bench Press (Barbell) 3×5 @" not in t  # plans carry no load
    assert t.index("2026-10-29") < t.index("2026-10-26")  # newest first
    assert "80×10" in t and "RIR" not in t and "Best estimated 1RMs" in t
    big = _fresh()
    big["workouts"] = [{"id": f"w{i}", "date": (date(2020, 1, 1) + timedelta(days=i)).isoformat(), "name": "Session",
                        "exercises": [{"id": "e", "exercise_id": "bench_press", "sets": [{"id": f"t{j}", "kg": 60, "reps": 8} for j in range(5)]}]} for i in range(400)]
    assert len(to_text(SPEC.validate(big))) <= 20_000


def test_reminders_before_sessions():
    d = _fresh(reminder_time="07:15", remind_before_min=45)
    run(d, "plan_week", {"replace_existing": False, "sessions": [
        {"date": "2026-11-02", "name": "Too late today", "exercises": []},   # 07:15 already passed
        {"date": "2026-11-02", "name": "Evening", "time": "18:00", "exercises": [{"exercise": "bench", "sets": 3, "reps": 5}]},
        {"date": "2026-11-04", "name": "Legs", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]},
        {"date": "2026-11-30", "name": "Far away", "exercises": []},
    ]})
    rs = reminders(d, _ctx())
    by = {r.title: r for r in rs}
    assert set(by) == {"Evening at 18:00", "Legs today"}
    assert by["Evening at 18:00"].due_at == datetime(2026, 11, 2, 17, 15, tzinfo=TZ)
    assert by["Legs today"].due_at == datetime(2026, 11, 4, 7, 15, tzinfo=TZ)
    assert "Back Squat (Barbell) 3×5" in by["Legs today"].body and "~" in by["Legs today"].body
    assert "@" not in by["Legs today"].body  # no load in a plan, so none in its reminder
    # Moving a session changes its key (so it's sent again); done ones are quiet.
    keys = {r.key for r in rs}
    legs = next(s for s in d["planned"] if s["name"] == "Legs")
    run(d, "edit_session", {"session_id": legs["id"], "date": "2026-11-05"})
    assert {r.key for r in reminders(d, _ctx())} != keys
    legs = next(s for s in d["planned"] if s["name"] == "Legs")
    legs["status"] = "done"
    assert "Legs today" not in {r.title for r in reminders(d, _ctx())}
    d["settings"]["reminders"] = False
    assert reminders(d, _ctx()) == []
    # A live session left open gets a nudge (even with session reminders off).
    run(d, "start_session", {"empty": True})
    assert [r.key.split(":")[0] for r in reminders(d, _ctx())] == ["active"]
    d["active"]["started_at"] = "2026-11-02T09:00:00"  # naive (an old client) still works
    assert reminders(d, _ctx())[0].due_at == datetime(2026, 11, 2, 12, 0, tzinfo=TZ)


# --------------------------------------------------------------- AI tools


def test_tools_have_no_refs_and_cover_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    for a in SPEC.actions:
        assert a.name in names
    assert {"read_other_item", "update_data", "read_data"} <= names and "web_search" not in names
    assert "refit_upcoming_loads" not in names and SPEC.action("refit_upcoming_loads") is None  # plans hold no loads to re-fit
    # No action that writes a plan takes a load any more.
    plan_args = json.dumps([t["function"]["parameters"] for t in tools if t["function"]["name"] in
                            {"plan_week", "create_program", "save_routine", "schedule_sessions", "edit_session"}])
    assert '"load"' not in plan_args and '"load_pct"' not in plan_args and '"fill_loads"' not in plan_args
    assert "$ref" not in json.dumps(tools)
    reader = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "plan_week" not in reader and {"suggest_loads", "get_progress", "weekly_volume_by_muscle"} <= reader
    other = next(t for t in tools if t["function"]["name"] == "read_other_item")
    assert set(other["function"]["parameters"]["properties"]["kind"]["enum"]) == {"health", "meals"}
    assert SPEC.kind == "workout" and SPEC.suffix == ".workout" and SPEC.color == "#E2725B" and SPEC.icon == "dumbbell"
    assert SPEC.category == "Health & fitness" and 5 <= len(SPEC.highlights) <= 8 and 4 <= len(SPEC.ai_suggestions) <= 6
    assert "sets × reps × load" not in SPEC.ai_brief and "never weights" in SPEC.ai_brief
    for word in ("sets × reps", "MEV", "MRV", "deload", "double progression", "medical"):
        assert word.lower() in SPEC.ai_brief.lower()


# ------------------------------------------------------------- API flows


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


async def _new_file(client, user) -> dict:
    r = await client.post("/api/items/store/workout", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "workout", "title": "Training"})
    assert r.status_code == 201, r.text
    return r.json()


async def test_end_to_end_api_flow(client, db, user):
    store = (await client.get("/api/items/store", headers=_auth(user))).json()["items"]
    entry = next(i for i in store if i["kind"] == "workout")
    assert "Strong/Hevy" in entry["replaces"] and "import" in entry["description"] and entry["color"] == "#E2725B"
    item = await _new_file(client, user)
    fid = item["file_id"]
    assert item["filename"] == "Training.workout" and item["data"]["settings"]["onboarded"] is False
    cat = await client.get("/api/items/k/workout/catalog", headers=_auth(user))
    assert cat.status_code == 200 and len(cat.json()["exercises"]) >= 150
    assert (await client.get("/api/items/k/workout/catalog")).status_code == 401
    r = await client.post(f"/api/items/{fid}/actions/set_profile", headers=_auth(user), json={"args": {"bodyweight": 82, "goal": "strength"}})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/actions/log_workout", headers=_auth(user),
                          json={"args": {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 8, "load": 80}]}})
    assert r.status_code == 200 and "Logged" in r.json()["summary"]
    tomorrow = (datetime.now(ZoneInfo("UTC")).date() + timedelta(days=1)).isoformat()
    r = await client.post(f"/api/items/{fid}/actions/plan_week", headers=_auth(user),
                          json={"args": {"sessions": [{"date": tomorrow, "name": "Heavy", "exercises": [{"exercise": "bench", "sets": 5, "reps": 5}]}]}})
    assert r.status_code == 200, r.text
    planned = r.json()["data"]["planned"][0]
    assert planned["exercises"][0].get("load_kg") is None  # plans never carry a load
    r = await client.post(f"/api/items/{fid}/actions/suggest_loads", headers=_auth(user), json={"args": {"items": [{"exercise": "bench", "reps": 3}]}})
    assert r.status_code == 200 and r.json()["result"]["suggestions"][0]["basis"] == "recent"
    r = await client.post(f"/api/items/{fid}/actions/edit_session", headers=_auth(user), json={"args": {"session_id": "nope", "name": "x"}})
    assert r.status_code == 400 and "No planned session" in r.json()["detail"]
    # The UI's own edits (the live logger saves this way).
    data = r = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    body = data["data"]
    body["active"] = {"id": "live1", "name": "Quick", "date": tomorrow, "started_at": datetime.now(ZoneInfo("UTC")).isoformat(),
                      "exercises": [{"id": "e1", "exercise_id": "db_curl", "sets": [{"id": "s1", "kg": 12, "reps": 10, "done": True}]}]}
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": data["revision"]})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["active"]["exercises"][0]["sets"][0] == {"id": "s1", "kg": 12.0, "reps": 10, "done": True}
    bad = dict(body, settings={**body["settings"], "goal": "be huge"})
    assert (await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": bad, "base_revision": r.json()["revision"]})).status_code == 400
    r = await client.post(f"/api/items/{fid}/actions/finish_session", headers=_auth(user), json={"args": {}})
    assert r.status_code == 200 and r.json()["data"]["active"] is None and len(r.json()["data"]["workouts"]) == 2
    # Searchable text and reminders follow the data.
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.files.models import UserFile
    from app.items.models import ItemReminder

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Bench Press (Barbell)" in row.content_text and "Heavy" in row.content_text
        rems = (await s.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
        assert any(r.title.startswith("Heavy") for r in rems)


class _FakeModel:
    def __init__(self, hops):
        self.hops = list(hops)
        self.calls = []

    async def stream_chat_events(self, **kw):
        from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

        self.calls.append(kw)
        hop = self.hops.pop(0) if self.hops else {"text": "done"}
        if hop.get("text"):
            yield TextDelta(text=hop["text"])
        for i, (name, args) in enumerate(hop.get("tools", [])):
            yield ToolCallDelta(index=i, id=f"call{i}{len(self.calls)}", name=name, arguments=json.dumps(args))
        yield FinishEvent(reason="tool_calls" if hop.get("tools") else "stop")


async def test_the_coach_plans_a_week_from_the_ai_panel(client, db, user, monkeypatch):
    from app.items import ai
    from app.models_config import provider as prov

    item = await _new_file(client, user)
    fid = item["file_id"]
    await client.post(f"/api/items/{fid}/actions/log_workout", headers=_auth(user),
                      json={"args": {"date": "2026-01-05", "exercises": [{"exercise": "squat", "set_count": 3, "reps": 5, "load": 100}]}})
    day = (datetime.now(ZoneInfo("UTC")).date() + timedelta(days=2)).isoformat()
    fake = _FakeModel([
        {"tools": [("read_other_item", {"kind": "health"}), ("suggest_loads", {"items": [{"exercise": "squat", "reps": 5}]})]},
        {"tools": [("plan_week", {"sessions": [{"date": day, "name": "Lower", "exercises": [{"exercise": "squat", "sets": 5, "reps": 5}]}]})]},
        {"text": "Planned Lower: squats 5×5 (about 100 kg, from last time)."},
    ])
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "plan my week", object(), "m", can_edit=True)]
    acts = [e for e in events if e["type"] == "action"]
    assert [a["ok"] for a in acts] == [True] and "Planned 1 session" in acts[0]["summary"]
    done = events[-1]
    assert done["type"] == "done" and done["changed"] and done["version_id"]
    lower = done["data"]["planned"][0]
    assert lower["exercises"][0].get("load_kg") is None and lower["exercises"][0]["sets"] == 5  # sets × reps only
    system = fake.calls[0]["system"]
    assert "double progression" in system.lower() and '"workouts"' in system
    tool_msgs = [m["content"] for m in fake.calls[1]["messages"] if m.get("role") == "tool"]
    assert any("health" in m for m in tool_msgs) and any("e1rm" in m for m in tool_msgs)
    assert any("100 kg" in m for m in tool_msgs)  # suggest_loads still answers "what should I lift": 100×5 → 100 for 5 again


# ------------------------------------------------------------ fix pass


def _log(d: dict, day: str, ex: str, sets: list[tuple[float, int]], **kw) -> None:
    run(d, "log_workout", {"date": day, "exercises": [{"exercise": ex, "sets": [{"load": kg, "reps": r} for kg, r in sets]}], **kw})


def _svc_run(data: dict, name: str, args: dict):
    from app.items import service

    return asyncio.run(service.run_action(_ctx(), SPEC, data, name, args))


def test_working_sets_are_not_read_as_failure():
    d = _fresh(bodyweight_kg=80)
    bench = builtin()["bench_press"]
    _log(d, "2026-10-29", "bench", [(80, 5)] * 3)
    # A different rep range goes through the e1RM, read with the 2-rep margin, not as a max.
    s = sci.next_load(d, bench, 10, 12, today=NOW.date())
    assert s["basis"] == "e1rm"
    assert s["load_kg"] == sci.round_load(sci.load_for(sci.e1rm(80, 5, 2), 11, 2), bench, d["settings"])
    assert s["load_kg"] > sci.round_load(sci.load_for(sci.e1rm(80, 5, 0), 11, 2), bench, d["settings"])
    one, _ = sci.recent_e1rm(d, bench, today=NOW.date())
    assert one == pytest.approx(sci.e1rm(80, 5, 2), abs=0.1)
    # A set marked to failure gets no margin; a legacy stored RIR is ignored;
    # records keep the strict reading.
    assert sci.set_e1rm({"kg": 80, "reps": 5, "type": "failure"}, bench, d["settings"], 2) == pytest.approx(sci.e1rm(80, 5, 0))
    assert sci.set_e1rm({"kg": 80, "reps": 5, "rir": 4}, bench, d["settings"]) == pytest.approx(sci.e1rm(80, 5))
    assert sci.records(d)["bench_press"]["e1rm"]["value"] == pytest.approx(sci.e1rm(80, 5, 0), abs=0.1)


def test_planning_uses_double_progression_not_a_regressing_back_calc():
    d = _fresh(bodyweight_kg=80)
    _log(d, "2026-10-29", "bench", [(80, 10)] * 3)  # the top of 8-10
    args = {"sessions": [{"date": "2026-11-03", "name": "Upper", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]}
    run(d, "plan_week", args)
    run(d, "start_session", {"session_id": d["planned"][0]["id"]})
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d)} == {(None, 82.5)}  # 80 x 10 -> + the increment (was 77.5)
    # Short of the top: same load, beat the reps.
    d2 = _fresh(bodyweight_kg=80)
    _log(d2, "2026-10-29", "bench", [(80, 10), (80, 9), (80, 8)])
    run(d2, "plan_week", args)
    run(d2, "start_session", {"session_id": d2["planned"][0]["id"]})
    assert {s["suggest_kg"] for s in _work(d2)} == {80}
    # 10 reps against a 6-8 range is out of range -> via the e1RM, upward.
    out = sci.next_load(d2, builtin()["bench_press"], 6, 8, today=NOW.date())
    assert out["basis"] == "e1rm" and out["load_kg"] >= 80
    # create_program and swap_exercise fill the same way.
    d3 = _fresh(bodyweight_kg=80)
    _log(d3, "2026-10-29", "bench", [(80, 10)] * 3)
    run(d3, "create_program", {"name": "B", "weeks": 2, "progression": "none", "days": [{"weekday": 2, "name": "Day", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]})
    assert d3["planned"][0]["exercises"][0]["load_kg"] is None
    run(d3, "start_session", {"session_id": d3["planned"][0]["id"]})
    assert {s["suggest_kg"] for s in _work(d3)} == {82.5}
    run(d3, "discard_session", {})
    _log(d3, "2026-10-30", "incline bench", [(60, 10)] * 3)
    run(d3, "plan_week", {"sessions": [{"date": "2026-11-06", "name": "Push", "exercises": [{"exercise": "ohp", "sets": 3, "reps_min": 8, "reps_max": 10}]}], "replace_existing": False})
    push = next(s for s in d3["planned"] if s["name"] == "Push")
    push["exercises"][0]["load_kg"] = 40  # a legacy planned load for the old lift ...
    run(d3, "swap_exercise", {"from_exercise": "ohp", "to_exercise": "incline bench", "scope": "session", "session_id": push["id"]})
    push = next(s for s in d3["planned"] if s["name"] == "Push")
    assert push["exercises"][0]["load_kg"] is None  # ... means nothing for the new one
    run(d3, "start_session", {"session_id": push["id"]})
    assert {s["suggest_kg"] for s in _work(d3)} == {62.5}
    # A long break: no blind progression off a session from months ago.
    d4 = _fresh(bodyweight_kg=80)
    _log(d4, "2026-05-01", "bench", [(80, 10)] * 3)
    assert sci.next_load(d4, builtin()["bench_press"], 8, 10, today=NOW.date())["basis"] == "e1rm"


def test_progression_skips_a_deload_week():
    d = _fresh(bodyweight_kg=80)
    bench = builtin()["bench_press"]
    _log(d, "2026-10-20", "bench", [(80, 10)] * 3)
    run(d, "plan_week", {"sessions": [{"date": "2026-10-27", "name": "Deload", "deload": True, "exercises": [{"exercise": "bench", "sets": 2, "reps": 8}]}], "replace_existing": False})
    _log(d, "2026-10-27", "bench", [(70, 8)] * 2)
    w = d["workouts"][-1]
    assert w["deload"] is True and sci.is_deload(d, w)
    assert sci.last_session(d, bench)[0]["date"] == "2026-10-20"
    assert sci.next_load(d, bench, 8, 10, today=NOW.date())["load_kg"] == 82.5
    # Without a non-deload session to go on, the deload one still counts.
    d2 = _fresh(bodyweight_kg=80)
    d2["workouts"] = [{"id": "w1", "date": "2026-10-27", "deload": True, "exercises": [{"id": "e", "exercise_id": "bench_press", "sets": [{"id": "t", "kg": 70, "reps": 8}]}]}]
    assert sci.last_session(expand(SPEC.validate(d2)), bench)[0]["id"] == "w1"


def test_logger_prefers_the_better_of_plan_and_progression():
    d = _fresh(bodyweight_kg=80)
    _log(d, "2026-10-29", "bench", [(80, 10)] * 3)
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Upper", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]})
    rx = d["planned"][0]["exercises"][0]
    rx["load_kg"] = 75  # a legacy planned load (old files): stored data, no action writes one now
    run(d, "start_session", {})
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d)} == {(None, 82.5)}
    run(d, "discard_session", {})
    # A heavier plan wins; a deload keeps its planned load.
    d["planned"][0]["exercises"][0]["load_kg"] = 90
    run(d, "start_session", {})
    assert _work(d)[0]["suggest_kg"] == 90 and _work(d)[0]["kg"] is None
    run(d, "discard_session", {})
    d["planned"][0]["deload"] = True
    d["planned"][0]["exercises"][0]["load_kg"] = 70
    run(d, "start_session", {})
    assert d["active"]["deload"] is True
    assert _work(d)[0]["suggest_kg"] == 70


def test_landmark_labels():
    assert sci.landmark_status("chest", 6) == "below_mev"
    assert sci.landmark_status("chest", 10) == "productive"
    assert sci.landmark_status("chest", 14) == "in_mav"
    assert sci.landmark_status("chest", 20) == "in_mav"
    assert sci.landmark_status("triceps", 15) == "above_mav"  # MAV 10-14, MRV 18
    assert sci.landmark_status("triceps", 17) == "near_mrv"
    assert sci.landmark_status("triceps", 19) == "above_mrv"
    assert sci.landmark_status("front_delts", 0) == "none"


def test_compact_storage_and_actions_on_compact_data():
    d = _history(_fresh(bodyweight_kg=80))
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Upper", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]})
    run(d, "start_session", {})
    run(d, "log_sets", {"exercise": "bench", "set_count": 3, "reps": 10, "load": 82.5})
    run(d, "finish_session", {}, now=NOW + timedelta(minutes=50))
    stored = SPEC.validate(d)
    w = stored["workouts"][-1]
    we = w["exercises"][0]
    assert all("done" not in s and "at" not in s and "type" not in s for s in we["sets"])
    assert set(we["rx"]) <= {"id", "exercise_id", "sets", "reps_min", "reps_max", "load_kg"}
    assert "notes" not in w and "rest_until" not in w and "superset" not in we
    rx = stored["planned"][0]["exercises"][0]
    assert "notes" not in rx and "load_pct" not in rx and "drop_sets" not in rx
    assert len(json.dumps(stored)) < len(json.dumps(expand(stored))) * 0.8
    # Compact data reads back the same, and actions work on it.
    assert expand(stored) == expand(expand(stored))
    raw = copy.deepcopy(stored)
    assert _svc_run(raw, "get_progress", {"exercise": "bench"}).result["sessions"]
    raw = copy.deepcopy(stored)
    _svc_run(raw, "start_session", {"empty": True})
    assert raw["active"] and SPEC.validate(raw)
    assert "Bench Press" in to_text(stored) and reminders(stored, _ctx()) is not None


def test_archive_moves_old_workouts_and_keeps_the_rest():
    d = _history(_fresh(bodyweight_kg=80))
    run(d, "add_custom_exercise", {"name": "Sandbag Carry", "primary": ["traps"], "log": "distance"})
    run(d, "save_routine", {"name": "Push", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]})
    run(d, "log_workout", {"date": "2026-11-01", "exercises": [{"exercise": "Sandbag Carry", "sets": [{"meters": 40}]}]})
    run(d, "plan_week", {"sessions": [{"date": "2026-11-04", "name": "Next", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]}]})
    kept, archived = SPEC.archive(SPEC.validate(d), _ctx(), "2026-10-30")
    kept, archived = SPEC.validate(kept), SPEC.validate(archived)
    assert [w["date"] for w in kept["workouts"]] == ["2026-11-01"]
    assert [w["date"] for w in archived["workouts"]] == ["2026-10-26", "2026-10-29"]
    assert kept["routines"] and kept["exercises"] and kept["planned"] and kept["settings"]["bodyweight_kg"] == 80
    assert archived["exercises"] and archived["settings"]["units"] == "kg" and archived["settings"]["reminders"] is False
    assert archived["active"] is None and not archived["routines"]
    assert "Bench Press (Barbell)" in to_text(archived)
    with pytest.raises(ActionError):
        SPEC.archive(SPEC.validate(d), _ctx(), "2020-01-01")


def test_a_full_file_is_explained_not_silent():
    d = _fresh()
    w = {"id": "w", "date": "2026-01-01", "exercises": [{"id": "e", "exercise_id": "plank", "sets": [{"id": "t", "seconds": 30}]}]}
    d["workouts"] = [dict(w, id=f"w{k}") for k in range(2500)]
    d = expand(SPEC.validate(d))
    run(d, "start_session", {"empty": True})
    run(d, "log_sets", {"exercise": "plank", "seconds": 40})
    _refused(d, "finish_session", {}, "Archive")
    assert d["active"] is not None  # nothing lost
    _refused(d, "log_workout", {"exercises": [{"exercise": "plank", "seconds": 30}]}, "Archive")


def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = _fresh()
    run(d, "plan_week", {"sessions": [
        {"date": "2026-11-02", "name": "Old one", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]},
        {"date": "2026-11-05", "name": "New one", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]},
    ]})
    token = _TEXT_NOW.set(datetime(2026, 11, 4, 8, 0, tzinfo=TZ))
    try:
        text = to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    assert "Today is 2026-11-04" in text
    assert "Missed (planned, not done): 2026-11-02 Old one" in text
    nxt = text.split("Planned sessions (next):")[1]
    assert "New one" in nxt and "Old one" not in nxt


def test_unit_switch_converts_ez_and_trap_bars():
    d = _fresh()
    run(d, "set_profile", {"units": "lb"})
    st = d["settings"]
    assert round(st["ez_bar_kg"] / LB) == 25 and round(st["trap_bar_kg"] / LB) == 55
    run(d, "set_profile", {"units": "kg"})
    assert d["settings"]["ez_bar_kg"] == 10 and d["settings"]["trap_bar_kg"] == 25
    run(d, "set_profile", {"ez_bar": 8, "trap_bar": 27})
    assert d["settings"]["ez_bar_kg"] == 8 and d["settings"]["trap_bar_kg"] == 27
    run(d, "set_profile", {"units": "lb"})  # a custom bar keeps its weight
    assert d["settings"]["ez_bar_kg"] == 8


async def test_archive_through_the_api(client, db, user):
    item = await _new_file(client, user)
    fid = item["file_id"]
    for day in ("2026-01-05", "2026-06-01"):
        r = await client.post(f"/api/items/{fid}/actions/log_workout", headers=_auth(user),
                              json={"args": {"date": day, "exercises": [{"exercise": "bench", "set_count": 3, "reps": 8, "load": 80}]}})
        assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/archive", headers=_auth(user), json={"before": "2026-03-01"})
    assert r.status_code == 200, r.text
    assert [w["date"] for w in r.json()["data"]["workouts"]] == ["2026-06-01"]
    arch = (await client.get(f"/api/items/{r.json()['archive_id']}", headers=_auth(user))).json()
    assert [w["date"] for w in arch["data"]["workouts"]] == ["2026-01-05"]
    r = await client.post(f"/api/items/{fid}/archive", headers=_auth(user), json={"before": "2025-01-01"})
    assert r.status_code == 400 and "No workouts before" in r.json()["detail"]


# ------------------------------------------------------------ audit (fix pass)


def _w(day: str, eid: str, sets: list[tuple], wid: str | None = None, **extra) -> dict:
    """A finished workout: sets as (kg, reps) or (kg, reps, type)."""
    return {"id": wid or f"w{day}{eid}", "date": day, "started_at": f"{day}T10:00:00+00:00", **extra,
            "exercises": [{"id": f"e{day}{eid}", "exercise_id": eid,
                           "sets": [{"id": f"t{i}", "kg": s[0], "reps": s[1], **({"type": s[2]} if len(s) > 2 else {})} for i, s in enumerate(sets)]}]}


def _with(*workouts, **settings) -> dict:
    d = _fresh(**settings)
    d["workouts"] = list(workouts)
    return expand(SPEC.validate(d))


def test_assisted_lifts_progress_by_taking_assistance_away():
    cat = builtin()
    ap = cat["assisted_pullup"]
    # Every set at the top of 8–10 with 30 kg of help → the next step LESS help.
    d = _with(_w("2026-10-29", "assisted_pullup", [(30, 10), (30, 10), (30, 10)]))
    nl = sci.next_load(d, ap, 8, 10, today=NOW.date())
    assert nl["basis"] == "progression" and nl["load_kg"] == 25 and nl["action"] == "less_assist"
    # Not there yet → same assistance, beat the reps.
    d2 = _with(_w("2026-10-29", "assisted_pullup", [(30, 10), (30, 9), (30, 8)]))
    assert sci.next_load(d2, ap, 8, 10, today=NOW.date())["load_kg"] == 30
    # A plan written with more help than they now need doesn't hold them back
    # (the logger starts at the LESS assisted of plan and progression).
    assert sci.prefill(d, ap, {"reps_min": 8, "reps_max": 10, "load_kg": 30}, today=NOW.date()) == 25
    assert sci.prefill(d, ap, {"reps_min": 8, "reps_max": 10, "load_kg": 20}, today=NOW.date()) == 20
    # A deload gives MORE assistance; a drop set too.
    assert sci.prefill(d, ap, {"reps_min": 8, "reps_max": 10}, today=NOW.date(), deload=True) > 30
    from app.items.kinds.workout.actions import drop_load
    assert drop_load(30, ap, d["settings"]) > 30


def test_assisted_records_reward_less_help_not_more_reps():
    d = _with(_w("2026-10-20", "assisted_pullup", [(30, 8), (30, 8)]))
    rec = sci.records(d, "assisted_pullup")["assisted_pullup"]
    assert rec["least_assist"]["value"] == 30 and rec["max_reps"]["value"] == 8
    # 12 reps with MORE help: no record of any kind.
    easier = _w("2026-10-27", "assisted_pullup", [(45, 12)])
    assert sci.new_records(d, easier) == []
    # Less help: the least-assistance PR, headlined.
    harder = _w("2026-10-27", "assisted_pullup", [(25, 6)])
    prs = sci.new_records(d, harder)
    assert [(p["kind"], p["headline"]) for p in prs] == [("least_assist", True)]
    # And then more reps at that new level is a "most reps" record.
    d = _with(d["workouts"][0], harder)
    prs = sci.new_records(d, _w("2026-11-01", "assisted_pullup", [(25, 9)]))
    assert [p["kind"] for p in prs] == ["max_reps"]


def test_weighted_and_plain_bodyweight_progression():
    pu = builtin()["pullup"]
    # +10 kg × 8 on every set at the top of 6–8 → add the smallest load step.
    d = _with(_w("2026-10-29", "pullup", [(10, 8), (10, 8), (10, 8)]))
    nl = sci.next_load(d, pu, 6, 8, today=NOW.date())
    assert nl["action"] == "add_load" and nl["load_kg"] == 11.25
    # Plain bodyweight at the top of the range → more reps / harder variation, no phantom load.
    d = _with(_w("2026-10-29", "pullup", [(None, 12), (None, 12)]))
    p = sci.progression(d, pu, d["workouts"][0]["exercises"][0], (8, 12))
    assert p["action"] == "add_reps" and p["load_kg"] == 0 and "harder variation" in p["why"]


def test_timed_lifts_progress_time_not_reps():
    plank = builtin()["plank"]
    d = _fresh()
    p = sci.progression(d, plank, {"sets": [{"seconds": 60}, {"seconds": 55}]}, (1, 1))
    assert p["action"] == "add_time" and p["seconds"] == 65


def test_repeated_failure_resets_the_load():
    bench = builtin()["bench_press"]
    one_bad = _w("2026-10-26", "bench_press", [(100, 7), (100, 6), (100, 6)])
    # One bad day at 8–10: keep the load (no reset).
    d = _with(one_bad)
    nl = sci.next_load(d, bench, 8, 10, today=NOW.date())
    assert nl["basis"] == "progression" and nl["load_kg"] == 100
    # Two sessions running short of 8 without gaining a rep → reset ~10%.
    d = _with(one_bad, _w("2026-10-29", "bench_press", [(100, 7), (100, 6), (100, 5)]))
    nl = sci.next_load(d, bench, 8, 10, today=NOW.date())
    assert nl["basis"] == "reset" and nl["load_kg"] == 90 and "Stalled" in nl["why"]
    # ... and the logger takes the reset over a plan that asks for 100 again.
    assert sci.prefill(d, bench, {"reps_min": 8, "reps_max": 10, "load_kg": 100}, today=NOW.date()) == 90
    # Short of the range but gaining reps: still progressing, no reset.
    d = _with(one_bad, _w("2026-10-29", "bench_press", [(100, 7), (100, 7), (100, 7)]))
    assert sci.next_load(d, bench, 8, 10, today=NOW.date())["load_kg"] == 100
    # Three sessions in the range at the same load with no reps gained → reset.
    flat = [_w(f"2026-10-{day}", "bench_press", [(100, 9), (100, 8), (100, 8)]) for day in (20, 23, 27)]
    d = _with(*flat)
    assert sci.next_load(d, bench, 8, 10, today=NOW.date())["basis"] == "reset"
    # A different load in between starts a new run.
    d = _with(flat[0], _w("2026-10-23", "bench_press", [(97.5, 10), (97.5, 10), (97.5, 10)]), flat[2])
    assert sci.next_load(d, bench, 8, 10, today=NOW.date())["basis"] == "progression"


def test_no_logged_load_never_prescribes_zero():
    d = _fresh(bodyweight_kg=80, sex="male")
    run(d, "log_workout", {"date": "2026-10-29", "exercises": [{"exercise": "bench", "set_count": 3, "reps": 8}]})
    nl = sci.next_load(d, builtin()["bench_press"], 8, 10, today=NOW.date())
    assert nl["load_kg"] and nl["load_kg"] >= 20 and nl["basis"] == "estimate"


def test_deload_without_a_planned_load_is_lighter_than_last_time():
    d = _with(_w("2026-10-29", "bench_press", [(100, 10), (100, 10), (100, 10)]))
    bench = builtin()["bench_press"]
    assert sci.prefill(d, bench, {"reps_min": 8, "reps_max": 10}, today=NOW.date()) == 102.5  # earned
    assert sci.prefill(d, bench, {"reps_min": 8, "reps_max": 10}, today=NOW.date(), deload=True) == 90
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "deload": True, "exercises": [{"exercise": "bench", "sets": 2, "reps_min": 8, "reps_max": 10}]}]})
    run(d, "start_session", {})
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d)} == {(None, 90)}


def test_percent_prescriptions_use_the_e1rm_the_person_sees():
    d = _with(_w("2026-10-29", "bench_press", [(100, 5), (100, 5), (100, 5)]))
    bench = builtin()["bench_press"]
    shown = sci.records(d, "bench_press")["bench_press"]["e1rm"]["value"]  # 116.7
    kg = sci.prefill(d, bench, {"reps_min": 5, "reps_max": 5, "load_pct": 85}, today=NOW.date())
    assert kg == sci.round_load(shown * 0.85, bench, d["settings"]) == 100  # not 105 from a margin-inflated basis


def test_prs_headline_once_per_exercise_and_need_a_previous_record():
    d = _history(_fresh())  # bench 80 × 8 and 80 × 10, rows 60 × 10
    # Bench: e1RM, 5RM and session volume all beaten; rows: e1RM. Two exercises → 2 PRs.
    out = run(d, "log_workout", {"exercises": [
        {"exercise": "bench", "set_count": 4, "reps": 8, "load": 85},
        {"exercise": "barbell row", "set_count": 3, "reps": 10, "load": 65},
    ]})
    prs = out.result["prs"]
    assert out.result["pr_count"] == 2 and "2 PRs:" in out.summary
    assert [p["kind"] for p in prs if p["headline"]] == ["e1rm", "e1rm"]
    bench_kinds = [p["kind"] for p in prs if p["exercise_id"] == "bench_press"]
    assert bench_kinds[0] == "e1rm" and set(bench_kinds) == {"e1rm", "5rm", "volume"}
    # A first-ever 10-rep set of a lift only done for 5s isn't a "10RM record".
    d = _with(_w("2026-10-20", "db_curl", [(12, 5), (12, 5)]))
    assert sci.new_records(d, _w("2026-10-27", "db_curl", [(8, 12)])) == []
    # Warm-ups never make records.
    d = _with(_w("2026-10-20", "back_squat", [(100, 5)]))
    assert sci.new_records(d, _w("2026-10-27", "back_squat", [(140, 5, "warmup"), (100, 5)])) == []


def test_plans_report_volume_warnings():
    d = _fresh(experience="beginner")
    out = run(d, "plan_week", {"sessions": [
        {"date": "2026-11-03", "name": "Chest day", "exercises": [
            {"exercise": "bench", "sets": 6, "reps": 8}, {"exercise": "incline dumbbell press", "sets": 6, "reps": 10}]},
        {"date": "2026-11-05", "name": "Chest again", "exercises": [{"exercise": "bench", "sets": 5, "reps": 8}]},
    ]})
    warn = " ".join(out.result["volume_warnings"])
    assert "Chest day" in warn and "12 sets for chest in one session" in warn
    assert "Chest: 17 hard sets/week" in warn and "beginner" in warn
    ok = run(_fresh(experience="intermediate"), "plan_week", {"sessions": [
        {"date": "2026-11-03", "exercises": [{"exercise": "bench", "sets": 4, "reps": 8}, {"exercise": "squat", "sets": 4, "reps": 6}]}]})
    assert ok.result["volume_warnings"] == []


def test_today_is_the_owners_day_in_sydney_around_midnight_utc():
    from app.items import service
    from app.items.spec import _TEXT_NOW

    syd = ZoneInfo("Australia/Sydney")
    # 13:30 UTC on 2 Nov = 00:30 on 3 Nov in Sydney.
    now = datetime(2026, 11, 2, 13, 30, tzinfo=ZoneInfo("UTC")).astimezone(syd)
    ctx = ItemContext(db=None, user=None, file_id=None, now=now, tz=syd)

    def go(d, name, args):
        out = asyncio.run(service.run_action(ctx, SPEC, d, name, args))
        clean = expand(SPEC.validate(d))
        d.clear()
        d.update(clean)
        return out

    d = _fresh()
    go(d, "plan_week", {"sessions": [
        {"date": "2026-11-02", "name": "Monday", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]},
        {"date": "2026-11-03", "name": "Tuesday", "exercises": [{"exercise": "bench", "sets": 3, "reps": 5}]},
    ]})
    go(d, "start_session", {})
    assert d["active"]["name"] == "Tuesday" and d["active"]["date"] == "2026-11-03"
    go(d, "discard_session", {})
    go(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 5, "load": 60}]})
    assert d["workouts"][-1]["date"] == "2026-11-03" and d["workouts"][-1]["name"] == "Tuesday"
    token = _TEXT_NOW.set(now)
    try:
        text = to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    assert "Today is 2026-11-03" in text and "Missed (planned, not done): 2026-11-02 Monday" in text


def test_action_guards():
    d = _history(_fresh())
    _refused(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 5, "load": 2000}]}, "plausible")
    _refused(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 5, "load": -5}]}, "Bad arguments")
    _refused(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 0, "reps": 5}]}, "Bad arguments")
    # Plans take no load at all (the logger suggests one).
    _refused(d, "plan_week", {"sessions": [{"date": "2026-11-03", "exercises": [{"exercise": "bench", "load": 2000}]}]}, "Unknown field 'load'")
    _refused(d, "plate_math", {"load": 30, "exercise": "db curl"}, "isn't loaded on a bar")
    assert run(d, "plate_math", {"load": 40, "exercise": "ez bar curl"}).result["bar"] == "10 kg"
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]}]})
    sid = d["planned"][0]["id"]
    _refused(d, "edit_session", {"session_id": sid, "changes": [{"exercise": "bench", "load": 81}]}, "Unknown field 'load'")
    assert d["planned"][0]["exercises"][0]["load_kg"] is None
    run(d, "log_workout", {"session_id": sid, "exercises": [{"exercise": "bench", "set_count": 3, "reps": 8, "load": 80}]})
    _refused(d, "start_session", {"session_id": sid}, "already done")


def test_swapping_a_lift_mid_workout_rebuilds_its_warmups():
    d = _with(_w("2026-10-29", "back_squat", [(100, 5), (100, 5), (100, 5)]), _w("2026-10-29", "front_squat", [(80, 5), (80, 5)], wid="wf"))
    run(d, "save_routine", {"name": "Legs", "exercises": [{"exercise": "squat", "sets": 3, "reps": 5}]})
    run(d, "start_session", {"routine_id": d["routines"][0]["id"]})
    run(d, "swap_exercise", {"from_exercise": "squat", "to_exercise": "front squat", "scope": "active"})
    we = d["active"]["exercises"][0]
    warm = [s for s in we["sets"] if s["type"] == "warmup"]
    work = [s for s in we["sets"] if s["type"] == "working"]
    assert we["exercise_id"] == "front_squat" and warm and all(s["suggest_kg"] and s["kg"] is None for s in warm)
    assert all(s["kg"] is None for s in work)
    assert max(s["suggest_kg"] for s in warm) < work[0]["suggest_kg"] and work[0]["suggest_kg"] < 100


def test_legacy_rir_and_rpe_never_come_back():
    d = _fresh()
    d["settings"]["effort"] = "rpe"
    d["planned"] = [{"id": "s", "date": "2026-11-03", "exercises": [{"id": "x", "exercise_id": "bench_press", "target_rir": 2}]}]
    d["workouts"] = [{"id": "w", "date": "2026-10-01", "effort": 8, "exercises": [{"id": "e", "exercise_id": "bench_press", "sets": [{"id": "t", "kg": 60, "reps": 5, "rir": 2}]}]}]
    stored = json.dumps(SPEC.validate(d))
    assert "rir" not in stored and "effort" not in stored and "rpe" not in stored
    assert "RIR" not in to_text(_history(_fresh())) and "RPE" not in to_text(_history(_fresh()))


def test_program_deload_weeks_ease_assisted_lifts_too():
    d = _with(_w("2026-10-29", "assisted_pullup", [(30, 10)] * 4), _w("2026-10-29", "bench_press", [(80, 10)] * 4, wid="wb"))
    out = run(d, "create_program", {"name": "Block", "weeks": 4, "days": [{"weekday": 0, "name": "Day", "exercises": [
        {"exercise": "assisted pull up", "sets": 4, "reps_min": 8, "reps_max": 10},
        {"exercise": "bench", "sets": 4, "reps_min": 8, "reps_max": 10}]}]})
    dl = [s for s in d["planned"] if s.get("deload")][0]
    assert dl["exercises"][0]["sets"] == 2 and all(rx["load_kg"] is None for rx in dl["exercises"])
    assert out.result["volume_warnings"] == []
    # The deload's suggestions: more assistance, a lighter bench.
    run(d, "start_session", {"session_id": dl["id"]})
    assert all(s["suggest_kg"] > 30 for s in _work(d, 0)) and {s["suggest_kg"] for s in _work(d, 1)} == {70}


def test_stated_bests_calibrate_loads_until_history_exists():
    d = _fresh(bodyweight_kg=84, sex="male", experience="intermediate")
    out = run(d, "set_profile", {"baselines": [
        {"exercise": "bench", "load": 90, "reps": 5}, {"exercise": "lat pulldown", "load": 70, "reps": 10},
        {"exercise": "assisted pull up", "load": 25, "reps": 8}]})
    assert "bests" in out.summary
    assert {b["exercise_id"] for b in d["settings"]["baselines"]} == {"bench_press", "lat_pulldown", "assisted_pullup"}
    # Upsert by exercise, remove by name.
    run(d, "set_profile", {"baselines": [{"exercise": "bench", "load": 92.5, "reps": 5}], "remove_baselines": ["assisted pull up"]})
    assert [(b["exercise_id"], b["kg"]) for b in d["settings"]["baselines"]] == [("bench_press", 92.5), ("lat_pulldown", 70)]
    run(d, "set_profile", {"baselines": [{"exercise": "bench", "load": 90, "reps": 5}]})
    bench, pd = builtin()["bench_press"], builtin()["lat_pulldown"]
    # The stated best drives the load (with a margin), not bodyweight norms.
    nl = sci.next_load(d, bench, 8, 10, today=NOW.date())
    assert nl["basis"] == "baseline" and nl["load_kg"] == 77.5 and "90 kg × 5" in nl["why"]
    # 70 × 10 best → 10–12 reps gets headroom below 70.
    assert sci.next_load(d, pd, 10, 12, today=NOW.date())["load_kg"] == 65
    prog = run(d, "create_program", {"name": "Block", "weeks": 4, "days": [{"weekday": 0, "name": "Day", "exercises": [
        {"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}, {"exercise": "lat pulldown", "sets": 3, "reps_min": 10, "reps_max": 12}]}]})
    first = prog.result["first_week"][0]["exercises"]
    assert "load" not in first[0] and "load" not in first[1]  # the plan holds no load ...
    assert "Calibration" not in d["planned"][0]["exercises"][0].get("notes", "")
    run(d, "start_session", {"session_id": d["planned"][0]["id"]})
    assert {s["suggest_kg"] for s in _work(d, 0)} == {77.5} and {s["suggest_kg"] for s in _work(d, 1)} == {65}  # ... the logger suggests it
    run(d, "discard_session", {})
    s = sci.suggest(d, bench, 5, today=NOW.date())
    assert s["basis"] == "baseline" and s["calibrate"] is False and s["e1rm_kg"] == 105.0
    text = to_text(d)
    assert "Stated bests" in text and "Bench Press (Barbell) 90×5" in text
    # Once the lift is logged, the log wins.
    run(d, "log_workout", {"date": "2026-10-30", "exercises": [{"exercise": "bench", "set_count": 3, "reps": 10, "load": 70}]})
    nl = sci.next_load(d, bench, 8, 10, today=NOW.date())
    assert nl["basis"] == "progression" and nl["load_kg"] == 72.5
    _refused(d, "set_profile", {"baselines": [{"exercise": "flarp", "load": 50, "reps": 5}]}, "don't know")


def test_log_results_say_they_are_saved():
    d = _fresh()
    out = run(d, "log_workout", {"exercises": [{"exercise": "bench", "set_count": 3, "reps": 5, "load": 60}]})
    assert "saved" in out.summary.lower() and out.result["saved"] is True and len(d["workouts"]) == 1
    assert "already" in SPEC.ai_brief and "not a duplicate" in SPEC.ai_brief


def test_program_days_must_be_named():
    """Left optional, models skipped the day name and every planned session
    read "Workout" instead of "Upper A" / "Push"."""
    from app.items.kinds.workout.actions import ProgramDayIn

    fields = ProgramDayIn.model_json_schema()
    assert "name" in fields["required"]


def test_cardio_is_one_bout_without_rest_or_volume():
    d = _fresh()
    out = run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Cardio", "exercises": [
        {"exercise": "stationary bike"}, {"exercise": "rowing machine", "meters": 5000}]}]})
    bike, row = d["planned"][0]["exercises"]
    assert (bike["sets"], bike["seconds"]) == (1, 1200) and row["sets"] == 1
    assert out.result["sessions"][0]["est_minutes"] <= 40  # ~20 min + ~10 min + change-overs, no rest
    cat = builtin()
    assert sci.rest_for(cat["stationary_bike"], d["settings"]) == 0 and sci.rest_for(cat["bench_press"], d["settings"]) == 180
    run(d, "start_session", {})
    sets = [we["sets"] for we in d["active"]["exercises"]]
    assert [len(x) for x in sets] == [1, 1] and sets[0][0]["seconds"] == 1200
    # An explicit set count is respected (intervals).
    run(d, "discard_session", {})
    run(d, "plan_week", {"sessions": [{"date": "2026-11-03", "exercises": [{"exercise": "air bike", "sets": 6, "seconds": 30}]}]})
    assert d["planned"][-1]["exercises"][0]["sets"] == 6
    # Cardio bouts and 0-rep sets aren't hard sets for weekly volume.
    run(d, "log_workout", {"date": "2026-10-27", "exercises": [
        {"exercise": "rowing machine", "meters": 5000, "seconds": 1200},
        {"exercise": "bench", "sets": [{"load": 100, "reps": 0}, {"load": 80, "reps": 8}]}]})
    vol = sci.weekly_volume(d, date(2026, 10, 26))
    assert vol["upper_back"] == 0 and vol["chest"] == 1


def test_finishing_a_session_on_another_day_moves_it_there():
    d = _fresh()
    run(d, "plan_week", {"sessions": [{"date": "2026-11-05", "name": "Thursday", "exercises": [{"exercise": "bench", "sets": 2, "reps": 8}]}]})
    sid = d["planned"][0]["id"]
    run(d, "start_session", {"session_id": sid})
    for s in d["active"]["exercises"][0]["sets"]:
        s["done"] = True
    run(d, "finish_session", {})
    s = d["planned"][0]
    assert s["status"] == "done" and s["date"] == "2026-11-02" == d["workouts"][-1]["date"] and s["workout_id"] == d["workouts"][-1]["id"]
    # Logging against a planned session on another day moves it too.
    run(d, "plan_week", {"replace_existing": False, "sessions": [{"date": "2026-11-06", "name": "Friday", "exercises": [{"exercise": "squat", "sets": 2, "reps": 5}]}]})
    fid = next(p["id"] for p in d["planned"] if p["name"] == "Friday")
    run(d, "log_workout", {"date": "2026-11-01", "session_id": fid, "exercises": [{"exercise": "squat", "set_count": 2, "reps": 5, "load": 60}]})
    assert next(p for p in d["planned"] if p["id"] == fid)["date"] == "2026-11-01"


# ------------------------------------------------- suggested loads, not planned


def test_plans_never_store_a_load_even_with_history():
    d = _history(_fresh(bodyweight_kg=80))
    run(d, "plan_week", {"sessions": [{"date": "2026-11-03", "name": "Upper", "exercises": [
        {"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}, {"exercise": "barbell row", "sets": 3, "reps": 10}]}]})
    run(d, "create_program", {"name": "B", "weeks": 2, "start_date": "2026-11-09", "replace_existing": False,
                              "days": [{"weekday": 0, "name": "Day", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]}]})
    rid = run(d, "save_routine", {"name": "Push", "exercises": [{"exercise": "bench", "sets": 3, "reps": 8}]}).result["routine_id"]
    run(d, "schedule_sessions", {"routine_id": rid, "dates": ["2026-11-30"]})
    run(d, "edit_session", {"session_id": d["planned"][0]["id"], "add": [{"exercise": "ohp", "sets": 3, "reps": 8}]})
    rxs = [rx for s in d["planned"] for rx in s["exercises"]] + d["routines"][0]["exercises"]
    assert len(rxs) >= 7 and all(rx["load_kg"] is None and rx["load_pct"] is None for rx in rxs)
    for bad in ({"load": 80}, {"load_pct": 75}):
        _refused(d, "plan_week", {"sessions": [{"date": "2026-11-04", "exercises": [{"exercise": "bench", **bad}]}]}, "Unknown field")
    _refused(d, "plan_week", {"fill_loads": True, "sessions": [{"date": "2026-11-04", "exercises": []}]}, "Unknown field 'fill_loads'")


def test_a_never_logged_lift_has_no_suggestion_but_a_stated_best_does():
    d = _fresh(bodyweight_kg=84, sex="male")
    run(d, "set_profile", {"baselines": [{"exercise": "bench", "load": 90, "reps": 5}]})
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Day", "exercises": [
        {"exercise": "squat", "sets": 3, "reps": 5}, {"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]})
    run(d, "start_session", {})
    squat, bench = d["active"]["exercises"]
    # No bodyweight-norm guess in the logger: no working weight to suggest…
    assert squat["exercise_id"] == "back_squat" and {(s["kg"], s["suggest_kg"]) for s in _work(d, 0)} == {(None, None)}
    # …but still a warm-up ramp: the empty bar, then reps to fill in once there's a working weight.
    assert [(s["kg"], s["suggest_kg"], s["reps"]) for s in _work(d, 0, "warmup")] == [(None, 20, 10), (None, None, 5), (None, None, 3)]
    # The stated best does give one (and a warm-up ramp to it).
    assert {(s["kg"], s["suggest_kg"]) for s in _work(d, 1)} == {(None, 77.5)}
    assert _work(d, 1, "warmup") and all(s["suggest_kg"] and s["kg"] is None for s in _work(d, 1, "warmup"))
    # suggest_loads (asked "what should I lift?") still flags its estimate as a calibration.
    assert run(d, "suggest_loads", {"items": [{"exercise": "squat", "reps": 5}]}).result["suggestions"][0]["calibrate"] is True


def test_finishing_adopts_suggestions_and_strips_them():
    from app.items.kinds.workout.actions import finish_active

    d = _with(_w("2026-10-29", "bench_press", [(80, 10)] * 3))
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Bench", "exercises": [{"exercise": "bench", "sets": 3, "reps_min": 8, "reps_max": 10}]}]})
    run(d, "start_session", {})
    warm, work = _work(d, 0, "warmup"), _work(d)
    assert warm and {s["suggest_kg"] for s in work} == {82.5}
    warm[-1]["done"] = True  # ticked as suggested
    for s in work:
        s["done"] = True
    work[0]["kg"] = 85  # typed a weight: that wins over the suggestion
    raw = copy.deepcopy(d)
    w, _ = finish_active(raw, NOW + timedelta(minutes=40))
    sets = w["exercises"][0]["sets"]
    assert all("suggest_kg" not in s for s in sets)
    assert [s["kg"] for s in sets] == [warm[-1]["suggest_kg"], 85, 82.5, 82.5]
    # Through the action too: what's saved is the adopted load, no suggestion left.
    run(d, "finish_session", {}, now=NOW + timedelta(minutes=40))
    saved = d["workouts"][-1]["exercises"][0]["sets"]
    assert [s["kg"] for s in saved if s["type"] == "working"] == [85, 82.5, 82.5]
    assert all(s.get("suggest_kg") is None for s in saved) and "suggest_kg" not in json.dumps(SPEC.validate(d)["workouts"])


def test_day_focus_is_stored_trimmed_and_shown():
    d = _fresh()
    out = run(d, "set_profile", {"training_days": [0, 3, 5], "day_focus": {"0": "Upper body", "3": "  Legs  ", "9": "x"}})
    assert "day plan" in out.summary
    assert d["settings"]["day_focus"] == {"0": "Upper body", "3": "Legs"}  # weekday 9 isn't one
    t = to_text(d)
    assert "day plan: Mon Upper body, Thu Legs, Sat (coach's choice)" in t
    # It replaces the whole map, trimmed to 40 characters.
    run(d, "set_profile", {"day_focus": {"5": "y" * 60}})
    assert d["settings"]["day_focus"] == {"5": "y" * 40}


def test_warmups_only_before_the_first_heavy_lift_of_each_pattern():
    """Real practice: ramp up before the first heavy compound of a movement;
    a second press after bench, or an isolation lift, starts straight away.
    "On" in the plan forces one; "Off" drops it."""
    d = _fresh(bodyweight_kg=84, sex="male")
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Day", "exercises": [
        {"exercise": "bench", "sets": 3, "reps": 5},
        {"exercise": "incline bench", "sets": 3, "reps": 8},
        {"exercise": "squat", "sets": 3, "reps": 5},
        {"exercise": "leg press", "sets": 3, "reps": 10, "warmup": True},
        {"exercise": "db curl", "sets": 2, "reps": 12}]}]})
    run(d, "start_session", {})
    warm = [bool(_work(d, i, "warmup")) for i in range(5)]
    assert warm == [True, False, True, True, False]
    d = _fresh(bodyweight_kg=84, sex="male")
    run(d, "plan_week", {"sessions": [{"date": "2026-11-02", "name": "Day", "exercises": [{"exercise": "bench", "sets": 3, "reps": 5, "warmup": False}]}]})
    run(d, "start_session", {})
    assert not _work(d, 0, "warmup")
