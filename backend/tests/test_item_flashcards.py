"""Flashcards (app/items/kinds/flashcards): FSRS-6 correctness, cloze
parsing, the data model, every action, import parsing, to_text,
reminders, the AI tool schema and one end-to-end API flow."""
from __future__ import annotations

import json
import math
import os
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.items.kinds.flashcards import SPEC, fsrs, importer, reminders, study, template, to_text
from app.items.kinds.flashcards.cloze import ClozeError, render_plain, review_keys, validate_cloze
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 9, 30, tzinfo=TZ)


def ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def blank() -> dict:
    return SPEC.validate(template(ctx()))


def run(data: dict, _action: str, now: datetime = NOW, **args):
    action = SPEC.action(_action)
    assert action is not None, _action
    out = action.run(ctx(now), data, action.params.model_validate(args))
    SPEC.validate(data)  # every action leaves a valid file
    return out


def cfg(**kw) -> fsrs.Config:
    return fsrs.Config(tz=TZ, **kw)


# ======================================================== FSRS correctness


def test_default_weights_are_fsrs6():
    w = fsrs.DEFAULT_WEIGHTS
    assert len(w) == 21
    assert w[:4] == (0.212, 1.2931, 2.3065, 8.2956)
    assert w[20] == 0.1542


def test_initial_stability_and_difficulty_for_each_rating():
    c = cfg()
    assert [fsrs.init_stability(g, c) for g in fsrs.RATINGS] == [0.212, 1.2931, 2.3065, 8.2956]
    d = [round(fsrs.init_difficulty(g, c), 4) for g in fsrs.RATINGS]
    # D0(G) = w4 − e^(w5·(G−1)) + 1: 6.4133, 5.1122, 2.1181, (−4.77 →) 1
    assert d == [6.4133, 5.1122, 2.1181, 1.0]
    assert round(fsrs.init_difficulty(fsrs.EASY, c, clamp=False), 3) == -4.772


def test_interval_at_90_percent_is_the_stability():
    c = cfg()
    # FACTOR is chosen so that R(S, S) = 0.9 exactly.
    for s in (1.0, 2.3065, 10.0, 123.4):
        assert math.isclose(fsrs.retrievability(s, s, c), 0.9, rel_tol=1e-12)
    assert fsrs.next_interval(2.3065, c) == 2
    assert fsrs.next_interval(8.2956, c) == 8
    assert fsrs.next_interval(100.0, c) == 100
    # Lower retention → longer interval; higher → shorter.
    assert fsrs.next_interval(100.0, cfg(retention=0.8)) > 200
    assert fsrs.next_interval(100.0, cfg(retention=0.95)) < 50
    assert fsrs.next_interval(0.01, c) == 1  # at least a day
    assert fsrs.next_interval(1e6, cfg(maximum_interval=365)) == 365
    assert math.isclose(c.factor, 0.9 ** (1 / -0.1542) - 1)


def test_new_card_buttons_follow_learning_steps():
    c = cfg(fuzz=False)
    p = fsrs.preview(fsrs.new_srs("f"), NOW, c, "k/f")
    assert [p[g]["state"] for g in fsrs.RATINGS] == ["learning", "learning", "learning", "review"]
    assert p[1]["_minutes"] == 1 and p[2]["_minutes"] == 5.5 and p[3]["_minutes"] == 10
    assert p[4]["_days"] == 8
    # Review intervals land on the rollover (4 am local) of the due day.
    assert p[4]["due"] == "2026-11-08T04:00:00+11:00"
    assert p[1]["due"] == "2026-10-31T09:31:00+11:00"
    labels = [fsrs.label(p[g]["_minutes"], p[g]["_days"]) for g in fsrs.RATINGS]
    assert labels == ["1m", "6m", "10m", "8d"]


def test_hard_with_one_learning_step_is_one_and_a_half_times():
    p = fsrs.preview(fsrs.new_srs("f"), NOW, cfg(learning_steps=(10.0,)), "k/f")
    assert p[2]["_minutes"] == 15 and p[3]["state"] == "review"


def test_graduating_and_same_day_short_term_stability():
    c = cfg(fuzz=False)
    s, log = fsrs.review(fsrs.new_srs("f"), fsrs.GOOD, NOW, c, "k/f")
    assert s["state"] == "learning" and s["step"] == 1 and s["reps"] == 1
    assert log == {"r": 3, "s": "n", "e": 0, "i": round(10 / 1440, 4)}
    s2, log2 = fsrs.review(s, fsrs.GOOD, NOW + timedelta(minutes=10), c, "k/f")
    assert s2["state"] == "review" and s2["step"] is None
    # Same-day Good: S·e^(w17·(0+w18))·S^−w19 < S, floored at ×1 → unchanged.
    assert math.isclose(s2["stability"], 2.3065)
    assert log2["s"] == "l" and log2["i"] == 2.0
    assert s2["due"] == "2026-11-02T04:00:00+11:00"
    # Same-day Again lowers stability: S·e^(w17·(−2+w18))·S^−w19
    w = fsrs.DEFAULT_WEIGHTS
    lower = fsrs.short_term_stability(2.3065, fsrs.AGAIN, c)
    assert math.isclose(lower, 2.3065 * math.exp(w[17] * (-2 + w[18])) * 2.3065 ** (-w[19]))
    assert lower < 2.3065


def test_review_success_grows_stability_by_the_recall_formula():
    c = cfg(fuzz=False)
    srs = {**fsrs.new_srs("f"), "state": "review", "stability": 10.0, "difficulty": 5.0,
           "last_review": fsrs.iso(NOW - timedelta(days=10)), "due": fsrs.iso(NOW), "reps": 3}
    p = fsrs.preview(srs, NOW, c, "k/f")
    w = fsrs.DEFAULT_WEIGHTS
    r = fsrs.retrievability(10, 10.0, c)
    assert math.isclose(r, 0.9)
    expect_good = 10.0 * (1 + math.exp(w[8]) * (11 - 5.0) * 10.0 ** (-w[9]) * (math.exp((1 - r) * w[10]) - 1))
    assert math.isclose(p[3]["stability"], expect_good)
    assert math.isclose(p[2]["stability"], 10.0 * (1 + math.exp(w[8]) * 6 * 10 ** -w[9] * (math.exp(0.1 * w[10]) - 1) * w[15]))
    assert p[4]["stability"] > p[3]["stability"] > p[2]["stability"] > 10.0
    # Difficulty: Good leaves it nearly unchanged (mean reversion only), Again raises it.
    d_good = w[7] * fsrs.init_difficulty(4, c, clamp=False) + (1 - w[7]) * 5.0
    assert math.isclose(p[3]["difficulty"], d_good)
    assert p[1]["difficulty"] > 5.0 > p[4]["difficulty"]
    # Intervals are ordered Hard < Good < Easy.
    assert p[2]["_days"] < p[3]["_days"] < p[4]["_days"]
    assert p[3]["_days"] == fsrs.next_interval(expect_good, c)


def test_lapse_goes_to_relearning_with_forget_stability():
    c = cfg(fuzz=False)
    srs = {**fsrs.new_srs("f"), "state": "review", "stability": 30.0, "difficulty": 6.0,
           "last_review": fsrs.iso(NOW - timedelta(days=30)), "reps": 5, "lapses": 1}
    s, log = fsrs.review(srs, fsrs.AGAIN, NOW, c, "k/f")
    w = fsrs.DEFAULT_WEIGHTS
    r = 0.9
    long_term = w[11] * 6.0 ** (-w[12]) * (31.0 ** w[13] - 1) * math.exp((1 - r) * w[14])
    short_term = 30.0 / math.exp(w[17] * w[18])
    assert math.isclose(s["stability"], min(long_term, short_term), rel_tol=1e-9)
    assert s["stability"] < 30 / 5  # a lapse loses most of it
    assert s["state"] == "relearning" and s["step"] == 0 and s["lapses"] == 2
    assert s["due"] == fsrs.iso(NOW + timedelta(minutes=10))
    assert log["s"] == "r" and log["e"] == 30 and log["r"] == 1
    # Relearning Good on the last step → back to review, interval from the new stability.
    s2, _ = fsrs.review(s, fsrs.GOOD, NOW + timedelta(minutes=10), c, "k/f")
    assert s2["state"] == "review" and s2["lapses"] == 2
    # Without relearning steps a lapse stays in review.
    s3, _ = fsrs.review(srs, fsrs.AGAIN, NOW, cfg(fuzz=False, relearning_steps=()), "k/f")
    assert s3["state"] == "review" and s3["lapses"] == 2


