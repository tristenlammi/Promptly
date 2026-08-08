"""Resolving board columns for the AI's read/write tools.

The bug this closes was quiet and destructive. Cards store a column *id*;
the AI reads a board as flattened text grouped under column *names*. On a
board with custom columns the two never met:

* ``query_board_cards(status="In Review")`` matched nothing and reported
  ``0 card(s) match`` — a wrong count stated as fact.
* ``propose_board_updates(set={"status": "done"})`` wrote a status no column
  owned, so the card wasn't complete and the board UI dropped it into the
  *first* column. The user asked to finish work and watched it move to the
  backlog, under a proposal marked "Applied".

So the cases worth pinning are: names resolve, ids resolve, aliases resolve,
exact matches beat aliases, and an unknown token returns None (the caller
turns that into a retryable error listing the real columns) rather than
silently matching nothing.
"""
from __future__ import annotations

from app.workspaces.board_columns import (
    board_columns,
    column_labels,
    done_status_ids,
    resolve_status,
)

CUSTOM = {
    "columns": [
        {"id": "c_ab12cd3", "name": "In Review"},
        {"id": "c_ff99xx1", "name": "Shipped", "done": True},
        {"id": "todo", "name": "Inbox"},
    ]
}

DEFAULT = {}


def test_default_board_falls_back_to_the_builtin_three():
    assert board_columns(DEFAULT) == [
        ("todo", "To Do"),
        ("doing", "In Progress"),
        ("done", "Done"),
    ]


def test_default_board_resolves_aliases():
    assert resolve_status(DEFAULT, "in progress") == "doing"
    assert resolve_status(DEFAULT, "complete") == "done"
    assert resolve_status(DEFAULT, "backlog") == "todo"


def test_custom_column_resolves_by_display_name():
    """The name is what the model sees in the flattened board text, and what
    a user says out loud. This is the case that used to silently fail."""
    assert resolve_status(CUSTOM, "In Review") == "c_ab12cd3"
    assert resolve_status(CUSTOM, "in review") == "c_ab12cd3"


def test_custom_column_resolves_by_id():
    assert resolve_status(CUSTOM, "c_ff99xx1") == "c_ff99xx1"


def test_exact_name_beats_alias():
    """A column literally named "Inbox" carrying the built-in ``todo`` id
    must still resolve from either handle, and a name match must never be
    overridden by the alias table."""
    assert resolve_status(CUSTOM, "Inbox") == "todo"
    assert resolve_status(CUSTOM, "todo") == "todo"


def test_alias_maps_onto_a_matching_builtin_id():
    """"backlog" isn't a name on this board, but the ``todo`` column is."""
    assert resolve_status(CUSTOM, "backlog") == "todo"


def test_unknown_column_returns_none_not_a_silent_miss():
    """The caller turns None into an error naming the valid columns. The old
    behaviour — falling through to a literal comparison — produced a
    confident "0 cards match"."""
    assert resolve_status(CUSTOM, "Doing") is None
    assert resolve_status(CUSTOM, "nonsense") is None


def test_empty_token_resolves_to_nothing():
    assert resolve_status(CUSTOM, "") is None
    assert resolve_status(CUSTOM, "   ") is None


def test_labels_are_the_display_names():
    assert column_labels(CUSTOM) == ["In Review", "Shipped", "Inbox"]


def test_done_ids_prefer_the_explicit_flag():
    """A board can flag any column as terminal; ``Shipped`` is this board's
    done state, and nothing here is called "done"."""
    assert done_status_ids(CUSTOM) == ["c_ff99xx1"]


def test_done_ids_default_to_the_builtin():
    assert done_status_ids(DEFAULT) == ["done"]


def test_malformed_config_does_not_explode():
    """Config is JSONB written by the frontend — treat it as untrusted."""
    for bad in (None, {"columns": None}, {"columns": []}, {"columns": ["x"]},
                {"columns": [{"name": "no id"}]}):
        assert board_columns(bad) == [
            ("todo", "To Do"),
            ("doing", "In Progress"),
            ("done", "Done"),
        ]
        assert resolve_status(bad, "done") == "done"
