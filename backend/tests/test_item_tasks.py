"""The Tasks item (kind ``tasks``): the model, repeats, every action,
to_text, reminders, archive, the AI tool schemas and one end-to-end API
flow."""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.tasks import SPEC
from app.items.kinds.tasks.models import TasksData
from app.items.kinds.tasks.recur import describe, next_due
from app.items.kinds.tasks.reminders import reminders
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Brisbane")
NOW = datetime(2026, 11, 2, 7, 30, tzinfo=TZ)  # a Monday
assert NOW.weekday() == 0


def ctx_at(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def fresh(**settings) -> dict:
    d = SPEC.template(ctx_at())
    d["settings"].update(settings)
    return SPEC.validate(d)


async def act(data: dict, name: str, args: dict | None = None, now: datetime = NOW):
    from app.items.service import run_action

    out = await run_action(ctx_at(now), SPEC, data, name, args or {})
    clean = SPEC.validate(data)
    data.clear()
    data.update(clean)
    return out


def by_title(data: dict, title: str) -> dict:
    return next(t for t in data["tasks"] if t["title"] == title)


# ------------------------------------------------------------------ model


def test_template_and_identity():
    t = SPEC.template(ctx_at())
    assert SPEC.validate(t) == t
    assert [x["id"] for x in t["lists"]][:1] == ["inbox"] and t["tasks"] == []
    assert (SPEC.kind, SPEC.suffix, SPEC.icon, SPEC.category) == ("tasks", ".tasks", "list-todo", "Productivity")
    assert 5 <= len(SPEC.highlights) <= 8 and SPEC.replaces.startswith("Replaces")
    assert TasksData.model_validate({}).settings.default_time == "09:00"


def test_model_validation():
    base = {"id": "a", "title": "x"}
    t = TasksData.model_validate({"tasks": [{**base, "due": "2026-11-05T10:00:00", "time": "9:05", "alerts": [60, 0, 60], "tags": ["#home", "Home", "@x"]}]}).tasks[0]
    assert (t.due, t.time, t.alerts, t.tags) == ("2026-11-05", "09:05", [0, 60], ["home", "x"])
    for bad in ({"time": "25:00"}, {"due": "nope"}, {"priority": 5}, {"alerts": [-1]}, {"title": ""}):
        with pytest.raises(ValidationError):
            TasksData.model_validate({"tasks": [{**base, **bad}]})
    with pytest.raises(ValidationError):
        TasksData.model_validate({"tasks": [{**base, "repeat": {"freq": "weekly", "weekdays": [7]}}]})
    assert TasksData.model_validate({"lists": [{"id": "l", "name": "L", "color": "red"}]}).lists[0].color == "#3B7DD8"


# ------------------------------------------------------------------ repeats


@pytest.mark.parametrize(
    "rep, due, done, want",
    [
        ({"freq": "daily"}, "2026-11-02", "2026-11-02", "2026-11-03"),
        ({"freq": "daily"}, "2026-10-28", "2026-11-02", "2026-11-03"),  # late → tomorrow, not the past
        ({"freq": "daily", "interval": 3, "from_completion": True}, "2026-10-30", "2026-11-02", "2026-11-05"),
        ({"freq": "weekly"}, "2026-11-02", "2026-11-02", "2026-11-09"),
        ({"freq": "weekly", "weekdays": [0, 3]}, "2026-11-02", "2026-11-02", "2026-11-05"),
        ({"freq": "weekly", "weekdays": [0, 3]}, "2026-11-05", "2026-11-05", "2026-11-09"),
        ({"freq": "weekly", "weekdays": [0, 3], "interval": 2}, "2026-11-05", "2026-11-05", "2026-11-16"),
        ({"freq": "weekly", "weekdays": [0, 1, 2, 3, 4]}, "2026-11-06", "2026-11-06", "2026-11-09"),  # Fri → Mon
        ({"freq": "monthly", "month_day": 31}, "2026-01-31", "2026-01-31", "2026-02-28"),
        ({"freq": "monthly", "month_day": 31}, "2026-02-28", "2026-02-28", "2026-03-31"),
        ({"freq": "monthly"}, "2026-11-15", "2026-11-02", "2026-12-15"),  # done early
        ({"freq": "yearly"}, "2028-02-29", "2028-02-29", "2029-02-28"),
        ({"freq": "daily", "until": "2026-11-03"}, "2026-11-03", "2026-11-03", None),
    ],
)
def test_next_due(rep, due, done, want):
    assert next_due(rep, due, done) == want


def test_describe():
    assert describe({"freq": "weekly", "interval": 1, "weekdays": [0, 1, 2, 3, 4]}) == "every weekday"
    assert describe({"freq": "monthly", "interval": 1, "month_day": 1}) == "every month on the 1st"
    assert describe({"freq": "daily", "interval": 3, "from_completion": True}) == "every 3 days after done"
    assert describe(None) == ""


# ------------------------------------------------------------------ actions


async def test_add_tasks_defaults_and_lists():
    d = fresh()
    out = await act(d, "add_tasks", {"tasks": [
        {"title": "Call mum", "due": "2026-11-03", "time": "18:00"},
        {"title": "Milk", "list": "shopping"},
        {"title": "Pay rent", "due": "2026-11-01", "repeat": {"freq": "monthly"}, "list": "Bills", "priority": 3, "steps": ["Check balance", " "]},
        {"title": "Renew rego", "due": "2027-03-01", "alerts": [10080]},
        {"title": "No-date alert", "alerts": [0]},
    ]})
    assert "5 tasks" in out.summary and len(out.result) == 5
    call = by_title(d, "Call mum")
    assert call["alerts"] == [0] and call["list_id"] == "inbox"
    assert by_title(d, "Milk")["list_id"] == "shopping"
    rent = by_title(d, "Pay rent")
    assert rent["repeat"]["month_day"] == 1 and rent["priority"] == 3 and [s["title"] for s in rent["steps"]] == ["Check balance"]
    assert any(lst["name"] == "Bills" for lst in d["lists"]) and rent["list_id"] == "bills"
    assert by_title(d, "Renew rego")["alerts"] == [10080]
    assert by_title(d, "No-date alert")["alerts"] == []
    # Deterministic: the same call on the same data gives the same ids.
    d2 = fresh()
    await act(d2, "add_tasks", {"tasks": [{"title": "Call mum", "due": "2026-11-03", "time": "18:00"}]})
    d3 = fresh()
    await act(d3, "add_tasks", {"tasks": [{"title": "Call mum", "due": "2026-11-03", "time": "18:00"}]})
    assert d2["tasks"][0]["id"] == d3["tasks"][0]["id"]
    # A repeat with no day starts today.
    await act(d, "add_tasks", {"tasks": [{"title": "Stretch", "repeat": {"freq": "daily"}}]})
    assert by_title(d, "Stretch")["due"] == "2026-11-02"
    with pytest.raises(ActionError):
        await act(d, "add_tasks", {"tasks": [{"title": "x", "when": "now"}]})


async def test_update_task():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [{"title": "Dentist", "due": "2026-11-04"}]})
    out = await act(d, "update_task", {"task": "dentist", "time": "10:30", "list": "Personal", "tags": ["health"], "add_steps": ["Book"]})
    t = by_title(d, "Dentist")
    assert "Updated" in out.summary and t["time"] == "10:30" and t["alerts"] == [0] and t["list_id"] == "personal"
    assert t["tags"] == ["health"] and t["steps"][0]["title"] == "Book"
    await act(d, "update_task", {"task": t["id"], "repeat": {"freq": "yearly"}})
    assert by_title(d, "Dentist")["repeat"]["freq"] == "yearly"
    await act(d, "update_task", {"task": t["id"], "due": None})
    t = by_title(d, "Dentist")
    assert (t["due"], t["time"], t["alerts"], t["repeat"]) == (None, None, [], None)
    await act(d, "update_task", {"task": t["id"], "list": "Inbox"})
    assert by_title(d, "Dentist")["list_id"] == "inbox"
    with pytest.raises(ActionError, match="No task"):
        await act(d, "update_task", {"task": "nope", "title": "x"})


