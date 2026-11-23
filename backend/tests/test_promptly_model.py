"""The built-in "Promptly" custom model: made once, "not ready" until an
admin puts a model behind it, and everything that resolves the default
chat model works when the default is this custom model."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models_config.provider import FinishEvent, TextDelta
from tests.test_chat_reliability import _clean_sessions, _drive, _enqueue  # noqa: F401
from tests.test_chat_streaming import _seed_turn
from tests.test_member_defaults import _auth, _member, client  # noqa: F401
from tests.test_setup_checklist import _provider, _rows, quiet  # noqa: F401

CATALOGUE = [
    {"id": "anthropic/claude-sonnet-4.5", "display_name": "Claude Sonnet 4.5", "supports_vision": True, "context_window": 200000},
    {"id": "anthropic/claude-haiku-4.5", "display_name": "Claude Haiku 4.5", "supports_vision": True, "context_window": 200000},
]


async def _settings(db):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.commit()
    await db.refresh(row)
    return row


async def _seeded(db):
    from app.custom_models import builtin

    await _settings(db)
    cm = await builtin.provision(db)
    assert cm is not None
    return cm


# ------------------------------------------------------------ seeding


async def test_a_fresh_install_gets_promptly_with_nothing_behind_it(db):
    from app.custom_models import builtin
    from app.custom_models.models import CustomModel

    cm = await _seeded(db)
    assert (cm.name, cm.display_name) == ("promptly", "Promptly")
    assert cm.base_provider_id is None and cm.base_model_id is None and not builtin.ready(cm)
    assert cm.personality and len(cm.personality) < 400
    row = await _settings(db)
    assert row.builtin_model_seeded is True and row.builtin_model_id == cm.id
    # Nothing was made the default behind anyone's back.
    assert row.default_chat_model_id is None

    # Starting again changes nothing.
    assert await builtin.provision(db) is None
    assert len((await db.execute(select(CustomModel))).scalars().all()) == 1


async def test_a_renamed_or_deleted_promptly_never_comes_back(db):
    from app.custom_models import builtin
    from app.custom_models.models import CustomModel

    cm = await _seeded(db)
    cm.name, cm.display_name = "helper", "Helper"
    await db.commit()
    assert await builtin.provision(db) is None
    assert [c.name for c in (await db.execute(select(CustomModel))).scalars()] == ["helper"]
    assert (await builtin.get(db)).display_name == "Helper"

    await db.delete(cm)
    await db.commit()
    assert await builtin.provision(db) is None
    assert (await db.execute(select(CustomModel))).scalars().all() == []
    assert await builtin.get(db) is None


async def test_an_existing_install_gets_a_promptly_that_works_and_keeps_its_default(db):
    from app.custom_models import builtin

    p = await _provider(db, CATALOGUE)
    row = await _settings(db)
    row.default_chat_provider_id, row.default_chat_model_id = p.id, "anthropic/claude-haiku-4.5"
    await db.commit()

    cm = await builtin.provision(db)
    assert (cm.base_provider_id, cm.base_model_id) == (p.id, "anthropic/claude-haiku-4.5")
    row = await _settings(db)
    # The update never changes what new chats start on.
    assert (row.default_chat_provider_id, row.default_chat_model_id) == (p.id, "anthropic/claude-haiku-4.5")


async def test_an_admins_own_model_called_promptly_is_adopted(db):
    from app.custom_models import builtin
    from app.custom_models.models import CustomModel

    p = await _provider(db, CATALOGUE)
    await _settings(db)
    mine = CustomModel(name="promptly", display_name="Our Promptly", base_provider_id=p.id, base_model_id=CATALOGUE[0]["id"], personality="Mine.")
    db.add(mine)
    await db.commit()
    cm = await builtin.provision(db)
    assert cm.id == mine.id and cm.personality == "Mine."


# ----------------------------------------------- the picker and sending


async def test_the_picker_says_when_promptly_is_not_ready(db, user, client):
    cm = await _seeded(db)
    hdr = _auth(user)
    # No AI service at all: nothing to list, Promptly included.
    assert (await client.get("/api/models/available", headers=hdr)).json() == []

    p = await _provider(db, CATALOGUE)
    listed = (await client.get("/api/models/available", headers=hdr)).json()
    row = next(m for m in listed if m["model_id"] == f"custom:{cm.id}")
    assert row["needs_setup"] is True and row["is_custom"] is True and row["display_name"] == "Promptly"
    assert all(not m.get("needs_setup") for m in listed if m is not row)

    # A member sees it the same way.
    _, member = await _member(db, client, user)
    listed = (await client.get("/api/models/available", headers=member)).json()
    assert next(m for m in listed if m["model_id"] == f"custom:{cm.id}")["needs_setup"] is True

    # With a model behind it: an ordinary custom row carrying the base
    # model's context window and what it can see.
    r = await client.put("/api/admin/setup/promptly-model", headers=hdr, json={"provider_id": str(p.id), "model_id": CATALOGUE[0]["id"]})
    assert r.status_code == 200, r.text
    listed = (await client.get("/api/models/available", headers=member)).json()
    row = next(m for m in listed if m["model_id"] == f"custom:{cm.id}")
    assert row["needs_setup"] is False and row["supports_vision"] is True and row["context_window"] == 200000
    assert row["provider_id"] == str(p.id)
    # Members see it by its own name only.
    assert row["base_display_name"] is None


async def test_promptly_is_an_ordinary_entry_on_a_persons_model_list(db, user, client):
    """Ticked: they see it and can use it (and nothing it runs on). Unticked:
    it isn't listed and a message to it is refused, like any other model."""
    from app.chat.models import Conversation
    from app.custom_models.models import CustomModel
    from app.models_config.access import is_model_allowed

    cm = await _seeded(db)
    p = await _provider(db, CATALOGUE)
    other = CustomModel(name="tutor", display_name="Tutor", base_provider_id=p.id, base_model_id=CATALOGUE[0]["id"])
    db.add(other)
    await db.commit()
    promptly, tutor = f"custom:{cm.id}", f"custom:{other.id}"
    sonnet, haiku = CATALOGUE[0]["id"], CATALOGUE[1]["id"]

    # The admin's list of models says which one is the built-in one, so the
    # "new person" form can put it first and tick it.
    pool = {m["model_id"]: m for m in (await client.get("/api/models/available", headers=_auth(user))).json()}
    assert pool[promptly]["is_builtin"] is True
    assert not any(m.get("is_builtin") for mid, m in pool.items() if mid != promptly)

    # The list an admin ticks from (Admin → Users) has it first, even
    # before its model is chosen.
    choices = (await client.get("/api/admin/model-pool", headers=_auth(user))).json()
    assert choices[0]["model_id"] == promptly and choices[0]["is_builtin"] is True
    assert [c["model_id"] for c in choices if c.get("is_builtin")] == [promptly]

    r = await client.put("/api/admin/setup/promptly-model", headers=_auth(user), json={"provider_id": str(p.id), "model_id": sonnet})
    assert r.status_code == 200, r.text
    choices = (await client.get("/api/admin/model-pool", headers=_auth(user))).json()
    assert choices[0]["model_id"] == promptly and choices[0]["is_builtin"] is True
    assert {c["model_id"] for c in choices} == {promptly, tutor, sonnet, haiku}

    ticked, ticked_hdr = await _member(db, client, user, allowed_models=[promptly, haiku])
    unticked, unticked_hdr = await _member(db, client, user, allowed_models=[haiku])

    async def ids(headers) -> dict[str, dict]:
        return {m["model_id"]: m for m in (await client.get("/api/models/available", headers=headers)).json()}

    # Ticked: Promptly and their one model. Not Sonnet (what Promptly runs
    # on), not the other custom model on Sonnet.
    listed = await ids(ticked_hdr)
    assert set(listed) == {haiku, promptly}
    assert listed[promptly]["needs_setup"] is False and listed[promptly]["base_display_name"] is None
    assert await is_model_allowed(ticked, db, model_id=promptly, base_model_id=sonnet) is True
    assert await is_model_allowed(ticked, db, model_id=sonnet, base_model_id=sonnet) is False
    assert await is_model_allowed(ticked, db, model_id=tutor, base_model_id=sonnet) is False

    # Unticked: hidden, and not usable.
    assert set(await ids(unticked_hdr)) == {haiku}
    assert await is_model_allowed(unticked, db, model_id=promptly, base_model_id=sonnet) is False

    async def send(who, hdr, model_id: str) -> int:
        conv = Conversation(user_id=who.id, title="x", provider_id=p.id, model_id=model_id)
        db.add(conv)
        await db.commit()
        r = await client.post(f"/api/chat/conversations/{conv.id}/messages", headers=hdr, json={"content": "hello"})
        return r.status_code

    assert await send(unticked, unticked_hdr, promptly) == 403
    assert await send(ticked, ticked_hdr, tutor) == 403
    assert await send(ticked, ticked_hdr, sonnet) == 403
    # Past the model check (the made-up provider then fails to answer, which is not a 403).
    assert await send(ticked, ticked_hdr, promptly) != 403

    # An admin unticks it: gone for that person.
    r = await client.patch(f"/api/admin/users/{ticked.id}", headers=_auth(user), json={"allowed_models": [haiku]})
    assert r.status_code == 200, r.text
    assert set(await ids(ticked_hdr)) == {haiku}

    # No list at all: everything, as ever.
    _, free = await _member(db, client, user)
    assert set(await ids(free)) == {sonnet, haiku, promptly, tutor}


