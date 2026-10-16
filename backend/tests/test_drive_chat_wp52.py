"""Drive answers in chat (WP-5.2): the index remembers where each passage is
(a PDF's page, a sheet's tab and row), ``search_my_files`` turns hits into
citations that open the file at that spot, and the person's chat mode
decides whether chats look in their files (when relevant / every reply /
never)."""
from __future__ import annotations

import uuid
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select

from tests.test_chat_streaming import _FakeRequest, _seed_turn
from tests.test_drive_index_wp51 import _auth, _upload, _user, client, embedder  # noqa: F401 — fixtures

from app.models_config.provider import FinishEvent, TextDelta, UsageEvent


def _chunk(i, text_):
    from app.custom_models.embedding import Chunk

    return Chunk(index=i, text=text_, tokens=len(text_) // 4, metadata={})


# ---------------------------------------------------------------- positions


def test_pdf_chunks_know_their_page_and_sheet_chunks_their_tab_and_row():
    from app.files.drive_index import _annotate

    pdf = _annotate(
        [
            _chunk(0, "Lease --- Page 1 --- Tenancy terms start here"),
            _chunk(1, "more of page one --- Page 2 --- Rent is due monthly"),
            _chunk(2, "still on page two, the deposit is two months"),
            _chunk(3, "--- Page 3 --- Break clause after a year"),
        ],
        "pdf",
    )
    assert [c.metadata["page"] for c in pdf] == [1, 1, 2, 3]

    sheet = _annotate(
        [
            _chunk(0, "Budget [tab: Q1] [row 1] Item | Cost [row 2] Rent | 900"),
            _chunk(1, "[row 3] Food | 300 [tab: Q2] [row 1] Item | Cost"),
            _chunk(2, "| 450 more cells of the same row"),
        ],
        "sheet",
    )
    assert [(c.metadata["tab"], c.metadata["row"]) for c in sheet] == [("Q1", 1), ("Q1", 3), ("Q2", 1)]
    # Documents carry no positions — the find bar locates them instead.
    assert _annotate([_chunk(0, "text")], "document")[0].metadata == {}


# ---------------------------------------------------------------- settings


@pytest.mark.asyncio
async def test_chat_mode_defaults_to_auto_and_is_off_while_ai_search_is(client, db, user, embedder):  # noqa: F811
    from app.files.drive_index import chat_mode_for

    r = await client.get("/api/files/ai-index", headers=_auth(user))
    assert r.json()["chat_mode"] == "auto"
    await db.refresh(user)
    assert chat_mode_for(user) == "off"  # AI search itself is off
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [], "chat_mode": "always"},
                         headers=_auth(user))
    assert r.json()["chat_mode"] == "always"
    # Saving without a mode keeps it.
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    assert r.json()["chat_mode"] == "always"
    await db.refresh(user)
    assert chat_mode_for(user) == "always"
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [], "chat_mode": "loud"},
                         headers=_auth(user))
    assert r.status_code == 422


# ---------------------------------------------------------------- the tool


