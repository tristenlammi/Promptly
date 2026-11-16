"""The home for the assistant (``app/home/assistant.py``, ``chat/tools/home.py``):
it sees and switches only the homes of the person asking, never a lock or a
garage door, and a simple command is done without a model."""
from __future__ import annotations

import asyncio
import uuid

import pytest

from tests.test_home import _answer, _dial, _has_snapshot, _home_with, _prepare, _turn_on, _wait, client  # noqa: F401
from tests.test_maps_timeline import _hdr, _other
from tests.test_talk_turns import sidecars, talk_app  # noqa: F401

AREAS = [{"id": "kitchen", "name": "Kitchen"}, {"id": "lounge", "name": "Lounge"}, {"id": "hall", "name": "Hall"}]
BENCH = {"id": "light.bench", "domain": "light", "name": "Bench", "state": "on", "area": "kitchen", "bri": 80}
CEILING = {"id": "light.ceiling", "domain": "light", "name": "Kitchen ceiling", "state": "off", "area": "kitchen"}
LAMP = {"id": "light.lamp", "domain": "light", "name": "Floor lamp", "state": "off", "area": "lounge"}
SPEAKER = {"id": "media_player.kitchen", "domain": "media_player", "name": "Kitchen speaker", "state": "playing", "area": "kitchen", "x": {"vol": 30, "title": "Song", "artist": "Band", "can": ["pause", "play", "next", "vol", "mute", "preset"]}}
CAST = {"id": "media_player.lounge", "domain": "media_player", "name": "Lounge speaker", "state": "idle", "area": "lounge", "x": {"vol": 20, "can": ["pause", "play", "vol"]}}
MOVIE = {"id": "scene.movie", "domain": "scene", "name": "Movie night", "state": "x", "area": "lounge"}
LOCK = {"id": "lock.front", "domain": "lock", "name": "Front door", "state": "locked", "area": "hall"}
GARAGE = {"id": "cover.garage", "domain": "cover", "name": "Garage", "state": "closed", "cls": "garage"}
AC = {"id": "climate.ac", "domain": "climate", "name": "Air con", "state": "off", "x": {"modes": ["off", "cool"], "cur": 24}}
ALL = [BENCH, CEILING, LAMP, SPEAKER, CAST, MOVIE, LOCK, GARAGE, AC]


