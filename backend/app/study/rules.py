"""Study's rules: how evidence moves mastery, what is taught next, and when
the course changes. Pure functions over plain values — no database, no
model — so every rule here is tested directly (``tests/test_study_rules.py``).

The model never decides any of this. It writes a step, or grades a written
answer; these rules decide what that means.

Mastery (0–1 per concept)
-------------------------
One graded answer is one piece of evidence::

    score   = 1 correct · 0.5 partial · 0 wrong
    score  *= 0.7 for each hint used
    weight  = how much the kind of step proves (KIND_WEIGHT)
    weight *= 0.6 when the answer was right but the learner said "guessing"
    mastery += RATE * weight * (score - mastery)
    mastery *= 0.85 when the answer was wrong and the learner said "sure"

A concept is **mastered** when mastery ≥ GATE, with at least MIN_EVIDENCE
graded answers, at least one of them a right answer in the learner's own
words or work (a *production* step). A test-out step that is answered right
with no hints masters it on the spot.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

RATE = 0.6
GATE = 0.7
MIN_EVIDENCE = 2
#: Entering a concept at or above this (placement said "probably known"):
#: no explanation first, straight to one check in the learner's own words.
COMPRESS_AT = 0.6
#: A mastered concept that a recall step drops below this is taught again.
RELEARN_BELOW = 0.4
KNOWN_MASTERY = 0.85
LIKELY_MASTERY = 0.6

#: Steps spent on one concept in one session before it is parked for later.
PARK_AFTER = 7
#: A recall step on something learned earlier, every this many graded steps.
RECALL_EVERY = 4
#: A lesson is about this many steps.
SESSION_STEPS = 12

MAX_GAPS_PER_CONCEPT = 2
MAX_GAPS_PER_SUBJECT = 8

UNGRADED = ("explain",)
RECOGNITION = ("predict", "mcq", "order_steps", "match_pairs")
PRODUCTION = ("explain_back", "spot_error", "worked_example", "scenario", "teach_student")
KINDS = UNGRADED + RECOGNITION + PRODUCTION

KIND_WEIGHT = {
    "predict": 0.5,
    "mcq": 0.7,
    "order_steps": 0.7,
    "match_pairs": 0.7,
    "spot_error": 0.9,
    "worked_example": 0.9,
    "explain_back": 1.0,
    "scenario": 1.0,
    "teach_student": 1.0,
}
OUTCOME_SCORE = {"correct": 1.0, "partial": 0.5, "wrong": 0.0}

#: Which steps suit which kind of concept, in the order they are tried.
RECOGNITION_FOR = {
    "fact": ("mcq", "match_pairs", "predict"),
    "process": ("order_steps", "predict", "mcq"),
    "principle": ("predict", "mcq", "match_pairs"),
    "skill": ("mcq", "order_steps", "predict"),
}
PRODUCTION_FOR = {
    "fact": ("explain_back", "spot_error", "scenario", "teach_student"),
    "process": ("worked_example", "spot_error", "explain_back", "scenario"),
    "principle": ("explain_back", "teach_student", "scenario", "spot_error"),
    "skill": ("worked_example", "scenario", "spot_error", "explain_back"),
}
#: A different way in, each time an explanation didn't land.
ANGLES = ("plain", "analogy", "example", "step_by_step", "contrast")


# ------------------------------------------------------------------ mastery


@dataclass
class Evidence:
    kind: str
    outcome: str  # correct | partial | wrong
    hints: int = 0
    confidence: int | None = None  # 1 guessing · 2 think so · 3 sure
    test_out: bool = False


@dataclass
class ConceptState:
    """What the rules need to know about one concept."""

    id: str
    position: float
    mastery: float = 0.0
    state: str = "new"  # new | learning | mastered | known
    nature: str = "principle"
    prereqs: tuple[str, ...] = ()
    evidence_count: int = 0
    production_ok: int = 0
    origin: str = "planned"
    last_seen: float = 0.0  # any increasing number; smaller = longer ago

    @property
    def done(self) -> bool:
        return self.state in ("mastered", "known")


def score_of(ev: Evidence) -> float:
    return OUTCOME_SCORE[ev.outcome] * (0.7 ** max(0, ev.hints))


def update_mastery(mastery: float, ev: Evidence) -> float:
    """Mastery after one piece of evidence (see the module docstring)."""
    if ev.kind in UNGRADED:
        return mastery
    weight = KIND_WEIGHT[ev.kind]
    if ev.outcome == "correct" and ev.confidence == 1:
        weight *= 0.6
    new = mastery + RATE * weight * (score_of(ev) - mastery)
    if ev.outcome == "wrong" and ev.confidence == 3:
        new *= 0.85
    return round(min(1.0, max(0.0, new)), 4)


def apply_evidence(c: ConceptState, ev: Evidence) -> ConceptState:
    """``c`` after ``ev``: mastery, counters and state."""
    if ev.kind in UNGRADED:
        if c.state == "new":
            c.state = "learning"
        return c
    c.mastery = update_mastery(c.mastery, ev)
    c.evidence_count += 1
    clean = ev.outcome == "correct" and ev.hints == 0
    if ev.kind in PRODUCTION and ev.outcome == "correct":
        c.production_ok += 1
    if ev.test_out and clean and ev.confidence != 1:
        c.mastery = max(c.mastery, KNOWN_MASTERY)
        c.state = "mastered"
        return c
    if c.done:
        if c.mastery < RELEARN_BELOW:
            c.state = "learning"
            c.production_ok = 0
            c.evidence_count = 0
        return c
    c.state = "mastered" if passes_gate(c) else "learning"
    return c


def passes_gate(c: ConceptState) -> bool:
    return c.mastery >= GATE and c.evidence_count >= MIN_EVIDENCE and c.production_ok >= 1


# --------------------------------------------------------------- what's next


def available(concepts: Sequence[ConceptState]) -> list[ConceptState]:
    """Concepts that can be taught now: not done, everything they depend on done."""
    by_id = {c.id: c for c in concepts}
    out = []
    for c in concepts:
        if c.done:
            continue
        if all(by_id[p].done for p in c.prereqs if p in by_id):
            out.append(c)
    return out


def pick_concept(
    concepts: Sequence[ConceptState], *, focus: str | None = None, parked: Iterable[str] = ()
) -> ConceptState | None:
    """The concept to teach next.

    Stay on the one in hand until it passes the gate (or is parked). Then a
    gap concept that is ready (it was added because something else is
    waiting on it), then the weakest one already started, then the next new
    one in course order.
    """
    parked = set(parked)
    ready = [c for c in available(concepts) if c.id not in parked]
    if not ready:
        return None
    for c in ready:
        if c.id == focus:
            return c
    gaps = [c for c in ready if c.origin == "gap"]
    if gaps:
        return min(gaps, key=lambda c: c.position)
    started = [c for c in ready if c.state == "learning"]
    if started:
        return min(started, key=lambda c: (c.mastery, c.position))
    return min(ready, key=lambda c: c.position)


def recall_due(graded_in_session: int, since_recall: int, concepts: Sequence[ConceptState], focus: str | None) -> ConceptState | None:
    """A learned concept to bring back now, or ``None``. One every
    RECALL_EVERY graded steps: the one seen longest ago."""
    if graded_in_session == 0 or since_recall < RECALL_EVERY:
        return None
    done = [c for c in concepts if c.done and c.id != focus]
    if not done:
        return None
    return min(done, key=lambda c: (c.last_seen, c.position))


def choose_kind(c: ConceptState, history: Sequence[tuple[str, str | None]]) -> tuple[str, str]:
    """The kind of step to give next on ``c``, and the angle for an explanation.

    ``history`` is this concept's steps so far, oldest first, as
    ``(kind, outcome)`` (``None`` for an explanation or one not yet answered).

    * Nothing yet: explain first, unless the learner came in already likely
      to know it (COMPRESS_AT), who goes straight to a production check.
    * After an explanation: a recognition step.
    * After a right answer: a production step (a new kind each time).
    * After a wrong or partial answer: explain again from another angle,
      then an easier recognition step.
    """
    kinds = [k for k, _ in history]
    explains = kinds.count("explain")
    angle = ANGLES[min(explains, len(ANGLES) - 1)]
    recog = RECOGNITION_FOR.get(c.nature, RECOGNITION_FOR["principle"])
    prod = PRODUCTION_FOR.get(c.nature, PRODUCTION_FOR["principle"])

    def fresh(options: Sequence[str]) -> str:
        used = [k for k in kinds if k in options]
        for k in options:
            if k not in used:
                return k
        # All tried: the one used longest ago, never the last one given.
        last = kinds[-1] if kinds else None
        rest = [k for k in options if k != last] or list(options)
        return min(rest, key=lambda k: max(i for i, x in enumerate(kinds) if x == k))

    if not history:
        if c.mastery >= COMPRESS_AT:
            return fresh(prod), angle
        return "explain", angle
    last_kind, last_outcome = history[-1]
    if last_kind == "explain":
        return fresh(recog), angle
    if last_outcome == "correct":
        return fresh(prod), angle
    return "explain", angle


def recall_kind(c: ConceptState, history: Sequence[tuple[str, str | None]]) -> str:
    """A quick recognition step for a recall, not the one used last time."""
    recog = RECOGNITION_FOR.get(c.nature, RECOGNITION_FOR["principle"])
    last = history[-1][0] if history else None
    for k in recog:
        if k != last and k != "predict":
            return k
    return "mcq"


def should_park(steps_on_concept_in_session: int) -> bool:
    return steps_on_concept_in_session >= PARK_AFTER


# ------------------------------------------------------------------- gaps


def norm_key(label: str) -> str:
    """A misconception's label, normalised so "the same one again" matches."""
    return re.sub(r"[^a-z0-9]+", " ", (label or "").lower()).strip()[:80]


