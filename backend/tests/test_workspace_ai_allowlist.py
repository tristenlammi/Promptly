"""What the AI may retrieve from a workspace — the allow-list (roadmap R-033).

Workspace Ask, chat retrieval, search and Related all scope retrieval to
``retrievable_workspace_file_ids``. Each test below plants one source the
AI must *not* see next to one it must, so a regression in any single rule
fails a single, clearly named test.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from app.chat.models import (
    Conversation,
    Roster,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceTask,
)
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.workspaces.knowledge import (
    ai_context_items,
    retrievable_workspace_file_ids,
)

NOW = datetime.now(timezone.utc)


async def _file(db, owner, *, kind=None, name="f.md") -> UserFile:
    uf = UserFile(
        user_id=owner.id,
        filename=name,
        original_filename=name,
        mime_type="text/markdown",
        size_bytes=1,
        storage_path=f"u_{owner.id}/{uuid.uuid4()}.md",
        source_kind=kind,
    )
    db.add(uf)
    await db.flush()
    return uf


async def _ws(db, owner, **kw) -> Workspace:
    ws = Workspace(user_id=owner.id, title="Family", **kw)
    db.add(ws)
    await db.flush()
    return ws


async def _item(db, ws, kind, *, ref_id=None, **kw) -> WorkspaceItem:
    it = WorkspaceItem(
        workspace_id=ws.id,
        kind=kind,
        title=f"{kind}-{uuid.uuid4().hex[:6]}",
        position=1.0,
        ref_id=ref_id,
        created_by=ws.user_id,
        context_enabled=kw.pop("context_enabled", True),
        **kw,
    )
    db.add(it)
    await db.flush()
    return it


async def _note(db, ws, **kw):
    uf = await _file(db, ws_owner(ws))
    it = await _item(db, ws, "note", ref_id=uf.id, **kw)
    return it, uf


_OWNERS: dict = {}


def ws_owner(ws):
    return _OWNERS[ws.id]


@pytest.fixture
async def ws(db, user):
    w = await _ws(db, user)
    _OWNERS[w.id] = user
    return w


async def _allowed(db, ws):
    await db.commit()
    return await retrievable_workspace_file_ids(db, ws.id)


# ------------------------------------------------------------ items


@pytest.mark.asyncio
async def test_a_live_shared_note_is_retrievable(db, ws):
    _it, uf = await _note(db, ws)
    assert uf.id in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_a_private_draft_is_not(db, ws):
    _it, uf = await _note(db, ws, visibility="private")
    assert uf.id not in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_a_trashed_item_is_not(db, ws):
    _it, uf = await _note(db, ws, trashed_at=NOW)
    assert uf.id not in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_an_archived_item_is_not(db, ws):
    _it, uf = await _note(db, ws, archived_at=NOW)
    assert uf.id not in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_an_item_switched_off_for_context_is_not(db, ws):
    _it, uf = await _note(db, ws, context_enabled=False)
    assert uf.id not in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_a_page_inside_a_switched_off_notebook_is_not(db, ws):
    notebook = await _item(db, ws, "container", context_enabled=False)
    _it, uf = await _note(db, ws, parent_id=notebook.id)
    assert uf.id not in await _allowed(db, ws)


@pytest.mark.asyncio
async def test_a_page_inside_a_live_notebook_is(db, ws):
    notebook = await _item(db, ws, "container")
    _it, uf = await _note(db, ws, parent_id=notebook.id)
    assert uf.id in await _allowed(db, ws)


# ----------------------------------------------- backing-entity kinds


@pytest.mark.asyncio
async def test_roster_context_toggle_is_honoured(db, ws):
    """It used to do nothing — rosters weren't in the exclusion list."""
    on_file = await _file(db, ws_owner(ws), kind=GeneratedKind.ROSTER_TEXT.value)
    off_file = await _file(db, ws_owner(ws), kind=GeneratedKind.ROSTER_TEXT.value)
    on = Roster(workspace_id=ws.id, title="On", text_file_id=on_file.id)
    off = Roster(workspace_id=ws.id, title="Off", text_file_id=off_file.id)
    db.add_all([on, off])
    await db.flush()
    await _item(db, ws, "roster", ref_id=on.id)
    await _item(db, ws, "roster", ref_id=off.id, context_enabled=False)

    allowed = await _allowed(db, ws)

    assert on_file.id in allowed and off_file.id not in allowed


@pytest.mark.asyncio
async def test_private_canvas_and_sheet_are_not(db, ws):
    cf = await _file(db, ws_owner(ws))
    sf = await _file(db, ws_owner(ws))
    # Their Drive shells (WP-3.2) — any file row does for this test.
    cshell = await _file(db, ws_owner(ws))
    sshell = await _file(db, ws_owner(ws))
    canvas = WorkspaceCanvas(
        workspace_id=ws.id, title="c", yjs_update=b"", version=0, text_file_id=cf.id,
        file_id=cshell.id,
    )
    sheet = Spreadsheet(
        workspace_id=ws.id, title="s", yjs_update=b"", version=0, text_file_id=sf.id,
        file_id=sshell.id,
    )
    db.add_all([canvas, sheet])
    await db.flush()
    await _item(db, ws, "canvas", ref_id=canvas.id, visibility="private")
    await _item(db, ws, "sheet", ref_id=sheet.id, visibility="private")

    allowed = await _allowed(db, ws)

    assert cf.id not in allowed and sf.id not in allowed