async def test_find_task_ambiguity():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [{"title": "Email Sam"}, {"title": "Email Jo"}]})
    with pytest.raises(ActionError, match="several"):
        await act(d, "complete_tasks", {"tasks": ["email"]})
    await act(d, "complete_tasks", {"tasks": ["Email Sam"]})
    # Only one open match left → it's picked.
    await act(d, "complete_tasks", {"tasks": ["email"]})
    assert by_title(d, "Email Jo")["done"]


async def test_complete_repeat_and_reopen():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [
        {"title": "Bins out", "due": "2026-11-02", "repeat": {"freq": "weekly"}, "steps": ["Red", "Yellow"]},
        {"title": "One-off"},
    ]})
    bins = by_title(d, "Bins out")
    bins["steps"][0]["done"] = True
    out = await act(d, "complete_tasks", {"tasks": ["Bins out", "One-off"]})
    assert "2 tasks" in out.summary
    bins = by_title(d, "Bins out")
    assert not bins["done"] and bins["due"] == "2026-11-09" and not any(s["done"] for s in bins["steps"])
    one = by_title(d, "One-off")
    assert one["done"] and one["done_at"].startswith("2026-11-02")
    assert [x["title"] for x in d["log"]] == ["Bins out", "One-off"] and d["log"][0]["due"] == "2026-11-02"
    # Completing a done task again changes nothing.
    assert (await act(d, "complete_tasks", {"tasks": [one["id"]]})).summary == "Nothing to change"
    await act(d, "complete_tasks", {"tasks": [one["id"]], "done": False})
    assert not by_title(d, "One-off")["done"] and [x["title"] for x in d["log"]] == ["Bins out"]