def wants_gap(*, outcome: str, confidence: int | None, misconception_seen: int, wrong_on_concept: int) -> bool:
    """Whether what just happened calls for a new concept on the map.

    A gap is added when the learner got it wrong (or half right) and either
    the same wrong idea has now shown up twice, or once from someone who was
    sure, or they have missed three times on this concept for any reason.
    """
    if outcome == "correct":
        return False
    if misconception_seen >= 2:
        return True
    if misconception_seen >= 1 and confidence == 3 and outcome == "wrong":
        return True
    return wrong_on_concept >= 3


@dataclass
class GapCheck:
    ok: bool
    why: str = ""


def gap_allowed(
    *, title: str, existing_titles: Iterable[str], gaps_for_concept: int, gaps_in_subject: int, target_is_gap: bool
) -> GapCheck:
    """Whether a proposed gap concept may be added (the model proposes, this decides)."""
    t = norm_key(title)
    if len(t) < 3:
        return GapCheck(False, "no title")
    if target_is_gap:
        return GapCheck(False, "a gap concept doesn't get gaps of its own")
    if gaps_for_concept >= MAX_GAPS_PER_CONCEPT:
        return GapCheck(False, "this concept already has its gap concepts")
    if gaps_in_subject >= MAX_GAPS_PER_SUBJECT:
        return GapCheck(False, "the subject already has its gap concepts")
    if t in {norm_key(x) for x in existing_titles}:
        return GapCheck(False, "already on the map")
    return GapCheck(True)