def test_study_days_use_the_rollover_hour():
    c = cfg()
    evening = datetime(2026, 10, 30, 21, 0, tzinfo=TZ)
    morning = datetime(2026, 10, 31, 8, 0, tzinfo=TZ)
    small_hours = datetime(2026, 10, 31, 3, 0, tzinfo=TZ)
    assert fsrs.day_index(morning, c) - fsrs.day_index(evening, c) == 1
    assert fsrs.day_index(small_hours, c) == fsrs.day_index(evening, c)
    assert fsrs.study_date(small_hours, c) == "2026-10-30"


def test_fuzz_is_seeded_bounded_and_deterministic():
    c = cfg()
    assert fsrs.seeded_random("abc:0") == fsrs.seeded_random("abc:0")
    assert fsrs.seeded_random("abc:0") != fsrs.seeded_random("abc:1")
    # Golden values shared with the TypeScript mirror (fsrs.ts).
    assert round(fsrs.seeded_random("abc:0"), 12) == round(0.9884558890480548, 12)
    vals = [fsrs.seeded_random(f"card{i}") for i in range(2000)]
    assert all(0 <= v < 1 for v in vals) and 0.45 < sum(vals) / len(vals) < 0.55
    assert fsrs.fuzz_interval(2, 0.99, c) == 2  # < 2.5 days: none
    for v in (0.0, 0.5, 0.999):
        f = fsrs.fuzz_interval(100, v, c)
        assert 93 <= f <= 107  # delta = 1 + .15·4.5 + .1·13 + .05·80 ≈ 7
    assert fsrs.fuzz_interval(100, 0.0, c) == 93 and fsrs.fuzz_interval(100, 0.999, c) == 107
    srs = {**fsrs.new_srs("f"), "state": "review", "stability": 50.0, "difficulty": 5.0,
           "last_review": fsrs.iso(NOW - timedelta(days=50)), "reps": 4}
    a = fsrs.preview(srs, NOW, c, "k1/f")
    b = fsrs.preview(srs, NOW, c, "k1/f")
    assert [a[g]["_days"] for g in fsrs.RATINGS] == [b[g]["_days"] for g in fsrs.RATINGS]


def test_golden_run_shared_with_the_typescript_mirror():
    """A 16-answer run (lapses, relearning, Hard/Easy, fuzz on). The same
    run through ``fsrs.ts`` gave identical labels, due moments, S and D —
    if this changes, change fsrs.ts the same way."""
    from datetime import timezone

    tz = timezone(timedelta(hours=10))
    c = fsrs.Config(tz=tz)
    seq = [3, 3, 3, 1, 3, 2, 4, 3, 1, 1, 3, 4, 3, 3, 2, 3]
    s, t = fsrs.new_srs("f"), datetime(2026, 10, 31, 20, 17, 5, tzinfo=tz)
    labels, dues = [], []
    for i, g in enumerate(seq):
        p = fsrs.preview(s, t, c, f"kab{i % 3}/f")
        labels.append([fsrs.label(p[x]["_minutes"], p[x]["_days"]) for x in fsrs.RATINGS])
        s, _ = fsrs.review(s, g, t, c, f"kab{i % 3}/f")
        dues.append(s["due"])
        t = fsrs.parse_moment(s["due"]) + timedelta(hours=(i * 7) % 30, minutes=13)
    assert labels == [
        ["1m", "6m", "10m", "8d"], ["1m", "10m", "2d", "4d"], ["10m", "8d", "11d", "19d"], ["10m", "1mo", "1.4mo", "2.4mo"],
        ["10m", "15m", "3d", "4d"], ["10m", "7d", "10d", "15d"], ["10m", "14d", "17d", "24d"], ["10m", "1.1mo", "1.5mo", "2.2mo"],
        ["10m", "2.2mo", "2.8mo", "3.9mo"], ["10m", "15m", "4d", "5d"], ["10m", "15m", "1d", "2d"], ["10m", "2d", "3d", "4d"],
        ["10m", "4d", "5d", "7d"], ["10m", "8d", "9d", "12d"], ["10m", "10d", "12d", "15d"], ["10m", "15d", "18d", "22d"],
    ]
    assert dues[-1] == "2027-03-24T04:00:00+10:00"
    assert round(s["stability"], 6) == 15.721547 and round(s["difficulty"], 6) == 9.684949


def test_labels():
    assert fsrs.label(0.5, None) == "<1m"
    assert fsrs.label(10, None) == "10m"
    assert fsrs.label(90, None) == "1.5h"
    assert fsrs.label(None, 5) == "5d"
    assert fsrs.label(None, 45) == "1.5mo"
    assert fsrs.label(None, 400) == "1.1y"


def test_a_long_simulation_stays_sane():
    """A perfect learner's intervals grow; a forgetful one's don't explode."""
    c = cfg()
    s = fsrs.new_srs("f")
    t = NOW
    ivls = []
    for _ in range(12):
        s, log = fsrs.review(s, fsrs.GOOD, t, c, "sim/f")
        t = fsrs.parse_moment(s["due"]) + timedelta(hours=6)
        ivls.append(log["i"])
    review_ivls = [i for i in ivls if i >= 1]
    assert review_ivls == sorted(review_ivls) and review_ivls[-1] > 365
    assert 1 <= s["difficulty"] <= 10


# =============================================================== cloze


def test_cloze_parsing():
    text = "{{c1::Paris}} is the capital of {{c2::France::country}}; {{c1::Seine}} runs through it."
    assert validate_cloze(text) == [1, 2]
    assert review_keys("cloze", text) == ["c1", "c2"]
    assert review_keys("reversed", "x") == ["f", "r"]
    assert review_keys("basic", "x") == ["f"] == review_keys("typein", "x")
    assert render_plain(text, 1, reveal=False) == "[…] is the capital of France; […] runs through it."
    assert render_plain(text, 2, reveal=False) == "Paris is the capital of [country]; Seine runs through it."
    assert render_plain(text) == "Paris is the capital of France; Seine runs through it."
    assert validate_cloze("Energy: {{c1::$E = mc^2$}}") == [1]
    assert validate_cloze("{{c1::$\\frac{a}{b}$}} and {{c3::x}}") == [1, 3]


@pytest.mark.parametrize(
    "bad",
    ["no deletions here", "{{c1::}} empty", "{{c1::a {{c2::b}}}} nested", "{{c1::unclosed", "{{c0::zero}}"],
)
def test_bad_cloze_is_refused(bad):
    with pytest.raises(ClozeError):
        validate_cloze(bad)


# ============================================================ data model


def test_template_and_model_defaults():
    d = blank()
    assert d["decks"] == [] and d["cards"] == [] and d["review_log"] == []
    s = d["settings"]
    assert s["desired_retention"] == 0.9 and s["new_per_day"] == 20 and s["learning_steps"] == [1.0, 10.0]
    assert s["relearning_steps"] == [10.0] and s["maximum_interval"] == 36500 and s["rollover_hour"] == 4
    assert len(s["weights"]) == 21
    # Old/partial files load.
    assert SPEC.validate({})["settings"]["fuzz"] is True


