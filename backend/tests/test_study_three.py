"""Study, phase 3: figures the learner can work, code they can run, and
courses given to family.

* The formula evaluator: a table of cases shared with the browser's copy,
  and hostile input (nothing but arithmetic ever runs).
* Figures: every field of a spec is checked; a goal must be reachable and
  must not start solved; the answer is graded in code.
* The engine gives a figure or code only to a concept the plan marked for it.
* A code task whose own answer fails its checks counts for nothing.
* Sharing: a copy carries the course, never the giver's progress; nobody
  reaches anyone else's subject through it.
"""
from __future__ import annotations

import copy
import json
import pathlib

import pytest
from sqlalchemy import select

from tests import study_kit as kit
from tests.test_study_api import API, H, client, lesson, mk_user, nxt, ready  # noqa: F401 — client is a fixture

CASES = json.loads((pathlib.Path(__file__).parent / "study_expr_cases.json").read_text(encoding="utf-8"))


@pytest.fixture
def model(monkeypatch):
    return kit.install(monkeypatch)


# ---------------------------------------------------------------- evaluator


@pytest.mark.parametrize("case", CASES["values"], ids=lambda c: c["expr"])
def test_formula_values(case):
    from app.study import expr

    got = expr.value(case["expr"], case["env"])
    if case["value"] is None:
        assert got is None
    else:
        assert got == pytest.approx(case["value"], abs=1e-9)


@pytest.mark.parametrize("src", CASES["bad"], ids=repr)
def test_formula_refused(src):
    from app.study import expr

    with pytest.raises(expr.ExprError):
        expr.parse(src)


def test_the_browser_has_the_same_cases():
    theirs = pathlib.Path("/frontend/src/study/figures/expr.cases.json")
    if not theirs.exists():
        theirs = pathlib.Path(__file__).parents[2] / "frontend" / "src" / "study" / "figures" / "expr.cases.json"
    if not theirs.exists():
        pytest.skip("the frontend isn't here")
    assert json.loads(theirs.read_text(encoding="utf-8")) == CASES


def test_formula_hostile_input_is_only_ever_arithmetic():
    from app.study import expr

    for src in (
        "(" * 5000, "1" + "+1" * 5000, "-" * 5000 + "1", "2^" * 300 + "2", "sin(" * 100 + "1" + ")" * 100,
        "9" * 5000, "x" * 5000, None, 5, ["x"], {"a": 1}, b"1+1",
    ):
        with pytest.raises(expr.ExprError):
            expr.parse(src)
    # Names are only ever looked up in what the caller gave, the constants and the fixed functions.
    tree = expr.parse("os + system + exit")
    assert expr.names(tree) == {"os", "system", "exit"}
    with pytest.raises(expr.ExprError):
        expr.evaluate(tree, {})
    # A value that isn't a plain finite number is "no value", never an error that escapes.
    for env in ({"x": float("inf")}, {"x": float("nan")}, {"x": 1e300}, {"x": 1j}, {"x": True}, {"x": "1"}):
        assert expr.value("x + 1", env) is None
    assert expr.value("9 ^ 9 ^ 9", {}) is None
    assert expr.value("exp(exp(exp(9)))", {}) is None


# ------------------------------------------------------------------ figures


@pytest.mark.parametrize("tool", ["plot", "scale", "parts", "table"])
def test_a_good_figure_is_kept_and_tidied(tool):
    from app.study import figures

    fig = figures.clean(kit.FIGURES[tool], want=tool)
    assert fig["type"] == tool
    if tool == "plot":
        assert fig["y"]["min"] < 0 < fig["y"]["max"]  # worked out from the formula over every slider corner
        assert [p["name"] for p in fig["params"]] == ["a", "b"]
    if tool == "parts":
        assert [p["id"] for p in fig["parts"]] == ["p1", "p2", "p3", "p4"]
    with pytest.raises(figures.FigureInvalid):
        figures.clean(kit.FIGURES[tool], want="plot" if tool != "plot" else "table")


def _bad(tool, **change):
    raw = copy.deepcopy(kit.FIGURES[tool])
    for path, v in change.items():
        node, keys = raw, path.split("__")
        for k in keys[:-1]:
            node = node[int(k)] if k.isdigit() else node[k]
        node[int(keys[-1]) if keys[-1].isdigit() else keys[-1]] = v
    return raw


