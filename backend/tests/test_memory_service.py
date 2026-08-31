"""The parts of cross-chat memory that fail quietly.

This subsystem writes durable, user-visible rows from model output, and
almost none of it announces a mistake. ``_parse_ops`` turns a JSON blob
from an extraction model into row *deletions by id*; eviction decides
which fact to destroy when the store is full; the credential screen is
the only non-prompt defence on a write path the model can now invoke
directly. A regression in any of them looks exactly like normal
operation — memory just gets quietly worse — which is why they're
pinned here rather than left to the streaming tests.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.memory.constants import MAX_CONTENT_CHARS, MEMORY_CATEGORIES
from app.memory.models import UserMemory
from app.memory.service import (
    _evict_for_capture,
    _is_duplicate,
    _normalise,
    _parse_ops,
    build_memory_prompt,
    looks_sensitive,
)


def _ops(payload, valid_ids=frozenset()):
    return _parse_ops(json.dumps(payload), set(valid_ids))


# ------------------------------------------------------------ _parse_ops
#
# The blast radius here is deletion: an id that slips through is a row
# destroyed on the say-so of model output.


def test_delete_of_an_unknown_id_is_dropped():
    """The ids handed to the model are the only ones it may act on. A
    hallucinated — or injected — id must not reach the delete path."""
    assert _ops([{"op": "delete", "id": str(uuid.uuid4())}]) == []


def test_delete_of_a_supplied_id_survives():
    known = str(uuid.uuid4())
    assert _ops([{"op": "delete", "id": known}], {known}) == [
        {"op": "delete", "id": known}
    ]


def test_update_of_an_unknown_id_is_dropped():
    assert _ops(
        [{"op": "update", "id": str(uuid.uuid4()), "text": "User moved"}]
    ) == []


def test_low_confidence_adds_are_discarded():
    """The extraction prompt asks for 'high' only when the fact is durable.
    Treating a missing field as high would make every borderline guess
    permanent."""
    assert _ops([{"op": "add", "text": "User seems tired", "confidence": "low"}]) == []
    assert _ops([{"op": "add", "text": "User seems tired"}]) == []


def test_high_confidence_adds_survive_with_category():
    ops = _ops(
        [{"op": "add", "text": "User uses Rust", "confidence": "high",
          "category": "preferences"}]
    )
    assert ops == [
        {"op": "add", "text": "User uses Rust", "category": "preferences"}
    ]


def test_unknown_categories_are_coerced_not_rejected():
    """A bad category shouldn't cost us the fact — it's displayed as
    'Other' and the user can fix it."""
    ops = _ops(
        [{"op": "add", "text": "User uses Rust", "confidence": "high",
          "category": "vibes"}]
    )
    assert ops[0]["category"] is None


def test_every_valid_category_round_trips():
    for cat in MEMORY_CATEGORIES:
        ops = _ops(
            [{"op": "add", "text": "User x", "confidence": "high", "category": cat}]
        )
        assert ops[0]["category"] == cat, cat


def test_add_text_is_truncated_to_the_column_limit():
    ops = _ops(
        [{"op": "add", "text": "U" * (MAX_CONTENT_CHARS + 50), "confidence": "high"}]
    )
    assert len(ops[0]["text"]) == MAX_CONTENT_CHARS


def test_prose_around_the_array_is_tolerated():
    """Models preface JSON with commentary. Losing the whole turn's
    reconciliation over a 'Here you go:' would be silent."""
    raw = 'Sure! Here are the operations:\n[{"op": "delete", "id": "%s"}]\nDone.'
    known = str(uuid.uuid4())
    assert _parse_ops(raw % known, {known}) == [{"op": "delete", "id": known}]


def test_malformed_output_yields_no_operations():
    for raw in ("", "no json here", "[", "{}", "[1, 2, 3]", '{"op": "delete"}'):
        assert _parse_ops(raw, {"x"}) == [], raw


def test_unknown_ops_are_ignored():
    assert _ops([{"op": "drop_table", "id": "x"}], {"x"}) == []


def test_empty_text_is_not_an_add():
    assert _ops([{"op": "add", "text": "   ", "confidence": "high"}]) == []


# ------------------------------------------------------ credential screen


def test_credential_shapes_are_recognised():
    for secret in (
        "User key is sk-abcdefghijklmnop1234",
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        "xoxb-1234567890-abcdef",
        "AKIAIOSFODNN7EXAMPLE",
        "AIzaSyD-abcdefghijklmnopqrstuvwxyz12",
        "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM",
        "-----BEGIN RSA PRIVATE KEY-----",
        "User card 4111 1111 1111 1111",
        "User SSN 123-45-6789",
    ):
        assert looks_sensitive(secret), secret


def test_ordinary_facts_are_not_flagged():
    """A screen that fires on innocent text gets loosened until it catches
    nothing, so the false-positive set matters more than the catch rate.
    Note the 1Password line: phrase matching on 'password' would fail
    here, which is why the screen only recognises token shapes."""
    for benign in (
        "User prefers metric units",
        "User keeps their passwords in 1Password",
        "User was born in 1987",
        "User uses PostgreSQL 16 and Redis 7",
        "User is on the 2026 roadmap team",
        "User phone extension is 4821",
        "User joined on 2019-03-04",
        "User has 3 kids",
    ):
        assert not looks_sensitive(benign), benign


def test_the_capture_path_drops_secrets_whatever_the_model_says():
    """High confidence is not permission. The extraction prompt already
    asks the model to skip secrets — this is the half that doesn't depend
    on it having listened."""
    assert _ops(
        [{"op": "add", "text": "User token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
          "confidence": "high"}]
    ) == []


def test_secrets_cannot_arrive_through_an_update_either():
    known = str(uuid.uuid4())
    assert _ops(
        [{"op": "update", "id": known, "text": "User key sk-abcdefghijklmnop1234"}],
        {known},
    ) == []


# ---------------------------------------------------------------- dedupe


def test_duplicate_detection_covers_restatement():
    keys = [_normalise("User is a Rust developer")]
    assert _is_duplicate("user is a rust developer.", keys)
    assert _is_duplicate("User is a Rust developer", keys)
    assert not _is_duplicate("User is a Go developer", keys)


# -------------------------------------------------------------- eviction


async def _mem(db, user, content, **kw):
    kw.setdefault("source", "auto")
    row = UserMemory(user_id=user.id, content=content, **kw)
    db.add(row)
    await db.flush()
    return row


async def test_eviction_never_takes_a_manual_or_pinned_fact(db, user):
    """The cap recycles what the model captured on its own. A fact the
    user typed, or cared enough to pin, is not the system's to reclaim."""
    await _mem(db, user, "User typed this", source="manual")
    await _mem(db, user, "User pinned this", pinned=True)
    await db.commit()

    assert await _evict_for_capture(db, user.id) is False
    assert len(list((await db.execute(select(UserMemory))).scalars().all())) == 2


