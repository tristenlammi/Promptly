"""Memory write tools — the model's own hands on the memory store.

Until these existed the model was the *subject* of memory, never its
author: a regex decided whether a turn might contain something durable,
an extraction pass inferred facts from it, and the chat model only ever
saw a read-only block of what retrieval handed it. That works for
assertions ("I use Postgres") and fails for everything else. The
reconciliation prompt could already rewrite and delete stale facts, but
almost never got the chance, because the gate in front of it is shaped
like an assertion detector: "I no longer work at Acme", "stop calling me
Tris", and "I've switched from Python to Go" all sail straight past it.

So the store accumulated confidently-stated facts it had no realistic
way to retract — worse than not remembering, because a wrong fact is
injected into every relevant turn under an instruction to treat it as
known background.

These two tools close that loop. The model decides, in the moment, that
something is worth saving or is no longer true, and says so directly:

* ``remember`` — save a durable fact, optionally replacing one it
  supersedes (that's the correction path).
* ``forget`` — drop a fact that's no longer true and has no replacement.

Both locate existing facts by *description* rather than id. Ids would
have to be injected into the prompt to be usable, which costs tokens on
every turn and invites the model to recite them; a short phrase is what
the model naturally has to hand ("that I use Vim") and resolves fine
against a store capped at 200 rows.

The post-turn extraction pass stays as a backstop for turns where the
model doesn't think to act. It is no longer the only way in.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import select

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.memory.constants import (
    MAX_CONTENT_CHARS,
    MAX_MEMORIES,
    MEMORY_CATEGORIES,
)
from app.memory.models import UserMemory
from app.chat.models import Conversation, Message
from app.chat.semantic_search import get_embedding_config
from app.memory.service import (
    _evict_for_capture,
    _is_duplicate,
    _normalise,
    count_memories,
    embed_memory_row,
    is_explicit_memory_request,
    load_memories,
    looks_sensitive,
    resolve_memory_mode,
    retrieve_relevant_memories,
)

logger = logging.getLogger("promptly.chat.tools.memory")

_VALID_CATEGORIES = set(MEMORY_CATEGORIES)

# Words too common to carry any signal when matching a description
# against a stored fact. Every stored fact starts "User …" by
# convention, so without this a two-word locator matches everything.
_STOPWORDS = frozenset(
    {
        "user",
        "the",
        "a",
        "an",
        "that",
        "this",
        "is",
        "are",
        "was",
        "were",
        "be",
        "of",
        "to",
        "in",
        "on",
        "for",
        "and",
        "or",
        "my",
        "their",
        "them",
        "they",
        "it",
        "with",
        "has",
        "have",
        "had",
        "no",
        "not",
        "any",
        "more",
        "longer",
        "anymore",
    }
)

# How much of the locator's meaningful vocabulary must appear in a
# stored fact for them to be considered the same subject. Deliberately
# high: resolving to the *wrong* memory means silently rewriting or
# deleting something the user never mentioned, which is far worse than
# failing to find a match and telling them so.
_MATCH_THRESHOLD = 0.6


def _stem(word: str) -> str:
    """Crudest possible suffix stripping, and deliberately so.

    Stored facts are written in the third person ("User uses Vim") while
    the model describes them in the second ("that they use Vim"), so a
    plain word-set comparison misses on inflection alone — which is how
    the first version of this failed to find anything at all. Only the
    endings that cause that mismatch are stripped, and only when a real
    stem is left, so "is"/"has" survive intact.
    """
    for suffix, min_stem in (("ing", 4), ("ed", 4), ("es", 3), ("s", 3)):
        if word.endswith(suffix) and len(word) - len(suffix) >= min_stem:
            return word[: -len(suffix)]
    return word


def _tokens(text: str) -> set[str]:
    return {
        _stem(w)
        for w in re.findall(r"[\w']+", _normalise(text))
        if w not in _STOPWORDS
    }


async def _resolve(
    ctx: ToolContext, about: str
) -> UserMemory | None:
    """Find the one saved fact ``about`` refers to, or None.

    Three passes, most confident first: an exact normalised match, then
    containment either way (the model's phrasing is usually a fragment
    of the stored sentence, or vice versa), then vocabulary overlap.

    Ambiguity is treated as no match. If two stored facts look equally
    like the target we'd be guessing which one to overwrite, and the
    tool would rather report that it couldn't find it.
    """
    rows = (
        (
            await ctx.db.execute(
                select(UserMemory).where(UserMemory.user_id == ctx.user.id)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return None

    key = _normalise(about)
    exact = [m for m in rows if _normalise(m.content) == key]
    if len(exact) == 1:
        return exact[0]

    contained = [
        m
        for m in rows
        if key and (key in _normalise(m.content) or _normalise(m.content) in key)
    ]
    if len(contained) == 1:
        return contained[0]

    wanted = _tokens(about)
    if not wanted:
        return None
    scored = [
        (len(wanted & _tokens(m.content)) / len(wanted), m) for m in rows
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    best, row = scored[0]
    if best < _MATCH_THRESHOLD:
        return None
    # A clear runner-up means we can't tell which one they meant.
    if len(scored) > 1 and scored[1][0] >= best:
        return None
    return row


async def _refuse_if_paused(ctx: ToolContext, verb: str) -> str | None:
    """Return a refusal when this chat has memory capture paused.

    The pause is a hard off, not a "nothing automatic" — which is the one
    thing that distinguishes it from Self-managed mode. Self-managed is a
    standing preference about *how* memory works, so a deliberate "save
    this" is exactly what it's for. Pausing a single conversation is a
    statement about that conversation: whatever is discussed here doesn't
    leave it. Somebody who pauses a chat before a sensitive topic should
    not be able to undo that by absent-mindedly saying "remember that".

    Returns ``None`` when the write may proceed.
    """
    conv = await ctx.db.get(Conversation, ctx.conversation_id)
    if conv is None or not conv.memory_capture_paused:
        return None
    return (
        f"Memory is paused for this chat, so nothing was {verb} — that "
        "applies even when asked directly. Tell the user memory is paused "
        "here and they can turn it back on from the memory button in the "
        "composer if they want this kept."
    )


async def _refuse_uninvited(ctx: ToolContext, verb: str) -> str | None:
    """Return a refusal when this user only wants memory written on ask.

    "Self-managed" mode promises, in the settings panel's own words, that
    Promptly never captures anything on its own. Prompt-level restraint
    was tried first and lost to the tool's own description in live
    testing, so the check lives here, where the model's cooperation isn't
    required.

    Returns ``None`` when the write may proceed.
    """
    if resolve_memory_mode(ctx.user) != "manual":
        return None

    trigger = await ctx.db.get(Message, ctx.user_message_id)
    if trigger is not None and is_explicit_memory_request(trigger.content):
        return None

    return (
        f"This user manages their own memory, so nothing is {verb} unless "
        "they ask for it directly. They didn't this time — so nothing was "
        "changed. If you think it's worth saving, say so and let them "
        "decide."
    )


def _record(row: UserMemory) -> dict[str, str]:
    """Shape a written row for the ``memory_saved`` SSE event.

    Matches ``capture_memories``' return shape so the in-chat "saved to
    memory" affordance — including per-fact Undo — works for a
    tool-written memory without the UI knowing the difference.
    """
    return {"id": str(row.id), "content": row.content}


def _clean(content: str) -> str:
    text = (content or "").strip()
    if not text:
        raise ToolError("The memory text can't be empty.")
    if len(text) > MAX_CONTENT_CHARS:
        raise ToolError(
            f"That's too long to save ({len(text)} characters; the limit is "
            f"{MAX_CONTENT_CHARS}). Save the durable part as one short "
            "sentence."
        )
    if looks_sensitive(text):
        # Memory outlives the conversation and is replayed into every
        # relevant future turn, so a credential saved once is a credential
        # re-injected indefinitely. Refused rather than redacted: the
        # model can decide whether a non-secret version of the fact is
        # worth keeping, and silently storing a mangled secret helps
        # nobody.
        raise ToolError(
            "That looks like it contains a credential or ID number, so it "
            "wasn't saved. Long-term memory is replayed into future chats "
            "— keep secrets out of it. Save a version without the value if "
            "the fact itself is worth remembering."
        )
    return text


class RememberTool(Tool):
    name = "remember"
    category = "memory"
    silent = True
    # Deliberately silent on *when* to volunteer a save. That belongs to
    # the per-turn guideline in ``tools/prompt.py``, because the answer
    # depends on the user's memory mode — and a description that argued
    # for proactive saving was measurably stronger than a guideline
    # asking for restraint, which is how Self-managed mode came to
    # capture facts it had promised not to.
    description = (
        "Save a durable fact about the user to long-term memory, so it "
        "carries across every future conversation: their name or what to "
        "call them, their role, tools and languages they use, stable "
        "preferences (tone, format, units), or an ongoing project. When "
        "the fact CORRECTS or CONTRADICTS something already in memory — "
        "they changed jobs, switched languages, no longer want something "
        "— pass `replaces` describing the old fact so it is rewritten in "
        "place rather than left to contradict the new one. Never save "
        "one-off task details, the answer to their question, transient "
        "state ('I'm tired today'), or anything sensitive they didn't ask "
        "you to remember (passwords, card or ID numbers)."
    )
    prompt_hint = (
        "remember — save a durable fact about the user across chats; pass "
        "`replaces` when it corrects something already saved"
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": (
                    "The fact, as one concise third-person sentence "
                    "starting with 'User' — e.g. 'User prefers metric "
                    "units'."
                ),
            },
            "category": {
                "type": "string",
                "enum": list(MEMORY_CATEGORIES),
                "description": (
                    "identity = name, role, location. preferences = tools, "
                    "languages, formats, style. projects = active work and "
                    "goals. context = other durable background."
                ),
            },
            "replaces": {
                "type": "string",
                "description": (
                    "Optional. A short description of the existing saved "
                    "fact this supersedes, e.g. 'that they work at Acme'. "
                    "Use whenever the new fact contradicts something "
                    "already known. If nothing matches, the fact is saved "
                    "as new."
                ),
            },
        },
        "required": ["content"],
    }
    # Writing memory is cheap, but a model that decides to catalogue the
    # whole conversation shouldn't be able to. Four matches the
    # extraction pass's per-turn ceiling.
    max_per_turn = 4
    timeout_seconds = 20.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        refusal = await _refuse_if_paused(ctx, "saved") or await (
            _refuse_uninvited(ctx, "saved")
        )
        if refusal is not None:
            return ToolResult(content=refusal, meta={"memory_writes": []})

        content = _clean(str(args.get("content") or ""))
        category = args.get("category")
        if category not in _VALID_CATEGORIES:
            category = None

        replaces = str(args.get("replaces") or "").strip()
        if replaces:
            target = await _resolve(ctx, replaces)
            if target is not None:
                previous = target.content
                target.content = content
                if category is not None:
                    target.category = category
                await ctx.db.flush()
                await embed_memory_row(ctx.db, target)
                logger.info(
                    "memory tool: updated id=%s user=%s", target.id, ctx.user.id
                )
                return ToolResult(
                    content=(
                        f'Updated the saved memory "{previous}" to '
                        f'"{content}".'
                    ),
                    meta={"memory_writes": [_record(target)]},
                )
            # Fall through: the fact it meant to correct isn't there, so
            # the useful thing is still to save the new one.

        existing = (
            (
                await ctx.db.execute(
                    select(UserMemory).where(UserMemory.user_id == ctx.user.id)
                )
            )
            .scalars()
            .all()
        )
        if _is_duplicate(content, [_normalise(m.content) for m in existing]):
            return ToolResult(
                content="Already saved — memory is unchanged.",
                meta={"memory_writes": []},
            )

        if len(existing) >= MAX_MEMORIES:
            # Free a slot the same way auto-capture does: the least-used
            # auto-captured fact goes, never a pinned or user-stated one.
            if not await _evict_for_capture(ctx.db, ctx.user.id):
                raise ToolError(
                    f"Memory is full ({MAX_MEMORIES} saved) and every entry "
                    "is pinned or user-written, so nothing can be evicted. "
                    "Ask the user to remove a few from Settings → Memory."
                )

        row = UserMemory(
            user_id=ctx.user.id,
            content=content,
            # Deliberately "auto", not "manual": this is the model's
            # judgement, and the cap-eviction path only ever recycles
            # auto rows. Marking tool writes as user-stated would let a
            # chatty turn fill the store with entries nothing can evict.
            source="auto",
            source_conversation_id=ctx.conversation_id,
            category=category,
        )
        ctx.db.add(row)
        await ctx.db.flush()
        await embed_memory_row(ctx.db, row)
        logger.info("memory tool: saved id=%s user=%s", row.id, ctx.user.id)
        return ToolResult(
            content=f'Saved to memory: "{content}".',
            meta={"memory_writes": [_record(row)]},
        )


class ForgetTool(Tool):
    name = "forget"
    category = "memory"
    silent = True
    description = (
        "Delete a fact from the user's long-term memory. Call this when "
        "they ask you to forget something, or when they say a saved fact is "
        "no longer true and there is nothing to replace it with. If there "
        "IS a replacement — they moved, switched tools, changed their mind "
        "about a preference — call `remember` with `replaces` instead, so "
        "the fact is corrected rather than lost."
    )
    prompt_hint = (
        "forget — delete a saved memory that is no longer true (use "
        "`remember` with `replaces` when there's a corrected version)"
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "about": {
                "type": "string",
                "description": (
                    "A short description of the fact to remove, e.g. 'that "
                    "they use Vim' or 'their old job at Acme'."
                ),
            },
        },
        "required": ["about"],
    }
    max_per_turn = 4
    timeout_seconds = 20.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        paused = await _refuse_if_paused(ctx, "removed")
        if paused is not None:
            return ToolResult(content=paused, meta={"memory_forgot": []})

        # Deletion always requires an explicit ask — in every mode, not
        # just the two that promise restraint. Adding a fact on the
        # model's own judgement is recoverable: it shows up in the Memory
        # panel and can be deleted. Removing one is not, and since memory
        # writes are silent there is no chip to undo from either. So the
        # asymmetry is deliberate: the model may decide what to remember,
        # the user decides what to forget.
        trigger = await ctx.db.get(Message, ctx.user_message_id)
        if trigger is None or not is_explicit_memory_request(trigger.content):
            return ToolResult(
                content=(
                    "Removing a saved memory needs the user to ask for it — "
                    "they didn't here, so nothing was removed. If a fact "
                    "looks wrong, say so and let them decide, or use "
                    "`remember` with `replaces` to correct it instead."
                ),
                meta={"memory_forgot": []},
            )

        about = str(args.get("about") or "").strip()
        if not about:
            raise ToolError("Say which memory to forget.")

        target = await _resolve(ctx, about)
        if target is None:
            # Not an error the model should apologise for — there may
            # simply never have been such a fact. Tell it plainly so it
            # can say so rather than claiming it deleted something.
            return ToolResult(
                content=(
                    f'Nothing in memory matches "{about}", so there was '
                    "nothing to remove."
                ),
                meta={"memory_writes": []},
            )

        if target.pinned:
            # Pinning is the user reaching in and saying "this one
            # matters, keep it in front of you". Letting a tool call
            # undo that on inference is too big a step to take silently,
            # so this reports back instead of deleting.
            return ToolResult(
                content=(
                    f'"{target.content}" is pinned, so it wasn\'t removed. '
                    "Tell the user it's pinned and they can unpin or delete "
                    "it from Settings → Memory."
                ),
                meta={"memory_forgot": []},
            )

        removed = target.content
        removed_category = target.category
        logger.info("memory tool: forgot id=%s user=%s", target.id, ctx.user.id)
        await ctx.db.delete(target)
        await ctx.db.flush()
        return ToolResult(
            content=f'Removed from memory: "{removed}".',
            # Carries enough to put the fact back verbatim: the row is
            # gone, so Undo has to re-create rather than un-delete.
            meta={
                "memory_forgot": [
                    {"content": removed, "category": removed_category}
                ]
            },
        )


class RecallTool(Tool):
    """Read the whole store, not just what retrieval happened to surface.

    Injection is a guess made before the turn starts, from the user's
    message alone: top-K by cosine similarity, ten slots out of up to two
    hundred facts. That's the right default — but it means the model is
    holding a *sample* while sounding like it's holding everything. Ask
    "what do you know about me?" and it answers from the ten, with no way
    to tell that the other hundred and ninety exist.

    So this is the read-side mirror of ``remember``: the model decides
    mid-turn that it needs to look, and looks. Read-only, and unlike the
    write tools it isn't gated on memory mode — the facts are the user's,
    already saved by their own choice, and are being injected into this
    very turn regardless. Self-managed and pause both govern what gets
    *written*.
    """

    name = "recall"
    category = "memory"
    silent = True
    description = (
        "Search everything saved in the user's long-term memory. The few "
        "facts in your system prompt are only the ones judged relevant to "
        "this turn — they are not the whole store. Call this when the user "
        "asks what you know or remember about them, when they refer to "
        "something they told you before that isn't in front of you, or "
        "before saying you don't know something personal about them. "
        "Read-only: it never changes what is saved."
    )
    prompt_hint = (
        "recall — search the user's full saved memory, beyond the few facts "
        "already in your prompt"
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "What to look for, as a short topic phrase — 'their "
                    "job', 'dietary requirements', 'what they are "
                    "building'. Pass an empty string to review everything "
                    "saved."
                ),
            },
        },
        "required": ["query"],
    }
    # Enough to answer "what do you know about me?" without pouring a
    # 200-fact store into the context window.
    _LIMIT = 25
    max_per_turn = 3
    timeout_seconds = 20.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()

        total = await count_memories(ctx.db, ctx.user.id)
        if total == 0:
            return ToolResult(
                content="The user has nothing saved in memory yet.",
                meta={"query": query, "matched": 0, "total": 0},
            )

        if query:
            rows = await self._search(ctx, query)
            if not rows:
                return ToolResult(
                    content=(
                        f"Nothing in the user's {total} saved memories "
                        f'matches "{query}". Say you don\'t have it rather '
                        "than guessing."
                    ),
                    meta={"query": query, "matched": 0, "total": total},
                )
            heading = (
                f'Saved memories matching "{query}" '
                f"({len(rows)} of {total} saved)"
            )
        else:
            rows = await load_memories(ctx.db, ctx.user.id, limit=self._LIMIT)
            heading = f"All saved memories ({len(rows)} of {total})"

        lines = [f"{heading}:"]
        for m in rows:
            learned = m.updated_at or m.created_at
            origin = "stated" if m.source == "manual" else "inferred"
            stamp = (
                f" ({origin}, {learned.strftime('%b %Y')})"
                if learned
                else f" ({origin})"
            )
            lines.append(f"- {(m.content or '').strip()}{stamp}")
        return ToolResult(
            content="\n".join(lines),
            meta={"query": query, "matched": len(rows), "total": total},
        )

    async def _search(self, ctx: ToolContext, query: str) -> list[UserMemory]:
        """Semantic first, lexical when semantic can't answer.

        ``retrieve_relevant_memories`` degrades to *recency* whenever the
        embedding path can't run — no embedder configured, the provider
        unreachable, nothing embedded yet. That's right for background
        injection and wrong here: the model asked a question and would
        get the three most recent facts back under a heading claiming
        they match. ``strict`` turns that fallback off, and the lexical
        scan below answers instead, so a self-hosted install without a
        working embedder gets exact matches rather than confident noise.
        """
        cfg = await get_embedding_config(ctx.db)
        if cfg is not None:
            hits = await retrieve_relevant_memories(
                ctx.db,
                ctx.user.id,
                query=query,
                k=self._LIMIT,
                cfg=cfg,
                strict=True,
            )
            if hits:
                return hits

        rows = await load_memories(ctx.db, ctx.user.id, limit=MAX_MEMORIES)
        wanted = _tokens(query)
        if not wanted:
            return rows[: self._LIMIT]
        scored = [
            (len(wanted & _tokens(m.content or "")) / len(wanted), m)
            for m in rows
        ]
        scored.sort(key=lambda pair: -pair[0])
        return [m for score, m in scored if score > 0][: self._LIMIT]


__all__ = ["ForgetTool", "RecallTool", "RememberTool"]
