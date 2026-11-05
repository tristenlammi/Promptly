"""Body & Health (kind ``health``): the model, every action (happy path and
refusal), the science (trend, BP/BMI/glucose bands, correlation), adherence,
reminders, to_text, the AI tool schemas, and one end-to-end API flow."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.items.kinds.health import SPEC
from app.items.kinds.health import meds as M
from app.items.kinds.health import science as S
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 9, 0, tzinfo=TZ)  # a Saturday


class _U:
    settings: dict = {}


def ctx(now: datetime = NOW, user=None) -> ItemContext:
    return ItemContext(db=None, user=user or _U(), file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def fresh(**settings) -> dict:
    d = SPEC.validate(SPEC.template(ctx()))
    d["settings"].update(settings)
    return d


async def run(data: dict, name: str, args: dict, now: datetime = NOW):
    from app.items import service

    out = await service.run_action(ctx(now), SPEC, data, name, args)
    data.update(SPEC.validate(data))  # every write leaves a valid file
    return out


def text(data: dict, now: datetime = NOW) -> str:
    """to_text as the framework calls it: with the owner's "now" set."""
    from app.items.spec import _TEXT_NOW

    tok = _TEXT_NOW.set(now)
    try:
        return SPEC.to_text(data)
    finally:
        _TEXT_NOW.reset(tok)


async def refuse(data: dict, name: str, args: dict, match: str, now: datetime = NOW):
    before = copy.deepcopy(data)
    with pytest.raises(ActionError, match=match):
        await run(data, name, args, now)
    return before


# ------------------------------------------------------------ model/template


def test_template_is_valid_and_units_follow_the_locale():
    d = fresh()
    assert d["settings"]["weight_unit"] == "kg" and d["settings"]["cycle_tracking"] is False
    assert {g["metric"] for g in d["goals"]} == {"water", "sleep", "steps"}

    class US:
        settings = {"location": "Austin, Texas, United States"}

    us = SPEC.validate(SPEC.template(ctx(user=US())))
    assert us["settings"]["weight_unit"] == "lb" and us["settings"]["glucose_unit"] == "mgdl"


def test_old_or_partial_files_load_and_bad_values_are_refused():
    from pydantic import ValidationError

    assert SPEC.validate({})["readings"] == []
    assert SPEC.validate({"medications": [{"id": "m1", "name": "X"}]})["medications"][0]["schedule"]["times"] == ["08:00"]
    with pytest.raises(ValidationError):
        SPEC.validate({"readings": [{"id": "r", "metric": "bp", "at": "2026-10-31T08:00:00+11:00", "sys": 900}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"symptoms": [{"id": "s", "at": "2026-10-31T08:00:00+11:00", "name": "x", "severity": 11}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"profile": {"birth_date": "31/10/1990"}})


def test_identity():
    assert (SPEC.kind, SPEC.name, SPEC.suffix, SPEC.color, SPEC.icon, SPEC.category) == (
        "health", "Body & Health", ".health", "#D9506A", "heart-pulse", "Health & fitness"
    )
    assert SPEC.reads == ("workout", "meals") and SPEC.reminders is not None
    assert 5 <= len(SPEC.highlights) <= 8 and 4 <= len(SPEC.ai_suggestions) <= 6
    assert "hypertensive crisis" in SPEC.ai_brief.lower() and "not a doctor" in SPEC.ai_brief.lower()


def test_tools_have_no_refs_and_cover_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    assert "$ref" not in json.dumps(tools)
    names = {t["function"]["name"] for t in tools}
    expected = {
        "log_metrics", "log_symptom", "log_period", "add_medication", "edit_medication", "remove_medication",
        "log_dose", "add_appointment", "update_appointment", "add_lab_result", "add_vaccination", "set_profile",
        "save_care_provider", "set_goal", "define_custom_metric", "delete_entry", "metric_summary", "correlate",
        "adherence_report", "doctor_visit_summary", "bmi_and_ranges", "today_overview", "cycle_forecast",
    }
    assert expected <= names
    read_only = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "metric_summary" in read_only and "log_metrics" not in read_only


# ------------------------------------------------------------------ metrics


async def test_log_metrics_batch_converts_units_and_flags_crisis_bp():
    d = fresh(weight_unit="lb")
    out = await run(d, "log_metrics", {"readings": [
        {"metric": "weight", "value": 176.4},  # display unit lb
        {"metric": "Blood pressure", "sys": 185, "dia": 95, "pulse": 80, "arm": "left", "position": "sitting"},
        {"metric": "glucose", "value": 99, "unit": "mg/dL", "context": "fasting"},
        {"metric": "sleep", "bed": "23:00", "wake": "06:30", "quality": 4},
        {"metric": "water", "value": 2, "unit": "cups"},
        {"metric": "temp", "value": 100.4, "unit": "F"},
        {"metric": "mood", "value": 4},
    ]})
    by = {r["metric"]: r for r in d["readings"]}
    assert abs(by["weight"]["value"] - 80.0) < 0.05
    assert by["bp"]["sys"] == 185 and by["bp"]["arm"] == "left"
    assert abs(by["glucose"]["value"] - 5.5) < 0.01 and by["glucose"]["context"] == "fasting"
    assert by["sleep"]["value"] == 7.5 and by["sleep"]["bed"].startswith("2026-10-30T23:00") and by["sleep"]["at"].startswith("2026-10-31T06:30")
    assert by["water"]["value"] == 500 and abs(by["temperature"]["value"] - 38.0) < 0.01
    assert any("hypertensive-crisis" in w for w in out.result["warnings"])
    assert "Logged" in out.summary and len(out.result["added"]) == 7
    # The same batch again is a no-op (no duplicates).
    again = await run(d, "log_metrics", {"readings": [{"metric": "weight", "value": 176.4}]})
    assert again.result["added"] == 0 and len(d["readings"]) == 7


async def test_log_metrics_refusals():
    d = fresh()
    await refuse(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 120}]}, "needs both")
    await refuse(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 80, "dia": 120}]}, "higher number")
    await refuse(d, "log_metrics", {"readings": [{"metric": "weight", "value": 8000}]}, "outside")
    await refuse(d, "log_metrics", {"readings": [{"metric": "weight", "value": 80, "unit": "mg/dL"}]}, "isn't a unit")
    await refuse(d, "log_metrics", {"readings": [{"metric": "unicorns", "value": 3}]}, "Unknown metric")
    await refuse(d, "log_metrics", {"readings": [{"metric": "sleep"}]}, "Sleep needs")
    await refuse(d, "log_metrics", {"readings": [{"metric": "sleep", "bed": "2026-10-30T20:00:00", "wake": "2026-10-31T21:00:00"}]}, "isn't possible")
    await refuse(d, "log_metrics", {"readings": []}, "Bad arguments")
    assert d["readings"] == []


async def test_sleep_quality_only_and_custom_metrics():
    d = fresh()
    await run(d, "log_metrics", {"readings": [{"metric": "sleep", "quality": 2}]})
    assert d["readings"][0]["quality"] == 2 and d["readings"][0]["value"] is None
    out = await run(d, "define_custom_metric", {"name": "Caffeine", "unit": "mg", "aggregate": "sum", "goal": 200, "decimals": 0})
    mid = out.result["id"]
    assert mid == "x_caffeine" and mid in d["settings"]["today_tiles"]
    assert any(g["metric"] == mid and g["direction"] == "daily" for g in d["goals"])
    await run(d, "log_metrics", {"readings": [{"metric": "caffeine", "value": 95}, {"metric": "Caffeine", "value": 80, "at": "2026-10-31T08:30:00+11:00"}]})
    assert S.daily(d, mid)["2026-10-31"] == 175
    await refuse(d, "define_custom_metric", {"name": "caffeine"}, "already")
    await refuse(d, "define_custom_metric", {"name": "Weight"}, "built-in")
    # Deleting the metric drops its readings, goal and tile.
    await run(d, "delete_entry", {"entries": [{"type": "custom_metric", "id": mid}]})
    assert not any(r["metric"] == mid for r in d["readings"]) and mid not in d["settings"]["today_tiles"]