@pytest.mark.asyncio
async def test_an_opted_in_discussion_is_but_a_foreign_pointer_is_not(db, ws, user):
    transcript = await _file(
        db, user, kind=GeneratedKind.DISCUSSION_TEXT.value
    )
    await _item(
        db, ws, "discussion", config={"text_file_id": str(transcript.id)}
    )
    other_user_file = await _file(db, user)  # not a transcript
    await _item(
        db, ws, "discussion", config={"text_file_id": str(other_user_file.id)}
    )

    allowed = await _allowed(db, ws)

    assert transcript.id in allowed
    assert other_user_file.id not in allowed


@pytest.mark.asyncio
async def test_card_attachments_follow_their_board(db, ws):
    shared_board = await _item(db, ws, "board")
    private_board = await _item(db, ws, "board", visibility="private")
    a1 = await _file(db, ws_owner(ws), name="quote.pdf")
    a2 = await _file(db, ws_owner(ws), name="salary.pdf")
    db.add_all(
        [
            WorkspaceTask(
                workspace_id=ws.id, title="t1", board_item_id=shared_board.id,
                attachments=[{"file_id": str(a1.id), "filename": "quote.pdf"}],
            ),
            WorkspaceTask(
                workspace_id=ws.id, title="t2", board_item_id=private_board.id,
                attachments=[{"file_id": str(a2.id), "filename": "salary.pdf"}],
            ),
        ]
    )

    allowed = await _allowed(db, ws)

    assert a1.id in allowed and a2.id not in allowed


# ------------------------------------------------ workspace-level sources


@pytest.mark.asyncio
async def test_pinned_files_respect_their_context_toggle(db, ws):
    on = await _file(db, ws_owner(ws))
    off = await _file(db, ws_owner(ws))
    db.add_all(
        [
            WorkspaceFile(workspace_id=ws.id, file_id=on.id, context_enabled=True),
            WorkspaceFile(workspace_id=ws.id, file_id=off.id, context_enabled=False),
        ]
    )

    allowed = await _allowed(db, ws)

    assert on.id in allowed and off.id not in allowed


@pytest.mark.asyncio
async def test_chat_transcripts_need_workspace_visibility_and_context(
    db, ws, user, provider
):
    shared_f = await _file(db, user)
    private_f = await _file(db, user)
    db.add_all(
        [
            Conversation(
                user_id=user.id, title="shared", provider_id=provider.id,
                model_id="m", workspace_id=ws.id, visibility="workspace",
                context_enabled=True, context_file_id=shared_f.id,
            ),
            Conversation(
                user_id=user.id, title="private", provider_id=provider.id,
                model_id="m", workspace_id=ws.id, visibility="private",
                context_enabled=True, context_file_id=private_f.id,
            ),
        ]
    )

    allowed = await _allowed(db, ws)

    assert shared_f.id in allowed and private_f.id not in allowed


@pytest.mark.asyncio
async def test_ai_context_items_matches_the_allow_list_rules(db, ws):
    live, _ = await _note(db, ws)
    hidden, _ = await _note(db, ws, visibility="private")
    await db.commit()

    ids = {it.id for it in await ai_context_items(db, ws.id)}

    assert live.id in ids and hidden.id not in ids


# ------------------------------------------------ the leak, end to end


async def _chunk(db, ws, uf, text):
    from sqlalchemy import text as sql

    await db.execute(
        sql(
            "INSERT INTO knowledge_chunks (user_file_id, chunk_index, text, "
            "embedding_dim, workspace_id) VALUES (:f, 0, :t, 768, :w)"
        ),
        {"f": uf.id, "t": text, "w": ws.id},
    )


@pytest.mark.asyncio
async def test_retrieval_scoped_to_the_allow_list_cannot_see_a_private_draft(
    db, ws
):
    """What Ask did before (unscoped) versus now (allow-list).

    Uses the keyword arm, which needs no embedder, so this runs anywhere.
    """
    from app.custom_models.retrieval import retrieve_workspace_context

    _shared, shared_f = await _note(db, ws)
    _draft, draft_f = await _note(db, ws, visibility="private")
    await _chunk(db, ws, shared_f, "Holiday budget for the family trip")
    await _chunk(db, ws, draft_f, "Private salary negotiation notes 98765")
    await db.commit()

    unscoped = await retrieve_workspace_context(
        db, workspace_id=ws.id, query="salary negotiation", top_k=5
    )
    allowed = await retrievable_workspace_file_ids(db, ws.id)
    scoped = await retrieve_workspace_context(
        db,
        workspace_id=ws.id,
        query="salary negotiation",
        top_k=5,
        file_ids=list(allowed),
    )

    # The old, unscoped call really did surface the draft…
    assert any(c.user_file_id == draft_f.id for c in unscoped)
    # …and the allow-list scoped call cannot.
    assert not any(c.user_file_id == draft_f.id for c in scoped)
