"""Figures the learner can play with: a plot with sliders, a scale with a
point to drag, a picture made of labelled parts, and a "what happens if"
table. Each is DATA the app draws itself — the model writes a spec, this
module checks every field of it, and a spec that fails is refused (never
drawn half-right, never markup or script).

A figure can sit inside an explanation (to play with) or be an *explore*
step with a goal ("set the sliders so that…", "tap the part that…"). The
goal is checked here, in code: the model never grades it. Before a goal is
accepted this module proves it can be reached from the controls given, and
that the starting position isn't already the answer.

Formulas go through :mod:`app.study.expr` (no ``eval``).
"""
from __future__ import annotations

import itertools
import math
import re
from typing import Any

from app.study import expr
from app.study.expr import ExprError

TYPES = ("plot", "scale", "parts", "table")
LAYOUTS = ("layers", "rings", "row", "grid")
#: Slider positions tried when proving a goal can be reached.
MAX_COMBOS = 30000
SAMPLES = 41

_NAME = re.compile(r"^[a-z][a-z0-9_]{0,11}$")


class FigureInvalid(ValueError):
    """The figure (or its goal) can't be used."""


def _s(v: Any, n: int) -> str:
    return str(v if v is not None else "").strip()[:n]


def _num(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) > 1e9:
        raise FigureInvalid(f"{what}: not a number")
    return float(v)


def _tidy(v: float) -> float:
    """A float without the binary tail (0.30000000000000004 → 0.3)."""
    return float(f"{v:.10g}")


def _control(raw: Any, taken: set[str], what: str) -> dict[str, Any]:
    """One slider: a named number with a range, a step and where it starts."""
    if not isinstance(raw, dict):
        raise FigureInvalid(f"{what}: not an object")
    name = _s(raw.get("name"), 16)
    if not _NAME.match(name) or name in expr.RESERVED or name in taken:
        raise FigureInvalid(f"{what}: the name must be a short lower-case word of its own (not x, pi, e or a function)")
    lo, hi = _num(raw.get("min"), f"{name} min"), _num(raw.get("max"), f"{name} max")
    if not hi > lo:
        raise FigureInvalid(f"{name}: max must be above min")
    step = _num(raw.get("step"), f"{name} step") if raw.get("step") is not None else (hi - lo) / 20
    if step <= 0:
        raise FigureInvalid(f"{name}: step must be above 0")
    count = (hi - lo) / step
    if count < 2 - 1e-9 or count > 200 + 1e-9:
        raise FigureInvalid(f"{name}: between 2 and 200 steps from min to max")
    start = _num(raw.get("value"), f"{name} value") if raw.get("value") is not None else lo
    start = min(hi, max(lo, lo + round((start - lo) / step) * step))
    taken.add(name)
    return {
        "name": name, "label": _s(raw.get("label"), 40) or name, "unit": _s(raw.get("unit"), 12),
        "min": _tidy(lo), "max": _tidy(hi), "step": _tidy(step), "value": _tidy(start),
    }


def positions(c: dict[str, Any]) -> list[float]:
    """Every value a slider can take."""
    n = int(round((c["max"] - c["min"]) / c["step"]))
    return [_tidy(min(c["max"], c["min"] + i * c["step"])) for i in range(n + 1)]


def _formula(src: Any, allowed: set[str], what: str) -> str:
    text = _s(src, expr.MAX_LEN + 1)
    try:
        tree = expr.parse(text)
    except ExprError as e:
        raise FigureInvalid(f"{what}: {e}") from e
    extra = expr.names(tree) - allowed
    if extra:
        raise FigureInvalid(f"{what}: uses {', '.join(sorted(extra))}, which isn't one of the controls")
    return text


def _starts(controls: list[dict[str, Any]]) -> dict[str, float]:
    return {c["name"]: c["value"] for c in controls}


