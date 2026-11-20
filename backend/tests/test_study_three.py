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


def test_after_a_miss_the_answer_shown_is_the_one_nearest_where_they_left_it():
    from app.study import figures

    raw = {"type": "table", "inputs": [{"name": "m", "min": 1, "max": 5, "step": 0.5, "value": 3}, {"name": "r", "min": 0, "max": 8, "step": 0.5, "value": 2}],
           "outputs": [{"label": "high", "expr": "m + r / 2"}, {"label": "low", "expr": "m - r / 2"}]}
    fig = figures.clean(raw)
    goal, start = figures.clean_goal(fig, {"output": 1, "target": 1, "tolerance": 0.05})
    # Low water 1 m with the least moving from where the sliders start (two ways tie: either is right).
    assert start in ({"values": {"m": 2.0, "r": 2.0}}, {"values": {"m": 3.0, "r": 4.0}})
    assert figures.grade(fig, goal, start)[0] == "correct"
    # They got the range nearly there: the answer shown keeps their mean and finishes the range.
    assert figures.answer_near(fig, goal, {"values": {"m": 3, "r": 3.5}}) == {"values": {"m": 3.0, "r": 4.0}}
    assert figures.answer_near(fig, goal, {"values": {"m": 5, "r": 7.5}}) == {"values": {"m": 5.0, "r": 8.0}}
    assert figures.answer_near(figures.clean(kit.FIGURES["scale"]), {"target": 6, "tolerance": 1}, {"value": 2}) is None


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
    assert g["outcome"] == "wrong" and steps.grade_local("explore", payload, steps.check_answer("explore", payload, g["detail"]["solution"]))["outcome"] == "correct"
    assert key["solution"]
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


# ------------------------------------------------------------------ sharing


@pytest.fixture
def pushes(monkeypatch):
    from app.notifications import dispatch

    sent = []

    async def fake(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake)
    return sent


async def _studied(client, db, u):  # noqa: F811
    """A subject with real history: progress, a wrong idea, a concept added for a gap."""
    import uuid

    from app.study import service
    from app.study.models import StudyConcept, StudySubject

    sid = await ready(client, db, u, goal="For sailing with Dad")
    s = await db.get(StudySubject, uuid.UUID(sid))
    se = await service.start_lesson(db, s)
    for _ in range(14):
        st = await service.next_step(db, u, se, s)
        if st is None:
            se = await service.start_lesson(db, s)
            continue
        c = await db.get(StudyConcept, st.concept_id)
        graded = sum(1 for x in await service._concept_history(db, c.id) if x.grade)
        muddled = c.title == "Concept 2" and c.origin == "planned" and graded < 2
        await kit.answer(db, u, st, "misc" if muddled else "good", 3)
    return sid