# ------------------------------------------------------------------ science


def test_ewma_trend_and_gaps():
    series = {"2026-10-01": 80.0, "2026-10-02": 82.0}
    tr = S.ewma(series, 0.1)
    assert tr["2026-10-02"] == pytest.approx(80.2)
    gap = S.ewma({"2026-10-01": 80.0, "2026-10-11": 82.0}, 0.1)
    assert gap["2026-10-11"] == pytest.approx(80 + (1 - 0.9 ** 10) * 2)


def test_reference_bands():
    assert S.bp_category(118, 76)["id"] == "normal"
    assert S.bp_category(125, 78)["id"] == "elevated"
    assert S.bp_category(128, 82)["id"] == "stage1"
    assert S.bp_category(142, 85)["id"] == "stage2"
    # AHA: crisis is *higher than* 180 and/or *higher than* 120.
    assert S.bp_category(180, 100)["id"] == "stage2" and S.bp_category(150, 120)["id"] == "stage2"
    assert S.bp_category(181, 100)["id"] == "crisis" and S.bp_category(150, 121)["id"] == "crisis"
    assert S.bmi_band(S.bmi(70, 175)) == "Healthy weight" and S.bmi_band(31) == "Obesity class I"
    assert S.glucose_band(5.4, "fasting")["id"] == "normal"
    assert S.glucose_band(6.2, "fasting")["id"] == "elevated"
    assert S.glucose_band(7.2, "fasting")["id"] == "high"
    assert S.glucose_band(3.5, None)["id"] == "low"
    assert S.bmr_mifflin(80, 180, 40, "male") == pytest.approx(1730)
    assert S.pearson([1, 2, 3, 4], [2, 4, 6, 8]) == pytest.approx(1.0)
    assert S.strength(0.55) == "strong"


def test_cycle_forecast():
    periods = []
    for start in ("2026-08-01", "2026-08-29", "2026-09-26"):
        d0 = datetime.fromisoformat(start).date()
        periods += [{"day": (d0 + timedelta(days=i)).isoformat(), "flow": "medium"} for i in range(5)]
    fc = S.cycle_forecast(periods, NOW.date().replace(day=10))
    assert fc["avg_cycle_days"] == 28 and fc["avg_period_days"] == 5
    assert fc["next_period"] == "2026-10-24" and fc["ovulation_estimate"] == "2026-10-10"
    assert fc["fertile_window"] == ["2026-10-05", "2026-10-11"] and fc["cycle_day"] == 15


async def test_log_period_turns_tracking_on_and_can_clear():
    d = fresh()
    out = await run(d, "log_period", {"start": "2026-10-20", "end": "2026-10-24", "flow": "heavy"})
    assert d["settings"]["cycle_tracking"] and len(d["periods"]) == 5 and "turned on" in out.summary
    assert out.result["forecast"]["next_period"] == "2026-11-17"
    await run(d, "log_period", {"start": "2026-10-24", "remove": True})
    assert len(d["periods"]) == 4
    await refuse(d, "log_period", {"start": "2026-10-01", "end": "2026-10-30"}, "more than 15")
    out = await run(d, "cycle_forecast", {})
    assert out.result["cycle_day"] == 12 and "contraception" in out.result["caveat"]


# ---------------------------------------------------------------- summaries


def _weights(d: dict, start: str, values: list[float]):
    day0 = datetime.fromisoformat(start)
    for i, v in enumerate(values):
        at = (day0 + timedelta(days=i)).replace(hour=7, tzinfo=TZ).isoformat()
        d["readings"].append({"id": f"w{i}", "metric": "weight", "at": at, "value": v})


async def test_metric_summary_trend_weekly_rate_and_goal_projection():
    d = fresh()
    # 0.1 kg/day down with ±0.4 noise, for 42 days ending today.
    vals = [90 - 0.1 * i + (0.4 if i % 2 else -0.4) for i in range(42)]
    _weights(d, "2026-09-20", vals)
    await run(d, "set_goal", {"metric": "weight", "target": 80})
    goal = next(g for g in d["goals"] if g["metric"] == "weight")
    assert goal["direction"] == "down" and goal["start_value"] is not None
    out = (await run(d, "metric_summary", {"metric": "weight", "days": 30})).result
    assert out["days_logged"] == 30 and out["unit"] == "kg"
    assert -0.8 < out["weekly_rate"] < -0.6  # ≈ −0.7 kg/week
    assert out["goal"]["projected_date"] > "2026-10-31"
    assert out["trend_now"] > out["last"]["value"] - 1
    # In lb, the rate converts.
    d["settings"]["weight_unit"] = "lb"
    lb = (await run(d, "metric_summary", {"metric": "weight", "days": 30})).result
    assert lb["unit"] == "lb" and lb["weekly_rate"] == pytest.approx(out["weekly_rate"] * S.LB_PER_KG, rel=0.01)
    empty = (await run(d, "metric_summary", {"metric": "glucose"})).result
    assert empty["days_logged"] == 0
    await refuse(d, "metric_summary", {"metric": "nope"}, "Unknown")


async def test_bp_summary_categories_and_glucose_by_context():
    d = fresh()
    await run(d, "log_metrics", {"readings": [
        {"metric": "bp", "sys": 128, "dia": 82, "at": "2026-10-30T08:00:00+11:00"},
        {"metric": "bp", "sys": 135, "dia": 85, "at": "2026-10-30T20:00:00+11:00"},
        {"metric": "bp", "sys": 118, "dia": 76, "at": "2026-10-31T08:00:00+11:00"},
        {"metric": "glucose", "value": 5.2, "context": "fasting"},
        {"metric": "glucose", "value": 8.1, "context": "post_meal", "at": "2026-10-30T13:00:00+11:00"},
    ]})
    bp = (await run(d, "metric_summary", {"metric": "bp", "days": 7})).result
    assert bp["readings"] == 3 and bp["avg_sys"] == 127 and bp["avg_category"] == "Hypertension stage 1"
    assert bp["categories"]["Normal"] == 1 and bp["crisis_readings"] == []
    g = (await run(d, "metric_summary", {"metric": "glucose", "days": 7})).result
    assert g["by_context"]["fasting"]["n"] == 1 and g["by_context"]["post_meal"]["avg"] == 8.1
    dia = (await run(d, "metric_summary", {"metric": "bp_dia", "days": 7})).result
    assert dia["days_logged"] == 2


async def test_correlate_with_lag_and_symptoms():
    d = fresh()
    for i in range(20):
        day = datetime(2026, 10, 1, tzinfo=TZ) + timedelta(days=i)
        hours = 5 + (i % 4)
        d["readings"].append({"id": f"s{i}", "metric": "sleep", "at": day.replace(hour=7).isoformat(), "value": hours})
        nxt = day + timedelta(days=1)
        d["readings"].append({"id": f"m{i}", "metric": "mood", "at": nxt.replace(hour=20).isoformat(), "value": min(5, hours - 3)})
        if hours <= 5:
            d["symptoms"].append({"id": f"h{i}", "at": nxt.replace(hour=12).isoformat(), "name": "Headache", "severity": 6, "tags": []})
    r = (await run(d, "correlate", {"metric_a": "sleep", "metric_b": "mood", "lag_days": 1})).result
    assert r["paired_days"] >= 15 and r["r"] > 0.9 and r["strength"] == "very strong" and not r["likely_chance"]
    same_day = (await run(d, "correlate", {"metric_a": "sleep", "metric_b": "mood", "lag_days": 0})).result
    assert abs(same_day["r"]) < r["r"]
    h = (await run(d, "correlate", {"metric_a": "sleep", "metric_b": "symptom:headache", "lag_days": 1})).result
    assert h["r"] < -0.5  # days without a headache count as 0
    few = (await run(d, "correlate", {"metric_a": "steps", "metric_b": "mood"})).result
    assert "Not enough" in few["note"]


