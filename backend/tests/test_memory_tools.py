"""The model's own hands on the memory store.

Until the `remember` / `forget` tools existed, memory could only be
written by a post-turn extraction pass sitting behind a regex gate — and
that gate is shaped like an assertion detector, so "I use Vim" got in and
"I don't use Vim any more" did not. Memory could learn but not unlearn.

The riskiest part of handing the model a pen isn't the writing, it's the
*locating*: `remember(replaces=...)` and `forget(about=...)` take a
description rather than an id, so a sloppy match silently rewrites or
deletes a fact the user never mentioned. Most of what follows pins down
that resolver's refusal to guess.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.chat.tools.base import ToolContext, ToolError
from app.chat.tools.memory import ForgetTool, RecallTool, RememberTool
from app.memory.constants import MAX_CONTENT_CHARS, MAX_MEMORIES
from app.memory.models import UserMemory


def _ctx(db, user, conversation) -> ToolContext:
    return ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=uuid.uuid4(),
    )


async def _forget_ctx(db, user, conversation) -> ToolContext:
    """A context whose triggering message is an explicit ask to forget.

    Deletion requires one in every mode, so tests that are about the
    *resolver* rather than the gate have to satisfy it — otherwise they'd
    all be re-testing the gate by accident.
    """
    from app.chat.models import Message

    trigger = Message(
        conversation_id=conversation.id,
        role="user",
        content="Please forget that, thanks.",
    )
    db.add(trigger)
    await db.commit()
    await db.refresh(trigger)
    return ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )


async def _add(db, user, content: str, **kw) -> UserMemory:
    row = UserMemory(user_id=user.id, content=content, **{"source": "auto", **kw})
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _all(db, user) -> list[UserMemory]:
    return list(
        (
            await db.execute(
                select(UserMemory).where(UserMemory.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )


# ---------------------------------------------------------------- remember


async def test_remember_saves_a_fact(db, user, conversation):
    result = await RememberTool().run(
        _ctx(db, user, conversation),
        {"content": "User prefers metric units", "category": "preferences"},
    )
    await db.commit()

    rows = await _all(db, user)
    assert [r.content for r in rows] == ["User prefers metric units"]
    assert rows[0].category == "preferences"
    # Provenance: the fact points back at the chat that produced it.
    assert rows[0].source_conversation_id == conversation.id
    # The SSE payload the in-chat "saved to memory" chip (and its Undo)
    # reads, in the same shape the extraction pass emits.
    assert result.meta["memory_writes"] == [
        {"id": str(rows[0].id), "content": "User prefers metric units"}
    ]


async def test_tool_writes_are_evictable(db, user, conversation):
    """Marked ``auto``, not ``manual``, on purpose: cap-eviction only ever
    recycles auto rows, so tool writes must stay in that pool or a chatty
    session could fill the store with entries nothing can evict."""
    await RememberTool().run(
        _ctx(db, user, conversation), {"content": "User likes tabs"}
    )
    await db.commit()

    assert (await _all(db, user))[0].source == "auto"


async def test_remember_ignores_an_unknown_category(db, user, conversation):
    await RememberTool().run(
        _ctx(db, user, conversation),
        {"content": "User is a developer", "category": "vibes"},
    )
    await db.commit()

    assert (await _all(db, user))[0].category is None


async def test_remember_is_idempotent(db, user, conversation):
    await _add(db, user, "User prefers dark mode")

    result = await RememberTool().run(
        _ctx(db, user, conversation), {"content": "User prefers dark mode"}
    )
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert result.meta["memory_writes"] == []


async def test_remember_rejects_an_overlong_fact(db, user, conversation):
    with pytest.raises(ToolError):
        await RememberTool().run(
            _ctx(db, user, conversation),
            {"content": "User " + "x" * (MAX_CONTENT_CHARS + 1)},
        )


async def test_remember_rejects_empty_content(db, user, conversation):
    with pytest.raises(ToolError):
        await RememberTool().run(
            _ctx(db, user, conversation), {"content": "   "}
        )


# ------------------------------------------------------- correction path


async def test_replaces_rewrites_in_place(db, user, conversation):
    """The whole point of the feature: a contradiction updates the stale
    fact instead of stacking a second one beside it."""
    stale = await _add(db, user, "User works at Acme")

    await RememberTool().run(
        _ctx(db, user, conversation),
        {"content": "User works at Globex", "replaces": "that they work at Acme"},
    )
    await db.commit()

    rows = await _all(db, user)
    assert [r.content for r in rows] == ["User works at Globex"]
    assert rows[0].id == stale.id  # same row, rewritten


async def test_replaces_that_matches_nothing_still_saves(db, user, conversation):
    """Failing to find the old fact is no reason to drop the new one —
    the user still told us something true."""
    await _add(db, user, "User lives in Berlin")

    await RememberTool().run(
        _ctx(db, user, conversation),
        {
            "content": "User uses Postgres",
            "replaces": "that they use MySQL for everything",
        },
    )
    await db.commit()

    assert sorted(r.content for r in await _all(db, user)) == [
        "User lives in Berlin",
        "User uses Postgres",
    ]


# ------------------------------------------------------------------ forget


async def test_forget_removes_the_matching_fact(db, user, conversation):
    await _add(db, user, "User uses Vim")
    await _add(db, user, "User is based in Sydney")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they use Vim"}
    )
    await db.commit()

    assert [r.content for r in await _all(db, user)] == ["User is based in Sydney"]
    assert result.meta["memory_forgot"][0]["content"] == "User uses Vim"


async def test_forget_matches_across_inflection(db, user, conversation):
    """Stored facts are third person ("User uses Vim"); the model
    describes them in the second ("that they use Vim"). Comparing raw
    word sets misses on that alone, which made the first version of the
    resolver find nothing at all."""
    await _add(db, user, "User uses Vim")

    await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they use Vim"}
    )
    await db.commit()

    assert await _all(db, user) == []


async def test_forget_with_no_match_deletes_nothing(db, user, conversation):
    """Reported as an outcome, not raised as an error — there may simply
    never have been such a fact, and the model should be able to say so
    rather than claim it deleted something."""
    await _add(db, user, "User uses Vim")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "their shellfish allergy"}
    )
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert "nothing to remove" in result.content


async def test_forget_requires_a_subject(db, user, conversation):
    with pytest.raises(ToolError):
        await ForgetTool().run(await _forget_ctx(db, user, conversation), {"about": ""})


# -------------------------------------------------- resolver won't guess


async def test_ambiguous_description_matches_nothing(db, user, conversation):
    """Two facts equally like the target means we'd be guessing which one
    to destroy. Guessing wrong deletes something the user never mentioned,
    so the resolver declines."""
    await _add(db, user, "User prefers Python for scripting")
    await _add(db, user, "User prefers Python for data work")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "prefers Python"}
    )
    await db.commit()

    assert len(await _all(db, user)) == 2
    assert "nothing to remove" in result.content


async def test_a_merely_topical_description_does_not_match(db, user, conversation):
    """Sharing a word is not being about the same thing."""
    await _add(db, user, "User is learning Rust in their spare time")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they dislike JavaScript"}
    )
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert "nothing to remove" in result.content


async def test_resolution_is_scoped_to_the_caller(db, user, provider, conversation):
    """Another account's memory must be invisible, not merely unreturned —
    a resolver that could reach across users would let one person's
    correction delete another's fact."""
    from app.auth.models import User

    other = User(
        email="other@example.com",
        username="other",
        password_hash="x",
        role="user",
    )
    db.add(other)
    await db.commit()
    await db.refresh(other)
    await _add(db, other, "User uses Vim")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they use Vim"}
    )
    await db.commit()

    assert len(await _all(db, other)) == 1
    assert "nothing to remove" in result.content


