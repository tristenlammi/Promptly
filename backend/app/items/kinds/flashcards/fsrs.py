"""FSRS-6 — the Free Spaced Repetition Scheduler, as used by Anki 23.10+.

A faithful port of the open spec (open-spaced-repetition/py-fsrs v6, the
21-weight model) with three deliberate, documented choices so that this
module and ``frontend/src/items/kinds/flashcards/fsrs.ts`` give *identical*
answers (the TypeScript file is a line-by-line mirror — change both):

* **Days are study days.** Elapsed days are the difference of "study day"
  numbers — the person's local date after subtracting the day-rollover hour
  (Anki's 4 am rule) — not floored 24-hour spans. A card reviewed at 9 pm
  and again at 8 am the next morning has waited one day, as in Anki.
* **Review intervals land on the rollover moment** of the due day, so a
  card "due in 3 days" is due all of that day.
* **Fuzz is seeded** from the card, review item and repetition count
  (FNV-1a → mulberry32), so a replayed action or a preview button gives
  the same interval every time; values are spread uniformly (floor, not
  round). Rounding everywhere is half-up (``floor(x + 0.5)``), which is
  what JavaScript's ``Math.round`` does for positive numbers.
* In the Review state the four outcomes are kept in order (Hard ≤ Good <
  Easy), as ts-fsrs and Anki do.

Formulas (w = 21 weights, G = rating 1 Again … 4 Easy, D difficulty,
S stability, R retrievability, t elapsed days):

    DECAY = −w20, FACTOR = 0.9^(1/DECAY) − 1
    R(t, S) = (1 + FACTOR·t/S)^DECAY
    I(S, r) = S/FACTOR · (r^(1/DECAY) − 1)           (r = desired retention)
    S0(G) = w[G−1];  D0(G) = w4 − e^(w5·(G−1)) + 1   (clamped 1…10)
    D' = w7·D0(4) + (1−w7)·(D + (10−D)·(−w6·(G−3))/9)
    S'recall = S·(1 + e^w8·(11−D)·S^−w9·(e^((1−R)·w10) − 1)·hard·easy)
               hard = w15 if G=2, easy = w16 if G=4
    S'forget = min(w11·D^−w12·((S+1)^w13 − 1)·e^((1−R)·w14),  S/e^(w17·w18))
    S'short  = S·e^(w17·(G−3+w18))·S^−w19   (≥ S when G ≥ 2)  — same-day reviews
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo

# FSRS-6 defaults (py-fsrs / Anki), trained on ~700M reviews.
DEFAULT_WEIGHTS: tuple[float, ...] = (
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
)
STABILITY_MIN = 0.001
MIN_D, MAX_D = 1.0, 10.0
AGAIN, HARD, GOOD, EASY = 1, 2, 3, 4
RATINGS = (AGAIN, HARD, GOOD, EASY)
FUZZ_RANGES = ((2.5, 7.0, 0.15), (7.0, 20.0, 0.1), (20.0, math.inf, 0.05))
LEARN_AHEAD_MIN = 20  # a learning card due within this is shown when nothing else is left


def round_half_up(x: float) -> int:
    return math.floor(x + 0.5)


@dataclass
class Config:
    weights: tuple[float, ...] = DEFAULT_WEIGHTS
    retention: float = 0.9
    learning_steps: tuple[float, ...] = (1.0, 10.0)  # minutes
    relearning_steps: tuple[float, ...] = (10.0,)
    maximum_interval: int = 36500
    fuzz: bool = True
    rollover_hour: int = 4
    tz: tzinfo = timezone.utc

    @property
    def decay(self) -> float:
        return -self.weights[20]

    @property
    def factor(self) -> float:
        return 0.9 ** (1 / self.decay) - 1


def config_from(settings: dict, tz: tzinfo) -> Config:
    w = settings.get("weights") or []
    weights = tuple(float(x) for x in w) if len(w) == 21 else DEFAULT_WEIGHTS
    return Config(
        weights=weights,
        retention=float(settings.get("desired_retention", 0.9)),
        learning_steps=tuple(float(x) for x in settings.get("learning_steps", [1, 10])),
        relearning_steps=tuple(float(x) for x in settings.get("relearning_steps", [10])),
        maximum_interval=int(settings.get("maximum_interval", 36500)),
        fuzz=bool(settings.get("fuzz", True)),
        rollover_hour=int(settings.get("rollover_hour", 4)),
        tz=tz,
    )


# ------------------------------------------------------------- the model


def retrievability(t: float, s: float, cfg: Config) -> float:
    return (1 + cfg.factor * max(t, 0) / s) ** cfg.decay


def next_interval(s: float, cfg: Config) -> int:
    ivl = s / cfg.factor * (cfg.retention ** (1 / cfg.decay) - 1)
    return min(max(round_half_up(ivl), 1), cfg.maximum_interval)


def init_stability(g: int, cfg: Config) -> float:
    return max(cfg.weights[g - 1], STABILITY_MIN)


def init_difficulty(g: int, cfg: Config, clamp: bool = True) -> float:
    w = cfg.weights
    d = w[4] - math.exp(w[5] * (g - 1)) + 1
    return min(max(d, MIN_D), MAX_D) if clamp else d


def next_difficulty(d: float, g: int, cfg: Config) -> float:
    w = cfg.weights
    delta = -(w[6] * (g - 3))
    damped = d + (10 - d) * delta / 9
    nd = w[7] * init_difficulty(EASY, cfg, clamp=False) + (1 - w[7]) * damped
    return min(max(nd, MIN_D), MAX_D)


def short_term_stability(s: float, g: int, cfg: Config) -> float:
    w = cfg.weights
    inc = math.exp(w[17] * (g - 3 + w[18])) * s ** (-w[19])
    if g >= HARD:
        inc = max(inc, 1.0)
    return max(s * inc, STABILITY_MIN)


def forget_stability(d: float, s: float, r: float, cfg: Config) -> float:
    w = cfg.weights
    long_term = w[11] * d ** (-w[12]) * ((s + 1) ** w[13] - 1) * math.exp((1 - r) * w[14])
    short_term = s / math.exp(w[17] * w[18])
    return max(min(long_term, short_term), STABILITY_MIN)


def recall_stability(d: float, s: float, r: float, g: int, cfg: Config) -> float:
    w = cfg.weights
    hard = w[15] if g == HARD else 1.0
    easy = w[16] if g == EASY else 1.0
    out = s * (1 + math.exp(w[8]) * (11 - d) * s ** (-w[9]) * (math.exp((1 - r) * w[10]) - 1) * hard * easy)
    return max(out, STABILITY_MIN)


# ----------------------------------------------------------- study days


def parse_moment(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def day_index(moment: datetime, cfg: Config) -> int:
    """The study day ``moment`` falls in (a day number; only differences
    and round trips through :func:`day_start` mean anything)."""
    local = moment.astimezone(cfg.tz) - timedelta(hours=cfg.rollover_hour)
    return local.date().toordinal()


def day_start(n: int, cfg: Config) -> datetime:
    """When study day ``n`` begins (the rollover moment)."""
    d = date.fromordinal(n)
    return datetime(d.year, d.month, d.day, cfg.rollover_hour, tzinfo=cfg.tz)


def study_date(moment: datetime, cfg: Config) -> str:
    """The study day as ``YYYY-MM-DD``."""
    return date.fromordinal(day_index(moment, cfg)).isoformat()


def iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


# ----------------------------------------------------------------- fuzz


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def seeded_random(seed: str) -> float:
    """FNV-1a of the UTF-8 seed, one mulberry32 step → [0, 1)."""
    h = 0x811C9DC5
    for byte in seed.encode("utf-8"):
        h ^= byte
        h = _imul(h, 0x01000193)
    t = (h + 0x6D2B79F5) & 0xFFFFFFFF
    t = _imul(t ^ (t >> 15), t | 1)
    t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296


def fuzz_interval(ivl: int, rand: float, cfg: Config) -> int:
    if ivl < 2.5:
        return ivl
    delta = 1.0
    for start, end, f in FUZZ_RANGES:
        delta += f * max(min(ivl, end) - start, 0.0)
    lo = round_half_up(ivl - delta)
    hi = round_half_up(ivl + delta)
    lo = max(2, lo)
    hi = min(hi, cfg.maximum_interval)
    lo = min(lo, hi)
    return min(math.floor(rand * (hi - lo + 1) + lo), cfg.maximum_interval)


# ------------------------------------------------------------- scheduling


def new_srs(key: str) -> dict:
    return {
        "k": key, "state": "new", "stability": None, "difficulty": None, "due": None,
        "last_review": None, "reps": 0, "lapses": 0, "step": None,
    }


def _outcome(srs: dict, g: int, now: datetime, cfg: Config) -> tuple[dict, float | None, int | None]:
    """One rating's next state, before fuzz: (state, minutes, days)."""
    state = srs.get("state") or "new"
    s, d = srs.get("stability"), srs.get("difficulty")
    today = day_index(now, cfg)
    last = srs.get("last_review")
    elapsed = max(0, today - day_index(parse_moment(last), cfg)) if last else None
    if state == "new" or s is None or d is None:
        s, d = init_stability(g, cfg), init_difficulty(g, cfg)
    elif elapsed is not None and elapsed < 1:
        s, d = short_term_stability(s, g, cfg), next_difficulty(d, g, cfg)
    else:
        r = retrievability(elapsed or 0, s, cfg)
        s = forget_stability(d, s, r, cfg) if g == AGAIN else recall_stability(d, s, r, g, cfg)
        d = next_difficulty(d, g, cfg)
    out = {
        **srs, "stability": s, "difficulty": d, "reps": int(srs.get("reps") or 0) + 1,
        "lapses": int(srs.get("lapses") or 0), "last_review": iso(now),
    }
    minutes: float | None = None
    days: int | None = None
    if state in ("new", "learning", "relearning"):
        steps = cfg.relearning_steps if state == "relearning" else cfg.learning_steps
        stay = "relearning" if state == "relearning" else "learning"
        step = int(srs.get("step") or 0) if state != "new" else 0
        n = len(steps)
        if n == 0 or (step >= n and g >= HARD):
            days = next_interval(s, cfg)
        elif g == AGAIN:
            step, minutes = 0, steps[0]
        elif g == HARD:
            if step == 0 and n == 1:
                minutes = steps[0] * 1.5
            elif step == 0 and n >= 2:
                minutes = (steps[0] + steps[1]) / 2
            else:
                minutes = steps[step]
        elif g == GOOD:
            if step + 1 == n:
                days = next_interval(s, cfg)
            else:
                step, minutes = step + 1, steps[step + 1]
        else:
            days = next_interval(s, cfg)
        if minutes is not None:
            out.update(state=stay, step=step)
        else:
            out.update(state="review", step=None)
    else:  # review
        if g == AGAIN:
            out["lapses"] += 1
            if cfg.relearning_steps:
                minutes = cfg.relearning_steps[0]
                out.update(state="relearning", step=0)
            else:
                days = next_interval(s, cfg)
                out.update(state="review", step=None)
        else:
            days = next_interval(s, cfg)
            out.update(state="review", step=None)
    return out, minutes, days


