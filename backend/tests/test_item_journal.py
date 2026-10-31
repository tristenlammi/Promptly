"""Journal item: model, template, every action, text, reminders, tools, the
API flow and an AI turn."""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.journal import SPEC
from app.items.kinds.journal.logic import reminders, streaks, to_text
from app.items.kinds.journal.models import MAX_BODY, JournalData
from app.items.service import run_action
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 19, 30, tzinfo=TZ)  # a Saturday


def _ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def _fresh() -> dict:
    return SPEC.validate(SPEC.template(_ctx()))


def _e(id_, day, mood=None, body="", **kw):
    return {"id": id_, "date": day, "time": kw.pop("time", "20:00"), "body": body, "mood": mood, **kw}


def _data(*entries, **settings) -> dict:
    d = _fresh()
    d["entries"] = list(entries)
    d["settings"].update(settings)
    return SPEC.validate(d)


async def _act(data, name, args, now=NOW):
    return await run_action(_ctx(now), SPEC, data, name, args)


# ------------------------------------------------------------------ model


def test_template_has_builtin_templates_and_validates():
    d = _fresh()
    ids = {t["id"] for t in d["templates"]}
    assert {"morning-pages", "gratitude", "daily-review", "weekly-reflection", "evening", "thought-record", "self-compassion"} <= ids
    assert all(t["builtin"] for t in d["templates"])
    assert d["settings"]["onboarded"] is False and d["settings"]["reminder_time"] == "21:00"
    cbt = next(t for t in d["templates"] if t["id"] == "thought-record")
    assert "Evidence for" in cbt["body"] and "Balanced thought" in cbt["body"]
    assert next(t for t in d["templates"] if t["id"] == "gratitude")["gratitude_slots"] == 3
    # Old / empty files still load.
    assert JournalData.model_validate({}).model_dump()["entries"] == []


def test_entry_is_normalised_and_bounded():
    d = _data(_e("a", "2026-10-30", 4, "Hello there world", tags=["#Work", "work", "Deep Focus"], emotions=["Calm ", "calm"], gratitude=["  tea ", ""]))
    e = d["entries"][0]
    assert e["tags"] == ["work", "deep-focus"] and e["emotions"] == ["calm"] and e["gratitude"] == ["tea"]
    assert e["word_count"] == 4  # body 3 + gratitude 1 — recomputed, whoever wrote it
    with pytest.raises(ValidationError):
        SPEC.validate({"entries": [_e("a", "30/10/2026")]})
    with pytest.raises(ValidationError):
        SPEC.validate({"entries": [_e("a", "2026-10-30", mood=7)]})
    with pytest.raises(ValidationError):
        SPEC.validate({"entries": [_e("a", "2026-10-30", body="x" * (MAX_BODY + 1))]})
    with pytest.raises(ValidationError):
        SPEC.validate({"entries": [_e("a", "2026-10-30", time="25:00")]})
    assert SPEC.max_bytes == 8 * 1024 * 1024 and MAX_BODY == 100_000
    assert SPEC.chat_raw is False and SPEC.archive is not None
    # A new journal doesn't share excerpts; an older file keeps what it stored.
    assert _fresh()["settings"]["share_excerpts"] is False
    assert SPEC.validate({"settings": {"share_excerpts": True}})["settings"]["share_excerpts"] is True


# ---------------------------------------------------------------- add_entry


