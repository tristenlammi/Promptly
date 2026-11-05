"""AI search for mail: the admin decides, mail only goes where they agreed, and one
person never finds another's mail."""
from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select, text

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.mail import search
from app.models_config.models import ModelProvider

from .test_mail import H, client, mk_account, mk_message, mk_user  # noqa: F401

WORDS = {"bill": 0, "invoice": 0, "payment": 0, "lunch": 1, "food": 1, "holiday": 2}


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


async def _indexer(db, *, kind="ollama", url="http://ollama:11434/v1", model="nomic-embed-text") -> ModelProvider:
    provider = ModelProvider(name=f"Indexer {kind}", type=kind, base_url=url, models=[])
    db.add(provider)
    await db.flush()
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        settings = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(settings)
    settings.embedding_provider_id, settings.embedding_model_id, settings.embedding_dim = provider.id, model, 768
    settings.mail_ai_search, settings.mail_ai_search_provider = None, None
    await db.commit()
    return provider


async def _index_all(db) -> None:
    while await search.index_some(db):
        pass


@pytest.mark.parametrize("kind,url,local", [
    ("ollama", "", True),
    ("ollama", "http://ollama:11434/v1", True),
    ("openai", "http://192.168.1.20:8000/v1", True),
    ("openai", "http://localhost:1234/v1", True),
    ("openai", "http://llm.lan:8000/v1", True),
    ("openai", "", False),
    ("openai", "https://api.openai.com/v1", False),
    ("ollama", "https://ollama.example.com/v1", False),
    ("openai", "http://8.8.8.8/v1", False),
])
def test_what_counts_as_staying_on_this_network(kind, url, local):
    assert search.is_local(ModelProvider(name="x", type=kind, base_url=url)) is local


async def test_on_by_default_with_a_local_indexer_and_off_with_a_cloud_one(client, db):  # noqa: F811
    await _indexer(db)
    assert (await search.config(db)).on is True
    await _indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    assert (await search.config(db)).on is False


async def test_nothing_goes_to_a_cloud_indexer_until_the_admin_says_so(client, db, sent):  # noqa: F811
    admin, u = await mk_user(db, "boss", role="admin"), await mk_user(db, "owner")
    account = await mk_account(db, u)
    await mk_message(db, account, subject="Your bill", body="Secret words")
    await _indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    await _index_all(db)
    assert sent == []
    assert (await client.get("/api/mail/threads?q=nothing", headers=H(u))).json()["threads"] == []
    assert sent == []  # Nor does your search.

    r = await client.put("/api/mail/admin/ai-search", json={"on": True}, headers=H(admin))
    assert r.status_code == 200 and r.json()["on"] is True and r.json()["local"] is False
    await _index_all(db)
    assert any("Secret words" in t for t in sent)


async def test_agreeing_to_one_cloud_provider_isnt_agreeing_to_the_next(client, db, sent):  # noqa: F811
    admin = await mk_user(db, "boss", role="admin")
    await _indexer(db, kind="openai", url="https://api.openai.com/v1", model="text-embedding-3-small")
    assert (await client.put("/api/mail/admin/ai-search", json={"on": True}, headers=H(admin))).json()["on"] is True
    await _indexer_swap(db, url="https://other.example.com/v1")
    assert (await search.config(db)).on is False


async def test_turning_on_for_a_local_indexer_doesnt_carry_over_to_a_cloud_one(client, db):  # noqa: F811
    admin = await mk_user(db, "boss", role="admin")
    await _indexer(db)
    assert (await client.put("/api/mail/admin/ai-search", json={"on": True}, headers=H(admin))).json()["on"] is True
    await _indexer_swap(db, url="https://api.openai.com/v1")
    assert (await search.config(db)).on is False


async def _indexer_swap(db, url: str) -> None:
    provider = ModelProvider(name="Next", type="openai", base_url=url, models=[])
    db.add(provider)
    await db.flush()
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    settings.embedding_provider_id = provider.id
    await db.commit()


async def test_only_an_admin_decides(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    assert (await client.get("/api/mail/admin/ai-search", headers=H(u))).status_code == 403
    assert (await client.put("/api/mail/admin/ai-search", json={"on": True}, headers=H(u))).status_code == 403


async def test_search_finds_by_meaning_after_the_exact_words_and_only_yours(client, db, sent):  # noqa: F811
    await _indexer(db)
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    mine = await mk_account(db, u)
    theirs = await mk_account(db, other, email="them@example.com")
    payment = await mk_message(db, mine, subject="Your invoice", body="Please pay")
    payment.uid = 21
    lunch = await mk_message(db, mine, subject="Lunch", body="Friday?")
    lunch.uid = 22
    exact = await mk_message(db, mine, subject="The bill", body="Here")
    exact.uid = 23
    hidden = await mk_message(db, theirs, subject="Their invoice", body="Private")
    await db.commit()
    await _index_all(db)

    got = (await client.get("/api/mail/threads?q=bill", headers=H(u))).json()["threads"]
    assert [t["key"] for t in got] == [exact.thread_key, payment.thread_key]
    assert "related" not in got[0] and got[1]["related"] is True
    assert hidden.thread_key not in [t["key"] for t in got]
    assert lunch.thread_key not in [t["key"] for t in got]


async def test_if_the_model_is_down_search_still_finds_the_words(client, db, monkeypatch):  # noqa: F811
    await _indexer(db)
    u = await mk_user(db, "owner")
    m = await mk_message(db, await mk_account(db, u), subject="The bill")

    async def down(**_):
        raise RuntimeError("no")

    monkeypatch.setattr(search, "embed_texts", down)
    got = (await client.get("/api/mail/threads?q=bill", headers=H(u))).json()["threads"]
    assert [t["key"] for t in got] == [m.thread_key]


async def test_turning_it_off_removes_the_index_and_a_new_model_starts_again(client, db, sent):  # noqa: F811
    admin, u = await mk_user(db, "boss", role="admin"), await mk_user(db, "owner")
    await _indexer(db)
    await mk_message(db, await mk_account(db, u))
    await _index_all(db)
    assert await db.scalar(text("SELECT count(*) FROM mail_vectors")) == 1
    status = (await client.get("/api/mail/admin/ai-search", headers=H(admin))).json()
    assert (status["indexed"], status["total"]) == (1, 1)

    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    settings.embedding_model_id = "another-model"
    await db.commit()
    await search.index_some(db)
    assert await db.scalar(text("SELECT count(*) FROM mail_vectors WHERE model = 'another-model'")) == 1

    assert (await client.put("/api/mail/admin/ai-search", json={"on": False}, headers=H(admin))).json()["on"] is False
    assert await db.scalar(text("SELECT count(*) FROM mail_vectors")) == 0
    await db.refresh(settings)
    sent.clear()
    await _index_all(db)
    assert sent == []


async def test_spam_and_trash_are_never_indexed(client, db, sent):  # noqa: F811
    from app.mail.models import MailFolder, MailMessage

    await _indexer(db)
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await mk_message(db, account, body="Rubbish")
    spam = MailFolder(account_id=account.id, path="Spam", name="Spam", role="spam")
    db.add(spam)
    await db.flush()
    row = await db.scalar(select(MailMessage).where(MailMessage.id == m.id))
    row.folder_id = spam.id
    await db.commit()
    await _index_all(db)
    assert sent == []