# --------------------------------------------------------------- placement


@dataclass
class Placement:
    """A binary search over probe questions laid out in course order."""

    n: int
    lo: int = 0
    hi: int | None = None
    asked: dict[int, bool] = field(default_factory=dict)  # probe index -> right?

    def __post_init__(self) -> None:
        if self.hi is None:
            self.hi = self.n - 1

    def next_probe(self) -> int | None:
        if self.lo > self.hi:
            return None
        return (self.lo + self.hi) // 2

    def record(self, index: int, right: bool) -> None:
        self.asked[index] = right
        if right:
            self.lo = index + 1
        else:
            self.hi = index - 1

    @property
    def frontier(self) -> int:
        """The last probe the learner is taken to know; -1 for none."""
        return self.lo - 1

    def to_json(self) -> dict[str, Any]:
        return {"n": self.n, "lo": self.lo, "hi": self.hi, "asked": {str(k): v for k, v in self.asked.items()}}

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Placement":
        return cls(n=int(d["n"]), lo=int(d["lo"]), hi=int(d["hi"]), asked={int(k): bool(v) for k, v in (d.get("asked") or {}).items()})


def placement_result(
    concepts: Sequence[ConceptState], probe_concept_ids: Sequence[str], p: Placement
) -> dict[str, tuple[float, str]]:
    """Starting mastery and state per concept id after placement.

    Probes answered right: known. Everything else at or before the last
    probe taken as known: likely known (taught in compressed form: one check
    in the learner's own words, no explanation first). A probe answered
    wrong stays at zero even when it sits before the frontier.
    """
    out: dict[str, tuple[float, str]] = {}
    if p.frontier < 0:
        return out
    pos = {c.id: c.position for c in concepts}
    edge = pos.get(probe_concept_ids[p.frontier])
    if edge is None:
        return out
    wrong = {probe_concept_ids[i] for i, ok in p.asked.items() if not ok}
    right = {probe_concept_ids[i] for i, ok in p.asked.items() if ok}
    for c in concepts:
        if c.position > edge or c.id in wrong:
            continue
        out[c.id] = (KNOWN_MASTERY, "known") if c.id in right else (LIKELY_MASTERY, "new")
    return out


def pick_probes(concepts: Sequence[ConceptState], want: int = 7) -> list[str]:
    """Up to ``want`` concept ids spread evenly through the course, in order."""
    ordered = sorted(concepts, key=lambda c: c.position)
    if len(ordered) <= want:
        return [c.id for c in ordered]
    step = (len(ordered) - 1) / (want - 1)
    picks: list[str] = []
    for i in range(want):
        cid = ordered[round(i * step)].id
        if cid not in picks:
            picks.append(cid)
    return picks