async def _home(client, admin, who, entities=ALL):  # noqa: F811
    prepared = await _prepare(client, admin)
    home_id = (await client.post("/api/home/claim", headers=_hdr(who), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": AREAS, "entities": entities})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    return prepared, home_id, box, task


def _quiet(box) -> bool:
    """The box hasn't been asked for anything."""
    return not any(m.get("t") == "req" for m in list(box.from_server._queue))


def _ctx(db, who, **turn):
    from app.chat.tools.base import ToolContext, TurnState

    return ToolContext(db=db, user=who, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=TurnState(**turn))


async def _run(tool, db, who, args, box=None, n=0, **turn):
    """Run a tool; the box says yes to the ``n`` things it's asked."""
    side = asyncio.create_task(_answer(box, n=n)) if box is not None and n else None
    try:
        result = await tool.run(_ctx(db, who, **turn), args)
    except BaseException:
        if side is not None:
            side.cancel()
        raise
    asked = [a for a in await side] if side is not None else []
    return result, [(a["op"], a["args"]) for a in asked]


async def test_only_the_people_in_a_home_see_or_switch_it(user, client, db):  # noqa: F811
    """``user`` is the admin: they prepared the box and still see nothing."""
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeControlTool, HomeDevicesTool
    from app.home import assistant

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    _prepared, _home_id, box, task = await _home(client, user, sam)

    assert await assistant.has_home(db, sam.id) is True
    assert await assistant.has_home(db, ann.id) is False
    assert {d["id"] for d in await assistant.devices_for(db, sam.id)} == {e["id"] for e in ALL}
    for outsider in (ann, user):
        assert await assistant.devices_for(db, outsider.id) == []
        with pytest.raises(ToolError):
            await HomeControlTool().run(_ctx(db, outsider), {"action": "turn_off", "target": "Kitchen"})
        assert await assistant.quick_command(outsider.id, "turn off the kitchen lights") is None
    with pytest.raises(ToolError):
        await HomeDevicesTool().run(_ctx(db, ann), {})
    await box.hang_up()
    await task


async def test_the_list_says_what_everything_is_doing(user, client, db):  # noqa: F811
    from app.chat.tools.home import HomeDevicesTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)
    text = (await HomeDevicesTool().run(_ctx(db, user), {})).content
    assert "Kitchen:" in text and "- Bench [light] on at 80%" in text and "- Kitchen ceiling [light] off" in text
    assert "- Kitchen speaker [speaker] playing, “Song” by Band, volume 30" in text
    assert "- Front door [lock] locked · Home page only" in text
    assert "- Garage [cover] closed · Home page only" in text
    assert "- Air con [climate] off, 24° now · Home page only" in text
    only = (await HomeDevicesTool().run(_ctx(db, user), {"room": "lounge"})).content
    assert "Floor lamp" in only and "Bench" not in only
    await box.hang_up()
    await task


async def test_lights_scenes_and_speakers_are_switched_through_the_box(user, client, db):  # noqa: F811
    from app.chat.tools.home import HomeControlTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)
    tool = HomeControlTool()

    result, asked = await _run(tool, db, user, {"action": "turn_off", "target": "Kitchen"}, box, 1)
    assert asked == [("room.lights", {"area": "kitchen", "action": "turn_off"})] and result.content == "Done: Kitchen lights off."
    _r, asked = await _run(tool, db, user, {"action": "turn_on", "target": "kitchen lights"}, box, 1)
    assert asked == [("room.lights", {"area": "kitchen", "action": "turn_on"})]
    result, asked = await _run(tool, db, user, {"action": "set_light", "target": "Kitchen", "brightness": 40, "colour": "warm white"}, box, 2)
    assert sorted(a[1]["entity"] for a in asked) == ["light.bench", "light.ceiling"]
    assert all(a == ("do", {"entity": a[1]["entity"], "action": "set", "value": {"bri": 40, "k": 2700}}) for a in asked)
    assert result.content == "Done: Kitchen lights at 40% and warm white."
    _r, asked = await _run(tool, db, user, {"action": "set_light", "target": "Floor lamp", "colour": "#ff8800"}, box, 1)
    assert asked == [("do", {"entity": "light.lamp", "action": "set", "value": {"rgb": [255, 136, 0]}})]
    _r, asked = await _run(tool, db, user, {"action": "turn_on", "target": "floor lamp", "brightness": 5}, box, 1)
    assert asked == [("do", {"entity": "light.lamp", "action": "set", "value": {"bri": 5}})]
    _r, asked = await _run(tool, db, user, {"action": "run_scene", "target": "movie night"}, box, 1)
    assert asked == [("do", {"entity": "scene.movie", "action": "run", "value": None})]

    # Nothing named: the speaker that's playing.
    result, asked = await _run(tool, db, user, {"action": "pause"}, box, 1)
    assert asked == [("do", {"entity": "media_player.kitchen", "action": "pause", "value": None})] and result.content == "Done: Paused on Kitchen speaker."
    _r, asked = await _run(tool, db, user, {"action": "set_volume", "target": "Lounge", "volume": 35}, box, 1)
    assert asked == [("do", {"entity": "media_player.lounge", "action": "volume", "value": 35})]
    _r, asked = await _run(tool, db, user, {"action": "mute", "target": "kitchen speaker"}, box, 1)
    assert asked == [("do", {"entity": "media_player.kitchen", "action": "mute", "value": True})]
    _r, asked = await _run(tool, db, user, {"action": "play_preset", "target": "kitchen speaker", "preset": 2}, box, 1)
    assert asked == [("do", {"entity": "media_player.kitchen", "action": "preset", "value": 2})]
    await box.hang_up()
    await task