async def test_a_shared_course_is_the_map_and_none_of_the_givers_progress(client, db, model, pushes):  # noqa: F811
    import uuid

    from app.study import service
    from app.study.models import StudyConcept, StudyMisconception, StudySource, StudyStep, StudySubject

    ana, ben = await mk_user(db, "ana"), await mk_user(db, "ben")
    sid = await _studied(client, db, ana)
    mine = (await client.get(f"{API}/subjects/{sid}", headers=H(ana))).json()
    mine_concepts = [c for u in mine["units"] for c in u["concepts"]]
    assert any(c["origin"] == "gap" for c in mine_concepts) and mine["misconceptions"] and mine["progress"]["done"] >= 1

    r = await client.post(f"{API}/subjects/{sid}/share", json={"user_ids": [str(ben.id)]}, headers=H(ana))
    assert r.status_code == 200, r.text
    assert r.json() == {"given": [{"user_id": str(ben.id), "name": ben.username}], "skipped": []}

    bens = (await client.get(f"{API}/subjects", headers=H(ben))).json()["subjects"]
    assert len(bens) == 1 and bens[0]["id"] != sid
    copy_ = (await client.get(f"{API}/subjects/{bens[0]['id']}", headers=H(ben))).json()
    assert (copy_["title"], copy_["goal"], copy_["shared_from"], copy_["status"]) == ("Tides", "For sailing with Dad", ana.username, "placement")
    assert copy_["prior"] == "" and copy_["progress"] == {"total": 6, "done": 0, "learning": 0, "percent": 0}
    theirs = [c for u in copy_["units"] for c in u["concepts"]]
    # The plan, without the concept that was added for the giver's own gap.
    assert [c["title"] for c in theirs] == [f"Concept {i}" for i in range(1, 7)]
    assert all(c["origin"] == "planned" and c["mastery"] == 0 and c["state"] == "new" and c["steps_done"] == 0 and c["reviews"] == 0 for c in theirs)
    assert copy_["misconceptions"] == [] and copy_["active_session"] is None and copy_["capstone"] is None
    assert all(u["capstone"] is None for u in copy_["units"])
    # Its own ids all the way down: nothing in the copy points into the giver's subject.
    their_ids = {c["id"] for c in theirs}
    assert not their_ids & {c["id"] for c in mine_concepts}
    assert all(set(c["prereqs"]) <= their_ids for c in theirs) and theirs[1]["prereqs"] == [theirs[0]["id"]]
    blob = json.dumps(copy_)
    assert sid not in blob and str(ana.id) not in blob and kit.MISC not in blob
    cid = uuid.UUID(copy_["id"])
    assert (await db.execute(select(StudyStep).where(StudyStep.subject_id == cid))).first() is None
    assert (await db.execute(select(StudyMisconception).where(StudyMisconception.subject_id == cid))).first() is None
    for src in (await db.execute(select(StudySource).where(StudySource.subject_id == cid))).scalars():
        assert src.file_id is None and src.note_id is None
    # Ben was told, by ana, with a link to HIS copy.
    assert len(pushes) == 1 and pushes[0]["user_id"] == ben.id and pushes[0]["actor_user_id"] == ana.id
    assert pushes[0]["url"] == f"/study/{copy_['id']}" and "Tides" in pushes[0]["title"] and ana.username in pushes[0]["title"]

    # Neither can reach the other's, and nor can an admin.
    admin = await mk_user(db, "root", role="admin")
    assert (await client.get(f"{API}/subjects/{sid}", headers=H(ben))).status_code == 404
    assert (await client.get(f"{API}/subjects/{sid}/report", headers=H(ben))).status_code == 404
    assert (await client.get(f"{API}/subjects/{copy_['id']}", headers=H(ana))).status_code == 404
    assert (await client.get(f"{API}/subjects/{copy_['id']}/report", headers=H(ana))).status_code == 404
    assert (await client.get(f"{API}/subjects/{copy_['id']}", headers=H(admin))).status_code == 404
    assert (await client.post(f"{API}/subjects/{copy_['id']}/share", json={"user_ids": [str(ana.id)]}, headers=H(ana))).status_code == 404

    # Separate from here on: ben studies his, ana deletes hers; each is untouched by the other.
    before = (await client.get(f"{API}/subjects/{sid}", headers=H(ana))).json()["progress"]
    assert (await client.post(f"{API}/subjects/{copy_['id']}/placement/skip", headers=H(ben))).status_code == 200
    bs = await db.get(StudySubject, cid)
    await db.refresh(bs)
    out = await kit.run_course(db, ben, bs, kit.strong)
    assert out["complete"]
    assert (await client.get(f"{API}/subjects/{sid}", headers=H(ana))).json()["progress"] == before
    assert (await client.delete(f"{API}/subjects/{sid}", headers=H(ana))).status_code == 200
    await service.purge_subject(db, ana, uuid.UUID(sid))
    still = (await client.get(f"{API}/subjects/{copy_['id']}", headers=H(ben))).json()
    assert still["title"] == "Tides" and still["status"] == "complete"
    assert (await db.execute(select(StudyConcept).where(StudyConcept.subject_id == cid))).first() is not None