def test_model_reconciles_review_items_and_orphans():
    d = SPEC.validate({
        "decks": [{"id": "a", "name": "A", "parent_id": "missing"}],
        "cards": [
            {"id": "k1", "deck_id": "a", "type": "cloze", "front": "{{c1::x}} {{c2::y}}",
             "srs": [{"k": "c1", "state": "review", "stability": 3, "difficulty": 5, "reps": 2}, {"k": "f"}]},
            {"id": "k2", "deck_id": "gone", "type": "reversed", "front": "q", "back": "a", "tags": ["x", "X", " y "]},
        ],
    })
    assert d["decks"][0]["parent_id"] is None
    c1, c2 = d["cards"]
    assert [s["k"] for s in c1["srs"]] == ["c1", "c2"] and c1["srs"][0]["state"] == "review"
    assert [s["k"] for s in c2["srs"]] == ["f", "r"] and c2["deck_id"] == "default"
    assert c2["tags"] == ["x", "y"]
    assert any(x["id"] == "default" for x in d["decks"])


def test_bad_values_are_refused_and_the_log_is_trimmed():
    with pytest.raises(ValidationError):
        SPEC.validate({"settings": {"desired_retention": 1.5}})
    with pytest.raises(ValidationError):
        SPEC.validate({"settings": {"learning_steps": [-1]}})
    with pytest.raises(ValidationError):
        SPEC.validate({"cards": [{"id": "k", "deck_id": "d", "type": "weird"}]})
    # Past the cap the oldest go — counted, never silently.
    from app.items.kinds.flashcards.models import MAX_LOG

    assert MAX_LOG == 100_000
    log = [{"c": "k", "t": "2026-01-01T00:00:00+00:00", "r": 3}] * (MAX_LOG + 10)
    out = SPEC.validate({"review_log": log, "log_trimmed": 5})
    assert len(out["review_log"]) == MAX_LOG and out["log_trimmed"] == 15
    assert SPEC.validate({"review_log": log[:10]})["log_trimmed"] == 0


def test_deck_cycles_are_broken():
    d = SPEC.validate({"decks": [{"id": "a", "name": "A", "parent_id": "b"}, {"id": "b", "name": "B", "parent_id": "a"}]})
    paths = study.deck_paths(d)
    assert all(len(p.split("::")) <= 2 for p in paths.values())


# =============================================================== actions


def _seed() -> dict:
    d = blank()
    run(d, "add_cards", deck="Biology::Cells", cards=[
        {"front": "Powerhouse of the cell?", "back": "Mitochondrion", "tags": ["bio"]},
        {"type": "cloze", "front": "{{c1::Ribosomes}} make {{c2::proteins}}.", "tags": ["bio"]},
        {"type": "reversed", "front": "ATP", "back": "Adenosine triphosphate"},
    ])
    run(d, "add_cards", deck="Spanish", cards=[{"type": "typein", "front": "dog", "back": "perro", "tags": ["vocab"]}])
    return d


def test_create_deck_nests_and_is_idempotent():
    d = blank()
    out = run(d, "create_deck", name="Med::Pharm::Antibiotics", description="Year 2", color="#112233")
    assert [x["name"] for x in d["decks"]] == ["Med", "Pharm", "Antibiotics"]
    leaf = d["decks"][-1]
    assert leaf["description"] == "Year 2" and leaf["color"] == "#112233"
    assert study.deck_paths(d)[out.result["deck_id"]] == "Med::Pharm::Antibiotics"
    again = run(d, "create_deck", name="med::pharm::antibiotics")
    assert again.result["existed"] and len(d["decks"]) == 3
    with pytest.raises(ActionError):
        run(d, "create_deck", name=" :: ")


def test_add_cards_validates_dedupes_and_is_deterministic():
    d = _seed()
    assert len(d["cards"]) == 4 and len(d["decks"]) == 3
    cloze = next(c for c in d["cards"] if c["type"] == "cloze")
    assert [s["k"] for s in cloze["srs"]] == ["c1", "c2"]
    out = run(d, "add_cards", deck="Biology::Cells", cards=[{"front": "powerhouse of the cell?", "back": "dup"}])
    assert out.result["skipped"] == 1 and not out.result["card_ids"]
    with pytest.raises(ActionError, match="cloze"):
        run(d, "add_cards", deck="Spanish", cards=[{"type": "cloze", "front": "no deletion"}])
    with pytest.raises(ActionError, match="needs a back"):
        run(d, "add_cards", deck="Spanish", cards=[{"front": "q"}])
    with pytest.raises(ActionError, match="use type"):
        run(d, "add_cards", deck="Spanish", cards=[{"front": "{{c1::x}}", "back": "y"}])
    # Same inputs at the same moment → same ids (replay-safe).
    assert [c["id"] for c in _seed()["cards"]] == [c["id"] for c in d["cards"][:4]]


def test_edit_card_keeps_scheduling_of_surviving_items():
    d = _seed()
    cloze = next(c for c in d["cards"] if c["type"] == "cloze")
    cloze["srs"][0].update(state="review", stability=5.0, difficulty=4.0, reps=3)
    run(d, "edit_card", card_id=cloze["id"], front="{{c1::Ribosomes}} translate {{c3::mRNA}}.", tags=["bio", "edited"])
    c = next(x for x in d["cards"] if x["id"] == cloze["id"])
    assert [s["k"] for s in c["srs"]] == ["c1", "c3"] and c["srs"][0]["stability"] == 5.0 and c["srs"][1]["state"] == "new"
    assert c["tags"] == ["bio", "edited"]
    with pytest.raises(ActionError):
        run(d, "edit_card", card_id=cloze["id"], front="no clozes left")
    with pytest.raises(ActionError):
        run(d, "edit_card", card_id="nope", back="x")
    run(d, "edit_card", card_id=cloze["id"], deck="Spanish")
    assert c["deck_id"] == study.find_deck(d, "Spanish")["id"]


def test_bulk_status_actions():
    d = _seed()
    ids = [c["id"] for c in d["cards"][:2]]
    run(d, "suspend_cards", card_ids=ids)
    assert all(c["suspended"] for c in d["cards"][:2])
    run(d, "unsuspend_cards", card_ids=ids)
    assert not any(c["suspended"] for c in d["cards"])
    run(d, "flag_cards", card_ids=ids)
    assert d["cards"][0]["flagged"]
    run(d, "bury_cards", card_ids=ids)
    assert d["cards"][0]["buried_until"] == "2026-11-01"
    run(d, "tag_cards", card_ids=ids, add=["exam"], remove=["bio"])
    assert d["cards"][0]["tags"] == ["exam"]
    with pytest.raises(ActionError):
        run(d, "tag_cards", card_ids=ids)
    run(d, "move_cards", card_ids=ids, deck="Biology::Review")
    assert study.deck_paths(d)[d["cards"][0]["deck_id"]] == "Biology::Review"
    d["cards"][0]["srs"][0].update(state="review", stability=9, difficulty=5, reps=4, due=fsrs.iso(NOW))
    d["review_log"].append({"c": ids[0], "k": "f", "t": fsrs.iso(NOW), "r": 3, "s": "r", "e": 3, "i": 9, "d": 4000})
    run(d, "reset_cards", card_ids=[ids[0]])
    assert d["cards"][0]["srs"][0]["state"] == "new" and len(d["review_log"]) == 1
    run(d, "delete_cards", card_ids=[ids[0]])
    assert len(d["cards"]) == 3 and d["review_log"] == []
    with pytest.raises(ActionError):
        run(d, "delete_cards", card_ids=["missing"])