@pytest.mark.asyncio
async def test_search_my_files_cites_the_pdf_page_and_the_sheet_row(client, db, user, embedder, monkeypatch):  # noqa: F811
    from app.chat.tools.base import ToolContext
    from app.chat.tools.registry import get_tool
    from app.files import drive_index
    from app.files.drive_index import index_pass
    from app.files.models import UserFile
    from app.files.office import content_for_shell

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))

    # A PDF whose text (as the extractor gives it) runs over three pages,
    # long enough to split into several chunks.
    filler = "Ordinary clause text about the tenancy agreement. " * 50
    pdf_text = (
        f"\n--- Page 1 ---\n{filler}\n--- Page 2 ---\n{filler}\n--- Page 3 ---\n"
        "The break clause lets the tenant leave after twelve months with notice. " + filler
    )
    real_text = drive_index._file_text
    monkeypatch.setattr(drive_index, "_file_text", lambda f: pdf_text if f.filename == "lease.pdf" else real_text(f))
    pdf = await _upload(client, user, "lease.pdf", b"%PDF-1.4 stand-in", mime="application/pdf")

    # A sheet with two tabs.
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Budget"}, headers=_auth(user))
    sheet_id = uuid.UUID(r.json()["id"])
    row = await db.get(UserFile, sheet_id)
    entity = await content_for_shell(db, row)
    entity.data = [
        {"name": "Q1", "celldata": [{"r": 0, "c": 0, "v": {"v": "Rent"}}, {"r": 0, "c": 1, "v": {"v": 900}}]},
        {"name": "Q2", "celldata": [
            {"r": 0, "c": 0, "v": {"v": "Item"}},
            {"r": 11, "c": 0, "v": {"v": "Gym membership"}}, {"r": 11, "c": 1, "v": {"v": 45}},
        ]},
    ]
    await db.commit()

    await index_pass(db)

    tool = get_tool("search_my_files")
    assert tool is not None and tool.category == "drive"
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4())

    res = await tool.run(ctx, {"query": "break clause twelve months"})
    top = res.sources[0]
    assert top["kind"] == "file" and top["file_id"] == pdf["id"] and top["title"] == "lease.pdf"
    assert top["page"] == 3 and top["location"] == "page 3"
    assert top["url"] == f"/files/f/{pdf['id']}?page=3"
    assert "[1] lease.pdf — page 3" in res.content

    res = await tool.run(ctx, {"query": "gym membership"})
    top = res.sources[0]
    assert top["file_id"] == str(sheet_id) and top["tab"] == "Q2" and top["row"] == 12
    q = parse_qs(urlsplit(top["url"]).query)
    assert q == {"tab": ["Q2"], "row": ["12"]}
    assert top["location"] == "Q2 · row 12"

    # Nothing matching → an honest empty result, no citations.
    res = await tool.run(ctx, {"query": "zebra migration"})
    assert res.sources == [] and "Nothing in the user's files" in res.content


@pytest.mark.asyncio
async def test_document_citations_carry_a_phrase_to_find(client, db, user, embedder):  # noqa: F811
    from app.chat.tools.search_my_files import search_drive, render_hits
    from app.files.drive_index import index_pass

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    f = await _upload(client, user, "recipes.txt", b"Grandma's lemon drizzle cake needs four eggs and a lemon.")
    await index_pass(db)
    hits = await search_drive(db, user.id, "lemon drizzle")
    _content, sources = render_hits("lemon drizzle", hits)
    src = sources[0]
    assert src["file_id"] == f["id"] and "page" not in src
    phrase = parse_qs(urlsplit(src["url"]).query)["q"][0]
    # The title the indexer prepends isn't part of the file's text.
    assert phrase.startswith("Grandma's lemon drizzle")


# ---------------------------------------------------------------- in a chat


def _recording_stub(seen: list[dict]):
    async def _stream(**kwargs):
        seen.append(kwargs)
        yield TextDelta(text="Your lease has a break clause [1].")
        yield UsageEvent(prompt_tokens=5, completion_tokens=3, cost_usd=0.0)
        yield FinishEvent(reason="stop")

    return _stream


async def _chat(monkeypatch, db, user, conversation, question, *, model_can_call_tools=True, tools_enabled=False):
    from app.chat import router as chat_router
    from app.chat.models import Message
    from app.chat.service import enqueue_stream

    msg = await _seed_turn(db, conversation)
    msg.content = question
    await db.commit()
    seen: list[dict] = []
    monkeypatch.setattr(chat_router.model_router, "stream_chat_events", _recording_stub(seen), raising=True)
    monkeypatch.setattr(chat_router, "_model_tool_support", lambda p, m: None if model_can_call_tools else False)
    stream_id = uuid.uuid4()
    await enqueue_stream(stream_id, {
        "conversation_id": str(conversation.id), "user_message_id": str(msg.id),
        "provider_id": str(conversation.provider_id), "model_id": "test-model", "web_search_mode": "off",
        "temperature": 0.7, "max_tokens": None, "tools_enabled": tools_enabled, "reasoning_effort": None,
    })
    sse = "".join([c async for c in chat_router._stream_generator(stream_id, user, _FakeRequest())])
    reply = (await db.execute(
        select(Message).where(Message.conversation_id == conversation.id, Message.role == "assistant")
        .order_by(Message.created_at.desc())
    )).scalars().first()
    await db.refresh(reply)
    return sse, seen, reply