async def test_eviction_prefers_the_least_recently_useful(db, user):
    """Ordering by ``times_used`` first made eviction self-reinforcing: the
    counter increments on *injection*, and injection is what the retrieval
    boost rewards, so a fact that kept being injected kept being protected
    — while an on-point fact that only fires for a rare topic looked like
    the cheapest thing to throw away."""
    now = datetime.now(timezone.utc)
    stale = await _mem(
        db, user, "User used to like X", times_used=99,
        last_used_at=now - timedelta(days=200),
    )
    rare_but_recent = await _mem(
        db, user, "User is allergic to shellfish", times_used=1,
        last_used_at=now - timedelta(days=1),
    )
    await db.commit()

    assert await _evict_for_capture(db, user.id) is True
    await db.commit()

    survivors = [
        m.id for m in (await db.execute(select(UserMemory))).scalars().all()
    ]
    assert stale.id not in survivors
    assert rare_but_recent.id in survivors


async def test_eviction_protects_rows_written_this_pass(db, user):
    """A fact added earlier in the same capture pass has times_used=0 and
    no last_used_at — without the guard it would be the obvious victim
    when the next fact in the same batch needs a slot."""
    fresh = await _mem(db, user, "User just said this")
    old = await _mem(
        db, user, "User said this ages ago",
        last_used_at=datetime.now(timezone.utc) - timedelta(days=90),
    )
    await db.commit()

    assert await _evict_for_capture(db, user.id, protect_ids=[fresh.id]) is True
    await db.commit()

    survivors = [
        m.id for m in (await db.execute(select(UserMemory))).scalars().all()
    ]
    assert fresh.id in survivors
    assert old.id not in survivors


# ----------------------------------------------------- prompt rendering


def test_the_injected_block_dates_every_fact(db):
    """Undated facts read as equally current, so a year-old 'User is
    learning Rust' outranks nothing and contradicts everything. The block
    also has to tell the model to prefer the newer one."""
    now = datetime.now(timezone.utc)
    rows = [
        UserMemory(user_id=uuid.uuid4(), content="User uses Rust", created_at=now),
    ]
    block = build_memory_prompt(rows)

    assert block is not None
    assert now.strftime("%b %Y") in block
    assert "prefer newer" in block.lower()
    # It must also tell the model not to read the list back at the user.
    assert "do not recite" in block.lower()