async def test_an_upgrade_adds_promptly_to_existing_model_lists_once(db, user, client):
    """The first time the built-in model is made, people who already have a
    model list get it added. Never again: an admin who unticks it afterwards
    has it stay unticked."""
    from app.custom_models import builtin

    p = await _provider(db, CATALOGUE)
    haiku = CATALOGUE[1]["id"]
    listed, _ = await _member(db, client, user, allowed_models=[haiku])
    locked, _ = await _member(db, client, user, allowed_models=[haiku], model_locked=True)
    nothing, _ = await _member(db, client, user, allowed_models=[])
    free, _ = await _member(db, client, user)

    cm = await _seeded(db)
    promptly = f"custom:{cm.id}"
    for person in (listed, locked, nothing, free, user):
        await db.refresh(person)
    assert listed.allowed_models == [haiku, promptly]
    # Locked to one model: left exactly as it was.
    assert locked.allowed_models == [haiku] and locked.model_locked is True
    # "No models at all" stays that; full access and admins have no list to add to.
    assert nothing.allowed_models == []
    assert free.allowed_models is None and user.allowed_models is None

    # The admin unticks it; a restart (provision again) doesn't put it back.
    r = await client.patch(f"/api/admin/users/{listed.id}", headers=_auth(user), json={"allowed_models": [haiku]})
    assert r.status_code == 200, r.text
    assert await builtin.provision(db) is None
    await db.refresh(listed)
    assert listed.allowed_models == [haiku]
    _ = p