def clean(raw: Any, *, want: str | None = None) -> dict[str, Any]:
    """A figure the app can draw. Raises :class:`FigureInvalid`."""
    if not isinstance(raw, dict) or raw.get("type") not in TYPES:
        raise FigureInvalid("figure: unknown type")
    t = raw["type"]
    if want and t != want:
        raise FigureInvalid(f"figure: this step needs a {want} figure")
    out: dict[str, Any] = {"type": t, "title": _s(raw.get("title"), 120)}
    if t == "plot":
        taken = {"x"}
        params = [_control(p, taken, "slider") for p in (raw.get("params") if isinstance(raw.get("params"), list) else [])][:3]
        xr = raw.get("x") if isinstance(raw.get("x"), dict) else {}
        x_lo, x_hi = _num(xr.get("min", 0), "x min"), _num(xr.get("max", 10), "x max")
        if not x_hi > x_lo:
            raise FigureInvalid("x: max must be above min")
        text = _formula(raw.get("expr"), {"x"} | {p["name"] for p in params}, "formula")
        tree = expr.parse(text)
        if "x" not in expr.names(tree):
            raise FigureInvalid("formula: a plot's formula must use x")
        xs = [x_lo + (x_hi - x_lo) * i / (SAMPLES - 1) for i in range(SAMPLES)]
        # The y range: every corner of the sliders, so moving one moves the curve inside the frame.
        corners = list(itertools.product(*[(p["min"], p["max"], p["value"]) for p in params])) or [()]
        ys: list[float] = []
        start_ok = 0
        start = tuple(p["value"] for p in params)
        for corner in corners:
            env = {p["name"]: v for p, v in zip(params, corner)}
            for x in xs:
                try:
                    y = expr.evaluate(tree, {**env, "x": x})
                except ExprError:
                    continue
                ys.append(y)
                if corner == start:
                    start_ok += 1
        if start_ok < SAMPLES * 0.6:
            raise FigureInvalid("formula: it has no value over most of the x range")
        ys.sort()
        lo, hi = ys[int(len(ys) * 0.02)], ys[min(len(ys) - 1, int(len(ys) * 0.98))]
        yr = raw.get("y") if isinstance(raw.get("y"), dict) else {}
        if yr.get("min") is not None and yr.get("max") is not None:
            lo, hi = _num(yr["min"], "y min"), _num(yr["max"], "y max")
        if not hi > lo:
            lo, hi = lo - 1, hi + 1
        pad = (hi - lo) * 0.08
        out.update({
            "expr": text, "params": params,
            "x": {"min": _tidy(x_lo), "max": _tidy(x_hi), "label": _s(xr.get("label"), 40) or "x"},
            "y": {"min": _tidy(lo - pad), "max": _tidy(hi + pad), "label": _s(yr.get("label"), 40) or "y"},
        })
    elif t == "scale":
        c = _control({**raw, "name": "v"}, set(), "scale")
        marks = []
        for m in (raw.get("marks") if isinstance(raw.get("marks"), list) else [])[:8]:
            if isinstance(m, dict) and _s(m.get("label"), 40):
                v = _num(m.get("value"), "mark")
                if c["min"] <= v <= c["max"]:
                    marks.append({"value": _tidy(v), "label": _s(m.get("label"), 40)})
        out.update({"min": c["min"], "max": c["max"], "step": c["step"], "value": c["value"], "unit": _s(raw.get("unit"), 12), "marks": marks})
        ro = raw.get("readout")
        if isinstance(ro, dict) and ro.get("expr"):
            out["readout"] = {
                "label": _s(ro.get("label"), 40), "expr": _formula(ro.get("expr"), {"v"}, "readout"),
                "unit": _s(ro.get("unit"), 12), "decimals": _decimals(ro.get("decimals")),
            }
    elif t == "parts":
        layout = raw.get("layout") if raw.get("layout") in LAYOUTS else "row"
        parts = []
        items = raw.get("parts") if isinstance(raw.get("parts"), list) else []
        if not 3 <= len(items) <= 8:
            raise FigureInvalid("parts: between 3 and 8 parts")
        for i, p in enumerate(items):
            label = _s(p.get("label") if isinstance(p, dict) else p, 40)
            if not label:
                raise FigureInvalid("parts: every part needs a label")
            parts.append({"id": f"p{i + 1}", "label": label, "note": _s(p.get("note"), 200) if isinstance(p, dict) else ""})
        if len({p["label"].lower() for p in parts}) != len(parts):
            raise FigureInvalid("parts: two parts have the same label")
        out.update({"layout": layout, "parts": parts})
    else:  # table
        taken: set[str] = set()
        ins = raw.get("inputs") if isinstance(raw.get("inputs"), list) else []
        if not 1 <= len(ins) <= 3:
            raise FigureInvalid("table: 1 to 3 inputs")
        inputs = [_control(c, taken, "input") for c in ins]
        outs = raw.get("outputs") if isinstance(raw.get("outputs"), list) else []
        if not 1 <= len(outs) <= 4:
            raise FigureInvalid("table: 1 to 4 outputs")
        outputs = []
        env = _starts(inputs)
        for o in outs:
            if not isinstance(o, dict) or not _s(o.get("label"), 60):
                raise FigureInvalid("table: every output needs a label and a formula")
            text = _formula(o.get("expr"), taken, f"output {_s(o.get('label'), 30)}")
            if expr.value(text, env) is None:
                raise FigureInvalid(f"output {_s(o.get('label'), 30)}: no value at the starting inputs")
            outputs.append({"label": _s(o.get("label"), 60), "expr": text, "unit": _s(o.get("unit"), 12), "decimals": _decimals(o.get("decimals"))})
        out.update({"inputs": inputs, "outputs": outputs})
    return out