# ------------------------------------------------------------------- cap


async def test_at_the_cap_an_auto_fact_is_evicted(db, user, conversation):
    for i in range(MAX_MEMORIES):
        db.add(
            UserMemory(user_id=user.id, content=f"User fact {i}", source="auto")
        )
    await db.commit()

    await RememberTool().run(
        _ctx(db, user, conversation), {"content": "User prefers tabs"}
    )
    await db.commit()

    rows = await _all(db, user)
    assert len(rows) == MAX_MEMORIES
    assert any(r.content == "User prefers tabs" for r in rows)


async def test_a_full_unevictable_store_reports_rather_than_silently_dropping(
    db, user, conversation
):
    """Every row pinned or user-written means nothing can be recycled. The
    model needs to hear that, or it will tell the user their fact was
    saved when it wasn't."""
    for i in range(MAX_MEMORIES):
        db.add(
            UserMemory(
                user_id=user.id,
                content=f"User pinned fact {i}",
                source="manual",
                pinned=True,
            )
        )
    await db.commit()

    with pytest.raises(ToolError):
        await RememberTool().run(
            _ctx(db, user, conversation), {"content": "User prefers tabs"}
        )


# ------------------------------------------------------------- advertising


def test_both_tools_are_registered_under_the_memory_category():
    """The category is what gates advertisement on the user's memory
    setting — a tool registered under the wrong one would be offered to
    users who turned memory off."""
    from app.chat.tools.registry import tools_in

    names = {t.name for t in tools_in({"memory"})}
    assert names == {"remember", "forget", "recall"}