def test_edit_and_delete_deck():
    d = _seed()
    with pytest.raises(ActionError, match="holds"):
        run(d, "delete_deck", deck="Biology")
    run(d, "edit_deck", deck="Biology::Cells", name="Cell biology", color="#000000")
    assert "Biology::Cell biology" in study.deck_paths(d).values()
    with pytest.raises(ActionError):
        run(d, "edit_deck", deck="Biology", parent="Biology::Cell biology")
    run(d, "delete_deck", deck="Biology::Cell biology", cards="move_to_parent")
    bio = study.find_deck(d, "Biology")
    assert sum(1 for c in d["cards"] if c["deck_id"] == bio["id"]) == 3
    run(d, "delete_deck", deck="Biology", cards="delete")
    assert len(d["cards"]) == 1 and study.find_deck(d, "Biology") is None
    with pytest.raises(ActionError, match="No deck"):
        run(d, "edit_deck", deck="Biology", name="x")


def test_set_settings():
    d = blank()
    run(d, "set_settings", desired_retention=0.92, new_per_day=10, learning_steps=[1, 5, 30], exam_date="2026-12-01")
    s = d["settings"]
    assert s["desired_retention"] == 0.92 and s["new_per_day"] == 10 and s["learning_steps"] == [1.0, 5.0, 30.0]
    assert s["exam_date"] == "2026-12-01"
    run(d, "set_settings", exam_date="")
    assert d["settings"]["exam_date"] is None
    with pytest.raises(ActionError):
        run(d, "set_settings")
    with pytest.raises(ActionError):
        run(d, "set_settings", exam_date="next week")
    with pytest.raises(ActionError):
        run(d, "set_settings", learning_steps=[0])


def _study_some(d: dict) -> None:
    """Answer every card Good twice today (graduates them)."""
    c = fsrs.config_from(d["settings"], TZ)
    t = NOW - timedelta(hours=2)
    for card in d["cards"]:
        for i, s in enumerate(card["srs"]):
            for step in range(2):
                when = t + timedelta(minutes=10 * step)
                nxt, log = fsrs.review(s, fsrs.GOOD, when, c, f"{card['id']}/{s['k']}")
                for k in [k for k in nxt if k.startswith("_")]:
                    nxt.pop(k)
                card["srs"][i] = s = nxt
                d["review_log"].append({"c": card["id"], "k": s["k"], "t": fsrs.iso(when), "d": 5000, **log})


def test_due_summary_counts_and_limits():
    d = _seed()
    out = run(d, "due_summary").result
    # 1 basic + 2 cloze + 2 reversed + 1 typein = 6 new items, but siblings
    # are buried (one per card per day) → 4.
    assert out["total"]["new"] == 4 and out["total"]["review"] == 0
    run(d, "set_settings", bury_siblings=False, new_per_day=5)
    assert run(d, "due_summary").result["total"]["new"] == 5
    spanish = next(x for x in out["decks"] if x["deck"] == "Spanish")
    assert spanish["new"] == 1
    _study_some(d)
    later = run(d, "due_summary").result
    assert later["total"]["new"] == 0 and later["studied_today"] and later["streak_days"] == 1
    # A few days on, the graduated items come due.
    assert run(d, "due_summary", now=NOW + timedelta(days=30)).result["total"]["review"] == 6


def test_find_cards_query_language():
    d = _seed()
    def ids(q):
        return {c["front"] for c in run(d, "find_cards", query=q).result["cards"]}
    assert ids("tag:bio") == {"Powerhouse of the cell?", "{{c1::Ribosomes}} make {{c2::proteins}}."}
    assert ids("deck:biology") == ids("deck:Biology::Cells") and len(ids("deck:biology")) == 3
    assert ids("type:typein") == {"dog"}
    assert ids("-tag:bio is:new deck:biology") == {"ATP"}
    assert ids('"adenosine tri"') == {"ATP"}
    d["cards"][0]["suspended"] = True
    assert ids("is:suspended") == {"Powerhouse of the cell?"}
    d["cards"][1]["srs"][0]["lapses"] = 9
    top = run(d, "find_cards", sort="lapses", limit=1).result
    assert top["total"] == 4 and top["cards"][0]["id"] == d["cards"][1]["id"]


def test_stats_forecast_and_exam_plan():
    d = _seed()
    _study_some(d)
    st = run(d, "deck_stats").result
    assert st["cards"] == 4 and st["review_items"] == {"review": 6}
    assert st["reviews_last_30d"] == 12 and st["minutes_last_30d"] == 1.0
    assert run(d, "deck_stats", deck="Spanish").result["cards"] == 1
    fc = run(d, "study_forecast", days=10).result
    assert len(fc["forecast"]) == 10 and fc["total_due_in_period"] == 6
    assert fc["forecast"][0]["day"] == "2026-10-31"
    plan = run(d, "study_forecast", exam_date="2026-11-30").result["exam"]
    assert plan["days_left"] == 30 and plan["seen_items"] == 6 and plan["unseen_items"] == 0
    assert plan["seen_items_below_target_on_exam_day"] == 6  # S ≈ 2–8 days, a month away
    d2 = _seed()
    plan2 = run(d2, "study_forecast", exam_date="2026-11-30").result["exam"]
    assert plan2["unseen_items"] == 6 and plan2["suggested_new_per_day"] == 1
    with pytest.raises(ActionError):
        run(d, "study_forecast", exam_date="soon")
    # True retention: Again on a review counts as a fail.
    d["review_log"].append({"c": d["cards"][0]["id"], "k": "f", "t": fsrs.iso(NOW), "r": 1, "s": "r", "e": 2, "i": 0.0069, "d": 3000})
    d["review_log"].append({"c": d["cards"][0]["id"], "k": "f", "t": fsrs.iso(NOW), "r": 3, "s": "r", "e": 2, "i": 3, "d": 3000})
    assert run(d, "deck_stats").result["true_retention_30d"] == {"reviews": 2, "retention": 0.5, "target": 0.9}


def test_card_details():
    d = _seed()
    _study_some(d)
    out = run(d, "card_details", card_ids=[d["cards"][0]["id"]]).result["cards"][0]
    assert out["front"] == "Powerhouse of the cell?" and len(out["history"]) == 2
    assert out["items"][0]["state"] == "review" and out["items"][0]["recall_now"] is not None


# ================================================================= import


def test_import_csv_with_header_and_quotes():
    text = 'Question,Answer,Tags\n"What is 2+2?","4","math basic"\n"Comma, inside","yes",\n,missing front,\n'
    cards, skipped, fmt = importer.parse(text)
    assert fmt == "csv" and skipped == 1
    assert cards[0] == {"type": "basic", "front": "What is 2+2?", "back": "4", "tags": ["math", "basic"], "deck": None, "note": ""}
    assert cards[1]["front"] == "Comma, inside"


def test_import_tsv_and_quizlet():
    cards, _, fmt = importer.parse("hola\thello\nperro\tdog\n")
    assert fmt == "tsv" and [c["back"] for c in cards] == ["hello", "dog"]
    cards, skipped, fmt = importer.parse("gato - cat;casa - house;broken", "quizlet", term_sep=" - ", card_sep="semicolon")
    assert fmt == "quizlet" and [(c["front"], c["back"]) for c in cards] == [("gato", "cat"), ("casa", "house")]
    assert skipped == 1
    cards, _, _ = importer.parse("a,b\nc,d", "quizlet", term_sep="comma")
    assert [(c["front"], c["back"]) for c in cards] == [("a", "b"), ("c", "d")]
    cards, _, _ = importer.parse("term one\tline 1\nline 2\n\nterm two\tdef", "quizlet", card_sep="blankline")
    assert [(c["front"], c["back"]) for c in cards] == [("term one", "line 1\nline 2"), ("term two", "def")]