def preview(srs: dict, now: datetime, cfg: Config, seed: str) -> dict[int, dict]:
    """The next state for each rating — what the four buttons would do.
    Each value is the new SRS dict plus ``_minutes`` / ``_days`` (the
    interval; strip keys starting with ``_`` before storing)."""
    raw = {g: _outcome(srs, g, now, cfg) for g in RATINGS}
    days = {g: raw[g][2] for g in RATINGS}
    rand = seeded_random(f"{seed}:{int(srs.get('reps') or 0)}")
    for g in RATINGS:
        if days[g] is not None and cfg.fuzz:
            days[g] = fuzz_interval(days[g], rand, cfg)
    if (srs.get("state") == "review") and all(days[g] is not None for g in (HARD, GOOD, EASY)):
        days[HARD] = min(days[HARD], days[GOOD])
        days[GOOD] = max(days[GOOD], days[HARD] + 1)
        days[EASY] = max(days[EASY], days[GOOD] + 1)
        for g in (HARD, GOOD, EASY):
            days[g] = min(days[g], cfg.maximum_interval)
    out: dict[int, dict] = {}
    today = day_index(now, cfg)
    for g in RATINGS:
        nxt, minutes, _ = raw[g]
        if minutes is not None:
            nxt["due"] = iso(now + timedelta(minutes=minutes))
        else:
            nxt["due"] = iso(day_start(today + days[g], cfg))
        nxt["_minutes"] = minutes
        nxt["_days"] = days[g] if minutes is None else None
        out[g] = nxt
    return out