async def test_bmi_and_ranges():
    d = fresh()
    none = (await run(d, "bmi_and_ranges", {})).result
    assert "height" in none["missing"]
    await run(d, "set_profile", {"height": 175, "birth_date": "1986-05-01", "sex": "female"})
    await run(d, "log_metrics", {"readings": [
        {"metric": "weight", "value": 70}, {"metric": "waist", "value": 80}, {"metric": "hip", "value": 100},
        {"metric": "bp", "sys": 122, "dia": 78},
    ]})
    out = (await run(d, "bmi_and_ranges", {})).result
    assert out["bmi"] == 22.9 and out["bmi_band"] == "Healthy weight" and "Asian" in out["bmi_caveats"]
    assert out["bmr_kcal"] == round(10 * 70 + 6.25 * 175 - 5 * 40 - 161)
    assert out["waist_to_height"]["ratio"] == 0.46 and out["waist_to_hip"]["above_threshold"] is False
    assert out["latest_bp"]["aha_category"] == "Elevated"


# --------------------------------------------------------------- symptoms


async def test_log_symptom_and_red_flags():
    d = fresh()
    out = await run(d, "log_symptom", {"symptoms": [{"name": "Headache", "severity": 6, "tags": ["Coffee", "coffee", "stress"]}]})
    assert d["symptoms"][0]["tags"] == ["coffee", "stress"] and "red_flag" not in out.result
    out = await run(d, "log_symptom", {"symptoms": [{"name": "Chest pain", "severity": 8, "note": "spreading to my arm"}]})
    assert "emergency" in out.result["red_flag"]
    await refuse(d, "log_symptom", {"symptoms": [{"name": "x", "severity": 12}]}, "Bad arguments")


# ------------------------------------------------------------- medications


async def test_medication_lifecycle_dose_log_adherence_and_refill():
    d = fresh()
    out = await run(d, "add_medication", {
        "name": "Metformin", "dose": "500 mg", "times": ["08:00", "20:00"], "with_food": "with",
        "remaining": 17, "start": "2026-10-25",
    })
    mid = out.result["id"]
    await refuse(d, "add_medication", {"name": "metformin"}, "already on the list")
    await refuse(d, "add_medication", {"name": "Vit D", "schedule_type": "days"}, "needs weekdays")
    await run(d, "add_medication", {"name": "Vitamin D", "kind": "supplement", "schedule_type": "days", "weekdays": [0, 3], "times": ["09:00"]})
    await run(d, "add_medication", {"name": "Ibuprofen", "dose": "200 mg", "schedule_type": "as_needed"})

    # Today 09:00: the 08:00 Metformin is due; log it (auto slot, on time).
    out = await run(d, "log_dose", {"doses": [{"med": "metformin", "at": "2026-10-31T08:10:00+11:00"}]})
    rec = d["doses"][-1]
    assert rec["slot"] == "08:00" and rec["status"] == "taken" and out.result["refill_warnings"] == []
    assert next(m for m in d["medications"] if m["id"] == mid)["remaining"] == 16
    # Yesterday's evening dose, late; the morning one skipped.
    await run(d, "log_dose", {"doses": [
        {"med": mid, "day": "2026-10-30", "slot": "20:00", "at": "2026-10-30T22:30:00+11:00"},
        {"med": mid, "day": "2026-10-30", "slot": "08:00", "status": "skipped"},
    ]})
    assert {x["status"] for x in d["doses"] if x["day"] == "2026-10-30"} == {"late", "skipped"}
    # Changing skipped → taken uses a tablet; refill warning appears under 7 days' supply (2/day).
    out = await run(d, "log_dose", {"doses": [{"med": mid, "day": "2026-10-30", "slot": "08:00", "status": "taken"}]})
    assert next(m for m in d["medications"] if m["id"] == mid)["remaining"] == 14
    assert "refill" in out.result["refill_warnings"][0]
    await refuse(d, "log_dose", {"doses": [{"med": mid, "slot": "13:00"}]}, "isn't scheduled")
    await refuse(d, "log_dose", {"doses": [{"med": "aspirin"}]}, "No single medication")
    # As-needed doses are recorded without a slot; several a day is fine.
    await run(d, "log_dose", {"doses": [{"med": "ibuprofen"}, {"med": "ibuprofen", "at": "2026-10-31T13:00:00+11:00"}]})
    assert sum(1 for x in d["doses"] if x["slot"] is None) == 2

    rep = (await run(d, "adherence_report", {"days": 7}, now=NOW.replace(hour=22))).result
    met = next(r for r in rep["medications"] if r["med_id"] == mid)
    # Oct 25–31 = 14 slots; 10 missed + Oct 30 (2 taken/late) + Oct 31 08:00 taken; Oct 31 20:00 pending.
    assert met["taken"] == 2 and met["late"] == 1 and met["pending"] == 1 and met["due"] == 13
    assert met["adherence_pct"] == round(100 * 3 / 13)
    assert rep["supply"][0]["refill_now"] and rep["as_needed_taken"][0]["count"] == 2

    # "all" logs everything due so far; then nothing is.
    await run(d, "log_dose", {"doses": [{"med": "all"}]}, now=NOW.replace(hour=21))
    await refuse(d, "log_dose", {"doses": [{"med": "all"}]}, "Nothing is due", now=NOW.replace(hour=21))

    # Refill, edit, stop, delete.
    out = await run(d, "edit_medication", {"med": mid, "refill_add": 60, "times": ["07:30", "19:30"]})
    assert out.result["supply"]["days_left"] >= 30
    await run(d, "remove_medication", {"med": "Vitamin D"})
    vd = next(m for m in d["medications"] if m["name"] == "Vitamin D")
    assert vd["active"] is False and vd["end"] == "2026-10-31"
    await run(d, "remove_medication", {"med": "Ibuprofen", "mode": "delete"})
    assert not any(m["name"] == "Ibuprofen" for m in d["medications"])
    assert all(x["med_id"] != "ibuprofen" for x in d["doses"])
    # Deleting a taken dose gives the tablet back.
    before = next(m for m in d["medications"] if m["id"] == mid)["remaining"]
    taken = next(x for x in d["doses"] if x["med_id"] == mid and x["status"] == "taken")
    await run(d, "delete_entry", {"entries": [{"type": "dose", "id": taken["id"]}]})
    assert next(m for m in d["medications"] if m["id"] == mid)["remaining"] == before + 1


def test_schedules():
    med = {"id": "m", "name": "X", "active": True, "start": "2026-10-01", "end": None,
           "schedule": {"type": "interval", "times": ["08:00"], "weekdays": [], "every_days": 3}, "per_dose": 2, "remaining": 30}
    from datetime import date

    assert M.times_on(med, date(2026, 10, 4)) == ["08:00"] and M.times_on(med, date(2026, 10, 5)) == []
    assert M.per_day_usage(med) == pytest.approx(2 / 3)
    assert M.supply(med, date(2026, 10, 31))["days_left"] == 45
    med["schedule"] = {"type": "days", "times": ["08:00"], "weekdays": [5], "every_days": 1}
    assert M.times_on(med, date(2026, 10, 31)) == ["08:00"]  # Saturday
    med["end"] = "2026-10-30"
    assert M.times_on(med, date(2026, 10, 31)) == []


# ----------------------------------------------------------------- records