async def test_what_it_will_not_do_and_what_it_asks_about(user, client, db):  # noqa: F811
    from app.chat.tools.base import HoldForApproval, ToolError
    from app.chat.tools.home import HomeControlTool
    from app.home import assistant

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)
    tool = HomeControlTool()

    async def refused(args, **turn) -> str:
        with pytest.raises(ToolError) as e:
            await tool.run(_ctx(db, user, **turn), args)
        assert _quiet(box), "the box was asked"
        return str(e.value)

    # A lock, a garage door: not from here, whatever the action.
    assert "no light or switch called" in await refused({"action": "turn_off", "target": "Front door"})
    assert "no light or switch called" in await refused({"action": "turn_on", "target": "Garage"})
    lock = next(d for d in await assistant.devices_for(db, user.id) if d["id"] == "lock.front")
    garage = next(d for d in await assistant.devices_for(db, user.id) if d["id"] == "cover.garage")
    await db.commit()
    for device, action in ((lock, "unlock"), (lock, "lock"), (garage, "open")):
        with pytest.raises(assistant.CantDo) as e:
            await assistant.act(device, action)
        assert str(e.value) == assistant.NOT_FROM_HERE
    # Air con is parked for now.
    ac = next(d for d in await assistant.devices_for(db, user.id) if d["id"] == "climate.ac")
    await db.commit()
    with pytest.raises(assistant.CantDo) as e:
        await assistant.act(ac, "turn_on")
    assert str(e.value) == assistant.PARKED
    assert _quiet(box)

    # Two speakers, neither named, none... one is playing, so "play" has nothing paused to pick.
    assert "Which speaker?" in await refused({"action": "play"})
    # More than one thing it could be: it says so, and asks nothing of the box.
    assert "More than one" in await refused({"action": "set_volume", "target": "speaker", "volume": 10})
    assert "Which room's lights?" in await refused({"action": "turn_off", "target": "the lights"})
    # What a device can't do, or a value that won't do.
    assert "can't do that" in await refused({"action": "next", "target": "Lounge speaker"})
    assert "doesn't have numbered presets" in await refused({"action": "play_preset", "target": "Lounge speaker", "preset": 1})
    assert "1 to 100" in await refused({"action": "set_light", "target": "Kitchen", "brightness": 400})
    assert "colour name" in await refused({"action": "set_light", "target": "Kitchen", "colour": "sparkly"})

    # A turn that read a web page: the change waits for a yes...
    with pytest.raises(HoldForApproval):
        await tool.run(_ctx(db, user, untrusted=True), {"action": "turn_off", "target": "Kitchen"})
    assert _quiet(box)
    # ...and the yes runs it.
    _r, asked = await _run(tool, db, user, {"action": "turn_off", "target": "Kitchen"}, box, 1, untrusted=True, user_approved=True)
    assert asked == [("room.lights", {"area": "kitchen", "action": "turn_off"})]
    from app.chat import holds

    assert holds.holdable("home_control")
    assert holds.question("home_control", {"action": "set_volume", "target": "Kitchen speaker", "volume": 80}) == "At home: set volume Kitchen speaker, volume 80?"
    await box.hang_up()
    await task


async def test_a_simple_command_is_done_without_a_model(user, client, db):  # noqa: F811
    from app.home import assistant

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)

    async def said(text: str, n: int = 1):
        side = asyncio.create_task(_answer(box, n=n))
        ran = await assistant.quick_command(user.id, text)
        return ran, [(a["op"], a["args"]) for a in await side]

    ran, asked = await said("Turn off the kitchen lights.")
    assert ran == (True, "Kitchen lights off.") and asked == [("room.lights", {"area": "kitchen", "action": "turn_off"})]
    ran, asked = await said("Set the lounge lights to 30%")
    assert ran == (True, "Lounge lights at 30%.") and asked == [("do", {"entity": "light.lamp", "action": "set", "value": {"bri": 30}})]
    ran, asked = await said("pause the music")
    assert ran == (True, "Paused on Kitchen speaker.") and asked == [("do", {"entity": "media_player.kitchen", "action": "pause", "value": None})]
    ran, asked = await said("turn on movie night")
    assert ran == (True, "Movie night is on.")

    # Not sure, or not a device command: nothing is asked of the box, the model answers.
    for text in ("unlock the front door", "turn off the front door", "turn off the lights", "what's the weather", "play some jazz", "turn on the air con"):
        assert await assistant.quick_command(user.id, text) is None, text
    assert _quiet(box)

    # The box says no: that's what is said.
    async def no():
        ask = await box.hear("req")
        await box.say({"t": "res", "id": ask["id"], "ok": False, "error": "The lamp isn't answering."})

    side = asyncio.create_task(no())
    assert await assistant.quick_command(user.id, "turn on the floor lamp") == (False, "The lamp isn't answering.")
    await side

    # The box is gone: said, not hung on.
    await box.hang_up()
    await task
    ran = await assistant.quick_command(user.id, "turn off the kitchen lights")
    assert ran is not None and ran[0] is False and "offline" in ran[1]


