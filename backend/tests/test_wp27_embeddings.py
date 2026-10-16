"""Embedding lifecycle (WP-2.7): model fingerprint, re-embed on switch,
outage signal, the message indexer, config probing, attachment fallback
(R-317…R-324, R-332…R-336)."""
from __future__ import annotations

import uuid

import httpx
import openai
import pytest

from app.custom_models import embedding as emb
from app.models_config.models import ModelProvider


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


async def _settings(db, provider, model="embed-b", dim=768):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.embedding_provider_id = provider.id
    row.embedding_model_id = model
    row.embedding_dim = dim
    await db.commit()
    return row


def _vec(i: int, dim: int = 768) -> list[float]:
    v = [0.0] * dim
    v[i] = 1.0
    return v


async def _file(db, user, name="doc.txt", text="alpha"):
    from app.files.models import UserFile

    uf = UserFile(user_id=user.id, filename=name, original_filename=name, mime_type="text/plain",
                  size_bytes=len(text), storage_path=f"x/{name}", content_text=text)
    db.add(uf)
    await db.commit()
    return uf


async def _chunks(db, conv_id, file_id, text, model, vec):
    from app.custom_models.embedding import Chunk
    from app.custom_models.ingestion import insert_chunks

    await insert_chunks(
        db, scope_kind="conversation", scope_id=conv_id, user_file_id=file_id,
        chunks=[Chunk(index=0, text=text, tokens=3, metadata={})], embeddings=[vec],
        embedding_model=model, embedding_dim=len(vec),
    )


def _bad_request() -> openai.BadRequestError:
    return openai.BadRequestError(
        "rejected", response=httpx.Response(400, request=httpx.Request("POST", "http://x")), body=None
    )


# ---------------------------------------------------------------- R-317


@pytest.mark.asyncio
async def test_retrieval_keeps_to_the_current_models_vectors(db, user, provider, conversation, monkeypatch):
    """After a same-dimension switch, the old model's vectors scored as
    confident nonsense next to the new one's."""
    from app.custom_models import retrieval

    await _settings(db, provider, model="embed-b")
    old = await _file(db, user, "old.txt")
    new = await _file(db, user, "new.txt")
    # The old model's chunk is the *closer* vector — it must still not win.
    await _chunks(db, conversation.id, old.id, "zeta one", "embed-a", _vec(0))
    await _chunks(db, conversation.id, new.id, "zeta two", "embed-b", _vec(1))
    await db.commit()

    async def fake_embed(**kw):
        return [_vec(0)]

    monkeypatch.setattr(retrieval, "embed_texts", fake_embed)
    retrieval._QUERY_VECTOR_CACHE.clear()
    hits = await retrieval.retrieve_conversation_context(db, conversation_id=conversation.id, query="qqq")
    assert [h.user_file_id for h in hits] == [new.id]
    assert retrieval.vector_status() == "ok"


@pytest.mark.asyncio
async def test_switching_the_model_queues_everything_for_a_fresh_embed(db, user, provider, conversation):
    from sqlalchemy import text

    from app.chat.models import Workspace, WorkspaceItem
    from app.custom_models.backfill import mark_all_for_reembed, pending_counts

    await _settings(db, provider, model="embed-b")
    ws = Workspace(user_id=user.id, title="W")
    db.add(ws)
    await db.flush()
    item = WorkspaceItem(workspace_id=ws.id, kind="note", title="N", indexing_status="ready",
                         indexed_content_hash="h", created_by=user.id)
    db.add(item)
    f = await _file(db, user)
    await _chunks(db, conversation.id, f.id, "stale", "embed-a", _vec(2))
    await db.commit()

    await mark_all_for_reembed(db, model_id="embed-b")
    await db.commit()
    await db.refresh(item)
    assert item.indexing_status == "queued" and item.indexed_content_hash is None
    left = await db.scalar(text("SELECT count(*) FROM knowledge_chunks WHERE conversation_id = :c"),
                           {"c": conversation.id})
    assert left == 0
    assert (await pending_counts(db))["items"] >= 1


# ---------------------------------------------------------------- R-319


@pytest.mark.asyncio
async def test_attachments_are_found_by_keyword_when_the_embedder_is_down(db, user, provider, conversation, monkeypatch):
    from app.chat.attachment_rag import conversation_indexed_file_ids
    from app.custom_models import retrieval

    await _settings(db, provider, model="embed-b")
    f = await _file(db, user, "contract.txt")
    stale = await _file(db, user, "stale.txt")
    await _chunks(db, conversation.id, f.id, "Clause seven covers termination notice", "embed-b", _vec(3))
    await _chunks(db, conversation.id, stale.id, "Clause seven elsewhere", "embed-a", _vec(4))
    await db.commit()

    async def down(**kw):
        raise ConnectionError("embedder down")

    monkeypatch.setattr(retrieval, "embed_texts", down)
    retrieval._QUERY_VECTOR_CACHE.clear()
    hits = await retrieval.retrieve_conversation_context(
        db, conversation_id=conversation.id, query="termination notice"
    )
    assert f.id in {h.user_file_id for h in hits}
    assert retrieval.vector_status() == "unavailable"
    # Only the current model's chunks count as "indexed" — the stale file
    # is inlined instead of silently dropped.
    assert await conversation_indexed_file_ids(db, conversation.id) == {f.id}