async def test_postpone_and_delete():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [
        {"title": "Late 1", "due": "2026-10-30"},
        {"title": "Late 2", "due": "2026-11-01"},
        {"title": "Soon", "due": "2026-11-05"},
    ]})
    out = await act(d, "postpone_tasks", {"overdue": True, "to": "2026-11-03"})
    assert "2 tasks" in out.summary and by_title(d, "Late 1")["due"] == by_title(d, "Late 2")["due"] == "2026-11-03"
    await act(d, "postpone_tasks", {"tasks": ["Soon"], "days": 2})
    assert by_title(d, "Soon")["due"] == "2026-11-07"
    with pytest.raises(ActionError):
        await act(d, "postpone_tasks", {"tasks": ["Soon"]})
    with pytest.raises(ActionError):
        await act(d, "postpone_tasks", {"overdue": True, "days": 1})  # nothing overdue now
    await act(d, "delete_tasks", {"tasks": ["Soon"]})
    assert all(t["title"] != "Soon" for t in d["tasks"])


async def test_manage_list():
    d = fresh()
    await act(d, "manage_list", {"op": "create", "list": "Garden", "emoji": "🌱"})
    assert any(x["name"] == "Garden" and x["emoji"] == "🌱" for x in d["lists"])
    with pytest.raises(ActionError, match="already"):
        await act(d, "manage_list", {"op": "create", "list": "garden"})
    await act(d, "add_tasks", {"tasks": [{"title": "Mow", "list": "Garden"}]})
    await act(d, "manage_list", {"op": "rename", "list": "Garden", "name": "Yard", "color": "#112233"})
    yard = next(x for x in d["lists"] if x["name"] == "Yard")
    assert yard["color"] == "#112233"
    await act(d, "manage_list", {"op": "delete", "list": "Yard"})
    assert by_title(d, "Mow")["list_id"] == "inbox" and all(x["name"] != "Yard" for x in d["lists"])
    with pytest.raises(ActionError, match="Inbox"):
        await act(d, "manage_list", {"op": "delete", "list": "inbox"})
    with pytest.raises(ActionError, match="No list"):
        await act(d, "manage_list", {"op": "rename", "list": "nope", "name": "x"})


async def test_read_only_actions():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [
        {"title": "Old thing", "due": "2026-10-20", "tags": ["admin"]},
        {"title": "Today thing", "due": "2026-11-02", "list": "Work"},
        {"title": "Next week", "due": "2026-11-06"},
        {"title": "Someday book"},
    ]})
    await act(d, "add_tasks", {"tasks": [{"title": "Done thing"}]})
    await act(d, "complete_tasks", {"tasks": ["Done thing"]})
    ag = (await act(d, "agenda", {})).result
    assert [ag[k]["count"] for k in ("overdue", "today", "upcoming", "later", "someday")] == [1, 1, 1, 0, 1]
    f = (await act(d, "find_tasks", {"tag": "admin"})).result
    assert f["count"] == 1 and f["tasks"][0]["task"].startswith("Old thing")
    assert (await act(d, "find_tasks", {"list": "Work"})).result["count"] == 1
    assert (await act(d, "find_tasks", {"query": "thing", "include_done": True})).result["count"] == 3
    assert (await act(d, "find_tasks", {"due_from": "2026-11-01", "due_to": "2026-11-03"})).result["count"] == 1
    with pytest.raises(ActionError):
        await act(d, "find_tasks", {"list": "nope"})
    r = (await act(d, "review", {"days": 7})).result
    assert r["completed"] == 1 and r["overdue"] == 1 and r["overdue_a_week_or_more"][0]["task"].startswith("Old thing")


# ------------------------------------------------------------------ text, reminders, archive