def test_memory_mode_resolution_gates_advertising():
    """The category alone doesn't decide who sees these tools — the
    router asks ``_resolve_memory_mode`` first, so a user who turned
    memory off must never be offered a tool that writes to it. The legacy
    boolean still has to resolve, or accounts predating the three-way
    setting would silently start getting memory writes."""
    from app.auth.models import User
    from app.chat.router import _resolve_memory_mode

    def _u(settings):
        return User(
            email="m@example.com",
            username="m",
            password_hash="x",
            role="user",
            settings=settings,
        )

    assert _resolve_memory_mode(_u({"memory_mode": "off"})) == "off"
    assert _resolve_memory_mode(_u({"memory_mode": "manual"})) == "manual"
    # Legacy opt-out predating memory_mode.
    assert _resolve_memory_mode(_u({"memory_enabled": False})) == "off"
    # Unset, or an unrecognised value, means on.
    assert _resolve_memory_mode(_u({})) == "auto"
    assert _resolve_memory_mode(_u(None)) == "auto"
    assert _resolve_memory_mode(_u({"memory_mode": "nonsense"})) == "auto"


# ------------------------------------------------- per-mode capture rules


def _memory_guideline(explicit_only: bool) -> str:
    from app.chat.tools.prompt import build_tools_system_prompt

    prompt = build_tools_system_prompt(
        {"memory"}, memory_explicit_only=explicit_only
    )
    return prompt.lower()


def test_explicit_only_forbids_uninvited_capture():
    """Two promises land on this flag — "Self-managed" mode and the
    per-chat capture pause — and both say Promptly never captures on its
    own. The tools stay available so an explicit "remember this" still
    works, which means the restraint has to come from the prompt, against
    a tool description that argues the opposite. If this goes quiet, both
    promises silently become Auto and nothing in the UI would show it."""
    text = _memory_guideline(True)

    assert "only when they explicitly ask" in text
    assert "do not save facts they merely mention" in text
    # The proactive phrasing from auto mode must not leak in.
    assert "or state something durable about themselves" not in text


def test_default_invites_proactive_capture():
    text = _memory_guideline(False)

    assert "state something durable about themselves" in text
    assert "only when they explicitly ask" not in text


def test_corrections_are_permitted_either_way():
    """Correcting a fact the user already asked to save isn't capture —
    withholding it under either promise would strand exactly the stale
    facts this whole change exists to fix."""
    for explicit_only in (True, False):
        assert "replaces" in _memory_guideline(explicit_only), explicit_only