async def test_appointments_labs_vaccinations_profile_care_team_and_delete():
    d = fresh()
    out = await run(d, "save_care_provider", {"name": "Dr Lee", "role": "GP", "clinic": "Harbour Medical", "phone": "02 9000 0000"})
    cid = out.result["id"]
    out = await run(d, "add_appointment", {"at": "2026-11-04T10:30:00", "title": "Check-up", "provider_id": cid, "questions": ["BP meds?"]})
    aid = out.result["id"]
    appt = d["appointments"][0]
    assert appt["who"] == "Dr Lee" and appt["at"] == "2026-11-04T10:30:00+11:00"
    await refuse(d, "add_appointment", {"at": "2026-11-04T10:30:00", "provider_id": "nope"}, "No care-team")
    await run(d, "update_appointment", {"id": aid, "add_questions": ["Cholesterol?", "BP meds?"], "notes": "Bring readings"})
    assert d["appointments"][0]["questions"] == ["BP meds?", "Cholesterol?"]
    await refuse(d, "update_appointment", {"id": "zzz"}, "No appointment")

    out = await run(d, "add_lab_result", {"results": [
        {"test": "LDL cholesterol", "value": 3.9, "unit": "mmol/L", "ref_high": 3.0, "panel": "Lipids", "day": "2026-10-20"},
        {"test": "HbA1c", "value": 5.4, "unit": "%", "ref_low": 4.0, "ref_high": 5.6, "day": "2026-10-20"},
        {"test": "Urine glucose", "value_text": "negative"},
    ]})
    assert [r["flag"] for r in d["labs"]] == ["high", "normal", ""] and out.result["flagged"] == ["LDL cholesterol high"]
    await refuse(d, "add_lab_result", {"results": [{"test": "X"}]}, "give a value")
    await refuse(d, "add_lab_result", {"results": [{"test": "X", "value": 1, "ref_low": 5, "ref_high": 2}]}, "back to front")

    await run(d, "add_vaccination", {"name": "Influenza", "day": "2026-04-10", "next_due": "2027-04-01"})
    assert d["vaccinations"][0]["next_due"] == "2027-04-01"
    await refuse(d, "add_vaccination", {"name": "Flu", "day": "10/04/2026"}, "isn't a date")

    out = await run(d, "set_profile", {
        "height": 69, "height_unit": "in", "sex": "male", "add_allergies": ["Penicillin", "penicillin"],
        "conditions": ["Hypertension"], "weigh_in_time": "07:00", "today_tiles": ["weight", "Blood pressure", "nonsense"],
        "blood_type": "O+", "emergency_notes": "On BP meds",
    })
    p = d["profile"]
    assert p["height_cm"] == 175.3 and p["allergies"] == ["Penicillin"] and d["settings"]["onboarded"]
    assert d["settings"]["today_tiles"] == ["weight", "bp"] and d["settings"]["weigh_in_time"] == "07:00"
    await refuse(d, "set_profile", {"weigh_in_time": "7am"}, "HH:MM")
    await refuse(d, "set_profile", {"birth_date": "2030-01-01"}, "future")
    await run(d, "set_profile", {"weigh_in_time": ""})
    assert d["settings"]["weigh_in_time"] is None

    await run(d, "delete_entry", {"entries": [{"type": "appointment", "id": aid}, {"type": "care_provider", "id": cid}]})
    assert d["appointments"] == [] and d["profile"]["care_team"] == []
    await refuse(d, "delete_entry", {"entries": [{"type": "lab", "id": "nope"}]}, "No lab")


async def test_goals():
    d = fresh(weight_unit="lb")
    out = await run(d, "set_goal", {"metric": "weight", "target": 165})
    g = next(g for g in d["goals"] if g["metric"] == "weight")
    assert abs(g["target"] - 74.84) < 0.01 and "165" in out.summary
    await run(d, "set_goal", {"metric": "glucose", "low": 4, "high": 7})
    assert next(g for g in d["goals"] if g["metric"] == "glucose")["direction"] == "range"
    await run(d, "set_goal", {"metric": "water", "target": 2500, "unit": "ml"})
    assert next(g for g in d["goals"] if g["metric"] == "water")["target"] == 2500
    await refuse(d, "set_goal", {"metric": "weight"}, "Give a target")
    await refuse(d, "set_goal", {"metric": "glucose", "low": 8, "high": 4}, "low is above")
    await run(d, "set_goal", {"metric": "glucose", "remove": True})
    assert not any(g["metric"] == "glucose" for g in d["goals"])


async def test_doctor_visit_summary_and_today_overview():
    d = fresh()
    await run(d, "set_profile", {"birth_date": "1970-01-15", "sex": "male", "conditions": ["Type 2 diabetes"], "allergies": ["Sulfa"]})
    await run(d, "add_medication", {"name": "Metformin", "dose": "500 mg", "times": ["08:00"], "start": "2026-10-01"})
    await run(d, "log_dose", {"doses": [{"med": "metformin"}]})
    await run(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 132, "dia": 84}, {"metric": "water", "value": 750}, {"metric": "water", "value": 500}]})
    await run(d, "log_symptom", {"symptoms": [{"name": "Dizziness", "severity": 4, "tags": ["standing up"]}]})
    await run(d, "add_appointment", {"at": "2026-11-03T09:00:00", "title": "Diabetes review", "who": "Dr Patel", "questions": ["Dose?"]})
    out = (await run(d, "doctor_visit_summary", {"days": 30})).result
    assert out["about"]["age"] == 56 and out["about"]["allergies"] == ["Sulfa"]
    assert out["medications"][0]["name"] == "Metformin" and out["metrics"]["bp"]["avg_category"] == "Hypertension stage 1"
    assert out["symptoms"][0]["name"] == "Dizziness" and out["next_appointment"]["questions"] == ["Dose?"]
    t = (await run(d, "today_overview", {})).result
    assert t["numbers"]["water"] == "1,250 ml" and t["numbers"]["bp"] == ["132/84"]
    assert t["meds"][0]["state"] == "taken"
    water = next(g for g in t["daily_goals"] if g["metric"] == "water")
    assert water["met"] is False


async def test_actions_are_deterministic():
    a, b = fresh(), fresh()
    args = {"readings": [{"metric": "weight", "value": 80}, {"metric": "mood", "value": 3}]}
    await run(a, "log_metrics", args)
    await run(b, "log_metrics", args)
    assert a == b
    m1 = await run(a, "add_medication", {"name": "Aspirin", "dose": "100 mg"})
    m2 = await run(b, "add_medication", {"name": "Aspirin", "dose": "100 mg"})
    assert m1.result == m2.result


async def test_caps_refuse_instead_of_dropping_old_data(monkeypatch):
    from app.items.kinds.health import actions as A

    monkeypatch.setattr(A, "MAX_READINGS", 3)
    d = fresh()
    await run(d, "log_metrics", {"readings": [{"metric": "weight", "value": 80 + i, "at": f"2026-10-0{i + 1}T07:00:00+10:00"} for i in range(3)]})
    await refuse(d, "log_metrics", {"readings": [{"metric": "weight", "value": 90}]}, "Archive older data")
    assert [r["value"] for r in d["readings"]][:3] == [80, 81, 82]  # nothing old was dropped (the refused write is discarded)


# ---------------------------------------------------------------- reminders


async def test_reminders_doses_refill_appointments_weigh_in_and_discreet():
    d = fresh(weigh_in_time="07:00")
    await run(d, "add_medication", {"name": "Metformin", "dose": "500 mg", "times": ["08:00", "20:00"], "remaining": 10, "with_food": "with"})
    await run(d, "add_appointment", {"at": "2026-11-03T10:00:00", "title": "Check-up", "who": "Dr Lee"})
    await run(d, "log_metrics", {"readings": [{"metric": "weight", "value": 80, "at": "2026-11-01T07:05:00+11:00"}]})
    rem = SPEC.reminders(d, ctx())
    keys = [r.key for r in rem]
    assert keys == sorted(keys, key=lambda k: next(r.due_at for r in rem if r.key == k))
    # Today's 08:00 already passed (it's 09:00); 20:00 today and the next 8 days follow.
    assert "dose:{}:2026-10-31T08:00".format(d["medications"][0]["id"]) not in keys
    mid = d["medications"][0]["id"]
    assert f"dose:{mid}:2026-10-31T20:00" in keys and f"dose:{mid}:2026-11-01T08:00" in keys
    dose = next(r for r in rem if r.key == f"dose:{mid}:2026-10-31T20:00")
    assert dose.title == "Metformin 500 mg" and "with food" in dose.body
    # 10 tablets at 2 a day = 5 days → a refill nudge.
    assert any(k.startswith(f"refill:{mid}:") for k in keys)
    aid = d["appointments"][0]["id"]
    assert f"appt:{aid}:day" in keys and f"appt:{aid}:2h" in keys
    day_before = next(r for r in rem if r.key == f"appt:{aid}:day")
    assert day_before.due_at == datetime(2026, 11, 2, 18, 0, tzinfo=TZ) and "Tomorrow" in day_before.title
    # Weigh-in: not today (time passed), not Nov 1 (already weighed), Nov 2 yes.
    assert "weigh:2026-10-31" not in keys and "weigh:2026-11-01" not in keys and "weigh:2026-11-02" in keys
    # Logging tonight's dose drops its reminder.
    await run(d, "log_dose", {"doses": [{"med": mid, "slot": "20:00", "at": "2026-10-31T19:55:00+11:00"}]})
    assert f"dose:{mid}:2026-10-31T20:00" not in [r.key for r in SPEC.reminders(d, ctx())]
    # Discreet mode hides the medicine's name; switches turn kinds off.
    d["settings"].update(discreet_reminders=True)
    rem = SPEC.reminders(d, ctx())
    assert not any("Metformin" in r.title or "Metformin" in r.body for r in rem)
    d["settings"].update(med_reminders=False, refill_reminders=False, appointment_reminders=False, weigh_in_time=None)
    assert SPEC.reminders(d, ctx()) == []


