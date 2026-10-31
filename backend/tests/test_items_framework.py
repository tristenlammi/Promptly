"""The Item Store framework (app/items): files whose whole state is
validated JSON, the store, saves with revisions, actions, the AI panel's
turn, Undo, reminders, downloads, and items from a normal chat."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import httpx
import pytest
from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemSpec, Reminder


# ----------------------------------------------------------- a tiny kind


class Entry(BaseModel):
    id: str
    text: str = Field(max_length=200)
    done: bool = False
    due: str | None = None  # ISO datetime


class TodoData(BaseModel):
    entries: list[Entry] = Field(default_factory=list)
    goal: str = ""


class AddEntry(BaseModel):
    text: str
    due: str | None = None


def _add(ctx, data, p: AddEntry) -> ActionOutcome:
    eid = f"e{len(data['entries']) + 1}"
    data["entries"].append({"id": eid, "text": p.text, "done": False, "due": p.due})
    return ActionOutcome(summary=f"Added “{p.text}”", result={"id": eid})


class Tick(BaseModel):
    id: str


def _tick(ctx, data, p: Tick) -> ActionOutcome:
    for e in data["entries"]:
        if e["id"] == p.id:
            e["done"] = True
            return ActionOutcome(summary=f"Ticked {e['text']}")
    raise ActionError("No entry with that id.")


class Nothing(BaseModel):
    pass


def _count(ctx, data, p) -> ActionOutcome:
    return ActionOutcome(summary="", result={"open": sum(1 for e in data["entries"] if not e["done"])})


def _reminders(data, ctx):
    out = []
    for e in data["entries"]:
        if e.get("due") and not e["done"]:
            out.append(Reminder(key=f"todo:{e['id']}", due_at=datetime.fromisoformat(e["due"]), title=e["text"]))
    return out


TEST_SPEC = ItemSpec(
    kind="testtodo",
    name="Test Todo",
    tagline="A list",
    description="A list for tests.",
    category="Habits & journal",
    icon="list",
    color="#888888",
    suffix=".testtodo",
    model=TodoData,
    template=lambda ctx: {"entries": [], "goal": ""},
    to_text=lambda d: "\n".join(f"[{'x' if e['done'] else ' '}] {e['text']}" for e in d["entries"]),
    actions=[
        ItemAction("add_entry", "Add an entry", AddEntry, _add),
        ItemAction("tick", "Tick an entry", Tick, _tick),
        ItemAction("count_open", "How many are open", Nothing, _count, writes=False),
    ],
    ai_brief="Be a good list keeper.",
    reminders=_reminders,
)


@pytest.fixture(autouse=True)
def _kind():
    from app.items import registry

    registry.register(TEST_SPEC)
    yield
    registry.unregister("testtodo")


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


async def _other(db, role="user"):
    from app.auth.models import User

    u = User(email=f"o-{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _new(client, user, **kw):
    r = await client.post("/api/items/store/testtodo", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "testtodo", "title": "Groceries", **kw})
    assert r.status_code == 201, r.text
    return r.json()


# ----------------------------------------------------------------- tests


async def test_nothing_is_on_until_you_add_it(client, user):
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "testtodo"})
    assert r.status_code == 400 and "Item Store" in r.json()["detail"]
    store = (await client.get("/api/items/store", headers=_auth(user))).json()["items"]
    assert any(i["kind"] == "testtodo" and not i["installed"] for i in store)
    item = await _new(client, user)
    assert item["title"] == "Groceries" and item["filename"] == "Groceries.testtodo"
    assert item["revision"] == 1 and item["data"] == {"entries": [], "goal": ""}
    store = (await client.get("/api/items/store", headers=_auth(user))).json()["items"]
    assert any(i["kind"] == "testtodo" and i["installed"] and i["files"] == 1 for i in store)
    # Removing it from the store keeps the file.
    await client.delete("/api/items/store/testtodo", headers=_auth(user))
    assert (await client.get(f"/api/items/{item['file_id']}", headers=_auth(user))).status_code == 200


async def test_saves_are_validated_and_stale_ones_get_the_newer_state(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    good = {"entries": [{"id": "a", "text": "milk"}], "goal": ""}
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": good, "base_revision": 1})
    assert r.status_code == 200 and r.json()["revision"] == 2
    assert r.json()["data"]["entries"][0]["done"] is False  # normalised by the model
    stale = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": {"entries": []}, "base_revision": 1})
    assert stale.status_code == 409 and stale.json()["revision"] == 2
    assert stale.json()["data"]["entries"][0]["text"] == "milk"
    bad = await client.put(
        f"/api/items/{fid}", headers=_auth(user), json={"data": {"entries": [{"text": 5}]}, "base_revision": 2}
    )
    assert bad.status_code == 400
    # The search text follows the data.
    from app.files.models import UserFile
    from app.database import SessionLocal

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "milk" in row.content_text and row.size_bytes > 0


async def test_actions_from_the_ui(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    r = await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": "eggs"}})
    assert r.status_code == 200, r.text
    assert r.json()["summary"] == "Added “eggs”" and r.json()["revision"] == 2
    r = await client.post(f"/api/items/{fid}/actions/count_open", headers=_auth(user), json={})
    assert r.json()["result"] == {"open": 1} and r.json()["revision"] == 2
    r = await client.post(f"/api/items/{fid}/actions/tick", headers=_auth(user), json={"args": {"id": "nope"}})
    assert r.status_code == 400 and "No entry" in r.json()["detail"]


async def test_strangers_get_404_and_readers_cant_write(client, db, user):
    item = await _new(client, user)
    fid = item["file_id"]
    stranger = await _other(db)
    assert (await client.get(f"/api/items/{fid}", headers=_auth(stranger))).status_code == 404
    # Share read-only: they can read and run read-only actions, not write.
    from app.files.models import ResourceGrant

    db.add(ResourceGrant(resource_type="file", resource_id=uuid.UUID(fid), grantee_user_id=stranger.id, granted_by_user_id=user.id))
    await db.commit()
    got = await client.get(f"/api/items/{fid}", headers=_auth(stranger))
    assert got.status_code == 200 and got.json()["access"] == "read"
    w = await client.put(f"/api/items/{fid}", headers=_auth(stranger), json={"data": {"entries": []}, "base_revision": 1})
    assert w.status_code == 404
    assert (await client.post(f"/api/items/{fid}/actions/count_open", headers=_auth(stranger), json={})).status_code == 200
    assert (await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(stranger), json={"args": {"text": "x"}})).status_code == 404


async def test_download_is_the_whole_file_as_json_and_it_imports_back(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": "eggs"}})
    r = await client.get(f"/api/files/{fid}/download", headers=_auth(user))
    assert r.status_code == 200, r.text
    body = json.loads(r.content)
    assert body["promptly_item"] == "testtodo" and body["data"]["entries"][0]["text"] == "eggs"
    # One app = one file: importing a second copy is refused while the first exists…
    again = await client.post("/api/items", headers=_auth(user), json={"kind": "testtodo", "title": "Copy", "data": body})
    assert again.status_code == 409
    # …and works once it's gone.
    await client.post("/api/files/bulk/trash", headers=_auth(user), json={"file_ids": [fid], "folder_ids": []})
    again = await client.post("/api/items", headers=_auth(user), json={"kind": "testtodo", "title": "Copy", "data": body})
    assert again.status_code == 201 and again.json()["data"]["entries"][0]["text"] == "eggs"


async def test_rename_keeps_the_suffix(client, user):
    item = await _new(client, user)
    r = await client.patch(f"/api/files/{item['file_id']}", headers=_auth(user), json={"filename": "Weekly shop"})
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/items/{item['file_id']}", headers=_auth(user))).json()
    assert got["filename"] == "Weekly shop.testtodo" and got["title"] == "Weekly shop"


async def test_reminders_follow_the_data_and_are_sent_once(client, db, user, monkeypatch):
    from sqlalchemy import select

    from app.items import loops
    from app.items.models import ItemReminder

    sent = []

    async def fake_notify(**kw):
        sent.append(kw)

    monkeypatch.setattr("app.notifications.dispatch.notify_user", fake_notify)
    item = await _new(client, user)
    fid = item["file_id"]
    soon = (datetime.now().astimezone() + timedelta(seconds=1)).isoformat()
    later = (datetime.now().astimezone() + timedelta(days=3)).isoformat()
    far = (datetime.now().astimezone() + timedelta(days=30)).isoformat()
    for text, due in (("call", soon), ("dentist", later), ("someday", far)):
        await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": text, "due": due}})
    rows = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert sorted(r.title for r in rows) == ["call", "dentist"]  # beyond the horizon waits
    import asyncio

    await asyncio.sleep(1.2)
    from app.database import SessionLocal

    async with SessionLocal() as s:
        assert await loops.send_due(s) == 1
    async with SessionLocal() as s:
        assert await loops.send_due(s) == 0
    assert sent[0]["title"] == "call" and sent[0]["url"] == f"/files/item/{fid}"
    # Saving again doesn't resend the one already sent.
    await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": "more"}})
    async with SessionLocal() as s:
        assert await loops.send_due(s) == 0


# --------------------------------------------------------------- the AI


class _FakeModel:
    """Scripted ``stream_chat_events``: each call yields the next hop."""

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


async def _turn(db, user, fid, message, fake, monkeypatch):
    from app.items import ai
    from app.models_config import provider as prov

    monkeypatch.setattr(prov, "model_router", fake)
    events = []
    async for ev in ai.run_turn(db, user, uuid.UUID(fid), message, object(), "m", can_edit=True):
        events.append(ev)
    return events


async def test_the_ai_changes_the_file_through_actions_and_patches_and_can_be_undone(client, db, user, monkeypatch):
    item = await _new(client, user)
    fid = item["file_id"]
    fake = _FakeModel(
        [
            {"tools": [("add_entry", {"text": "bread"}), ("add_entry", {"text": "jam"})]},
            {"tools": [("update_data", {"ops": [{"op": "replace", "path": "/goal", "value": "Breakfast"}], "why": "Set the goal"})]},
            {"tools": [("update_data", {"ops": [{"op": "add", "path": "/entries/-", "value": {"text": 3}}]})]},
            {"text": "Added bread and jam."},
        ]
    )
    events = await _turn(db, user, fid, "plan breakfast", fake, monkeypatch)
    actions = [e for e in events if e["type"] == "action"]
    assert [a["ok"] for a in actions] == [True, True, True, False]  # the invalid patch was refused
    done = events[-1]
    assert done["type"] == "done" and done["changed"] and done["version_id"]
    assert [e["text"] for e in done["data"]["entries"]] == ["bread", "jam"] and done["data"]["goal"] == "Breakfast"
    # The system prompt carried the brief, the data and today's date.
    assert "Be a good list keeper." in fake.calls[0]["system"] and '"entries":[]' in fake.calls[0]["system"]
    # One save for the whole turn.
    assert done["revision"] == 2
    # The thread is kept.
    thread = (await client.get(f"/api/items/{fid}/ai", headers=_auth(user))).json()["turns"]
    assert thread[0]["content"] == "plan breakfast" and thread[1]["content"] == "Added bread and jam."
    # Undo.
    r = await client.post(f"/api/items/{fid}/restore/{done['version_id']}", headers=_auth(user))
    assert r.status_code == 200 and r.json()["data"]["entries"] == []


async def test_the_ais_writes_are_replayed_when_the_file_changed_meanwhile(client, db, user, monkeypatch):
    item = await _new(client, user)
    fid = item["file_id"]

    class Interleaved(_FakeModel):
        async def stream_chat_events(self, **kw):
            if len(self.calls) == 1:  # someone saves while the AI works
                from app.database import SessionLocal
                from app.items import service

                async with SessionLocal() as s:
                    row, doc, _ = await service.load(s, user, uuid.UUID(fid), need="edit", lock=True)
                    data = dict(doc.data)
                    data["entries"] = [*data["entries"], {"id": "x", "text": "from phone", "done": False}]
                    await service.save_data(s, user, row, doc, data, base_revision=doc.revision)
                    await s.commit()
            async for ev in super().stream_chat_events(**kw):
                yield ev

    fake = Interleaved([{"tools": [("add_entry", {"text": "bread"})]}, {"text": "ok"}])
    events = await _turn(db, user, fid, "add bread", fake, monkeypatch)
    texts = [e["text"] for e in events[-1]["data"]["entries"]]
    assert texts == ["from phone", "bread"]


async def test_a_reader_gets_no_write_tools(client, db, user):
    from app.items.ai import tools_for

    names = {t["function"]["name"] for t in tools_for(TEST_SPEC, can_edit=False)}
    assert names == {"count_open", "read_data", "find_my_files", "read_my_file"}
    names = {t["function"]["name"] for t in tools_for(TEST_SPEC, can_edit=True)}
    assert {"add_entry", "tick", "update_data"} <= names
    # Parameter schemas are inlined (no $ref) for providers that reject refs.
    assert "$ref" not in json.dumps(tools_for(TEST_SPEC, can_edit=True))


# ------------------------------------------------------------ from a chat


async def test_a_chat_can_read_and_use_an_item(client, db, user):
    from app.chat.tools import ToolContext
    from app.chat.tools.base import ToolError
    from app.chat.tools.items import ListMyItemsTool, ReadItemTool, UseItemTool, has_items

    item = await _new(client, user)
    fid = item["file_id"]
    assert await has_items(db, user.id)
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    listed = await ListMyItemsTool().run(ctx, {})
    assert fid in listed.content and "Test Todo" in listed.content
    read = await ReadItemTool().run(ctx, {"title": "groceries"})
    assert "add_entry" in read.content and "params" in read.content
    used = await UseItemTool().run(ctx, {"file_id": fid, "action": "add_entry", "args": {"text": "tea"}})
    assert "Added “tea”" in used.content
    got = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    assert got["data"]["entries"][0]["text"] == "tea"
    # A turn that read outside content can't write.
    ctx.turn["untrusted"] = True
    with pytest.raises(ToolError):
        await UseItemTool().run(ctx, {"file_id": fid, "action": "add_entry", "args": {"text": "evil"}})


async def test_admin_can_hide_a_kind(client, db, user):
    other = await _other(db)
    r = await client.put("/api/items/store/admin", headers=_auth(user), json={"disabled": ["testtodo", "nope"]})
    assert r.status_code == 200 and r.json()["disabled"] == ["testtodo"]
    store = (await client.get("/api/items/store", headers=_auth(other))).json()["items"]
    assert not any(i["kind"] == "testtodo" for i in store)
    assert (await client.post("/api/items/store/testtodo", headers=_auth(other))).status_code == 404
    assert (await client.put("/api/items/store/admin", headers=_auth(other), json={"disabled": []})).status_code == 403


async def test_an_undone_ai_turn_stays_undone(client, db, user, monkeypatch):
    item = await _new(client, user)
    fid = item["file_id"]
    events = await _turn(db, user, fid, "add", _FakeModel([{"tools": [("add_entry", {"text": "x"})]}, {"text": "ok"}]), monkeypatch)
    vid = events[-1]["version_id"]
    assert (await client.post(f"/api/items/{fid}/restore/{vid}", headers=_auth(user))).status_code == 200
    thread = (await client.get(f"/api/items/{fid}/ai", headers=_auth(user))).json()["turns"]
    assert thread[-1]["undone"] is True


async def test_the_app_manifest_is_public_and_reads_nothing(client):
    fid = uuid.uuid4()
    r = await client.get(f"/api/items/app/testtodo/manifest.webmanifest", params={"id": str(fid), "name": "Shop <b>"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/manifest+json")
    m = r.json()
    assert m["name"] == "Shop b" and m["scope"] == f"/app/{fid}/" and m["start_url"].startswith(m["scope"])
    assert m["display"] == "standalone" and m["icons"][0]["src"] == "/item-icons/item-192.png"
    assert (await client.get("/api/items/app/nope/manifest.webmanifest", params={"id": str(fid)})).status_code == 404


async def test_an_action_refuses_fields_it_doesnt_know(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    r = await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"txt": "milk"}})
    assert r.status_code == 400 and "Unknown field 'txt'" in r.json()["detail"] and "text" in r.json()["detail"]
    ok = await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": "milk", "due": None}})
    assert ok.status_code == 200


def test_tool_schemas_keep_fields_named_title():
    from app.items.ai import _inline_refs

    class Inner(BaseModel):
        title: str

    class P(BaseModel):
        title: str = Field(description="Why")
        rows: list[Inner] = Field(default_factory=list)

    s = _inline_refs(P.model_json_schema())
    assert "title" in s["properties"] and s["properties"]["title"]["description"] == "Why"
    assert "title" in s["properties"]["rows"]["items"]["properties"]
    assert not isinstance(s.get("title"), str)  # the model's own label is gone


def test_every_apps_tool_schemas_are_valid_json_schema():
    """Anthropic validates tool input schemas against draft 2020-12. A depth
    guard used to blank the leaves of deep schemas (``"type": {}``), so every
    AI-panel turn with a Claude model failed with a 400."""
    from jsonschema import Draft202012Validator

    from app.items.ai import tools_for
    from app.items.registry import all_specs

    def blanks(node, path="", in_props=False):
        if isinstance(node, dict):
            for k, v in node.items():
                # Under "properties" keys are field names (a field may be called "type").
                if not in_props and k in ("type", "minimum", "maximum", "maxLength", "exclusiveMinimum", "pattern") and isinstance(v, dict):
                    yield f"{path}/{k}"
                yield from blanks(v, f"{path}/{k}", in_props=(k == "properties" and not in_props))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                yield from blanks(v, f"{path}/{i}")

    for spec in all_specs().values():
        for tool in tools_for(spec, can_edit=True):
            params = tool["function"]["parameters"]
            Draft202012Validator.check_schema(params)
            assert not list(blanks(params)), (spec.kind, tool["function"]["name"], list(blanks(params))[:3])


def test_diff_round_trips():
    from app.items.ai import apply_patch
    from app.items.jsonpatch import diff

    cases = [
        ({"a": 1, "b": [1, 2]}, {"a": 2, "b": [1, 2, 3], "c": {"x": "y/z~"}}),
        ({"log": [{"id": 1}, {"id": 2}]}, {"log": [{"id": 0}, {"id": -1}, {"id": 1}, {"id": 2}]}),  # newest first
        ({"l": [1, 2, 3]}, {"l": [1, 3]}),
        ({"l": [1, 2, 3]}, {"l": []}),
        ({"k": {"a/b": 1, "t~": 2}}, {"k": {"a/b": 3}}),
        ({"x": None}, {"x": {"deep": [1]}}),
        ({"l": list(range(1000))}, {"l": [*range(500), *range(501, 1000)]}),  # one removed mid-list
        ({"l": list(range(1000))}, {"l": [*range(500), "new", *range(500, 1000)]}),  # one inserted
        ({"l": [1, 2, 3, 4]}, {"l": [9, 2, 3, 8, 7]}),
    ]
    for a, b in cases:
        assert apply_patch(a, diff(a, b)) == b
    assert len(diff({"l": list(range(1000))}, {"l": [*range(500), *range(501, 1000)]})) == 1
    assert len(diff({"l": list(range(1000))}, {"l": [*range(500), "new", *range(500, 1000)]})) == 1


async def test_a_save_can_be_a_small_patch_and_the_fix_comes_back(client, user):
    item = await _new(client, user)
    fid = item["file_id"]
    # The client adds an entry without its default "done"/"due": the server
    # fills them in and says so in the fix.
    patch = [{"op": "add", "path": "/entries/-", "value": {"id": "a", "text": "milk"}}]
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"patch": patch, "base_revision": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 2 and "data" not in body
    assert {"op": "add", "path": "/entries/0/done", "value": False} in body["fix"]
    # A stale patch, and one that doesn't fit, both get the real file back.
    stale = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"patch": patch, "base_revision": 1})
    assert stale.status_code == 409 and stale.json()["revision"] == 2
    bad = await client.put(
        f"/api/items/{fid}", headers=_auth(user),
        json={"patch": [{"op": "replace", "path": "/entries/9/text", "value": "x"}], "base_revision": 2},
    )
    assert bad.status_code == 409 and bad.json()["data"]["entries"][0]["text"] == "milk"
    assert (await client.put(f"/api/items/{fid}", headers=_auth(user), json={"base_revision": 2})).status_code == 400


def test_safe_urls():
    from pydantic import BaseModel as BM, ValidationError

    from app.items.spec import SafeUrl

    class L(BM):
        link: SafeUrl = ""

    assert L(link="https://x.org/a").link == "https://x.org/a"
    assert L(link="example.com/booking").link == "https://example.com/booking"
    assert L(link="mailto:a@b.co").link == "mailto:a@b.co"
    assert L(link="").link == ""
    for bad in ("javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"):
        with pytest.raises(ValidationError):
            L(link=bad)


async def test_archive_moves_older_data_to_a_new_file(client, db, user, monkeypatch):
    import dataclasses

    from app.items import registry

    def archive(data, ctx, before):
        old = [e for e in data["entries"] if e["done"]]
        return ({**data, "entries": [e for e in data["entries"] if not e["done"]]}, {**data, "entries": old})

    registry.register(dataclasses.replace(TEST_SPEC, archive=archive))
    item = await _new(client, user)
    fid = item["file_id"]
    assert item["can_archive"] is True and item["max_bytes"] > 0
    for t in ("a", "b"):
        await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": t}})
    await client.post(f"/api/items/{fid}/actions/tick", headers=_auth(user), json={"args": {"id": "e1"}})
    r = await client.post(f"/api/items/{fid}/archive", headers=_auth(user), json={"before": "2026-01-01"})
    assert r.status_code == 200, r.text
    assert [e["text"] for e in r.json()["data"]["entries"]] == ["b"]
    arch = (await client.get(f"/api/items/{r.json()['archive_id']}", headers=_auth(user))).json()
    assert [e["text"] for e in arch["data"]["entries"]] == ["a"] and "2026-01-01" in arch["title"]


async def test_reminders_reach_editors_when_the_kind_asks(client, db, user):
    import dataclasses

    from sqlalchemy import select

    from app.files.models import ResourceGrant
    from app.items import registry
    from app.items.models import ItemReminder

    registry.register(dataclasses.replace(TEST_SPEC, remind_collaborators=True))
    item = await _new(client, user)
    fid = item["file_id"]
    friend = await _other(db)
    db.add(ResourceGrant(resource_type="file", resource_id=uuid.UUID(fid), grantee_user_id=friend.id, granted_by_user_id=user.id, can_edit=True))
    await db.commit()
    due = (datetime.now().astimezone() + timedelta(hours=2)).isoformat()
    await client.post(f"/api/items/{fid}/actions/add_entry", headers=_auth(user), json={"args": {"text": "flight", "due": due}})
    who = set((await db.execute(select(ItemReminder.user_id).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all())
    assert who == {user.id, friend.id}


async def test_chat_respects_private_kinds(client, db, user):
    import dataclasses

    from app.chat.tools import ToolContext
    from app.chat.tools.base import ToolError
    from app.chat.tools.items import ReadItemTool, UseItemTool
    from app.items import registry

    hidden = dataclasses.replace(TEST_SPEC.actions[2], chat=False)  # count_open
    registry.register(dataclasses.replace(TEST_SPEC, chat_raw=False, actions=[*TEST_SPEC.actions[:2], hidden]))
    item = await _new(client, user)
    fid = item["file_id"]
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    read = await ReadItemTool().run(ctx, {"file_id": fid})
    assert "Data:" not in read.content and "count_open" not in read.content
    with pytest.raises(ToolError):
        await UseItemTool().run(ctx, {"file_id": fid, "action": "count_open"})


async def test_after_restore_runs(client, db, user, monkeypatch):
    import dataclasses

    from app.items import registry

    seen = []

    async def after(db_, file_id):
        seen.append(file_id)

    registry.register(dataclasses.replace(TEST_SPEC, after_restore=after))
    item = await _new(client, user)
    fid = item["file_id"]
    events = await _turn(db, user, fid, "add", _FakeModel([{"tools": [("add_entry", {"text": "x"})]}, {"text": "ok"}]), monkeypatch)
    r = await client.post(f"/api/items/{fid}/restore/{events[-1]['version_id']}", headers=_auth(user))
    assert r.status_code == 200 and seen == [uuid.UUID(fid)]


async def test_apps_live_in_the_apps_folder_and_the_launcher_keeps_order(client, db, user):
    from app.files.models import FileFolder, UserFile

    item = await _new(client, user)
    row = await db.get(UserFile, uuid.UUID(item["file_id"]))
    folder = await db.get(FileFolder, row.folder_id)
    parent = await db.get(FileFolder, folder.parent_id)
    assert folder.name == "Test Todo" and parent.system_kind == "apps" and parent.name == "Apps"
    # Launching opens the most recent file; with none, it makes one.
    opened = (await client.post("/api/items/open/testtodo", headers=_auth(user))).json()
    assert opened == {"file_id": item["file_id"], "created": False}
    apps = (await client.get("/api/items/launcher", headers=_auth(user))).json()["apps"]
    assert [a["kind"] for a in apps] == ["testtodo"] and apps[0]["latest"] == item["file_id"] and apps[0]["files"] == 1
    r = await client.put("/api/items/launcher", headers=_auth(user), json={"order": ["nope", "testtodo", "testtodo"]})
    assert r.json()["order"] == ["nope", "testtodo"]
    apps = (await client.get("/api/items/launcher", headers=_auth(user))).json()["apps"]
    assert [a["kind"] for a in apps] == ["testtodo"]  # unknown kinds are skipped


async def test_launching_an_app_with_no_file_makes_one(client, user):
    import asyncio

    # Two launches at once (React dev mode double-runs effects; a double tap)
    # must still make exactly one file.
    r, r2 = await asyncio.gather(
        client.post("/api/items/open/testtodo", headers=_auth(user)),
        client.post("/api/items/open/testtodo", headers=_auth(user)),
    )
    assert r.status_code == 200 and r2.status_code == 200
    assert r.json()["file_id"] == r2.json()["file_id"]
    assert sorted([r.json()["created"], r2.json()["created"]]) == [False, True]
    got = (await client.get(f"/api/items/{r.json()['file_id']}", headers=_auth(user))).json()
    assert got["kind"] == "testtodo"
    assert (await client.post("/api/items/open/nope", headers=_auth(user))).status_code == 404


async def test_one_app_is_one_file(client, user):
    import asyncio

    first = await _new(client, user)
    again = await client.post("/api/items", headers=_auth(user), json={"kind": "testtodo"})
    assert again.status_code == 200 and again.json()["file_id"] == first["file_id"]
    # Two launches at once agree on one file.
    r1, r2 = await asyncio.gather(
        client.post("/api/items/open/testtodo", headers=_auth(user)),
        client.post("/api/items/open/testtodo", headers=_auth(user)),
    )
    assert r1.json()["file_id"] == r2.json()["file_id"] == first["file_id"]