async def test_a_message_to_an_unready_promptly_gets_a_plain_answer(db, user, client, provider):
    from app.chat.models import Conversation

    cm = await _seeded(db)
    member, member_hdr = await _member(db, client, user)
    for who, hdr, words in ((user, _auth(user), "Admin → Setup"), (member, member_hdr, "Ask the person who runs this server")):
        conv = Conversation(user_id=who.id, title="x", provider_id=provider.id, model_id=f"custom:{cm.id}")
        db.add(conv)
        await db.commit()
        r = await client.post(f"/api/chat/conversations/{conv.id}/messages", headers=hdr, json={"content": "hello"})
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert "Promptly doesn't have a model behind it yet" in detail and words in detail
        assert "custom:" not in detail and str(cm.id) not in detail


async def test_the_stream_says_so_too(db, user, conversation, monkeypatch):
    cm = await _seeded(db)
    conversation.model_id = f"custom:{cm.id}"
    await db.commit()
    msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, msg, model_id=f"custom:{cm.id}")

    async def never(**kwargs):
        raise AssertionError("no model should be called")
        yield  # pragma: no cover

    chunks = await _drive(monkeypatch, user, stream_id, never)
    text = "".join(chunks)
    assert "Promptly doesn't have a model behind it yet" in text and '"done": true' in text


# ------------------------------------- the wizard's "model behind Promptly"


