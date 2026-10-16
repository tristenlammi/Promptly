"""Ask your photos in chat (PH-4, Part E §E4.7).

* ``search_photos`` — the model fills in the structured question (it *is*
  the query understanding: "me and my wife at Noosa" → people ["me", "my
  wife"], place "Noosa"); the engine resolves, filters, ranks, relaxes and
  explains. The reply cites only what came back; the gallery card shows the
  photos (``meta.photo_results``: ids + chips — the card fetches fresh
  signed links, so an old chat still shows them).
* ``refine_photo_results`` — narrows or widens the last result set ("the
  beach ones", "only 2023", "without Sarah") by changing its question.

Result sets live in Redis for a week, per conversation.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import text

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

_KEY = "promptly:photoset:{}"
_TTL = 7 * 24 * 3600
_SHOWN = 24

_FILTERS = {
    "people": {"type": "array", "items": {"type": "string"}, "description": 'All must be in it: "me", names, or "my wife".'},
    "pets": {"type": "array", "items": {"type": "string"}},
    "species": {"type": "array", "items": {"type": "string"}, "description": '"dog", "cat", …'},
    "place": {"type": "string", "description": "Town, state or country."},
    "near": {"type": "boolean"},
    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
    "media": {"type": "string", "enum": ["photo", "video"]},
    "text": {"type": "string", "description": "Words written in it (a sign, a menu)."},
    "looks_like": {"type": "string", "description": 'What it shows: "on the beach", "birthday cake".'},
    "favorites": {"type": "boolean"},
    "sort": {"type": "string", "enum": ["relevance", "newest", "oldest", "best"]},
}


def _query(args: dict[str, Any]) -> Any:
    from app.photos.engine import query_from

    q = query_from(args)
    q.limit = 60
    return q


def _args_of(q: Any) -> dict[str, Any]:
    from app.photos.engine import args_of

    return args_of(q)


async def _redis():
    from app.redis_client import redis

    return redis


async def _run(ctx: ToolContext, q: Any, *, parent: str | None = None) -> ToolResult:
    from app.photos import engine

    out = await engine.search(ctx.db, ctx.user, q)
    set_id = uuid.uuid4().hex[:12]
    await (await _redis()).set(
        _KEY.format(set_id),
        json.dumps({"user_id": str(ctx.user.id), "conversation_id": str(ctx.conversation_id), "args": _args_of(q)}),
        ex=_TTL,
    )
    items = out["items"]
    lines = [f'Result set {set_id}: {len(items)} photo{"s" if len(items) != 1 else ""}' + (" (showing the best 24)" if len(items) > _SHOWN else "") + "."]
    if out["relaxed"]:
        lines.append("Nothing matched exactly, so these were widened: " + "; ".join(out["relaxed"]) + ". Say so.")
    for u in out["unresolved"]:
        lines.append(f"Couldn't resolve {u}.")
    for i, it in enumerate(items[:_SHOWN], 1):
        chips = ", ".join(f'{c["kind"]}: {c["label"]}' for c in it["chips"] if c["label"])
        lines.append(f'{i}. {it["filename"]} — {chips}' + (f' (+{it["similar"]} similar)' if it.get("similar") else ""))
    if not items:
        lines.append("No photos found. Don't invent any; suggest what to try instead.")
    lines.append("The photos are shown to the user in a gallery card; refer to them, don't list file names unless asked.")
    return ToolResult(
        content="\n".join(lines),
        meta={
            "photo_results": {
                "set_id": set_id, "parent": parent, "total": len(items),
                "items": [{"id": it["id"], "chips": it["chips"], "similar": it.get("similar", 0)} for it in items[:_SHOWN]],
                "understood": out["understood"], "relaxed": out["relaxed"], "unresolved": out["unresolved"],
            }
        },
    )


class SearchPhotosTool(Tool):
    name = "search_photos"
    category = "photos"
    timeout_seconds = 60.0
    max_content_chars = 6000
    description = (
        "Search the user's own photos and videos (who, where, when, what's in them; \"when did we get Max?\" = "
        "pet Max, sort oldest). Results show as a gallery; describe only what it returned, never guess."
    )
    parameters = {"type": "object", "properties": _FILTERS, "additionalProperties": False}

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        q = _query(args)
        if not (q.people or q.pets or q.species or q.place or q.date_from or q.date_to or q.media or q.text or q.visual or q.favorites):
            raise ToolError("Say something to look for: who, where, when, or what's in it.")
        ctx.report_progress("Looking through your photos…")
        return await _run(ctx, q)


class RefinePhotoResultsTool(Tool):
    name = "refine_photo_results"
    category = "photos"
    timeout_seconds = 60.0
    max_content_chars = 6000
    description = "Follow-ups on photos just found: add conditions (\"the beach ones\", \"only 2023\") or drop some (\"without Sarah\")."
    parameters = {
        "type": "object",
        "properties": {
            "set_id": {"type": "string", "description": "The result set the follow-up is about."},
            "add": {"type": "object", "description": "Any search_photos fields to add."},
            "remove": {
                "type": "array",
                "items": {"type": "string", "enum": ["people", "pets", "species", "place", "date", "media", "text", "looks_like", "favorites"]},
            },
            "remove_people": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["set_id"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        raw = await (await _redis()).get(_KEY.format(str(args.get("set_id", ""))[:40]))
        if not raw:
            raise ToolError("That result set has expired — search again.")
        saved = json.loads(raw)
        if saved.get("user_id") != str(ctx.user.id):
            raise ToolError("That result set has expired — search again.")
        merged = dict(saved["args"])
        for field in args.get("remove") or []:
            if field == "date":
                merged["date_from"] = merged["date_to"] = None
            elif field in ("people", "pets", "species"):
                merged[field] = []
            elif field == "favorites":
                merged[field] = False
            else:
                merged[field] = None
        gone = {p.lower() for p in args.get("remove_people") or []}
        merged["people"] = [p for p in merged.get("people") or [] if p.lower() not in gone]
        for k, v in (args.get("add") or {}).items():
            if k not in _FILTERS:
                continue
            if k in ("people", "pets", "species"):
                merged[k] = list(dict.fromkeys([*(merged.get(k) or []), *v]))
            elif v not in (None, "", []):
                merged[k] = v
        ctx.report_progress("Narrowing the photos…")
        return await _run(ctx, _query(merged), parent=args.get("set_id"))


_INSPECT_SYSTEM = (
    "You look at one personal photo to answer a question about it. Reply with JSON only: "
    "{\"answer\": \"yes\" | \"no\" | \"unsure\", \"why\": \"a few words on what you see\"}. "
    "Answer only from what is visible; don't guess who people are."
)


class InspectPhotosTool(Tool):
    name = "inspect_photos"
    category = "photos"
    timeout_seconds = 180.0
    max_content_chars = 4000
    max_per_turn = 2
    description = "Look at up to 12 photos of a result set to answer what search can't (\"where we're both smiling\")."
    parameters = {
        "type": "object",
        "properties": {
            "set_id": {"type": "string"},
            "question": {"type": "string", "description": "Yes/no, about each photo."},
            "count": {"type": "integer", "minimum": 1, "maximum": 12},
        },
        "required": ["set_id", "question"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        import asyncio

        from app.files.derivatives import rendition_path
        from app.photos import captions

        raw = await (await _redis()).get(_KEY.format(str(args.get("set_id", ""))[:40]))
        saved = json.loads(raw) if raw else None
        if not saved or saved.get("user_id") != str(ctx.user.id):
            raise ToolError("That result set has expired — search again.")
        vision = await captions.configured(ctx.db)
        if vision is None:
            raise ToolError("No Photos vision model is set up (an admin chooses one in Admin → Models → Defaults).")
        if not vision.local and not (ctx.user.settings or {}).get("photos_captions"):
            # A cloud model sees photos only for people who agreed to it.
            raise ToolError(
                f"Looking at photos would send them to {vision.label}; turn on Describe my photos in Photos settings first."
            )
        from app.photos import engine

        out = await engine.search(ctx.db, ctx.user, _query(saved["args"]))
        picked = out["items"][: int(args.get("count") or 12)]
        question = str(args.get("question") or "").strip()[:300]
        ctx.report_progress(f"Looking at {len(picked)} photos…")
        slots = asyncio.Semaphore(4)

        async def one(it: dict[str, Any]) -> tuple[dict[str, Any], str, str]:
            path = rendition_path(uuid.UUID(it["id"]), "preview.webp")
            if not path.is_file():
                return it, "unsure", "no preview"
            async with slots:
                try:
                    reply = await _ask(vision, await asyncio.to_thread(path.read_bytes), question, ctx.db)
                except Exception as exc:  # noqa: BLE001 — one photo's failure isn't the answer
                    return it, "unsure", exc.__class__.__name__
            return it, *reply

        answers = await asyncio.gather(*(one(it) for it in picked))
        yes = [it for it, a, _ in answers if a == "yes"]
        lines = [f'Looked at {len(picked)} photos for "{question}": {len(yes)} yes.']
        for i, (it, a, why) in enumerate(answers, 1):
            lines.append(f"{i}. {it['filename']}: {a} — {why}")
        set_id = uuid.uuid4().hex[:12]
        return ToolResult(
            content="\n".join(lines) + "\nThe matching photos are shown in a gallery card.",
            meta={
                "photo_results": {
                    "set_id": set_id, "parent": args.get("set_id"), "total": len(yes),
                    "items": [{"id": it["id"], "chips": [*it["chips"], {"kind": "looks", "label": question}], "similar": 0} for it in yes],
                    "understood": {"question": question}, "relaxed": [], "unresolved": [],
                }
            },
        )


async def _ask(vision: Any, preview: bytes, question: str, db: Any) -> tuple[str, str]:
    import asyncio
    import base64
    import re

    from app.models_config.provider import ChatMessage, ImagePart, TextPart, model_router
    from app.photos.captions import _jpeg

    provider, model_id = vision.provider, vision.model_id
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise ToolError("The Photos vision model no longer exists.")
        provider, model_id = resolved.base_provider, resolved.base_model_id
    data = await asyncio.to_thread(_jpeg, preview)
    url = "data:image/jpeg;base64," + base64.b64encode(data).decode()
    msg = ChatMessage(role="user", content=[TextPart(text=f"Question: {question}"), ImagePart(url=url)])
    async with asyncio.timeout(60):
        reply = "".join([t async for t in model_router.stream_chat(
            provider=provider, model_id=model_id, messages=[msg], system=_INSPECT_SYSTEM, temperature=0.0, max_tokens=120,
        )])
    m = re.search(r"\{.*\}", reply, re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except ValueError:
        d = {}
    answer = str(d.get("answer") or "").lower()
    if answer not in ("yes", "no", "unsure"):
        answer = "yes" if re.match(r"\s*yes\b", reply, re.I) else "no" if re.match(r"\s*no\b", reply, re.I) else "unsure"
    return answer, str(d.get("why") or reply)[:160].strip()


class ProposePhotoActionTool(Tool):
    """Albums, sharing and "Sarah is my wife" from a chat — as a preview
    card the person applies (see app.photos.chat_actions)."""

    name = "propose_photo_action"
    category = "photos"
    max_per_turn = 3
    timeout_seconds = 60.0
    description = (
        "Propose (the user applies it from a card): album — set_id or file_ids, plus title (smart: keeps adding "
        "matches) or album to add to; share — album, people (usernames/emails), role; relationship — person, label "
        "(\"my wife\")."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["album", "share", "relationship"]},
            "set_id": {"type": "string"},
            "file_ids": {"type": "array", "items": {"type": "string"}},
            "title": {"type": "string"},
            "album": {"type": "string"},
            "smart": {"type": "boolean"},
            "people": {"type": "array", "items": {"type": "string"}},
            "role": {"type": "string", "enum": ["viewer", "contributor"]},
            "person": {"type": "string"},
            "label": {"type": "string"},
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.chat.models import WorkspaceProposal
        from app.photos import chat_actions as ca

        action = args.get("action")
        try:
            if action == "album":
                set_args = None
                if args.get("set_id"):
                    raw = await (await _redis()).get(_KEY.format(str(args["set_id"])[:40]))
                    saved = json.loads(raw) if raw else None
                    if not saved or saved.get("user_id") != str(ctx.user.id):
                        raise ToolError("That result set has expired — search again.")
                    set_args = saved["args"]
                elif not args.get("file_ids"):
                    raise ToolError("Which photos? Give a set_id from a search, or file_ids.")
                payload = await ca.check_album(
                    ctx.db, ctx.user, set_args=set_args, file_ids=args.get("file_ids"), title=args.get("title"),
                    album=args.get("album"), smart=bool(args.get("smart")),
                )
                kind = "photo_album"
            elif action == "share":
                payload = await ca.check_share(ctx.db, ctx.user, album=args.get("album") or "", people=args.get("people") or [],
                                               role=args.get("role") or "viewer")
                kind = "photo_share"
            elif action == "relationship":
                payload = await ca.check_relationship(ctx.db, ctx.user, person=args.get("person") or "", label=args.get("label") or "")
                kind = "photo_relationship"
            else:
                raise ToolError("action must be album, share or relationship.")
        except ca.ActionError as exc:
            raise ToolError(str(exc)) from exc
        proposal = WorkspaceProposal(
            conversation_id=ctx.conversation_id, workspace_id=None, user_id=ctx.user.id, kind=kind, payload=payload,
        )
        ctx.db.add(proposal)
        await ctx.db.commit()
        return ToolResult(
            content=f"Proposal filed: {payload['summary']}. A card is showing in the chat — tell the user to review and Apply it; nothing has changed yet.",
            meta={"proposal_id": str(proposal.id), "kind": kind, "summary": payload["summary"]},
        )


async def has_library(db: Any, user_id: uuid.UUID) -> bool:
    """Whether to offer the photo tools at all."""
    return bool(await db.scalar(text("SELECT EXISTS (SELECT 1 FROM photo_assets WHERE user_id = :u)"), {"u": user_id}))


__all__ = ["InspectPhotosTool", "ProposePhotoActionTool", "RefinePhotoResultsTool", "SearchPhotosTool", "has_library"]
