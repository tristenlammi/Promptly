"""Notes N2.1: AI search over notes.

* the admin's switch: on with a local indexer, off with a cloud one until they
  agree, back off when the provider changes, and off wipes every note vector;
* stale means another model or changed words (ticking an item isn't);
* each person can keep their notes out, and a shared note follows its owner;
* ``nearest`` never returns a stranger's note, a removed member's or a trashed
  one;
* the admin sees the switch and two totals, nothing else.
"""
from __future__ import annotations

import hashlib
import uuid

import pytest
from sqlalchemy import text

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.models_config.models import ModelProvider
from app.notes import search
from tests.test_notes_chat_tools import ctx
from tests.test_notes_core import H, client, get, live, mk_user, new_list, new_note, share  # noqa: F401 — fixtures

WORDS = {"wifi": 0, "router": 0, "password": 0, "internet": 0, "plumber": 1, "leak": 1, "tap": 1}


def fake_vector(line: str) -> list[float]:
    """Words of a kind land near each other, as they would with a real model."""
    v = [0.0] * 768
    for raw in line.lower().split():
        word = "".join(c for c in raw if c.isalnum())
        if word in WORDS:
            v[WORDS[word]] += 1.0
    if not any(v):
        v[3 + int(hashlib.md5(line.encode()).hexdigest(), 16) % 700] = 1.0
    return v


@pytest.fixture
def sent(monkeypatch):
    seen: list[str] = []

    async def fake(*, provider, model_id, texts, dimensions=None, fast=False):
        seen.extend(texts)
        return [fake_vector(t) for t in texts]

    monkeypatch.setattr(search, "embed_texts", fake)
    return seen


async def indexer(db, *, kind="ollama", url="http://ollama:11434/v1", model="nomic-embed-text") -> ModelProvider:
    provider = ModelProvider(name=f"Indexer {kind}", type=kind, base_url=url, models=[])
    db.add(provider)
    await db.flush()
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        settings = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(settings)
    settings.embedding_provider_id, settings.embedding_model_id, settings.embedding_dim = provider.id, model, 768
    settings.notes_ai_search, settings.notes_ai_search_provider = None, None
    await db.commit()
    return provider


async def swap(db, url: str, model: str | None = None) -> None:
    provider = ModelProvider(name="Next", type="openai", base_url=url, models=[])
    db.add(provider)
    await db.flush()
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    settings.embedding_provider_id = provider.id
    if model:
        settings.embedding_model_id = model
    await db.commit()


async def index_all(db) -> None:
    while await search.index_some(db):
        pass


async def vectors(db) -> int:
    return int(await db.scalar(text("SELECT count(*) FROM note_vectors")))


async def admin(db):
    u = await mk_user(db, "boss")
    u.role = "admin"
    await db.commit()
    return u


async def related(client, u, q):  # noqa: F811
    r = await client.get("/api/notes", headers=H(u), params={"q": q})
    assert r.status_code == 200, r.text
    body = r.json()
    return [n["id"] for n in body["notes"]], [n["id"] for n in body.get("related", [])]


# ------------------------------------------------------------------ the switch


async def test_on_with_a_local_indexer_and_off_with_a_cloud_one(client, db):  # noqa: F811
    await indexer(db)
    assert (await search.config(db)).on is True
    await indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    assert (await search.config(db)).on is False


async def test_nothing_goes_to_a_cloud_indexer_until_the_admin_says_so(client, db, sent):  # noqa: F811
    boss, ann = await admin(db), await mk_user(db, "ann")
    await new_note(client, ann, title="Router", text="The wifi password is hunter2")
    await indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    await index_all(db)
    assert sent == [] and await vectors(db) == 0
    assert (await related(client, ann, "internet"))[1] == []
    assert sent == []  # nor does a search

    r = await client.put("/api/notes/admin/ai-search", json={"on": True}, headers=H(boss))
    assert r.status_code == 200 and r.json()["on"] is True and r.json()["local"] is False
    await index_all(db)
    assert any("hunter2" in t for t in sent) and await vectors(db) == 1

    # Agreeing to one cloud provider isn't agreeing to the next.
    await swap(db, "https://other.example.com/v1")
    assert (await search.config(db)).on is False
    await search.index_some(db)
    assert await vectors(db) == 0


