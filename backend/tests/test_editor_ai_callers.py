"""Every caller of ``editor_ai.complete`` passes ``user=``.

``user`` is keyword-only and required (it's how each assistant is told
today's date). Tests that fake ``complete`` with ``**kw`` can't notice a
caller that forgot it: Notes' Tidy up / Make a list / Make an event answered
500 from v0.40.0 until this was caught by the browser suite. This reads the
code instead, so no fake can hide it.
"""
from __future__ import annotations

import ast
import pathlib

APP = pathlib.Path(__file__).resolve().parent.parent / "app"


def _calls_without_user() -> list[str]:
    missing: list[str] = []
    for path in APP.rglob("*.py"):
        src = path.read_text(encoding="utf-8")
        if "editor_ai" not in src and path.name != "editor_ai.py":
            continue
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""
            words = {k.arg for k in node.keywords}
            # editor_ai.complete is the one called with system= and messages=.
            if name == "complete" and {"system", "messages"} <= words and "user" not in words:
                missing.append(f"{path.relative_to(APP)}:{node.lineno}")
    return missing


def test_every_completion_says_who_is_asking():
    assert _calls_without_user() == []