def test_the_block_admits_it_is_only_a_selection():
    """Retrieval hands over ten of two hundred facts and the block used to
    read like the whole store, so "what do you know about me?" was
    answered confidently and incompletely — with nothing to signal the
    gap. When `recall` is on the table the model is pointed at it; when
    it isn't, it's told not to imply the list is everything."""
    rows = [UserMemory(user_id=uuid.uuid4(), content="User uses Rust")]

    with_tool = build_memory_prompt(rows, total=40, can_recall=True)
    assert "1 most relevant of 40" in with_tool
    assert "`recall`" in with_tool

    without_tool = build_memory_prompt(rows, total=40, can_recall=False)
    assert "recall" not in without_tool
    assert "don't imply this is everything" in without_tool


def test_no_selection_notice_when_the_block_is_the_whole_store():
    """Most accounts sit under the cap. Telling those models facts are
    missing would invite a `recall` call that can only return what they
    are already holding."""
    rows = [UserMemory(user_id=uuid.uuid4(), content="User uses Rust")]

    block = build_memory_prompt(rows, total=1, can_recall=True)

    assert "most relevant of" not in block
    assert "recall" not in block


def test_the_block_says_how_each_fact_was_learned():
    """The store always knew stated-vs-inferred and the prompt threw it
    away, so a month-old inference arrived with the same authority as
    something the user typed, and nothing broke the tie."""
    rows = [
        UserMemory(user_id=uuid.uuid4(), content="User uses Vim", source="manual"),
        UserMemory(user_id=uuid.uuid4(), content="User likes dark mode", source="auto"),
    ]

    block = build_memory_prompt(rows)

    assert "User uses Vim (stated" in block
    assert "User likes dark mode (inferred" in block
    assert "stated over inferred" in block


def test_no_memories_means_no_block_at_all():
    """Zero token overhead for fresh accounts is a deliberate property."""
    assert build_memory_prompt([]) is None
    assert build_memory_prompt(
        [UserMemory(user_id=uuid.uuid4(), content="   ")]
    ) is None


# ------------------------------------------- editing by describing it
#
# ``apply_memory_edits`` takes a plan that travelled through the browser,
# so it is the boundary that matters: everything it receives is a
# suggestion, and it has to behave as if the payload were hostile.


async def test_apply_ignores_ids_belonging_to_someone_else(db, user):
    """The plan round-trips through the client. If apply trusted the ids
    in it, a crafted payload would edit another account's memory."""
    from app.auth.models import User
    from app.memory.service import apply_memory_edits

    victim = User(
        email="victim@example.com",
        username="victim",
        password_hash="x",
        role="user",
    )
    db.add(victim)
    await db.commit()
    await db.refresh(victim)
    theirs = await _mem(db, victim, "User works at Acme")
    await db.commit()

    result = await apply_memory_edits(
        db,
        user_id=user.id,
        ops=[{"op": "delete", "id": str(theirs.id)}],
    )
    await db.commit()

    assert result["deleted"] == 0
    survivors = (await db.execute(select(UserMemory))).scalars().all()
    assert [m.id for m in survivors] == [theirs.id]


async def test_apply_performs_the_three_operations(db, user):
    from app.memory.service import apply_memory_edits

    stale = await _mem(db, user, "User works at Acme")
    doomed = await _mem(db, user, "User uses Vim")
    await db.commit()

    result = await apply_memory_edits(
        db,
        user_id=user.id,
        ops=[
            {"op": "update", "id": str(stale.id), "after": "User works at Globex",
             "category": "identity"},
            {"op": "delete", "id": str(doomed.id)},
            {"op": "add", "after": "User prefers metric units",
             "category": "preferences"},
        ],
    )
    await db.commit()

    assert result == {"added": 1, "updated": 1, "deleted": 1}
    rows = {m.content for m in (await db.execute(select(UserMemory))).scalars()}
    assert rows == {"User works at Globex", "User prefers metric units"}


async def test_apply_re_screens_for_credentials(db, user):
    """The screen runs on the plan too. A preview the user skim-approved
    is not a reason to store a token."""
    from app.memory.service import apply_memory_edits

    row = await _mem(db, user, "User uses Vim")
    await db.commit()

    result = await apply_memory_edits(
        db,
        user_id=user.id,
        ops=[
            {"op": "add", "after": "User token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"},
            {"op": "update", "id": str(row.id),
             "after": "User key sk-abcdefghijklmnop1234"},
        ],
    )
    await db.commit()

    assert result == {"added": 0, "updated": 0, "deleted": 0}
    assert (await db.execute(select(UserMemory))).scalars().one().content == (
        "User uses Vim"
    )