@pytest.mark.parametrize("raw", [
    {"type": "svg", "body": "<script>alert(1)</script>"},
    {"type": "html"},
    "<svg onload=alert(1)>",
    None,
    _bad("plot", expr="a*sin(x) + c"),  # c isn't a slider
    _bad("plot", expr="a + b"),  # doesn't use x
    _bad("plot", expr="__import__('os').system('id')"),
    _bad("plot", expr="sqrt(-1 - x*x)"),  # no value anywhere
    _bad("plot", params__0__name="x"),
    _bad("plot", params__0__name="sin"),
    _bad("plot", params__0__name="pi"),
    _bad("plot", params__0__name="A"),
    _bad("plot", params__1__name="a"),  # the same name twice
    _bad("plot", params__0__max=-1),
    _bad("plot", params__0__step=0),
    _bad("plot", params__0__step=0.001),  # thousands of positions
    _bad("plot", params__0__min="0"),
    _bad("plot", params__0__max=float("inf")),
    _bad("plot", x={"min": 5, "max": 5}),
    _bad("scale", max=0),
    _bad("scale", readout={"label": "x", "expr": "w + 1"}),
    _bad("parts", parts=[{"label": "one"}, {"label": "two"}]),
    _bad("parts", parts=[{"label": "same"}, {"label": "Same"}, {"label": "other"}]),
    _bad("parts", parts=[{"label": ""}, {"label": "a"}, {"label": "b"}]),
    _bad("table", inputs=[]),
    _bad("table", outputs=[]),
    _bad("table", outputs=[{"label": "out", "expr": "1 / (r - 2)"}]),  # no value where it starts
    _bad("table", outputs=[{"label": "out", "expr": "q * 2"}]),
], ids=lambda r: json.dumps(r, default=str)[:60])
def test_a_bad_figure_is_refused(raw):
    from app.study import figures

    with pytest.raises(figures.FigureInvalid):
        figures.clean(raw)
    assert figures.clean_or_none(raw) is None


def test_a_figure_carries_text_only_as_text():
    """Labels are plain strings, cut to length; nothing in a spec is markup the app would run."""
    from app.study import figures

    fig = figures.clean(_bad("parts", title="<img src=x onerror=alert(1)>" * 20, parts__0__label="<b>" * 100))
    assert len(fig["title"]) <= 120 and len(fig["parts"][0]["label"]) <= 40
    assert set(fig) == {"type", "title", "layout", "parts"}
    assert all(set(p) == {"id", "label", "note"} for p in fig["parts"])


def test_goals_are_proved_reachable_and_not_already_met():
    from app.study import figures

    plot = figures.clean(kit.FIGURES["plot"])
    goal, sol = figures.clean_goal(plot, kit.GOALS["plot"])
    assert sol["values"]["b"] == 3 and figures.grade(plot, goal, sol)[0] == "correct"
    with pytest.raises(figures.FigureInvalid, match="reach"):
        figures.clean_goal(plot, {"points": [{"x": 0, "y": 2.5}], "tolerance": 0.01})  # b only moves in whole steps
    with pytest.raises(figures.FigureInvalid, match="already"):
        figures.clean_goal(plot, {"points": [{"x": 0, "y": 0}]})  # b starts at 0
    with pytest.raises(figures.FigureInvalid, match="outside"):
        figures.clean_goal(plot, {"points": [{"x": 99, "y": 0}]})
    with pytest.raises(figures.FigureInvalid):
        figures.clean_goal(plot, {"points": []})
    no_sliders = figures.clean({**kit.FIGURES["plot"], "expr": "sin(x)", "params": []})
    with pytest.raises(figures.FigureInvalid, match="slider"):
        figures.clean_goal(no_sliders, {"points": [{"x": 0, "y": 0}]})

    table = figures.clean(kit.FIGURES["table"])
    goal, sol = figures.clean_goal(table, kit.GOALS["table"])
    assert sol == {"values": {"r": 8.0}}
    with pytest.raises(figures.FigureInvalid, match="reach"):
        figures.clean_goal(table, {"output": 0, "target": 99})
    with pytest.raises(figures.FigureInvalid):
        figures.clean_goal(table, {"output": 3, "target": 7})

    scale = figures.clean(kit.FIGURES["scale"])
    assert scale["value"] == 6
    goal, sol = figures.clean_goal(scale, kit.GOALS["scale"])
    assert scale["value"] in (0, 12) and sol == {"value": 6.0}  # it started on the answer: moved to an end
    with pytest.raises(figures.FigureInvalid, match="off the scale"):
        figures.clean_goal(scale, {"target": 40})

    parts = figures.clean(kit.FIGURES["parts"])
    assert figures.clean_goal(parts, {"part": 1})[0] == {"part_id": "p2"}
    for bad in ({"part": 9}, {"part": "p2"}, {"part": True}, {}, None):
        with pytest.raises(figures.FigureInvalid):
            figures.clean_goal(parts, bad)