async def test_add_entry_only_when_the_person_asked_and_is_marked_ai_drafted():
    d = _fresh()
    with pytest.raises(ActionError, match="explicitly ask"):
        await _act(d, "add_entry", {"person_asked": False, "body": "Today was fine."})
    assert d["entries"] == []
    out = await _act(d, "add_entry", {"person_asked": True, "title": "A good walk", "body": "Walked by the river.", "mood": 4, "tags": ["#Outside"]})
    e = d["entries"][0]
    assert e["ai_drafted"] is True and e["date"] == "2026-10-31" and e["time"] == "19:30"
    assert e["tags"] == ["#Outside"]  # normalised on save
    assert SPEC.validate(d)["entries"][0]["tags"] == ["outside"]
    assert out.result["id"] == e["id"] and "AI-drafted" in out.summary
    # Deterministic: the same call at the same moment makes the same id.
    d2 = _fresh()
    out2 = await _act(d2, "add_entry", {"person_asked": True, "title": "A good walk", "body": "Walked by the river.", "mood": 4, "tags": ["#Outside"]})
    assert out2.result["id"] == out.result["id"]
    # Same again on the same file: a different, unique id.
    out3 = await _act(d, "add_entry", {"person_asked": True, "title": "A good walk", "body": "Walked by the river.", "mood": 4, "tags": ["#Outside"]})
    assert out3.result["id"] != out.result["id"]


async def test_add_entry_from_a_template_and_refusals():
    d = _fresh()
    await _act(d, "add_entry", {"person_asked": True, "template_id": "daily-review", "date": "2026-10-29", "time": "08:15"})
    e = d["entries"][0]
    assert "## Wins" in e["body"] and "review" in e["tags"] and e["template_id"] == "daily-review" and e["prompt"]
    with pytest.raises(ActionError, match="no template"):
        await _act(d, "add_entry", {"person_asked": True, "template_id": "nope", "body": "x"})
    with pytest.raises(ActionError, match="needs a title"):
        await _act(d, "add_entry", {"person_asked": True, "body": "   "})
    with pytest.raises(ActionError, match="Bad arguments"):
        await _act(d, "add_entry", {"person_asked": True, "body": "x", "mood": 9})


# --------------------------------------------------------------- edit / delete


async def test_edit_entry_sets_appends_and_clears():
    d = _data(_e("a", "2026-10-30", 2, "First line.", energy=2, tags=["work"]))
    out = await _act(d, "edit_entry", {"id": "a", "mood": 3, "starred": True})
    assert "mood" in out.summary
    assert d["entries"][0]["ai_edited"] is False  # metadata only: not a text edit
    out = await _act(d, "edit_entry", {"id": "a", "append": "Later: felt better.", "person_asked": True})
    e = d["entries"][0]
    assert e["mood"] == 3 and e["starred"] and e["body"] == "First line.\n\nLater: felt better."
    assert "body" in out.summary and e["updated_at"].startswith("2026-10-31")
    assert e["ai_edited"] is True and SPEC.validate(d)["entries"][0]["ai_edited"] is True
    await _act(d, "edit_entry", {"id": "a", "energy": None, "tags": ["Family"]})
    assert d["entries"][0]["energy"] is None and d["entries"][0]["tags"] == ["Family"]
    assert d["entries"][0]["mood"] == 3  # untouched
    with pytest.raises(ActionError, match="no entry"):
        await _act(d, "edit_entry", {"id": "zzz", "mood": 1})
    with pytest.raises(ActionError, match="Nothing to change"):
        await _act(d, "edit_entry", {"id": "a"})
    with pytest.raises(ActionError, match="longer than"):
        await _act(d, "edit_entry", {"id": "a", "append": "y" * MAX_BODY, "person_asked": True})


async def test_edit_entry_text_needs_person_asked():
    d = _data(_e("a", "2026-10-30", 2, "My own words."))
    for args in ({"body": "Rewritten"}, {"append": "More"}, {"body": "Rewritten", "person_asked": False}):
        with pytest.raises(ActionError, match="person_asked"):
            await _act(d, "edit_entry", {"id": "a", **args})
    assert d["entries"][0]["body"] == "My own words." and not d["entries"][0].get("ai_edited")
    await _act(d, "edit_entry", {"id": "a", "body": "Rewritten as asked.", "person_asked": True})
    assert d["entries"][0]["body"] == "Rewritten as asked." and d["entries"][0]["ai_edited"] is True
    # The panel sees the label when it searches.
    r = await _act(d, "search_entries", {"query": "rewritten"})
    assert r.result["entries"][0]["ai_edited"] is True