# ------------------------------------------------------------------ to_text


async def test_to_text_has_what_helps_and_not_private_notes():
    d = fresh()
    await run(d, "set_profile", {"height": 180, "birth_date": "1980-03-01", "sex": "male", "allergies": ["Penicillin"],
                                 "emergency_notes": "SECRET-EMERGENCY", "emergency_contact": "Jane 0400 000 000"})
    await run(d, "save_care_provider", {"name": "Dr Lee", "phone": "0299990000"})
    _weights(d, "2026-10-01", [85 - 0.05 * i for i in range(31)])
    await run(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 128, "dia": 82, "note": "PRIVATE-NOTE"}]})
    await run(d, "add_medication", {"name": "Ramipril", "dose": "5 mg", "times": ["08:00"]})
    await run(d, "add_appointment", {"at": "2026-11-05T09:00:00", "title": "BP review", "who": "Dr Lee", "questions": ["Dose ok?"]})
    await run(d, "add_lab_result", {"results": [{"test": "LDL", "value": 3.5, "unit": "mmol/L", "ref_high": 3.0}]})
    await run(d, "log_symptom", {"symptoms": [{"name": "Headache", "severity": 5, "note": "PRIVATE-SYMPTOM"}]})
    out = text(d)
    for want in ("Penicillin", "Weight: latest", "trend", "128/82", "Hypertension stage 1", "Ramipril 5 mg", "BP review", "LDL", "[HIGH]", "Headache"):
        assert want in out, want
    for secret in ("SECRET-EMERGENCY", "PRIVATE-NOTE", "PRIVATE-SYMPTOM", "0400 000 000", "0299990000"):
        assert secret not in out
    assert len(out) < 20_000
    assert "Nothing logged" in text(fresh())


# ------------------------------------------------------------ fix pass


# Every ADA cut point, both units: (value as entered, unit, context, expected band id).
GLUCOSE_CASES = [
    # mg/dL — classified exactly at the ADA's thresholds
    (53, "mgdl", None, "very_low"), (54, "mgdl", None, "low"),
    (69, "mgdl", None, "low"), (70, "mgdl", None, "normal"),  # hypo is <70: 70 is NOT low
    (99, "mgdl", "fasting", "normal"), (100, "mgdl", "fasting", "elevated"),  # 100–125 prediabetes range
    (125, "mgdl", "fasting", "elevated"), (126, "mgdl", "fasting", "high"),
    (139, "mgdl", "post_meal", "normal"), (140, "mgdl", "post_meal", "elevated"),  # normal is <140
    (179, "mgdl", "post_meal", "elevated"), (180, "mgdl", "post_meal", "high"),
    (130, "mgdl", "pre_meal", "normal"), (131, "mgdl", "pre_meal", "elevated"),  # target 80–130
    (80, "mgdl", "pre_meal", "normal"), (130, "mgdl", "bedtime", "normal"),
    (199, "mgdl", "random", "normal"), (200, "mgdl", "random", "high"),
    (249, "mgdl", None, "high"), (250, "mgdl", None, "very_high"), (250, "mgdl", "fasting", "very_high"),
    # mmol/L — the ADA's own rounded equivalents
    (2.9, "mmol", None, "very_low"), (3.0, "mmol", None, "low"),
    (3.8, "mmol", None, "low"), (3.9, "mmol", None, "normal"),
    (5.5, "mmol", "fasting", "normal"), (5.6, "mmol", "fasting", "elevated"),
    (6.9, "mmol", "fasting", "elevated"), (7.0, "mmol", "fasting", "high"),
    (7.7, "mmol", "post_meal", "normal"), (7.8, "mmol", "post_meal", "elevated"),
    (9.9, "mmol", "post_meal", "elevated"), (10.0, "mmol", "post_meal", "high"),
    (7.2, "mmol", "pre_meal", "normal"), (7.3, "mmol", "pre_meal", "elevated"),
    (11.0, "mmol", "random", "normal"), (11.1, "mmol", "random", "high"),
    (13.8, "mmol", None, "high"), (13.9, "mmol", None, "very_high"),
]


@pytest.mark.parametrize("value,unit,context,want", GLUCOSE_CASES)
def test_glucose_bands_at_every_ada_cut_point(value, unit, context, want):
    # Stored as it would be: converted to mmol/L with the exact factor.
    stored = value / S.MGDL_PER_MMOL if unit == "mgdl" else value
    stored = round(stored, 4)  # what log_metrics keeps
    assert S.glucose_band(stored, context, unit)["id"] == want


def test_glucose_factor_and_display_round_trip():
    assert S.MGDL_PER_MMOL == 18.0182
    d = fresh(glucose_unit="mgdl")
    for v in (54, 70, 100, 126, 130, 140, 180, 250):
        assert S.fmt_value(d, "glucose", round(v / S.MGDL_PER_MMOL, 4)) == f"{v} mg/dL"


async def test_glucose_warnings_in_mgdl_follow_the_cut_points():
    d = fresh(glucose_unit="mgdl")
    out = await run(d, "log_metrics", {"readings": [{"metric": "glucose", "value": 70, "context": "pre_meal"}]})
    assert out.result["warnings"] == []  # 70 is not low
    out = await run(d, "log_metrics", {"readings": [{"metric": "glucose", "value": 69, "at": "2026-10-31T08:01:00+11:00"}]})
    assert "Low" in out.result["warnings"][0] and "69 mg/dL" in out.result["warnings"][0]
    out = (await run(d, "metric_summary", {"metric": "glucose", "days": 7})).result
    assert out["lows"] == 1


async def test_spo2_warnings_match_the_brief():
    d = fresh()
    for v, minute, want in ((93, 1, None), (92, 2, "contact a clinician"), (89, 3, "urgent")):
        out = await run(d, "log_metrics", {"readings": [{"metric": "spo2", "value": v, "at": f"2026-10-31T08:0{minute}:00+11:00"}]})
        if want is None:
            assert out.result["warnings"] == []
        else:
            assert want in out.result["warnings"][0]
    assert S.spo2_band(93) == "slightly low" and S.spo2_band(92).startswith("low") and S.spo2_band(89).startswith("very low")


async def test_bp_crisis_wording_and_summary_use_higher_than():
    d = fresh()
    out = await run(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 180, "dia": 110}]})
    assert out.result["warnings"] == []
    out = await run(d, "log_metrics", {"readings": [{"metric": "bp", "sys": 181, "dia": 110, "at": "2026-10-31T08:05:00+11:00"}]})
    assert "Higher than 180" in out.result["warnings"][0] and "emergency" in out.result["warnings"][0]
    s = (await run(d, "metric_summary", {"metric": "bp", "days": 7})).result
    assert len(s["crisis_readings"]) == 1


