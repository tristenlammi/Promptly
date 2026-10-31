"""The numbers: estimated 1RM, loads for a target rep count (working sets
that stop a couple of reps short of failure),
rounding to the plates / dumbbells someone actually has, plate maths,
warm-up ramps, personal records, weekly volume per muscle and progression.

Everything works on plain dicts (the validated file data) and kg."""
from __future__ import annotations

import math
import re
from datetime import date, timedelta
from functools import lru_cache
from typing import Any, Iterable

from app.items.kinds.workout.catalog import MUSCLES, builtin

LB = 0.45359237
FULL_GYM = {
    "barbell", "rack", "bench", "dumbbell", "kettlebell", "cable", "machine", "smith", "ez_bar", "trap_bar",
    "pullup_bar", "dip_station", "band", "rings", "cardio", "sled", "bodyweight",
}
LOWER = {"quads", "glutes", "hamstrings", "adductors", "abductors", "calves", "lower_back"}


# ------------------------------------------------------------------ exercises


def custom_as_catalog(c: dict) -> dict:
    return {
        "id": c["id"],
        "name": c["name"],
        "equipment": c.get("equipment", "bodyweight"),
        "needs": [[c.get("equipment", "bodyweight")]],
        "pattern": c.get("pattern", "core"),
        "log": c.get("log", "weight_reps"),
        "primary": list(c.get("primary", [])),
        "secondary": list(c.get("secondary", [])),
        "compound": bool(c.get("compound")),
        "start": None,
        "aliases": [],
        "custom": True,
        "notes": c.get("notes", ""),
        "archived": bool(c.get("archived")),
    }


def all_exercises(data: dict) -> dict[str, dict]:
    out = dict(builtin())
    for c in data.get("exercises", []):
        out[c["id"]] = custom_as_catalog(c)
    return out


