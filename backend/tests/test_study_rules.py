"""Study's rules and step kinds, on their own (no database, no model).

* Mastery: what one answer does, the gate, hints, confidence, test-out,
  and a recall that slips.
* What is taught next: prerequisites, staying on a concept, gaps first,
  the step kind that follows what just happened.
* Gaps: when one is called for, and the caps.
* Placement: the search, and what it marks as known.
* Step kinds: every kind builds from a valid raw step, hides its answer,
  and the ones with a right answer grade it here.
"""
from __future__ import annotations

import pytest

from app.study import rules, steps
from app.study.rules import ConceptState as C
from app.study.rules import Evidence as E
from tests.study_kit import answer_for, raw_step


def ev(kind, outcome="correct", **kw):
    return E(kind=kind, outcome=outcome, **kw)


# ------------------------------------------------------------------ mastery


def test_an_explanation_is_not_evidence():
    c = rules.apply_evidence(C("a", 1), ev("explain"))
    assert (c.mastery, c.evidence_count, c.state) == (0.0, 0, "learning")


def test_two_right_answers_one_in_their_own_words_pass_the_gate():
    c = C("a", 1)
    rules.apply_evidence(c, ev("mcq"))
    assert c.mastery == 0.42 and c.state == "learning"
    rules.apply_evidence(c, ev("explain_back"))
    assert c.mastery >= rules.GATE and c.state == "mastered"


def test_recognition_alone_never_masters():
    c = C("a", 1)
    for _ in range(8):
        rules.apply_evidence(c, ev("mcq"))
    assert c.mastery > 0.9 and c.state == "learning" and not rules.passes_gate(c)


def test_wrong_answers_pull_mastery_down_and_keep_it_from_the_gate():
    c = C("a", 1, mastery=0.6)
    rules.apply_evidence(c, ev("explain_back", "wrong"))
    assert c.mastery == pytest.approx(0.24) and c.state == "learning"


def test_partial_counts_for_half():
    assert rules.update_mastery(0.0, ev("scenario", "partial")) == pytest.approx(0.3)


def test_hints_make_a_right_answer_worth_less():
    clean = rules.update_mastery(0.0, ev("explain_back"))
    one = rules.update_mastery(0.0, ev("explain_back", hints=1))
    two = rules.update_mastery(0.0, ev("explain_back", hints=2))
    assert clean > one > two > 0


def test_a_lucky_guess_counts_for_less_and_sure_but_wrong_costs_more():
    assert rules.update_mastery(0.0, ev("mcq", confidence=1)) < rules.update_mastery(0.0, ev("mcq", confidence=2))
    assert rules.update_mastery(0.5, ev("mcq", "wrong", confidence=3)) < rules.update_mastery(0.5, ev("mcq", "wrong", confidence=2))


def test_test_out_masters_on_one_clean_answer_only():
    assert rules.apply_evidence(C("a", 1), ev("scenario", test_out=True)).state == "mastered"
    assert rules.apply_evidence(C("a", 1), ev("scenario", "partial", test_out=True)).state == "learning"
    assert rules.apply_evidence(C("a", 1), ev("scenario", test_out=True, confidence=1)).state == "learning"


def test_one_slip_on_recall_keeps_it_mastered_two_send_it_back():
    c = C("a", 1, mastery=0.72, state="mastered", evidence_count=2, production_ok=1)
    rules.apply_evidence(c, ev("mcq", "wrong"))
    assert c.state == "mastered"
    rules.apply_evidence(c, ev("mcq", "wrong"))
    assert c.state == "learning" and c.production_ok == 0


def test_compressed_entry_needs_one_answer_in_their_own_words():
    # Placement left it "likely known": mastery 0.6 and one piece of evidence.
    c = C("a", 1, mastery=rules.LIKELY_MASTERY, evidence_count=1)
    assert rules.choose_kind(c, []) [0] in rules.PRODUCTION
    rules.apply_evidence(c, ev("explain_back"))
    assert c.state == "mastered"


# -------------------------------------------------------------- what's next


def chain():
    return [C("a", 1), C("b", 2, prereqs=("a",)), C("c", 3, prereqs=("b",)), C("d", 4)]


def test_only_concepts_whose_prerequisites_are_done_are_available():
    cs = chain()
    assert [c.id for c in rules.available(cs)] == ["a", "d"]
    cs[0].state = "known"
    assert [c.id for c in rules.available(cs)] == ["b", "d"]