async def test_mail_and_notes_have_separate_switches(client, db):  # noqa: F811
    from app.mail import search as mail_search

    boss = await admin(db)
    await indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    assert (await client.put("/api/mail/admin/ai-search", json={"on": True}, headers=H(boss))).json()["on"] is True
    assert (await mail_search.config(db)).on is True
    assert (await search.config(db)).on is False


async def test_turning_it_off_deletes_every_note_vector_at_once(client, db, sent):  # noqa: F811
    boss, ann, bob = await admin(db), await mk_user(db, "ann"), await mk_user(db, "bob")
    await indexer(db)
    await new_note(client, ann, title="Router", text="wifi password")
    await new_note(client, bob, title="Plumber", text="the tap leak")
    await index_all(db)
    assert await vectors(db) == 2
    r = await client.put("/api/notes/admin/ai-search", json={"on": False}, headers=H(boss))
    assert r.json()["on"] is False and await vectors(db) == 0
    # A local indexer stays off once the admin said so.
    await search.index_some(db)
    assert await vectors(db) == 0 and (await search.config(db)).on is False


async def test_only_an_admin_decides_and_sees_two_numbers_and_the_switch(client, db, sent):  # noqa: F811
    boss, ann = await admin(db), await mk_user(db, "ann")
    await indexer(db)
    await new_note(client, ann, title="Router", text="wifi password")
    await new_note(client, ann, title="", text="")  # empty: nothing to index
    assert (await client.get("/api/notes/admin/ai-search", headers=H(ann))).status_code == 403
    assert (await client.put("/api/notes/admin/ai-search", json={"on": True}, headers=H(ann))).status_code == 403
    await index_all(db)
    body = (await client.get("/api/notes/admin/ai-search", headers=H(boss))).json()
    # The server's indexer and switch, and two totals. No note, title, id or person.
    assert set(body) == {"ready", "on", "local", "provider", "model", "indexed", "total"}
    assert body["indexed"] == 1 and body["total"] == 1
    assert "Router" not in str(body) and str(ann.id) not in str(body)


# ------------------------------------------------------------------ staleness


async def test_changed_words_or_model_reembed_and_a_tick_doesnt(client, db, sent):  # noqa: F811
    ann = await mk_user(db, "ann")
    await indexer(db)
    lst = await new_list(client, ann, title="Router", items=("wifi password", "reset"))
    await index_all(db)
    assert len(sent) == 1
    sent.clear()

    iid = lst["items"][0]["id"]
    r = await client.patch(f"/api/notes/{lst['id']}/items/{iid}", headers=H(ann), json={"checked": True})
    assert r.status_code == 200
    await index_all(db)
    assert sent == []  # a tick isn't new words

    r = await client.patch(f"/api/notes/{lst['id']}/items/{iid}", headers=H(ann), json={"text": "wifi password hunter2"})
    await index_all(db)
    assert len(sent) == 1 and "hunter2" in sent[0]
    sent.clear()

    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    settings.embedding_model_id = "another-model"
    await db.commit()
    await index_all(db)
    assert len(sent) == 1
    assert await db.scalar(text("SELECT model FROM note_vectors")) == "another-model"


# ------------------------------------------------------------------ who finds what


