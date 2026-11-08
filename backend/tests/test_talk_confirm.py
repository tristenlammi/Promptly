"""The one spoken yes/no matcher (WP-T3, ``app/talk/confirm.py``): a port of
the web overlay's ``spokenConfirm.ts`` (R-131), used by Talk and by the
phone's ``/api/assistant``. The safe reading of anything unclear is no."""
from __future__ import annotations

import pytest

from app.talk.confirm import answer, is_bare_no, is_yes, normalise_answer

# The overlay's own table (e2e/tests/unit-spoken-confirm.spec.ts).
YES = ["Yes", "yes please", "Yeah.", "OK", "Okay, do it", "Sure!", "Go ahead", "go for it", "Confirm"]
NOT_YES = [
    "Okay, cancel that.",
    "OK no, stop",
    "Sure, wait no",
    "Do it later",
    "Confirm? No.",
    "Yesterday I said no",
    "yes, hold on",
    "don't",
    "Please",
    "it",
    "",
    "open the garage",
]


@pytest.mark.parametrize("said", YES)
def test_a_clear_yes_runs_it(said):
    assert is_yes(said) and answer(said) == "yes"


@pytest.mark.parametrize("said", NOT_YES)
def test_anything_less_doesnt(said):
    assert not is_yes(said)


@pytest.mark.parametrize("said", ["No.", "nope", "No thanks", "no, thank you", "Nah, never mind", "don't", "Cancel that", "not now", "Okay, cancel that.", "Don't do it", "Stop.", "Do it later"])
def test_a_bare_no(said):
    assert is_bare_no(said) and answer(said) == "no"


@pytest.mark.parametrize("said", ["No, Friday", "no, I meant the garage", "Sure, wait no", "Yesterday I said no", "make it ten", "", "Yes", "no no no no no no"])
def test_a_no_with_more_to_say_isnt_bare(said):
    assert not is_bare_no(said)


@pytest.mark.parametrize("said", ["No, Friday", "Sure, wait no", "what's the weather", "yes, hold on"])
def test_neither_goes_to_the_model(said):
    assert answer(said) is None


def test_normalising():
    assert normalise_answer("  Don’t — DO it!! ") == "dont do it"
    assert normalise_answer("Café, sí") == "cafe si"


@pytest.mark.parametrize(
    ("said", "wanted"),
    [
        ("Yes.", {"do": "confirm"}),
        ("okay, do it", {"do": "confirm"}),  # the old regex sent this to the model
        ("No thanks", {"do": "cancel"}),
        ("nope, never mind", {"do": "cancel"}),  # so did this
        ("Sure, wait no", None),
        ("yes, hold on", None),
        ("Do it later", {"do": "cancel"}),  # not now is a no
    ],
)
def test_the_phone_assistant_uses_the_same_matcher(said, wanted):
    from app.maps import assistant

    pending = {"tool": "calendar_add_event", "args": {"title": "X", "start": "2026-11-20"}, "question": "Add X?"}
    assert assistant._plainly(said, assistant.DriveState(pending=pending)) == wanted
    # Nothing waiting: never a yes or a no.
    assert assistant._plainly(said, assistant.DriveState()) is None
