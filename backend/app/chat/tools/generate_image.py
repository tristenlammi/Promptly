"""``generate_image`` — author or edit an image via OpenRouter.

Phase B1 of the AI-artefacts plan. The assistant calls this when the
user asks for a picture / illustration / image edit. We:

1. Pick the user's first ``supports_image_output`` model from their
   available pool. Admins curate which image models are enabled in the
   Models tab; this tool just consumes whatever's lit up.
2. Optionally inline an image as a vision input — either the
   ``source_file_id`` the model passed explicitly, or (if absent) the
   first image attachment on the *triggering user message*. The
   auto-attach path is what makes "make this sunset" work without the
   model having to know file IDs.
3. Hit OpenRouter via :meth:`ModelRouter.generate_image` (raw HTTP —
   the OpenAI SDK doesn't know about ``modalities`` / ``images``).
4. Persist the resulting bytes to ``Generated Files / Media`` via
   :func:`persist_generated_file` and attach the new file to the
   assistant reply.

We intentionally do **not** attempt to overwrite a previously
generated image even though ``overwrite`` was the chosen versioning
mode for paired artefacts (Phase A2 PDFs). Iteration on an image
produces a *new* file pinned to a fresh chip — the user's chat
history would otherwise mutate retroactively, which is jarring. The
``overwrite`` rule still applies inside Phase A2's source-editor flow,
where it makes sense (download from chat reflects latest edit).

Hard caps live in :mod:`app.chat.router` (one image per turn so a
runaway tool loop can't burn budget). This module trusts that.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Message
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.models import UserFile
from app.files.storage import absolute_path
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    GeneratedImage,
    ProviderError,
    model_router,
)
from app.models_config.router import list_available_models_for

logger = logging.getLogger("promptly.tools.generate_image")

# Cap on a single inline source image. Image inputs above this rarely
# improve results (the model downsamples internally) and they balloon
# the request body. 8 MB matches the user-upload ceiling for media so
# any image the user could legitimately attach is fair game.
_MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024

_MAX_PROMPT_CHARS = 4_000

# Common image MIME types we'll send to OpenRouter as inline source
# images. WebP / GIF are accepted by Gemini Image; everything else we
# refuse so we don't paste arbitrary bytes into a vision input.
_VISION_INPUT_MIMES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}

# Default mime → file extension. Generated images come back as PNG
# from every model we currently support, but be defensive in case a
# new model returns JPEG / WebP.
_EXT_FOR_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


class GenerateImageTool(Tool):
    name = "generate_image"
    # Costly: every successful invocation hits a paid OpenRouter image
    # endpoint. One per turn keeps a runaway tool loop from burning the
    # user's budget without any visible feedback. The model can still
    # call once, react to the result, and call again on the *next*
    # user turn if iteration is needed.
    max_per_turn = 1
    description = (
        "Generate (or edit) an image and attach it to your reply. "
        "Call this whenever the user asks for an image, picture, "
        "illustration, drawing, photo, artwork, diagram, logo, icon, "
        "wallpaper, sketch, painting, render, mockup, poster, or "
        "anything else they want to *see*. Also call it when the user "
        "uploads an image and asks you to edit, modify, restyle, "
        "recolour, remove the background, change the lighting, add or "
        "remove objects, or generally produce a variation of it. "
        "Examples that should trigger this tool: 'draw me a...', "
        "'generate an image of...', 'create a picture of...', 'make a "
        "logo for...', 'turn this photo into watercolour', 'remove the "
        "background of the image I attached', 'show me what X would "
        "look like'. The image is saved into the user's "
        "'Generated Files / Media' folder and surfaced as a clickable "
        "thumbnail in chat. Do NOT call this for ASCII art, emoji "
        "compositions, or text-only descriptions of an image — only "
        "when an actual rendered image is the goal."
    )
    prompt_hint = (
        "Generate or edit an actual image and attach it to your reply. "
        "Use whenever the user wants a picture, illustration, logo, "
        "diagram, photo edit, or any visual the user wants to *see*. "
        "When the user attaches an image and asks you to modify it, "
        "call this tool — never refuse on the grounds that you 'can't "
        "produce images'. The most recent image the user attached in "
        "this turn is auto-passed as the edit source if you don't set "
        "source_file_id explicitly."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": (
                    "Detailed description of the image to generate. "
                    "Be specific about subject, style, lighting, "
                    "composition, mood, colours. When editing an "
                    "uploaded image, describe what should *change* "
                    "(\"replace the sky with a sunset\", \"remove the "
                    "lamp on the left\"); the model already sees the "
                    f"source. Maximum {_MAX_PROMPT_CHARS:,} characters."
                ),
                "maxLength": _MAX_PROMPT_CHARS,
            },
            "source_file_id": {
                "type": "string",
                "description": (
                    "Optional UUID of a previously uploaded or "
                    "generated image to use as the edit source. Leave "
                    "unset to auto-pick the most recent image the user "
                    "attached on this turn — that's the right answer "
                    "in almost every case. Only set this when the user "
                    "explicitly references a different file (e.g. "
                    "\"edit the image you generated earlier\")."
                ),
            },
        },
        "required": ["prompt"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        prompt = args.get("prompt")
        source_file_id_raw = args.get("source_file_id")

        if not isinstance(prompt, str) or not prompt.strip():
            raise ToolError("`prompt` is required and must be a non-empty string")
        prompt = prompt.strip()
        if len(prompt) > _MAX_PROMPT_CHARS:
            raise ToolError(
                f"`prompt` exceeds {_MAX_PROMPT_CHARS:,}-char limit"
            )

        # ---- Resolve source image (explicit > auto-attach > none) ----
        source_image: tuple[bytes, str] | None = None
        source_filename: str | None = None
        if source_file_id_raw is not None:
            if not isinstance(source_file_id_raw, str):
                raise ToolError("`source_file_id` must be a UUID string")
            try:
                source_id = uuid.UUID(source_file_id_raw)
            except ValueError as e:
                raise ToolError(f"`source_file_id` is not a valid UUID: {e}") from e
            file_row = await _load_user_image(ctx.db, ctx.user, source_id)
            if file_row is None:
                raise ToolError(
                    "source_file_id does not match any image you own"
                )
            source_image = await _read_image_bytes(file_row)
            source_filename = file_row.original_filename
        else:
            auto = await _auto_attach_source(ctx)
            if auto is not None:
                source_image, source_filename = auto

        # ---- Pick an image-capable model the user actually has ----
        provider, model_id = await _pick_image_model(ctx.db, ctx.user)

        # ---- Call OpenRouter ----
        try:
            result: GeneratedImage = await model_router.generate_image(
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                source_image=source_image,
            )
        except ProviderError as e:
            logger.info(
                "generate_image: provider error user=%s model=%s err=%s",
                ctx.user.id,
                model_id,
                e,
            )
            raise ToolError(str(e)) from e

        # ---- Persist + attach ----
        ext = _EXT_FOR_MIME.get(result.mime_type, ".png")
        out_filename = _build_filename(prompt, ext)
        try:
            row = await persist_generated_file(
                ctx.db,
                user=ctx.user,
                filename=out_filename,
                mime_type=result.mime_type,
                content=result.content,
            )
        except GeneratedFileError as e:
            raise ToolError(f"Couldn't save generated image: {e}") from e

        logger.info(
            "generate_image: ok user=%s model=%s bytes=%d cost=%s%s",
            ctx.user.id,
            model_id,
            row.size_bytes,
            f"${result.cost_usd:.4f}" if result.cost_usd is not None else "?",
            f" edit_of={source_filename!r}" if source_filename else "",
        )

        edit_phrase = (
            f" (edited from {source_filename!r})" if source_filename else ""
        )
        caption = (result.caption or "").strip()
        body = (
            f"Generated '{row.filename}' "
            f"({row.size_bytes:,} bytes) via {model_id}{edit_phrase}."
        )
        if caption:
            body += f" Model said: {caption}"

        meta: dict[str, Any] = {
            "filename": row.filename,
            "size_bytes": row.size_bytes,
            "model_id": model_id,
            "provider_name": provider.name,
            "edited": source_image is not None,
        }
        if source_filename:
            meta["source_filename"] = source_filename
        if result.cost_usd is not None:
            meta["cost_usd"] = result.cost_usd
        if result.total_tokens is not None:
            meta["total_tokens"] = result.total_tokens

        return ToolResult(
            content=body,
            attachment_ids=[row.id],
            meta=meta,
        )


# ====================================================================
# Helpers — kept module-private so the tool's surface area stays small
# ====================================================================
_FILENAME_FALLBACK = "image"
_FILENAME_MAX = 60


def _build_filename(prompt: str, ext: str) -> str:
    """Derive a friendly filename from the prompt + a timestamp suffix.

    Strip non-word chars, collapse whitespace, lowercase, truncate.
    Append ``-YYYYMMDD-HHMMSS`` so iterating ("now make it darker")
    doesn't collide with the previous file. The persistence layer
    always assigns a fresh UUID for the storage path, so collisions
    are cosmetic — the suffix just helps the user tell versions apart
    in their files list.
    """
    cleaned = re.sub(r"[^\w\s-]+", "", prompt).strip().lower()
    cleaned = re.sub(r"\s+", "-", cleaned) or _FILENAME_FALLBACK
    if len(cleaned) > _FILENAME_MAX:
        cleaned = cleaned[:_FILENAME_MAX].rstrip("-")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{cleaned}-{stamp}{ext}"


async def _load_user_image(
    db: AsyncSession, user: User, file_id: uuid.UUID
) -> UserFile | None:
    """Look up an image owned by ``user`` (returns ``None`` if not theirs).

    Validates ownership *and* MIME so the model can't smuggle a PDF /
    text file into the vision input field.
    """
    row = await db.get(UserFile, file_id)
    if row is None:
        return None
    if row.user_id != user.id:
        return None
    if row.mime_type not in _VISION_INPUT_MIMES:
        return None
    return row


async def _read_image_bytes(row: UserFile) -> tuple[bytes, str]:
    """Read the on-disk blob for a ``UserFile`` row.

    Returns ``(bytes, mime)``. Raises :class:`ToolError` for missing
    files / oversized blobs so the dispatch loop can surface a clean
    error to the model.
    """
    try:
        path = absolute_path(row.storage_path)
    except ValueError as e:
        raise ToolError(f"Refusing to read suspicious source path: {e}") from e
    if not path.exists():
        raise ToolError(
            f"Source file '{row.filename}' is missing on disk"
        )
    if row.size_bytes > _MAX_SOURCE_IMAGE_BYTES:
        raise ToolError(
            "Source image is too large to use as an edit input "
            f"({row.size_bytes:,} bytes; cap is "
            f"{_MAX_SOURCE_IMAGE_BYTES:,})"
        )
    try:
        data = path.read_bytes()
    except OSError as e:
        raise ToolError(f"Failed to read source image: {e}") from e
    return data, row.mime_type


async def _auto_attach_source(
    ctx: ToolContext,
) -> tuple[tuple[bytes, str], str] | None:
    """Find the most recent image attachment on the triggering turn.

    Returns ``((bytes, mime), filename)`` or ``None`` if the user
    didn't attach an image (in which case we run as a pure text-to-
    image generation). Failures while loading silently fall through to
    "no source" rather than aborting — the model would rather generate
    *something* than fail outright when the auto-attach path is best-
    effort.
    """
    msg = await ctx.db.get(Message, ctx.user_message_id)
    if msg is None or not msg.attachments:
        return None
    # Walk newest-first so multiple attachments resolve to the most
    # recently picked one (which is the one a typical chat client
    # surfaces last to the user too).
    for att in reversed(msg.attachments):
        if not isinstance(att, dict):
            continue
        att_id = att.get("id")
        if not att_id:
            continue
        try:
            file_id = uuid.UUID(str(att_id))
        except ValueError:
            continue
        row = await _load_user_image(ctx.db, ctx.user, file_id)
        if row is None:
            continue
        try:
            data, mime = await _read_image_bytes(row)
        except ToolError:
            # Best-effort: if we can't read this one, fall through and
            # try the next attachment instead of failing the whole
            # generation.
            continue
        return (data, mime), row.original_filename
    return None


async def _pick_image_model(
    db: AsyncSession, user: User
) -> tuple[ModelProvider, str]:
    """Pick the first image-capable model the user can actually invoke.

    We deliberately don't honour the user's currently selected chat
    model here — chat models (Gemini Pro / Claude / GPT-4o) usually
    *don't* support image *output*. Instead we walk the user's full
    available pool, filter by ``supports_image_output``, and take the
    first match. Admins control the order by curating the provider's
    ``enabled_models`` list.
    """
    available = await list_available_models_for(user, db)
    image_models = [m for m in available if m.supports_image_output]
    if not image_models:
        raise ToolError(
            "No image-capable models are enabled. Ask an admin to "
            "enable an image model (e.g. google/gemini-2.5-flash-image) "
            "in the Models tab."
        )
    chosen = image_models[0]
    provider_row = await db.get(ModelProvider, chosen.provider_id)
    if provider_row is None:  # pragma: no cover — race with admin delete
        raise ToolError(
            f"Provider for model {chosen.model_id!r} disappeared mid-call"
        )
    return provider_row, chosen.model_id


__all__ = ["GenerateImageTool"]