# ---------------------------------------------------------------- R-323


@pytest.mark.asyncio
async def test_a_message_the_embedder_rejects_is_marked_not_retried_forever(db, conversation, provider, monkeypatch):
    from sqlalchemy import text

    from app.chat import semantic_index as si
    from app.chat.models import Message
    from app.chat.semantic_search import EmbeddingConfig

    good = Message(conversation_id=conversation.id, role="user", content="A perfectly ordinary question")
    bad = Message(conversation_id=conversation.id, role="assistant", content="BAD content the provider refuses")
    blank = Message(conversation_id=conversation.id, role="assistant", content="a\n\n\n\n\n\n\n\n\n\nb")
    db.add_all([good, bad, blank])
    await db.commit()
    calls = []

    async def fake_embed(*, texts, **kw):
        calls.append(list(texts))
        if any("BAD" in t for t in texts):
            raise _bad_request()
        return [_vec(5) for _ in texts]

    monkeypatch.setattr(si, "embed_texts", fake_embed)
    cfg = EmbeddingConfig(provider=provider, model_id="embed-b", dim=768)
    assert await si._index_batch(db, cfg) == 3
    # Nothing left — the bad and the blank message got markers.
    assert await si._index_batch(db, cfg) == 0
    rows = {
        r.message_id: r
        for r in (await db.execute(
            text(
                "SELECT message_id, embed_dim, embed_model, embedding_768 IS NOT NULL AS has_vec "
                "FROM message_embeddings WHERE conversation_id = :c"
            ), {"c": conversation.id})).all()
    }
    assert rows[good.id].has_vec and rows[good.id].embed_dim == 768
    assert rows[bad.id].embed_dim == 0 and not rows[bad.id].has_vec
    assert rows[blank.id].embed_dim == 0
    # A model switch makes every row stale again.
    cfg2 = EmbeddingConfig(provider=provider, model_id="embed-c", dim=768)
    assert await si._index_batch(db, cfg2) >= 1


# ---------------------------------------------------------------- R-333


@pytest.mark.asyncio
async def test_dimensions_is_only_sent_when_needed_and_retried_without(monkeypatch):
    sent = []

    class _Client:
        def with_options(self, **kw):
            return self

        class embeddings:  # noqa: N801
            @staticmethod
            async def create(**kw):
                sent.append(kw)
                if "dimensions" in kw:
                    raise _bad_request()
                return type("R", (), {"data": [type("D", (), {"embedding": [0.0] * 1536})()]})()

    emb._breaker.clear()
    emb._clients.clear()
    monkeypatch.setattr(emb, "_client_for", lambda p: _Client())
    p = ModelProvider(name=f"P{uuid.uuid4().hex[:6]}", type="openai", base_url="http://x/v1", api_key=None, models=[])
    # Native size: no ``dimensions`` at all.
    await emb.embed_texts(provider=p, model_id="text-embedding-3-small", texts=["q"], dimensions=1536)
    assert "dimensions" not in sent[-1]
    # A provider refusing the field: one retry without it.
    out = await emb.embed_texts(provider=p, model_id="unknown-embed", texts=["q"], dimensions=768)
    assert "dimensions" in sent[-2] and "dimensions" not in sent[-1]
    assert len(out[0]) == 1536
    assert emb.embedding_dim_for("nomic-embed-text:latest") == 768
    assert emb.embedding_dim_for("openai/text-embedding-3-small") == 1536


@pytest.mark.asyncio
async def test_saving_a_known_model_still_probes_it(client, db, provider, monkeypatch):
    from app.auth.models import User
    from app.custom_models import router as cm_router

    admin = User(email=f"a{uuid.uuid4().hex[:6]}@x.com", username=f"adm{uuid.uuid4().hex[:6]}",
                 password_hash="x", role="admin")
    db.add(admin)
    await db.commit()
    await db.refresh(admin)

    async def wrong_size(**kw):
        return [[0.0] * 1536]

    monkeypatch.setattr(cm_router, "embed_texts", wrong_size)
    await _settings(db, provider, model="embed-old", dim=768)
    r = await client.put(
        "/api/admin/custom-models/embedding-config",
        json={"embedding_provider_id": str(provider.id), "embedding_model_id": "nomic-embed-text"},
        headers=_auth(admin),
    )
    assert r.status_code == 400
    assert "768" in r.json()["detail"]

    await _settings(db, provider, model="nomic-embed-text", dim=768)
    r = await client.post("/api/admin/custom-models/embedding-config/test", headers=_auth(admin))
    assert r.status_code == 200
    assert r.json()["ok"] is False and r.json()["dimension"] == 1536

    r = await client.get("/api/admin/custom-models/embedding-config", headers=_auth(admin))
    body = r.json()
    assert body["pending"] is not None and "files" in body["pending"]
    assert body["health"] is not None


# ---------------------------------------------------------------- R-336


@pytest.mark.asyncio
async def test_a_disabled_provider_stops_being_called(db, provider):
    from app.chat.semantic_search import get_embedding_config

    await _settings(db, provider)
    provider.enabled = False
    await db.commit()
    assert await get_embedding_config(db) is None
    emb._breaker.clear()
    with pytest.raises(emb.EmbedderUnavailable):
        await emb.embed_texts(provider=provider, model_id="m", texts=["q"])
