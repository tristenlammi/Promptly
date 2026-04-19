"""Provider abstraction layer.

Phase 2b scope (per product decision): OpenRouter only. The abstraction is
still generic so Anthropic native / Ollama / openai_compatible can plug in
later without touching callers.

Multimodal content (Phase 2 of the file-attachment plan)
--------------------------------------------------------
``ChatMessage.content`` accepts either a plain ``str`` (legacy / text-only
turns) or a list of :class:`ContentPart` instances (multimodal turns).
``ContentPart`` is currently :class:`TextPart` or :class:`ImagePart`; PDFs
and audio can plug in here later without touching call sites.

Serialisation rules:

* ``content: str`` → ``{"role": ..., "content": "<str>"}`` — the same wire
  shape we sent before this refactor. Existing call sites are completely
  unchanged.
* ``content: list[ContentPart]`` → ``{"role": ..., "content": [<parts>]}``
  using the OpenAI-style typed-array shape that OpenRouter, OpenAI and
  Anthropic-via-router all accept. Per-part ``to_openai()`` lives on each
  part class so adding a new modality is a one-place edit.

Tool calling (Phase A1 of the AI-artefacts plan)
------------------------------------------------
``stream_chat_events`` is the modern entrypoint that surfaces
**structured stream events** (text deltas, tool-call deltas, usage). The
chat router consumes these directly so the model can call registered
tools mid-stream. ``stream_chat`` is kept as a thin text-only wrapper so
every other caller (titler, search distiller, study chat) keeps the
exact wire shape they had before.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any, Union

import httpx
from openai import AsyncOpenAI, OpenAIError

from app.auth.utils import decrypt_secret
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.modelrouter")

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# OpenRouter recommends these headers for routing + analytics. They also
# appear in rate-limit dashboards for the app.
OPENROUTER_HEADERS = {
    "HTTP-Referer": "https://promptly.local",
    "X-Title": "Promptly",
}


class ProviderError(Exception):
    """Raised when a provider request fails (auth, network, model unavailable)."""


# ====================================================================
# Multimodal content parts
# ====================================================================
@dataclass
class TextPart:
    """A text fragment inside a multimodal user message."""

    text: str

    def to_openai(self) -> dict[str, Any]:
        return {"type": "text", "text": self.text}


@dataclass
class ImagePart:
    """An image fed to a vision-capable model.

    ``url`` may be either a remote ``https://`` URL or an inline
    ``data:image/<mime>;base64,...`` URL. We don't try to download/inline
    here — that's the caller's job (the chat router, in Phase 4).

    ``detail`` mirrors OpenAI's ``image_url.detail`` knob (``"auto"`` /
    ``"low"`` / ``"high"``). Most routers accept it; those that don't will
    silently ignore the field.
    """

    url: str
    detail: str = "auto"

    def to_openai(self) -> dict[str, Any]:
        return {
            "type": "image_url",
            "image_url": {"url": self.url, "detail": self.detail},
        }


# Type alias for anything that can sit inside a `content[]` array. Adding
# a new modality (PdfPart, AudioPart, …) is a matter of defining a new
# dataclass with a `to_openai()` method and extending this union.
ContentPart = Union[TextPart, ImagePart]


# ====================================================================
# Tool calling — stream events
# ====================================================================
# OpenAI's streaming API delivers tool calls in *deltas*: the same
# ``index`` accumulates ``id`` / ``function.name`` / ``function.arguments``
# across multiple chunks, with arguments arriving as a JSON string built
# up character-by-character. We surface those deltas raw so the chat
# router can buffer them itself (the buffering rules are router-side
# policy: when to commit, how to error on bad JSON, what to log, etc.).
#
# The four event kinds below are the *only* shapes that come out of
# ``stream_chat_events``. Keeping it a closed union (instead of free-form
# dicts) means a typo in a key name on either side breaks at import time
# instead of silently swallowing a token.


@dataclass
class TextDelta:
    """A chunk of assistant text. Concatenate ``text`` to build the reply."""

    text: str


@dataclass
class ToolCallDelta:
    """One slice of a tool call.

    ``index`` is the position in the model's ``tool_calls`` array; multiple
    deltas with the same index belong to the same call and must be merged
    by the caller. ``id`` and ``name`` are stable once seen but typically
    only arrive on the *first* delta for an index. ``arguments`` is a
    *partial* JSON string that grows over time; the caller concatenates
    every delta's ``arguments`` for the same ``index`` and parses the
    final accumulated string when the stream finishes.
    """

    index: int
    id: str | None = None
    name: str | None = None
    arguments: str | None = None


@dataclass
class FinishEvent:
    """End-of-turn marker.

    ``reason`` mirrors OpenAI's ``finish_reason``:

    * ``"stop"`` — the model produced a complete reply, nothing more to do.
    * ``"tool_calls"`` — the model wants to invoke one or more tools; the
      caller should run them and then issue a follow-up call with the
      results appended.
    * ``"length"`` / ``"content_filter"`` / ``None`` — provider-specific
      truncation; the caller treats these the same as ``"stop"``.
    """

    reason: str | None = None


@dataclass
class UsageEvent:
    """Token-accounting summary that arrives in the final chunk.

    Emitted only when the caller passed ``include_usage=True``. Mirrors the
    shape of OpenAI's ``usage`` block — fields default to ``None`` because
    some providers omit individual counts.
    """

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    # Provider-reported USD cost for this hop. OpenRouter populates
    # ``usage.cost`` on every stream; direct OpenAI / Anthropic do not.
    # The chat loop sums it across hops and persists it on the
    # assistant message + folds it into the daily rollup so admins can
    # see real spend without round-tripping a price table.
    cost_usd: float | None = None


StreamEvent = Union[TextDelta, ToolCallDelta, FinishEvent, UsageEvent]


def _serialize_part(part: ContentPart) -> dict[str, Any]:
    """Serialise a single content part. Defensive isinstance check so a
    bad union member raises a clear error rather than silently producing
    a broken payload."""
    if isinstance(part, (TextPart, ImagePart)):
        return part.to_openai()
    raise TypeError(f"Unsupported ContentPart subtype: {type(part).__name__}")


@dataclass
class ChatMessage:
    role: str  # 'system' | 'user' | 'assistant'
    content: str | list[ContentPart] = field(default="")

    def to_openai(self) -> dict[str, Any]:
        # Plain-string fast path keeps every legacy caller wire-identical
        # to the pre-refactor behaviour.
        if isinstance(self.content, str):
            return {"role": self.role, "content": self.content}
        # Multimodal path: emit the typed array shape.
        return {
            "role": self.role,
            "content": [_serialize_part(p) for p in self.content],
        }

    def is_multimodal(self) -> bool:
        return not isinstance(self.content, str)


def _safe_int(value: Any) -> int | None:
    """Coerce a number-ish value to int, returning None on anything weird.

    Some providers send token counts as floats or strings depending on
    the codec; normalise here so downstream maths can't trip over a
    surprise type.
    """
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    """Sister of :func:`_safe_int` for fractional values (e.g. ``cost``)."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ====================================================================
# Image generation — data URL helpers + result dataclass
# ====================================================================
def _bytes_to_data_url(data: bytes, mime_type: str) -> str:
    """Encode raw bytes as a ``data:<mime>;base64,<payload>`` URL.

    OpenRouter's image-input messages accept inline data URLs directly
    on ``image_url.url``; this is a simple wrapper so the encoding
    rules live in one place.
    """
    import base64

    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _data_url_to_bytes(url: str) -> tuple[bytes, str]:
    """Inverse of :func:`_bytes_to_data_url`.

    Strict on purpose: only base64 data URLs are accepted (the only
    encoding OpenRouter actually returns today). Returns ``(raw_bytes,
    mime_type)``. Raises :class:`ValueError` for anything malformed.
    """
    import base64

    if not url.startswith("data:"):
        raise ValueError("not a data: URL")
    head, _, payload = url[5:].partition(",")
    if not payload:
        raise ValueError("data URL missing payload")
    if ";base64" not in head:
        raise ValueError("data URL is not base64-encoded")
    mime_type = head.split(";", 1)[0] or "application/octet-stream"
    try:
        raw = base64.b64decode(payload, validate=False)
    except (ValueError, TypeError) as e:
        raise ValueError(f"invalid base64 payload: {e}") from e
    return raw, mime_type


