"""Vision relay — caption images for non-vision chat models.

When the user's selected chat model can't read images, the chat
router routes each image attachment through an admin-configured
vision-capable model first, then splices the resulting caption into
the user's prompt as text. This module owns the captioning call
itself; the chat router owns "should we relay?" and "emit chips for
the UI" — keeping the policy + UI concerns at the call site and the
upstream call concentrated here.

Wire contract
-------------
``caption_image`` returns ``CaptionResult``:

* ``ok`` + ``text``     — captioning succeeded, ``text`` is the
                           caption to splice into the prompt.
* ``ok=False`` + ``error`` — captioning failed (provider down,
                           credentials missing, custom-model id
                           dangling, transient timeout, …). The
                           caller should drop the image, surface a
                           red chip, and continue without aborting
                           the whole turn.

Failures are intentionally swallowed (logged at WARNING) rather than
re-raised: a flaky relay should never break the user's actual chat
turn. Worst case we drop one image and the main model proceeds with
the rest of the prompt — the chip tells the user what happened so
they can retry, switch the relay model, or pick a vision-capable
chat model.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import UserFile
from app.files.prompt import build_image_parts, looks_image
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    ImagePart,
    ProviderError,
    TextPart,
    model_router,
)

logger = logging.getLogger("promptly.chat.vision_relay")

# Per-image budget for the captioning call. Relay models we recommend
# (Gemini Flash, GPT-4o-mini) finish in 1-3s on a real image. 30s is a
# very generous ceiling that still keeps a hung upstream from holding
# the whole chat turn hostage; the timer applies *per image* so a
# multi-image send still fails fast on the first stuck call.
RELAY_TIMEOUT_SECONDS = 30.0

# Hard ceiling on the caption length we splice into the prompt. The
# captioning model can be told to keep it brief, but a runaway model
# is best handled defensively too — at 4 chars/token a 4000-char cap
# is roughly 1000 tokens, well under any non-vision chat model's
# context budget per attachment.
MAX_CAPTION_CHARS = 4000

# System prompt for the captioning model. Tuned for general-purpose
# images attached to chats — encourages verbatim transcription of any
# visible text (the most common loss point) plus concrete description
# of layout. The user's question (when present) biases the caption
# toward what they're actually asking, so a meme + "is this funny?"
# gets a different caption than the same meme + "summarise the text
# in the image".
_CAPTION_SYSTEM = (
    "You describe images for a text-only AI model that cannot see them. "
    "Be specific and concrete: transcribe any visible text verbatim "
    "(signs, code, handwriting, tables, captions), describe people / "
    "objects / layout, and note anything that looks relevant to the "
    "user's question. Keep the description under ~200 words unless the "
    "image is text-heavy. Do not editorialise, speculate, or answer the "
    "user's question — your only job is to describe what's in the image."
)

# System prompt for the *indexing* path (pinned workspace images, scanned
# PDF pages). Unlike the chat relay above, there's no user question to bias
# toward and the output isn't shown to anyone — it's embedded for semantic
# retrieval, so we want a thorough, search-friendly description that
# captures every distinct element and all text verbatim. The retrieval
# layer matches a future query against this text, so recall beats brevity.
_INDEX_CAPTION_SYSTEM = (
    "You catalogue an image so it can be found by a later text search. "
    "Produce a thorough, factual description for a search index:\n"
    "- Transcribe ALL visible text verbatim (labels, titles, dimensions, "
    "annotations, legends, tables, handwriting).\n"
    "- Name every distinct object, region, or component and its spatial "
    "relationship to the others (left/right, above/below, adjacent).\n"
    "- For diagrams, floor plans, schematics, or charts: describe the "
    "layout, connections, rooms/zones, and any measurements or quantities.\n"
    "- Note dominant colours, materials, and style where they're "
    "meaningful (e.g. product photos, colour selections).\n"
    "Be comprehensive and concrete. Do not speculate beyond what's shown "
    "and do not editorialise — just describe what is in the image."
)

_INDEX_USER_PROMPT = (
    "Describe this image in full detail for a search index, transcribing "
    "all visible text."
)


@dataclass
class CaptionResult:
    """Outcome of one relay-captioning call.

    Either ``ok=True`` with a non-empty ``text``, or ``ok=False`` with
    an ``error`` string suitable for surfacing in the chip tooltip.
    Never both populated — the chat router renders the chip from
    whichever side is set.
    """

    ok: bool
    text: str | None = None
    error: str | None = None


async def caption_image(
    *,
    db: AsyncSession,
    image_file: UserFile,
    user_question: str = "",
    relay_provider: ModelProvider,
    relay_model_id: str,
    for_index: bool = False,
) -> CaptionResult:
    """Run one captioning call against the configured relay model.

    ``relay_model_id`` may be a synthetic ``custom:<uuid>`` id; we
    resolve it to a base provider + model id here so callers don't
    have to special-case Custom Models. ``relay_provider`` is the
    *containing* provider for non-custom ids, and a passthrough for
    custom ids (which carry their own resolved provider).

    ``user_question`` is the user's text turn — used to bias the
    captioning prompt so unrelated detail isn't wasted. Pass an
    empty string when the user only attached an image with no text.

    ``for_index`` switches to the thorough, search-oriented description
    (no user question, fuller transcription) used when captioning a
    pinned workspace image for the RAG index rather than relaying it
    into a live chat turn.
    """
    # Reject anything that isn't actually an image up-front so we
    # never burn a relay call on a PDF or a corrupted upload.
    if not looks_image(image_file):
        return CaptionResult(
            ok=False, error="Attachment isn't an image; nothing to caption."
        )

    # Resolve custom-model relay targets transparently. This lets an
    # admin point the relay at a custom model that wraps, say, a
    # Gemini Flash provider with a tuned system prompt — they don't
    # have to expose the base model in the picker.
    base_provider = relay_provider
    base_model_id = relay_model_id
    from app.custom_models.resolver import (  # local import — avoids cycle
        is_custom_model_id,
        resolve_custom_model,
    )

    if is_custom_model_id(relay_model_id):
        resolved = await resolve_custom_model(relay_model_id, db)
        if resolved is None:
            return CaptionResult(
                ok=False,
                error=(
                    "Relay model is a custom model that no longer "
                    "exists — ask an admin to fix the Vision relay setting."
                ),
            )
        base_provider = resolved.base_provider
        base_model_id = resolved.base_model_id

    # Re-use the chat router's image-loading helper so size limits,
    # transcoding, and Pillow verify all behave identically to the
    # normal pipeline. ``build_image_parts`` returns at most one part
    # for our single-element list (or empty + warnings on failure).
    parts, warnings = build_image_parts([image_file])
    if not parts:
        first_warning = warnings[0] if warnings else "Image could not be read."
        return CaptionResult(ok=False, error=first_warning)
    image_part: ImagePart = parts[0]

    # Indexing path: no user question to bias toward, and the output is
    # embedded (never shown), so use the thorough search-oriented prompts.
    if for_index:
        return await _caption_call(
            base_provider=base_provider,
            base_model_id=base_model_id,
            image_part=image_part,
            user_prompt=_INDEX_USER_PROMPT,
            system=_INDEX_CAPTION_SYSTEM,
            label=f"index:{image_file.id}",
        )

    # Compose the user-side prompt for the captioner. We deliberately
    # mention the user's question only when it's meaningfully long —
    # a one-word question ("hi", "ok") doesn't usefully bias the
    # caption and just risks confusing the model.
    question_excerpt = (user_question or "").strip()
    if len(question_excerpt) > 400:
        # Trim aggressively — the captioning model only needs the
        # gist to pick what to focus on, not the full prompt.
        question_excerpt = question_excerpt[:400].rstrip() + "…"

    if len(question_excerpt) >= 8:
        user_prompt = (
            f"Describe this image for a text-only model so it can answer "
            f"the user's question.\n\nUser's question: {question_excerpt}"
        )
    else:
        user_prompt = (
            "Describe this image in detail for a text-only model."
        )

    return await _caption_call(
        base_provider=base_provider,
        base_model_id=base_model_id,
        image_part=image_part,
        user_prompt=user_prompt,
        system=_CAPTION_SYSTEM,
        label=str(image_file.id),
    )


async def _caption_call(
    *,
    base_provider: ModelProvider,
    base_model_id: str,
    image_part: ImagePart,
    user_prompt: str,
    system: str,
    label: str,
) -> CaptionResult:
    """Run one captioning request against the relay model.

    Shared by the chat-relay and the indexing paths — they differ only in
    the ``system`` prompt and ``user_prompt`` they pass in. ``label`` is
    a short identifier (file id, ``"pdf-page-3"``) used only for logging.
    """
    request_message = ChatMessage(
        role="user",
        content=[TextPart(text=user_prompt), image_part],
    )

    # Run the captioning call with a per-image deadline. ``stream_chat``
    # returns an async generator of token strings; we accumulate them
    # into one buffer because the caller doesn't need progressive
    # surfacing — the chip stays in "captioning…" state until we
    # have the full caption to splice in.
    try:
        async with asyncio.timeout(RELAY_TIMEOUT_SECONDS):
            buf: list[str] = []
            async for token in model_router.stream_chat(
                provider=base_provider,
                model_id=base_model_id,
                messages=[request_message],
                system=system,
                # Low temperature: captioning benefits from consistency
                # over creativity. We're not asking for prose, just an
                # accurate description.
                temperature=0.2,
                # Generous output cap so a text-heavy image (a receipt,
                # a code screenshot) isn't truncated. The post-call
                # hard ceiling (``MAX_CAPTION_CHARS``) then defends
                # against a runaway model that ignores its instructions.
                max_tokens=1024,
            ):
                buf.append(token)
            caption = "".join(buf).strip()
    except asyncio.TimeoutError:
        logger.warning(
            "vision-relay-timeout label=%s relay=%s/%s",
            label,
            base_provider.id,
            base_model_id,
        )
        return CaptionResult(
            ok=False,
            error=(
                f"Captioning timed out after {int(RELAY_TIMEOUT_SECONDS)}s. "
                "Try again, switch the relay model, or pick a chat model "
                "that supports vision natively."
            ),
        )
    except ProviderError as exc:
        logger.warning(
            "vision-relay-provider-error label=%s relay=%s/%s err=%s",
            label,
            base_provider.id,
            base_model_id,
            exc,
        )
        return CaptionResult(
            ok=False,
            error=f"Relay model error: {exc}",
        )
    except Exception:  # pragma: no cover — unexpected crash path
        logger.exception(
            "vision-relay-unexpected label=%s relay=%s/%s",
            label,
            base_provider.id,
            base_model_id,
        )
        return CaptionResult(
            ok=False,
            error="Captioning failed unexpectedly. Check backend logs.",
        )

    if not caption:
        return CaptionResult(
            ok=False,
            error="Relay model returned an empty caption.",
        )

    # Hard truncate as a defence against a model that ignores the
    # ~200 word guidance. The user can always switch to a more
    # disciplined relay model if their pictures keep getting
    # truncated.
    if len(caption) > MAX_CAPTION_CHARS:
        caption = caption[:MAX_CAPTION_CHARS].rstrip() + "…"

    return CaptionResult(ok=True, text=caption)


async def caption_index_image_part(
    *,
    db: AsyncSession,
    image_part: ImagePart,
    relay_provider: ModelProvider,
    relay_model_id: str,
    label: str = "index",
) -> CaptionResult:
    """Caption a prebuilt :class:`ImagePart` for the RAG index.

    The bytes-source twin of ``caption_image(..., for_index=True)`` —
    used for rasterised PDF pages, which don't exist as ``UserFile``s.
    Resolves custom-model relay targets the same way and always uses the
    thorough indexing prompts.
    """
    base_provider = relay_provider
    base_model_id = relay_model_id
    from app.custom_models.resolver import (  # local import — avoids cycle
        is_custom_model_id,
        resolve_custom_model,
    )

    if is_custom_model_id(relay_model_id):
        resolved = await resolve_custom_model(relay_model_id, db)
        if resolved is None:
            return CaptionResult(
                ok=False,
                error="Relay custom model no longer exists.",
            )
        base_provider = resolved.base_provider
        base_model_id = resolved.base_model_id

    return await _caption_call(
        base_provider=base_provider,
        base_model_id=base_model_id,
        image_part=image_part,
        user_prompt=_INDEX_USER_PROMPT,
        system=_INDEX_CAPTION_SYSTEM,
        label=label,
    )


def format_captions_as_text(
    captions: list[tuple[uuid.UUID, str, CaptionResult]],
) -> str:
    """Render the per-image caption results as a preamble block.

    Splice the returned string in front of the user's text content
    so the non-vision chat model sees what the captioner saw. We
    format failed captions explicitly (as ``[Image #N: relay
    failed — …]``) rather than silently dropping them so the model
    can at least acknowledge that the user attached something.

    ``captions`` is a list of ``(file_id, filename, CaptionResult)``
    tuples ordered exactly as the images appear in the user's turn.
    The numbering in the preamble matches the chip numbering on the
    frontend so the user can correlate visually.
    """
    if not captions:
        return ""

    lines: list[str] = [
        "[Vision relay — the chat model cannot read images directly. "
        "The following descriptions were generated by a separate "
        "vision model and substituted in place of the originals.]",
    ]
    for idx, (_fid, filename, result) in enumerate(captions, start=1):
        header = f"Image #{idx} ({filename or 'unnamed'}):"
        if result.ok and result.text:
            lines.append(f"{header}\n{result.text}")
        else:
            lines.append(
                f"{header}\n[Caption failed: "
                f"{result.error or 'unknown error'}]"
            )
    return "\n\n".join(lines) + "\n\n"