async def test_apply_skips_a_stale_id_without_failing_the_rest(db, user):
    """The user may have deleted a row in another tab between preview and
    apply. Partially-stale plans should still land what they can."""
    from app.memory.service import apply_memory_edits

    keep = await _mem(db, user, "User uses Vim")
    await db.commit()

    result = await apply_memory_edits(
        db,
        user_id=user.id,
        ops=[
            {"op": "delete", "id": str(uuid.uuid4())},
            {"op": "add", "after": "User prefers tabs"},
        ],
    )
    await db.commit()

    assert result["added"] == 1
    assert result["deleted"] == 0
    contents = {m.content for m in (await db.execute(select(UserMemory))).scalars()}
    assert contents == {"User uses Vim", "User prefers tabs"}
    assert keep is not None


async def test_apply_respects_the_store_cap(db, user):
    from app.memory.constants import MAX_MEMORIES
    from app.memory.service import apply_memory_edits

    for i in range(MAX_MEMORIES):
        await _mem(db, user, f"User fact {i}")
    await db.commit()

    result = await apply_memory_edits(
        db, user_id=user.id, ops=[{"op": "add", "after": "User one more"}]
    )
    await db.commit()

    assert result["added"] == 0


async def test_user_directed_adds_are_theirs_not_inferred(db, user):
    """They asked for it by name, so it's a manual row — which also keeps
    it out of the cap-eviction pool the model's own captures live in."""
    from app.memory.service import apply_memory_edits

    await apply_memory_edits(
        db, user_id=user.id, ops=[{"op": "add", "after": "User prefers tabs"}]
    )
    await db.commit()

    assert (await db.execute(select(UserMemory))).scalars().one().source == "manual"


# --------------------------------------------------- what gets injected
#
# This is the function the whole feature exists to feed, and it had no
# coverage at all — including for the retrieval floor added to stop pins
# crowding relevance out. A regression here is invisible: the block still
# renders, it just stops containing the facts that matter.


async def _no_embeddings(monkeypatch):
    """Force the recency fallback so these tests don't need a provider.

    The pinned/retrieved split is the same either way — only the ordering
    of the retrieved half changes — so the floor is testable without
    standing up an embedding model.
    """
    import app.memory.service as svc

    async def _none(_db):
        return None

    monkeypatch.setattr(svc, "get_embedding_config", _none)


async def test_pins_cannot_starve_retrieval(db, user, monkeypatch):
    """Pinned facts are injected unconditionally and used to draw from the
    same K slots as relevance, so pinning ten silently switched semantic
    retrieval off entirely. Half the slots are now reserved."""
    await _no_embeddings(monkeypatch)
    from app.memory.service import build_memory_system_prompt

    for i in range(10):
        await _mem(db, user, f"User pinned fact {i}", pinned=True)
    for i in range(10):
        await _mem(db, user, f"User ordinary fact {i}")
    await db.commit()

    _block, injected = await build_memory_system_prompt(
        db, user.id, query="anything", k=10
    )
    await db.commit()

    unpinned = [m for m in injected if not m.pinned]
    assert len(unpinned) >= 5, "retrieval was crowded out by pins"


async def test_the_injected_block_is_bounded_however_much_is_pinned(
    db, user, monkeypatch
):
    """Pinning used to be unbounded: 100 pins meant 100 facts in every
    prompt. The cap bounds the *unconditional* half at
    ``MAX_PINNED_MEMORIES``; anything pinned beyond it stops riding free
    and competes for the retrieval slots like an ordinary fact, so the
    whole block is bounded by cap + floor.

    Note what this deliberately does not assert: that over-cap pins are
    excluded. Making them unreachable would hide facts the user cared
    enough to pin — worse than demoting them to ordinary."""
    await _no_embeddings(monkeypatch)
    from app.memory.constants import MAX_PINNED_MEMORIES
    from app.memory.service import build_memory_system_prompt

    for i in range(MAX_PINNED_MEMORIES + 40):
        await _mem(db, user, f"User pinned fact {i}", pinned=True)
    await db.commit()

    k = 10
    _block, injected = await build_memory_system_prompt(
        db, user.id, query="anything", k=k
    )
    await db.commit()

    assert len(injected) <= MAX_PINNED_MEMORIES + k // 2
    assert len(injected) >= MAX_PINNED_MEMORIES