def test_import_anki_plain_text():
    text = (
        "#separator:tab\n#html:true\n#notetype column:1\n#deck column:2\n#tags column:5\n"
        "Basic\tBio::Cells\tWhat is <b>ATP</b>?\tEnergy<br>currency\tbio exam\n"
        "Cloze\tBio::Cells\t{{c1::DNA}} is in the \\(nucleus\\)\tExtra &amp; more\tbio\n"
        "Basic (and reversed card)\tSpanish\tperro\tdog\t\n"
    )
    cards, skipped, fmt = importer.parse(text)
    assert fmt == "anki" and skipped == 0 and len(cards) == 3
    assert cards[0]["front"] == "What is **ATP**?" and cards[0]["back"] == "Energy\ncurrency"
    assert cards[0]["deck"] == "Bio::Cells" and cards[0]["tags"] == ["bio", "exam"]
    assert cards[1]["type"] == "cloze" and cards[1]["front"] == "{{c1::DNA}} is in the $nucleus$" and cards[1]["back"] == "Extra & more"
    assert cards[2]["type"] == "reversed"


def test_import_action_dry_run_decks_and_dupes():
    d = _seed()
    text = "#separator:tab\n#html:false\n#deck column:3\nnew q\tnew a\tChem\nPowerhouse of the cell?\tdup\tBiology::Cells\n{{c1::}} oops\tbad cloze\tChem\n"
    preview = run(d, "import_cards", text=text, dry_run=True).result
    assert preview["count"] == 3 and preview["format"] == "anki"
    assert len(d["cards"]) == 4
    out = run(d, "import_cards", text=text, tags=["imported"])
    assert out.result == {"added": 1, "duplicates": 1, "unreadable": 1, "format": "anki"}
    chem = study.find_deck(d, "Chem")
    new = next(c for c in d["cards"] if c["deck_id"] == chem["id"])
    assert new["tags"] == ["imported"]
    with pytest.raises(ActionError):
        run(d, "import_cards", text="   \n")


# ============================================================ text, AI


def test_to_text():
    d = _seed()
    _study_some(d)
    t = to_text(d)
    assert "4 cards in 3 decks" in t and "Biology::Cells" in t and "Mitochondrion" in t
    assert "Ribosomes make proteins" in t  # cloze text without the syntax
    big = blank()
    big["decks"] = [{"id": "d", "name": "D"}]
    big["cards"] = [{"id": f"k{i}", "deck_id": "d", "front": "x" * 150, "back": "y" * 150} for i in range(500)]
    assert len(to_text(SPEC.validate(big))) <= 21_000


def test_tools_have_no_refs_and_include_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    for a in ("create_deck", "add_cards", "edit_card", "delete_cards", "suspend_cards", "unsuspend_cards", "flag_cards",
              "move_cards", "tag_cards", "set_settings", "reset_cards", "import_cards", "due_summary", "deck_stats",
              "find_cards", "study_forecast", "web_search", "find_my_files"):
        assert a in names, a
    assert "$ref" not in json.dumps(tools)
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "add_cards" not in ro and "due_summary" in ro
    assert SPEC.kind == "flashcards" and SPEC.suffix == ".cards" and SPEC.color == "#5B6DD9" and SPEC.category == "Learning"
    assert len(SPEC.highlights) >= 5 and 4 <= len(SPEC.ai_suggestions) <= 6 and "20 rules" in SPEC.ai_brief


# ============================================================== reminders


def test_reminders_when_cards_are_due():
    d = _seed()
    c = ctx(datetime(2026, 10, 31, 8, 0, tzinfo=TZ))
    rs = reminders(d, c)
    keys = [r.key for r in rs]
    assert keys[0] == "study:2026-10-31" and len(keys) == 8
    assert rs[0].due_at == datetime(2026, 10, 31, 19, 0, tzinfo=TZ) and "4 new" in rs[0].body
    # After studying everything, today's reminder goes; days the reviews fall due keep one.
    _study_some(d)
    rs = reminders(d, c)
    assert "study:2026-10-31" not in {r.key for r in rs} and rs
    d["settings"]["reminder_enabled"] = False
    assert reminders(d, c) == []
    assert reminders(blank(), c) == []


def test_streak_nudge():
    d = _seed()
    d["settings"]["reminder_enabled"] = False
    d["settings"]["streak_nudge"] = True
    yesterday = NOW - timedelta(days=1)
    d["review_log"].append({"c": d["cards"][0]["id"], "k": "f", "t": fsrs.iso(yesterday), "r": 3, "s": "n", "e": 0, "i": 0.0069, "d": 1000})
    rs = reminders(d, ctx())
    assert [r.key for r in rs] == ["streak:2026-10-31"] and "1-day" in rs[0].title
    d["review_log"].append({"c": d["cards"][0]["id"], "k": "f", "t": fsrs.iso(NOW - timedelta(minutes=5)), "r": 3, "s": "l", "e": 0, "i": 0.0069, "d": 1000})
    assert reminders(d, ctx()) == []


# ======================================================= fix pass (review)

GOLDEN = os.path.join(os.path.dirname(__file__), "test_item_flashcards_golden.json")


def _golden_run(tz_name: str) -> dict:
    tz = ZoneInfo(tz_name)
    c = fsrs.Config(tz=tz)
    seq = [3, 3, 3, 1, 3, 2, 4, 3, 1, 1, 3, 4, 3, 3, 2, 3]
    s, t = fsrs.new_srs("f"), datetime(2026, 10, 31, 20, 17, 5, tzinfo=tz)
    steps = []
    for i, g in enumerate(seq):
        seed = f"kab{i % 3}/f"
        p = fsrs.preview(s, t, c, seed)
        labels = [fsrs.label(p[x]["_minutes"], p[x]["_days"]) for x in fsrs.RATINGS]
        at = fsrs.iso(t)
        s, log = fsrs.review(s, g, t, c, seed)
        steps.append({"at": at, "rating": g, "seed": seed, "labels": labels, "due": s["due"], "state": s["state"],
                      "stability": round(s["stability"], 9), "difficulty": round(s["difficulty"], 9), "log": log})
        t = fsrs.parse_moment(s["due"]) + timedelta(hours=(i * 7) % 30, minutes=13)
    return {"tz": tz_name, "steps": steps}


def test_golden_fixture():
    """The JSON fixture ``frontend/.../flashcards/golden.ts`` checks fsrs.ts
    against (see its header for the esbuild + node command) is exactly what
    fsrs.py produces."""
    with open(GOLDEN, encoding="utf-8") as f:
        fx = json.load(f)
    run_ = _golden_run(fx["tz"])
    if os.environ.get("FLASHCARDS_REGEN_GOLDEN"):
        with open(GOLDEN, "w", encoding="utf-8") as f:
            json.dump({"about": fx.get("about", ""), **run_}, f, indent=1)
    assert len(fx["steps"]) == 16
    for got, want in zip(run_["steps"], fx["steps"]):
        assert got["labels"] == want["labels"] and got["due"] == want["due"] and got["state"] == want["state"]
        assert math.isclose(got["stability"], want["stability"], rel_tol=1e-9)
        assert math.isclose(got["difficulty"], want["difficulty"], rel_tol=1e-9)
        assert got["log"] == want["log"] and got["at"] == want["at"]