async def test_found_by_meaning_after_the_exact_words(client, db, sent, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    await indexer(db)
    router = await new_note(client, ann, title="Router", text="password hunter2")
    exact = await new_note(client, ann, title="Wifi at Mum's", text="ask her")
    plumber = await new_note(client, ann, title="Plumber", text="the tap leak")
    await index_all(db)

    found, near = await related(client, ann, "wifi")
    assert found == [exact["id"]]
    assert near == [router["id"]]  # not the plumber, not the exact match again
    assert plumber["id"] not in near
    # The same in chat: the exact words first, then close in meaning.
    from app.chat.tools.notes import FindNotesTool

    out = (await FindNotesTool().run(ctx(db, ann), {"query": "wifi"})).content
    assert out.index(exact["id"]) < out.index(router["id"]) and "close in meaning" in out
    assert plumber["id"] not in out

    # Next pages and searches without words have no "related".
    r = await client.get("/api/notes", headers=H(ann))
    assert "related" not in r.json()


async def test_nearest_never_returns_a_strangers_a_removed_members_or_a_trashed_note(client, db, sent, live):  # noqa: F811
    ann, bob, cat = await mk_user(db, "ann"), await mk_user(db, "bob"), await mk_user(db, "cat")
    await indexer(db)
    mine = await new_note(client, ann, title="Router", text="wifi password")
    shared = await new_note(client, bob, title="Internet", text="router login")
    await share(client, bob, shared["id"], ann, cat)
    strangers = await new_note(client, cat, title="Cat's router", text="wifi password")
    trashed = await new_note(client, ann, title="Old router", text="wifi password")
    await index_all(db)
    assert await vectors(db) == 4

    got = {str(i) for i in await search.nearest(db, ann, "wifi")}
    assert got == {mine["id"], shared["id"], trashed["id"]}

    assert (await client.delete(f"/api/notes/{trashed['id']}", headers=H(ann))).status_code == 200
    assert await vectors(db) == 3  # its vector went with it
    r = await client.delete(f"/api/notes/{shared['id']}/members/{ann.id}", headers=H(bob))
    assert r.status_code == 200
    got = {str(i) for i in await search.nearest(db, ann, "wifi")}
    assert got == {mine["id"]}
    # Cat still has the shared one and her own; never Ann's.
    got = {str(i) for i in await search.nearest(db, cat, "wifi")}
    assert got == {shared["id"], strangers["id"]}


async def test_your_own_switch_and_a_shared_note_follows_its_owner(client, db, sent, live):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    await indexer(db)
    anns = await new_note(client, ann, title="Router", text="wifi password")
    bobs = await new_note(client, bob, title="Internet", text="router login")
    await share(client, ann, anns["id"], bob)
    await index_all(db)

    me = (await client.get("/api/notes/settings/search", headers=H(ann))).json()
    assert me == {"available": True, "on": True, "local": True, "provider": "Indexer ollama"}
    r = await client.put("/api/notes/settings/search", headers=H(ann), json={"on": False})
    assert r.json()["on"] is False
    # Ann's vectors are gone at once, and stay out.
    assert {str(i) for i in (await db.execute(text("SELECT note_id FROM note_vectors"))).scalars()} == {bobs["id"]}
    sent.clear()
    await index_all(db)
    assert sent == []
    # Bob doesn't find Ann's shared note by meaning, only by its words.
    assert {str(i) for i in await search.nearest(db, bob, "wifi")} == {bobs["id"]}
    found, near = await related(client, bob, "wifi")
    assert found == [anns["id"]] and near == [bobs["id"]]

    # Back on: indexed again.
    await client.put("/api/notes/settings/search", headers=H(ann), json={"on": True})
    await index_all(db)
    assert await vectors(db) == 2
    # With the server's switch off there's nothing to choose.
    await search.set_choice(db, False)
    assert (await client.get("/api/notes/settings/search", headers=H(ann))).json()["available"] is False


async def test_a_failing_model_leaves_word_search_working(client, db, monkeypatch, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    await indexer(db)
    n = await new_note(client, ann, title="Wifi", text="password")

    async def broken(**kw):
        raise RuntimeError("down")

    monkeypatch.setattr(search, "embed_texts", broken)
    found, near = await related(client, ann, "wifi")
    assert found == [n["id"]] and near == []
    _ = uuid