async def test_injection_stamps_usage(db, user, monkeypatch):
    """``last_used_at`` is what eviction now orders on, so a fact that is
    injected and never stamped would look stale and be discarded first."""
    await _no_embeddings(monkeypatch)
    from app.memory.service import build_memory_system_prompt

    row = await _mem(db, user, "User prefers metric units")
    await db.commit()

    await build_memory_system_prompt(db, user.id, query="units", k=10)
    await db.commit()
    await db.refresh(row)

    assert row.times_used == 1
    assert row.last_used_at is not None


async def test_an_empty_store_injects_nothing(db, user, monkeypatch):
    """Zero token overhead for fresh accounts is a deliberate property of
    the feature, not an accident of there being no rows."""
    await _no_embeddings(monkeypatch)
    from app.memory.service import build_memory_system_prompt

    block, injected = await build_memory_system_prompt(db, user.id, query="x", k=10)

    assert block is None
    assert injected == []


# ------------------------------------------- planning a described edit


def _stub_model(monkeypatch, payload: str):
    """Stand in for the memory model so the planner's own logic is what's
    under test — not the model's willingness to emit valid JSON."""
    import app.memory.service as svc

    async def _resolve(_db, **_kwargs):
        return ("provider-sentinel", "model-sentinel")

    async def _stream(**_kwargs):
        yield payload

    monkeypatch.setattr(svc, "resolve_memory_model", _resolve)
    monkeypatch.setattr(svc.model_router, "stream_chat", _stream)


async def test_plan_renders_before_and_after(db, user, monkeypatch):
    from app.memory.service import plan_memory_edits

    stale = await _mem(db, user, "User works at Acme")
    doomed = await _mem(db, user, "User uses Vim")
    await db.commit()

    _stub_model(
        monkeypatch,
        json.dumps(
            [
                {"op": "update", "id": str(stale.id),
                 "text": "User works at Globex", "category": "identity"},
                {"op": "delete", "id": str(doomed.id)},
                {"op": "add", "text": "User prefers tabs",
                 "confidence": "high", "category": "preferences"},
            ]
        ),
    )

    plan = await plan_memory_edits(
        db, user_id=user.id, instruction="I moved to Globex and dropped Vim"
    )

    by_op = {c["op"]: c for c in plan}
    assert by_op["update"]["before"] == "User works at Acme"
    assert by_op["update"]["after"] == "User works at Globex"
    assert by_op["delete"]["before"] == "User uses Vim"
    assert by_op["add"]["after"] == "User prefers tabs"


async def test_plan_writes_nothing(db, user, monkeypatch):
    """The whole point of previewing is that looking is free. If the
    planner mutated, Cancel would be a lie."""
    from app.memory.service import plan_memory_edits

    row = await _mem(db, user, "User works at Acme")
    await db.commit()

    _stub_model(
        monkeypatch,
        json.dumps([{"op": "delete", "id": str(row.id)}]),
    )
    await plan_memory_edits(db, user_id=user.id, instruction="forget my job")
    await db.commit()

    assert len(list((await db.execute(select(UserMemory))).scalars().all())) == 1


async def test_plan_drops_no_op_rewrites(db, user, monkeypatch):
    """A rewrite to identical text reads as a change the user then has to
    check, and there is nothing to check."""
    from app.memory.service import plan_memory_edits

    row = await _mem(db, user, "User works at Acme")
    await db.commit()

    _stub_model(
        monkeypatch,
        json.dumps([{"op": "update", "id": str(row.id), "text": "User works at Acme"}]),
    )
    plan = await plan_memory_edits(db, user_id=user.id, instruction="tidy this")

    assert plan == []


async def test_plan_ignores_ids_the_model_invented(db, user, monkeypatch):
    """Same guarantee as the capture path: the ids handed to the model are
    the only ones it may act on."""
    from app.memory.service import plan_memory_edits

    await _mem(db, user, "User works at Acme")
    await db.commit()

    _stub_model(
        monkeypatch,
        json.dumps([{"op": "delete", "id": str(uuid.uuid4())}]),
    )
    assert await plan_memory_edits(
        db, user_id=user.id, instruction="forget something"
    ) == []


async def test_plan_rejects_an_empty_instruction(db, user):
    import pytest

    from app.memory.service import plan_memory_edits

    with pytest.raises(ValueError):
        await plan_memory_edits(db, user_id=user.id, instruction="   ")


async def test_plan_on_an_empty_store_needs_no_model(db, user):
    """No facts means nothing to edit — worth short-circuiting, since the
    alternative is paying for a model call to be told so."""
    from app.memory.service import plan_memory_edits

    assert await plan_memory_edits(
        db, user_id=user.id, instruction="forget everything"
    ) == []


# ------------------------------------------------- the capture pass
#
# This is the function that decides what a user's memory contains. It had
# no coverage: the correction path — the whole reason the reconciliation
# prompt exists — was verified only by reading it.