async def test_with_home_switched_off_there_is_nothing(user, client, db):  # noqa: F811
    from app.home import assistant

    assert await assistant.has_home(db, user.id) is False
    assert await assistant.devices_for(db, user.id) == []
    assert await assistant.quick_command(user.id, "turn off the kitchen lights") is None


def test_the_tools_are_offered_to_people_in_a_home_and_on_spoken_turns():
    from app.chat.tools.registry import get_tool, list_openai_tools
    from app.talk import tools as voice

    assert {t["function"]["name"] for t in list_openai_tools({"home"})} == {"home_devices", "home_control"}
    assert get_tool("home_control").category == "home"
    names = voice.voice_tool_names([], device="android")
    assert {"home_devices", "home_control"} <= names
    # They run at once on a spoken turn: a light is easily switched back.
    assert not voice.is_write("home_control")
    assert "home" in voice.CATEGORIES


# ---------------------------------------------------------------- spoken, through Talk
async def test_spoken_a_simple_command_never_reaches_the_model(db, user, conversation, sidecars, talk_app, client, monkeypatch):  # noqa: F811
    from .talk_fakes import Model
    from .test_talk_turns import finish, messages, open_talk, use_model

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)
    model = use_model(monkeypatch, Model(["The model should never be asked."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    side = asyncio.create_task(_answer(box, n=1))
    await live.say(1, "Turn off the kitchen lights.")
    await c.until_audio()
    await c.expect("state", state="listening", timeout=15)
    assert [(a["op"], a["args"]) for a in await side] == [("room.lights", {"area": "kitchen", "action": "turn_off"})]
    assert model.calls == []
    assert sidecars.spoken == ["Kitchen lights off."]
    rows = await messages(db, conversation)
    assert [r.role for r in rows] == ["user", "assistant"] and rows[1].content == "Kitchen lights off."
    assert rows[1].tool_calls[0]["name"] == "home_control" and rows[1].tool_calls[0]["meta"]["source"] == "home_quick"
    assert rows[1].voice["fast_path"] is True
    await finish(c)
    await box.hang_up()
    await task


async def test_spoken_anything_else_goes_to_the_model_with_the_home_tools(db, user, conversation, sidecars, talk_app, client, monkeypatch):  # noqa: F811
    from .talk_fakes import Model
    from .test_talk_turns import finish, open_talk, use_model

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user)
    model = use_model(monkeypatch, Model([{"tool": "home_control", "args": {"action": "set_light", "target": "Lounge", "brightness": 20, "colour": "warm white"}}, "The lounge is cosy now."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    side = asyncio.create_task(_answer(box, n=1))
    await live.say(1, "Make the lounge cosy.")
    await c.find("reply", done=True, timeout=20)
    assert [(a["op"], a["args"]) for a in await side] == [("do", {"entity": "light.lamp", "action": "set", "value": {"bri": 20, "k": 2700}})]
    assert {"home_devices", "home_control"} <= model.tools_offered(0)
    assert "home_control switches lights" in model.system(0)
    assert "The lounge is cosy now." in " ".join(sidecars.spoken)
    await finish(c)
    await box.hang_up()
    await task


async def test_someone_with_no_home_is_not_offered_the_home_tools(db, user, conversation, sidecars, talk_app, monkeypatch):  # noqa: F811
    from .talk_fakes import Model
    from .test_talk_turns import finish, open_talk, use_model

    model = use_model(monkeypatch, Model(["I can't do that."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Turn off the kitchen lights.")
    await c.find("reply", done=True, timeout=20)
    assert len(model.calls) == 1 and not {"home_devices", "home_control"} & model.tools_offered()
    await finish(c)
