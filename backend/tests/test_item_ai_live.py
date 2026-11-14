"""The item assistant never leaves a turn hanging, and never does it twice.

Owner report 2026-11-12: Meals & Macros sat on "Thinking…" after "I had 2
lolly snakes, and another scotch finger", and an earlier reply said a lunch
he'd asked for once was "already in today's diary". A turn now runs on its
own (a dropped connection doesn't lose it), one at a time; a model that dies
or goes quiet ends the turn with what was done kept, or a plain error with
"try again"; and each later step is told what this reply already did."""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest

from tests.test_item_meals import _auth, client  # noqa: F401


class _Model:
    """Scripted ``stream_chat_events``: each call plays the next hop. A hop
    may ``raise`` a ProviderError, ``hang`` forever, or wait for ``gate``."""

    def __init__(self, hops, gate: asyncio.Event | None = None):
        self.hops = list(hops)
        self.calls: list[dict] = []
        self.gate = gate

    async def stream_chat_events(self, **kw):
        from app.models_config.provider import FinishEvent, ProviderError, TextDelta, ToolCallDelta

        self.calls.append(kw)
        hop = self.hops.pop(0) if self.hops else {"text": "done"}
        if self.gate is not None and len(self.calls) == 1:
            await self.gate.wait()
        if hop.get("raise"):
            raise ProviderError(hop["raise"])
        if hop.get("hang"):
            await asyncio.sleep(3600)
        if hop.get("text"):
            yield TextDelta(text=hop["text"])
        for i, (name, args) in enumerate(hop.get("tools", [])):
            yield ToolCallDelta(index=i, id=f"call{i}{len(self.calls)}", name=name, arguments=json.dumps(args))
        yield FinishEvent(reason="tool_calls" if hop.get("tools") else "stop")


LOG = ("log_foods", {"slot": "snacks", "items": [{"name": "Scotch Finger", "portion": "1 biscuit", "kcal": 88, "protein": 1, "carbs": 12, "fat": 4}]})


async def _meals(client, user) -> str:  # noqa: F811
    h = _auth(user)
    await client.post("/api/items/store/meals", headers=h)
    return (await client.post("/api/items", headers=h, json={"kind": "meals", "title": "Food"})).json()["file_id"]


async def _turn(db, user, fid, message, fake, monkeypatch, **kw):
    from app.items import ai
    from app.models_config import provider as prov

    monkeypatch.setattr(prov, "model_router", fake)
    return [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), message, object(), "m", can_edit=True, **kw)]


def _entries(data: dict) -> list[str]:
    return [e["name"] for day in data["days"].values() for e in day["entries"]]


# ------------------------------------------------------------ the turn itself


async def test_a_model_that_dies_after_logging_keeps_the_food_and_says_so(client, db, user, monkeypatch):  # noqa: F811
    fid = await _meals(client, user)
    events = await _turn(db, user, fid, "a scotch finger", _Model([{"tools": [LOG]}, {"raise": "503 overloaded"}]), monkeypatch)

    done = events[-1]
    assert done["type"] == "done" and done["changed"] and done["version_id"]
    assert _entries(done["data"]) == ["Scotch Finger"]
    said = "".join(e["text"] for e in events if e["type"] == "text")
    assert "Logged Scotch Finger" in said and "saved" in said
    thread = (await client.get(f"/api/items/{fid}/ai", headers=_auth(user))).json()["turns"]
    assert thread[0]["content"] == "a scotch finger" and "Logged Scotch Finger" in thread[1]["content"]


async def test_a_model_that_goes_quiet_ends_the_turn_with_try_again(client, db, user, monkeypatch):  # noqa: F811
    from app.items import ai

    monkeypatch.setattr(ai, "STREAM_IDLE_S", 0.2)
    fid = await _meals(client, user)
    events = await asyncio.wait_for(_turn(db, user, fid, "a scotch finger", _Model([{"hang": True}]), monkeypatch), 10)

    assert [e["type"] for e in events] == ["error"]
    assert events[0]["retry"] is True and "Nothing was changed" in events[0]["message"]
    got = (await client.get(f"/api/items/{fid}/ai", headers=_auth(user))).json()
    assert got["turns"] == [] and got["running"] is None