def _stub_capture_model(monkeypatch, payload: str, *, embeddings=False):
    import app.memory.service as svc

    async def _stream(**_kwargs):
        yield payload

    async def _cfg(_db):
        return None

    monkeypatch.setattr(svc.model_router, "stream_chat", _stream)
    if not embeddings:
        monkeypatch.setattr(svc, "get_embedding_config", _cfg)


async def _capture(db, user, provider, conversation, monkeypatch, ops, **kw):
    from app.memory.service import capture_memories

    _stub_capture_model(monkeypatch, json.dumps(ops))
    saved = await capture_memories(
        db,
        user_id=user.id,
        user_text=kw.get("user_text", "I switched jobs"),
        assistant_text=kw.get("assistant_text", "Noted."),
        source_conversation_id=conversation.id,
        provider=provider,
        model_id="test-model",
    )
    await db.commit()
    return saved


async def test_capture_saves_a_new_fact(db, user, provider, conversation, monkeypatch):
    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "add", "text": "User prefers metric units",
          "confidence": "high", "category": "preferences"}],
    )

    row = (await db.execute(select(UserMemory))).scalars().one()
    assert row.content == "User prefers metric units"
    assert row.source == "auto"
    assert row.source_conversation_id == conversation.id
    assert saved == [{"id": str(row.id), "content": "User prefers metric units"}]


async def test_capture_rewrites_a_contradicted_fact_in_place(
    db, user, provider, conversation, monkeypatch
):
    """The headline behaviour of the whole feature. A contradiction has to
    update the stale row, not stack a second one beside it — two rows
    saying different things is worse than either alone, because retrieval
    will happily inject both."""
    stale = await _mem(db, user, "User works at Acme")
    await db.commit()

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "update", "id": str(stale.id), "text": "User works at Globex",
          "category": "identity"}],
    )

    rows = (await db.execute(select(UserMemory))).scalars().all()
    assert [r.content for r in rows] == ["User works at Globex"]
    assert rows[0].id == stale.id
    assert saved == [{"id": str(stale.id), "content": "User works at Globex"}]


async def test_capture_deletes_a_retracted_fact(
    db, user, provider, conversation, monkeypatch
):
    doomed = await _mem(db, user, "User uses Vim")
    await db.commit()

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "delete", "id": str(doomed.id)}],
    )

    assert (await db.execute(select(UserMemory))).scalars().all() == []
    # A deletion isn't a save — surfacing it in the "saved to memory" chip
    # would be actively misleading.
    assert saved == []


async def test_capture_ignores_a_rewrite_that_changes_nothing(
    db, user, provider, conversation, monkeypatch
):
    """Reported as saved, it would show a "saved to memory" chip for a
    turn in which nothing happened."""
    row = await _mem(db, user, "User works at Acme")
    await db.commit()

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "update", "id": str(row.id), "text": "User works at Acme"}],
    )

    assert saved == []


async def test_capture_skips_a_restatement_of_something_known(
    db, user, provider, conversation, monkeypatch
):
    await _mem(db, user, "User is a Rust developer")
    await db.commit()

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "add", "text": "User is a Rust developer.",
          "confidence": "high"}],
    )

    assert saved == []
    assert len((await db.execute(select(UserMemory))).scalars().all()) == 1


async def test_capture_is_bounded_per_turn(
    db, user, provider, conversation, monkeypatch
):
    """One chatty turn shouldn't be able to flood the store with near-
    trivia — the cap is what keeps a single message from rewriting who
    the assistant thinks you are."""
    from app.memory.constants import MAX_NEW_PER_TURN

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [
            {"op": "add", "text": f"User fact number {i}", "confidence": "high"}
            for i in range(MAX_NEW_PER_TURN + 5)
        ],
    )

    assert len(saved) == MAX_NEW_PER_TURN


async def test_capture_drops_credentials_end_to_end(
    db, user, provider, conversation, monkeypatch
):
    """Not just at the parser — this is the path a pasted key would
    actually travel."""
    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "add", "text": "User key is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
          "confidence": "high"},
         {"op": "add", "text": "User prefers tabs", "confidence": "high"}],
    )

    assert [s["content"] for s in saved] == ["User prefers tabs"]