def test_too_many_slider_positions_to_prove_is_refused():
    from app.study import figures

    raw = {"type": "table", "inputs": [{"name": n, "min": 0, "max": 100, "step": 1, "value": 0} for n in ("a", "b", "c")],
           "outputs": [{"label": "sum", "expr": "a + b + c"}]}
    with pytest.raises(figures.FigureInvalid, match="too many"):
        figures.clean_goal(figures.clean(raw), {"output": 0, "target": 150})


@pytest.mark.parametrize("tool", ["plot", "scale", "parts", "table"])
def test_an_explore_step_keeps_its_answer_back_and_is_graded_in_code(tool):
    from app.study import steps

    payload = steps.build("explore", kit.raw_explore(tool), tool=tool)
    pub, key = payload["public"], payload["key"]
    sent = json.dumps(pub)
    assert "solution" not in pub and "goal" not in pub and "Because of the pull" not in sent
    if tool == "parts":
        assert all(p["note"] == "" for p in pub["figure"]["parts"]) and "does the pulling" not in sent
        assert steps.reveal_view("explore", payload)["figure"]["parts"][0]["note"] == "does the pulling"
    if tool == "plot":
        assert pub["targets"] == [{"x": 0.0, "y": 3.0}]  # the dot the curve must reach is the task itself

    class S:
        kind = "explore"

    S.payload = payload
    good = steps.check_answer("explore", payload, kit.answer_for(S, "good"))
    bad = steps.check_answer("explore", payload, kit.answer_for(S, "bad"))
    assert steps.grade_local("explore", payload, good)["outcome"] == "correct"
    g = steps.grade_local("explore", payload, bad)
    assert g["outcome"] == "wrong" and g["detail"]["solution"] == key["solution"]
    for junk in ({}, {"values": {}}, {"values": {"a": 1, "b": 1, "zz": 3}}, {"values": {"a": "1", "b": 0}}, {"value": 9999}, {"value": None}, {"part_id": "p99"}, {"values": {"a": 1e9, "b": 0}}):
        with pytest.raises(steps.AnswerInvalid):
            steps.check_answer("explore", payload, junk)
    assert steps.check_answer("explore", payload, {"dont_know": True}) == {"dont_know": True}


def test_close_is_partial():
    from app.study import steps

    payload = steps.build("explore", kit.raw_explore("scale"), tool="scale")
    tol = payload["key"]["goal"]["tolerance"]
    assert steps.grade_local("explore", payload, {"value": 6 + tol})["outcome"] == "correct"
    assert steps.grade_local("explore", payload, {"value": 6 + 2 * tol})["outcome"] == "partial"
    assert steps.grade_local("explore", payload, {"value": 6 + 4 * tol})["outcome"] == "wrong"


def test_a_figure_step_needs_a_concept_that_suits_it():
    from app.study import steps

    with pytest.raises(steps.StepInvalid):
        steps.build("explore", kit.raw_explore("plot"))  # no tool on the concept
    with pytest.raises(steps.StepInvalid):
        steps.build("explore", kit.raw_explore("plot"), tool="table")
    with pytest.raises(steps.StepInvalid):
        steps.build("explore", {**kit.raw_explore("plot"), "goal": {"points": [{"x": 0, "y": 0}]}}, tool="plot")
    # An explanation: a figure only where the concept suits one, and a bad one is dropped, not an error.
    raw = {**kit.raw_step("explain"), "figure": kit.FIGURES["table"]}
    assert "figure" not in steps.build("explain", raw)["public"]
    with_fig = steps.build("explain", raw, tool="table")["public"]
    assert with_fig["figure"]["type"] == "table" and with_fig["diagram"] is None
    dropped = steps.build("explain", {**raw, "figure": {"type": "table", "inputs": []}}, tool="table")["public"]
    assert "figure" not in dropped and dropped["diagram"] is not None


# --------------------------------------------------------------------- code