def review(srs: dict, g: int, now: datetime, cfg: Config, seed: str) -> tuple[dict, dict]:
    """Answer ``g``: (the new SRS dict, the review-log fields)."""
    if g not in RATINGS:
        raise ValueError("rating must be 1–4")
    nxt = preview(srs, now, cfg, seed)[g]
    minutes, days = nxt.pop("_minutes"), nxt.pop("_days")
    last = srs.get("last_review")
    # Never negative: a previous review "ahead" of this one (clock skew
    # between devices, travelling west) counts as the same day.
    elapsed = max(0, day_index(now, cfg) - day_index(parse_moment(last), cfg)) if last else 0
    sched = round(minutes / 1440, 4) if minutes is not None else float(days)
    log = {"r": g, "s": STATE_CODE.get(srs.get("state") or "new", "n"), "e": elapsed, "i": sched}
    return nxt, log


STATE_CODE = {"new": "n", "learning": "l", "review": "r", "relearning": "x"}


def current_retrievability(srs: dict, now: datetime, cfg: Config) -> float | None:
    if srs.get("state") == "new" or not srs.get("stability") or not srs.get("last_review"):
        return None
    t = day_index(now, cfg) - day_index(parse_moment(srs["last_review"]), cfg)
    return retrievability(t, srs["stability"], cfg)


def label(minutes: float | None, days: int | None) -> str:
    """"<1m", "10m", "1h", "2d", "3.4mo", "1.2y" — the button labels (mirrored in TS)."""
    if minutes is not None:
        if minutes < 1:
            return "<1m"
        if minutes < 60:
            return f"{round_half_up(minutes)}m"
        if minutes < 1440:
            h = minutes / 60
            return f"{round_half_up(h * 10) / 10:g}h"
        return f"{round_half_up(minutes / 1440)}d"
    assert days is not None
    if days < 30:
        return f"{days}d"
    if days < 365:
        return f"{round_half_up(days / 30.4 * 10) / 10:g}mo"
    return f"{round_half_up(days / 365 * 10) / 10:g}y"