async def test_capture_evicts_at_the_cap_rather_than_dropping_the_new_fact(
    db, user, provider, conversation, monkeypatch
):
    """Memory should keep renewing rather than freezing at whatever it
    happened to learn first."""
    from app.memory.constants import MAX_MEMORIES

    for i in range(MAX_MEMORIES):
        await _mem(db, user, f"User old fact {i}")
    await db.commit()

    saved = await _capture(
        db, user, provider, conversation, monkeypatch,
        [{"op": "add", "text": "User just moved to Berlin", "confidence": "high"}],
    )

    assert [s["content"] for s in saved] == ["User just moved to Berlin"]
    rows = (await db.execute(select(UserMemory))).scalars().all()
    assert len(rows) == MAX_MEMORIES


async def test_capture_with_no_user_text_never_calls_a_model(
    db, user, provider, conversation, monkeypatch
):
    """A regenerate or an empty turn shouldn't cost an extraction call."""
    import app.memory.service as svc
    from app.memory.service import capture_memories

    called = False

    async def _explode(**_kwargs):
        nonlocal called
        called = True
        yield "[]"

    monkeypatch.setattr(svc.model_router, "stream_chat", _explode)

    assert await capture_memories(
        db, user_id=user.id, user_text="   ", assistant_text="hi",
        source_conversation_id=conversation.id, provider=provider,
        model_id="test-model",
    ) == []
    assert called is False


async def test_capture_swallows_a_model_failure(
    db, user, provider, conversation, monkeypatch
):
    """Best-effort by contract: the reply is already on disk, and losing a
    fact is not a reason to break the turn the user is reading."""
    import app.memory.service as svc
    from app.memory.service import capture_memories

    async def _boom(**_kwargs):
        raise RuntimeError("provider exploded")
        yield  # pragma: no cover — makes this an async generator

    async def _cfg(_db):
        return None

    monkeypatch.setattr(svc.model_router, "stream_chat", _boom)
    monkeypatch.setattr(svc, "get_embedding_config", _cfg)

    assert await capture_memories(
        db, user_id=user.id, user_text="I moved to Berlin",
        assistant_text="Noted.", source_conversation_id=conversation.id,
        provider=provider, model_id="test-model",
    ) == []


# ------------------------------------------------------------ retrieval
#
# Which facts reach the prompt. The semantic path is what production runs
# whenever an embedder is configured, so it's stubbed at the embedding
# call rather than skipped — the pgvector query, the ordering and the
# usage re-rank are all real below.

_AXES = {"rust": 0, "cooking": 1, "cycling": 2, "berlin": 3}


def _fake_vector(text: str) -> list[float]:
    """A deterministic unit vector keyed on topic words.

    Facts sharing a topic word land on the same axis and so are close;
    everything else is orthogonal. Enough structure to prove the query
    actually drives the ordering, without a real embedding model.
    """
    vec = [0.0] * 768
    lowered = text.lower()
    hits = [i for word, i in _AXES.items() if word in lowered]
    if not hits:
        vec[767] = 1.0
        return vec
    weight = len(hits) ** -0.5
    for i in hits:
        vec[i] = weight
    return vec


def _stub_embeddings(monkeypatch):
    import app.memory.service as svc
    from app.chat.semantic_search import EmbeddingConfig

    cfg = EmbeddingConfig(provider=None, model_id="fake-embedder", dim=768)

    async def _get_cfg(_db):
        return cfg

    async def _embed(*, provider, model_id, texts, dimensions=None):
        return [_fake_vector(t) for t in texts]

    monkeypatch.setattr(svc, "get_embedding_config", _get_cfg)
    monkeypatch.setattr(svc, "embed_texts", _embed)
    return cfg


async def test_retrieval_puts_the_on_topic_fact_first(db, user, monkeypatch):
    from app.memory.service import embed_memory_row, retrieve_relevant_memories

    cfg = _stub_embeddings(monkeypatch)
    for content in (
        "User enjoys cooking Thai food",
        "User is a Rust developer",
        "User commutes by cycling",
    ):
        row = await _mem(db, user, content)
        await db.flush()
        await embed_memory_row(db, row, cfg)
    await db.commit()

    hits = await retrieve_relevant_memories(
        db, user.id, query="what rust crate should I use", k=1
    )

    assert [m.content for m in hits] == ["User is a Rust developer"]


async def test_retrieval_honours_k_and_exclusions(db, user, monkeypatch):
    """``exclude_ids`` is how pinned facts avoid being injected twice —
    if it leaked, the block would carry duplicates."""
    from app.memory.service import embed_memory_row, retrieve_relevant_memories

    cfg = _stub_embeddings(monkeypatch)
    rows = []
    for i in range(5):
        row = await _mem(db, user, f"User fact about rust number {i}")
        await db.flush()
        await embed_memory_row(db, row, cfg)
        rows.append(row)
    await db.commit()

    hits = await retrieve_relevant_memories(
        db, user.id, query="rust", k=2, exclude_ids={rows[0].id, rows[1].id}
    )

    assert len(hits) == 2
    assert rows[0].id not in {m.id for m in hits}
    assert rows[1].id not in {m.id for m in hits}