async def test_delete_entries():
    d = _data(_e("a", "2026-10-30", body="a"), _e("b", "2026-10-29", body="b"), _e("c", "2026-10-28", body="c"))
    out = await _act(d, "delete_entries", {"ids": ["a", "c", "ghost"]})
    assert [e["id"] for e in d["entries"]] == ["b"]
    assert out.result == {"deleted": ["a", "c"], "not_found": ["ghost"]} and "2 entries" in out.summary
    with pytest.raises(ActionError, match="None of those"):
        await _act(d, "delete_entries", {"ids": ["ghost"]})
    with pytest.raises(ActionError):
        await _act(d, "delete_entries", {"ids": []})


# ------------------------------------------------------------------- tagging


async def test_tag_entries_by_query_ids_and_range():
    d = _data(
        _e("a", "2026-10-30", body="Dinner with my sister Ana", tags=["food"]),
        _e("b", "2026-10-20", body="Ana's wedding planning"),
        _e("c", "2026-09-01", body="Work offsite"),
    )
    out = await _act(d, "tag_entries", {"query": "ana", "add": ["#Family"], "remove": ["food"]})
    tags = {e["id"]: e["tags"] for e in d["entries"]}
    assert tags == {"a": ["family"], "b": ["family"], "c": []} and out.result == {"changed": 2}
    await _act(d, "tag_entries", {"ids": ["c"], "add": ["work"]})
    assert d["entries"][2]["tags"] == ["work"]
    await _act(d, "tag_entries", {"range": {"start": "2026-10-01", "end": "2026-10-31"}, "add": ["october"]})
    assert [("october" in e["tags"]) for e in d["entries"]] == [True, True, False]
    with pytest.raises(ActionError, match="No entries matched"):
        await _act(d, "tag_entries", {"query": "ana", "add": ["family"]})  # already there
    with pytest.raises(ActionError, match="Pick the entries"):
        await _act(d, "tag_entries", {"add": ["x"]})
    with pytest.raises(ActionError, match="which tags"):
        await _act(d, "tag_entries", {"ids": ["a"]})


# ------------------------------------------------------------ templates/settings


async def test_add_template():
    d = _fresh()
    out = await _act(d, "add_template", {"name": "Daily review", "body": "## Energy\n", "prompts": ["What drained me?"], "gratitude_slots": 2})
    assert out.result["id"] == "daily-review-2"  # the built-in keeps its id
    t = SPEC.validate(d)["templates"][-1]
    assert t["builtin"] is False and t["gratitude_slots"] == 2 and t["prompts"] == ["What drained me?"]
    with pytest.raises(ActionError, match="Bad arguments"):
        await _act(d, "add_template", {"name": ""})


async def test_set_settings():
    d = _fresh()
    out = await _act(d, "set_settings", {"daily_reminder": True, "reminder_time": "20:30", "add_prompts": ["What surprised me?"], "onboarded": True})
    s = d["settings"]
    assert s["daily_reminder"] and s["reminder_time"] == "20:30" and s["custom_prompts"] == ["What surprised me?"] and s["onboarded"]
    assert "daily reminder" in out.summary
    await _act(d, "set_settings", {"default_template_id": "evening"})
    assert d["settings"]["default_template_id"] == "evening"
    await _act(d, "set_settings", {"default_template_id": None})
    assert d["settings"]["default_template_id"] is None
    with pytest.raises(ActionError, match="no template"):
        await _act(d, "set_settings", {"default_template_id": "nope"})
    with pytest.raises(ActionError, match="Nothing to change"):
        await _act(d, "set_settings", {})
    with pytest.raises(ActionError, match="Bad arguments"):
        await _act(d, "set_settings", {"reminder_time": "9pm"})