def _decimals(v: Any) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 4 else 2


def clean_or_none(raw: Any, *, want: str | None = None) -> dict[str, Any] | None:
    """For a figure that only illustrates an explanation: a bad one is dropped."""
    try:
        return clean(raw, want=want)
    except FigureInvalid:
        return None


# -------------------------------------------------------------------- goals


def _controls(fig: dict[str, Any]) -> list[dict[str, Any]]:
    return fig["params"] if fig["type"] == "plot" else fig["inputs"]


def _miss(fig: dict[str, Any], goal: dict[str, Any], env: dict[str, float]) -> float | None:
    """How far ``env`` is from the goal, in tolerances (≤ 1 is on target).
    ``None`` when the formula has no value there."""
    if fig["type"] == "plot":
        worst = 0.0
        for p in goal["points"]:
            y = expr.value(fig["expr"], {**env, "x": p["x"]})
            if y is None:
                return None
            worst = max(worst, abs(y - p["y"]) / goal["tolerance"])
        return worst
    y = expr.value(fig["outputs"][goal["output"]]["expr"], env)
    return None if y is None else abs(y - goal["target"]) / goal["tolerance"]


def _best(fig: dict[str, Any], goal: dict[str, Any], near: dict[str, float] | None = None) -> tuple[dict[str, float], float]:
    """A slider position that meets the goal, and how far off it is (≤ 1:
    on target). Of those that meet it, the one that moves the sliders least
    from ``near`` (where they start, or where the learner left them); when
    none does, the one that comes closest."""
    controls = _controls(fig)
    grids = [positions(c) for c in controls]
    if math.prod(len(g) for g in grids) > MAX_COMBOS:
        raise FigureInvalid("goal: too many slider positions to check; use fewer sliders or bigger steps")
    near = near or _starts(controls)
    best: tuple[dict[str, float], float] | None = None
    hit: tuple[dict[str, float], float, float] | None = None
    for combo in itertools.product(*grids):
        env = {c["name"]: v for c, v in zip(controls, combo)}
        m = _miss(fig, goal, env)
        if m is None:
            continue
        if best is None or m < best[1]:
            best = (env, m)
        if m <= 1 + 1e-9:
            moved = sum(abs(env[c["name"]] - near.get(c["name"], c["value"])) / (c["max"] - c["min"]) for c in controls)
            if hit is None or moved < hit[2] - 1e-12:
                hit = (env, m, moved)
    if best is None:
        raise FigureInvalid("goal: the formula has no value anywhere")
    return (hit[0], hit[1]) if hit is not None else best


def answer_near(fig: dict[str, Any], goal: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any] | None:
    """For a slider figure: the right setting closest to where the learner
    left the sliders (what they are shown after a miss). ``None`` for the
    other figures, whose answer is one thing."""
    if fig["type"] not in ("plot", "table") or not isinstance(answer.get("values"), dict):
        return None
    try:
        env, miss = _best(fig, goal, near=answer["values"])
    except FigureInvalid:
        return None
    return {"values": env} if miss <= 1 + 1e-9 else None