def test_a_code_step_is_checked_and_graded_by_count():
    from app.study import steps

    raw = kit.raw_step("write_code")
    with pytest.raises(steps.StepInvalid):
        steps.build("write_code", raw)  # not a programming concept
    with pytest.raises(steps.StepInvalid):
        steps.build("write_code", raw, tool="code", lang="python")  # nothing here can run it
    payload = steps.build("write_code", raw, tool="code", lang="javascript")
    pub = payload["public"]
    assert pub["lang"] == "javascript" and [c["id"] for c in pub["run"]["checks"]] == ["k1", "k2", "k3"]
    for bad in (
        {**raw, "checks": raw["checks"][:1]},
        {**raw, "checks": [{"call": "double(2)"}, {"call": "double(3)", "expect": 6}]},
        {**raw, "checks": [{"call": "double(2)", "expect": 4}, {"call": "double(2)", "expect": 4}]},
        {**raw, "checks": [{"call": "x", "expect": float("nan")}, {"call": "y", "expect": 1}]},
        {**raw, "starter": raw["solution"]},
        {**raw, "solution": ""},
    ):
        with pytest.raises(steps.StepInvalid):
            steps.build("write_code", bad, tool="code", lang="javascript")

    def ans(**results):
        return steps.check_answer("write_code", payload, {"code": "function double(n) { return n * 2 }", "results": results, "output": "x" * 9000, "error": ""})

    for junk in ({}, {"code": "x"}, {"code": "x", "results": {"k1": True}}, {"code": "x", "results": {"k1": 1, "k2": 1, "k3": 1}}, {"code": "", "results": {"k1": True, "k2": True, "k3": True}}):
        with pytest.raises(steps.AnswerInvalid):
            steps.check_answer("write_code", payload, junk)
    a = ans(k1=True, k2=True, k3=True)
    assert len(a["output"]) == 2000 and a["faulty"] is False
    assert steps.grade_local("write_code", payload, a)["outcome"] == "correct"
    g = steps.grade_local("write_code", payload, ans(k1=True, k2=True, k3=False))
    assert g["outcome"] == "partial" and "works below zero" in g["feedback_md"] and g["detail"] == {"failed": ["k3"], "passed": 2, "checks": 3}
    assert steps.grade_local("write_code", payload, ans(k1=False, k2=False, k3=True))["outcome"] == "wrong"


# -------------------------------------------------------------------- rules


def test_a_figure_or_code_only_where_the_concept_suits_it():
    from app.study import rules as r

    plain = r.ConceptState(id="a", position=1, nature="principle")
    seen = set()
    hist = []
    for _ in range(12):
        k, _angle = r.choose_kind(plain, hist)
        seen.add(k)
        hist.append((k, None if k == "explain" else "correct"))
    assert not seen & {"explore", "write_code"}

    fig = r.ConceptState(id="b", position=2, nature="principle", tool="plot")
    assert r.choose_kind(fig, [("explain", None)])[0] == "explore"  # the figure is its first check
    assert r.choose_kind(fig, [("explain", None), ("explore", "wrong"), ("explain", None)])[0] != "explore"  # then another way

    code = r.ConceptState(id="c", position=3, nature="skill", tool="code")
    assert r.choose_kind(code, [("explain", None), ("mcq", "correct")])[0] == "write_code"
    assert r.test_out_kind(code) == "write_code" and r.test_out_kind(plain) == "scenario"
    # A faulty code task (no outcome) is followed by other work of the learner's own, not the explanation again.
    k, _ = r.choose_kind(code, [("explain", None), ("mcq", "correct"), ("write_code", None)])
    assert k in r.PRODUCTION and k != "write_code"
    assert r.KIND_WEIGHT["explore"] > r.KIND_WEIGHT["mcq"] and "explore" in r.RECOGNITION and "write_code" in r.PRODUCTION


# ------------------------------------------------------------------- engine


async def test_the_plan_marks_concepts_and_the_course_uses_it(db, user, model):
    from app.study import service

    model.tools = {1: "plot", 2: "table", 3: "parts", 4: "scale", 5: "code", 6: "hologram"}
    s = await kit.make_subject(db, user)
    rows = await service.concepts_of(db, s.id)
    # "code" without a programming language the app can run is dropped; so is a tool that doesn't exist.
    assert [c.tool for c in rows] == ["plot", "table", "parts", "scale", "", ""] and s.code_lang is None
    out = await kit.run_course(db, user, s, kit.strong)
    assert out["complete"]
    explored = {title for title, kind, _role, _how in out["kinds"] if kind == "explore"}
    assert explored == {"Concept 1", "Concept 2", "Concept 3", "Concept 4"}
    assert not any(kind == "write_code" for _t, kind, _r, _h in out["kinds"])
    # The explanation for a concept with a figure asked for one.
    explain = next(c for c in model.calls if c["task"] == "step:explain" and "Concept being taught now: Concept 1" in c["prompt"])
    assert '"figure"' in explain["prompt"] and '"type": "plot"' in explain["prompt"]
    plain = next(c for c in model.calls if c["task"] == "step:explain" and "Concept being taught now: Concept 5" in c["prompt"])
    assert '"figure"' not in plain["prompt"]


