"""Home automations (``app/home/automations.py``, ``flow_nodes.py``,
``auto_router.py``): the home's own flows. The owner makes them, everyone in
the home runs them, a phrase runs one without a model only on an exact
match, and no lock or garage door is ever a step."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_home import _answer, _dial, _has_snapshot, _prepare, _turn_on, _wait, client  # noqa: F401
from tests.test_home_assistant import ALL, _ctx, _home, _quiet
from tests.test_maps_timeline import _hdr, _other

DOOR = {"id": "binary_sensor.door", "domain": "binary_sensor", "name": "Front door sensor", "state": "off", "area": "hall"}


def _node(i, kind, **data):
    return {"id": i, "type": kind, "position": {"x": 0, "y": 0}, "data": data}


def _chain(*nodes, extra_edges=()):
    """Nodes joined one after the other."""
    edges = [{"source": a["id"], "target": b["id"]} for a, b in zip(nodes, nodes[1:])]
    return {"version": 1, "mode": "advanced", "nodes": list(nodes), "edges": edges + list(extra_edges)}


def _asked(box_id: str = ""):
    return _node("trigger", "trigger.manual")


def _light(i, prepared, entity="light.lamp", action="turn_on", value=None):
    return _node(i, "home.device", box=prepared["box"]["id"], entity=entity, action=action, value=value)


async def _make(client, who, home_id, name="Movie time"):  # noqa: F811
    r = await client.post(f"/api/home/{home_id}/automations", headers=_hdr(who), json={"name": name, "timezone": "Australia/Brisbane"})
    assert r.status_code == 201, r.text
    return r.json()


async def _save(client, who, home_id, auto_id, **body):  # noqa: F811
    return await client.put(f"/api/home/{home_id}/automations/{auto_id}", headers=_hdr(who), json=body)


async def _settled(db, auto_id):
    from sqlalchemy import select

    from app.tasks.models import TaskRun

    async def now():
        q = select(TaskRun).where(TaskRun.task_id == uuid.UUID(auto_id)).order_by(TaskRun.created_at)
        return (await db.execute(q.execution_options(populate_existing=True))).scalars().all()

    for _ in range(100):
        rows = await now()
        if rows and all(r.status not in ("pending", "running") for r in rows):
            break
        await asyncio.sleep(0.05)
    return await now()


# ------------------------------------------------------------------ the phrase matcher (pure)


@pytest.mark.parametrize(
    "said",
    [
        "it's morning time",
        "Its morning time",
        "It is morning time.",
        "Hey Promptly, it's morning time!",
        "promptly it’s morning time please",
        "OK Promptly, it is MORNING time, thanks",
        "could you please run it's morning time",
        "start morning routine",
        "run the morning routine",
        "Run Morning Routine automation",
    ],
)
def test_a_phrase_is_heard_however_it_is_written(said):
    from app.home import automations
    from app.tasks.models import Task

    task = Task(title="Morning routine", phrases=["It's morning time"])
    assert automations.said_for(said, task) is True


@pytest.mark.parametrize(
    "said",
    [
        "",
        "morning",
        "morning time",
        "it's morning",
        "is it morning time",
        "it's morning time already",
        "it's morning time and turn off the lights",
        "it's not morning time",
        "what is morning time",
        "its mourning time",
        "it's evening time",
        "tell me when it's morning time",
        "morning routine",  # its name alone isn't a phrase: only "run morning routine"
        "run the morning",
        "start my morning routine now",
        "don't run morning routine",
        "run morning routine and movie time",
        "please",
        "hey promptly",
        "run",
    ],
)
def test_nothing_looser_than_the_phrase_runs_it(said):
    from app.home import automations
    from app.tasks.models import Task

    task = Task(title="Morning routine", phrases=["It's morning time"])
    assert automations.said_for(said, task) is False


def test_number_words_and_digits_are_one_phrase():
    from app.home import automations
    from app.tasks.models import Task

    task = Task(title="Scene two", phrases=["scene twenty five"])
    assert automations.said_for("Scene 25", task) and automations.said_for("scene twenty-five", task)
    assert not automations.said_for("scene 26", task)


def test_phrases_are_tidied_and_silly_ones_refused():
    from app.home import automations

    assert automations.clean_phrases(["  Movie   time ", "movie time!", "", "Goodnight"]) == ["Movie time", "Goodnight"]
    for bad in (["please"], ["hey promptly"], ["go"], ["turn off the {room} lights"], ["x" * 81], ["a b"] * 1 + [f"phrase number {n}" for n in range(7)]):
        with pytest.raises(automations.Problem):
            automations.clean_phrases(bad)
    with pytest.raises(automations.Problem):
        automations.clean_phrases("movie time")


def test_a_schedule_is_said_the_way_a_person_would():
    from app.home.automations import schedule_words
    from app.tasks.flow_graph import ScheduleTriggerData as S

    assert schedule_words(S(frequency="daily", hour=6, minute=30)) == "Every day at 6:30 am"
    assert schedule_words(S(frequency="daily", hour=0, minute=5)) == "Every day at 12:05 am"
    assert schedule_words(S(frequency="weekly", hour=19, minute=0, weekdays=[4, 0, 1, 2, 3])) == "Weekdays at 7:00 pm"
    assert schedule_words(S(frequency="weekly", hour=9, minute=0, weekdays=[5, 6])) == "Weekends at 9:00 am"
    assert schedule_words(S(frequency="weekly", hour=12, minute=0, weekdays=[1, 3])) == "Tue, Thu at 12:00 pm"
    assert schedule_words(S(frequency="weekly", hour=8, minute=0, weekday=2)) == "Wed at 8:00 am"
    assert schedule_words(S(frequency="hourly", minute=15)) == "Hourly · at :15"


def test_time_checks_over_midnight_and_by_day():
    from app.home.flow_nodes import in_window
    from app.tasks.flow_graph import TimeWindowData

    def at(day, hh, mm):  # 2026-11-16 is a Monday
        return datetime(2026, 11, 16 + day, hh, mm)

    evening = TimeWindowData(start="18:00", end="23:00")
    assert in_window(evening, at(0, 18, 0)) and in_window(evening, at(0, 22, 59))
    assert not in_window(evening, at(0, 23, 0)) and not in_window(evening, at(0, 17, 59))
    night = TimeWindowData(start="22:00", end="06:00", days=[4])  # Friday nights
    assert in_window(night, at(4, 23, 0)) and in_window(night, at(5, 5, 59))  # into Saturday morning
    assert not in_window(night, at(5, 23, 0)) and not in_window(night, at(4, 5, 0)) and not in_window(night, at(5, 6, 0))
    weekdays = TimeWindowData(start="07:00", end="09:00", days=[0, 1, 2, 3, 4])
    assert in_window(weekdays, at(2, 8, 0)) and not in_window(weekdays, at(5, 8, 0))


def test_on_and_off_mean_what_a_person_means():
    from app.home.flow_nodes import state_is

    assert state_is({"state": "playing"}, "on") and state_is({"state": "open"}, "on") and state_is({"state": "on"}, "on")
    assert state_is({"state": "paused"}, "off") and state_is({"state": "closed"}, "off")
    assert not state_is({"state": "unavailable"}, "on") and not state_is({"state": "unavailable"}, "off")
    assert state_is({"state": "Playing"}, "playing") and not state_is({"state": "idle"}, "playing")


# ------------------------------------------------------------------ who may do what


async def test_the_owner_makes_them_everyone_in_the_home_runs_them_nobody_else_sees_them(user, client, db):  # noqa: F811
    """``user`` is the admin, and not in the home."""
    await _turn_on(client, user)
    sam, kim, ann = await _other(db), await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": kim.username})).status_code == 200

    made = await _make(client, sam, home_id)
    assert made["enabled"] is False and made["steps"] == 0 and made["can_edit"] is True
    graph = _chain(_asked(), _light("a", prepared))
    r = await _save(client, sam, home_id, made["id"], graph=graph, phrases=["Movie time"])
    assert r.status_code == 200, r.text
    saved = r.json()
    # Saving its first steps switches it on.
    assert saved["enabled"] is True and saved["steps"] == 1 and saved["phrases"] == ["Movie time"]
    assert saved["trigger"] == {"kind": "asked", "words": "When someone asks"}
    assert saved["graph"]["nodes"][1]["data"]["name"] == "Floor lamp"

    # A member sees it and runs it, and changes nothing.
    listed = (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(kim))).json()
    assert listed["can_edit"] is False and [a["name"] for a in listed["automations"]] == ["Movie time"]
    assert (await client.post(f"/api/home/{home_id}/automations", headers=_hdr(kim), json={"name": "Mine"})).status_code == 403
    assert (await _save(client, kim, home_id, made["id"], name="Hers")).status_code == 403
    assert (await client.delete(f"/api/home/{home_id}/automations/{made['id']}", headers=_hdr(kim))).status_code == 403
    assert (await client.get(f"/api/home/{home_id}/automations-music", headers=_hdr(kim), params={"box_id": prepared["box"]["id"], "q": "jazz"})).status_code == 403
    side = asyncio.create_task(_answer(box, n=1))
    ran = await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(kim))
    assert ran.status_code == 200 and ran.json()["ok"] is True and ran.json()["words"] == "Okay, Movie time is done."
    assert [(a["op"], a["args"]) for a in await side] == [("do", {"entity": "light.lamp", "action": "turn_on", "value": None})]

    # Someone in no home, and the admin who prepared the box: nothing at all.
    for outsider in (ann, user):
        assert (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(outsider))).status_code == 404
        assert (await client.get(f"/api/home/{home_id}/automations/{made['id']}", headers=_hdr(outsider))).status_code == 404
        assert (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(outsider))).status_code == 404
        assert (await client.get(f"/api/home/{home_id}/automations/{made['id']}/runs", headers=_hdr(outsider))).status_code == 404
        assert (await _save(client, outsider, home_id, made["id"], name="Theirs")).status_code == 404
        assert (await client.delete(f"/api/home/{home_id}/automations/{made['id']}", headers=_hdr(outsider))).status_code == 404
    assert _quiet(box)
    # It is not one of the owner's own automations (the AI tasks page), and
    # can't be reached through that door either.
    sam.can_use_automations = True
    await db.commit()
    assert (await client.get("/api/tasks?scope=all", headers=_hdr(sam))).json() == []
    for path in (f"/api/tasks/{made['id']}", f"/api/tasks/{made['id']}/graph", f"/api/tasks/{made['id']}/runs"):
        assert (await client.get(path, headers=_hdr(sam))).status_code == 404
    assert (await client.post(f"/api/tasks/{made['id']}/run", headers=_hdr(sam))).status_code == 404

    assert (await client.delete(f"/api/home/{home_id}/automations/{made['id']}", headers=_hdr(sam))).json() == {"ok": True}
    assert (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(sam))).json()["automations"] == []
    await box.hang_up()
    await task


async def test_an_automation_of_one_home_is_not_another_homes(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    sam, pat = await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    theirs, their_home, box2, task2 = await _home(client, user, pat)
    made = await _make(client, sam, home_id)
    # Pat owns a home too, and still can't touch Sam's, nor borrow Sam's lamp.
    assert (await client.get(f"/api/home/{their_home}/automations/{made['id']}", headers=_hdr(pat))).status_code == 404
    assert (await _save(client, pat, their_home, made["id"], name="x")).status_code == 404
    own = await _make(client, pat, their_home, "Pat's")
    r = await _save(client, pat, their_home, own["id"], graph=_chain(_asked(), _light("a", prepared)))
    assert r.status_code == 422 and "isn't in this home" in r.json()["detail"]
    for b, t in ((box, task), (box2, task2)):
        await b.hang_up()
        await t


# ------------------------------------------------------------------ what can be saved


async def test_what_a_flow_may_and_may_not_hold(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user, ALL + [DOOR])
    b = prepared["box"]["id"]
    made = await _make(client, user, home_id)

    async def refused(graph, words):
        r = await _save(client, user, home_id, made["id"], graph=graph)
        assert r.status_code == 422, r.text
        assert words in r.json()["detail"], r.json()["detail"]

    # Nothing to do; a loose step; a loop; two starts.
    await refused(_chain(_asked()), "at least one thing")
    await refused({**_chain(_asked(), _light("a", prepared)), "nodes": [_asked(), _light("a", prepared), _light("b", prepared)]}, "joined on")
    await refused(_chain(_asked(), _light("a", prepared), _light("b", prepared), extra_edges=[{"source": "b", "target": "a"}]), "joined on")
    await refused(_chain(_asked(), _node("t2", "trigger.manual"), _light("a", prepared)), "exactly one")
    # Never a lock, a garage door or an alarm; nor the parked air con.
    await refused(_chain(_asked(), _node("a", "home.device", box=b, entity="lock.front", action="unlock")), "Locks, garage doors")
    await refused(_chain(_asked(), _node("a", "home.device", box=b, entity="cover.garage", action="open")), "Locks, garage doors")
    await refused(_chain(_asked(), _node("a", "home.device", box=b, entity="climate.ac", action="turn_on")), "can't be used in an automation yet")
    # Not a device here; an action it hasn't got; a value that won't do.
    await refused(_chain(_asked(), _node("a", "home.device", box=b, entity="light.nope", action="turn_on", name="Old lamp")), "Old lamp isn't in this home any more")
    await refused(_chain(_asked(), _node("a", "home.device", box=str(uuid.uuid4()), entity="light.lamp", action="turn_on")), "isn't in this home any more")
    await refused(_chain(_asked(), _light("a", prepared, action="unlock")), "can't do that")
    await refused(_chain(_asked(), _light("a", prepared, entity="media_player.lounge", action="next")), "can't do that")  # it doesn't say it can skip
    await refused(_chain(_asked(), _light("a", prepared, action="set", value={"bri": 400})), "needs a brightness")
    await refused(_chain(_asked(), _light("a", prepared, entity="media_player.kitchen", action="volume", value=140)), "0 to 100")
    # Only home steps: no AI, no web, no connectors, no reports.
    for kind in ("ai.prompt", "http.request", "mcp.action", "search.web", "output.report", "trigger.webhook", "control.router"):
        await refused(_chain(_asked(), _light("a", prepared), _node("x", kind)), "only use home steps" if kind != "trigger.webhook" else "only use home steps")
    # Waits: a sensible length, and not hours of them.
    await refused(_chain(_asked(), _node("w", "flow.delay", seconds=0), _light("a", prepared)), "A wait can be")
    await refused(_chain(_asked(), _node("w", "flow.delay", seconds=4000), _light("a", prepared)), "A wait can be")
    await refused(_chain(_asked(), _node("w1", "flow.delay", seconds=1800), _node("w2", "flow.delay", seconds=1800), _node("w3", "flow.delay", seconds=600), _light("a", prepared)), "add up to more")
    # Rooms, speakers, checks and starts must be things of this home.
    await refused(_chain(_asked(), _node("a", "home.lights", box=b, area="attic", name="Attic", on=False)), "Attic isn't in this home")
    await refused(_chain(_asked(), _node("a", "home.music", box=b, entity="light.lamp", query="jazz")), "isn't a speaker")
    await refused(_chain(_asked(), _node("c", "control.time", start="25:00", end="07:00"), _light("a", prepared)), "start and an end time")
    await refused(_chain(_node("trigger", "trigger.home_state", box=b, entity="", state="on"), _light("a", prepared)), "Pick the device that starts it")
    await refused(_chain(_node("trigger", "trigger.schedule", frequency="sometimes"), _light("a", prepared)), "Pick when it should run")
    await refused(_chain(_node("trigger", "trigger.schedule", frequency="minutes", interval_minutes=1), _light("a", prepared)), "Pick when it should run")

    # And one with a bit of everything is kept, with names filled in.
    good = _chain(
        _node("trigger", "trigger.schedule", frequency="daily", hour=6, minute=30, timezone="Australia/Brisbane"),
        _node("r", "home.lights", box=b, area="kitchen", on=True),
        _node("w", "flow.delay", seconds=60),
        _node("m", "home.music", box=b, entity="media_player.kitchen", query="jazz", volume=25),
        _node("s", "home.device", box=b, entity="scene.movie", action="run"),
    )
    r = await _save(client, user, home_id, made["id"], graph=good)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["trigger"] == {"kind": "schedule", "words": "Every day at 6:30 am"} and out["steps"] == 3 and out["next_run_at"]
    names = {n["id"]: n["data"].get("name") for n in out["graph"]["nodes"]}
    assert names["r"] == "Kitchen" and names["m"] == "Kitchen speaker" and names["s"] == "Movie night"
    # Switched off: the clock leaves it alone. On again: it's back on the clock.
    assert (await _save(client, user, home_id, made["id"], enabled=False)).json()["next_run_at"] is None
    assert (await _save(client, user, home_id, made["id"], enabled=True)).json()["next_run_at"]
    # An empty one can't be switched on.
    empty = await _make(client, user, home_id, "Empty")
    r = await _save(client, user, home_id, empty["id"], enabled=True)
    assert r.status_code == 422 and "before switching it on" in r.json()["detail"]
    assert _quiet(box)
    await box.hang_up()
    await task


async def test_two_automations_in_a_home_cannot_share_a_phrase(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    one, two = await _make(client, user, home_id, "Movie time"), await _make(client, user, home_id, "Film night")
    assert (await _save(client, user, home_id, one["id"], phrases=["Movie time", "Let's watch a film"])).status_code == 200
    r = await _save(client, user, home_id, two["id"], phrases=["Hey Promptly, MOVIE time!"])
    assert r.status_code == 422 and "already what runs “Movie time”" in r.json()["detail"]
    r = await _save(client, user, home_id, two["id"], phrases=["lets watch a film"])
    assert r.status_code == 422
    assert (await _save(client, user, home_id, two["id"], phrases=["film night"])).status_code == 200
    # Its own phrases can be saved again.
    assert (await _save(client, user, home_id, one["id"], phrases=["Movie time"])).status_code == 200
    r = await _save(client, user, home_id, one["id"], phrases=["ok"])
    assert r.status_code == 422 and "too short" in r.json()["detail"]
    await box.hang_up()
    await task


# ------------------------------------------------------------------ running


async def test_a_run_does_its_steps_in_order_and_says_what_happened(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    b = prepared["box"]["id"]
    made = await _make(client, user, home_id, "Evening")
    graph = _chain(
        _asked(),
        _node("r", "home.lights", box=b, area="kitchen", on=False),
        _light("l", prepared, action="set", value={"bri": 30, "k": 2700}),
        _node("v", "home.device", box=b, entity="media_player.kitchen", action="volume", value=20),
        _node("s", "home.device", box=b, entity="scene.movie", action="run"),
    )
    assert (await _save(client, user, home_id, made["id"], graph=graph)).status_code == 200
    side = asyncio.create_task(_answer(box, n=4))
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    assert [(a["op"], a["args"]) for a in await side] == [
        ("room.lights", {"area": "kitchen", "action": "turn_off"}),
        ("do", {"entity": "light.lamp", "action": "set", "value": {"bri": 30, "k": 2700}}),
        ("do", {"entity": "media_player.kitchen", "action": "volume", "value": 20}),
        ("do", {"entity": "scene.movie", "action": "run", "value": None}),
    ]
    assert ran["ok"] is True and ran["run"]["status"] == "success" and ran["run"]["trigger"] == "manual"
    assert [s["text"] for s in ran["run"]["steps"]] == [
        "Kitchen lights: turned off",
        "Floor lamp: set to 30%, warm white",
        "Kitchen speaker: volume 20",
        "Movie night: switched on",
    ]
    listed = (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(user))).json()["automations"][0]
    assert listed["last"]["status"] == "success"
    history = (await client.get(f"/api/home/{home_id}/automations/{made['id']}/runs", headers=_hdr(user))).json()["runs"]
    assert len(history) == 1 and len(history[0]["steps"]) == 4
    await box.hang_up()
    await task


async def test_one_step_that_fails_does_not_stop_the_rest_and_is_said(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    made = await _make(client, user, home_id, "Evening")
    graph = _chain(_asked(), _light("a", prepared, entity="light.bench", action="turn_off"), _light("b", prepared))
    assert (await _save(client, user, home_id, made["id"], graph=graph)).status_code == 200

    async def no_then_yes():
        first = await box.hear("req")
        await box.say({"t": "res", "id": first["id"], "ok": False, "error": "The bulb didn't answer."})
        second = await box.hear("req")
        await box.say({"t": "res", "id": second["id"], "ok": True})
        return [first["args"]["entity"], second["args"]["entity"]]

    side = asyncio.create_task(no_then_yes())
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    assert await side == ["light.bench", "light.lamp"]
    assert ran["ok"] is False and ran["run"]["status"] == "warning"
    assert ran["words"] == "Evening ran, but part of it didn't work. The bulb didn't answer."
    assert [(s["status"], s["text"]) for s in ran["run"]["steps"]] == [("error", "The bulb didn't answer."), ("success", "Floor lamp: turned on")]
    await box.hang_up()
    await task


async def test_with_the_box_offline_it_fails_in_plain_words_and_asks_nothing(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    made = await _make(client, user, home_id, "Evening")
    assert (await _save(client, user, home_id, made["id"], graph=_chain(_asked(), _light("a", prepared)))).status_code == 200
    await box.hang_up()
    await task
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    assert ran["ok"] is False and ran["run"]["status"] == "failed"
    assert ran["words"] == "Evening didn't work. The home box is offline, so I can't reach it. Check it has power and internet."


async def test_checks_send_a_run_down_one_branch(user, client, db):  # noqa: F811
    """If the kitchen speaker is playing: pause it. Otherwise: lamp on."""
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    b = prepared["box"]["id"]
    made = await _make(client, user, home_id, "Quiet")
    nodes = [
        _asked(),
        _node("c", "control.home_state", box=b, entity="media_player.kitchen", state="on"),
        _node("p", "home.device", box=b, entity="media_player.kitchen", action="pause"),
        _light("l", prepared),
    ]
    graph = {
        "version": 1, "mode": "advanced", "nodes": nodes,
        "edges": [
            {"source": "trigger", "target": "c"},
            {"source": "c", "target": "p", "source_handle": "true"},
            {"source": "c", "target": "l", "source_handle": "false"},
        ],
    }
    assert (await _save(client, user, home_id, made["id"], graph=graph)).status_code == 200
    side = asyncio.create_task(_answer(box, n=1))
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    assert [a["args"] for a in await side] == [{"entity": "media_player.kitchen", "action": "pause", "value": None}]
    assert [s["text"] for s in ran["run"]["steps"]] == ["Kitchen speaker is playing: yes", "Kitchen speaker: paused"]
    # It stops playing: the other branch.
    await box.say({"t": "state", "e": {"id": "media_player.kitchen", "domain": "media_player", "name": "Kitchen speaker", "state": "idle", "area": "kitchen", "x": {"vol": 30, "can": ["pause", "play"]}}})
    from app.home import relay

    await _wait(lambda: relay.link(uuid.UUID(b)).entities["media_player.kitchen"]["state"] == "idle")
    side = asyncio.create_task(_answer(box, n=1))
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    assert [a["args"]["entity"] for a in await side] == ["light.lamp"]
    assert ran["run"]["steps"][0]["text"] == "Kitchen speaker is idle: no"
    await box.hang_up()
    await task


async def test_a_second_run_waits_for_the_first_to_finish(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    made = await _make(client, user, home_id, "Slow")
    assert (await _save(client, user, home_id, made["id"], graph=_chain(_asked(), _light("a", prepared)))).status_code == 200
    from app.home import automations
    from app.tasks.models import Task

    row = await db.get(Task, uuid.UUID(made["id"]))
    first = await automations.run_now(db, row, "manual")  # the box hasn't answered yet
    ask = await box.hear("req")
    with pytest.raises(automations.Problem, match="already running"):
        await automations.run_now(db, row, "manual")
    await box.say({"t": "res", "id": ask["id"], "ok": True})
    runs = await _settled(db, made["id"])
    assert [r.status for r in runs] == ["success"] and runs[0].id == first.id
    await box.hang_up()
    await task


# ------------------------------------------------------------------ phrases, said and typed


async def test_saying_the_phrase_runs_it_without_a_model(user, client, db):  # noqa: F811
    from app.home import automations

    await _turn_on(client, user)
    sam, kim, ann = await _other(db), await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": kim.username})).status_code == 200
    made = await _make(client, sam, home_id, "Morning routine")
    assert (await _save(client, sam, home_id, made["id"], graph=_chain(_asked(), _light("a", prepared)), phrases=["It's morning time"])).status_code == 200

    # A member says it.
    side = asyncio.create_task(_answer(box, n=1))
    assert await automations.said(kim.id, "Hey Promptly, its morning time") == (True, "Okay, Morning routine is done.")
    assert len(await side) == 1
    runs = await _settled(db, made["id"])
    assert [r.trigger for r in runs] == ["phrase"]
    # Not quite the phrase: nothing runs, the model answers.
    for near in ("it's morning", "is it morning time?", "it's morning time and put the kettle on", "morning routine"):
        assert await automations.said(kim.id, near) is None
    # Someone not in the home, and the admin: it isn't theirs to say.
    for outsider in (ann, user):
        assert await automations.said(outsider.id, "it's morning time") is None
    # Switched off: the phrase does nothing (the Run button still works).
    assert (await _save(client, sam, home_id, made["id"], enabled=False)).status_code == 200
    assert await automations.said(kim.id, "it's morning time") is None
    assert _quiet(box)
    await box.hang_up()
    await task


async def test_the_same_phrase_in_two_of_your_homes_is_left_for_the_model_to_ask_about(user, client, db):  # noqa: F811
    from app.home import automations

    await _turn_on(client, user)
    sam = await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    prepared2, home2, box2, task2 = await _home(client, user, sam)
    for h, p in ((home_id, prepared), (home2, prepared2)):
        made = await _make(client, sam, h, "Movie time")
        assert (await _save(client, sam, h, made["id"], graph=_chain(_asked(), _light("a", p)), phrases=["movie time"])).status_code == 200
    assert await automations.said(sam.id, "movie time") is None
    assert _quiet(box) and _quiet(box2)
    for b, t in ((box, task), (box2, task2)):
        await b.hang_up()
        await t


async def test_the_assistants_tool_runs_one_by_name_lists_them_and_never_guesses(user, client, db):  # noqa: F811
    from app.chat import holds
    from app.chat.tools.base import HoldForApproval, ToolError
    from app.chat.tools.home import HomeAutomationTool
    from app.chat.tools.registry import get_tool, list_openai_tools
    from app.talk import tools as voice

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    tool = HomeAutomationTool()
    assert "no automations yet" in (await tool.run(_ctx(db, sam), {})).content
    for name, phrases in (("Movie time", ["movie time"]), ("Movie night for the kids", []), ("Bedtime", ["goodnight"])):
        made = await _make(client, sam, home_id, name)
        assert (await _save(client, sam, home_id, made["id"], graph=_chain(_asked(), _light("a", prepared)), phrases=phrases)).status_code == 200

    listed = (await tool.run(_ctx(db, sam), {})).content
    assert "3 automations" in listed and "- Bedtime: say “goodnight”" in listed and "- Movie night for the kids" in listed
    side = asyncio.create_task(_answer(box, n=1))
    result = await tool.run(_ctx(db, sam), {"name": "Goodnight!"})
    assert result.content == "Done: Okay, Bedtime is done." and len(await side) == 1
    side = asyncio.create_task(_answer(box, n=1))
    assert (await tool.run(_ctx(db, sam), {"name": "bedtime"})).content == "Done: Okay, Bedtime is done."
    await side
    await _settled(db, made["id"])
    # "movie": two could be meant. "the news": none of them. Neither runs.
    with pytest.raises(ToolError, match="More than one automation"):
        await tool.run(_ctx(db, sam), {"name": "movie"})
    with pytest.raises(ToolError, match="isn't one of their home's automations"):
        await tool.run(_ctx(db, sam), {"name": "the news"})
    # Not theirs to list or run.
    for outsider in (ann, user):
        assert "no automations yet" in (await tool.run(_ctx(db, outsider), {})).content
        with pytest.raises(ToolError):
            await tool.run(_ctx(db, outsider), {"name": "goodnight"})
    # After reading a web page or an email, running one waits for a yes.
    with pytest.raises(HoldForApproval):
        await tool.run(_ctx(db, sam, untrusted=True), {"name": "goodnight"})
    assert _quiet(box)
    assert get_tool("home_automation").category == "home"
    assert "home_automation" in {t["function"]["name"] for t in list_openai_tools({"home"})}
    assert "home_automation" in voice.voice_tool_names([], device="android") and not voice.is_write("home_automation")
    assert holds.question("home_automation", {"name": "movie time"}) == "At home: run “movie time”?"
    await box.hang_up()
    await task


# ------------------------------------------------------------------ a device starts it, and the clock


async def test_a_device_changing_starts_it_once_and_only_on_a_real_change(user, client, db):  # noqa: F811
    from app.home import automations

    automations.reset()
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user, ALL + [DOOR])
    b = prepared["box"]["id"]
    made = await _make(client, user, home_id, "Door light")
    graph = _chain(_node("trigger", "trigger.home_state", box=b, entity="binary_sensor.door", state="on"), _light("a", prepared))
    saved = (await _save(client, user, home_id, made["id"], graph=graph)).json()
    assert saved["trigger"] == {"kind": "device", "words": "When Front door sensor turns on"}

    def door(state):
        return {"t": "state", "e": {**DOOR, "state": state}}

    # It comes back from "unavailable" already open: not a change anyone made.
    await box.say(door("unavailable"))
    await box.say(door("on"))
    await box.say(door("off"))
    await asyncio.sleep(0.2)
    assert _quiet(box)
    # It opens.
    side = asyncio.create_task(_answer(box, n=1))
    await box.say(door("on"))
    assert [a["args"]["entity"] for a in await side] == ["light.lamp"]
    runs = await _settled(db, made["id"])
    assert [(r.trigger, r.status) for r in runs] == [("device", "success")]
    # Shut and open again straight away: a flicker doesn't run it twice.
    await box.say(door("off"))
    await box.say(door("on"))
    await asyncio.sleep(0.2)
    assert _quiet(box)
    # Switched off: nothing.
    automations._last_fired.clear()
    assert (await _save(client, user, home_id, made["id"], enabled=False)).status_code == 200
    await box.say(door("off"))
    await box.say(door("on"))
    await asyncio.sleep(0.2)
    assert _quiet(box) and len(await _settled(db, made["id"])) == 1
    await box.hang_up()
    await task


async def test_the_clock_starts_it_here_whoever_owns_it_and_never_queues_it(user, client, db, monkeypatch):  # noqa: F811
    """The owner has no "automations" permission of their own: a home's
    schedule runs all the same, and in this process, where the box is."""
    from app.tasks import queue, scheduler
    from app.tasks.models import Task

    await _turn_on(client, user)
    sam = await _other(db)
    assert not getattr(sam, "can_use_automations", False)
    prepared, home_id, box, task = await _home(client, user, sam)
    made = await _make(client, sam, home_id, "Sunrise")
    graph = _chain(_node("trigger", "trigger.schedule", frequency="daily", hour=6, minute=30, timezone="Australia/Brisbane"), _light("a", prepared))
    assert (await _save(client, sam, home_id, made["id"], graph=graph)).status_code == 200

    async def no_queue():
        raise AssertionError("a home automation was queued for the worker")

    monkeypatch.setattr(queue, "_get_pool", no_queue)
    row = await db.get(Task, uuid.UUID(made["id"]))
    row.next_run_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    await db.commit()
    side = asyncio.create_task(_answer(box, n=1))
    for run_id in await scheduler._claim_due():
        await queue.enqueue_run(run_id)
    assert len(await side) == 1
    runs = await _settled(db, made["id"])
    assert [(r.trigger, r.status) for r in runs] == [("schedule", "success")]
    await db.refresh(row)
    assert row.next_run_at > datetime.now(timezone.utc)
    await box.hang_up()
    await task


async def test_a_run_cut_off_by_a_restart_is_closed_and_does_not_block_the_next(user, client, db):  # noqa: F811
    from app.home import automations
    from app.tasks.models import Task, TaskRun

    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user)
    made = await _make(client, user, home_id, "Evening")
    assert (await _save(client, user, home_id, made["id"], graph=_chain(_asked(), _light("a", prepared)))).status_code == 200
    # As the last process left it: running, and nothing is running it.
    stuck = TaskRun(task_id=uuid.UUID(made["id"]), status="running", trigger="schedule", started_at=datetime.now(timezone.utc))
    mine = TaskRun(task_id=(await _own_task(db, user)).id, status="running", trigger="schedule")
    db.add_all([stuck, mine])
    await db.commit()
    row = await db.get(Task, uuid.UUID(made["id"]))
    with pytest.raises(automations.Problem, match="already running"):
        await automations.run_now(db, row, "manual")
    assert await automations.close_interrupted() == 1
    await db.refresh(stuck)
    await db.refresh(mine)
    assert stuck.status == "failed" and "restarted" in stuck.error
    assert mine.status == "running"  # someone's own automation is the worker's to look after
    side = asyncio.create_task(_answer(box, n=1))
    ran = (await client.post(f"/api/home/{home_id}/automations/{made['id']}/run", headers=_hdr(user))).json()
    await side
    assert ran["ok"] is True
    await box.hang_up()
    await task


async def _own_task(db, who):
    from app.tasks.models import Task

    own = Task(user_id=who.id, title="Mine", prompt="x", frequency="daily")
    db.add(own)
    await db.commit()
    return own


async def test_home_steps_do_nothing_outside_a_home_automation(user, db):
    """Someone's own automation can't borrow a home's devices by naming them."""
    from app.tasks.flow_graph import FlowGraph
    from app.tasks.graph_runner import run_graph_flow
    from app.tasks.models import Task
    from app.tasks.runner import TaskRunError

    task = Task(user_id=user.id, title="Mine", prompt="", frequency="daily")
    graph = FlowGraph.model_validate(_chain(_asked(), _node("a", "home.device", box=str(uuid.uuid4()), entity="light.lamp", action="turn_on"), _node("o", "output.report")))
    with pytest.raises(TaskRunError, match="only work in a home's own automations"):
        await run_graph_flow(task=task, graph=graph, user=user, run_started_at=datetime.now(timezone.utc), db=db)


async def test_a_home_changing_hands_takes_its_automations_with_it(user, client, db):  # noqa: F811
    from app.home import automations
    from app.tasks.models import Task

    await _turn_on(client, user)
    sam, kim = await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam)
    made = await _make(client, sam, home_id)
    kim_id = kim.id
    await automations.rehome(db, uuid.UUID(home_id), kim_id)
    await db.commit()
    row = await db.get(Task, uuid.UUID(made["id"]))
    await db.refresh(row)
    assert row.user_id == kim_id
    await box.hang_up()
    await task