def test_negative_elapsed_is_clamped_not_refused():
    """A previous review "ahead" of this one (clock skew between devices,
    travelling west) must not drop the answer."""
    c = cfg(fuzz=False)
    ahead = {**fsrs.new_srs("f"), "state": "review", "stability": 10.0, "difficulty": 5.0,
             "last_review": fsrs.iso(NOW + timedelta(days=2)), "due": fsrs.iso(NOW + timedelta(days=12)), "reps": 3}
    nxt, log = fsrs.review(ahead, fsrs.GOOD, NOW, c, "k/f")
    assert log["e"] == 0 and nxt["state"] == "review"
    # Same-day path (short-term stability) for an "ahead" review — sane numbers.
    assert nxt["stability"] >= 10.0 and 1 <= nxt["difficulty"] <= 10
    assert fsrs.current_retrievability(ahead, NOW, c) == 1.0
    # The model clamps instead of rejecting a whole save.
    d = SPEC.validate({"review_log": [
        {"c": "k", "t": fsrs.iso(NOW), "r": 3, "e": -3, "i": -1, "d": -50},
        {"c": "k", "t": fsrs.iso(NOW), "r": 3, "e": 10**9, "d": 10**9},
    ]})
    a, b = d["review_log"]
    assert (a["e"], a["i"], a["d"]) == (0, 0.0, 0)
    assert b["e"] == 100_000 and b["d"] == 3_600_000
    with pytest.raises(ValidationError):  # the rating itself is still checked
        SPEC.validate({"review_log": [{"c": "k", "t": fsrs.iso(NOW), "r": 7}]})


def test_today_log_tolerates_out_of_order_entries():
    d = _seed()
    cid = d["cards"][0]["id"]
    c = fsrs.config_from(d["settings"], TZ)
    today_ = {"c": cid, "k": "f", "t": fsrs.iso(NOW - timedelta(minutes=30)), "r": 3, "s": "n"}
    yesterday = {"c": cid, "k": "f", "t": fsrs.iso(NOW - timedelta(days=1)), "r": 3, "s": "r"}
    # A replay left yesterday's entry after today's.
    d["review_log"] = [today_, yesterday]
    assert study.today_log(d, NOW, c) == [today_]
    assert study.counts(d, NOW, c)["new_done_today"] == 1


def test_per_deck_daily_limits():
    d = blank()
    run(d, "add_cards", deck="Lang::Spanish", cards=[{"front": f"es{i}", "back": "x"} for i in range(6)])
    run(d, "add_cards", deck="Lang::French", cards=[{"front": f"fr{i}", "back": "x"} for i in range(6)])
    run(d, "add_cards", deck="Bio", cards=[{"front": f"bio{i}", "back": "x"} for i in range(6)])
    c = fsrs.config_from(d["settings"], TZ)
    assert study.counts(d, NOW, c)["new"] == 18
    run(d, "edit_deck", deck="Lang::Spanish", new_per_day=2)
    assert study.counts(d, NOW, c)["new"] == 14  # 2 + 6 + 6
    run(d, "edit_deck", deck="Lang", new_per_day=5)  # covers its subdecks
    assert study.counts(d, NOW, c)["new"] == 11  # Lang 5 (Spanish ≤ 2) + Bio 6
    spanish = study.find_deck(d, "Lang::Spanish")["id"]
    assert study.counts(d, NOW, c, study.subtree(d, spanish))["new"] == 2
    per = study.deck_counts(d, NOW, c)
    lang = study.find_deck(d, "Lang")["id"]
    assert per[spanish]["new"] == 2 and per[lang]["new"] == 5 and per[lang]["cards"] == 12
    # Today's answers count against the deck's limit.
    sid = next(x["id"] for x in d["cards"] if x["deck_id"] == spanish)
    d["review_log"].append({"c": sid, "k": "f", "t": fsrs.iso(NOW - timedelta(minutes=5)), "r": 3, "s": "n", "e": 0, "i": 0.0069, "d": 1000})
    assert study.counts(d, NOW, c, study.subtree(d, spanish))["new"] == 1
    # The file-wide limit still applies on top.
    run(d, "set_settings", new_per_day=3)
    assert study.counts(d, NOW, c)["new"] == 2  # 3 − 1 done
    run(d, "edit_deck", deck="Lang", clear_limits=True)
    assert study.find_deck(d, "Lang")["new_per_day"] is None
    assert "own limits" in to_text(d)
    with pytest.raises(ValidationError):
        SPEC.validate({"decks": [{"id": "a", "name": "A", "new_per_day": -1}]})


def test_to_text_uses_the_owners_zone_and_one_pass():
    from app.items.spec import _TEXT_NOW

    d = blank()
    run(d, "add_cards", deck="D", cards=[{"front": "q", "back": "a"}])
    srs = d["cards"][0]["srs"][0]
    # Due 2 am on 1 Nov in Sydney: inside Sydney's study day (ends 4 am),
    # but not UTC's (whose day ends 15:00 Sydney on the 31st).
    srs.update(state="review", stability=5.0, difficulty=5.0, reps=2,
               last_review=fsrs.iso(NOW - timedelta(days=5)), due="2026-11-01T02:00:00+11:00")
    d = SPEC.validate(d)
    tok = _TEXT_NOW.set(NOW)
    try:
        assert "1 reviews" in to_text(d)
    finally:
        _TEXT_NOW.reset(tok)
    tok = _TEXT_NOW.set(NOW.astimezone(ZoneInfo("UTC")))
    try:
        assert "0 reviews" in to_text(d)
    finally:
        _TEXT_NOW.reset(tok)
    # Many decks: per-deck numbers come from one pass (no counts() per deck).
    big = blank()
    big["decks"] = [{"id": f"d{i}", "name": f"D{i}"} for i in range(400)]
    big["cards"] = [{"id": f"k{i}", "deck_id": f"d{i % 400}", "front": f"q{i}", "back": "a"} for i in range(8000)]
    big = SPEC.validate(big)
    import time

    calls = 0
    real = study.counts

    def spy(*a, **k):
        nonlocal calls
        calls += 1
        return real(*a, **k)

    study.counts = spy
    try:
        t0 = time.perf_counter()
        to_text(big)
        took = time.perf_counter() - t0
    finally:
        study.counts = real
    assert calls == 1 and took < 5


def test_archive_moves_old_history_only():
    from app.items.kinds.flashcards import archive

    d = _seed()
    _study_some(d)
    cid = d["cards"][0]["id"]
    old = [{"c": cid, "k": "f", "t": fsrs.iso(NOW - timedelta(days=400 + i)), "r": 3, "s": "r", "e": 5, "i": 9.0, "d": 3000} for i in range(5)]
    d["review_log"] = old[::-1] + d["review_log"]
    d = SPEC.validate(d)
    srs_before = json.dumps([c["srs"] for c in d["cards"]], sort_keys=True)
    kept, arch = archive(d, ctx(), (NOW - timedelta(days=30)).date().isoformat())
    assert len(arch["review_log"]) == 5 and len(kept["review_log"]) == len(d["review_log"]) - 5
    assert json.dumps([c["srs"] for c in kept["cards"]], sort_keys=True) == srs_before  # schedule untouched
    assert [c["id"] for c in arch["cards"]] == [cid] and arch["cards"][0]["suspended"] is True
    assert "archived" in arch["cards"][0]["tags"]
    assert arch["settings"]["reminder_enabled"] is False and arch["settings"]["onboarded"] is True
    assert {x["id"] for x in arch["decks"]} >= {arch["cards"][0]["deck_id"]}
    assert reminders(arch, ctx()) == []
    with pytest.raises(ActionError):
        archive(kept, ctx(), (NOW - timedelta(days=30)).date().isoformat())
    with pytest.raises(ActionError):
        archive(d, ctx(), "not a day")
    assert SPEC.archive is archive


# ---------------------------------------------------------------- .apkg


