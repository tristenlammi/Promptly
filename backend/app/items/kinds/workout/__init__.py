"""Workout — a strength-training log with an AI coach, in the style of
Strong and Hevy.

The file holds the person's profile & kit, custom exercises (the ~170
built-in ones live in :mod:`.catalog`), routines, programs (mesocycles),
planned sessions on dates, the workout history and the live session (so a
workout survives reloads). The coach (``ai_brief``) plans weeks with real
loads from their history via the actions in :mod:`.actions`."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends

from app.auth.deps import get_current_user
from app.items.kinds.workout import science as sci
from app.items.kinds.workout.actions import ACTIONS
from app.items.kinds.workout.brief import AI_BRIEF, AI_SUGGESTIONS
from app.items.kinds.workout.catalog import MUSCLES, catalog_payload
from app.items.kinds.workout.models import WorkoutData, expand
from app.items.spec import ActionError, ItemContext, ItemSpec, Reminder, text_now

MAX_TEXT = 20_000


def template(ctx: ItemContext) -> dict:
    return WorkoutData().model_dump(mode="json")


# ------------------------------------------------------------------- text


def _set_txt(s: dict, ex: dict, st: dict) -> str:
    log = ex.get("log")
    if log == "duration":
        core = f"{s.get('seconds') or 0}s"
        if s.get("kg"):
            core += f" @ {sci.fmt_kg(s['kg'], st)}"
    elif log == "distance":
        core = f"{s.get('meters') or 0:g} m"
        if s.get("seconds"):
            core += f" in {s['seconds'] // 60}:{s['seconds'] % 60:02d}"
        if s.get("kg"):
            core += f" @ {sci.fmt_kg(s['kg'], st)}"
    elif log == "bodyweight_reps":
        core = f"{s.get('reps') or 0}" + (f" (+{sci.fmt_kg(s['kg'], st)})" if s.get("kg") else "")
    elif log == "assisted":
        core = f"{s.get('reps') or 0} (−{sci.fmt_kg(s.get('kg') or 0, st)} assist)"
    else:
        v = sci.to_unit(s.get("kg") or 0, st)
        core = f"{v:g}×{s.get('reps') or 0}"
    if s.get("type") in ("drop", "failure"):
        core += f" ({s['type']})"
    return core


def _rx_txt(rx: dict, ex: dict, st: dict) -> str:
    lo, hi = rx.get("reps_min"), rx.get("reps_max")
    reps = f"{lo}" if lo == hi else f"{lo}–{hi}"
    if ex.get("log") == "duration":
        reps = f"{rx.get('seconds') or '?'}s"
    elif ex.get("log") == "distance":
        reps = f"{rx.get('meters') or '?'} m"
    out = f"{ex.get('name', rx['exercise_id'])} {rx.get('sets', 3)}×{reps}"
    if rx.get("load_kg") is not None:
        out += f" @ {sci.fmt_kg(rx['load_kg'], st)}"
    elif rx.get("load_pct"):
        out += f" @ {rx['load_pct']:g}% e1RM"
    return out


def to_text(data: dict) -> str:
    # Reads compact data as stored (``.get`` with defaults) — no expansion on
    # every save.
    today = text_now().date().isoformat()
    st = data.get("settings", {})
    exs = sci.all_exercises(data)
    unit = st.get("units", "kg")
    lines: list[str] = []
    prof = [
        f"Goal: {st.get('goal', 'general')}", f"experience: {st.get('experience', 'beginner')}",
        f"{st.get('days_per_week', 3)} days/week, {st.get('session_minutes', 60)} min", f"units: {unit}",
    ]
    if st.get("bodyweight_kg"):
        prof.append(f"bodyweight {sci.fmt_kg(st['bodyweight_kg'], st)}")
    prof.append("equipment: " + ", ".join(st.get("equipment") or ["full_gym"]))
    if st.get("injuries"):
        prof.append(f"injuries/limitations: {st['injuries']}")
    lines.append(f"Today is {today}.")
    lines.append("Profile — " + "; ".join(prof))
    if st.get("baselines"):
        logged = {we.get("exercise_id") for w in data.get("workouts", []) for we in w.get("exercises", [])}
        bits = []
        for b in st["baselines"]:
            ex = exs.get(b["exercise_id"], {"name": b["exercise_id"]})
            v = sci.to_unit(b.get("kg") or 0, st)
            bits.append(f"{ex['name']} {v:g}×{b.get('reps')}" + (" (now logged — the log is used)" if b["exercise_id"] in logged else ""))
        lines.append(f"Stated bests (loads calibrate from these until a lift is logged; {unit}): " + "; ".join(bits))
    if data.get("active"):
        a = data["active"]
        done = sum(1 for we in a["exercises"] for s in we["sets"] if s.get("done", True) and s.get("type") != "warmup")
        lines.append(f"\nIN PROGRESS: {a['name']} (started {(a.get('started_at') or '')[:16]}), {done} sets ticked")
        for we in a["exercises"]:
            ex = exs.get(we["exercise_id"], {"name": we["exercise_id"]})
            lines.append(f"  - {ex['name']}: " + ", ".join(("✓" if s.get("done", True) else "·") + _set_txt(s, ex, st) for s in we["sets"]))
    progs = [p for p in data.get("programs", []) if p.get("status") == "active"]
    for p in progs:
        dl = [str(w["n"]) for w in p.get("weeks", []) if w.get("deload")]
        lines.append(f"\nProgram: {p['name']} (from {p['start_date']}, {len(p.get('weeks', []))} weeks" + (f", deload week {', '.join(dl)}" if dl else "") + ")")
    upcoming = [s for s in data.get("planned", []) if s.get("status") == "planned" and s["date"] >= today]
    missed = [s for s in data.get("planned", []) if s.get("status") == "planned" and s["date"] < today]
    if missed:
        lines.append("\nMissed (planned, not done): " + "; ".join(f"{s['date']} {s['name']}" for s in missed[-6:]))
    if upcoming:
        lines.append("\nPlanned sessions (next):")
        for s in upcoming[:14]:
            ex_txt = "; ".join(_rx_txt(rx, exs.get(rx["exercise_id"], {}), st) for rx in s.get("exercises", []))
            lines.append(f"- {s['date']}{' ' + s['time'] if s.get('time') else ''} {s['name']}{' [deload]' if s.get('deload') else ''}: {ex_txt or 'no exercises yet'}")
    if data.get("routines"):
        lines.append("\nRoutines: " + "; ".join(f"{r['name']} ({len(r['exercises'])} exercises)" for r in data["routines"][:30]))
    recs = sci.records(data)
    top = []
    for eid, rec in recs.items():
        if "e1rm" in rec and exs.get(eid, {}).get("compound"):
            top.append((rec["e1rm"]["value"], eid, rec))
    top.sort(reverse=True)
    if top:
        lines.append("\nBest estimated 1RMs: " + "; ".join(f"{exs.get(eid, {}).get('name', eid)} {sci.fmt_kg(v, st)} ({rec['e1rm']['date']})" for v, eid, rec in top[:12]))
    ws = data.get("workouts", [])
    if ws:
        lines.append(f"\nWorkout history ({len(ws)} total, newest first):")
        for w in reversed(ws[-40:]):
            mins = f", {round(w['duration_s'] / 60)} min" if w.get("duration_s") else ""
            lines.append(f"- {w['date']} {w['name']}{mins}" + (" [deload]" if sci.is_deload(data, w) else "") + (f" — {w['notes'][:120]}" if w.get("notes") else ""))
            for we in w["exercises"]:
                ex = exs.get(we["exercise_id"], {"name": we["exercise_id"]})
                sets = [s for s in we["sets"] if sci.is_hard(s)]
                lines.append(f"  {ex['name']}: " + ", ".join(_set_txt(s, ex, st) for s in sets))
    custom = [c for c in data.get("exercises", []) if not c.get("archived")]
    if custom:
        lines.append("\nCustom exercises: " + ", ".join(c["name"] for c in custom[:60]))
    out = "\n".join(lines)
    return out[:MAX_TEXT]


# -------------------------------------------------------------- reminders


def _hm(s: str | None, fallback: str = "08:00") -> time:
    try:
        h, m = (s or fallback).split(":")
        return time(int(h), int(m))
    except ValueError:
        return time(8, 0)


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    st = data.get("settings", {})
    out: list[Reminder] = []
    exs = sci.all_exercises(data)
    a = data.get("active")
    if a and a.get("started_at"):
        try:
            started = datetime.fromisoformat(a["started_at"])
            if started.tzinfo is None:
                started = started.replace(tzinfo=ctx.tz)
            due = started + timedelta(hours=3)
            if due > ctx.now:
                out.append(Reminder(key=f"active:{a['id']}", due_at=due, title=f"Still training? {a['name']} is open", body="Finish it to save it to your history (or discard it)."))
        except (TypeError, ValueError):
            pass
    if not st.get("reminders", True):
        return out
    today = ctx.today
    horizon = (today + timedelta(days=8)).isoformat()
    for s in data.get("planned", []):
        if s.get("status") != "planned" or s["date"] < today.isoformat() or s["date"] > horizon:
            continue
        d = date.fromisoformat(s["date"])
        if s.get("time"):
            due = datetime.combine(d, _hm(s["time"]), tzinfo=ctx.tz) - timedelta(minutes=int(st.get("remind_before_min", 60)))
            when = f"at {s['time']}"
        else:
            due = datetime.combine(d, _hm(st.get("reminder_time")), tzinfo=ctx.tz)
            when = "today"
        if due <= ctx.now:
            continue
        rxs = s.get("exercises", [])
        est = sci.estimate_minutes(rxs, data)
        first = _rx_txt(rxs[0], exs.get(rxs[0]["exercise_id"], {}), st) if rxs else ""
        body = f"{len(rxs)} exercise{'s' if len(rxs) != 1 else ''} · ~{est} min" + (f" · {first}" if first else "")
        out.append(Reminder(key=f"session:{s['id']}:{s['date']}:{s.get('time') or st.get('reminder_time')}", due_at=due, title=f"{s['name']} {when}{' (deload)' if s.get('deload') and 'deload' not in s['name'].lower() else ''}", body=body))
    return out


# ---------------------------------------------------------------- archive


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    """Move workouts (and finished / skipped planned sessions) dated before
    ``before_day`` into an archive file. Settings, custom exercises,
    routines, programs, the live session and the upcoming plan stay; the
    archive gets the settings and custom exercises too, so it reads on its
    own (names, units, records)."""
    try:
        cut = date.fromisoformat(before_day[:10]).isoformat()
    except ValueError as e:
        raise ActionError(f"{before_day!r} isn't a date (use YYYY-MM-DD).") from e
    full = expand(data)
    old = [w for w in full.get("workouts", []) if w["date"] < cut]
    if not old:
        raise ActionError(f"No workouts before {cut} to archive.")
    kept_w = [w for w in full.get("workouts", []) if w["date"] >= cut]
    old_ids = {w["id"] for w in old}
    old_p = [s for s in full.get("planned", []) if s["date"] < cut and (s.get("status") != "planned" or s.get("workout_id") in old_ids)]
    old_pids = {s["id"] for s in old_p}
    kept = {**full, "workouts": kept_w, "planned": [s for s in full.get("planned", []) if s["id"] not in old_pids]}
    used_programs = {w.get("program_id") for w in old} | {s.get("program_id") for s in old_p}
    archived = {
        "settings": {**full["settings"], "reminders": False, "onboarded": True},
        "exercises": list(full.get("exercises", [])),
        "routines": [],
        "programs": [pr for pr in full.get("programs", []) if pr["id"] in used_programs],
        "planned": old_p,
        "workouts": old,
        "active": None,
    }
    return WorkoutData.model_validate(kept).model_dump(mode="json"), WorkoutData.model_validate(archived).model_dump(mode="json")


# ----------------------------------------------------------------- router

router = APIRouter()


@router.get("/catalog")
async def catalog(_user=Depends(get_current_user)) -> dict:  # noqa: ANN001
    """The built-in exercise library and muscle landmarks."""
    return catalog_payload()


SPEC = ItemSpec(
    kind="workout",
    name="Workout",
    tagline="A Strong/Hevy-style lifting log with an AI coach that plans your week.",
    description=(
        "A phone-first strength log with an AI coach, in one file. Start today's session and the logger has the "
        "weights ready — last time's numbers, double-progression loads, warm-ups, a plate calculator and a rest "
        "timer — and it works offline at the gym. Programs run in mesocycles with double progression and deloads; progress "
        "shows estimated 1RMs, PRs and weekly sets per muscle against volume landmarks. Ask the coach to plan your "
        "week and it prescribes concrete loads from your own history, fitted to your goal, schedule, equipment and "
        "injuries. Not included yet: importing from other apps, exercise instructions or videos, and a watch app."
    ),
    category="Health & fitness",
    icon="dumbbell",
    color="#E2725B",
    suffix=".workout",
    model=WorkoutData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=AI_SUGGESTIONS,
    reads=("health", "meals"),
    reminders=reminders,
    archive=archive,
    router=router,
    replaces="A Strong/Hevy-style logger with an AI coach",
    highlights=[
        "Live logger with last time's numbers, prefilled loads, warm-ups and a rest timer — works offline",
        "AI coach plans your week with real weights from your history — sets × reps × load, double progression, deloads",
        "Re-fit a plan's loads to what you're actually lifting, in one tap or one sentence",
        "Programs: mesocycles, routines, scheduled sessions and reminders before each workout",
        "~170 built-in exercises (names and muscles) plus your own, filtered to the equipment you have",
        "Plate calculator rounded to your bar and plates (kg or lb)",
        "Estimated 1RM charts, a PR board and weekly sets per muscle vs MEV / MAV / MRV",
        "Logs from chat: “I did 3×8 bench at 80” just works",
    ],
)

__all__ = ["SPEC", "MUSCLES"]