async def test_a_model_that_goes_quiet_after_logging_still_saves_it(client, db, user, monkeypatch):  # noqa: F811
    from app.items import ai

    monkeypatch.setattr(ai, "STREAM_IDLE_S", 0.2)
    fid = await _meals(client, user)
    events = await asyncio.wait_for(_turn(db, user, fid, "a scotch finger", _Model([{"tools": [LOG]}, {"hang": True}]), monkeypatch), 10)

    assert events[-1]["type"] == "done" and _entries(events[-1]["data"]) == ["Scotch Finger"]


async def test_an_empty_answer_is_an_error_not_an_empty_bubble(client, db, user, monkeypatch):  # noqa: F811
    fid = await _meals(client, user)
    events = await _turn(db, user, fid, "hello?", _Model([{"text": ""}]), monkeypatch)

    assert [e["type"] for e in events] == ["error"] and events[0]["retry"] is True


async def test_an_empty_answer_after_logging_says_what_was_done(client, db, user, monkeypatch):  # noqa: F811
    fid = await _meals(client, user)
    events = await _turn(db, user, fid, "a scotch finger", _Model([{"tools": [LOG]}, {"text": ""}]), monkeypatch)

    said = "".join(e["text"] for e in events if e["type"] == "text")
    assert said.startswith("Done:") and "Logged Scotch Finger" in said
    assert events[-1]["type"] == "done" and events[-1]["changed"]


async def test_later_steps_are_told_what_this_reply_already_did(client, db, user, monkeypatch):  # noqa: F811
    """The data in the prompt is rebuilt after each change: without the note,
    a model read its own minute-old entry as "already in today's diary"."""
    fid = await _meals(client, user)
    fake = _Model([{"tools": [LOG]}, {"text": "Logged it."}])
    await _turn(db, user, fid, "a scotch finger", fake, monkeypatch)

    assert "Already done in THIS reply" not in fake.calls[0]["system"]
    second = fake.calls[1]["system"]
    assert "Already done in THIS reply" in second and "Logged Scotch Finger" in second and "Don't do them again" in second


async def test_the_panel_says_what_it_is_looking_up():
    from app.items.ai import _doing

    assert _doing("web_search", {"query": "GYG mini cali burrito nutrition"}) == "Searching the web for “GYG mini cali burrito nutrition”…"
    assert _doing("fetch_page", {"url": "https://www.guzmanygomez.com.au/nutrition.pdf"}) == "Reading guzmanygomez.com.au…"
    assert _doing("search_foods", {"queries": ["lolly snakes", "scotch finger"]}) == "Looking up “lolly snakes, scotch finger”…"
    assert _doing("log_foods", {}) == "Logging foods…"
    assert _doing("web_search") == "Searching the web…"


# ---------------------------------------------------- the turn on its own legs


@pytest.fixture
def served(monkeypatch):
    """The endpoint with a scripted model: give it the model, get the events."""
    import app.chat.router as chat_router
    import app.files.editor_ai as ea
    from app.items import ai
    from app.models_config import provider as prov

    async def resolve(db, user, provider_id, model_id):
        return object(), "fake"

    async def quotas(request, user, db):
        return None

    monkeypatch.setattr(ea, "resolve_model", resolve)
    monkeypatch.setattr(chat_router, "_enforce_send_quotas", quotas)

    def use(fake):
        monkeypatch.setattr(prov, "model_router", fake)
        return fake

    yield use
    ai._LIVE.clear()


def _events(body: str) -> list[dict]:
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]


async def _until(check, seconds: float = 10.0):
    for _ in range(int(seconds / 0.05)):
        if check():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("never happened")