# ------------------------------------------------ deletions stay visible


async def test_forget_reports_enough_to_restore(db, user, conversation):
    """A save is undone by deleting a row; an unwanted delete can only be
    undone by re-creating one, so the event has to carry the content back
    or the destructive direction becomes the irreversible one."""
    await _add(db, user, "User uses Vim", category="preferences")

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they use Vim"}
    )
    await db.commit()

    assert result.meta["memory_forgot"] == [
        {"content": "User uses Vim", "category": "preferences"}
    ]


async def test_forget_will_not_remove_a_pinned_fact(db, user, conversation):
    """Pinning is the user reaching in to say "this one matters". Undoing
    that on inference is too big a step to take silently."""
    await _add(db, user, "User is called Tris", pinned=True)

    result = await ForgetTool().run(
        await _forget_ctx(db, user, conversation), {"about": "that they are called Tris"}
    )
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert "pinned" in result.content.lower()
    assert result.meta["memory_forgot"] == []


# ------------------------------------------ the promise, enforced in code
#
# Prompt-level restraint was tried first and lost in live testing: with
# Self-managed set and a restraining guideline in the system prompt, the
# model still wrote two facts from "I've just started learning Portuguese
# and I usually work from a café". The settings panel promises "Promptly
# never captures anything on its own", so the check now runs server-side.


async def _msg(db, conversation, text: str):
    from app.chat.models import Message

    row = Message(conversation_id=conversation.id, role="user", content=text)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _self_managed(user):
    user.settings = {**(user.settings or {}), "memory_mode": "manual"}
    return user