async def _med_with_week_of_doses(d: dict) -> str:
    mid = (await run(d, "add_medication", {"name": "Ramipril", "dose": "5 mg", "times": ["08:00"], "start": "2026-10-25"})).result["id"]
    for day in range(25, 31):
        await run(d, "log_dose", {"doses": [{"med": mid, "day": f"2026-10-{day}", "slot": "08:00", "at": f"2026-10-{day}T08:05:00+11:00"}]})
    return mid


async def test_changing_a_schedule_keeps_past_doses_taken():
    d = fresh()
    mid = await _med_with_week_of_doses(d)
    out = await run(d, "edit_medication", {"med": mid, "times": ["09:00", "21:00"], "dose": "10 mg"})
    assert "earlier days keep theirs" in out.summary
    med = d["medications"][0]
    assert med["schedule_history"][0]["until"] == "2026-10-30" and med["schedule_history"][0]["dose"] == "5 mg"
    assert M.times_on(med, NOW.date() - timedelta(days=3)) == ["08:00"] and M.times_on(med, NOW.date()) == ["09:00", "21:00"]
    rep = (await run(d, "adherence_report", {"days": 7}, now=NOW.replace(hour=23))).result["medications"][0]
    assert rep["taken"] == 6 and rep["missed"] == 1 and rep["due"] == 7  # only today's 09:00 is missed
    # The plan in effect sets the dose shown for a day.
    assert M.slot_dose(med, NOW.date(), "09:00") == "10 mg" and M.slot_dose(med, NOW.date() - timedelta(days=2), "08:00") == "5 mg"
    # A no-op edit doesn't add history.
    await run(d, "edit_medication", {"med": mid, "times": ["09:00", "21:00"]})
    assert len(d["medications"][0]["schedule_history"]) == 1


async def test_stopping_keeps_history_and_only_ends_the_future():
    d = fresh()
    mid = await _med_with_week_of_doses(d)
    # 07:00 today: stop before today's dose.
    await run(d, "remove_medication", {"med": mid}, now=NOW.replace(hour=7))
    med = d["medications"][0]
    assert med["active"] is False and med["end"] == "2026-10-31" and med["stopped_at"].startswith("2026-10-31T07:00")
    rep = (await run(d, "adherence_report", {"days": 7}, now=NOW.replace(hour=23))).result["medications"][0]
    assert rep["taken"] == 6 and rep["missed"] == 0  # today's 08:00 came after the stop
    assert M.due_today(d, NOW) == []
    assert not any(r.key.startswith("dose:") for r in SPEC.reminders(d, ctx()))
    await refuse(d, "remove_medication", {"med": mid}, "already stopped")
    # Resume 3 days later: the break days aren't "missed".
    later = NOW + timedelta(days=3)
    await run(d, "edit_medication", {"med": mid, "active": True}, now=later)
    med = d["medications"][0]
    assert med["active"] and med["end"] is None and med["schedule_history"][-1]["stopped"] is True
    rep = (await run(d, "adherence_report", {"days": 10}, now=later.replace(hour=7))).result["medications"][0]
    assert rep["missed"] == 0 and rep["taken"] == 6
    assert M.times_on(med, later.date()) == ["08:00"]


def test_old_files_with_stopped_meds_keep_their_history():
    d = SPEC.validate({
        "medications": [{"id": "m1", "name": "X", "active": False, "start": "2026-10-01"}],
        "doses": [{"id": "d1", "med_id": "m1", "day": "2026-10-10", "slot": "08:00"}],
    })
    assert d["medications"][0]["end"] == "2026-10-10"
    rep = M.adherence(d, NOW, 31, "m1")
    assert rep["medications"][0]["taken"] == 1 and rep["medications"][0]["due"] == 10


async def test_interval_schedules_always_count_from_a_day():
    d = fresh()
    await run(d, "add_medication", {"name": "B12", "schedule_type": "interval", "every_days": 3, "times": ["09:00"]})
    med = d["medications"][0]
    assert med["schedule"]["anchor"] == "2026-10-31"  # the creation day
    assert M.times_on(med, NOW.date()) == ["09:00"] and M.times_on(med, NOW.date() + timedelta(days=1)) == []
    await run(d, "edit_medication", {"med": "B12", "interval_start": "2026-11-01"})
    assert M.times_on(d["medications"][0], NOW.date() + timedelta(days=1)) == ["09:00"]
    # Old files: an interval without an anchor counts from the start date (never silently daily).
    old = SPEC.validate({"medications": [{"id": "m", "name": "Y", "start": "2026-10-01", "schedule": {"type": "interval", "every_days": 2}}]})
    assert old["medications"][0]["schedule"]["anchor"] == "2026-10-01"
    m2 = {**old["medications"][0], "start": None, "schedule": {**old["medications"][0]["schedule"], "anchor": None}}
    assert M.times_on(m2, NOW.date()) == []
    await refuse(d, "add_medication", {"name": "Z", "schedule_type": "interval", "every_days": 2, "start": ""}, "needs a day to count from")


async def test_different_dose_per_time_slot():
    d = fresh()
    mid = (await run(d, "add_medication", {
        "name": "Metformin", "dose": "500 mg", "times": ["08:00", "20:00"], "remaining": 30,
        "slot_doses": [{"time": "20:00", "dose": "1000 mg", "per_dose": 2}],
    })).result["id"]
    med = d["medications"][0]
    assert M.per_day_usage(med, NOW.date()) == 3
    await run(d, "log_dose", {"doses": [{"med": mid, "slot": "20:00", "at": "2026-10-31T20:00:00+11:00"}]})
    assert d["medications"][0]["remaining"] == 28
    rem = {r.key: r for r in SPEC.reminders(d, ctx())}
    assert rem[f"dose:{mid}:2026-11-01T20:00"].title == "Metformin 1000 mg" and rem[f"dose:{mid}:2026-11-01T08:00"].title == "Metformin 500 mg"
    await refuse(d, "edit_medication", {"med": mid, "slot_doses": [{"time": "13:00", "dose": "1 g"}]}, "isn't one of the times")


async def test_taper_changes_the_dose_on_dates():
    d = fresh()
    await run(d, "add_medication", {
        "name": "Prednisolone", "dose": "40 mg", "times": ["08:00"],
        "taper": [{"start": "2026-11-05", "dose": "20 mg"}, {"start": "2026-11-10", "dose": "10 mg", "per_dose": 0.5}],
    })
    med = d["medications"][0]
    day = lambda n: NOW.date() + timedelta(days=n)  # noqa: E731
    assert [M.slot_dose(med, day(n), "08:00") for n in (0, 4, 5, 9, 10, 30)] == ["40 mg", "40 mg", "20 mg", "20 mg", "10 mg", "10 mg"]
    assert M.slot_units(med, day(10), "08:00") == 0.5
    assert "Prednisolone 40 mg" in text(d)
    # A later edit "from 7 Nov" replaces the planned steps after it.
    await run(d, "edit_medication", {"med": "Prednisolone", "dose": "15 mg", "effective_from": "2026-11-07"})
    med = d["medications"][0]
    assert [M.slot_dose(med, day(n), "08:00") for n in (0, 5, 7, 12)] == ["40 mg", "20 mg", "15 mg", "15 mg"]
    await refuse(d, "edit_medication", {"med": "Prednisolone", "taper": [{"start": "2026-01-01", "dose": "5 mg"}]}, "before the medicine's start")


async def test_as_needed_limits_warn():
    d = fresh()
    await run(d, "add_medication", {"name": "Paracetamol", "dose": "1 g", "schedule_type": "as_needed", "max_per_day": 2, "min_hours_between": 4})
    out = await run(d, "log_dose", {"doses": [{"med": "paracetamol", "at": "2026-10-31T06:00:00+11:00"}]})
    assert out.result["limit_warnings"] == []
    out = await run(d, "log_dose", {"doses": [{"med": "paracetamol", "at": "2026-10-31T08:00:00+11:00"}]})
    assert "2.0 h since the last dose" in out.result["limit_warnings"][0]
    out = await run(d, "log_dose", {"doses": [{"med": "paracetamol", "at": "2026-10-31T14:00:00+11:00"}]})
    assert "dose 3 today" in out.result["limit_warnings"][0] and len(d["doses"]) == 3  # warned, still logged
    await run(d, "edit_medication", {"med": "paracetamol", "max_per_day": 0, "min_hours_between": 0})
    assert d["medications"][0]["max_per_day"] is None and d["medications"][0]["min_hours_between"] is None