async def test_a_programming_subject_gets_code_to_write(db, user, model):
    from app.study import service

    model.tools, model.language, model.nature = {2: "code", 3: "code"}, "JavaScript", "skill"
    s = await kit.make_subject(db, user)
    assert s.code_lang == "javascript"
    assert [c.tool for c in await service.concepts_of(db, s.id)] == ["", "code", "code", "", "", ""]
    out = await kit.run_course(db, user, s, kit.strong)
    assert out["complete"]
    coded = {title for title, kind, _role, _how in out["kinds"] if kind == "write_code"}
    assert coded == {"Concept 2", "Concept 3"}

    model.language = "python"  # a language nothing here can run: no code steps at all
    s2 = await kit.make_subject(db, user)
    assert s2.code_lang is None and not any(c.tool for c in await service.concepts_of(db, s2.id))


async def test_a_bad_figure_from_the_model_is_asked_for_again_then_fails_cleanly(db, user, model):
    from app.study import service
    from app.study.models import StudyStep

    model.tools = {1: "plot"}
    s = await kit.make_subject(db, user)
    se = await service.start_lesson(db, s)
    st = await service.next_step(db, user, se, s)
    assert st.kind == "explain"
    await kit.answer(db, user, st, "good")
    model.override["explore"] = {**kit.raw_explore("plot"), "figure": {**kit.FIGURES["plot"], "expr": "a * fetch(x)"}}
    with pytest.raises(service.StudyError) as e:
        await service.next_step(db, user, se, s)
    assert e.value.code == "model_failed"
    assert model.tasks().count("step:explore") == 3  # told what was wrong, twice more
    assert "can't be used" in model.calls[-1]["messages"][-1]["content"]
    assert (await db.execute(select(StudyStep).where(StudyStep.kind == "explore"))).first() is None


async def test_a_faulty_code_task_counts_for_nothing(db, user, model):
    from app.study import service
    from app.study.models import StudyConcept

    model.tools, model.language, model.nature = {1: "code"}, "javascript", "skill"
    s = await kit.make_subject(db, user)
    se = await service.start_lesson(db, s)
    for _ in range(8):
        st = await service.next_step(db, user, se, s)
        if st.kind == "write_code":
            break
        await kit.answer(db, user, st, "good", 3)
    assert st.kind == "write_code"
    c = await db.get(StudyConcept, st.concept_id)
    before = (c.mastery, c.evidence_count)
    ids = [k["id"] for k in st.payload["public"]["run"]["checks"]]
    res = await service.answer_step(db, user, st.id, {"code": "function double(n) { return n * 2 }", "results": {i: False for i in ids}, "faulty": True}, 3)
    await db.refresh(c)
    assert res["step"].grade is None and res["step"].status == "answered" and res["step"].evidence == []
    assert (c.mastery, c.evidence_count) == before and not any(ch["type"] == "mastery" for ch in res["changes"])
    nxt_step = await service.next_step(db, user, se, s)
    assert nxt_step.kind not in ("write_code", "explain")


# ---------------------------------------------------------------------- API


async def test_the_browser_gets_the_figure_and_never_the_answer(client, db, model):  # noqa: F811
    model.tools = {1: "parts"}
    u = await mk_user(db, "ann")
    sid = await ready(client, db, u)
    full = (await client.get(f"{API}/subjects/{sid}", headers=H(u))).json()
    assert full["units"][0]["concepts"][0]["tool"] == "parts" and full["code_lang"] is None and full["shared_from"] is None
    se = await lesson(client, u, sid)
    st = (await nxt(client, u, se))["step"]
    assert st["kind"] == "explain" and st["public"]["figure"]["type"] == "parts"
    assert st["public"]["figure"]["parts"][0]["note"] == "does the pulling"  # an explanation shows the notes
    await client.post(f"{API}/steps/{st['id']}/answer", json={"answer": {}}, headers=H(u))
    st = (await nxt(client, u, se))["step"]
    assert st["kind"] == "explore" and st["reveal"] is None and st["void"] is False
    assert all(p["note"] == "" for p in st["public"]["figure"]["parts"])
    assert "p2" not in json.dumps({k: v for k, v in st["public"].items() if k != "figure"})
    r = await client.post(f"{API}/steps/{st['id']}/answer", json={"answer": {"part_id": "p2"}, "confidence": 3}, headers=H(u))
    assert r.status_code == 200, r.text
    done = r.json()["step"]
    assert done["grade"]["outcome"] == "correct" and done["reveal"]["solution"] == {"part_id": "p2"}
    assert done["reveal"]["figure"]["parts"][1]["note"] == "pulled most"
    r = await client.post(f"{API}/steps/{st['id']}/answer", json={"answer": {"part_id": "p1"}}, headers=H(u))
    assert r.status_code == 409