def test_pick_stays_on_the_focus_then_started_then_course_order():
    cs = chain()
    assert rules.pick_concept(cs).id == "a"
    assert rules.pick_concept(cs, focus="d").id == "d"
    cs[3].state, cs[3].mastery = "learning", 0.2
    assert rules.pick_concept(cs).id == "d"  # started beats new
    assert rules.pick_concept(cs, parked=["d"]).id == "a"
    for c in cs:
        c.state = "mastered"
    assert rules.pick_concept(cs) is None


def test_a_ready_gap_concept_comes_first():
    cs = [C("a", 1, state="mastered"), C("g", 1.5, origin="gap"), C("b", 2, prereqs=("a", "g"), state="learning"), C("d", 4, state="learning")]
    assert rules.pick_concept(cs, focus="b").id == "g"


def test_step_kinds_follow_what_just_happened():
    c = C("a", 1, nature="principle")
    assert rules.choose_kind(c, []) == ("explain", "plain")
    assert rules.choose_kind(c, [("explain", None)])[0] == "predict"
    assert rules.choose_kind(c, [("explain", None), ("predict", "correct")])[0] == "explain_back"
    # A miss: explained again another way, then a recognition step not used yet.
    again = [("explain", None), ("predict", "wrong")]
    assert rules.choose_kind(c, again) == ("explain", "analogy")
    assert rules.choose_kind(c, again + [("explain", None)])[0] == "mcq"
    # A partial answer in their own words: the same.
    assert rules.choose_kind(c, [("explain", None), ("predict", "correct"), ("explain_back", "partial")])[0] == "explain"


def test_production_kinds_rotate_and_never_repeat_back_to_back():
    c = C("a", 1, nature="skill")
    hist = [("explain", None), ("mcq", "correct")]
    seen = []
    for _ in range(6):
        k, _a = rules.choose_kind(c, hist)
        seen.append(k)
        hist.append((k, "correct"))
    assert seen[:4] == list(rules.PRODUCTION_FOR["skill"])
    assert all(a != b for a, b in zip(seen, seen[1:]))


def test_recall_comes_every_few_graded_steps_and_picks_the_oldest():
    cs = [C("a", 1, state="mastered", last_seen=5), C("b", 2, state="known", last_seen=1), C("c", 3, state="learning")]
    assert rules.recall_due(3, 3, cs, "c") is None
    assert rules.recall_due(4, rules.RECALL_EVERY, cs, "c").id == "b"
    assert rules.recall_due(4, 4, [cs[2]], "c") is None
    assert rules.recall_kind(cs[0], [("mcq", "correct")]) in ("match_pairs", "order_steps")


def test_parking():
    assert not rules.should_park(rules.PARK_AFTER - 1) and rules.should_park(rules.PARK_AFTER)


# --------------------------------------------------------------------- gaps


def test_when_a_gap_is_called_for():
    w = rules.wants_gap
    assert not w(outcome="correct", confidence=3, misconception_seen=5, wrong_on_concept=9)
    assert not w(outcome="wrong", confidence=2, misconception_seen=1, wrong_on_concept=1)
    assert w(outcome="wrong", confidence=2, misconception_seen=2, wrong_on_concept=2)
    assert w(outcome="wrong", confidence=3, misconception_seen=1, wrong_on_concept=1)  # sure, and wrong the same way
    assert not w(outcome="partial", confidence=3, misconception_seen=1, wrong_on_concept=1)
    assert w(outcome="partial", confidence=None, misconception_seen=0, wrong_on_concept=3)


def test_gap_caps_and_duplicates():
    ok = dict(existing_titles=["Tides", "The Moon's pull"], gaps_for_concept=0, gaps_in_subject=0, target_is_gap=False)
    assert rules.gap_allowed(title="Gravity basics", **ok).ok
    assert not rules.gap_allowed(title="the moon's PULL!", **ok).ok
    assert not rules.gap_allowed(title="", **ok).ok
    assert not rules.gap_allowed(title="Gravity", **{**ok, "gaps_for_concept": rules.MAX_GAPS_PER_CONCEPT}).ok
    assert not rules.gap_allowed(title="Gravity", **{**ok, "gaps_in_subject": rules.MAX_GAPS_PER_SUBJECT}).ok
    assert not rules.gap_allowed(title="Gravity", **{**ok, "target_is_gap": True}).ok


# ---------------------------------------------------------------- placement


