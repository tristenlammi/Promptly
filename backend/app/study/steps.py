"""The kinds of lesson step: what the model must write for each, what the
browser is sent, and how the ones with a right answer are graded here.

A stored step payload is ``{"public": {...}, "key": {...}}``. ``public`` is
what the learner sees. ``key`` (the right answer, the rubric, the hints) is
never sent before the step is answered; afterwards it is the step's
``reveal``. The model writes a *raw* shape (answers by position); this
module checks it, gives everything ids and shuffles what should be shuffled.

Diagrams are data the app draws itself (``clean_diagram``) — the model never
writes markup.
"""
from __future__ import annotations

import json
import random
from typing import Any

from app.study import figures, rules

MAX_MD = 6000
MAX_SHORT = 400


class StepInvalid(ValueError):
    """The model's step can't be used (it is asked again)."""


class AnswerInvalid(ValueError):
    """The learner's answer isn't in the shape this kind of step takes."""


def _s(v: Any, n: int = MAX_SHORT) -> str:
    return str(v if v is not None else "").strip()[:n]


def _need(v: Any, what: str, n: int = MAX_MD) -> str:
    s = _s(v, n)
    if not s:
        raise StepInvalid(f"missing {what}")
    return s


def _list(v: Any, what: str, lo: int, hi: int) -> list[Any]:
    if not isinstance(v, list) or len(v) < lo:
        raise StepInvalid(f"{what}: need at least {lo}")
    return v[:hi]


def _hints(raw: dict[str, Any]) -> list[str]:
    h = raw.get("hints")
    return [_s(x, 500) for x in h if _s(x)][:2] if isinstance(h, list) else []