async def test_to_text():
    from app.items.spec import _TEXT_NOW

    d = fresh()
    await act(d, "add_tasks", {"tasks": [
        {"title": "Late", "due": "2026-10-30"},
        {"title": "Gym", "due": "2026-11-02", "time": "17:00", "repeat": {"freq": "weekly", "weekdays": [0, 2, 4]}},
        {"title": "Book flights", "notes": "Check Qantas sale"},
    ]})
    await act(d, "add_tasks", {"tasks": [{"title": "Finished"}]})
    await act(d, "complete_tasks", {"tasks": ["Finished"]})
    tok = _TEXT_NOW.set(NOW)
    try:
        text = SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(tok)
    assert text.index("Overdue (1)") < text.index("Today (1)") < text.index("No date (1)")
    assert "Gym · due 2026-11-02 17:00 · every week on Mon, Wed, Fri" in text
    assert "Check Qantas sale" in text and "2026-11-02 Finished" in text and "Lists: Inbox" in text


async def test_reminders():
    d = fresh(digest_time="08:00")
    await act(d, "add_tasks", {"tasks": [
        {"title": "Call", "due": "2026-11-02", "time": "18:00", "alerts": [0, 30]},
        {"title": "Rego", "due": "2026-11-05", "alerts": [1440]},
        {"title": "Past", "due": "2026-11-02", "time": "07:00"},
        {"title": "Far", "due": "2026-12-25", "time": "09:00"},
        {"title": "Late one", "due": "2026-10-31"},
    ]})
    rs = reminders(d, ctx_at())
    alerts = {(r.title, r.body) for r in rs}
    assert alerts == {("Call", "Due now"), ("Call", "Due in 30 min"), ("Rego", "Due tomorrow")}
    rego = next(r for r in rs if r.title == "Rego")
    assert rego.due_at == datetime(2026, 11, 4, 9, 0, tzinfo=TZ)
    # The morning list moved into the one Today summary push (app/today):
    # Tasks no longer schedules a digest of its own, so nobody gets two.
    assert not any(r.key.startswith("digest") for r in rs)
    # Ticking off removes its alerts.
    await act(d, "complete_tasks", {"tasks": ["Call"]})
    assert {r.title for r in reminders(d, ctx_at())} == {"Rego"}


async def test_archive():
    d = fresh()
    await act(d, "add_tasks", {"tasks": [{"title": "Old done"}, {"title": "Open"}]})
    await act(d, "complete_tasks", {"tasks": ["Old done"]}, now=NOW - timedelta(days=100))
    kept, archived = SPEC.archive(d, ctx_at(), "2026-10-01")
    assert [t["title"] for t in kept["tasks"]] == ["Open"] and kept["log"] == []
    assert [t["title"] for t in archived["tasks"]] == ["Old done"] and len(archived["log"]) == 1
    assert SPEC.validate(kept) and SPEC.validate(archived)


def test_tools():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    assert "$ref" not in str(tools)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert {"agenda", "find_tasks", "review"} <= ro and "add_tasks" not in ro
    assert len(SPEC.ai_suggestions) >= 4 and "Getting Things Done" in SPEC.ai_brief


# ------------------------------------------------------------ end to end


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


async def test_end_to_end_api_flow(client, db, user):
    from sqlalchemy import select

    from app.items.models import ItemReminder

    r = await client.post("/api/items/store/tasks", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "tasks", "title": "My tasks"})
    assert r.status_code == 201, r.text
    fid = r.json()["file_id"]
    soon = (datetime.now(TZ) + timedelta(days=2)).date().isoformat()
    r = await client.post(
        f"/api/items/{fid}/actions/add_tasks",
        headers=_auth(user),
        json={"args": {"tasks": [{"title": "Water plants", "due": soon, "time": "12:00"}]}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["tasks"][0]["alerts"] == [0]
    rems = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == fid))).scalars().all()
    assert any(x.title == "Water plants" for x in rems)

    r = await client.post(f"/api/items/{fid}/actions/complete_tasks", headers=_auth(user), json={"args": {"tasks": ["nope"]}})
    assert r.status_code == 400 and "No task" in r.json()["detail"]

    # A direct UI save (the check-off path) is validated and stored.
    cur = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    data = cur["data"]
    data["tasks"][0]["done"] = True
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": data, "base_revision": cur["revision"]})
    assert r.status_code == 200, r.text
    bad = r.json()["data"]
    bad["tasks"][0]["time"] = "99:99"
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": bad, "base_revision": r.json()["revision"]})
    assert r.status_code == 400
