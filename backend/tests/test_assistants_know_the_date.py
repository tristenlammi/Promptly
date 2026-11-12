"""Every app's assistant knows today's date and time, as chat does: so
"tomorrow" is counted from today, not guessed from the newest email."""
from __future__ import annotations

import ast
import pathlib
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

APP = pathlib.Path(__file__).resolve().parent.parent / "app"


def test_the_line_has_the_weekday_date_and_time_in_your_zone():
    from app.chat.personal_context import now_line

    line = now_line(SimpleNamespace(settings={"timezone": "Australia/Brisbane"}))
    now = datetime.now(ZoneInfo("Australia/Brisbane"))
    assert now.strftime("%A") in line and now.strftime("%B %Y") in line
    assert "Australia/Brisbane" in line and ("AM" in line or "PM" in line)


@pytest.mark.parametrize("settings", [None, {}, {"timezone": "Not/AZone"}])
def test_without_a_time_zone_it_is_utc(settings):
    from app.chat.personal_context import now_line

    who = None if settings is None else SimpleNamespace(settings=settings)
    assert "UTC" in now_line(who)


async def test_the_shared_helper_tells_the_model_the_date(monkeypatch):
    import app.files.editor_ai as ea
    from app.models_config import provider as prov

    seen: dict = {}

    async def stream_chat(**kw):
        seen["system"] = kw["system"]
        yield "ok"

    monkeypatch.setattr(prov.model_router, "stream_chat", stream_chat)
    out = await ea.complete(object(), "m", system="Be brief.", messages=[], user=SimpleNamespace(settings={"timezone": "Australia/Brisbane"}))
    assert out == "ok"
    assert seen["system"].startswith("Be brief.")
    assert datetime.now(ZoneInfo("Australia/Brisbane")).strftime("%A") in seen["system"]


async def test_the_helper_cant_be_called_without_saying_for_whom():
    import app.files.editor_ai as ea

    with pytest.raises(TypeError):
        await ea.complete(object(), "m", system="x", messages=[])  # type: ignore[call-arg]


def _calls_to_complete(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "complete":
            yield node
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "complete" \
                and isinstance(node.func.value, ast.Name) and node.func.value.id in {"editor_ai", "ea"}:
            yield node


def test_no_assistant_leaves_out_the_date():
    """Every place that calls the shared helper names the user (``user=``), so
    it can't be added without the date. (The people helper also called
    ``complete`` takes no ``system`` and isn't a model call.)"""
    missing = []
    for path in APP.rglob("*.py"):
        src = path.read_text(encoding="utf-8")
        if "editor_ai" not in src and path.name != "editor_ai.py":
            continue
        for call in _calls_to_complete(ast.parse(src)):
            names = {k.arg for k in call.keywords}
            if "system" in names and "user" not in names:
                missing.append(f"{path.relative_to(APP)}:{call.lineno}")
    assert missing == []