def _tool_names(kwargs):
    return {t["function"]["name"] for t in (kwargs.get("tools") or [])}


@pytest.mark.asyncio
async def test_chat_modes_offer_force_or_withhold_the_file_search(client, db, user, conversation, embedder, monkeypatch):  # noqa: F811
    from app.files.drive_index import index_pass

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    f = await _upload(client, user, "lease.txt", b"The break clause lets the tenant leave after twelve months.")
    await index_pass(db)

    # auto: offered, not forced.
    await db.refresh(user)
    sse, seen, reply = await _chat(monkeypatch, db, user, conversation, "when can I leave my lease?")
    assert "search_my_files" in _tool_names(seen[0])
    assert not reply.sources

    # always: looked up before the model answers; the passage reaches the
    # model as framed, untrusted file text and the reply carries the citation.
    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [], "chat_mode": "always"},
                     headers=_auth(user))
    await db.refresh(user)
    sse, seen, reply = await _chat(monkeypatch, db, user, conversation, "break clause twelve months")
    assert "search_my_files" in sse
    msgs = [m if isinstance(m, dict) else m.to_openai() for m in seen[0]["messages"]]
    tool_msgs = [m for m in msgs if m.get("role") == "tool"]
    assert tool_msgs and '<untrusted_content source="search_my_files">' in tool_msgs[0]["content"]
    assert reply.sources and reply.sources[0]["kind"] == "file" and reply.sources[0]["file_id"] == f["id"]

    # always, but nothing in the files shares a word with it: no lookup is
    # forced (the tool is still offered), no citations.
    sse, seen, reply = await _chat(monkeypatch, db, user, conversation, "hello, thanks!")
    assert "search_my_files" in _tool_names(seen[0])
    assert not [m for m in seen[0]["messages"] if (m if isinstance(m, dict) else m.to_openai()).get("role") == "tool"]
    assert not reply.sources

    # always, with a model that can't call tools: the passages ride in the
    # turn's context instead, with the same citation.
    sse, seen, reply = await _chat(monkeypatch, db, user, conversation, "break clause twelve months",
                                   model_can_call_tools=False)
    assert not _tool_names(seen[0])
    assert "twelve months" in seen[0]["system"]
    assert reply.sources and reply.sources[0]["file_id"] == f["id"]

    # off: never offered.
    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [], "chat_mode": "off"},
                     headers=_auth(user))
    await db.refresh(user)
    sse, seen, reply = await _chat(monkeypatch, db, user, conversation, "break clause twelve months")
    assert "search_my_files" not in _tool_names(seen[0]) and not reply.sources


@pytest.mark.asyncio
async def test_a_reader_only_gets_citations_for_files_they_can_open(client, db, user, embedder):  # noqa: F811
    from app.chat.tools.search_my_files import search_drive
    from app.files.drive_index import index_pass

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    shared = await _upload(client, user, "wifi.txt", b"The guest wifi password is on the fridge.")
    await _upload(client, user, "salary.txt", b"My salary review is in June.")
    await index_pass(db)
    pal = await _user(db, "pal")
    await client.post(f"/api/files/file/{shared['id']}/grants", json={"grantee_user_id": str(pal.id)},
                      headers=_auth(user))
    assert [str(h.user_file_id) for h in await search_drive(db, pal.id, "guest wifi")] == [shared["id"]]
    assert await search_drive(db, pal.id, "salary review") == []