async def test_choosing_the_model_behind_promptly_makes_it_the_default(db, user, client, quiet):  # noqa: F811
    cm = await _seeded(db)
    hdr = _auth(user)
    p = await _provider(db, CATALOGUE)

    body = (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).json()
    assert body["promptly"] == {"id": str(cm.id), "display_name": "Promptly", "ready": False, "is_default": False}
    chat = body["roles"][0]
    assert chat["role"] == "chat" and chat["label"] == "The model behind Promptly"
    assert chat["suggestion"]["model_id"] == "anthropic/claude-sonnet-4.5" and chat["current"] is None
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["models"]["status"] == "todo" and "doesn't have a model behind it" in rows["models"]["detail"]

    r = await client.put("/api/admin/setup/promptly-model", headers=hdr, json=chat["suggestion"] | {"make_default": True})
    assert r.status_code == 200, r.text
    assert r.json()["default_chat_model_id"] == f"custom:{cm.id}" and r.json()["listed"] is True

    # What a new person's app is told to start chats on.
    defaults = (await client.get("/api/workspace-defaults", headers=hdr)).json()
    assert (defaults["default_chat_provider_id"], defaults["default_chat_model_id"]) == (str(p.id), f"custom:{cm.id}")
    # And a chat made with no model named starts on it.
    r = await client.post("/api/chat/conversations", headers=hdr, json={})
    assert r.status_code in (200, 201), r.text
    assert r.json()["model_id"] == f"custom:{cm.id}"

    body = (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).json()
    assert body["promptly"]["ready"] is True and body["promptly"]["is_default"] is True
    assert body["roles"][0]["current"]["model_id"] == "anthropic/claude-sonnet-4.5"
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["models"]["status"] == "done" and "Promptly answers with Claude Sonnet 4.5" in rows["models"]["detail"]


async def test_promptly_model_guards(db, user, client):
    cm = await _seeded(db)
    hdr = _auth(user)
    p = await _provider(db, CATALOGUE)
    _, member = await _member(db, client, user)
    url = "/api/admin/setup/promptly-model"
    ok = {"provider_id": str(p.id), "model_id": CATALOGUE[0]["id"]}
    assert (await client.put(url, headers=member, json=ok)).status_code == 403
    assert (await client.put(url, headers=hdr, json=ok | {"model_id": "not-a-model"})).status_code == 400
    assert (await client.put(url, headers=hdr, json=ok | {"model_id": f"custom:{cm.id}"})).status_code == 400
    assert (await client.put(url, headers=hdr, json=ok | {"provider_id": str(uuid.uuid4())})).status_code == 400
    # Without making it the default: only the model behind it changes.
    assert (await client.put(url, headers=hdr, json=ok | {"make_default": False})).status_code == 200
    assert (await _settings(db)).default_chat_model_id is None
    # Deleted by an admin: there is nothing to set.
    await db.delete(cm)
    await db.commit()
    assert (await client.put(url, headers=hdr, json=ok)).status_code == 404
    body = (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).json()
    assert body["promptly"] is None and body["roles"][0]["label"] == "Chat"


async def test_changing_the_base_in_admin_keeps_the_default_pointing_at_it(db, user, client):
    cm = await _seeded(db)
    hdr = _auth(user)
    p1 = await _provider(db, CATALOGUE)
    p2 = await _provider(db, [{"id": "gpt-5", "display_name": "GPT-5"}], name="OpenAI", kind="openai")
    await client.put("/api/admin/setup/promptly-model", headers=hdr, json={"provider_id": str(p1.id), "model_id": CATALOGUE[0]["id"]})
    r = await client.patch(f"/api/admin/custom-models/{cm.id}", headers=hdr, json={"base_provider_id": str(p2.id), "base_model_id": "gpt-5"})
    assert r.status_code == 200, r.text
    assert r.json()["is_builtin"] is True and r.json()["base_model_id"] == "gpt-5"
    row = await _settings(db)
    assert (row.default_chat_provider_id, row.default_chat_model_id) == (p2.id, f"custom:{cm.id}")