async def test_a_turn_finishes_after_whoever_asked_has_gone(client, db, user, served):  # noqa: F811
    """The phone locked (or the tunnel dropped the stream) mid-turn: the food
    is still logged, and the thread says so when the panel comes back."""
    from app.items import ai

    fid = await _meals(client, user)
    gate = asyncio.Event()
    served(_Model([{"tools": [LOG]}, {"text": "Logged a Scotch Finger, 88 kcal."}], gate=gate))
    h = _auth(user)
    asking = asyncio.create_task(client.post(f"/api/items/{fid}/ai", headers=h, json={"message": "a scotch finger", "client_id": "t1"}))
    await _until(lambda: (uuid.UUID(fid), user.id) in ai._LIVE)

    # Still going: the thread says so, and a second ask is turned away (no second log).
    got = (await client.get(f"/api/items/{fid}/ai", headers=h)).json()
    assert got["running"]["message"] == "a scotch finger" and got["running"]["client_id"] == "t1"
    again = await client.post(f"/api/items/{fid}/ai", headers=h, json={"message": "a scotch finger", "client_id": "t2"})
    assert again.status_code == 409

    asking.cancel()  # whoever asked goes away
    await asyncio.gather(asking, return_exceptions=True)
    gate.set()
    await _until(lambda: (uuid.UUID(fid), user.id) not in ai._LIVE)

    got = (await client.get(f"/api/items/{fid}/ai", headers=h)).json()
    assert got["running"] is None
    assert [t.get("cid") for t in got["turns"]] == ["t1", "t1"] and got["turns"][1]["content"] == "Logged a Scotch Finger, 88 kcal."
    data = (await client.get(f"/api/items/{fid}", headers=h)).json()["data"]
    assert _entries(data) == ["Scotch Finger"]  # once


async def test_a_panel_that_reconnects_gets_the_turn_from_its_first_event(client, db, user, served, monkeypatch):  # noqa: F811
    from app.items import ai

    monkeypatch.setattr(ai, "KEEPALIVE_S", 0.1)
    fid = await _meals(client, user)
    gate = asyncio.Event()
    served(_Model([{"tools": [LOG]}, {"text": "Logged."}], gate=gate))
    h = _auth(user)
    asking = asyncio.create_task(client.post(f"/api/items/{fid}/ai", headers=h, json={"message": "a scotch finger", "client_id": "t1"}))
    await _until(lambda: (uuid.UUID(fid), user.id) in ai._LIVE)
    following = asyncio.create_task(client.get(f"/api/items/{fid}/ai/live", headers=h))
    await asyncio.sleep(0.4)  # quiet: only keep-alives go out
    gate.set()
    first, second = await asyncio.gather(asking, following)

    assert ": keep-alive" in first.text
    for body in (first.text, second.text):
        kinds = [e["type"] for e in _events(body)]
        assert kinds[-1] == "done" and "action" in kinds and "text" in kinds
    # Nothing running now: nothing to follow.
    assert (await client.get(f"/api/items/{fid}/ai/live", headers=h)).status_code == 204


async def test_stop_ends_the_turn_and_saves_nothing(client, db, user, served):  # noqa: F811
    from app.items import ai

    fid = await _meals(client, user)
    served(_Model([{"tools": [LOG]}, {"hang": True}]))
    h = _auth(user)
    asking = asyncio.create_task(client.post(f"/api/items/{fid}/ai", headers=h, json={"message": "a scotch finger", "client_id": "t1"}))
    await _until(lambda: (uuid.UUID(fid), user.id) in ai._LIVE and any(e["type"] == "action" for e in ai._LIVE[(uuid.UUID(fid), user.id)].events))

    assert (await client.post(f"/api/items/{fid}/ai/stop", headers=h)).json()["stopped"] is True
    res = await asyncio.wait_for(asking, 10)

    last = _events(res.text)[-1]
    assert last["type"] == "error" and "Stopped" in last["message"]
    data = (await client.get(f"/api/items/{fid}", headers=h)).json()["data"]
    assert _entries(data) == []
    assert (await client.get(f"/api/items/{fid}/ai", headers=h)).json()["turns"] == []


