"""Study's test kit: a scripted model and simulated learners.

:class:`FakeModel` stands in for ``app.study.ai.raw_call``. Every step it
writes has a known right answer (an option whose text is ``RIGHT``, steps
numbered in order, pairs ``L1``↔``R1``…), and it grades a written answer by
the word in it: ``GOOD`` correct, ``HALF`` partial, ``MISC`` wrong with a
misconception, anything else wrong.

:func:`run_course` plays a learner through a whole subject and counts what
it took, so tests can show the course really shortens, lengthens and adds a
concept for a gap.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Callable

MISC = "mixes up cause and effect"


class FakeModel:
    def __init__(self, units: int = 2, per_unit: int = 3, nature: str = "principle") -> None:
        self.units, self.per_unit, self.nature = units, per_unit, nature
        self.calls: list[dict[str, Any]] = []
        self.garbage: dict[str, int] = {}  # task -> how many unusable answers first
        self.unsuitable = False
        self.gaps = 0
        self.gap_title: str | None = None

    def tasks(self) -> list[str]:
        return [c["task"] for c in self.calls]

    async def __call__(self, t: Any, task: str, *, system: str, messages: list[dict[str, str]], max_tokens: int, temperature: float = 0.4) -> str:
        prompt = messages[0]["content"]
        self.calls.append({"task": task, "system": system, "prompt": prompt, "messages": messages})
        if self.garbage.get(task, 0) > 0:
            self.garbage[task] -= 1
            return "Sure! Here is what you asked for."
        if task == "ask":
            return "Think of it like a **seesaw**."
        return json.dumps(self.answer(task, prompt, messages))

    def answer(self, task: str, prompt: str, messages: list[dict[str, str]]) -> dict[str, Any]:
        if task == "plan":
            if self.unsuitable:
                return {"suitable": False, "unsuitable_reason": "Not for this age."}
            units, n = [], 0
            for u in range(self.units):
                concepts = []
                for _ in range(self.per_unit):
                    n += 1
                    concepts.append({
                        "key": f"c{n}", "title": f"Concept {n}", "summary": f"Idea number {n}.", "objectives": [f"can use idea {n}"],
                        "nature": self.nature, "prereqs": [f"c{n - 1}"] if n > 1 else [], "sources": [1, 99],
                    })
                units.append({"title": f"Unit {u + 1}", "summary": "A unit.", "concepts": concepts})
            return {"suitable": True, "title": "Tides", "summary": "You will understand tides.", "units": units}
        if task == "placement":
            keys = re.findall(r'key "([^"]+)"', prompt)
            return {"questions": [{"key": k, "question": f"Probe for {k}?", "options": _opts(), "correct": 0} for k in keys]}
        if task == "grade":
            text = prompt.split("<learner_answer>")[1].split("</learner_answer>")[0]
            if "GOOD" in text:
                return {"outcome": "correct", "met": [0, 1], "feedback": "Yes, that's it.", "misconception": None}
            if "HALF" in text:
                return {"outcome": "partial", "met": [0], "feedback": "Half of it.", "misconception": None}
            if "MISC" in text:
                return {"outcome": "wrong", "met": [], "feedback": "Not quite.", "misconception": {"label": MISC, "detail": "Thinks the effect comes first."}}
            return {"outcome": "wrong", "met": [], "feedback": "No.", "misconception": None}
        if task == "gap":
            self.gaps += 1
            return {
                "title": self.gap_title or f"Cause before effect {self.gaps}", "summary": "What comes first.", "objectives": ["can order cause and effect"],
                "nature": "principle", "reason": "Your answers put the effect first, so we'll sort that out.",
            }
        if task == "student_turn":
            said = messages[0]["content"].split("<conversation>")[1].split("</conversation>")[0]
            last = [line for line in said.splitlines() if line.startswith("TEACHER:")][-1]
            return {"reply": "Oh! So it pulls." if "GOOD" in last else "I still don't get it.", "resolved": "GOOD" in last}
        kind = task.split(":", 1)[1]
        return raw_step(kind)


def _opts() -> list[dict[str, str]]:
    return [
        {"text": "RIGHT", "why": "Because it is."},
        {"text": "WRONG 1", "why": "No.", "misconception": MISC},
        {"text": "WRONG 2", "why": "No."},
        {"text": "WRONG 3", "why": "No."},
    ]


def raw_step(kind: str) -> dict[str, Any]:
    """A valid raw step of ``kind``, as the model would write it."""
    hints = ["Think about the moon.", "It pulls."]
    return {
        "explain": {"title": "The idea", "body": "The moon pulls the sea.", "key_points": ["It pulls."],
                    "diagram": {"type": "flow", "title": "Pull", "nodes": [{"id": "a", "label": "Moon"}, {"id": "b", "label": "Sea"}]}, "sources": [1]},
        "predict": {"setup": "The moon is overhead.", "question": "What happens?", "options": _opts(), "correct": 0, "reveal": "The sea bulges.", "hints": hints},
        "mcq": {"question": "Which is it?", "options": _opts(), "correct": 0, "reveal": "It is RIGHT.", "hints": hints, "sources": [1]},
        "order_steps": {"prompt": "Order these.", "steps": ["1 first", "2 second", "3 third", "4 fourth"], "explain": "In that order.", "hints": hints},
        "match_pairs": {"prompt": "Match these.", "pairs": [{"left": f"L{i}", "right": f"R{i}"} for i in (1, 2, 3, 4)], "explain": "So.", "hints": hints},
        "spot_error": {"intro": "One line is wrong.", "lines": ["fine a", "fine b", "ERROR here", "fine c"], "error": 2, "explain": "That one.",
                       "correction": "fixed", "misconception": MISC, "hints": hints},
        "worked_example": {"problem": "Work it out.", "steps": [
            {"text": "Start.", "blank": False},
            {"blank": True, "question": "Next?", "options": ["RIGHT", "WRONG 1", "WRONG 2"], "correct": 0, "why": "Because."},
        ], "hints": hints},
        "explain_back": {"prompt": "Explain it to a friend.", "rubric": ["the moon pulls", "the sea bulges"], "model_answer": "The moon pulls the sea.", "hints": hints},
        "scenario": {"scenario": "You are at the beach.", "question": "Why is the water high?", "rubric": ["the moon pulls", "the sea bulges"],
                     "model_answer": "The moon.", "hints": hints},
        "teach_student": {"student_name": "Sam", "opening": "I think the sea pushes the moon.", "misconception": MISC,
                          "rubric": ["the moon pulls", "not the other way"], "model_answer": "It is the moon that pulls."},
    }[kind]


def install(monkeypatch: Any, model: FakeModel | None = None) -> FakeModel:
    """Put the fake model in. Builds don't start by themselves: call
    ``service.build_subject(id)``."""
    from app.study import ai, service, sources

    model = model or FakeModel()

    async def resolve(db: Any, user: Any) -> ai.Teacher:
        return ai.Teacher(None, "fake", user)

    async def no_web(db: Any, user: Any, query: str) -> list[Any]:
        return []

    monkeypatch.setattr(ai, "resolve", resolve)
    monkeypatch.setattr(ai, "raw_call", model)
    monkeypatch.setattr(service, "start_build", lambda subject_id: None)
    monkeypatch.setattr(sources, "search", no_web)
    return model


# ------------------------------------------------------------------ answers


def answer_for(step: Any, how: str) -> dict[str, Any]:
    """The answer a learner gives to ``step`` (a ``StudyStep``): ``good``,
    ``bad`` or ``misc`` (wrong in the way that shows the misconception)."""
    pub, kind = step.payload["public"], step.kind
    good = how == "good"

    def pick(options: list[dict[str, str]]) -> str:
        want = "RIGHT" if good else "WRONG 1" if how == "misc" else "WRONG 2"
        return next((o["id"] for o in options if o["text"] == want), next(o["id"] for o in options if o["text"] != "RIGHT"))

    if kind == "explain":
        return {}
    if kind in ("mcq", "predict"):
        return {"option_id": pick(pub["options"])}
    if kind == "order_steps":
        ids = [i["id"] for i in sorted(pub["items"], key=lambda i: i["text"])]
        return {"order": ids if good else list(reversed(ids))}
    if kind == "match_pairs":
        right = {r["text"]: r["id"] for r in pub["right"]}
        pairs = {x["id"]: right["R" + x["text"][1:]] for x in pub["left"]}
        if not good:
            ids = list(pairs)
            vals = [pairs[i] for i in ids]
            pairs = dict(zip(ids, vals[1:] + vals[:1]))
        return {"pairs": pairs}
    if kind == "spot_error":
        lines = pub["lines"]
        return {"line_id": next(x["id"] for x in lines if ("ERROR" in x["text"]) == good)}
    if kind == "worked_example":
        return {"blanks": {s["id"]: pick(s["options"]) for s in pub["steps"] if s["blank"]}}
    if kind in ("explain_back", "scenario"):
        return {"text": {"good": "GOOD answer", "misc": "MISC answer"}.get(how, "a poor answer")}
    return {}


async def answer(db: Any, user: Any, step: Any, how: str, confidence: int | None = None) -> dict[str, Any]:
    from app.study import service

    if step.kind == "teach_student":
        await service.student_turn(db, user, step.id, {"good": "GOOD: the moon pulls.", "misc": "MISC"}.get(how, "dunno"))
    return await service.answer_step(db, user, step.id, answer_for(step, how), confidence)


async def make_subject(db: Any, user: Any, *, placement: str | None = "skip", **over: Any) -> Any:
    """A built subject. ``placement``: ``skip``, ``None`` (left at the
    placement stage), or ``all``/``none`` (take it, every probe right/wrong)."""
    from app.study import service

    data = {"title": "Tides", "goal": "", "prior": "", "depth": "overview", "level": "adult", "use_web": False, "file_ids": [], "note_ids": [], **over}
    s = await service.create_subject(db, user, data)
    await service.build_subject(s.id)
    await db.refresh(s)
    if placement == "skip":
        await service.skip_placement(db, s)
    elif placement in ("all", "none"):
        se = await service.start_placement(db, user, s)
        while (st := await service.next_step(db, user, se, s)) is not None:
            await service.answer_step(db, user, st.id, answer_for(st, "good" if placement == "all" else "bad"), None)
        await db.refresh(s)
    return s


Policy = Callable[[Any, Any, int], tuple[str, int | None]]
"""(step, concept row, graded answers so far on this concept) -> (how, confidence)"""


async def run_course(db: Any, user: Any, subject: Any, policy: Policy, max_steps: int = 400) -> dict[str, Any]:
    """Play ``policy`` until the subject is complete. Returns what it took."""
    from app.study import service
    from app.study.models import StudyConcept

    out = {"steps": 0, "graded": 0, "sessions": 0, "changes": [], "kinds": [], "complete": False}
    seen: dict[uuid.UUID, int] = {}
    while out["steps"] < max_steps:
        await db.refresh(subject)
        if subject.status == "complete":
            out["complete"] = True
            break
        se = await service.start_lesson(db, subject)
        out["sessions"] += 1
        while out["steps"] < max_steps:
            st = await service.next_step(db, user, se, subject)
            if st is None:
                break
            concept = await db.get(StudyConcept, st.concept_id)
            how, conf = policy(st, concept, seen.get(st.concept_id, 0))
            res = await answer(db, user, st, how, conf)
            out["steps"] += 1
            out["kinds"].append((concept.title, st.kind, st.role, how))
            if st.kind != "explain":
                out["graded"] += 1
                if st.role != "recall":
                    seen[st.concept_id] = seen.get(st.concept_id, 0) + 1
            out["changes"] += res["changes"]
    return out


def strong(step: Any, concept: Any, n: int) -> tuple[str, int | None]:
    return "good", 3


def weak(step: Any, concept: Any, n: int) -> tuple[str, int | None]:
    """Misses the first two graded answers on every concept, then gets it."""
    if step.role == "recall":
        return "good", 2
    return ("bad", 1) if n < 2 else ("good", 2)