async def test_who_a_course_can_and_cannot_be_given_to(client, db, model, pushes):  # noqa: F811
    from app.people import blocks

    ana, ben, cat, dan, kid = [await mk_user(db, n) for n in ("ana", "ben", "cat", "dan", "kid")]
    kid.study_level_lock = "child"
    dan.disabled = True
    await db.commit()
    await blocks.block(db, cat.id, ana.id)  # cat has blocked ana
    await db.commit()
    sid = await ready(client, db, ana)

    async def give(*who):
        return await client.post(f"{API}/subjects/{sid}/share", json={"user_ids": [w if isinstance(w, str) else str(w.id) for w in who]}, headers=H(ana))

    assert (await give(ana)).status_code == 422  # not to yourself
    assert (await client.post(f"{API}/subjects/{sid}/share", json={"user_ids": []}, headers=H(ana))).status_code == 422
    assert (await client.post(f"{API}/subjects/{sid}/share", json={"user_ids": [str(ben.id)] * 11}, headers=H(ana))).status_code == 422
    assert (await client.post(f"{API}/subjects/{sid}/share", json={"user_ids": [str(ben.id)]})).status_code == 401

    ghost = "00000000-0000-4000-8000-000000000001"
    r = (await give(ben, ben, cat, dan, kid, ghost)).json()
    assert r["given"] == [{"user_id": str(ben.id), "name": ben.username}]  # once, though asked twice
    reasons = {s["user_id"]: s for s in r["skipped"]}
    # Blocked, switched off and never-existed all read the same: nothing to learn from the answer.
    assert reasons[str(cat.id)] == {"user_id": str(cat.id), "name": "", "reason": reasons[ghost]["reason"]}
    assert reasons[str(dan.id)]["reason"] == reasons[ghost]["reason"] and reasons[str(dan.id)]["name"] == ""
    assert "younger learner" in reasons[str(kid.id)]["reason"]  # an adult course is not handed to a child account
    assert [p["user_id"] for p in pushes] == [ben.id]
    for who, n in ((ben, 1), (cat, 0), (kid, 0)):
        assert len((await client.get(f"{API}/subjects", headers=H(who))).json()["subjects"]) == n

    # A course made for a child can go to anyone, and is pitched at whoever receives it.
    kid_sid = await ready(client, db, ana, level="child", title="Rock pools")
    r = await client.post(f"{API}/subjects/{kid_sid}/share", json={"user_ids": [str(kid.id), str(ben.id)]}, headers=H(ana))
    assert len(r.json()["given"]) == 2
    kids = (await client.get(f"{API}/subjects", headers=H(kid))).json()["subjects"]
    assert len(kids) == 1 and kids[0]["level"] == "child" and kids[0]["shared_from"] == ana.username
    bens = (await client.get(f"{API}/subjects", headers=H(ben))).json()["subjects"]
    assert sorted(s["level"] for s in bens) == ["adult", "adult"]

    # Not ready, not shareable.
    building = (await client.post(f"{API}/subjects", json={"title": "Half built", "use_web": False}, headers=H(ana))).json()["id"]
    r = await client.post(f"{API}/subjects/{building}/share", json={"user_ids": [str(ben.id)]}, headers=H(ana))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_ready"


# ------------------------------------------------------- the phone's widget


async def test_the_study_widget_shows_your_own_due_and_next_and_nobody_elses(client, db, model):  # noqa: F811
    import uuid
    from datetime import datetime, timedelta, timezone

    from app.study import service
    from app.study.models import StudyConcept, StudySubject
    from tests.test_widgets_glance import _device

    ana, ben = await mk_user(db, "ana"), await mk_user(db, "ben")
    mine, his = await _device(db, ana, ["widgets"]), await _device(db, ben, ["widgets"])

    async def glance(auth):
        r = await client.get("/api/widgets/glance", params={"want": "study"}, auth=auth)
        assert r.status_code == 200, r.text
        return r.json()

    assert "study" not in await glance(mine)  # nothing started, nothing due
    sid = await ready(client, db, ana)
    got = (await glance(mine))["study"]
    assert got == {
        "due": 0, "subject": "Tides", "percent": 0, "next": "Concept 1", "next_url": f"/study/{sid}/continue", "review_url": None,
        "streak": 0, "today": False, "url": "/study",
    }
    # Learn the first idea, then let time pass: it comes due.
    s = await db.get(StudySubject, uuid.UUID(sid))
    se = await service.start_lesson(db, s)
    for _ in range(4):
        st = await service.next_step(db, ana, se, s)
        await kit.answer(db, ana, st, "good", 3)
    learned = (await db.execute(select(StudyConcept).where(StudyConcept.subject_id == s.id, StudyConcept.state == "mastered"))).scalars().first()
    assert learned is not None
    learned.due_at = datetime.now(timezone.utc) - timedelta(hours=1)
    await db.commit()
    got = (await glance(mine))["study"]
    assert got["due"] == 1 and got["review_url"] == "/study/review" and got["today"] is True and got["streak"] == 1
    assert got["next"] == "Concept 2" and got["percent"] > 0
    # Somebody else's phone shows nothing of it; and a phone without the widgets password is refused.
    assert "study" not in await glance(his)
    other = await _device(db, ana, ["upload"])
    assert (await client.get("/api/widgets/glance", params={"want": "study"}, auth=other)).status_code == 403
    assert (await client.get("/api/widgets/glance", params={"want": "study"})).status_code == 401