def _index(v: Any, n: int, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < n:
        raise StepInvalid(f"{what}: not a position in the list")
    return v


def _sources(raw: dict[str, Any], valid: set[int]) -> list[int]:
    out: list[int] = []
    for x in raw.get("sources") if isinstance(raw.get("sources"), list) else []:
        if isinstance(x, int) and not isinstance(x, bool) and x in valid and x not in out:
            out.append(x)
    return out[:4]


# ------------------------------------------------------------------ diagram

DIAGRAM_TYPES = ("flow", "cycle", "tree", "timeline", "compare", "bars")


def clean_diagram(raw: Any) -> dict[str, Any] | None:
    """A diagram the app can draw, or ``None`` (a bad one is dropped, not an error)."""
    if not isinstance(raw, dict) or raw.get("type") not in DIAGRAM_TYPES:
        return None
    t = raw["type"]
    out: dict[str, Any] = {"type": t, "title": _s(raw.get("title"), 120)}
    try:
        if t in ("flow", "cycle", "tree"):
            nodes = []
            for i, n in enumerate(_list(raw.get("nodes"), "nodes", 2, 10)):
                label = _s(n.get("label") if isinstance(n, dict) else n, 60)
                if not label:
                    raise StepInvalid("node label")
                nid = _s(n.get("id"), 20) if isinstance(n, dict) and _s(n.get("id")) else f"n{i + 1}"
                node = {"id": nid, "label": label, "note": _s(n.get("note"), 140) if isinstance(n, dict) else ""}
                if t == "tree":
                    node["parent"] = _s(n.get("parent"), 20) or None if isinstance(n, dict) else None
                nodes.append(node)
            ids = [n["id"] for n in nodes]
            if len(set(ids)) != len(ids):
                raise StepInvalid("node ids")
            out["nodes"] = nodes
            if t == "tree":
                roots = [n for n in nodes if n["parent"] is None]
                if len(roots) != 1 or any(n["parent"] not in ids for n in nodes if n["parent"]):
                    raise StepInvalid("tree")
            else:
                edges = []
                for e in raw.get("edges") if isinstance(raw.get("edges"), list) else []:
                    if isinstance(e, dict) and e.get("from") in ids and e.get("to") in ids:
                        edges.append({"from": e["from"], "to": e["to"], "label": _s(e.get("label"), 40)})
                if not edges:  # in the order given
                    edges = [{"from": a, "to": b, "label": ""} for a, b in zip(ids, ids[1:])]
                    if t == "cycle":
                        edges.append({"from": ids[-1], "to": ids[0], "label": ""})
                out["edges"] = edges[:16]
        elif t == "timeline":
            out["items"] = [
                {"label": _need(i.get("label"), "label", 80), "when": _s(i.get("when"), 40), "note": _s(i.get("note"), 140)}
                for i in _list(raw.get("items"), "items", 2, 10)
                if isinstance(i, dict)
            ]
            if len(out["items"]) < 2:
                raise StepInvalid("items")
        elif t == "compare":
            cols = [_s(c, 40) for c in _list(raw.get("columns"), "columns", 2, 3)]
            rows = []
            for r in _list(raw.get("rows"), "rows", 1, 8):
                cells = [_s(c, 140) for c in (r.get("cells") if isinstance(r, dict) else [])][: len(cols)]
                if len(cells) != len(cols):
                    raise StepInvalid("cells")
                rows.append({"label": _s(r.get("label"), 60), "cells": cells})
            out["columns"], out["rows"] = cols, rows
        else:  # bars
            bars = []
            for b in _list(raw.get("bars"), "bars", 2, 8):
                v = b.get("value") if isinstance(b, dict) else None
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise StepInvalid("bar value")
                bars.append({"label": _need(b.get("label"), "label", 40), "value": float(v)})
            out["unit"], out["bars"] = _s(raw.get("unit"), 20), bars
    except (StepInvalid, AttributeError, TypeError):
        return None
    return out


#: Languages a "write code" step can run (in the browser's sandbox).
CODE_LANGS = ("javascript",)


def _plain(v: Any, depth: int = 0) -> bool:
    """JSON-plain: what a check can expect back."""
    if v is None or isinstance(v, (bool, str)):
        return True
    if isinstance(v, (int, float)):
        return v == v and abs(v) < 1e15
    if depth > 4:
        return False
    if isinstance(v, list):
        return len(v) <= 50 and all(_plain(x, depth + 1) for x in v)
    if isinstance(v, dict):
        return len(v) <= 30 and all(isinstance(k, str) and _plain(x, depth + 1) for k, x in v.items())
    return False


# ----------------------------------------------------------------- building


def _options(raw_opts: Any, correct: Any, rng: random.Random, lo: int = 3) -> tuple[list[dict], str, dict, dict]:
    opts = _list(raw_opts, "options", lo, 5)
    ci = _index(correct, len(opts), "correct")
    public, notes, misc = [], {}, {}
    correct_id = ""
    order = list(range(len(opts)))
    rng.shuffle(order)
    for n, i in enumerate(order):
        o = opts[i]
        text = _need(o.get("text") if isinstance(o, dict) else o, "option text", 300)
        oid = f"o{n + 1}"
        public.append({"id": oid, "text": text})
        if isinstance(o, dict):
            if _s(o.get("why"), 500):
                notes[oid] = _s(o.get("why"), 500)
            if i != ci and _s(o.get("misconception"), 200):
                misc[oid] = _s(o.get("misconception"), 200)
        if i == ci:
            correct_id = oid
    if len({p["text"].lower() for p in public}) != len(public):
        raise StepInvalid("two options are the same")
    return public, correct_id, notes, misc


def build(
    kind: str, raw: Any, *, valid_sources: set[int] | None = None, seed: int | None = None, tool: str = "", lang: str = ""
) -> dict[str, Any]:
    """A stored payload from the model's raw step. ``tool`` is what the concept
    suits (a figure type, or ``code`` in ``lang``). Raises :class:`StepInvalid`."""
    if kind not in rules.KINDS:
        raise StepInvalid("unknown kind")
    if not isinstance(raw, dict):
        raise StepInvalid("not an object")
    rng = random.Random(seed)
    pub: dict[str, Any] = {}
    key: dict[str, Any] = {}
    if kind == "explain":
        pub = {
            "title": _s(raw.get("title"), 120),
            "body_md": _need(raw.get("body"), "body"),
            "key_points": [_s(x, 240) for x in (raw.get("key_points") if isinstance(raw.get("key_points"), list) else []) if _s(x)][:5],
            "diagram": clean_diagram(raw.get("diagram")),
        }
        # A figure to play with, only where the concept suits one (a bad one is dropped).
        if tool in rules.FIGURE_TOOLS and raw.get("figure") is not None:
            fig = figures.clean_or_none(raw.get("figure"), want=tool)
            if fig is not None:
                pub["figure"], pub["diagram"] = fig, None
    elif kind in ("mcq", "predict"):
        options, correct_id, notes, misc = _options(raw.get("options"), raw.get("correct"), rng)
        pub = {"question_md": _need(raw.get("question"), "question", 1500), "options": options}
        if kind == "predict":
            pub["setup_md"] = _need(raw.get("setup"), "setup", 2000)
        key = {"correct_id": correct_id, "notes": notes, "misconceptions": misc, "explain_md": _s(raw.get("reveal") or raw.get("explain"), 2000)}
        if kind == "predict" and not key["explain_md"]:
            raise StepInvalid("missing reveal")
    elif kind == "order_steps":
        items = [_need(x, "step", 300) for x in _list(raw.get("steps"), "steps", 3, 7)]
        if len({i.lower() for i in items}) != len(items):
            raise StepInvalid("two steps are the same")
        ids = [f"s{i + 1}" for i in range(len(items))]
        shown = list(zip(ids, items))
        for _ in range(8):
            rng.shuffle(shown)
            if [i for i, _t in shown] != ids:
                break
        pub = {"prompt_md": _need(raw.get("prompt"), "prompt", 1500), "items": [{"id": i, "text": t} for i, t in shown]}
        key = {"order": ids, "explain_md": _s(raw.get("explain"), 2000)}
    elif kind == "match_pairs":
        pairs = _list(raw.get("pairs"), "pairs", 3, 6)
        left, right, mapping = [], [], {}
        for i, p in enumerate(pairs):
            if not isinstance(p, dict):
                raise StepInvalid("pair")
            lid, rid = f"l{i + 1}", f"r{i + 1}"
            left.append({"id": lid, "text": _need(p.get("left"), "left", 200)})
            right.append({"id": rid, "text": _need(p.get("right"), "right", 300)})
            mapping[lid] = rid
        if len({r["text"].lower() for r in right}) != len(right) or len({x["text"].lower() for x in left}) != len(left):
            raise StepInvalid("two pairs are the same")
        rng.shuffle(right)
        pub = {"prompt_md": _need(raw.get("prompt"), "prompt", 1500), "left": left, "right": right}
        key = {"pairs": mapping, "explain_md": _s(raw.get("explain"), 2000)}
    elif kind == "spot_error":
        lines = [_need(x, "line", 400) for x in _list(raw.get("lines"), "lines", 3, 8)]
        ei = _index(raw.get("error"), len(lines), "error")
        pub = {"intro_md": _need(raw.get("intro"), "intro", 1500), "lines": [{"id": f"x{i + 1}", "text": t} for i, t in enumerate(lines)]}
        key = {
            "error_id": f"x{ei + 1}",
            "explain_md": _need(raw.get("explain"), "explain", 2000),
            "correction": _s(raw.get("correction"), 600),
            "misconception": _s(raw.get("misconception"), 200),
        }
    elif kind == "worked_example":
        steps_pub, blanks, notes = [], {}, {}
        for i, st in enumerate(_list(raw.get("steps"), "steps", 2, 8)):
            if not isinstance(st, dict):
                raise StepInvalid("step")
            sid = f"w{i + 1}"
            if st.get("blank"):
                options, correct_id, _n, _m = _options(st.get("options"), st.get("correct"), rng, lo=2)
                steps_pub.append({"id": sid, "blank": True, "text_md": _need(st.get("question") or st.get("text"), "question", 1000), "options": options})
                blanks[sid] = correct_id
                notes[sid] = _s(st.get("why") or st.get("text"), 800)
            else:
                steps_pub.append({"id": sid, "blank": False, "text_md": _need(st.get("text"), "text", 1500)})
        if not blanks:
            raise StepInvalid("no step for the learner to fill in")
        pub = {"problem_md": _need(raw.get("problem"), "problem", 2000), "steps": steps_pub}
        key = {"blanks": blanks, "notes": notes}
    elif kind in ("explain_back", "scenario"):
        rubric = [_s(x, 300) for x in _list(raw.get("rubric"), "rubric", 2, 6) if _s(x)]
        if len(rubric) < 2:
            raise StepInvalid("rubric")
        if kind == "scenario":
            pub = {"scenario_md": _need(raw.get("scenario"), "scenario", 2500), "question_md": _need(raw.get("question"), "question", 800)}
        else:
            pub = {"prompt_md": _need(raw.get("prompt"), "prompt", 1500)}
        key = {"rubric": rubric, "model_answer_md": _need(raw.get("model_answer"), "model answer", 2500)}
    elif kind == "teach_student":
        rubric = [_s(x, 300) for x in _list(raw.get("rubric"), "rubric", 2, 5) if _s(x)]
        if len(rubric) < 2:
            raise StepInvalid("rubric")
        pub = {"student_name": _s(raw.get("student_name"), 30) or "Sam", "opening_md": _need(raw.get("opening"), "opening", 1200), "max_turns": 3}
        key = {
            "misconception": _need(raw.get("misconception"), "misconception", 300),
            "rubric": rubric,
            "model_answer_md": _need(raw.get("model_answer"), "model answer", 2500),
        }
    elif kind == "explore":
        if tool not in rules.FIGURE_TOOLS:
            raise StepInvalid("this concept has no figure")
        try:
            fig = figures.clean(raw.get("figure"), want=tool)
            goal, solution = figures.clean_goal(fig, raw.get("goal"))
        except figures.FigureInvalid as e:
            raise StepInvalid(str(e)) from e
        pub = {"prompt_md": _need(raw.get("prompt"), "prompt", 1500), "figure": figures.public(fig, hide_notes=True)}
        if fig["type"] == "plot":
            pub["targets"] = goal["points"]  # drawn on the plot: "make the curve pass through these"
        key = {"goal": goal, "solution": solution, "figure": fig, "explain_md": _need(raw.get("explain"), "explain", 2000)}
    elif kind == "write_code":
        if tool != "code" or lang not in CODE_LANGS:
            raise StepInvalid("this concept has no code to run")
        checks = []
        for i, c in enumerate(_list(raw.get("checks"), "checks", 2, 6)):
            if not isinstance(c, dict) or "expect" not in c:
                raise StepInvalid("each check is {call, expect, label}")
            expect = c["expect"]
            if not _plain(expect) or len(json.dumps(expect)) > 600:
                raise StepInvalid("a check's expect must be a plain value (number, text, true/false, null, list, object)")
            checks.append({"id": f"k{i + 1}", "call": _need(c.get("call"), "check call", 200), "expect": expect, "label": _s(c.get("label"), 160)})
        if len({c["call"] for c in checks}) != len(checks):
            raise StepInvalid("two checks are the same")
        starter, solution = _need(raw.get("starter"), "starter", 3000), _need(raw.get("solution"), "solution", 4000)
        if starter.strip() == solution.strip():
            raise StepInvalid("the starter code must leave the work to the learner")
        # The checks and a known-good answer go to the browser: that is where
        # the code runs (a sandbox with no network). They are never shown.
        pub = {"prompt_md": _need(raw.get("prompt"), "prompt", 2000), "lang": lang, "starter": starter, "run": {"checks": checks, "solution": solution}}
        key = {"solution": solution, "explain_md": _s(raw.get("explain"), 2000), "checks": [{"id": c["id"], "label": c["label"] or c["call"]} for c in checks]}
    pub["sources"] = _sources(raw, valid_sources or set())
    if kind != "explain":
        key["hints"] = _hints(raw)
    return {"public": pub, "key": key}


def build_capstone(raw: Any, concept_ids: list[str], *, valid_sources: set[int] | None = None) -> dict[str, Any]:
    """A capstone's stored payload: one applied task and a rubric whose every
    point is tied to one of ``concept_ids`` (the model gives its number, from
    1). Raises :class:`StepInvalid`."""
    if not isinstance(raw, dict):
        raise StepInvalid("not an object")
    rubric: list[str] = []
    owners: list[str] = []
    for p in _list(raw.get("rubric"), "rubric", 3, 8):
        if not isinstance(p, dict):
            raise StepInvalid("each rubric point is an object with point and concept")
        n = p.get("concept")
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= len(concept_ids):
            raise StepInvalid("each rubric point names one of the numbered ideas")
        rubric.append(_need(p.get("point"), "rubric point", 300))
        owners.append(concept_ids[n - 1])
    if len(set(owners)) < min(2, len(concept_ids)):
        raise StepInvalid("the rubric must draw on at least two of the ideas")
    return {
        "public": {"task_md": _need(raw.get("task"), "task", 3000), "sources": _sources(raw, valid_sources or set())},
        "key": {"rubric": rubric, "rubric_concepts": owners, "model_answer_md": _need(raw.get("model_answer"), "model answer", 3500), "hints": []},
    }


# ------------------------------------------------------------------ grading

LOCAL = ("mcq", "predict", "order_steps", "match_pairs", "spot_error", "worked_example", "explore", "write_code")
WRITTEN = ("explain_back", "scenario", "teach_student")


def _lcs(a: list[str], b: list[str]) -> int:
    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            dp[i + 1][j + 1] = dp[i][j] + 1 if x == y else max(dp[i][j + 1], dp[i + 1][j])
    return dp[-1][-1]


def _band(fraction: float) -> str:
    return "correct" if fraction >= 0.999 else "partial" if fraction >= 0.5 else "wrong"


def check_answer(kind: str, payload: dict[str, Any], answer: Any) -> dict[str, Any]:
    """The learner's answer, checked for shape and tidied. Raises :class:`AnswerInvalid`."""
    if not isinstance(answer, dict):
        raise AnswerInvalid("The answer isn't in the right shape.")
    pub = payload["public"]
    if kind == "explain":
        return {}
    if answer.get("dont_know") is True and kind in LOCAL + ("explain_back", "scenario", "capstone"):
        return {"dont_know": True}
    if kind in ("mcq", "predict"):
        if answer.get("option_id") not in {o["id"] for o in pub["options"]}:
            raise AnswerInvalid("Pick one of the options.")
        return {"option_id": answer["option_id"]}
    if kind == "order_steps":
        ids = [i["id"] for i in pub["items"]]
        order = answer.get("order")
        if not isinstance(order, list) or sorted(map(str, order)) != sorted(ids):
            raise AnswerInvalid("Put every step in order.")
        return {"order": [str(x) for x in order]}
    if kind == "match_pairs":
        pairs = answer.get("pairs")
        lefts, rights = {x["id"] for x in pub["left"]}, {x["id"] for x in pub["right"]}
        if not isinstance(pairs, dict) or set(pairs) != lefts or not set(pairs.values()) <= rights or len(set(pairs.values())) != len(pairs):
            raise AnswerInvalid("Match every item once.")
        return {"pairs": {str(k): str(v) for k, v in pairs.items()}}
    if kind == "spot_error":
        if answer.get("line_id") not in {x["id"] for x in pub["lines"]}:
            raise AnswerInvalid("Pick the line with the mistake.")
        return {"line_id": answer["line_id"]}
    if kind == "worked_example":
        blanks = answer.get("blanks")
        want = {s["id"]: {o["id"] for o in s["options"]} for s in pub["steps"] if s["blank"]}
        if not isinstance(blanks, dict) or set(blanks) != set(want) or any(blanks[k] not in want[k] for k in want):
            raise AnswerInvalid("Fill in every step.")
        return {"blanks": {str(k): str(v) for k, v in blanks.items()}}
    if kind == "explore":
        try:
            return figures.check_answer(payload["key"]["figure"], answer)
        except figures.AnswerBad as e:
            raise AnswerInvalid(str(e)) from e
    if kind == "write_code":
        code = answer.get("code")
        if not isinstance(code, str) or not code.strip() or len(code) > 8000:
            raise AnswerInvalid("Write some code first.")
        ids = [c["id"] for c in pub["run"]["checks"]]
        results = answer.get("results")
        if not isinstance(results, dict) or set(results) != set(ids) or not all(isinstance(v, bool) for v in results.values()):
            raise AnswerInvalid("Run your code before you hand it in.")
        return {
            "code": code, "results": {k: results[k] for k in ids}, "output": _s(answer.get("output"), 2000),
            "error": _s(answer.get("error"), 500), "faulty": answer.get("faulty") is True,
        }
    if kind in ("explain_back", "scenario", "capstone"):
        text = _s(answer.get("text"), 8000 if kind == "capstone" else 4000)
        if len(text) < 2:
            raise AnswerInvalid("Write an answer first.")
        return {"text": text}
    if kind == "teach_student":
        return {}
    raise AnswerInvalid("Unknown step.")


def grade_local(kind: str, payload: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    """The grade for a step with a right answer: ``{outcome, feedback_md,
    misconception, detail}``. Nothing here asks the model."""
    key = payload["key"]
    if answer.get("dont_know"):
        return {"outcome": "wrong", "feedback_md": key.get("explain_md", ""), "misconception": None, "detail": {"dont_know": True}}
    if kind in ("mcq", "predict"):
        picked = answer["option_id"]
        right = picked == key["correct_id"]
        note = key["notes"].get(picked, "")
        feedback = "\n\n".join(x for x in (note, key.get("explain_md", "")) if x)
        return {
            "outcome": "correct" if right else "wrong",
            "feedback_md": feedback,
            "misconception": None if right else key["misconceptions"].get(picked),
            "detail": {"correct_id": key["correct_id"]},
        }
    if kind == "order_steps":
        frac = _lcs(answer["order"], key["order"]) / len(key["order"])
        outcome = "correct" if answer["order"] == key["order"] else ("partial" if frac >= 0.6 else "wrong")
        return {"outcome": outcome, "feedback_md": key.get("explain_md", ""), "misconception": None, "detail": {"order": key["order"]}}
    if kind == "match_pairs":
        right_n = sum(1 for k, v in key["pairs"].items() if answer["pairs"].get(k) == v)
        return {
            "outcome": _band(right_n / len(key["pairs"])),
            "feedback_md": key.get("explain_md", ""),
            "misconception": None,
            "detail": {"pairs": key["pairs"], "right": right_n},
        }
    if kind == "spot_error":
        right = answer["line_id"] == key["error_id"]
        return {
            "outcome": "correct" if right else "wrong",
            "feedback_md": key["explain_md"],
            "misconception": None if right else (key.get("misconception") or None),
            "detail": {"error_id": key["error_id"], "correction": key.get("correction", "")},
        }
    if kind == "explore":
        outcome, miss = figures.grade(key["figure"], key["goal"], answer)
        close = "Close, but not quite on it.\n\n" if outcome == "partial" else ""
        return {"outcome": outcome, "feedback_md": close + key["explain_md"], "misconception": None, "detail": {"miss": miss, "solution": key["solution"]}}
    if kind == "write_code":
        labels = {c["id"]: c["label"] for c in key["checks"]}
        failed = [k for k, ok in answer["results"].items() if not ok]
        lines = (["These checks didn't pass:"] + [f"- {labels[k]}" for k in failed]) if failed else []
        if answer.get("error"):
            lines = [f"Your code stopped with an error: `{answer['error'][:300]}`", ""] + lines
        if key.get("explain_md"):
            lines += ["", key["explain_md"]]
        return {
            "outcome": _band(1 - len(failed) / len(labels)), "feedback_md": "\n".join(lines).strip(), "misconception": None,
            "detail": {"failed": failed, "passed": len(labels) - len(failed), "checks": len(labels)},
        }
    if kind == "worked_example":
        right_ids = [k for k, v in key["blanks"].items() if answer["blanks"].get(k) == v]
        notes = [key["notes"][k] for k in key["blanks"] if k not in right_ids and key["notes"].get(k)]
        return {
            "outcome": _band(len(right_ids) / len(key["blanks"])),
            "feedback_md": "\n\n".join(notes),
            "misconception": None,
            "detail": {"blanks": key["blanks"]},
        }
    raise ValueError(kind)


def clean_written_grade(raw: Any, rubric: list[str]) -> dict[str, Any]:
    """The model's grade of a written answer, checked. Raises :class:`StepInvalid`."""
    if not isinstance(raw, dict) or raw.get("outcome") not in rules.OUTCOME_SCORE:
        raise StepInvalid("grade: outcome")
    met = [i for i in raw.get("met") if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(rubric)] if isinstance(raw.get("met"), list) else []
    misc = raw.get("misconception")
    label = _s(misc.get("label") if isinstance(misc, dict) else misc, 200)
    return {
        "outcome": raw["outcome"],
        "feedback_md": _need(raw.get("feedback"), "feedback", 2500),
        "misconception": label or None,
        "detail": {
            "met": sorted(set(met)),
            "misconception_detail": _s(misc.get("detail"), 600) if isinstance(misc, dict) else "",
        },
    }


def public_view(payload: dict[str, Any]) -> dict[str, Any]:
    return payload["public"]


def reveal_view(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """What is shown once the step is answered (the key, without the hints)."""
    if kind == "explore":
        # The answer, why, and the figure whole (a parts figure's notes come back).
        key = payload["key"]
        return {"solution": key["solution"], "goal": key["goal"], "figure": key["figure"], "explain_md": key["explain_md"]}
    return {k: v for k, v in payload["key"].items() if k != "hints"}