def clean_goal(fig: dict[str, Any], raw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """An explore step's goal, proved reachable. Returns ``(goal, solution)``
    — the goal as it is stored in the key, and one answer that meets it.
    May move a scale's starting point off the answer. Raises :class:`FigureInvalid`."""
    if not isinstance(raw, dict):
        raise FigureInvalid("goal: not an object")
    t = fig["type"]
    if t == "parts":
        i = raw.get("part")
        if isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(fig["parts"]):
            raise FigureInvalid("goal: part is the position of the right part (0 = first)")
        return {"part_id": fig["parts"][i]["id"]}, {"part_id": fig["parts"][i]["id"]}
    if t == "scale":
        target = _num(raw.get("target"), "goal target")
        if not fig["min"] <= target <= fig["max"]:
            raise FigureInvalid("goal: the target is off the scale")
        span = fig["max"] - fig["min"]
        tol = _num(raw.get("tolerance"), "tolerance") if raw.get("tolerance") is not None else max(fig["step"], span * 0.02)
        tol = min(span * 0.1, max(fig["step"] * 0.5001, tol))
        if abs(fig["value"] - target) <= tol * 2.5:
            # Start well away from the answer: the far end of the scale.
            fig["value"] = fig["min"] if target - fig["min"] > fig["max"] - target else fig["max"]
        nearest = min(positions({**fig, "name": "v"}), key=lambda v: abs(v - target))
        if abs(nearest - target) > tol:
            raise FigureInvalid("goal: the point can't be put on the target with this step")
        return {"target": _tidy(target), "tolerance": _tidy(tol)}, {"value": nearest}
    if not _controls(fig):
        raise FigureInvalid("goal: a goal needs at least one slider")
    if t == "plot":
        pts = raw.get("points") if isinstance(raw.get("points"), list) else []
        if not 1 <= len(pts) <= 2:
            raise FigureInvalid("goal: one or two points the curve must pass through")
        points = []
        for p in pts:
            if not isinstance(p, dict):
                raise FigureInvalid("goal: each point is {x, y}")
            x, y = _num(p.get("x"), "point x"), _num(p.get("y"), "point y")
            if not (fig["x"]["min"] <= x <= fig["x"]["max"] and fig["y"]["min"] <= y <= fig["y"]["max"]):
                raise FigureInvalid("goal: a point is outside the plot")
            points.append({"x": _tidy(x), "y": _tidy(y)})
        span = fig["y"]["max"] - fig["y"]["min"]
        tol = _num(raw.get("tolerance"), "tolerance") if raw.get("tolerance") is not None else span * 0.03
        goal: dict[str, Any] = {"points": points, "tolerance": _tidy(min(span * 0.08, max(span * 0.01, tol)))}
    else:
        i = raw.get("output", 0)
        if isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(fig["outputs"]):
            raise FigureInvalid("goal: output is the position of the output to hit (0 = first)")
        target = _num(raw.get("target"), "goal target")
        base = max(abs(target), 1e-6)
        tol = _num(raw.get("tolerance"), "tolerance") if raw.get("tolerance") is not None else base * 0.02
        goal = {"output": i, "target": _tidy(target), "tolerance": _tidy(min(base * 0.1, max(base * 0.005, tol)))}
    start = _miss(fig, goal, _starts(_controls(fig)))
    if start is not None and start <= 2.5:
        raise FigureInvalid("goal: the sliders already start at (or next to) the answer; start them somewhere else")
    env, miss = _best(fig, goal)
    if miss > 1:
        raise FigureInvalid("goal: no slider position reaches it; change the target or the slider ranges")
    return goal, {"values": env}


def public(fig: dict[str, Any], *, hide_notes: bool = False) -> dict[str, Any]:
    """The figure as the browser gets it (an explore step on a parts figure
    keeps each part's note back until it is answered)."""
    if fig["type"] == "parts" and hide_notes:
        return {**fig, "parts": [{**p, "note": ""} for p in fig["parts"]]}
    return fig


class AnswerBad(ValueError):
    pass


def check_answer(fig: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    """The learner's answer to an explore step, checked for shape."""
    t = fig["type"]
    if t == "parts":
        if answer.get("part_id") not in {p["id"] for p in fig["parts"]}:
            raise AnswerBad("Tap one of the parts.")
        return {"part_id": answer["part_id"]}
    if t == "scale":
        v = answer.get("value")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not fig["min"] - 1e-9 <= v <= fig["max"] + 1e-9:
            raise AnswerBad("Drag the point onto the scale.")
        return {"value": _tidy(float(v))}
    values = answer.get("values")
    controls = _controls(fig)
    if not isinstance(values, dict) or set(values) != {c["name"] for c in controls}:
        raise AnswerBad("Set every slider.")
    out = {}
    for c in controls:
        v = values[c["name"]]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not c["min"] - 1e-9 <= v <= c["max"] + 1e-9:
            raise AnswerBad("Set every slider.")
        out[c["name"]] = _tidy(float(v))
    return {"values": out}


def grade(fig: dict[str, Any], goal: dict[str, Any], answer: dict[str, Any]) -> tuple[str, float | None]:
    """``(outcome, how far off in tolerances)``: on target is correct, within
    two and a half tolerances is partial (close, not there), else wrong."""
    t = fig["type"]
    if t == "parts":
        return ("correct" if answer["part_id"] == goal["part_id"] else "wrong"), None
    if t == "scale":
        miss: float | None = abs(answer["value"] - goal["target"]) / goal["tolerance"]
    else:
        miss = _miss(fig, goal, answer["values"])
    if miss is None:
        return "wrong", None
    return ("correct" if miss <= 1 + 1e-9 else "partial" if miss <= 2.5 else "wrong"), round(miss, 3)