# ------------------------------------------------- export, and the level lock


async def test_the_export_has_every_step_you_answered_and_never_the_answer_key(db, user, model):
    from app.study.export import study_export

    model.tools = {1: "table"}
    s = await kit.make_subject(db, user, placement="none")  # the quick check, every question missed

    def one_slip(step, concept, n):
        if concept.title == "Concept 2" and n == 0:
            return "bad", 3
        return "good", 2

    out = await kit.run_course(db, user, s, one_slip)
    assert out["complete"]
    subject = (await study_export(db, user))["subjects"][0]
    steps_ = subject["steps"]
    assert len(steps_) >= out["steps"]  # the quick check's questions are there too
    kinds = {x["kind"] for x in steps_}
    assert {"explain", "explore", "mcq", "capstone"} <= kinds
    quick = [x for x in steps_ if x["role"] == "placement"]
    assert quick and all(x["outcome"] == "wrong" and x["feedback"] is None and x["answer"] == "WRONG 2" for x in quick)
    explore = next(x for x in steps_ if x["kind"] == "explore")
    assert explore["idea"] == "Concept 1" and explore["answer"] == "range = 8.0" and explore["outcome"] == "correct"
    assert "Work the figure." in explore["asked"] and "(A figure to work: Tide height)" in explore["asked"]
    slipped = next(x for x in steps_ if x["idea"] == "Concept 2" and x["outcome"] == "wrong")
    assert slipped["confidence"] == 3 and slipped["answer"]
    written = next(x for x in steps_ if x["kind"] in ("explain_back", "scenario") and x["role"] == "lesson")
    assert written["answer"] == "GOOD answer" and written["feedback"] == "Yes, that's it."
    assert next(x for x in steps_ if x["kind"] == "explain")["answer"] is None
    cap = next(x for x in steps_ if x["kind"] == "capstone")
    assert cap["idea"] and cap["asked"] == "Plan a sail around the tide."  # its title is the idea, not said twice
    # What was on the screen, nothing behind it: no rubrics, model answers, hints or solutions.
    blob = json.dumps(steps_)
    for secret in ("the moon pulls", "Leave on the ebb", "Think about the moon", "rubric", "model_answer", "correct_id", "solution", '"goal"'):
        assert secret not in blob, secret
    md = subject["markdown"]
    assert "## What you did" in md and "### 1. Quick check (quick check): Concept" in md
    assert "**Your answer:**" in md and "**Result:** not right, sure" in md and "**Result:** right, fairly sure" in md
    assert md.index("## Sources") < md.index("## What you did") if "## Sources" in md else True

    # Somebody else's export has none of it.
    from tests.test_study_api import mk_user as make

    other = await make(db, "ben")
    assert await study_export(db, other) is None