@dataclass
class GeneratedImage:
    """The structured result of :meth:`ModelRouter.generate_image`.

    ``content`` carries the raw bytes (caller persists via
    ``persist_generated_file``); ``caption`` is the assistant's
    accompanying text — Gemini Image often replies with one or two
    sentences alongside the image, which makes for a nicer chat
    transcript when surfaced as a tool message.
    """

    content: bytes
    mime_type: str
    caption: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    # Some OpenRouter responses include a `cost` float in `usage` (USD).
    # When present we surface it on the tool chip so the user can see
    # what they just paid for.
    cost_usd: float | None = None


def _api_key_for(provider: ModelProvider) -> str:
    if not provider.api_key:
        raise ProviderError(f"Provider {provider.name!r} has no API key configured")
    try:
        return decrypt_secret(provider.api_key)
    except ValueError as e:
        raise ProviderError(f"Unable to decrypt API key for {provider.name!r}: {e}") from e


def _detect_vision(raw_model: dict[str, Any]) -> bool:
    """Decide whether an OpenRouter catalog row supports image input.

    OpenRouter ships an ``architecture`` block on each model. Newer rows
    use a structured ``input_modalities`` list; older rows only have a
    ``modality`` string of the form ``"text+image->text"``. We accept
    either signal and also fall back to a tag scan so a model with neither
    field but a ``vision`` tag still lights up.
    """
    arch = raw_model.get("architecture")
    if isinstance(arch, dict):
        modalities = arch.get("input_modalities")
        if isinstance(modalities, list) and "image" in modalities:
            return True
        modality = arch.get("modality")
        if isinstance(modality, str) and "image" in modality.split("->")[0]:
            return True

    tags = raw_model.get("tags")
    if isinstance(tags, list) and any(
        isinstance(t, str) and t.lower() in {"vision", "multimodal"} for t in tags
    ):
        return True
    return False