def _norm(s: str) -> str:
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[()\-_/,.']", " ", s)
    return " ".join(s.split())


def _stem(w: str) -> str:
    return w[:-1] if len(w) >= 3 and w.endswith("s") and not w.endswith("ss") else w


def find_exercise(data: dict, ref: str) -> dict | None:
    """By id, exact name, alias, or the best fuzzy match ("bench" → Bench Press
    (Barbell), "db curl" → Curl (Dumbbell)). None when nothing is close."""
    if not ref:
        return None
    exs = all_exercises(data)
    if ref in exs:
        return exs[ref]
    q = _norm(ref)
    for e in exs.values():
        if _norm(e["name"]) == q or q in (_norm(a) for a in e["aliases"]):
            return e
    syn = {"db": "dumbbell", "bb": "barbell", "kb": "kettlebell", "ez": "ez bar", "bw": "bodyweight"}
    words = [syn.get(w, w) for w in q.split()]
    words = [_stem(w) for w in words]
    best, best_score = None, 0.0
    for e in exs.values():
        if e.get("archived"):
            continue
        hay = " ".join([_norm(e["name"]), *(_norm(a) for a in e["aliases"]), e["id"].replace("_", " ")])
        hay_words = {_stem(w) for w in hay.split()}
        hits = sum(1 for w in words if w in hay_words or any(h.startswith(w) for h in hay_words))
        if not hits:
            continue
        score = hits / len(words) - 0.01 * len(_norm(e["name"]).split())
        # The plain barbell version wins a bare name ("squat", "bench").
        if "barbell" in _norm(e["name"]) and "barbell" not in words and "dumbbell" not in words:
            score += 0.02
        if score > best_score:
            best, best_score = e, score
    return best if best_score >= 0.6 else None


def suggestions_for(data: dict, ref: str, n: int = 5) -> list[str]:
    q = set(_norm(ref).split())
    scored = []
    for e in all_exercises(data).values():
        words = set(_norm(e["name"]).split())
        s = len(q & words)
        if s:
            scored.append((s, e["name"]))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [name for _, name in scored[:n]]


def available_equipment(settings: dict) -> set[str]:
    have = set(settings.get("equipment") or [])
    if "full_gym" in have or not have:
        return set(FULL_GYM)
    return have | {"bodyweight"}


def is_available(ex: dict, settings: dict) -> bool:
    have = available_equipment(settings)
    return any(all(n in have for n in alt) for alt in ex.get("needs") or [[ex.get("equipment", "bodyweight")]])


def load_equipment(ex: dict, settings: dict) -> str:
    """Which implement the load is rounded for (the first available
    alternative)."""
    have = available_equipment(settings)
    for alt in ex.get("needs") or [[ex.get("equipment", "bodyweight")]]:
        if all(n in have for n in alt):
            return alt[0]
    return ex.get("equipment", "bodyweight")


def is_upper(ex: dict) -> bool:
    prim = set(ex.get("primary") or [])
    return not (prim & LOWER)


# ------------------------------------------------------------------- strength


def e1rm(kg: float | None, reps: int | None, reserve: float | None = None, formula: str = "epley") -> float | None:
    """Estimated one-rep max. ``reserve`` (reps that could still have been
    done) counts as reps — only the internal :data:`RESERVE` margin load
    suggestions assume, never something the person logs; beyond ~20
    effective reps the formulas stop meaning anything."""
    if not kg or not reps or reps <= 0:
        return None
    eff = reps + (reserve or 0)
    if eff > 20:
        return None
    if eff <= 1:
        return float(kg)
    if formula == "brzycki":
        return kg * 36.0 / (37.0 - eff)
    return kg * (1.0 + eff / 30.0)


def load_for(one_rm: float, reps: int, reserve: float = 0, formula: str = "epley") -> float:
    """The load for ``reps`` with ``reserve`` reps left in the tank, from an e1RM."""
    eff = max(1.0, reps + (reserve or 0))
    if eff <= 1:
        return one_rm
    if formula == "brzycki":
        return one_rm * (37.0 - min(eff, 36)) / 36.0
    return one_rm / (1.0 + eff / 30.0)


@lru_cache(maxsize=64)
def _per_side_sums(plates: tuple[tuple[float, int], ...]) -> tuple[float, ...]:
    sums = {0}
    for kg, pairs in plates:
        g = int(round(kg * 1000))
        sums = {s + g * k for s in sums for k in range(pairs + 1) if s + g * k <= 400_000}
    return tuple(sorted(s / 1000 for s in sums))


def _plates_key(settings: dict) -> tuple[tuple[float, int], ...]:
    plates = settings.get("plates") or []
    return tuple(sorted(((float(p["kg"]), int(p.get("pairs", 10))) for p in plates), reverse=True))


def achievable(ex: dict, settings: dict) -> tuple[str, list[float]] | None:
    """(implement, the loads that can be set up, ascending) — or None for
    lifts without an external load."""
    log = ex.get("log")
    if log in ("duration", "distance") and ex.get("equipment") in ("bodyweight", "cardio", "band"):
        return None
    eq = load_equipment(ex, settings)
    if log == "assisted":
        step = float(settings.get("machine_step_kg") or 5)
        return "machine", [round(step * i, 4) for i in range(0, 41)]
    if log == "bodyweight_reps" or eq in ("bodyweight", "band", "pullup_bar", "dip_station", "rings", "bench"):
        if log != "bodyweight_reps" or eq == "band":
            return None
        # Added load on a belt / vest: single plates or dumbbells.
        smallest = min((float(p["kg"]) for p in settings.get("plates") or []), default=1.25)
        return "added", [round(smallest * i, 4) for i in range(0, 121)]
    if eq in ("barbell", "ez_bar", "trap_bar", "smith", "rack"):
        bar = {"ez_bar": "ez_bar_kg", "trap_bar": "trap_bar_kg"}.get(eq, "bar_kg")
        bar_kg = 0.0 if eq == "smith" else float(settings.get(bar) or 0)
        sums = _per_side_sums(_plates_key(settings))
        return eq if eq != "rack" else "barbell", sorted({round(bar_kg + 2 * s, 4) for s in sums})
    if eq == "dumbbell":
        exact = settings.get("dumbbells_kg") or []
        if exact:
            return "dumbbell", sorted(float(x) for x in exact)
        step = float(settings.get("dumbbell_step_kg") or 2)
        top = float(settings.get("dumbbell_max_kg") or 60)
        return "dumbbell", [round(step * i, 4) for i in range(1, int(top / step + 1e-6) + 1)]
    if eq == "kettlebell":
        bells = settings.get("kettlebells_kg") or [8, 12, 16, 20, 24, 28, 32]
        return "kettlebell", sorted(float(x) for x in bells)
    step = float(settings.get("machine_step_kg") or 5)
    return eq, [round(step * i, 4) for i in range(1, 81)]


def round_load(kg: float | None, ex: dict, settings: dict, mode: str = "nearest") -> float | None:
    if kg is None:
        return None
    got = achievable(ex, settings)
    if got is None:
        return round(kg, 2)
    _eq, loads = got
    if not loads:
        return round(kg, 2)
    if mode == "down":
        below = [x for x in loads if x <= kg + 1e-6]
        return below[-1] if below else loads[0]
    return min(loads, key=lambda x: (abs(x - kg), x))


def increment(ex: dict, settings: dict) -> float:
    """The smallest sensible jump for a lift (beginner LP: +2.5 kg lower,
    +1.25 kg upper — or the next loadable step if that's bigger)."""
    nominal = 2.5 if not is_upper(ex) else 1.25
    if settings.get("units") == "lb":
        nominal = (5 if not is_upper(ex) else 2.5) * LB
    got = achievable(ex, settings)
    if got is None:
        return 0.0
    _eq, loads = got
    steps = [b - a for a, b in zip(loads, loads[1:]) if b - a > 1e-6]
    step = min(steps) if steps else nominal
    return max(nominal, step)


def plates_per_side(total_kg: float, settings: dict, bar_kg: float | None = None) -> dict:
    """Greedy plate breakdown for one side of the bar."""
    bar = float(settings.get("bar_kg") or 20) if bar_kg is None else bar_kg
    side = max(0.0, (total_kg - bar) / 2)
    left = round(side, 4)
    out: list[float] = []
    for kg, pairs in _plates_key(settings):
        n = 0
        while n < pairs and left + 1e-6 >= kg:
            out.append(kg)
            left = round(left - kg, 4)
            n += 1
    return {"bar_kg": bar, "per_side": out, "remainder_kg": round(left * 2, 3), "loaded_kg": round(bar + 2 * sum(out), 3)}


def warmups(work_kg: float, ex: dict, settings: dict) -> list[dict]:
    """A warm-up ramp to a working weight: empty bar ×10, ~40% ×5, ~60% ×3,
    ~80% ×2 for barbell lifts; two lighter sets for dumbbells / machines."""
    got = achievable(ex, settings)
    if not work_kg or got is None:
        return []
    eq, _ = got
    out: list[dict] = []
    if eq in ("barbell", "ez_bar", "trap_bar", "smith"):
        bar = {"ez_bar": settings.get("ez_bar_kg", 10), "trap_bar": settings.get("trap_bar_kg", 25)}.get(eq, settings.get("bar_kg", 20))
        bar = float(bar or 0) if eq != "smith" else 0.0
        if bar and work_kg > bar * 1.15:
            out.append({"kg": bar, "reps": 10})
        steps = [(0.4, 5), (0.6, 3), (0.8, 2)] if work_kg >= max(bar * 2.5, 60) else [(0.6, 5), (0.8, 3)]
    else:
        steps = [(0.5, 10), (0.75, 5)]
    for pct, reps in steps:
        kg = round_load(work_kg * pct, ex, settings, "down")
        if kg is None or kg <= 0 or kg >= work_kg - 1e-6:
            continue
        if out and kg <= out[-1]["kg"] + 1e-6:
            continue
        out.append({"kg": kg, "reps": reps})
    return out


# -------------------------------------------------------------------- history


def is_hard(s: dict) -> bool:
    """A set that counts: done, not a warm-up, and not a 0-rep miss."""
    if s.get("type", "working") == "warmup" or not s.get("done", True):
        return False
    return not (s.get("reps") == 0 and not s.get("seconds") and not s.get("meters"))


def is_cardio(ex: dict) -> bool:
    return ex.get("pattern") == "cardio"


# A cardio bout's default length on a timed machine (one bout, not sets).
CARDIO_SECONDS = 1200


def rest_for(ex: dict, settings: dict, rest_s: int | None = None) -> int:
    """Rest after a set: the explicit one, else none for cardio (one bout),
    else the compound / isolation default."""
    if rest_s is not None:
        return rest_s
    if is_cardio(ex):
        return 0
    return int(settings.get("rest_compound_s", 180) if ex.get("compound") else settings.get("rest_isolation_s", 90))


# The margin load suggestions work with: a working set stops a couple of
# reps short of failure (most people do), so a set is read that way when it
# feeds a *load suggestion* — reading every set as a max effort
# under-estimates the e1RM and walks every suggestion down — and suggested
# loads leave the same margin. Records keep the strict reading. Internal
# only: nothing asks for or shows reps in reserve.
RESERVE = 2.0


def is_deload(data: dict, w: dict) -> bool:
    """A deload workout (its own flag, or the planned session it followed)."""
    if w.get("deload"):
        return True
    sid = w.get("session_id")
    if sid:
        s = next((p for p in data.get("planned", []) if p.get("id") == sid), None)
        return bool(s and s.get("deload"))
    return False


def history_for(data: dict, exercise_id: str, include_active: bool = False, skip_deload: bool = False) -> list[tuple[dict, dict]]:
    """[(workout, workout-exercise)] for one exercise, oldest first.
    ``skip_deload`` leaves out deload sessions (submaximal on purpose) — but
    only while there's something else to go on."""
    out = []
    workouts = list(data.get("workouts", []))
    if include_active and data.get("active"):
        workouts.append(data["active"])
    for w in workouts:
        for we in w.get("exercises", []):
            if we.get("exercise_id") == exercise_id and any(is_hard(s) for s in we.get("sets", [])):
                out.append((w, we))
    if skip_deload:
        kept = [(w, we) for w, we in out if not is_deload(data, w)]
        return kept or out
    return out


def set_e1rm(s: dict, ex: dict, settings: dict, reserve: float | None = None) -> float | None:
    """e1RM of one set from its load × reps. ``reserve`` is the margin a
    load suggestion assumes (:data:`RESERVE`); a set marked to failure never
    gets one. A legacy stored ``rir`` on old sets is ignored."""
    if ex.get("log") != "weight_reps":
        return None
    margin = reserve if reserve is not None and s.get("type") != "failure" else None
    return e1rm(s.get("kg"), s.get("reps"), margin, settings.get("e1rm_formula", "epley"))


def session_stats(we: dict, ex: dict, settings: dict, reserve: float | None = None) -> dict:
    hard = [s for s in we.get("sets", []) if is_hard(s)]
    best = None
    best_e = None
    for s in hard:
        e = set_e1rm(s, ex, settings, reserve)
        if e is not None and (best_e is None or e > best_e):
            best, best_e = s, e
    volume = sum((s.get("kg") or 0) * (s.get("reps") or 0) for s in hard if ex.get("log") == "weight_reps")
    return {
        "sets": len(hard),
        "best_set": best,
        "e1rm": round(best_e, 1) if best_e else None,
        "volume_kg": round(volume, 1),
        "top_kg": max((s.get("kg") or 0 for s in hard), default=0),
        "max_reps": max((s.get("reps") or 0 for s in hard), default=0),
        "max_seconds": max((s.get("seconds") or 0 for s in hard), default=0),
        "max_meters": max((s.get("meters") or 0 for s in hard), default=0),
    }


REP_MAXES = (1, 3, 5, 10)


def records(data: dict, exercise_id: str | None = None) -> dict[str, dict]:
    """Personal records per exercise: best e1RM, heaviest weight for 1/3/5/10
    reps, best session volume, most reps; durations / distances for timed
    lifts; least assistance for assisted ones. Each with the date."""
    exs = all_exercises(data)
    settings = data.get("settings", {})
    out: dict[str, dict] = {}
    for w in data.get("workouts", []):
        for we in w.get("exercises", []):
            eid = we.get("exercise_id")
            if exercise_id and eid != exercise_id:
                continue
            ex = exs.get(eid)
            if ex is None:
                continue
            rec = out.setdefault(eid, {})
            day = w.get("date")
            stats = session_stats(we, ex, settings)
            if not stats["sets"]:
                continue

            def bump(key: str, value: float | None, extra: dict | None = None, lower: bool = False) -> None:
                if value is None or value <= 0 and not lower:
                    return
                cur = rec.get(key)
                if cur is None or (value < cur["value"] if lower else value > cur["value"] + 1e-9):
                    rec[key] = {"value": round(value, 2), "date": day, **(extra or {})}

            log = ex.get("log")
            for s in we.get("sets", []):
                if not is_hard(s):
                    continue
                if log == "weight_reps":
                    e = set_e1rm(s, ex, settings)
                    bump("e1rm", round(e, 1) if e else None, {"kg": s.get("kg"), "reps": s.get("reps")})
                    for n in REP_MAXES:
                        if (s.get("reps") or 0) >= n:
                            bump(f"{n}rm", s.get("kg"), {"reps": s.get("reps")})
                elif log == "bodyweight_reps":
                    bump("max_reps", s.get("reps"), {"kg": s.get("kg")})
                    if s.get("kg"):
                        bump("heaviest", s.get("kg"), {"reps": s.get("reps")})
                elif log == "assisted":
                    if s.get("reps"):
                        # Less assistance is harder: "most reps" only counts
                        # at the least assistance reached (12 reps with
                        # more help isn't a record over 8 with less).
                        kg = float(s.get("kg") or 0)
                        least = rec.get("least_assist")
                        if least is None or kg < least["value"] - 1e-9:
                            rec["least_assist"] = {"value": round(kg, 2), "date": day, "reps": s.get("reps")}
                            rec["max_reps"] = {"value": s.get("reps"), "date": day, "kg": s.get("kg")}
                        elif kg <= least["value"] + 1e-9:
                            bump("max_reps", s.get("reps"), {"kg": s.get("kg")})
                elif log == "duration":
                    bump("longest", s.get("seconds"))
                elif log == "distance":
                    bump("farthest", s.get("meters"), {"seconds": s.get("seconds")})
            if log == "weight_reps":
                bump("volume", stats["volume_kg"])
    return {k: v for k, v in out.items() if v}


# Which record headlines an exercise's PRs in a workout (one per exercise,
# so a good bench day reads "1 PR", not e1RM + 5RM + volume = 3).
PR_PRIORITY = ("e1rm", "1rm", "3rm", "5rm", "10rm", "heaviest", "least_assist", "max_reps", "longest", "farthest", "volume")


def new_records(data: dict, workout: dict) -> list[dict]:
    """The PRs ``workout`` set, compared with everything before it. A record
    must beat an earlier one (a first time — or a first 10-rep set — isn't a
    PR); of the 1/3/5/10RMs one set beats, only the most specific counts.
    Each exercise's PRs come together, the ``headline`` one first (exactly
    one per exercise): count PRs by exercise, show the rest as detail."""
    before = {**data, "workouts": [w for w in data.get("workouts", []) if w.get("id") != workout.get("id") and (w.get("date"), w.get("started_at") or "") < (workout.get("date"), workout.get("started_at") or "~")]}
    after = {**data, "workouts": [*before["workouts"], workout]}
    exs = all_exercises(data)
    out = []
    done: set[str] = set()
    for we in workout.get("exercises", []):
        eid = we["exercise_id"]
        if eid in done:
            continue  # the same lift twice in one workout: records cover both
        done.add(eid)
        old = records(before, eid).get(eid, {})
        new = records(after, eid).get(eid, {})
        beaten = [k for k in new if k.endswith("rm") and k != "e1rm" and k in old and new[k].get("date") == workout.get("date") and new[k]["value"] > old[k]["value"] + 1e-9]
        # 82.5 × 8 beats the 1, 3 and 5RM at once: say the most specific one.
        keep_rm = max(beaten, key=lambda k: int(k[:-2])) if beaten else None
        mine = []
        for key, rec in new.items():
            if key.endswith("rm") and key != "e1rm" and key != keep_rm:
                continue
            prev = old.get(key)
            if prev is None or rec.get("date") != workout.get("date"):
                continue  # a first time isn't a record
            if rec["value"] < prev["value"] - 1e-9 if key == "least_assist" else rec["value"] > prev["value"] + 1e-9:
                mine.append({"exercise_id": eid, "exercise": exs.get(eid, {}).get("name", eid), "kind": key, "value": rec["value"], "previous": prev["value"]})
        mine.sort(key=lambda p: PR_PRIORITY.index(p["kind"]) if p["kind"] in PR_PRIORITY else 99)
        for i, p in enumerate(mine):
            p["headline"] = i == 0
        out.extend(mine)
    return out


def baseline_for(settings: dict, exercise_id: str) -> dict | None:
    """The best the person stated for a lift (``settings.baselines``)."""
    return next((b for b in settings.get("baselines") or [] if b.get("exercise_id") == exercise_id), None)


def baseline_e1rm(settings: dict, ex: dict) -> float | None:
    """e1RM from a stated best, read strictly (a "best" is a hard set — so
    loads from it keep the usual margin below it)."""
    b = baseline_for(settings, ex["id"])
    if not b or ex.get("log") != "weight_reps":
        return None
    return e1rm(b.get("kg"), b.get("reps"), None, settings.get("e1rm_formula", "epley"))


def recent_e1rm(data: dict, ex: dict, sessions: int = 3, weeks: int = 10, today: date | None = None, reserve: float | None = RESERVE) -> tuple[float | None, str]:
    """The basis for load suggestions: the best e1RM from the last few
    sessions (recent performance, autoregulated) — falling back to the
    all-time best when the recent ones are old. ``reserve`` = the margin
    working sets are read with (:data:`RESERVE` for load maths; ``None`` =
    the strict e1RM the person sees on their records)."""
    settings = data.get("settings", {})
    hist = history_for(data, ex["id"], skip_deload=True)
    base = baseline_e1rm(settings, ex)
    if not hist:
        return (base, "baseline") if base else (None, "none")
    recent = hist[-sessions:]
    cutoff = ((today or date.today()) - timedelta(weeks=weeks)).isoformat()
    vals = [session_stats(we, ex, settings, reserve)["e1rm"] for w, we in recent if w.get("date", "") >= cutoff]
    vals = [v for v in vals if v]
    if vals:
        return max(vals), "recent"
    allv = [session_stats(we, ex, settings, reserve)["e1rm"] for _w, we in hist]
    allv = [v for v in allv if v]
    if allv:
        return max(allv), "all_time"
    return (base, "baseline") if base else (None, "none")


def starting_load(ex: dict, settings: dict, reps: int, reserve: float = RESERVE) -> float | None:
    """A conservative first-session load from bodyweight ratios (novice
    strength norms scaled by experience and sex) — to be calibrated."""
    if ex.get("log") != "weight_reps":
        return None
    r = ex.get("start")
    if r is None:
        eq = ex.get("equipment")
        comp = ex.get("compound")
        r = {
            "barbell": 0.4 if comp else 0.15,
            "dumbbell": 0.15 if comp else 0.06,
            "kettlebell": 0.2,
            "cable": 0.35 if comp else 0.12,
            "machine": 0.5 if comp else 0.25,
            "smith": 0.4,
        }.get(eq, 0.2)
    bw = settings.get("bodyweight_kg") or {"male": 80, "female": 65}.get(settings.get("sex") or "", 72)
    exp = {"beginner": 1.0, "intermediate": 1.45, "advanced": 1.8}.get(settings.get("experience", "beginner"), 1.0)
    sex = {"male": 1.0, "female": 0.7}.get(settings.get("sex") or "", 0.85)
    base = r * bw * exp * sex  # ~10 reps, ~3 short of failure
    one = base * (1 + 13 / 30)
    return load_for(one, reps, reserve, settings.get("e1rm_formula", "epley")) * 0.92


def _work_sets(we: dict) -> list[dict]:
    return [s for s in we.get("sets", []) if s.get("type", "working") in ("working", "failure") and s.get("done", True)]


def _level(work: list[dict], assisted: bool) -> float:
    """The load a session was trained at: the heaviest — or, for assisted
    lifts, the least assistance (the hardest)."""
    loads = [float(s.get("kg") or 0) for s in work] or [0.0]
    return min(loads) if assisted else max(loads)


def suggest(data: dict, ex: dict, reps: int, today: date | None = None) -> dict:
    """What to load for ``reps`` working reps: from the recent e1RM, rounded to
    the person's kit; else a calibration load. Also says what double
    progression makes of last time. ``e1rm_kg`` is the strict estimate (the
    one their records show); the load maths reads working sets with the
    internal :data:`RESERVE` margin and leaves the same margin."""
    settings = data.get("settings", {})
    formula = settings.get("e1rm_formula", "epley")
    one, basis = recent_e1rm(data, ex, today=today)
    strict, _ = recent_e1rm(data, ex, today=today, reserve=None)
    hist = history_for(data, ex["id"], skip_deload=True)
    last = hist[-1] if hist else None
    out: dict[str, Any] = {"exercise_id": ex["id"], "exercise": ex["name"], "reps": reps}
    if last:
        w, we = last
        hard = [s for s in we.get("sets", []) if is_hard(s)]
        out["last"] = {"date": w.get("date"), "sets": [{k: s.get(k) for k in ("kg", "reps", "seconds", "meters") if s.get(k) is not None} for s in hard]}
    if ex.get("log") != "weight_reps":
        out["note"] = {
            "assisted": "Assisted lift: the load is the machine's assistance — less assistance is progress.",
            "bodyweight_reps": "Bodyweight lift: the load is added weight (belt / vest); progress reps, then add load.",
        }.get(ex.get("log"), "No load to compute for this lift — progress time or distance.")
        if last:
            out["progression"] = progress_call(data, ex, reps, reps, today=today) or progression(data, ex, last[1], (reps, reps))
        return out
    if one:
        raw = load_for(one, reps, RESERVE, formula)
        out.update({"e1rm_kg": round(strict or one, 1), "basis": basis, "load_kg": round_load(raw, ex, settings, "nearest"), "exact_kg": round(raw, 1), "calibrate": False})
        if reps > 15:
            out["note"] = "Rep-max maths gets loose above ~15 reps — treat the load as a starting point and let the reps decide."
    else:
        raw = starting_load(ex, settings, reps)
        out.update({"basis": "estimate", "load_kg": round_load(raw, ex, settings, "down"), "exact_kg": round(raw or 0, 1), "calibrate": True,
                    "note": "No history: a conservative starting load from bodyweight norms. Treat session 1 as calibration — if every rep is easy, add a step next set; if form breaks before the target reps, drop one."})
    if last:
        call = progress_call(data, ex, reps, reps, today=today)
        if call:
            out["progression"] = call
    return out


def progression(data: dict, ex: dict, we: dict, rep_range: tuple[int, int]) -> dict:
    """Double progression on the last session: every working set at the top
    load reached the top of the range → add the smallest increment and go
    back to the bottom; otherwise keep the load and add reps.

    Assisted lifts run it the other way (``load_kg`` = assistance: hit the
    range → the next step *less* assistance); bodyweight lifts with added
    load add load; plain bodyweight / timed lifts add reps or time."""
    settings = data.get("settings", {})
    hard = _work_sets(we)
    if not hard:
        return {"action": "repeat"}
    lo, hi = rep_range
    log = ex.get("log")
    assisted = log == "assisted"
    top = _level(hard, assisted)
    at_top = [s for s in hard if abs(float(s.get("kg") or 0) - top) < 1e-6]
    hit = all((s.get("reps") or 0) >= hi for s in at_top)
    best = max((s.get("reps") or 0) for s in at_top)
    if log == "duration":
        secs = max((s.get("seconds") or 0) for s in hard)
        if not secs:
            return {"action": "repeat"}
        return {"action": "add_time", "seconds": secs + max(5, round(secs * 0.1 / 5) * 5), "why": f"Beat {secs} s by a little (or add load once it's easy)."}
    if log == "distance":
        return {"action": "repeat", "why": "Beat last time's distance or pace."}
    if assisted:
        if not hit:
            return {"action": "add_reps", "load_kg": top, "reps": best + 1, "why": f"Keep {fmt_kg(top, settings)} assistance and add reps toward {hi}."}
        if top <= 1e-6:
            return {"action": "unassisted", "load_kg": 0.0, "reps": lo, "why": f"{hi} reps with no assistance — move to the unassisted version."}
        got = achievable(ex, settings)
        less = [x for x in (got[1] if got else []) if x < top - 1e-6]
        nxt = less[-1] if less else 0.0
        return {"action": "less_assist", "load_kg": nxt, "reps": lo, "why": f"Hit {hi} reps on every set with {fmt_kg(top, settings)} assistance — take {fmt_kg(nxt, settings)} and restart at {lo}."}
    if log == "bodyweight_reps":
        if not hit:
            return {"action": "add_reps", "load_kg": top, "reps": best + 1, "why": f"Beat last time by a rep (toward {hi})."}
        if top <= 1e-6:
            return {"action": "add_reps", "load_kg": 0.0, "reps": best + 1, "why": f"{hi}+ reps on every set — add a little load (belt, vest, backpack) or a harder variation."}
        nxt = round_load(top + increment(ex, settings), ex, settings, "nearest")
        return {"action": "add_load", "load_kg": max(nxt or top, top), "reps": lo, "why": f"Hit {hi} reps on every set with +{fmt_kg(top, settings)} — add load and restart at {lo}."}
    if log != "weight_reps":
        return {"action": "add_reps", "reps": best + 1, "why": "Beat last time by a rep."}
    if top <= 0:
        return {"action": "repeat"}  # no load logged: nothing to progress from
    if hit:
        nxt = round_load(top + increment(ex, settings), ex, settings, "nearest")
        if nxt is not None and nxt <= top:
            got = achievable(ex, settings)
            nxt = next((x for x in (got[1] if got else []) if x > top + 1e-6), top)
        return {"action": "add_load", "load_kg": nxt, "reps": lo, "why": f"Hit {hi} reps on every set at {fmt_kg(top, settings)} — add load and restart at {lo}."}
    return {"action": "add_reps", "load_kg": top, "why": f"Keep {fmt_kg(top, settings)} and add reps toward {hi}."}


def last_session(data: dict, ex: dict) -> tuple[dict, dict] | None:
    """The session progression reads: the latest non-deload one."""
    hist = history_for(data, ex["id"], skip_deload=True)
    return hist[-1] if hist else None


def comparable(we: dict, lo: int, hi: int, assisted: bool = False) -> bool:
    """Did that session train roughly this rep range? (Then double
    progression applies directly; across ranges, go through the e1RM.)"""
    work = [s for s in _work_sets(we) if s.get("reps")]
    if not work:
        return False
    top = _level(work, assisted)
    reps = [s["reps"] for s in work if abs(float(s.get("kg") or 0) - top) < 1e-6]
    return lo - 2 <= max(reps) <= hi + 1


def _mean(xs: list[int]) -> float:
    return sum(xs) / len(xs)


def stall_reset(data: dict, ex: dict, lo: int, hi: int) -> dict | None:
    """Repeated failure → a reset. The last two (non-deload) sessions at the
    same load both fell short of the bottom of the range without gaining a
    rep — or three at the same load never reached the top and didn't gain
    reps — then drop ~10% and build back up (the classic linear-progression
    reset; one bad day on its own changes nothing)."""
    if ex.get("log") != "weight_reps":
        return None
    settings = data.get("settings", {})
    run: list[tuple[float, list[int]]] = []
    for _w, we in history_for(data, ex["id"], skip_deload=True)[-3:]:
        work = [s for s in _work_sets(we) if s.get("reps") is not None]
        if not work or not comparable(we, lo, hi):
            run = []  # only an unbroken run in this rep range counts
            continue
        top = _level(work, False)
        reps = [int(s.get("reps") or 0) for s in work if abs(float(s.get("kg") or 0) - top) < 1e-6]
        if run and abs(run[-1][0] - top) >= 1e-6:
            run = []  # a different load starts a new run
        run.append((top, reps))
    if len(run) < 2 or run[-1][0] <= 0:
        return None
    top = run[-1][0]
    a, b = run[-2], run[-1]
    reason = None
    if min(a[1]) < lo and min(b[1]) < lo and _mean(b[1]) <= _mean(a[1]) + 1e-9:
        reason = f"short of {lo} reps at {fmt_kg(top, settings)} two sessions running"
    elif len(run) >= 3 and not any(min(v[1]) >= hi for v in run) and _mean(run[-1][1]) <= _mean(run[0][1]) + 1e-9:
        reason = f"no reps gained at {fmt_kg(top, settings)} in three sessions"
    if not reason:
        return None
    new = round_load(top * 0.9, ex, settings, "down")
    if new is None or new >= top - 1e-6:
        got = achievable(ex, settings)
        new = next((x for x in reversed(got[1] if got else []) if x < top - 1e-6), None)
    if new is None:
        return None
    return {"action": "reset", "load_kg": new, "reps": lo, "from_kg": top,
            "why": f"Stalled — {reason}. Reset ~10% to {fmt_kg(new, settings)} and build back up (sleep, food and stress are worth a look)."}


# Double progression reads the last session only while it's recent; after a
# longer break the (all-time) e1RM is the safer basis.
PROGRESSION_WEEKS = 6


def progress_call(data: dict, ex: dict, lo: int, hi: int, today: date | None = None) -> dict | None:
    """What last time says for a ``lo``-``hi`` session: a stall reset, else
    double progression on the last recent comparable (non-deload) session;
    None when there's no such session."""
    last = last_session(data, ex)
    if last is None:
        return None
    if last[0].get("date", "") < ((today or date.today()) - timedelta(weeks=PROGRESSION_WEEKS)).isoformat():
        return None
    if not comparable(last[1], lo, hi, assisted=ex.get("log") == "assisted"):
        return None
    reset = stall_reset(data, ex, lo, hi)
    if reset:
        return reset
    return progression(data, ex, last[1], (lo, hi))


def next_load(data: dict, ex: dict, lo: int, hi: int, today: date | None = None) -> dict:
    """The load for the next session of a lift at ``lo``-``hi`` reps.

    1. Double progression on the last non-deload session when it trained a
       comparable range: every top set at the top of the range -> the next
       loadable increment, otherwise the same load (beat the reps); a lift
       that has stalled (see :func:`stall_reset`) resets ~10%.
    2. Else the recent e1RM (working sets read as stopping ~2 reps short)
       -> the load for the middle of the range with the same margin.
    3. Else a conservative calibration load from bodyweight norms.

    Assisted / bodyweight lifts: the assistance / added load double
    progression calls for, else last time's.

    Returns ``{"load_kg", "basis": progression|reset|e1rm|baseline|estimate|last|none,
    "why", "calibrate"}``."""
    settings = data.get("settings", {})
    log = ex.get("log")
    call = progress_call(data, ex, lo, hi, today=today)
    if call and call.get("load_kg") is not None:
        basis = "reset" if call.get("action") == "reset" else "progression"
        last = last_session(data, ex)
        return {"load_kg": call["load_kg"], "basis": basis, "why": call.get("why", ""), "calibrate": False,
                "action": call.get("action"), "from": last[0].get("date") if last else None}
    if log in ("assisted", "bodyweight_reps"):
        last = last_session(data, ex)
        work = _work_sets(last[1]) if last else []
        if work:
            return {"load_kg": _level(work, log == "assisted"), "basis": "last", "why": "Last time's load.", "calibrate": False}
        b = baseline_for(settings, ex["id"])
        if b:
            return {"load_kg": b["kg"], "basis": "baseline", "why": f"Your stated best ({fmt_kg(b['kg'], settings)} × {b['reps']}).", "calibrate": False}
        return {"load_kg": None, "basis": "none", "why": "", "calibrate": False}
    if log != "weight_reps":
        return {"load_kg": None, "basis": "none", "why": "No external load to compute.", "calibrate": False}
    mid = (lo + hi) // 2
    s = suggest(data, ex, mid, today=today)
    if s.get("load_kg") is None:
        return {"load_kg": None, "basis": "none", "why": "", "calibrate": False}
    if s.get("calibrate"):
        return {"load_kg": s["load_kg"], "basis": "estimate", "why": s.get("note", ""), "calibrate": True}
    if s.get("basis") == "baseline":
        b = baseline_for(settings, ex["id"]) or {}
        return {"load_kg": s["load_kg"], "basis": "baseline", "calibrate": False,
                "why": f"From your stated best of {fmt_kg(b.get('kg'), settings)} × {b.get('reps')} (nothing logged yet), with a couple of reps in hand."}
    return {"load_kg": s["load_kg"], "basis": "e1rm", "why": f"From a recent e1RM of {fmt_kg(s.get('e1rm_kg'), settings)}.", "calibrate": False}


# Deloads: ~10% lighter (assisted lifts: ~25% more assistance).
DELOAD_FACTOR = 0.9


def deload_load(kg: float | None, ex: dict, settings: dict) -> float | None:
    if kg is None:
        return None
    if ex.get("log") == "assisted":
        return round_load(kg * 1.25, ex, settings, "nearest") if kg > 0 else kg
    if kg <= 0:
        return kg
    return round_load(kg * DELOAD_FACTOR, ex, settings, "down")


def prefill(data: dict, ex: dict, rx: dict | None, today: date | None = None, deload: bool = False) -> float | None:
    """The load a set starts at in the logger: the better of the prescribed
    load and what double progression makes of last time (a plan written
    weeks ago shouldn't hold someone back) — but a stalled lift's reset wins
    over a plan that asks for the load they stalled at; the prescription as
    is on a deload (or ~10% under last time when it has no load); a % of the
    current (strict) e1RM; or progression; or a calibration estimate.
    Assisted lifts: "better" = less assistance."""
    settings = data.get("settings", {})
    log = ex.get("log")
    reps_lo = (rx or {}).get("reps_min", 8)
    reps_hi = (rx or {}).get("reps_max", reps_lo)
    planned = rx.get("load_kg") if rx else None
    if log in ("assisted", "bodyweight_reps"):
        assisted = log == "assisted"
        if planned is not None and deload:
            return planned
        if deload:
            prev = last_session(data, ex)
            work = _work_sets(prev[1]) if prev else []
            return deload_load(_level(work, assisted), ex, settings) if work else None
        nl = next_load(data, ex, reps_lo, reps_hi, today=today)
        if planned is None:
            return nl.get("load_kg")
        call = nl.get("load_kg") if nl.get("basis") == "progression" else None
        if call is None:
            return planned
        return min(planned, call) if assisted else max(planned, call)
    if log != "weight_reps":
        if planned is not None:
            return planned
        last = last_session(data, ex)
        if last:
            hard = [s for s in last[1].get("sets", []) if is_hard(s)]
            return max((s.get("kg") or 0 for s in hard), default=None) or None
        return None
    if planned is not None:
        if deload:
            return planned
        call = progress_call(data, ex, reps_lo, reps_hi, today=today)
        if call and call.get("load_kg") is not None:
            if call.get("action") == "reset":
                if planned >= call["from_kg"] - 1e-6:
                    return call["load_kg"]
            elif call["load_kg"] > planned + 1e-6:
                return call["load_kg"]
        return planned
    if rx and rx.get("load_pct"):
        # % of the strict e1RM (the one their records show), not the
        # margin-inflated basis load suggestions use.
        one, _ = recent_e1rm(data, ex, today=today, reserve=None)
        if one:
            kg = round_load(one * rx["load_pct"] / 100, ex, settings)
            return deload_load(kg, ex, settings) if deload else kg
    if deload:
        prev = last_session(data, ex)
        work = _work_sets(prev[1]) if prev else []
        if work and _level(work, False) > 0:
            return deload_load(_level(work, False), ex, settings)
    return next_load(data, ex, reps_lo, reps_hi, today=today).get("load_kg")


# --------------------------------------------------------------------- volume


def week_start(day: date, settings: dict) -> date:
    first = 6 if settings.get("week_start") == "sun" else 0
    return day - timedelta(days=(day.weekday() - first) % 7)


def muscle_sets(exercise_sets: Iterable[tuple[dict, float]]) -> dict[str, float]:
    """Hard sets per muscle: a primary muscle counts 1 per set, a secondary
    one ½ (the common fractional-counting convention)."""
    out: dict[str, float] = {m: 0.0 for m in MUSCLES}
    for ex, n in exercise_sets:
        if is_cardio(ex):
            continue  # conditioning, not hard sets for a muscle
        for m in ex.get("primary") or []:
            out[m] = out.get(m, 0) + n
        for m in ex.get("secondary") or []:
            out[m] = out.get(m, 0) + n * 0.5
    return out


def landmark_status(m: str, sets: float) -> str:
    lm = MUSCLES[m]
    if sets < lm["mev"] or (lm["mev"] == 0 and sets == 0):
        return "below_mev" if lm["mev"] > 0 else ("none" if sets == 0 else "productive")
    if sets > lm["mrv"]:
        return "above_mrv"
    if sets >= lm["mrv"] - 1:
        return "near_mrv"
    if sets > lm["mav"][1]:
        return "above_mav"
    if sets >= lm["mav"][0]:
        return "in_mav"
    return "productive"


def weekly_volume(data: dict, start: date, *, source: str = "logged") -> dict[str, float]:
    exs = all_exercises(data)
    end = (start + timedelta(days=7)).isoformat()
    s0 = start.isoformat()
    pairs: list[tuple[dict, float]] = []
    if source in ("logged", "both"):
        for w in data.get("workouts", []):
            if s0 <= w.get("date", "") < end:
                for we in w.get("exercises", []):
                    ex = exs.get(we["exercise_id"])
                    if ex:
                        pairs.append((ex, sum(1 for s in we.get("sets", []) if is_hard(s))))
    if source in ("planned", "both"):
        for p in data.get("planned", []):
            if s0 <= p.get("date", "") < end and p.get("status") != "skipped" and (source == "planned" or p.get("status") == "planned"):
                for rx in p.get("exercises", []):
                    ex = exs.get(rx["exercise_id"])
                    if ex:
                        pairs.append((ex, rx.get("sets", 3) + rx.get("drop_sets", 0)))
    return muscle_sets(pairs)


def estimate_minutes(exercises: list[dict], data: dict) -> int:
    """Session length budget: each working set ≈ 45 s of work plus its rest;
    warm-ups ≈ 4 min for each heavy compound; 2 min per exercise change-over."""
    exs = all_exercises(data)
    settings = data.get("settings", {})
    total = 0.0
    for rx in exercises:
        ex = exs.get(rx.get("exercise_id"), {})
        rest = rest_for(ex, settings, rx.get("rest_s"))
        sets = rx.get("sets", 3) + rx.get("drop_sets", 0)
        work = (rx.get("seconds") or 45) if ex.get("log") != "distance" else (rx.get("seconds") or 600)
        total += sets * work + max(0, sets - 1) * rest + 120
        if ex.get("compound") and ex.get("log") == "weight_reps" and rx.get("warmup") is not False:
            total += 240
    return int(math.ceil(total / 60))


# Per-session ceiling on hard sets for one muscle (primary sets): past
# ~10 the extra sets add little and recovery suffers — split across days.
SESSION_SET_CAP = 10


def volume_warnings(data: dict, sessions: list[dict]) -> list[str]:
    """Sanity checks on planned sessions, for the coach: weekly hard sets per
    muscle above MRV (or, for beginners, well past the ~10–12 they need), and
    more than :data:`SESSION_SET_CAP` primary sets for a muscle in one
    session. Deload weeks aren't checked. One line per problem."""
    exs = all_exercises(data)
    settings = data.get("settings", {})
    beginner = settings.get("experience", "beginner") == "beginner"
    weeks: dict[str, list[dict]] = {}
    out: list[str] = []
    seen: set[tuple[str, str]] = set()
    for s in sessions:
        if s.get("deload"):
            continue
        wk = week_start(date.fromisoformat(s["date"]), settings).isoformat()
        weeks.setdefault(wk, []).append(s)
        prim: dict[str, float] = {}
        for rx in s.get("exercises", []):
            ex = exs.get(rx["exercise_id"])
            for m in (ex or {}).get("primary") or []:
                prim[m] = prim.get(m, 0) + rx.get("sets", 3) + rx.get("drop_sets", 0)
        for m, n in prim.items():
            if n > SESSION_SET_CAP and ("session", m + s.get("name", "")) not in seen:
                seen.add(("session", m + s.get("name", "")))
                out.append(f"{s.get('name')} ({s['date']}): {n:g} sets for {MUSCLES[m]['label'].lower()} in one session — over ~{SESSION_SET_CAP}; spread them across the week.")
    worst: dict[str, tuple[float, str]] = {}
    for wk, ss in weeks.items():
        pairs = [(exs[rx["exercise_id"]], rx.get("sets", 3) + rx.get("drop_sets", 0)) for s in ss for rx in s.get("exercises", []) if rx["exercise_id"] in exs]
        for m, v in muscle_sets(pairs).items():
            if v > worst.get(m, (0, ""))[0]:
                worst[m] = (v, wk)
    for m, (v, wk) in worst.items():
        lm = MUSCLES[m]
        if v > lm["mrv"]:
            out.append(f"{lm['label']}: {v:g} hard sets/week (week of {wk}) — above its MRV (~{lm['mrv']}); trim it.")
        elif beginner and lm["mev"] > 0 and v > 14:
            out.append(f"{lm['label']}: {v:g} hard sets/week (week of {wk}) — a beginner grows on ~6–12; more mostly adds fatigue.")
    return out[:12]


# -------------------------------------------------------------------- display


def to_unit(kg: float | None, settings: dict) -> float | None:
    if kg is None:
        return None
    return round(kg / LB, 1) if settings.get("units") == "lb" else round(kg, 2)


def from_unit(v: float | None, unit: str) -> float | None:
    if v is None:
        return None
    return v * LB if unit == "lb" else float(v)


def fmt_kg(kg: float | None, settings: dict) -> str:
    if kg is None:
        return "–"
    v = to_unit(kg, settings)
    txt = f"{v:.2f}".rstrip("0").rstrip(".")
    return f"{txt} {settings.get('units', 'kg')}"