async def test_someone_elses_turn_is_not_yours_to_follow_or_stop(client, db, user, served):  # noqa: F811
    from app.auth.models import User
    from app.items import ai

    fid = await _meals(client, user)
    other = User(email=f"o-{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    await db.refresh(other)
    gate = asyncio.Event()
    served(_Model([{"text": "hi"}], gate=gate))
    asking = asyncio.create_task(client.post(f"/api/items/{fid}/ai", headers=_auth(user), json={"message": "hello"}))
    await _until(lambda: (uuid.UUID(fid), user.id) in ai._LIVE)

    assert (await client.get(f"/api/items/{fid}/ai/live", headers=_auth(other))).status_code == 404
    assert (await client.post(f"/api/items/{fid}/ai/stop", headers=_auth(other))).status_code == 404
    gate.set()
    await asking


# --------------------------------------------------------- "another one"


async def test_another_one_logs_the_same_food_with_the_same_numbers(client, db, user):  # noqa: F811
    fid = await _meals(client, user)
    h = _auth(user)

    async def act(name, args):
        r = await client.post(f"/api/items/{fid}/actions/{name}", headers=h, json={"args": args})
        assert r.status_code == 200, r.text
        return r.json()

    first = await act("log_foods", {"slot": "snacks", "items": [LOG[1]["items"][0], {"name": "Lolly snakes", "portion": "2 snakes", "kcal": 60, "carbs": 14}]})
    eid = first["result"]["entries"][0]["id"]

    found = (await act("search_foods", {"queries": ["scotch finger", "lolly snake", "egg"]}))["result"]["results"]
    assert [f["query"] for f in found] == ["scotch finger", "lolly snake", "egg"]
    before = found[0]["eaten_before"]
    assert before[0]["entry_id"] == eid and before[0]["kcal"] == 88 and before[0]["portion"] == "1 biscuit"
    assert found[1]["eaten_before"][0]["name"] == "Lolly snakes"
    assert found[2]["eaten_before"] == [] and any(f["food_id"] == "b:egg" for f in found[2]["foods"])
    # One query keeps its old shape, plus what was eaten before.
    one = (await act("search_foods", {"query": "scotch"}))["result"]
    assert one["query"] == "scotch" and one["eaten_before"][0]["entry_id"] == eid and "foods" in one

    again = await act("log_foods", {"slot": "snacks", "items": [{"name": "Scotch Finger", "repeat_entry_id": eid, "repeat_times": 2}]})
    e = again["result"]["entries"][0]
    assert e["name"] == "Scotch Finger" and e["kcal"] == 176 and e["estimate"] is True
    assert again["result"]["day_total"]["kcal"] == 88 + 60 + 176

    r = await client.post(f"/api/items/{fid}/actions/log_foods", headers=h, json={"args": {"items": [{"name": "x", "repeat_entry_id": "nope"}]}})
    assert r.status_code == 400 or "No diary entry" in r.text


async def test_the_assistant_is_given_todays_entries_and_recent_foods_with_ids(client, db, user, monkeypatch):  # noqa: F811
    """"Another scotch finger" in one step: the id is in the prompt, no search first."""
    fid = await _meals(client, user)
    h = _auth(user)
    r = await client.post(f"/api/items/{fid}/actions/log_foods", headers=h, json={"args": LOG[1]})
    eid = r.json()["result"]["entries"][0]["id"]
    fake = _Model([{"tools": [("log_foods", {"slot": "snacks", "items": [{"name": "Scotch Finger", "repeat_entry_id": eid}]})]}, {"text": "Logged another Scotch Finger, 88 kcal."}])
    events = await _turn(db, user, fid, "another scotch finger", fake, monkeypatch)

    system = fake.calls[0]["system"]
    assert "Today's entries" in system and "Eaten in the last few weeks" in system
    assert f"- {eid}: Snacks: Scotch Finger (1 biscuit, ~88 kcal" in system and "kcal and" in system
    entries = [e for day in events[-1]["data"]["days"].values() for e in day["entries"]]
    assert [(e["name"], e["n"]["kcal"]) for e in entries] == [("Scotch Finger", 88), ("Scotch Finger", 88)]
    assert len({e["id"] for e in entries}) == 2


async def test_the_box_asks_what_you_ate(client, db, user):  # noqa: F811
    fid = await _meals(client, user)
    spec = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["spec"]
    assert spec["ai_placeholder"] == "What did you eat?"


def test_a_model_failure_is_said_in_plain_words():
    from app.items.ai import _model_failure

    assert _model_failure("Connection error talking to the model: peer closed connection (incomplete chunked read)") == "The model didn't finish its answer."
    assert "quota" in _model_failure("429 rate limit exceeded")
    assert "Admin" in _model_failure("401 Unauthorized: invalid api key")
