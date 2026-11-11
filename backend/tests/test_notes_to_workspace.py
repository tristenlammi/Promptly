"""Notes N2.6: Copy to a workspace.

* a copy appears as a Page in that workspace (words, and pictures as the
  page's own images); the note is unchanged and still private;
* an editor may, a viewer may not (and isn't offered it); a stranger's
  workspace is 404; only the note's owner copies it out.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select

from tests.test_notes_attachments import attach, client, live, local_stt, png, queued, root, tus_upload  # noqa: F401 — fixtures
from tests.test_notes_core import H, get, mk_user, new_list, new_note, share


async def mk_ws(db, owner, title="House reno", members=()):
    from app.chat.models import Workspace, WorkspaceItem, WorkspaceShare

    ws = Workspace(user_id=owner.id, title=title)
    db.add(ws)
    await db.flush()
    for u, role in members:
        db.add(WorkspaceShare(workspace_id=ws.id, inviter_user_id=owner.id, invitee_user_id=u.id, status="accepted", role=role))
    book = WorkspaceItem(workspace_id=ws.id, kind="container", title="Ideas", position=1.0, created_by=owner.id)
    db.add(book)
    await db.commit()
    return ws, book


async def copy(client, u, nid, ws_id, parent=None, code=201):  # noqa: F811
    body = {"workspace_id": str(ws_id)}
    if parent:
        body["parent_id"] = str(parent)
    r = await client.post(f"/api/notes/{nid}/to-workspace", headers=H(u), json=body)
    assert r.status_code == code, r.text
    return r.json()


async def page_text(db, item_id):
    from app.chat.models import WorkspaceItem
    from app.files.models import DocumentState, UserFile

    item = await db.get(WorkspaceItem, uuid.UUID(item_id))
    doc = await db.get(UserFile, item.ref_id)
    state = await db.get(DocumentState, doc.id)
    return item, doc, state


async def test_an_editor_copies_a_list_as_a_page_and_the_note_stays_private(client, db, live):  # noqa: F811
    ann, sam = await mk_user(db, "ann"), await mk_user(db, "sam")
    ws, book = await mk_ws(db, sam, members=[(ann, "editor")])
    n = await new_list(client, ann, title="Paint colours", items=("Dulux White", "Taubmans Grey"))
    before = await get(client, ann, n["id"])

    targets = (await client.get("/api/notes/to-workspace/targets", headers=H(ann))).json()["workspaces"]
    assert [(t["title"], t["role"]) for t in targets] == [("House reno", "editor")]
    assert targets[0]["notebooks"] == [{"id": str(book.id), "title": "Ideas"}]

    out = await copy(client, ann, n["id"], ws.id, parent=book.id)
    assert out["workspace"] == "House reno" and out["href"].startswith(f"/workspaces/{ws.id}?item=")
    item, doc, state = await page_text(db, out["item_id"])
    assert item.kind == "note" and item.title == "Paint colours" and item.parent_id == book.id and item.workspace_id == ws.id
    assert doc.user_id == sam.id  # the workspace's page, like any other
    assert "Copied from a note on" in (doc.content_text or "") and "Dulux White" in (doc.content_text or "")
    assert state is not None and state.yjs_update

    # The note is exactly as it was, and still only Ann's.
    after = await get(client, ann, n["id"])
    assert after["revision"] == before["revision"] and after["change_seq"] == before["change_seq"]
    assert after["member_ids"] == [] and (await client.get(f"/api/notes/{n['id']}", headers=H(sam))).status_code == 404


async def test_pictures_come_as_the_pages_own_images(client, db, live, root):  # noqa: F811
    from app.files.generated_kinds import GeneratedKind
    from app.files.models import UserFile
    ann = await mk_user(db, "ann")
    ws, _ = await mk_ws(db, ann, title="Mine")
    n = await new_note(client, ann, title="Fence", text="The posts we liked")
    fid = await tus_upload(client, root, ann, "fence.png", png(), "image/png")
    assert (await attach(client, ann, n["id"], fid)).status_code == 201
    out = await copy(client, ann, n["id"], ws.id)
    _item, doc, _state = await page_text(db, out["item_id"])
    assets = (await db.execute(select(UserFile).where(UserFile.source_file_id == doc.id, UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value))).scalars().all()
    assert len(assets) == 1 and assets[0].mime_type.startswith("image/")


async def test_a_viewer_isnt_offered_it_and_is_refused(client, db, live):  # noqa: F811
    ann, sam, cat = await mk_user(db, "ann"), await mk_user(db, "sam"), await mk_user(db, "cat")
    ws, _ = await mk_ws(db, sam, members=[(ann, "viewer")])
    strangers, _ = await mk_ws(db, cat, title="Cat's")
    n = await new_note(client, ann, title="Gate")
    assert (await client.get("/api/notes/to-workspace/targets", headers=H(ann))).json()["workspaces"] == []
    await copy(client, ann, n["id"], ws.id, code=403)
    await copy(client, ann, n["id"], strangers.id, code=404)


async def test_only_the_owner_copies_a_shared_note_out(client, db, live):  # noqa: F811
    ann, sam = await mk_user(db, "ann"), await mk_user(db, "sam")
    ws, _ = await mk_ws(db, sam)
    n = await new_note(client, ann, title="Ann's words")
    await share(client, ann, n["id"], sam)
    await copy(client, sam, n["id"], ws.id, code=403)