def _detect_image_output(raw_model: dict[str, Any]) -> bool:
    """Decide whether an OpenRouter catalog row can *emit* images.

    Mirror of :func:`_detect_vision` but for the *output* side. Same
    ``architecture`` block, but read ``output_modalities`` (newer rows)
    or the right-hand side of ``"text+image->text+image"``-style
    ``modality`` strings (older rows). Falls back to a tag scan so
    image-only models tagged ``image-generation`` still light up.
    """
    arch = raw_model.get("architecture")
    if isinstance(arch, dict):
        modalities = arch.get("output_modalities")
        if isinstance(modalities, list) and "image" in modalities:
            return True
        modality = arch.get("modality")
        if isinstance(modality, str):
            parts = modality.split("->")
            if len(parts) > 1 and "image" in parts[1]:
                return True

    tags = raw_model.get("tags")
    if isinstance(tags, list) and any(
        isinstance(t, str)
        and t.lower() in {"image-generation", "image_output", "image-output"}
        for t in tags
    ):
        return True
    return False


def _client_for(provider: ModelProvider) -> AsyncOpenAI:
    if provider.type != "openrouter":
        raise ProviderError(
            f"Provider type {provider.type!r} is not supported yet "
            "(Phase 2b: openrouter only)"
        )
    return AsyncOpenAI(
        api_key=_api_key_for(provider),
        base_url=provider.base_url or OPENROUTER_BASE_URL,
        default_headers=OPENROUTER_HEADERS,
    )