async def test_deleting_its_provider_leaves_promptly_not_ready(db, user, client):
    from app.custom_models import builtin
    from app.models_config.models import ModelProvider

    cm = await _seeded(db)
    hdr = _auth(user)
    p = ModelProvider(name="Mine", type="openai", enabled=True, user_id=user.id, models=[{"id": "gpt-5", "display_name": "GPT-5"}])
    db.add(p)
    await db.commit()
    await client.put("/api/admin/setup/promptly-model", headers=hdr, json={"provider_id": str(p.id), "model_id": "gpt-5"})
    r = await client.delete(f"/api/models/providers/{p.id}", headers=hdr)
    assert r.status_code == 204, r.text
    await db.refresh(cm)
    still = await builtin.get(db)
    assert still is not None and still.id == cm.id and not builtin.ready(still)
    # The default went with the provider; nothing dangles.
    assert (await _settings(db)).default_chat_provider_id is None


# -------------------------- everything that resolves "the default model"


async def _promptly_default(db, client, user, model=CATALOGUE[0]["id"]):
    cm = await _seeded(db)
    p = await _provider(db, CATALOGUE)
    r = await client.put("/api/admin/setup/promptly-model", headers=_auth(user), json={"provider_id": str(p.id), "model_id": model})
    assert r.status_code == 200, r.text
    # The request used its own session: forget this one's copy.
    await db.refresh(cm)
    return cm, p


async def test_the_default_resolves_to_the_model_behind_promptly(db, user, client):
    from app.app_settings.defaults import load_effective_defaults
    from app.custom_models.resolver import base_pair
    from app.files.editor_ai import resolve_model
    from app.memory.service import resolve_memory_model
    from app.study import ai as study_ai

    cm, p = await _promptly_default(db, client, user)
    eff = await load_effective_defaults(db)
    assert eff.default_chat_model_id == f"custom:{cm.id}"

    want = (p.id, "anthropic/claude-sonnet-4.5")
    got = await base_pair(db, eff.default_chat_provider_id, eff.default_chat_model_id)
    assert (got[0].id, got[1]) == want
    # In-app assistants, Rooms' @promptly, Maps and Talk go through this.
    got = await resolve_model(db, user, eff.default_chat_provider_id, eff.default_chat_model_id)
    assert (got[0].id, got[1]) == want
    # Memory with no memory model set, and no chat to borrow one from.
    got = await resolve_memory_model(db)
    assert (got[0].id, got[1]) == want
    # Study with no Study model set.
    teacher = await study_ai.resolve(db, user)
    assert (teacher.provider.id, teacher.model_id) == want


async def test_a_new_spoken_chat_starts_on_promptly(db, user, client):
    from app.talk.reply import pick_model

    cm, p = await _promptly_default(db, client, user)
    got = await pick_model(db, user)
    assert got == (p.id, f"custom:{cm.id}")


async def test_a_chat_on_promptly_streams_from_the_model_behind_it(db, user, client, monkeypatch):
    from app.chat.models import Conversation, Message

    cm, p = await _promptly_default(db, client, user)
    conv = Conversation(user_id=user.id, title="x", provider_id=p.id, model_id=f"custom:{cm.id}")
    db.add(conv)
    await db.commit()
    msg = await _seed_turn(db, conv)
    seen: dict = {}
    titled: list[str] = []

    def stub(reply):
        async def _stream(**kwargs):
            # The title is written with a second, later call.
            if "chat titles" in str(kwargs.get("system") or ""):
                titled.append(kwargs["model_id"])
            else:
                seen.update(kwargs)
            yield TextDelta(text=reply)
            yield FinishEvent(reason="stop")

        return _stream

    stream_id = await _enqueue(conv, msg, model_id=f"custom:{cm.id}")
    chunks = await _drive(monkeypatch, user, stream_id, stub("Hi from the base model"))
    assert "Hi from the base model" in "".join(chunks)
    assert seen["model_id"] == "anthropic/claude-sonnet-4.5" and seen["provider"].id == p.id
    # Its short personality is in the prompt.
    assert "You are Promptly" in (seen.get("system") or "")
    # The title is written by the model behind it too, never "custom:…".
    assert titled and set(titled) == {"anthropic/claude-sonnet-4.5"}
    # The conversation still says Promptly; the reply is saved.
    await db.refresh(conv)
    assert conv.model_id == f"custom:{cm.id}"
    saved = (await db.execute(select(Message).where(Message.conversation_id == conv.id, Message.role == "assistant"))).scalars().all()
    assert [m.content for m in saved] == ["Hi from the base model"]