# ----------------------------------------------------------------- read-only


def _history() -> dict:
    return _data(
        _e("a", "2026-10-31", 4, "Lovely run along the beach, felt calm after.", emotions=["calm", "proud"], tags=["run"], energy=4),
        _e("b", "2026-10-30", 2, "Rough day at work, anxious about the deadline.", emotions=["anxious", "stressed"], tags=["work"], energy=2),
        _e("c", "2026-10-29", 3, "Ordinary Thursday. Some work, some reading.", emotions=["content"], tags=["work"]),
        _e("d", "2026-10-28", 5, "Ana visited! Long dinner, so much laughing.", emotions=["happy", "loved"], tags=["family"], starred=True),
        _e("e", "2025-10-31", 3, "Halloween last year — quiet night in.", tags=["family"]),
        _e("f", "2024-10-31", 4, "Halloween two years ago, party at Sam's.", emotions=["excited"]),
    )


async def test_search_entries_with_filters():
    d = _history()
    r = (await _act(d, "search_entries", {"query": "work"})).result
    assert [e["id"] for e in r["entries"]] == ["b", "c"] and r["total"] == 2
    r = (await _act(d, "search_entries", {"query": "halloween night"})).result
    assert [e["id"] for e in r["entries"]] == ["e"]
    r = (await _act(d, "search_entries", {"mood_min": 4})).result
    assert [e["id"] for e in r["entries"]] == ["a", "d", "f"]
    r = (await _act(d, "search_entries", {"tags": ["#Family"], "range": {"days": 30}})).result
    assert [e["id"] for e in r["entries"]] == ["d"]
    r = (await _act(d, "search_entries", {"starred": True})).result
    assert [e["id"] for e in r["entries"]] == ["d"] and r["entries"][0]["starred"] is True
    r = (await _act(d, "search_entries", {"emotions": ["anxious"]})).result
    assert r["entries"][0]["mood"] == "2 Low"
    r = (await _act(d, "search_entries", {"query": "unicorns"})).result
    assert r["total"] == 0 and "Nothing matched" in r["hint"]
    assert (await _act(d, "search_entries", {"limit": 2})).result["shown"] == 2
    full = (await _act(d, "read_entry", {"id": "d"})).result
    assert full["body"].startswith("Ana visited")
    with pytest.raises(ActionError):
        await _act(d, "read_entry", {"id": "nope"})


async def test_mood_summary():
    r = (await _act(_history(), "mood_summary", {})).result  # last 30 days
    assert r["start"] == "2026-10-02" and r["end"] == "2026-10-31"
    assert r["entries"] == 4 and r["avg_mood"] == 3.5 and r["avg_energy"] == 3.0
    assert r["mood_distribution"] == {"Awful": 0, "Low": 1, "Okay": 1, "Good": 1, "Great": 1}
    assert r["best_days"][0] == "2026-10-28" and r["hardest_days"][0] == "2026-10-30"
    assert r["mood_by_weekday"]["Fri"] == 2 and r["mood_by_weekday"]["Sat"] == 4
    assert r["emotion_families"]["anxious"] == 2 and r["top_tags"]["work"] == 2
    assert len(r["daily_mood"]) == 4
    r = (await _act(_history(), "mood_summary", {"range": {"start": "2020-01-01"}})).result
    assert r["entries"] == 6


async def test_on_this_day():
    r = (await _act(_history(), "on_this_day", {})).result
    assert [(e["id"], e["years_ago"]) for e in r["entries"]] == [("e", 1), ("f", 2)]
    r = (await _act(_history(), "on_this_day", {"date": "2026-03-03"})).result
    assert r["entries"] == [] and "No entries" in r["note"]