def run_placement(n, knows_up_to):
    p = rules.Placement(n=n)
    while (i := p.next_probe()) is not None:
        p.record(i, i <= knows_up_to)
    return p


@pytest.mark.parametrize("knows", [-1, 0, 2, 3, 6])
def test_placement_finds_the_frontier_in_a_few_questions(knows):
    p = run_placement(7, knows)
    assert p.frontier == knows and len(p.asked) <= 3
    assert rules.Placement.from_json(p.to_json()).frontier == knows


def test_placement_result_marks_known_and_likely():
    cs = [C(str(i), float(i)) for i in range(1, 11)]
    probes = rules.pick_probes(cs, want=4)
    assert probes == ["1", "4", "7", "10"]
    p = run_placement(4, 1)  # knows up to the probe on concept 4
    res = rules.placement_result(cs, probes, p)
    assert set(res) == {"1", "2", "3", "4"}
    assert res["4"] == (rules.KNOWN_MASTERY, "known") and res["2"] == (rules.LIKELY_MASTERY, "new")
    assert rules.placement_result(cs, probes, run_placement(4, -1)) == {}


def test_a_probe_answered_wrong_is_not_marked_even_before_the_frontier():
    cs = [C(str(i), float(i)) for i in range(1, 8)]
    probes = [c.id for c in cs]
    p = rules.Placement(n=7)
    p.record(3, True)
    p.record(5, True)
    p.record(6, False)
    p.asked[1] = False  # a miss recorded early (not how the search runs, but safe)
    res = rules.placement_result(cs, probes, p)
    assert "2" not in res and "7" not in res and res["6"][1] == "known"


# --------------------------------------------------------------- step kinds


@pytest.mark.parametrize("kind", rules.KINDS)
def test_every_kind_builds_and_keeps_its_answer_out_of_the_public_part(kind):
    payload = steps.build(kind, raw_step(kind), valid_sources={1}, seed=7)
    pub = payload["public"]
    text = str(pub)
    for secret in ("correct", "error_id", "rubric", "model_answer", "misconception", "hints", "pairs", "'order'"):
        assert secret not in text, (kind, secret)
    if kind != "explain":
        assert "hints" in payload["key"]
        assert "hints" not in steps.reveal_view(kind, payload)


@pytest.mark.parametrize("kind", steps.LOCAL)
def test_kinds_with_a_right_answer_are_graded_here(kind):
    class S:
        pass

    st = S()
    st.kind, st.payload = kind, steps.build(kind, raw_step(kind), seed=3)
    good = steps.grade_local(kind, st.payload, steps.check_answer(kind, st.payload, answer_for(st, "good")))
    bad = steps.grade_local(kind, st.payload, steps.check_answer(kind, st.payload, answer_for(st, "bad")))
    assert good["outcome"] == "correct" and bad["outcome"] in ("wrong", "partial")
    dunno = steps.grade_local(kind, st.payload, steps.check_answer(kind, st.payload, {"dont_know": True}))
    assert dunno["outcome"] == "wrong"


def test_a_wrong_option_names_its_misconception():
    class S:
        kind = "mcq"
        payload = steps.build("mcq", raw_step("mcq"), seed=1)

    g = steps.grade_local("mcq", S.payload, answer_for(S, "misc"))
    assert g["outcome"] == "wrong" and g["misconception"]
    assert steps.grade_local("mcq", S.payload, answer_for(S, "bad"))["misconception"] is None


def test_order_and_match_give_partial_credit():
    p = steps.build("order_steps", raw_step("order_steps"), seed=1)
    o = p["key"]["order"]
    assert steps.grade_local("order_steps", p, {"order": [o[1], o[0], o[2], o[3]]})["outcome"] == "partial"
    m = steps.build("match_pairs", raw_step("match_pairs"), seed=1)
    pairs = dict(m["key"]["pairs"])
    a, b = list(pairs)[:2]
    pairs[a], pairs[b] = pairs[b], pairs[a]
    assert steps.grade_local("match_pairs", m, {"pairs": pairs})["outcome"] == "partial"