class ModelRouter:
    """Unified streaming interface for chat completions.

    All concrete methods normalise provider-specific errors to `ProviderError`
    and yield plain strings for tokens so downstream code never has to branch
    on provider type.
    """

    async def stream_chat_events(
        self,
        *,
        provider: ModelProvider,
        model_id: str,
        messages: list[ChatMessage] | list[dict[str, Any]],
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = 4096,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        include_usage: bool = False,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a chat completion as structured events.

        This is the modern entrypoint that the chat router uses to drive
        the tool-calling loop. Unlike :meth:`stream_chat`, it surfaces
        ``ToolCallDelta`` and ``FinishEvent`` so the caller can detect a
        ``finish_reason == "tool_calls"`` mid-stream, dispatch the tools,
        and then re-enter with the same ``messages`` list extended by an
        ``assistant`` row carrying the tool calls and one ``tool`` row
        per result.

        ``messages`` accepts either ``ChatMessage`` instances (which are
        serialised via ``to_openai()``) **or** raw OpenAI-shaped dicts.
        The dict path exists so the tool loop can append the
        provider-native ``{"role": "assistant", "tool_calls": [...]}`` /
        ``{"role": "tool", "tool_call_id": ..., "content": ...}`` rows
        without round-tripping them through the typed dataclass — those
        shapes have no first-class representation today.

        ``tools`` is the OpenAI-format list:
        ``[{"type": "function", "function": {"name", "description",
        "parameters": <jsonschema>}}, ...]``. Pass ``None`` when no tools
        are enabled and the provider treats it as a plain text turn.
        """
        client = _client_for(provider)

        payload_messages: list[dict[str, Any]] = []
        if system:
            payload_messages.append({"role": "system", "content": system})
        for m in messages:
            if isinstance(m, ChatMessage):
                payload_messages.append(m.to_openai())
            else:
                payload_messages.append(m)

        create_kwargs: dict[str, Any] = dict(
            model=model_id,
            messages=payload_messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        if tools:
            create_kwargs["tools"] = tools
            if tool_choice is not None:
                create_kwargs["tool_choice"] = tool_choice
        if include_usage:
            create_kwargs["stream_options"] = {"include_usage": True}

        try:
            stream = await client.chat.completions.create(**create_kwargs)
        except OpenAIError as e:
            raise ProviderError(f"Upstream error starting stream: {e}") from e

        try:
            async for chunk in stream:
                # The final usage chunk on OpenAI/OpenRouter has an empty
                # `choices` list but carries `usage`. Capture it before
                # skipping the chunk so usage isn't lost when no choices
                # accompany it.
                if include_usage:
                    usage = getattr(chunk, "usage", None)
                    if usage is not None:
                        # OpenRouter reports ``usage.cost`` on every
                        # streamed completion (USD, float). Direct
                        # OpenAI / Anthropic don't, so this stays None
                        # for them and the surface degrades gracefully.
                        yield UsageEvent(
                            prompt_tokens=_safe_int(
                                getattr(usage, "prompt_tokens", None)
                            ),
                            completion_tokens=_safe_int(
                                getattr(usage, "completion_tokens", None)
                            ),
                            total_tokens=_safe_int(
                                getattr(usage, "total_tokens", None)
                            ),
                            cost_usd=_safe_float(
                                getattr(usage, "cost", None)
                            ),
                        )
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta

                # Text deltas — the bread-and-butter case.
                token = getattr(delta, "content", None)
                if token:
                    yield TextDelta(text=token)

                # Tool-call deltas — multiple per stream, indexed.
                tool_calls = getattr(delta, "tool_calls", None) or []
                for tc in tool_calls:
                    fn = getattr(tc, "function", None)
                    yield ToolCallDelta(
                        index=getattr(tc, "index", 0) or 0,
                        id=getattr(tc, "id", None),
                        name=getattr(fn, "name", None) if fn else None,
                        arguments=getattr(fn, "arguments", None) if fn else None,
                    )

                # End-of-turn marker. Yielded once per choice with a
                # finish_reason; intermediate chunks have ``None`` here.
                finish_reason = getattr(choice, "finish_reason", None)
                if finish_reason is not None:
                    yield FinishEvent(reason=finish_reason)
        except OpenAIError as e:
            raise ProviderError(f"Upstream error during stream: {e}") from e
        finally:
            await client.close()

    async def stream_chat(
        self,
        *,
        provider: ModelProvider,
        model_id: str,
        messages: list[ChatMessage],
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = 4096,
        usage_out: dict[str, Any] | None = None,
    ) -> AsyncGenerator[str, None]:
        """Yield content tokens from the provider's streaming endpoint.

        Backwards-compatible wrapper around :meth:`stream_chat_events` so
        the titler / search distiller / study chat keep their text-only
        contract. New code that needs tool calls or richer events should
        use ``stream_chat_events`` directly.
        """
        async for ev in self.stream_chat_events(
            provider=provider,
            model_id=model_id,
            messages=messages,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            include_usage=usage_out is not None,
        ):
            if isinstance(ev, TextDelta):
                yield ev.text
            elif isinstance(ev, UsageEvent) and usage_out is not None:
                if ev.prompt_tokens is not None:
                    usage_out["prompt_tokens"] = ev.prompt_tokens
                if ev.completion_tokens is not None:
                    usage_out["completion_tokens"] = ev.completion_tokens
                if ev.total_tokens is not None:
                    usage_out["total_tokens"] = ev.total_tokens
            # ToolCallDelta / FinishEvent are intentionally swallowed:
            # legacy callers don't pass tools and don't care about the
            # finish reason. If a misconfigured provider ever emits a
            # tool_calls delta on a no-tools request, the partial output
            # is harmless to discard.

    async def generate_image(
        self,
        *,
        provider: ModelProvider,
        model_id: str,
        prompt: str,
        source_image: tuple[bytes, str] | None = None,
        modalities: list[str] | None = None,
        timeout: float = 120.0,
    ) -> "GeneratedImage":
        """Generate (or edit) an image via OpenRouter's image-capable models.

        Bypasses the OpenAI SDK on purpose: image generation lives on
        ``/chat/completions`` but uses two OpenAI-incompatible fields —
        a top-level ``modalities`` request parameter and an ``images``
        array on the assistant response message. The SDK silently
        strips both, so we hit the HTTP API directly.

        Args:
            provider:      OpenRouter ``ModelProvider`` row (encrypted
                           api_key, base_url override).
            model_id:      Image-capable model id (e.g.
                           ``google/gemini-2.5-flash-image``).
            prompt:        Free-form text instruction.
            source_image:  Optional ``(bytes, mime)`` tuple. When
                           provided, the prompt is treated as an *edit*
                           instruction and the bytes are inlined as a
                           ``data:`` URL in the user content array.
            modalities:    OpenRouter's ``modalities`` field. Defaults
                           to ``["image", "text"]`` which works for
                           dual-output models like Gemini Image; pass
                           ``["image"]`` for image-only models like
                           Flux.
            timeout:       Per-request HTTP timeout. Image generation
                           can take 10-30s, so this is much higher than
                           the chat default.

        Returns:
            :class:`GeneratedImage` with raw image bytes, mime type, the
            assistant's accompanying caption (if any), and usage stats
            for cost reporting.

        Raises:
            ProviderError: For network failures, non-2xx responses, or
                           a 200 response that nonetheless contained no
                           image (model refused, returned text-only,
                           etc.).
        """
        if provider.type != "openrouter":
            raise ProviderError(
                f"generate_image not implemented for {provider.type!r}"
            )

        api_key = _api_key_for(provider)
        base = (provider.base_url or OPENROUTER_BASE_URL).rstrip("/")
        url = f"{base}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            **OPENROUTER_HEADERS,
        }

        # Build the user message content. Pure-prompt → string content;
        # editing → array with the image first then the instruction
        # (the order most multi-modal models seem to prefer).
        content: str | list[dict[str, Any]]
        if source_image is None:
            content = prompt
        else:
            img_bytes, img_mime = source_image
            data_url = _bytes_to_data_url(img_bytes, img_mime)
            content = [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt},
            ]

        payload: dict[str, Any] = {
            "model": model_id,
            "messages": [{"role": "user", "content": content}],
            "modalities": modalities or ["image", "text"],
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except httpx.HTTPError as e:
                raise ProviderError(f"Network error generating image: {e}") from e

        if resp.status_code >= 400:
            # Try to surface the upstream error message — OpenRouter is
            # usually descriptive ("model does not support image
            # output", "insufficient credits", etc.).
            detail = resp.text[:400]
            try:
                body = resp.json()
                if isinstance(body, dict):
                    err = body.get("error")
                    if isinstance(err, dict) and err.get("message"):
                        detail = str(err["message"])
                    elif isinstance(err, str):
                        detail = err
            except ValueError:
                pass
            raise ProviderError(
                f"Image generation failed (HTTP {resp.status_code}): {detail}"
            )

        try:
            body = resp.json()
        except ValueError as e:
            raise ProviderError(f"Image generation returned non-JSON body: {e}") from e

        choices = body.get("choices") or []
        if not choices:
            raise ProviderError("Image generation returned no choices")
        message = choices[0].get("message") or {}
        images = message.get("images") or []
        if not images:
            # The model accepted the request but returned text only.
            # Surface the assistant's text so the caller can pass it
            # back as a tool error for the model to react to.
            text = message.get("content") or ""
            raise ProviderError(
                "Model returned no image. "
                f"Assistant said: {text!r}" if text else
                "Model returned no image."
            )

        first = images[0]
        url_field = (first.get("image_url") or {}).get("url")
        if not isinstance(url_field, str) or not url_field.startswith("data:"):
            raise ProviderError(
                "Model returned an image without an inline data URL"
            )
        try:
            img_bytes, img_mime = _data_url_to_bytes(url_field)
        except ValueError as e:
            raise ProviderError(f"Could not decode generated image: {e}") from e

        usage = body.get("usage") or {}
        return GeneratedImage(
            content=img_bytes,
            mime_type=img_mime,
            caption=message.get("content") or None,
            prompt_tokens=_safe_int(usage.get("prompt_tokens")),
            completion_tokens=_safe_int(usage.get("completion_tokens")),
            total_tokens=_safe_int(usage.get("total_tokens")),
            cost_usd=_safe_float(usage.get("cost")),
        )

    async def list_models(self, provider: ModelProvider) -> list[dict[str, Any]]:
        """Fetch the live model catalog for a provider.

        For OpenRouter we hit `/models` directly (the OpenAI SDK also exposes
        `client.models.list()` but we want the richer metadata OpenRouter adds
        — context length, pricing, modality — which the SDK strips).
        """
        if provider.type != "openrouter":
            raise ProviderError(
                f"list_models not implemented for {provider.type!r}"
            )

        api_key = _api_key_for(provider)
        url = f"{(provider.base_url or OPENROUTER_BASE_URL).rstrip('/')}/models"
        headers = {"Authorization": f"Bearer {api_key}", **OPENROUTER_HEADERS}

        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Failed to fetch model list: {e}") from e

        data = resp.json().get("data", []) or []
        return [
            {
                "id": m["id"],
                "display_name": m.get("name") or m["id"],
                "context_window": m.get("context_length"),
                "pricing": m.get("pricing"),
                "description": m.get("description"),
                "supports_vision": _detect_vision(m),
                "supports_image_output": _detect_image_output(m),
            }
            for m in data
            if isinstance(m, dict) and "id" in m
        ]

    async def test_connection(self, provider: ModelProvider) -> dict[str, Any]:
        """Validate the provider's credentials.

        For OpenRouter we call `/auth/key` which is an authenticated endpoint
        — a 401 here definitively means the key is bad. We deliberately avoid
        `/models` because that endpoint is public and would report OK for
        any key (even garbage).
        """
        if provider.type != "openrouter":
            return {"ok": False, "error": f"Test not implemented for {provider.type!r}"}

        try:
            api_key = _api_key_for(provider)
        except ProviderError as e:
            return {"ok": False, "error": str(e)}

        url = f"{(provider.base_url or OPENROUTER_BASE_URL).rstrip('/')}/auth/key"
        headers = {"Authorization": f"Bearer {api_key}", **OPENROUTER_HEADERS}

        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.get(url, headers=headers)
            except httpx.HTTPError as e:
                return {"ok": False, "error": f"Network error: {e}"}

        if resp.status_code == 401:
            return {"ok": False, "error": "Invalid API key"}
        if resp.status_code >= 400:
            return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}

        # Also report the live model count since the UI shows it on the card.
        try:
            models = await self.list_models(provider)
            return {"ok": True, "model_count": len(models)}
        except ProviderError:
            return {"ok": True, "model_count": None}


# Module-level singleton — stateless, safe to share.
model_router = ModelRouter()