async def test_reflection_data_is_bounded_and_grounded():
    d = _history()
    d["entries"].append(_e("g", "2026-10-27", 3, "word " * 4000, gratitude=["sunshine"]))
    d = SPEC.validate(d)
    r = (await _act(d, "reflection_data", {})).result
    assert r["start"] == "2026-10-25" and r["days_with_entries"] == 5
    assert [e["id"] for e in r["entries"]] == ["g", "d", "c", "b", "a"]  # oldest first
    assert len(json.dumps(r)) < 20_000
    assert r["gratitude"] == ["sunshine"] and r["starred"] == ["d"] and r["stats"]["entries"] == 5
    assert "invent" in r["note"]
    r = (await _act(d, "reflection_data", {"range": {"days": 3}, "include_text": False})).result
    assert all("text" not in e for e in r["entries"]) and len(r["entries"]) == 3


async def test_streak_info_and_streak_rules():
    r = (await _act(_history(), "streak_info", {})).result
    assert r["current"] == 4 and r["wrote_today"] and r["total_entries"] == 6
    assert r["entries_this_week"] == 4  # Mon 26 Oct – Sat 31 Oct
    assert r["entries_by_year"] == {"2024": 1, "2025": 1, "2026": 4}
    # Not written today yet: yesterday's run still counts.
    s = streaks([{"date": "2026-10-30"}, {"date": "2026-10-29"}, {"date": "2026-10-20"}], NOW.date())
    assert s["current"] == 2 and not s["wrote_today"] and s["longest"] == 2
    s = streaks([{"date": "2026-10-28"}], NOW.date())
    assert s["current"] == 0 and s["longest"] == 1
    assert streaks([], NOW.date())["current"] == 0


async def test_correlate_mood():
    entries = [_e(f"x{i}", f"2026-10-{i:02d}", 1 + (i % 5), body="x") for i in range(1, 21)]
    d = _data(*entries)
    # Sleep the night before mirrors the next day's mood.
    values = [{"date": f"2026-10-{i - 1:02d}" if i > 1 else "2026-09-30", "value": 5 + (i % 5)} for i in range(1, 21)]
    r = (await _act(d, "correlate_mood", {"label": "sleep hours", "values": values, "lag_days": 1})).result
    assert r["days_compared"] == 20 and r["pearson_r"] == 1.0 and "strong positive" in r["reading"]
    assert r["avg_mood_when_at_or_above_median"] > r["avg_mood_when_below_median"] and "causation" in r["caveat"]
    with pytest.raises(ActionError, match="not enough"):
        await _act(d, "correlate_mood", {"label": "steps", "values": [{"date": "2026-10-01", "value": 1}]})


# ------------------------------------------------------------------- to_text