def test_what_an_answer_reads_as_for_every_kind():
    from app.study import export, steps

    def said(kind, how, **suits):
        raw = kit.raw_explore("plot") if kind == "explore" else kit.raw_step(kind)
        payload = steps.build(kind, raw, seed=5, **suits)

        class S:
            pass

        S.kind, S.payload = kind, payload
        return export.step_answer(kind, payload["public"], kit.answer_for(S, how), [])

    assert said("mcq", "good") == "RIGHT" and said("predict", "misc") == "WRONG 1"
    assert said("order_steps", "good") == "1. 1 first\n2. 2 second\n3. 3 third\n4. 4 fourth"
    assert said("match_pairs", "good").splitlines()[0] == "- L1 → R1"
    assert said("spot_error", "good") == "ERROR here" and said("worked_example", "good") == "- RIGHT"
    assert said("explain_back", "good") == "GOOD answer"
    assert said("explore", "good", tool="plot").startswith("range = ")
    assert "function double" in said("write_code", "good", tool="code", lang="javascript")
    pub = steps.build("teach_student", kit.raw_step("teach_student"))["public"]
    assert export.step_answer("teach_student", pub, {}, [{"role": "learner", "text": "It pulls."}, {"role": "student", "text": "Oh!"}]) == "Me: It pulls.\nSam: Oh!"
    assert export.step_answer("mcq", pub, {"dont_know": True}, []) == "I don't know"
    # Junk in, nothing out: never an error from someone's old or odd row.
    for kind in export._KIND:
        assert isinstance(export.step_answer(kind, {}, {}, []), str)
        assert isinstance(export.step_asked(kind, {}), str)


async def test_a_new_account_can_be_made_with_study_already_set_for_a_child(client, db, model):  # noqa: F811
    admin = await mk_user(db, "root", role="admin")
    body = {"email": "kid@example.com", "username": "kiddo", "password": "Correct-horse-9-battery!", "study_level_lock": "child", "must_change_password": False}
    r = await client.post("/api/admin/users", json=body, headers=H(admin))
    assert r.status_code in (200, 201), r.text
    assert r.json()["study_level_lock"] == "child"
    from app.auth.models import User

    kid = (await db.execute(select(User).where(User.username == "kiddo"))).scalar_one()
    prefs = (await client.get(f"{API}/prefs", headers=H(kid))).json()
    assert prefs["level"] == "child" and prefs["level_locked"] is True
    assert (await client.put(f"{API}/prefs", json={"level": "adult"}, headers=H(kid))).status_code == 403
    sid = await ready(client, db, kid, level="adult")  # asked for adult: gets the locked level
    assert (await client.get(f"{API}/subjects/{sid}", headers=H(kid))).json()["level"] == "child"
    # Left out, a new account chooses for itself; a level that doesn't exist is refused.
    r = await client.post("/api/admin/users", json={**body, "email": "b@example.com", "username": "grown", "study_level_lock": None}, headers=H(admin))
    assert r.status_code in (200, 201) and r.json()["study_level_lock"] is None
    r = await client.post("/api/admin/users", json={**body, "email": "c@example.com", "username": "odd", "study_level_lock": "toddler"}, headers=H(admin))
    assert r.status_code == 422


async def test_a_review_left_open_for_one_subject_does_not_stand_in_for_reviewing_everything(db, user, model):
    from datetime import datetime, timedelta, timezone

    from app.study import service
    from app.study.models import StudyConcept

    a = await kit.make_subject(db, user)
    b = await kit.make_subject(db, user, title="Knots")
    for s in (a, b):
        assert (await kit.run_course(db, user, s, kit.strong))["complete"]
    past = datetime.now(timezone.utc) - timedelta(days=1)
    for c in (await db.execute(select(StudyConcept).where(StudyConcept.subject_id.in_([a.id, b.id])))).scalars():
        c.due_at = past
    await db.commit()

    one = await service.start_review(db, user, a.id)
    assert len(one.plan["queue"]) == 6 and one.plan["scope"] == str(a.id)
    assert (await service.start_review(db, user, a.id)).id == one.id  # the same sitting, picked up

    everything = await service.start_review(db, user)
    await db.refresh(one)
    assert everything.id != one.id and one.status == "done"
    assert len(everything.plan["queue"]) == 12 and everything.plan["scope"] == "all"
    assert (await service.start_review(db, user)).id == everything.id
