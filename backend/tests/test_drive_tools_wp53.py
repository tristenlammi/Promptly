"""Drive chat tools (WP-5.3): find files by type / folder / owner / date,
read one (Docs, Sheets with rows, PDFs, text), and organise them through a
proposal the person applies — all of it or none of it."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from tests.test_drive_index_wp51 import _auth, _upload, _user, client, embedder  # noqa: F401 — fixtures


def _ctx(db, user):
    from app.chat.tools.base import ToolContext

    return ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4())


async def _tool(name):
    from app.chat.tools.registry import get_tool

    t = get_tool(name)
    assert t is not None and t.category in ("files", "drive")
    return t


async def _folder(db, user, name, parent=None, system_kind=None):
    from app.files.models import FileFolder

    f = FileFolder(user_id=user.id, name=name, parent_id=parent.id if parent else None, system_kind=system_kind)
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def _conversation(db, user, provider):
    from app.chat.models import Conversation

    c = Conversation(user_id=user.id, title="Organise", provider_id=provider.id, model_id="test-model")
    db.add(c)
    await db.commit()
    return c


# ---------------------------------------------------------------- finding


@pytest.mark.asyncio
async def test_list_my_files_filters_by_type_folder_owner_name_and_date(client, db, user):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.files.models import UserFile

    taxes = await _folder(db, user, "Taxes")
    y2025 = await _folder(db, user, "2025", parent=taxes)
    a = await _upload(client, user, "invoice-march.pdf", b"%PDF-1.4 x", folder_id=y2025.id, mime="application/pdf")
    await _upload(client, user, "notes.txt", b"hello", folder_id=taxes.id)
    old = await _upload(client, user, "old-receipt.pdf", b"%PDF-1.4 y", mime="application/pdf")
    row = await db.get(UserFile, uuid.UUID(old["id"]))
    row.modified_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db.commit()
    pal = await _user(db, "pal")
    theirs = await _upload(client, pal, "pal-plan.pdf", b"%PDF-1.4 z", mime="application/pdf")
    await client.post(f"/api/files/file/{theirs['id']}/grants", json={"grantee_user_id": str(user.id)},
                      headers=_auth(pal))

    tool = await _tool("list_my_files")
    ctx = _ctx(db, user)
    res = await tool.run(ctx, {"type": "pdf"})
    assert "invoice-march.pdf" in res.content and "pal-plan.pdf" in res.content and "notes.txt" not in res.content
    res = await tool.run(ctx, {"folder": "Taxes"})  # a name — and the subfolder counts
    assert "invoice-march.pdf" in res.content and "notes.txt" in res.content and "old-receipt" not in res.content
    assert "Folders in Taxes:" in res.content and f"2025/ (id: {y2025.id})" in res.content
    res = await tool.run(ctx, {"folder": "Taxes/2025"})
    assert "invoice-march.pdf" in res.content and "notes.txt" not in res.content
    res = await tool.run(ctx, {"owner": "shared"})
    assert "pal-plan.pdf" in res.content and "owner " + pal.username in res.content
    assert "invoice-march" not in res.content
    res = await tool.run(ctx, {"owner": pal.username, "type": "pdf"})
    assert "pal-plan.pdf" in res.content and "invoice-march" not in res.content
    since = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    res = await tool.run(ctx, {"type": "pdf", "modified_after": since, "owner": "me"})
    assert "invoice-march.pdf" in res.content and "old-receipt" not in res.content
    res = await tool.run(ctx, {"name": "RECEIPT"})
    assert "old-receipt.pdf" in res.content and f"(id: {old['id']})" in res.content
    with pytest.raises(ToolError, match="No folder called 'Nope'"):
        await tool.run(ctx, {"folder": "Nope"})
    with pytest.raises(ToolError, match="date"):
        await tool.run(ctx, {"modified_after": "last tuesday"})
    # A stranger's files never show.
    stranger = await _user(db, "sam")
    res = await tool.run(_ctx(db, stranger), {"type": "pdf"})
    assert "No files match" in res.content
    assert a["id"] not in res.content


@pytest.mark.asyncio
async def test_read_file_reads_sheets_with_rows_pages_long_files_and_only_what_you_can_open(client, db, user):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools import files as files_tools
    from app.files.models import UserFile
    from app.files.office import content_for_shell

    tool = await _tool("read_file")
    ctx = _ctx(db, user)

    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Budget"}, headers=_auth(user))
    sheet_id = r.json()["id"]
    entity = await content_for_shell(db, await db.get(UserFile, uuid.UUID(sheet_id)))
    entity.data = [{"name": "Q1", "celldata": [
        {"r": 0, "c": 0, "v": {"v": "Item"}}, {"r": 0, "c": 1, "v": {"v": "Cost"}},
        {"r": 4, "c": 0, "v": {"v": "Rent"}}, {"r": 4, "c": 1, "v": {"v": 900}},
    ]}]
    await db.commit()
    res = await tool.run(ctx, {"file_id": sheet_id})
    assert "[tab: Q1]" in res.content and "[row 5] Rent | 900" in res.content
    assert res.sources[0]["kind"] == "file" and res.sources[0]["url"] == f"/files/f/{sheet_id}"

    long = await _upload(client, user, "long.txt", ("word " * 6000).encode())
    first = await tool.run(ctx, {"file_id": long["id"]})
    assert f"Call read_file with start={files_tools._READ_CAP}" in first.content
    rest = await tool.run(ctx, {"file_id": long["id"], "start": files_tools._READ_CAP})
    assert "Call read_file with start" not in rest.content

    img = await _upload(client, user, "cat.png", b"\x89PNG\r\n\x1a\n" + b"0" * 20, mime="image/png")
    with pytest.raises(ToolError, match="only reads text"):
        await tool.run(ctx, {"file_id": img["id"]})
    stranger = await _user(db, "sam")
    with pytest.raises(ToolError, match="No file with that id"):
        await tool.run(_ctx(db, stranger), {"file_id": long["id"]})


@pytest.mark.asyncio
async def test_search_my_files_can_be_narrowed_by_folder_and_type(client, db, user, embedder):  # noqa: F811
    from app.files.drive_index import index_pass

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    home = await _folder(db, user, "Home")
    await _upload(client, user, "boiler.txt", b"Boiler service is due in May.", folder_id=home.id)
    await _upload(client, user, "car.txt", b"Car service is due in June.")
    await index_pass(db)
    tool = await _tool("search_my_files")
    ctx = _ctx(db, user)
    res = await tool.run(ctx, {"query": "service due"})
    assert {s["title"] for s in res.sources} == {"boiler.txt", "car.txt"}
    res = await tool.run(ctx, {"query": "service due", "folder": "Home"})
    assert [s["title"] for s in res.sources] == ["boiler.txt"]
    res = await tool.run(ctx, {"query": "service due", "type": "pdf"})
    assert res.sources == [] and "(pdf)" in res.content


# ---------------------------------------------------------------- organising


@pytest.mark.asyncio
async def test_a_proposal_checks_every_step_before_it_is_filed(client, db, user, provider):  # noqa: F811
    from app.chat.models import WorkspaceProposal
    from app.chat.tools.base import ToolContext, ToolError

    conv = await _conversation(db, user, provider)
    ctx = ToolContext(db=db, user=user, conversation_id=conv.id, user_message_id=uuid.uuid4())
    tool = await _tool("propose_file_changes")
    docs = await _folder(db, user, "Docs")
    inner = await _folder(db, user, "Inner", parent=docs)
    await _folder(db, user, "Inner")  # a root folder with the same name
    uploads = await _folder(db, user, "Chat Uploads", system_kind="chat_uploads")
    mine = await _upload(client, user, "a.txt", b"a")
    pal = await _user(db, "pal")
    theirs = await _upload(client, pal, "b.txt", b"b")

    bad = [
        ([{"op": "move", "item_type": "file", "item_id": theirs["id"], "to": "Docs"}], "belongs to someone else"),
        ([{"op": "rename", "item_type": "folder", "item_id": str(uploads.id), "name": "X"}], "system folder"),
        ([{"op": "move", "item_type": "folder", "item_id": str(docs.id), "to": "Docs/Inner"}], "into itself"),
        ([{"op": "move", "item_type": "folder", "item_id": str(inner.id), "to": ""}], "already has a folder called 'Inner'"),
        ([{"op": "rename", "item_type": "file", "item_id": mine["id"], "name": "x/y.txt"}], "isn't a valid file name"),
        ([{"op": "delete", "item_type": "file", "item_id": mine["id"]}], "`op` must be one of"),
    ]
    for ops, msg in bad:
        with pytest.raises(ToolError, match=msg):
            await tool.run(ctx, {"operations": ops})
    assert (await db.execute(select(WorkspaceProposal))).scalars().all() == []

    res = await tool.run(ctx, {"operations": [
        {"op": "move", "item_type": "file", "item_id": mine["id"], "to": "Taxes/2025"},
        {"op": "rename", "item_type": "file", "item_id": mine["id"], "name": "invoice.txt"},
    ]})
    assert "move 1 item, rename 1 item, 1 new folder" in res.content and "Nothing has been moved" in res.content
    p = (await db.execute(select(WorkspaceProposal))).scalars().one()
    assert p.workspace_id is None and p.kind == "file_changes"
    assert p.payload["operations"][0] == {
        "op": "move", "item_type": "file", "item_id": mine["id"], "name": "a.txt", "from": "",
        "to": "Taxes/2025", "to_new": True,
    }
    assert p.payload["operations"][1]["from"] == "Taxes/2025"  # where it'll be by then


@pytest.mark.asyncio
async def test_applying_moves_renames_and_makes_folders_all_or_nothing(client, db, user, provider):  # noqa: F811
    from app.chat.models import WorkspaceProposal
    from app.chat.tools.base import ToolContext
    from app.files.models import FileFolder, UserFile
    conv = await _conversation(db, user, provider)
    ctx = ToolContext(db=db, user=user, conversation_id=conv.id, user_message_id=uuid.uuid4())
    tool = await _tool("propose_file_changes")
    inv = await _upload(client, user, "scan001.pdf", b"%PDF-1.4 x", mime="application/pdf")
    r = await client.post("/api/files/office", json={"kind": "document", "title": "draft"}, headers=_auth(user))
    doc_id = r.json()["id"]
    old = await _folder(db, user, "Misc")
    old_id = old.id

    await tool.run(ctx, {"operations": [
        {"op": "create_folder", "path": "Archive"},
        {"op": "move", "item_type": "file", "item_id": inv["id"], "to": "Taxes/2025"},
        {"op": "rename", "item_type": "file", "item_id": inv["id"], "name": "March invoice.pdf"},
        {"op": "rename", "item_type": "file", "item_id": doc_id, "name": "Plan for spring"},
        {"op": "move", "item_type": "folder", "item_id": str(old.id), "to": "Archive"},
    ]})
    p = (await db.execute(select(WorkspaceProposal))).scalars().one()

    # The listing shows it to its chat's owner, with no workspace.
    lst = (await client.get(f"/api/chat/conversations/{conv.id}/proposals", headers=_auth(user))).json()
    assert lst[0]["id"] == str(p.id) and lst[0]["workspace_id"] is None

    uid = user.id
    r = await client.post(f"/api/chat/proposals/{p.id}/apply", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied"
    db.expire_all()
    row = await db.get(UserFile, uuid.UUID(inv["id"]))
    dest = await db.get(FileFolder, row.folder_id)
    parent = await db.get(FileFolder, dest.parent_id)
    assert (parent.name, dest.name, row.filename) == ("Taxes", "2025", "March invoice.pdf")
    assert r.json()["applied_item_id"] is not None  # "Open" goes to the first folder made
    doc = await db.get(UserFile, uuid.UUID(doc_id))
    assert doc.filename == "Plan for spring.html"
    archive = (await db.execute(select(FileFolder).where(FileFolder.name == "Archive", FileFolder.user_id == uid))).scalars().one()
    assert (await db.get(FileFolder, old_id)).parent_id == archive.id


@pytest.mark.asyncio
async def test_a_stale_step_fails_the_whole_proposal_and_changes_nothing(client, db, user, provider):  # noqa: F811
    from app.chat.models import WorkspaceProposal
    from app.chat.tools.base import ToolContext
    from app.files.models import FileFolder, UserFile

    conv = await _conversation(db, user, provider)
    ctx = ToolContext(db=db, user=user, conversation_id=conv.id, user_message_id=uuid.uuid4())
    tool = await _tool("propose_file_changes")
    a = await _upload(client, user, "a.txt", b"a")
    b = await _upload(client, user, "b.txt", b"b")
    await tool.run(ctx, {"operations": [
        {"op": "move", "item_type": "file", "item_id": a["id"], "to": "Sorted"},
        {"op": "move", "item_type": "file", "item_id": b["id"], "to": "Sorted"},
    ]})
    p = (await db.execute(select(WorkspaceProposal))).scalars().one()
    row = await db.get(UserFile, uuid.UUID(b["id"]))
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()

    pid = p.id
    r = await client.post(f"/api/chat/proposals/{pid}/apply", headers=_auth(user))
    assert r.status_code == 409 and "Step 2" in r.json()["detail"]
    db.expire_all()
    assert (await db.get(UserFile, uuid.UUID(a["id"]), populate_existing=True)).folder_id is None
    assert (await db.execute(select(FileFolder).where(FileFolder.name == "Sorted"))).scalars().all() == []
    assert (await db.execute(select(WorkspaceProposal.status).where(WorkspaceProposal.id == pid))).scalar() == "pending"
    # Someone else can't apply it.
    pal = await _user(db, "pal")
    assert (await client.post(f"/api/chat/proposals/{pid}/apply", headers=_auth(pal))).status_code == 404


@pytest.mark.asyncio
async def test_the_file_tools_come_with_the_tools_toggle_in_any_chat(db, user, conversation, monkeypatch):
    from tests.test_drive_chat_wp52 import _chat, _tool_names

    _sse, seen, _reply = await _chat(monkeypatch, db, user, conversation, "tidy up my files", tools_enabled=True)
    assert {"list_my_files", "read_file", "propose_file_changes"} <= _tool_names(seen[0])
    assert "search_my_files" not in _tool_names(seen[0])  # that one needs AI search on
    _sse, seen, _reply = await _chat(monkeypatch, db, user, conversation, "tidy up my files")
    assert not {"list_my_files", "read_file", "propose_file_changes"} & _tool_names(seen[0])