def test_to_text_is_a_modest_outline():
    d = _history()
    # Default (a new journal): an outline only — no words from any entry.
    private = to_text(d)
    for word in ("beach", "deadline", "laughing", "Halloween", "reading"):
        assert word not in private
    assert "#run" in private and "mood 4 Good (calm, proud)" in private and "only the journal's own assistant" in private
    d["settings"]["share_excerpts"] = True
    text = to_text(d)
    assert "6 entries" in text and "#work" in text and "“" not in text.split("Recent")[0]
    assert "mood 4 Good (calm, proud)" in text and "Lovely run" in text and "★" in text
    # Long bodies are never dumped.
    big = _data(*[_e(f"z{i}", f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}", 3, "secret " * 2000) for i in range(300)], share_excerpts=True)
    out = to_text(big)
    assert len(out) <= 20_000 and "older entries" in out
    assert to_text(_fresh()).startswith("A private journal")


# ----------------------------------------------------------------- reminders


def test_daily_reminders_skip_days_already_written_and_past_times():
    d = _data(_e("a", "2026-10-31", body="done"), daily_reminder=True, reminder_time="21:00")
    rs = reminders(d, _ctx())
    keys = [r.key for r in rs]
    assert "journal:daily:2026-10-31" not in keys  # already written today
    assert keys[0] == "journal:daily:2026-11-01" and len(keys) == 7
    assert rs[0].due_at == datetime(2026, 11, 1, 21, 0, tzinfo=TZ)
    # Nothing written today, before the time: today's reminder is there.
    d2 = _data(daily_reminder=True, reminder_time="21:00")
    assert reminders(d2, _ctx())[0].key == "journal:daily:2026-10-31"
    # After the time: not sent late.
    late = datetime(2026, 10, 31, 22, 0, tzinfo=TZ)
    assert reminders(d2, _ctx(late))[0].key == "journal:daily:2026-11-01"
    assert reminders(_data(), _ctx()) == []


def test_weekly_reflection_reminder():
    d = _data(weekly_reminder=True, weekly_day=6, weekly_time="18:00")  # Sundays
    rs = reminders(d, _ctx())
    assert [r.key for r in rs] == ["journal:weekly:2026-11-01"] and "reflection" in rs[0].title.lower()


def test_weekly_reminder_skips_a_week_already_reflected_on():
    base = {"weekly_reminder": True, "weekly_day": 6, "weekly_time": "18:00"}
    # Written on Friday from the weekly template: Sunday's nudge is skipped.
    d = _data(_e("w", "2026-10-30", body="My week", template_id="weekly-reflection"), **base)
    assert reminders(d, _ctx()) == []
    # Tagged #weekly counts too; an ordinary entry doesn't.
    assert reminders(_data(_e("w", "2026-10-31", body="x", tags=["weekly"]), **base), _ctx()) == []
    assert [r.key for r in reminders(_data(_e("o", "2026-10-31", body="x"), **base), _ctx())] == ["journal:weekly:2026-11-01"]
    # A reflection more than a week before the reminder day doesn't count.
    old = _data(_e("w", "2026-10-25", body="x", template_id="weekly-reflection"), **base)
    assert [r.key for r in reminders(old, _ctx())] == ["journal:weekly:2026-11-01"]


def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = _data(_e("a", "2026-10-29", 3, "x"), _e("b", "2026-10-30", 3, "x"))
    tok = _TEXT_NOW.set(datetime(2026, 10, 31, 9, 0, tzinfo=TZ))
    try:
        assert "Streak 2 day(s)" in to_text(d)  # yesterday counts until today ends
    finally:
        _TEXT_NOW.reset(tok)
    tok = _TEXT_NOW.set(datetime(2026, 11, 2, 9, 0, tzinfo=TZ))
    try:
        assert "Streak 0 day(s)" in to_text(d)  # days missed: the streak is over
    finally:
        _TEXT_NOW.reset(tok)


# ------------------------------------------------------------------ archive


def test_archive_moves_older_entries_and_keeps_templates_and_settings():
    d = _history()
    d["settings"].update({"daily_reminder": True, "weekly_reminder": True, "onboarded": True})
    d["templates"].append({"id": "mine", "name": "Mine"})
    d = SPEC.validate(d)
    kept, archived = SPEC.archive(copy.deepcopy(d), _ctx(), "2026-01-01")
    kept, archived = SPEC.validate(kept), SPEC.validate(archived)
    assert sorted(e["id"] for e in kept["entries"]) == ["a", "b", "c", "d"]
    assert sorted(e["id"] for e in archived["entries"]) == ["e", "f"]
    assert {t["id"] for t in archived["templates"]} == {t["id"] for t in kept["templates"]}
    assert "mine" in {t["id"] for t in archived["templates"]}
    assert kept["settings"]["daily_reminder"] is True  # the live journal keeps reminding
    assert archived["settings"]["daily_reminder"] is False and archived["settings"]["weekly_reminder"] is False
    assert archived["settings"]["onboarded"] is True
    with pytest.raises(ActionError, match="no entries before"):
        SPEC.archive(copy.deepcopy(d), _ctx(), "2000-01-01")
    with pytest.raises(ActionError):
        SPEC.archive(copy.deepcopy(d), _ctx(), "01/01/2026")


# --------------------------------------------------------------------- tools


def test_tools_have_no_refs_and_readers_only_get_reads():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names and "read_other_item" in names
    assert "$ref" not in json.dumps(tools)
    other = next(t for t in tools if t["function"]["name"] == "read_other_item")
    assert other["function"]["parameters"]["properties"]["kind"]["enum"] == ["habits", "health"]
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "add_entry" not in ro and {"search_entries", "mood_summary", "reflection_data", "streak_info", "on_this_day"} <= ro
    assert "Lifeline" in SPEC.ai_brief and "13 11 14" in SPEC.ai_brief and len(SPEC.ai_suggestions) >= 4
    for n in ("988", "116 123", "1737", "local emergency number"):
        assert n in SPEC.ai_brief
    assert "update_data" in SPEC.ai_brief  # never used to write entry text


def test_normal_chats_only_get_outline_actions():
    chat = {a.name for a in SPEC.actions if a.chat}
    hidden = {a.name for a in SPEC.actions if not a.chat}
    # Everything that returns an entry's words stays in the journal's panel.
    assert hidden == {"read_entry", "search_entries", "reflection_data", "on_this_day"}
    assert {"add_entry", "edit_entry", "mood_summary", "streak_info"} <= chat


# ---------------------------------------------------------------- API flow


@pytest.fixture
async def client(db):
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


async def _new(client, user):
    r = await client.post("/api/items/store/journal", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "journal", "title": "My journal"})
    assert r.status_code == 201, r.text
    return r.json()


async def test_api_flow(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    assert item["filename"] == "My journal.journal" and len(item["data"]["templates"]) == 7
    r = await client.post(
        f"/api/items/{fid}/actions/add_entry",
        headers=_auth(user),
        json={"args": {"person_asked": True, "title": "Drafted", "body": "From our chat.", "mood": 4}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 2 and body["data"]["entries"][0]["ai_drafted"] is True
    r = await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"person_asked": False, "body": "x"}})
    assert r.status_code == 400
    # The UI writes entries directly.
    data = copy.deepcopy(body["data"])
    data["entries"].append({"id": "ui1", "date": "2026-10-30", "time": "07:05", "body": "Morning pages here", "mood": 3, "tags": ["Morning"]})
    data["settings"]["onboarded"] = True
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": 2})
    assert r.status_code == 200, r.text
    saved = r.json()["data"]["entries"][1]
    assert saved["word_count"] == 3 and saved["tags"] == ["morning"]
    r = await client.post(f"/api/items/{fid}/actions/search_entries", headers=_auth(user), json={"args": {"query": "morning"}})
    assert r.status_code == 200 and r.json()["result"]["entries"][0]["id"] == "ui1" and r.json()["revision"] == 3
    r = await client.post(f"/api/items/{fid}/actions/streak_info", headers=_auth(user), json={})
    assert r.status_code == 200 and r.json()["result"]["total_entries"] == 2
    # Search text is the modest outline.
    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Private journal: 2 entries" in row.content_text


async def test_reminder_rows_follow_settings(client, db, user):
    from sqlalchemy import select

    from app.items.models import ItemReminder

    item = await _new(client, user)
    fid = item["file_id"]
    r = await client.post(
        f"/api/items/{fid}/actions/set_settings", headers=_auth(user), json={"args": {"daily_reminder": True, "reminder_time": "21:00"}}
    )
    assert r.status_code == 200, r.text
    rows = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert len(rows) >= 7 and all(x.key.startswith("journal:daily:") for x in rows)


async def test_normal_chat_sees_only_the_outline(client, db, user):
    from app.chat.tools import ToolContext
    from app.chat.tools.base import ToolError
    from app.chat.tools.items import ReadItemTool, UseItemTool

    item = await _new(client, user)
    fid = item["file_id"]
    data = copy.deepcopy(item["data"])
    data["entries"].append(
        {"id": "p1", "date": "2026-10-30", "time": "21:00", "title": "Thursday", "body": "A secret about Ana's surprise party.", "mood": 4, "tags": ["family"]}
    )
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": item["revision"]})
    assert r.status_code == 200, r.text
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    read = await ReadItemTool().run(ctx, {"file_id": fid})
    assert "Thursday" in read.content and "#family" in read.content and "mood 4 Good" in read.content
    assert "secret" not in read.content and "Data:" not in read.content
    for name in ("read_entry", "search_entries", "reflection_data", "on_this_day"):
        assert f"- {name}" not in read.content
        with pytest.raises(ToolError):
            await UseItemTool().run(ctx, {"file_id": fid, "action": name, "args": {"id": "p1"}})
    used = await UseItemTool().run(ctx, {"file_id": fid, "action": "mood_summary", "args": {"range": {"days": 3650}}})
    assert "secret" not in used.content
    await db.commit()  # the chat tools' session lets go of the row
    # Drive search / AI index reads the same outline.
    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Thursday" in row.content_text and "secret" not in row.content_text
    # Turning excerpts on is the person's choice: then a short excerpt shows.
    r = await client.post(f"/api/items/{fid}/actions/set_settings", headers=_auth(user), json={"args": {"share_excerpts": True}})
    assert r.status_code == 200, r.text
    read = await ReadItemTool().run(ctx, {"file_id": fid})
    assert "secret about Ana" in read.content and "Data:" not in read.content
    await db.commit()


async def test_archive_api(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    data = copy.deepcopy(item["data"])
    data["entries"] = [
        {"id": "old", "date": "2024-03-01", "body": "Long ago"},
        {"id": "new", "date": "2026-10-30", "body": "Recent"},
    ]
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": item["revision"]})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/archive", headers=_auth(user), json={"before": "2026-01-01"})
    assert r.status_code == 200, r.text
    assert [e["id"] for e in r.json()["data"]["entries"]] == ["new"]
    arch = (await client.get(f"/api/items/{r.json()['archive_id']}", headers=_auth(user))).json()
    assert [e["id"] for e in arch["data"]["entries"]] == ["old"] and len(arch["data"]["templates"]) == 7


# ------------------------------------------------------------------ AI turn


class _FakeModel:
    def __init__(self, hops):
        self.hops = list(hops)
        self.calls = []

    async def stream_chat_events(self, **kw):
        from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

        self.calls.append(kw)
        hop = self.hops.pop(0) if self.hops else {"text": "done"}
        if hop.get("text"):
            yield TextDelta(text=hop["text"])
        for i, (name, args) in enumerate(hop.get("tools", [])):
            yield ToolCallDelta(index=i, id=f"call{i}{len(self.calls)}", name=name, arguments=json.dumps(args))
        yield FinishEvent(reason="tool_calls" if hop.get("tools") else "stop")


async def test_ai_turn_drafts_an_entry_and_reads_stats(client, db, user, monkeypatch):
    from app.items import ai
    from app.models_config import provider as prov

    item = await _new(client, user)
    fid = item["file_id"]
    fake = _FakeModel(
        [
            {"tools": [("streak_info", {}), ("add_entry", {"person_asked": True, "title": "Tonight", "body": "Tired but okay.", "mood": 3})]},
            {"tools": [("add_entry", {"person_asked": False, "body": "sneaky"})]},
            {"text": "I drafted tonight's entry — edit it into your own words."},
        ]
    )
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "Write tonight's entry: tired but okay", object(), "m", can_edit=True)]
    acts = [e for e in events if e["type"] == "action"]
    assert [a["ok"] for a in acts] == [True, False]
    done = events[-1]
    assert done["changed"] and [e["title"] for e in done["data"]["entries"]] == ["Tonight"]
    assert done["data"]["entries"][0]["ai_drafted"] is True
    assert "reflection partner" in fake.calls[0]["system"]