async def test_self_managed_refuses_a_passing_mention(db, user, conversation):
    """The exact turn that leaked in testing."""
    trigger = await _msg(
        db,
        conversation,
        "I've just started learning Portuguese and I usually work from a café.",
    )
    ctx = ToolContext(
        db=db,
        user=_self_managed(user),
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    result = await RememberTool().run(ctx, {"content": "User is learning Portuguese"})
    await db.commit()

    assert await _all(db, user) == []
    assert result.meta["memory_writes"] == []
    assert "ask for it directly" in result.content


async def test_self_managed_still_honours_an_explicit_ask(db, user, conversation):
    """The other half of the contract — refusing everything would make the
    mode useless rather than restrained."""
    trigger = await _msg(db, conversation, "Remember that I'm learning Portuguese.")
    ctx = ToolContext(
        db=db,
        user=_self_managed(user),
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    await RememberTool().run(ctx, {"content": "User is learning Portuguese"})
    await db.commit()

    assert [m.content for m in await _all(db, user)] == [
        "User is learning Portuguese"
    ]


async def test_deletion_needs_an_explicit_ask_in_every_mode(db, user, conversation):
    """Deliberately stricter than saving, and stricter than the mode alone
    would require. Adding a fact on the model's own judgement is
    recoverable — it appears in the Memory panel and can be deleted.
    Removing one is not, and since memory writes are silent there is no
    chip to undo from either. The model decides what to remember; the
    user decides what to forget."""
    await _add(db, user, "User uses Vim")
    trigger = await _msg(db, conversation, "I've been trying out Helix lately.")
    ctx = ToolContext(
        db=db,
        user=user,  # Auto mode — the strict rule still applies
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    result = await ForgetTool().run(ctx, {"about": "that they use Vim"})
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert "needs the user to ask" in result.content


async def test_deletion_proceeds_on_an_explicit_ask(db, user, conversation):
    await _add(db, user, "User uses Vim")
    trigger = await _msg(db, conversation, "Forget that I use Vim.")
    ctx = ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    await ForgetTool().run(ctx, {"about": "that they use Vim"})
    await db.commit()

    assert await _all(db, user) == []


async def test_a_paused_chat_saves_nothing(db, user, conversation):
    """The pause used to gate only the post-turn extraction pass, so the
    tools walked straight through a switch the UI said was off."""
    conversation.memory_capture_paused = True
    trigger = await _msg(db, conversation, "I moved to Lisbon and I work in Go now.")
    ctx = ToolContext(
        db=db,
        user=user,  # Auto mode — the pause alone must be enough
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    result = await RememberTool().run(ctx, {"content": "User lives in Lisbon"})
    await db.commit()

    assert await _all(db, user) == []
    assert "paused for this chat" in result.content


async def test_a_paused_chat_refuses_even_an_explicit_ask(db, user, conversation):
    """This is what separates the pause from Self-managed mode. Both stop
    uninvited capture, but pausing a single conversation is a statement
    about that conversation — someone who pauses before a sensitive topic
    should not undo it by absent-mindedly saying "remember that"."""
    conversation.memory_capture_paused = True
    trigger = await _msg(db, conversation, "Remember that I've moved to Lisbon.")
    ctx = ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    result = await RememberTool().run(ctx, {"content": "User lives in Lisbon"})
    await db.commit()

    assert await _all(db, user) == []
    assert "paused for this chat" in result.content


async def test_a_paused_chat_refuses_deletion_too(db, user, conversation):
    await _add(db, user, "User uses Vim")
    conversation.memory_capture_paused = True
    trigger = await _msg(db, conversation, "Forget that I use Vim.")
    ctx = ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    result = await ForgetTool().run(ctx, {"about": "that they use Vim"})
    await db.commit()

    assert len(await _all(db, user)) == 1
    assert "paused for this chat" in result.content


async def test_self_managed_still_allows_an_explicit_ask_when_not_paused(
    db, user, conversation
):
    """The distinction cuts both ways: Self-managed is a preference about
    how memory works, so a deliberate save is exactly what it's for."""
    trigger = await _msg(db, conversation, "Remember that I've moved to Lisbon.")
    ctx = ToolContext(
        db=db,
        user=_self_managed(user),
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    await RememberTool().run(ctx, {"content": "User lives in Lisbon"})
    await db.commit()

    assert [m.content for m in await _all(db, user)] == ["User lives in Lisbon"]


async def test_auto_mode_saves_a_passing_mention(db, user, conversation):
    """The gate must not leak into Auto — capturing what you mention is
    the entire point of that mode."""
    trigger = await _msg(db, conversation, "I've just started learning Portuguese.")
    ctx = ToolContext(
        db=db,
        user=user,
        conversation_id=conversation.id,
        user_message_id=trigger.id,
    )

    await RememberTool().run(ctx, {"content": "User is learning Portuguese"})
    await db.commit()

    assert len(await _all(db, user)) == 1


def test_the_tool_description_no_longer_argues_for_proactive_saving():
    """A description saying "call this when they state something durable"
    beat a guideline asking for restraint. When to volunteer is per-mode,
    so it belongs to the guideline alone."""
    text = RememberTool.description.lower()

    assert "states something durable" not in text
    assert "asks you to remember" not in text
    # It must still say what the tool is for, and how to correct.
    assert "durable fact" in text
    assert "replaces" in text


def test_memory_tools_are_invisible_in_the_chat_surface():
    """Memory is plumbing, not work worth narrating. A tool card reading
    "ran 1 tool call" is noise when a fact is saved and actively
    misleading when the write is declined — it announces activity that
    produced nothing."""
    from app.chat.tools.registry import SILENT_TOOL_NAMES

    assert {"remember", "forget", "recall"} <= SILENT_TOOL_NAMES
    # Nothing else should have opted in by accident.
    assert SILENT_TOOL_NAMES == {"remember", "forget", "recall"}


# ------------------------------------------------------------------ recall
#
# Injection is a guess made before the turn starts: top-K out of a store
# of up to 200. The model holds a sample while sounding like it holds
# everything, so `recall` exists to let it go and look. Its failure mode
# is the quiet one — returning *something* plausible for a query it has
# no match for — so most of what follows is about the empty answer.


async def test_recall_finds_a_saved_fact(db, user, conversation):
    await _add(db, user, "User is a paramedic in Lisbon")
    await _add(db, user, "User is allergic to shellfish")

    result = await RecallTool().run(
        _ctx(db, user, conversation), {"query": "allergic"}
    )

    assert "shellfish" in result.content
    assert result.meta["total"] == 2


async def test_recall_says_so_when_nothing_matches(db, user, conversation):
    """Without an embedder the lexical pass must return *nothing* rather
    than the most recent row. A search tool that answers every query is
    worse than one that admits the miss — the model would present an
    unrelated fact as the answer."""
    await _add(db, user, "User is allergic to shellfish")

    result = await RecallTool().run(
        _ctx(db, user, conversation), {"query": "what car they drive"}
    )

    assert result.meta["matched"] == 0
    assert "shellfish" not in result.content
    assert "don't have it" in result.content


async def test_recall_on_an_empty_store(db, user, conversation):
    result = await RecallTool().run(_ctx(db, user, conversation), {"query": "job"})

    assert result.meta == {"query": "job", "matched": 0, "total": 0}
    assert "nothing saved" in result.content


async def test_an_empty_query_reviews_everything(db, user, conversation):
    for i in range(3):
        await _add(db, user, f"User fact number {i}")

    result = await RecallTool().run(_ctx(db, user, conversation), {"query": ""})

    assert result.meta["matched"] == 3
    assert result.content.count("\n- ") == 3


async def test_recall_is_scoped_to_the_caller(db, user, provider, conversation):
    """The store is per-account. A cross-user leak here would be silent
    and total — `recall` returns raw content, not a similarity score."""
    from app.auth.models import User

    other = User(
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        username=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(other)
    await db.commit()
    await db.refresh(other)
    db.add(UserMemory(user_id=other.id, content="Other user drives a Saab"))
    await db.commit()

    result = await RecallTool().run(
        _ctx(db, user, conversation), {"query": "Saab"}
    )

    assert "Saab" not in result.content
    assert result.meta["total"] == 0


async def test_recall_reports_how_it_was_learned(db, user, conversation):
    """Same provenance the injected block carries — a fact the model
    inferred shouldn't arrive with the authority of one the user typed."""
    await _add(db, user, "User uses Vim", source="manual")
    await _add(db, user, "User prefers dark mode", source="auto")

    result = await RecallTool().run(_ctx(db, user, conversation), {"query": ""})

    assert "User uses Vim (stated" in result.content
    assert "User prefers dark mode (inferred" in result.content


async def test_recall_works_when_capture_is_paused(db, user, conversation):
    """Pause is a promise about *writes*. Withholding facts the user
    already chose to save would break a second thing to enforce the
    first — and they're being injected into this very turn anyway."""
    conversation.memory_capture_paused = True
    await db.commit()
    await _add(db, user, "User is allergic to shellfish")

    result = await RecallTool().run(
        _ctx(db, user, conversation), {"query": "allergic"}
    )

    assert "shellfish" in result.content


async def test_recall_works_in_self_managed_mode(db, user, conversation):
    _self_managed(user)
    await db.commit()
    await _add(db, user, "User is allergic to shellfish")

    result = await RecallTool().run(
        _ctx(db, user, conversation), {"query": "allergic"}
    )

    assert "shellfish" in result.content


def test_recall_is_advertised_with_the_memory_tools():
    from app.chat.tools.registry import tools_in

    assert "recall" in {t.name for t in tools_in({"memory"})}
    assert "recall" not in {t.name for t in tools_in({"search", "code"})}


def test_the_guideline_tells_the_model_the_block_is_partial():
    """The read-side half of the fix: the tool is useless if the model
    doesn't know its prompt holds a selection rather than the store."""
    for explicit_only in (True, False):
        text = _memory_guideline(explicit_only)
        assert "recall" in text
        assert "not everything" in text