async def test_dose_follow_up_reminder():
    d = fresh()
    mid = (await run(d, "add_medication", {"name": "Ramipril", "times": ["08:45", "20:00"]})).result["id"]
    keys = {r.key: r for r in SPEC.reminders(d, ctx())}  # 09:00 now
    # 08:45 has passed: no first nudge, but a follow-up at 09:15; 20:00 gets both, with distinct keys.
    assert f"dose:{mid}:2026-10-31T08:45" not in keys and f"dose:{mid}:2026-10-31T08:45:again" in keys
    assert keys[f"dose:{mid}:2026-10-31T08:45:again"].due_at == datetime(2026, 10, 31, 9, 15, tzinfo=TZ)
    assert f"dose:{mid}:2026-10-31T20:00" in keys and f"dose:{mid}:2026-10-31T20:00:again" in keys
    assert "Still to take" in keys[f"dose:{mid}:2026-10-31T20:00:again"].title
    await run(d, "log_dose", {"doses": [{"med": mid, "slot": "08:45", "at": "2026-10-31T08:50:00+11:00"}]})
    assert f"dose:{mid}:2026-10-31T08:45:again" not in {r.key for r in SPEC.reminders(d, ctx())}


async def test_doses_can_be_logged_for_past_days_with_the_time_taken():
    d = fresh()
    mid = (await run(d, "add_medication", {"name": "Ramipril", "times": ["08:00"], "start": "2026-10-20"})).result["id"]
    await run(d, "log_dose", {"doses": [{"med": mid, "day": "2026-10-27", "at": "2026-10-27T10:30:00+11:00"}]})
    rec = d["doses"][-1]
    assert rec["day"] == "2026-10-27" and rec["slot"] == "08:00" and rec["status"] == "late" and rec["at"].startswith("2026-10-27T10:30")


async def test_to_text_uses_the_owners_now():
    from app.items.spec import _TEXT_NOW

    d = fresh()
    await run(d, "add_medication", {"name": "Ramipril", "times": ["08:00"], "start": "2026-10-25"})
    for day in range(25, 32):
        await run(d, "log_dose", {"doses": [{"med": "ramipril", "day": f"2026-10-{day}", "slot": "08:00", "at": f"2026-10-{day}T08:00:00+11:00"}]})
    # 11:30 on 1 Nov in Sydney is 00:30 UTC: in the owner's zone the unlogged 08:00 dose that day is
    # past its grace (missed); judged in UTC it would still be in the future.
    tok = _TEXT_NOW.set(datetime(2026, 11, 1, 11, 30, tzinfo=TZ))
    try:
        out = SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(tok)
    assert "30-day adherence 88%" in out


async def test_archive_moves_old_logs_and_keeps_the_rest():
    d = fresh()
    await run(d, "set_profile", {"height": 180})
    mid = await _med_with_week_of_doses(d)
    _weights(d, "2026-10-20", [80, 80.2, 80.1, 79.9, 79.8, 79.7, 79.6, 79.5, 79.4, 79.3, 79.2, 79.1])
    await run(d, "log_symptom", {"symptoms": [{"name": "Headache", "at": "2026-10-21T10:00:00+11:00"}, {"name": "Cough"}]})
    await run(d, "add_lab_result", {"results": [{"test": "LDL", "value": 3, "day": "2026-01-02"}]})
    kept, arch = SPEC.archive(copy.deepcopy(d), ctx(), "2026-10-28")
    kept, arch = SPEC.validate(kept), SPEC.validate(arch)
    assert all(r["at"][:10] >= "2026-10-28" for r in kept["readings"]) and all(r["at"][:10] < "2026-10-28" for r in arch["readings"])
    assert len(kept["readings"]) + len(arch["readings"]) == len(d["readings"])
    assert [s["name"] for s in kept["symptoms"]] == ["Cough"] and [s["name"] for s in arch["symptoms"]] == ["Headache"]
    assert {x["day"] for x in arch["doses"]} == {"2026-10-25", "2026-10-26", "2026-10-27"}
    assert kept["medications"] == d["medications"] and kept["labs"] == d["labs"] and kept["profile"]["height_cm"] == 180
    assert arch["medications"][0]["id"] == mid and arch["labs"] == [] and arch["settings"]["med_reminders"] is False
    assert SPEC.reminders(arch, ctx()) == []
    with pytest.raises(ActionError, match="nothing to archive"):
        SPEC.archive(d, ctx(), "2020-01-01")
    with pytest.raises(ActionError, match="isn't a date"):
        SPEC.archive(d, ctx(), "soon")


def test_store_copy_is_honest():
    blob = " ".join([SPEC.description, SPEC.replaces, *SPEC.highlights])
    assert "manual" in blob.lower() and "pharmacist" in blob.lower() and "no data leaves" not in blob
    assert "higher than 180 and/or higher than 120" in SPEC.ai_brief and "92% or less" in SPEC.ai_brief


# ------------------------------------------------------------- end to end


@pytest.fixture
async def client(db):
    import httpx

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


async def test_api_flow(client, db, user):
    import uuid

    from sqlalchemy import select

    from app.items.models import ItemReminder

    h = _auth(user)
    assert (await client.post("/api/items/store/health", headers=h)).status_code == 200
    r = await client.post("/api/items", headers=h, json={"kind": "health", "title": "My health"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "My health.health" and item["data"]["settings"]["onboarded"] is False
    assert {a["name"] for a in item["spec"]["actions"]} >= {"log_metrics", "doctor_visit_summary"}

    r = await client.post(f"/api/items/{fid}/actions/log_metrics", headers=h, json={"args": {"readings": [
        {"metric": "weight", "value": 81.5}, {"metric": "bp", "sys": 190, "dia": 100}]}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 2 and "Logged" in body["summary"] and body["result"]["warnings"]
    r = await client.post(f"/api/items/{fid}/actions/log_metrics", headers=h, json={"args": {"readings": [{"metric": "bp", "sys": 90}]}})
    assert r.status_code == 400 and "sys and dia" in r.json()["detail"]
    r = await client.post(f"/api/items/{fid}/actions/metric_summary", headers=h, json={"args": {"metric": "weight", "days": 7}})
    assert r.status_code == 200 and r.json()["revision"] == 2 and r.json()["result"]["days_logged"] == 1

    # A med with a future time → a reminder row exists.
    soon = (datetime.now(ZoneInfo("UTC")) + timedelta(hours=2)).strftime("%H:%M")
    r = await client.post(f"/api/items/{fid}/actions/add_medication", headers=h, json={"args": {"name": "Ramipril", "times": [soon]}})
    assert r.status_code == 200, r.text
    rows = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert any(x.key.startswith("dose:") for x in rows)

    # The UI's direct save: validated, with the revision check.
    data = r.json()["data"]
    data["settings"]["onboarded"] = True
    data["profile"]["height_cm"] = 172
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": data, "base_revision": r.json()["revision"]})
    assert r.status_code == 200 and r.json()["data"]["profile"]["height_cm"] == 172
    bad = copy.deepcopy(r.json()["data"])
    bad["readings"][0]["metric"] = "Not A Metric!"
    r2 = await client.put(f"/api/items/{fid}", headers=h, json={"data": bad, "base_revision": r.json()["revision"]})
    assert r2.status_code == 400

    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Ramipril" in row.content_text and "190/100" in row.content_text


async def test_ai_turn_logs_from_natural_language(client, db, user, monkeypatch):
    import uuid

    from app.items import ai
    from app.models_config import provider as prov
    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    h = _auth(user)
    await client.post("/api/items/store/health", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "health"})).json()["file_id"]

    class Fake:
        def __init__(self):
            self.calls = []

        async def stream_chat_events(self, **kw):
            self.calls.append(kw)
            if len(self.calls) == 1:
                args = {"readings": [{"metric": "bp", "sys": 128, "dia": 82}, {"metric": "sleep", "quality": 2}]}
                yield ToolCallDelta(index=0, id="c1", name="log_metrics", arguments=json.dumps(args))
                yield FinishEvent(reason="tool_calls")
            else:
                yield TextDelta(text="Logged BP 128/82 (stage 1) and a poor night.")
                yield FinishEvent(reason="stop")

    fake = Fake()
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "BP 128/82 this morning, slept badly", object(), "m", can_edit=True)]
    done = events[-1]
    assert done["type"] == "done" and done["changed"]
    assert {r["metric"] for r in done["data"]["readings"]} == {"bp", "sleep"}
    assert "AHA" in fake.calls[0]["system"]