async def test_retrieval_falls_back_to_recency_without_embeddings(
    db, user, monkeypatch
):
    """Most self-hosted installs run with no embedder at all. Returning
    nothing there would silently disable memory for them."""
    import app.memory.service as svc
    from app.memory.service import retrieve_relevant_memories

    async def _none(_db):
        return None

    monkeypatch.setattr(svc, "get_embedding_config", _none)

    for i in range(4):
        await _mem(db, user, f"User fact {i}")
    await db.commit()

    hits = await retrieve_relevant_memories(db, user.id, query="anything", k=2)

    assert len(hits) == 2


async def test_retrieval_falls_back_when_the_embedder_errors(db, user, monkeypatch):
    """A provider outage should degrade memory to recency, not remove it
    from the turn — and definitely not raise into the chat stream."""
    import app.memory.service as svc
    from app.memory.service import retrieve_relevant_memories

    _stub_embeddings(monkeypatch)

    async def _boom(**_kwargs):
        raise RuntimeError("embedder down")

    monkeypatch.setattr(svc, "embed_texts", _boom)

    await _mem(db, user, "User is a Rust developer")
    await db.commit()

    hits = await retrieve_relevant_memories(db, user.id, query="rust", k=5)

    assert [m.content for m in hits] == ["User is a Rust developer"]


async def test_an_empty_query_skips_the_embedding_call(db, user, monkeypatch):
    """A short follow-up can normalise to nothing. Embedding empty text
    costs a round trip to be told nothing."""
    import app.memory.service as svc
    from app.memory.service import retrieve_relevant_memories

    _stub_embeddings(monkeypatch)
    called = False

    async def _embed(**_kwargs):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(svc, "embed_texts", _embed)

    await _mem(db, user, "User is a Rust developer")
    await db.commit()

    hits = await retrieve_relevant_memories(db, user.id, query="   ", k=5)

    assert called is False
    assert len(hits) == 1


# ------------------------------------------------ resolving a model
#
# The settings-panel surfaces (Tidy up, plain-English editing) have no
# conversation to inherit a model from, so they were the only paths that
# needed an admin to have set a default — and a single-user self-hosted
# install typically hasn't. They failed with an error pointing at an
# admin page the user may not even be able to reach.


async def test_falls_back_to_the_users_last_chat_model(db, user, provider):
    """Step 4 of the resolution chain, and the one that makes the feature
    work on an instance where nobody visited Admin → Defaults."""
    from app.chat.models import Conversation
    from app.memory.service import resolve_memory_model

    db.add(
        Conversation(
            user_id=user.id,
            title="somewhere",
            provider_id=provider.id,
            model_id="the-model-they-actually-use",
        )
    )
    await db.commit()

    resolved = await resolve_memory_model(db, user_id=user.id)

    assert resolved is not None
    assert resolved[1] == "the-model-they-actually-use"


async def test_no_user_and_no_defaults_resolves_to_nothing(db):
    """Callers skip the pass rather than guessing at a provider."""
    from app.memory.service import resolve_memory_model

    assert await resolve_memory_model(db) is None


async def test_a_disabled_provider_is_not_used(db, user, provider):
    """A provider the admin turned off shouldn't be revived by a stale
    conversation pointing at it."""
    from app.chat.models import Conversation
    from app.memory.service import resolve_memory_model

    provider.enabled = False
    db.add(
        Conversation(
            user_id=user.id,
            title="somewhere",
            provider_id=provider.id,
            model_id="some-model",
        )
    )
    await db.commit()

    assert await resolve_memory_model(db, user_id=user.id) is None


async def test_strict_retrieval_returns_nothing_rather_than_recency(db, user):
    from app.memory.service import retrieve_relevant_memories

    """Injection wants a best-effort answer; a *search* wants an honest
    one. With no embedder configured the ordinary path hands back the
    most recent facts, which is fine as background and a fabrication when
    a caller asked "what do they drive?" — so `recall` asks for strict."""
    from app.memory.service import retrieve_relevant_memories

    for i in range(3):
        db.add(UserMemory(user_id=user.id, content=f"User fact {i}"))
    await db.commit()

    lenient = await retrieve_relevant_memories(db, user.id, query="cars", k=5)
    strict = await retrieve_relevant_memories(
        db, user.id, query="cars", k=5, strict=True
    )

    assert len(lenient) == 3  # recency stand-in — right for injection
    assert strict == []       # nothing genuinely matched