@pytest.mark.parametrize(
    "kind,raw",
    [
        ("mcq", {"question": "Q?", "options": [{"text": "a"}, {"text": "b"}], "correct": 0}),  # too few options
        ("mcq", {"question": "Q?", "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}], "correct": 7}),
        ("mcq", {"question": "Q?", "options": [{"text": "a"}, {"text": "A"}, {"text": "c"}], "correct": 0}),
        ("mcq", {"options": [{"text": "a"}, {"text": "b"}, {"text": "c"}], "correct": 0}),
        ("order_steps", {"prompt": "p", "steps": ["a", "b"]}),
        ("spot_error", {"intro": "i", "lines": ["a", "b", "c"], "error": "2", "explain": "e"}),
        ("worked_example", {"problem": "p", "steps": [{"text": "a"}, {"text": "b"}]}),  # nothing to fill in
        ("explain_back", {"prompt": "p", "rubric": ["only one"], "model_answer": "m"}),
        ("teach_student", {"opening": "o", "rubric": ["a", "b"], "model_answer": "m"}),  # no misconception
        ("explain", {"title": "t"}),
        ("mcq", "not an object"),
    ],
)
def test_a_step_that_cannot_be_used_is_refused(kind, raw):
    with pytest.raises(steps.StepInvalid):
        steps.build(kind, raw)


@pytest.mark.parametrize(
    "kind,answer",
    [
        ("mcq", {"option_id": "nope"}),
        ("mcq", "o1"),
        ("order_steps", {"order": ["s1"]}),
        ("match_pairs", {"pairs": {"l1": "r1"}}),
        ("spot_error", {}),
        ("worked_example", {"blanks": {}}),
        ("explain_back", {"text": " "}),
    ],
)
def test_an_answer_in_the_wrong_shape_is_refused(kind, answer):
    payload = steps.build(kind, raw_step(kind), seed=1)
    with pytest.raises(steps.AnswerInvalid):
        steps.check_answer(kind, payload, answer)


def test_diagrams_are_data_and_bad_ones_are_dropped():
    d = steps.clean_diagram({"type": "cycle", "title": "Water", "nodes": ["Sea", "Cloud", "Rain"]})
    assert [n["id"] for n in d["nodes"]] == ["n1", "n2", "n3"] and len(d["edges"]) == 3
    assert steps.clean_diagram({"type": "tree", "nodes": [{"id": "a", "label": "A", "parent": None}, {"id": "b", "label": "B", "parent": "a"}]})
    assert steps.clean_diagram({"type": "tree", "nodes": [{"id": "a", "label": "A", "parent": "zz"}, {"id": "b", "label": "B", "parent": "a"}]}) is None
    assert steps.clean_diagram({"type": "bars", "unit": "m", "bars": [{"label": "a", "value": 1}, {"label": "b", "value": 2.5}]})
    assert steps.clean_diagram({"type": "bars", "bars": [{"label": "a", "value": "big"}, {"label": "b", "value": 2}]}) is None
    assert steps.clean_diagram({"type": "compare", "columns": ["A", "B"], "rows": [{"label": "x", "cells": ["1", "2"]}]})
    assert steps.clean_diagram({"type": "timeline", "items": [{"label": "a", "when": "1900"}, {"label": "b"}]})
    for bad in (None, "<svg>", {"type": "html", "html": "<b>"}, {"type": "flow", "nodes": [{"label": "only one"}]}):
        assert steps.clean_diagram(bad) is None
    # A step with a bad diagram keeps its explanation.
    raw = {**raw_step("explain"), "diagram": {"type": "flow", "nodes": "<script>"}}
    assert steps.build("explain", raw)["public"]["diagram"] is None


def test_a_written_grade_is_checked():
    rubric = ["a", "b"]
    g = steps.clean_written_grade({"outcome": "partial", "met": [0, 9, "x"], "feedback": "ok", "misconception": {"label": "L", "detail": "D"}}, rubric)
    assert g["outcome"] == "partial" and g["detail"]["met"] == [0] and g["misconception"] == "L"
    for bad in ({"outcome": "great", "feedback": "x"}, {"outcome": "correct"}, "correct"):
        with pytest.raises(steps.StepInvalid):
            steps.clean_written_grade(bad, rubric)


def test_sources_cited_must_exist():
    p = steps.build("mcq", {**raw_step("mcq"), "sources": [1, 2, 99, "3", True]}, valid_sources={1, 2})
    assert p["public"]["sources"] == [1, 2]


def test_placement_state_survives_being_saved_at_every_point():
    # Saved and loaded after each answer (as the engine does), all wrong.
    p = rules.Placement(n=6)
    asked = []
    while (i := p.next_probe()) is not None:
        asked.append(i)
        p.record(i, False)
        p = rules.Placement.from_json(p.to_json())
        assert len(asked) < 10
    assert asked == [2, 0] and p.frontier == -1