async def test_a_report_logs_on_the_collection_day_and_only_once():
    d = fresh()
    results = [
        {"test": "Ferritin", "value": 18, "unit": "ug/L", "ref_low": 30, "ref_high": 500, "day": "2026-10-28", "time": "08:15", "panel": "Iron studies", "source": "bloods.pdf"},
        {"test": "HbA1c", "value": 5.4, "unit": "%", "ref_high": 5.6, "day": "2026-10-28", "time": "08:15", "source": "bloods.pdf"},
    ]
    out = await run(d, "add_lab_result", {"results": results})
    assert out.result["already_logged"] == 0 and out.result["flagged"] == ["Ferritin low"]
    row = d["labs"][0]
    assert (row["day"], row["time"], row["source"]) == ("2026-10-28", "08:15", "bloods.pdf")
    assert SPEC.validate(d)["labs"][0]["time"] == "08:15"
    # The same report again, and a new result the next time.
    again = await run(d, "add_lab_result", {"results": [*results, {"test": "Ferritin", "value": 42, "unit": "ug/L", "day": "2026-11-20"}]})
    assert again.result["already_logged"] == 2 and "2 already logged" in again.summary and len(d["labs"]) == 3


@pytest.mark.parametrize("name, body, mime", [("bloods.txt", b"Ferritin 18 ug/L collected 28 Oct 2026 08:15", "text/plain")])
async def test_an_attached_report_reaches_the_model_in_the_ask_panel(client, db, user, monkeypatch, name, body, mime):
    import uuid

    from app.items import ai
    from app.models_config import provider as prov
    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    h = _auth(user)
    await client.post("/api/items/store/health", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "health"})).json()["file_id"]
    up = await client.post("/api/files/", headers=h, files={"file": (name, body, mime)}, data={"scope": "mine", "route": "chat"})
    assert up.status_code < 300, up.text
    attached = uuid.UUID(up.json()["id"])

    class Fake:
        def __init__(self):
            self.calls = []

        async def stream_chat_events(self, **kw):
            self.calls.append([dict(m) for m in kw["messages"]])
            if len(self.calls) == 1:
                args = {"results": [{"test": "Ferritin", "value": 18, "unit": "ug/L", "day": "2026-10-28", "time": "08:15", "source": name}]}
                yield ToolCallDelta(index=0, id="c1", name="add_lab_result", arguments=json.dumps(args))
                yield FinishEvent(reason="tool_calls")
            else:
                yield TextDelta(text="Logged 1 result for 28 Oct.")
                yield FinishEvent(reason="stop")

    fake = Fake()
    monkeypatch.setattr(prov, "model_router", fake)
    from types import SimpleNamespace

    model = SimpleNamespace(models=[{"id": "m", "supports_vision": False}])
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "Here you go", model, "m", can_edit=True, attachment_ids=[attached])]
    assert "Ferritin 18 ug/L" in fake.calls[0][-1]["content"] and str(attached) in fake.calls[0][-1]["content"]
    done = events[-1]
    assert done["changed"] and done["data"]["labs"][0]["time"] == "08:15"
    # A later turn can still tell what was attached, without carrying the whole file.
    thread = await ai.load_thread(db, uuid.UUID(fid), user)
    assert name in thread[0]["content"] and "Ferritin 18" not in thread[0]["content"]


async def test_someone_elses_file_cant_be_attached(client, user):
    import uuid

    h = _auth(user)
    await client.post("/api/items/store/health", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "health"})).json()["file_id"]
    r = await client.post(f"/api/items/{fid}/ai", headers=h, json={"message": "hi", "attachment_ids": [str(uuid.uuid4())]})
    assert r.status_code in (400, 404)


async def test_a_scanned_pdf_goes_as_pictures_or_says_it_couldnt_be_read(db, tmp_path, monkeypatch):
    from types import SimpleNamespace

    from PIL import Image

    from app.files import vision_extract as ve

    scan = tmp_path / "scan.pdf"
    Image.new("RGB", (800, 1100), "white").save(scan, "PDF")
    file = SimpleNamespace(id="x", filename="scan.pdf", mime_type="application/pdf", storage_path="scan.pdf", user_id=None)
    monkeypatch.setattr(ve, "absolute_path", lambda _p: scan)
    monkeypatch.setattr(ve, "_extract_pdf_text", lambda *_a: ("", False))
    words, parts = await ve.read_scanned_pdfs(db, [file], True)
    assert len(parts) == 1 and parts[0].url.startswith("data:image/") and "follow as images" in words

    async def nothing(*_a):
        return None

    monkeypatch.setattr(ve, "extract_text_via_vision", nothing)
    words, parts = await ve.read_scanned_pdfs(db, [file], False)
    assert not parts and "could not be read" in words

    # A PDF with its own text needs none of this.
    monkeypatch.setattr(ve, "_extract_pdf_text", lambda *_a: ("Ferritin 18", False))
    assert await ve.read_scanned_pdfs(db, [file], True) == ("", [])


async def test_an_attached_file_can_log_results_but_not_change_anything_else(client, db, user):
    import uuid

    from app.chat.tools import ToolContext
    from app.chat.tools.base import ToolError, TurnState
    from app.chat.tools.items import UseItemTool

    h = _auth(user)
    await client.post("/api/items/store/health", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "health"})).json()["file_id"]
    lab = {"results": [{"test": "Ferritin", "value": 18, "unit": "ug/L", "day": "2026-10-28"}]}

    def turn(state):
        return ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=state)

    attached = TurnState(untrusted=True, own_attachments_only=True)
    out = await UseItemTool().run(turn(attached), {"file_id": fid, "action": "add_lab_result", "args": lab})
    assert "Added 1" in out.content
    # Only that: a document can't get anything else done.
    with pytest.raises(ToolError, match="Not changing"):
        await UseItemTool().run(turn(attached), {"file_id": fid, "action": "set_profile", "args": {"height_cm": 100}})
    # Anything else from outside this turn ends it, however it came in.
    attached["untrusted"] = True
    assert attached["own_attachments_only"] is False
    with pytest.raises(ToolError, match="Not changing"):
        await UseItemTool().run(turn(attached), {"file_id": fid, "action": "add_lab_result", "args": lab})
    with pytest.raises(ToolError, match="Not changing"):
        await UseItemTool().run(turn(TurnState(untrusted=True)), {"file_id": fid, "action": "add_lab_result", "args": lab})


async def test_the_ask_panel_keeps_an_attached_document_to_adding_results():
    from app.items import ai

    d = fresh()
    d["labs"] = [{"id": "l1", "day": "2026-10-01", "test": "X", "value": 1, "value_text": "", "unit": "", "ref_low": None, "ref_high": None, "flag": "", "panel": "", "note": "", "time": "", "source": ""}]
    delete = {"entries": [{"type": "lab", "id": "l1"}]}
    for name, args in (("delete_entry", delete), ("update_data", {"ops": [{"op": "remove", "path": "/labs/0"}]})):
        result, ok, _s, working = await ai._run_tool(ctx(), SPEC, d, name, args, [], True, attached=True)
        assert not ok and "attached document" in result and working is d and len(d["labs"]) == 1