def _png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def _apkg(tmp_path, *, member: str = "collection.anki2", media: dict | None = None, extra: dict | None = None,
          revlog: bool = True) -> str:
    """A small synthetic Anki 2.1 (schema 11) package."""
    import sqlite3
    import zipfile

    db = tmp_path / "col.sqlite"
    if db.exists():
        db.unlink()
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer,
            usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
        CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text,
            flds text, sfld text, csum integer, flags integer, data text);
        CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer,
            type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer,
            left integer, odue integer, odid integer, flags integer, data text);
        CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer,
            lastIvl integer, factor integer, time integer, type integer);
    """)
    models = {
        "1": {"name": "Basic", "type": 0, "flds": [{"name": "Front"}, {"name": "Back"}], "tmpls": [{"qfmt": "{{Front}}"}]},
        "2": {"name": "Basic (and reversed card)", "type": 0, "flds": [{"name": "Front"}, {"name": "Back"}],
              "tmpls": [{"qfmt": "{{Front}}"}, {"qfmt": "{{Back}}"}]},
        "3": {"name": "Cloze", "type": 1, "flds": [{"name": "Text"}, {"name": "Back Extra"}], "tmpls": [{"qfmt": "{{cloze:Text}}"}]},
        "4": {"name": "Basic (type in the answer)", "type": 0, "flds": [{"name": "Front"}, {"name": "Back"}],
              "tmpls": [{"qfmt": "{{Front}}\\n{{type:Back}}"}]},
    }
    decks = {"1": {"name": "Default"}, "10": {"name": "Bio::Cells"}, "20": {"name": "Spanish"}}
    crt = int(datetime(2026, 1, 1, 4, tzinfo=TZ).timestamp())
    con.execute("INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')", (crt, json.dumps(models), json.dumps(decks)))
    sep = "\x1f"
    notes = [
        (1001, "g-basic", 1, " bio  cells ", f"What is the <b>powerhouse</b>?<br><img src=\"cell.png\">{sep}Mitochondrion&nbsp;[sound:say.mp3]"),
        (1002, "g-rev", 2, "vocab", f"perro{sep}dog"),
        (1003, "g-cloze", 3, "", f"{{{{c1::Ribosomes}}}} make {{{{c2::proteins}}}}<script>alert(1)</script>{sep}extra info"),
        (1004, "g-type", 4, "", f"Spell: thank you (fr){sep}merci"),
        (1005, "g-empty", 1, "", f"{sep}"),
        (1006, "g-evil", 1, "", f"<img src=\"../../etc/passwd\"> evil{sep}<img src='x.svg'>ok"),
    ]
    for nid, guid, mid, tags, flds in notes:
        con.execute("INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, '', 0, 0, '')", (nid, guid, mid, tags, flds))
    cards = [
        # id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses
        (2001, 1001, 10, 0, 2, 2, 0, 0, 2500, 3, 0),   # history below
        (2002, 1002, 20, 0, 0, 0, 1, 0, 0, 0, 0),
        (2003, 1002, 20, 1, 0, -1, 2, 0, 0, 0, 0),     # suspended (only one of two)
        (2004, 1003, 10, 0, 2, 2, 300, 20, 2300, 4, 1),  # review, no history → estimate
        (2005, 1003, 10, 1, 0, 0, 3, 0, 0, 0, 0),
        (2006, 1004, 20, 0, 0, -1, 4, 0, 0, 0, 0),     # suspended
        (2007, 1005, 1, 0, 0, 0, 5, 0, 0, 0, 0),
        (2008, 1006, 1, 0, 0, 0, 6, 0, 0, 0, 0),
    ]
    for cid, nid, did, ord_, typ, queue, due, ivl, factor, reps, lapses in cards:
        con.execute("INSERT INTO cards VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '')",
                    (cid, nid, did, ord_, typ, queue, due, ivl, factor, reps, lapses))
    if revlog:
        t0 = datetime(2026, 9, 1, 9, 0, tzinfo=TZ)
        for i, (days, ease, rtype) in enumerate([(0, 3, 0), (0.007, 3, 0), (3, 3, 1), (11, 1, 1), (11.01, 3, 2), (14, 3, 1)]):
            rid = int((t0 + timedelta(days=days)).timestamp() * 1000) + i
            con.execute("INSERT INTO revlog VALUES (?, 2001, 0, ?, 0, 0, 0, 6000, ?)", (rid, ease, rtype))
    con.commit()
    con.close()
    out = tmp_path / "deck.apkg"
    with zipfile.ZipFile(out, "w") as z:
        z.write(db, member)
        files = media if media is not None else {"0": ("cell.png", _png()), "1": ("say.mp3", b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64)}
        z.writestr("media", json.dumps({k: v[0] for k, v in files.items()}))
        for k, (_name, data) in files.items():
            z.writestr(k, data)
        for k, v in (extra or {}).items():
            z.writestr(k, v)
    return str(out)


def test_apkg_reads_notes_decks_tags_history_and_media_refs(tmp_path):
    from app.items.kinds.flashcards import apkg

    pkg = apkg.read_package(_apkg(tmp_path), {}, TZ)
    assert pkg.format == "anki2" and pkg.notes == 6
    by = {c["front"].split("\n")[0][:20]: c for c in pkg.cards}
    basic = next(c for c in pkg.cards if "powerhouse" in c["front"])
    assert basic["type"] == "basic" and basic["deck"] == "Bio::Cells" and basic["tags"] == ["bio", "cells"]
    assert "**powerhouse**" in basic["front"] and "<" not in basic["front"]
    assert "](anki-media:cell.png)" in basic["front"] and "![audio: say](anki-media:say.mp3)" in basic["back"]
    assert basic["back"].startswith("Mitochondrion")
    # History replayed through FSRS: graduated, a lapse, relearned, reviewed.
    s = basic["srs"][0]
    assert s["state"] == "review" and s["reps"] == 6 and s["lapses"] == 1 and s["stability"] > 0
    logs = [e for e in pkg.logs if e["c"] == basic["id"]]
    assert len(logs) == 6 and [e["r"] for e in logs] == [3, 3, 3, 1, 3, 3] and all(e["e"] >= 0 for e in logs)
    assert [e["s"] for e in logs][:3] == ["n", "l", "r"]
    rev = next(c for c in pkg.cards if c["front"] == "perro")
    assert rev["type"] == "reversed" and [x["k"] for x in rev["srs"]] == ["f", "r"] and rev["suspended"] is False
    cloze = next(c for c in pkg.cards if c["type"] == "cloze")
    assert cloze["front"] == "{{c1::Ribosomes}} make {{c2::proteins}}" and cloze["back"] == "extra info"
    assert "alert" not in cloze["front"]
    c1 = next(x for x in cloze["srs"] if x["k"] == "c1")
    assert c1["state"] == "review" and c1["stability"] == 20.0 and c1["due"].startswith("2026-10-28")  # crt + 300 days
    typein = next(c for c in pkg.cards if c["type"] == "typein")
    assert typein["back"] == "merci" and typein["suspended"] is True
    assert pkg.skipped == 1  # the empty note
    evil = next(c for c in pkg.cards if "evil" in c["front"])
    assert "passwd" not in evil["front"] and "anki-media" not in evil["front"]
    assert set(pkg.media_needed) == {"cell.png", "say.mp3", "x.svg"}
    assert pkg.media_map == {"cell.png": "0", "say.mp3": "1"}
    assert sorted(pkg.decks) == ["Bio::Cells", "Default", "Spanish"]
    # Card ids come from Anki's guids: the same package gives the same ids.
    again = apkg.read_package(_apkg(tmp_path), {}, TZ)
    assert [c["id"] for c in again.cards] == [c["id"] for c in pkg.cards]
    assert all(c["id"].startswith("a") and len(c["id"]) <= 40 for c in pkg.cards)
    # Every card is valid for the model.
    data = blank()
    data["decks"] = [{"id": "d", "name": "D"}]
    data["cards"] = [{**{k: v for k, v in c.items() if k != "deck"}, "deck_id": "d"} for c in pkg.cards]
    data["review_log"] = pkg.logs
    SPEC.validate(data)
    # Without history: everything starts new except the estimate-free ones.
    nohist = apkg.read_package(_apkg(tmp_path), {}, TZ, history=False)
    assert next(c for c in nohist.cards if "powerhouse" in c["front"])["srs"][0]["state"] == "review"  # Anki said review
    assert nohist.logs == [] and nohist.reviews_total == 0
    del by


def test_apkg_fill_media_and_refusals(tmp_path):
    import zipfile

    from app.items.kinds.flashcards import apkg

    txt = "a\n\n![cell](anki-media:cell.png)\n\nb ![audio: x](anki-media:my%20sound.mp3)"
    out = apkg.fill_media(txt, {"cell.png": "11111111-2222-3333-4444-555555555555"})
    assert "![cell](drive:11111111-2222-3333-4444-555555555555)" in out and "anki-media" not in out
    # Newer Anki format → a clear way out.
    p = tmp_path / "new.apkg"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("collection.anki21b", b"(\xb5/\xfd zstd")
        z.writestr("media", b"\x28\xb5\x2f\xfd")
    with pytest.raises(apkg.AnkiError, match="Support older Anki versions"):
        apkg.read_package(str(p), {}, TZ)
    bad = tmp_path / "bad.apkg"
    bad.write_bytes(b"not a zip")
    with pytest.raises(apkg.AnkiError, match="zip"):
        apkg.read_package(str(bad), {}, TZ)
    empty = tmp_path / "empty.apkg"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("readme.txt", "hi")
    with pytest.raises(apkg.AnkiError, match="No Anki collection"):
        apkg.read_package(str(empty), {}, TZ)
    # anki21 is preferred over the "please update" anki2 stub.
    path = _apkg(tmp_path, member="collection.anki21", extra={"collection.anki2": b"stub"})
    assert apkg.read_package(path, {}, TZ).format == "anki21"
    # A member bigger than allowed is refused (zip-bomb guard).
    old = apkg.MAX_COLLECTION_BYTES
    apkg.MAX_COLLECTION_BYTES = 1000
    try:
        with pytest.raises(apkg.AnkiError, match="too large"):
            apkg.read_package(_apkg(tmp_path), {}, TZ)
    finally:
        apkg.MAX_COLLECTION_BYTES = old


# ==================================================== end-to-end via the API


@pytest.fixture
async def client(db):
    import httpx

    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_api_flow(client, user):
    h = _auth(user)
    r = await client.post("/api/items/store/flashcards", headers=h)
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=h, json={"kind": "flashcards", "title": "Biology"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "Biology.cards" and item["data"]["cards"] == []
    r = await client.post(
        f"/api/items/{fid}/actions/add_cards", headers=h,
        json={"args": {"deck": "Cells", "cards": [
            {"front": "Powerhouse?", "back": "Mitochondrion"},
            {"type": "cloze", "front": "{{c1::DNA}} lives in the {{c2::nucleus}}"},
        ]}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 2 and "Added 2 cards" in r.json()["summary"]
    data = r.json()["data"]
    r = await client.post(f"/api/items/{fid}/actions/add_cards", headers=h, json={"args": {"deck": "Cells", "cards": [{"type": "cloze", "front": "bad"}]}})
    assert r.status_code == 400 and "cloze" in r.json()["detail"]
    r = await client.post(f"/api/items/{fid}/actions/due_summary", headers=h, json={})
    assert r.status_code == 200 and r.json()["result"]["total"]["new"] == 2
    # The Study tab saves a review straight into the data.
    card = data["cards"][0]
    now = datetime.now(ZoneInfo("UTC"))
    nxt, log = fsrs.review(card["srs"][0], fsrs.GOOD, now, fsrs.Config(), f"{card['id']}/f")
    card["srs"][0] = {k: v for k, v in nxt.items() if not k.startswith("_")}
    data["review_log"].append({"c": card["id"], "k": "f", "t": fsrs.iso(now), "d": 4200, **log})
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": data, "base_revision": 2})
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 3 and r.json()["data"]["cards"][0]["srs"][0]["state"] == "learning"
    r = await client.post(f"/api/items/{fid}/actions/deck_stats", headers=h, json={})
    assert r.json()["result"]["reviews_last_30d"] == 1
    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Mitochondrion" in row.content_text and "DNA lives in the nucleus" in row.content_text


async def test_apkg_import_endpoint(client, user, tmp_path):
    import re

    h = _auth(user)
    assert (await client.post("/api/items/store/flashcards", headers=h)).status_code == 200
    r = await client.post("/api/items", headers=h, json={"kind": "flashcards", "title": "From Anki"})
    fid = r.json()["file_id"]
    with open(_apkg(tmp_path), "rb") as f:
        raw = f.read()
    r = await client.post(f"/api/items/k/flashcards/{fid}/apkg", headers=h,
                          files={"file": ("deck.apkg", raw, "application/octet-stream")}, data={"media": "true", "history": "true"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["format"] == "anki2" and len(out["cards"]) == 5 and out["media"]["stored"] >= 1
    assert out["media"]["missing"] == 1  # x.svg isn't in the package (and wouldn't be allowed)
    basic = next(c for c in out["cards"] if "powerhouse" in c["front"])
    m = re.search(r"!\[cell\]\(drive:([0-9a-f-]{36})\)", basic["front"])
    assert m and "anki-media" not in json.dumps(out["cards"])
    assert len(out["logs"]) == 6 and out["history"]["reviews"] == 6
    from app.database import SessionLocal
    from app.files.models import FileFolder, UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(m.group(1)))
        assert row is not None and row.user_id == user.id and row.mime_type == "image/png"
        folder = await s.get(FileFolder, row.folder_id)
        assert folder.name == "Flashcards media" and folder.parent_id is None
    # The item file itself didn't change — the client adds the cards.
    r = await client.get(f"/api/items/{fid}", headers=h)
    item = r.json()
    assert item["data"]["cards"] == []
    data = item["data"]
    data["decks"] = [{"id": "imp", "name": "Imported"}]
    data["cards"] = [{**{k: v for k, v in c.items() if k != "deck"}, "deck_id": "imp"} for c in out["cards"]]
    data["review_log"] = out["logs"]
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": data, "base_revision": item["revision"]})
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["cards"]) == 5
    # Without media: the references go, the text stays.
    r = await client.post(f"/api/items/k/flashcards/{fid}/apkg", headers=h,
                          files={"file": ("deck.apkg", raw, "application/octet-stream")}, data={"media": "false"})
    plain = next(c for c in r.json()["cards"] if "powerhouse" in c["front"])
    assert "drive:" not in plain["front"] and "powerhouse" in plain["front"] and r.json()["media"]["stored"] == 0
    # Refusals: not a package, not an item you can edit.
    r = await client.post(f"/api/items/k/flashcards/{fid}/apkg", headers=h, files={"file": ("x.apkg", b"nope", "application/zip")})
    assert r.status_code == 400 and "zip" in r.json()["detail"]
    r = await client.post(f"/api/items/k/flashcards/{uuid.uuid4()}/apkg", headers=h, files={"file": ("x.apkg", raw, "application/zip")})
    assert r.status_code == 404


async def test_api_accepts_a_review_with_negative_elapsed(client, user):
    """The save path: a review whose previous one looked "ahead" (clock
    skew) saves instead of being refused."""
    h = _auth(user)
    await client.post("/api/items/store/flashcards", headers=h)
    r = await client.post("/api/items", headers=h, json={"kind": "flashcards", "title": "Skew"})
    item = r.json()
    data = item["data"]
    data["decks"] = [{"id": "d", "name": "D"}]
    data["cards"] = [{"id": "k1", "deck_id": "d", "front": "q", "back": "a"}]
    data["review_log"] = [{"c": "k1", "k": "f", "t": fsrs.iso(NOW), "r": 3, "s": "r", "e": -2, "i": 3, "d": 1200}]
    r = await client.put(f"/api/items/{item['file_id']}", headers=h, json={"data": data, "base_revision": item["revision"]})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["review_log"][0]["e"] == 0