async def test_a_spoken_turn_on_promptly_uses_the_voice_model(db, user, client, monkeypatch):
    from app.chat.models import Conversation
    from app.custom_models.models import CustomModel

    cm, p = await _promptly_default(db, client, user)
    r = await client.patch("/api/admin/app-settings", headers=_auth(user), json={"voice_provider_id": str(p.id), "voice_model_id": "anthropic/claude-haiku-4.5"})
    assert r.status_code == 200, r.text
    seen: list[str] = []

    async def _stream(**kwargs):
        if "chat titles" not in str(kwargs.get("system") or ""):
            seen.append(kwargs["model_id"])
        yield TextDelta(text="ok")
        yield FinishEvent(reason="stop")

    async def turn(model_id: str) -> None:
        conv = Conversation(user_id=user.id, title="x", provider_id=p.id, model_id=model_id)
        db.add(conv)
        await db.commit()
        msg = await _seed_turn(db, conv)
        await _drive(monkeypatch, user, await _enqueue(conv, msg, model_id=model_id, voice=True), _stream)

    await turn(f"custom:{cm.id}")
    # Any other custom model keeps its own model when spoken to.
    other = CustomModel(name="kb", display_name="KB", base_provider_id=p.id, base_model_id="anthropic/claude-sonnet-4.5")
    db.add(other)
    await db.commit()
    await turn(f"custom:{other.id}")
    assert seen == ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"]


# ------------------------------------------------- reading (embedding) model


def test_openrouter_and_openai_offer_a_reading_model():
    from types import SimpleNamespace

    from app.admin.setup import embedding_options
    from app.custom_models.embedding import SUPPORTED_DIMS, embedding_dim_for

    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    got = embedding_options([
        SimpleNamespace(id=a, name="OpenRouter", type="openrouter", enabled=True),
        SimpleNamespace(id=b, name="Anthropic", type="anthropic", enabled=True),
        SimpleNamespace(id=c, name="OpenAI", type="openai", enabled=True),
    ])
    assert [(o["provider_name"], o["model_id"]) for o in got] == [
        ("OpenAI", "text-embedding-3-small"),
        ("OpenRouter", "openai/text-embedding-3-small"),
    ]
    for o in got:
        assert embedding_dim_for(o["model_id"]) == o["dim"] and o["dim"] in SUPPORTED_DIMS
    assert embedding_options([SimpleNamespace(id=b, name="Anthropic", type="anthropic", enabled=True)]) == []


async def test_an_openrouter_only_install_can_set_its_reading_model(db, user, client, monkeypatch):
    from app.custom_models import router as cm_router

    hdr = _auth(user)
    p = await _provider(db, CATALOGUE)
    await _settings(db)
    options = (await client.get("/api/admin/setup/embedding-options", headers=hdr)).json()["options"]
    assert options == [{
        "provider_id": str(p.id), "provider_name": "OpenRouter", "provider_type": "openrouter",
        "model_id": "openai/text-embedding-3-small", "dim": 1536,
    }]
    asked: list = []

    async def fake_embed(*, provider, model_id, texts, **kw):
        asked.append((provider.type, model_id))
        return [[0.0] * 1536 for _ in texts]

    monkeypatch.setattr(cm_router, "embed_texts", fake_embed)
    o = options[0]
    r = await client.put("/api/admin/custom-models/embedding-config", headers=hdr, json={
        "embedding_provider_id": o["provider_id"], "embedding_model_id": o["model_id"], "embedding_dim": o["dim"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["embedding_model_id"] == "openai/text-embedding-3-small" and r.json()["embedding_dim"] == 1536
    assert asked and asked[0] == ("openrouter", "openai/text-embedding-3-small")
    _, member = await _member(db, client, user)
    assert (await client.get("/api/admin/setup/embedding-options", headers=member)).status_code == 403
