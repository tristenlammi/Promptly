"""Provider abstraction layer.

Supported provider types
------------------------
``openrouter``        Aggregator with the richest model metadata; also the
                      only type that can drive ``generate_image`` today
                      because OpenRouter exposes image output via its
                      OpenAI-shaped ``/chat/completions`` endpoint.
``openai``            Native OpenAI.
``anthropic``         Anthropic's OpenAI-compatibility layer for chat
                      (Bearer auth); the native ``/v1/models`` endpoint
                      for catalog fetches (``x-api-key`` auth).
``gemini``            Google AI Studio's OpenAI-compatibility layer.
``ollama``            Local Ollama server's OpenAI-compatibility layer.
                      No API key required.
``openai_compatible`` Generic catch-all for self-hosted OpenAI-shaped
                      endpoints (vLLM, LocalAI, LM Studio, …).

All five non-openrouter types are driven through the OpenAI SDK because
they all expose an OpenAI-shaped ``/v1/chat/completions`` endpoint.
Only the catalog (``list_models``) and credential check
(``test_connection``) branches need per-type logic — the streaming and
tool-calling path is identical.

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

import asyncio
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

# Per-type defaults for ``base_url``. ``None`` means the type requires
# the admin to supply one at provider-create time (``openai_compatible``
# is intentionally generic and has no single canonical host).
DEFAULT_BASE_URLS: dict[str, str | None] = {
    "openrouter": OPENROUTER_BASE_URL,
    "openai": "https://api.openai.com/v1",
    # Anthropic's OpenAI-compat endpoint for chat. List models still
    # uses the native API path with ``x-api-key`` — see list_models.
    "anthropic": "https://api.anthropic.com/v1",
    # Google AI Studio's OpenAI-compat endpoint. The trailing ``openai``
    # segment is required; the upstream also serves a non-compat shape
    # without it which the OpenAI SDK can't talk to.
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    # Local dev default. ``host.docker.internal`` would also be valid
    # when Promptly itself runs in Docker; admins override via base_url.
    "ollama": "http://localhost:11434/v1",
    "openai_compatible": None,
}

SUPPORTED_PROVIDER_TYPES: frozenset[str] = frozenset(DEFAULT_BASE_URLS)

# Provider types that don't require an API key. Ollama's OpenAI-compat
# endpoint accepts any placeholder token (including an empty string),
# so the admin can save an Ollama provider without entering one.
KEYLESS_PROVIDER_TYPES: frozenset[str] = frozenset({"ollama"})


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
    """Decrypt and return the provider's API key.

    ``ollama`` doesn't actually authenticate, so we fabricate a
    placeholder token when no key is stored — the OpenAI SDK requires
    *something* in the ``Authorization`` header and Ollama cheerfully
    ignores it.
    """
    if not provider.api_key:
        if provider.type in KEYLESS_PROVIDER_TYPES:
            return "ollama"
        raise ProviderError(f"Provider {provider.name!r} has no API key configured")
    try:
        return decrypt_secret(provider.api_key)
    except ValueError as e:
        raise ProviderError(f"Unable to decrypt API key for {provider.name!r}: {e}") from e


def _resolve_base_url(provider: ModelProvider) -> str:
    """Return the effective base URL for a provider, no trailing slash."""
    if provider.base_url:
        return provider.base_url.rstrip("/")
    default = DEFAULT_BASE_URLS.get(provider.type)
    if not default:
        raise ProviderError(
            f"Provider type {provider.type!r} requires an explicit base_url"
        )
    return default.rstrip("/")


def _headers_for(provider: ModelProvider) -> dict[str, str]:
    """Per-type extra HTTP headers. Only OpenRouter needs any today."""
    if provider.type == "openrouter":
        return dict(OPENROUTER_HEADERS)
    return {}


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


def _known_context_window(provider_type: str, model_id: str) -> int | None:
    """Best-effort context-window lookup for providers that don't
    return ``context_length`` on their ``/models`` endpoint.

    Anthropic's REST catalog (as of April 2026) still omits the
    context-window field, so we hard-code the well-documented limits
    for the Claude-3 and Claude-4 families — everything in those
    families ships with a 200k window, so the map stays short.

    Ollama runs locally and every installed model has its own
    ``num_ctx`` configured at pull time; we can't know it without
    probing the model file, so we return ``None`` and let the TopNav
    pill hide itself rather than display a number we'd have to
    guess at. Users with local stacks can set a default in
    ``modelfile`` overrides later if we want to surface it.

    Return ``None`` when we genuinely don't know — never fabricate a
    number. The pill treats ``None`` as "no indicator"."""
    mid = model_id.lower()
    if provider_type == "anthropic":
        # All Claude-3* and Claude-4* sizes (sonnet / opus / haiku)
        # use a 200k window; older claude-2.x was 100k/200k but we
        # don't surface those anymore.
        if (
            "claude-3" in mid
            or "claude-4" in mid
            or "claude-sonnet" in mid
            or "claude-opus" in mid
            or "claude-haiku" in mid
        ):
            return 200_000
        return None
    # Everyone else populates context_window from the API catalog.
    return None


def _detect_vision_by_id(provider_type: str, model_id: str) -> bool:
    """Cheap per-type heuristic for whether a model can read images.

    Non-openrouter providers don't return structured modality info on
    their ``/models`` endpoint, so we match known vision families by
    id. Err on the side of ``False`` for unknown entries — a wrong
    ``True`` would let the user attach an image the model silently
    drops, whereas a wrong ``False`` is just a missing "Vision" badge.
    """
    mid = model_id.lower()
    if provider_type == "openai":
        # gpt-4o*, gpt-4.1*, gpt-4-turbo*, gpt-4-vision*, o1*, o3*, o4*
        if mid.startswith(("gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision")):
            return True
        if mid.startswith(("o1", "o3", "o4", "chatgpt-4o")):
            return True
        return False
    if provider_type == "anthropic":
        # Every Claude 3+ model supports image input.
        return "claude-3" in mid or "claude-4" in mid or "claude-sonnet" in mid or "claude-opus" in mid or "claude-haiku" in mid
    if provider_type == "gemini":
        # Every Gemini 1.5+ (and the ``*-pro-vision`` legacy) reads images.
        return (
            mid.startswith("gemini-1.5")
            or mid.startswith("gemini-2")
            or mid.startswith("gemini-3")
            or "vision" in mid
        )
    if provider_type == "ollama":
        # Known vision-capable open model families.
        keywords = (
            "llava", "bakllava", "moondream", "qwen2-vl", "qwen-vl",
            "minicpm-v", "vision", "llama3.2-vision", "llama-3.2-vision",
        )
        return any(k in mid for k in keywords)
    # openrouter / openai_compatible / anything else → let the richer
    # catalog logic decide (openrouter) or default off.
    return False


# --------------------------------------------------------------------
# OpenRouter per-model endpoint privacy lookup
# --------------------------------------------------------------------
# OpenRouter's ``/api/v1/models`` listing doesn't include the
# data-policy details that determine whether a model will actually
# respond for a given account's privacy settings (ZDR toggles,
# training opt-out, etc.). Those live on the per-model ``/endpoints``
# resource, which is one request per model. We fan these out in
# parallel with a capped semaphore so an OR outage can't hang the
# refresh for a catalog of 300+ models, and summarise the endpoints
# into a compact blob the frontend can render as badges.

_OPENROUTER_ENDPOINTS_CONCURRENCY = 12
_OPENROUTER_ENDPOINTS_TIMEOUT = 8.0


async def _fetch_openrouter_privacy_bulk(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict[str, str],
    model_ids: list[str],
) -> dict[str, dict[str, Any] | None]:
    """Fetch privacy/data-policy summaries for every OpenRouter model.

    Returns a mapping of ``model_id`` → ``{endpoints_count, training_endpoints,
    retains_prompts_endpoints, zdr_endpoints, max_retention_days}`` or
    ``None`` when the lookup failed for that specific model. Never
    raises — errors are swallowed per-model so one flaky lookup
    doesn't black out the whole catalog refresh.
    """
    if not model_ids:
        return {}

    sem = asyncio.Semaphore(_OPENROUTER_ENDPOINTS_CONCURRENCY)

    async def _one(model_id: str) -> tuple[str, dict[str, Any] | None]:
        async with sem:
            try:
                resp = await client.get(
                    f"{base_url}/models/{model_id}/endpoints",
                    headers=headers,
                    timeout=_OPENROUTER_ENDPOINTS_TIMEOUT,
                )
                resp.raise_for_status()
            except httpx.HTTPError as e:
                # Soft failure — we just don't show a privacy badge for
                # this model. Don't blow up the catalog refresh.
                logger.debug(
                    "OpenRouter /endpoints lookup failed for %s: %s",
                    model_id,
                    e,
                )
                return model_id, None

            try:
                body = resp.json()
            except ValueError:
                return model_id, None

        data = body.get("data") if isinstance(body, dict) else None
        endpoints = (
            data.get("endpoints") if isinstance(data, dict) else None
        ) or []
        summary = _summarise_endpoint_privacy(endpoints)
        return model_id, summary

    results = await asyncio.gather(
        *(_one(mid) for mid in model_ids),
        return_exceptions=False,
    )
    return {mid: privacy for mid, privacy in results}


def _summarise_endpoint_privacy(
    endpoints: list[Any],
) -> dict[str, Any] | None:
    """Reduce a list of OpenRouter endpoint dicts to a compact summary.

    We count, across all endpoints for a model, how many:

    * allow training on user data (``data_policy.training == true``),
    * retain prompts at all (``data_policy.retains_prompts`` or
      ``retention_days > 0``),
    * qualify as "zero data retention" (neither of the above).

    Plus the worst-case retention window. The frontend derives a
    human badge from these numbers — keeping the interpretation on
    the frontend means we don't have to ship a backend change every
    time we want to phrase a badge differently.
    """
    total = 0
    training = 0
    retains = 0
    zdr = 0
    max_retention: int | None = None

    for e in endpoints:
        if not isinstance(e, dict):
            continue
        total += 1
        policy = e.get("data_policy") or {}
        if not isinstance(policy, dict):
            policy = {}

        is_training = bool(policy.get("training"))
        # Some OR endpoints omit ``retains_prompts`` and only set
        # ``retention_days`` > 0; treat either signal as retention.
        rd = policy.get("retention_days")
        rd_int = int(rd) if isinstance(rd, (int, float)) else None
        is_retaining = bool(
            policy.get("retains_prompts")
            or (rd_int is not None and rd_int > 0)
        )

        if is_training:
            training += 1
        if is_retaining:
            retains += 1
        if not is_training and not is_retaining:
            zdr += 1

        if rd_int is not None and rd_int > 0:
            if max_retention is None or rd_int > max_retention:
                max_retention = rd_int

    if total == 0:
        # ``/endpoints`` returned an empty list — means OR knows the
        # model exists but can't route it to anyone. Distinct from
        # "we didn't fetch" (``None``), so we preserve the zero-count
        # summary and let the frontend render a "No endpoints
        # available" note instead of a privacy badge.
        return {
            "endpoints_count": 0,
            "training_endpoints": 0,
            "retains_prompts_endpoints": 0,
            "zdr_endpoints": 0,
            "max_retention_days": None,
        }

    return {
        "endpoints_count": total,
        "training_endpoints": training,
        "retains_prompts_endpoints": retains,
        "zdr_endpoints": zdr,
        "max_retention_days": max_retention,
    }


def _client_for(provider: ModelProvider) -> AsyncOpenAI:
    """Build an AsyncOpenAI client aimed at ``provider``.

    All supported providers expose an OpenAI-shaped
    ``/chat/completions`` endpoint — the only thing that varies is the
    ``base_url``, auth key, and a small set of per-type headers
    (OpenRouter wants ``HTTP-Referer`` / ``X-Title``; everyone else
    wants nothing).
    """
    if provider.type not in SUPPORTED_PROVIDER_TYPES:
        raise ProviderError(
            f"Unsupported provider type: {provider.type!r}. "
            f"Supported: {sorted(SUPPORTED_PROVIDER_TYPES)}"
        )
    return AsyncOpenAI(
        api_key=_api_key_for(provider),
        base_url=_resolve_base_url(provider),
        default_headers=_headers_for(provider),
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
                "Image generation is only available through OpenRouter "
                "today. Switch to an OpenRouter-backed model to use the "
                "generate_image tool."
            )

        api_key = _api_key_for(provider)
        base = _resolve_base_url(provider)
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

        Dispatches per-type: OpenRouter keeps its bespoke endpoint for
        the rich modality / pricing metadata; Anthropic uses its native
        ``/v1/models`` with ``x-api-key`` auth; everyone else fetches
        the OpenAI-compat ``/models`` list (works for OpenAI, Gemini,
        Ollama, and any generic ``openai_compatible`` server).
        """
        if provider.type == "openrouter":
            return await self._list_models_openrouter(provider)
        if provider.type == "anthropic":
            return await self._list_models_anthropic(provider)
        if provider.type in {"openai", "gemini", "ollama", "openai_compatible"}:
            return await self._list_models_openai_compat(provider)
        raise ProviderError(
            f"list_models not implemented for {provider.type!r}"
        )

    async def _list_models_openrouter(
        self, provider: ModelProvider
    ) -> list[dict[str, Any]]:
        api_key = _api_key_for(provider)
        base = _resolve_base_url(provider)
        list_url = f"{base}/models"
        headers = {"Authorization": f"Bearer {api_key}", **OPENROUTER_HEADERS}

        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.get(list_url, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Failed to fetch model list: {e}") from e

            raw_models = [
                m
                for m in (resp.json().get("data", []) or [])
                if isinstance(m, dict) and "id" in m
            ]

            # Fan out per-model endpoint metadata in parallel so we can
            # surface privacy/data-policy badges in the model picker.
            # The ``/endpoints`` API is free (metadata only, no tokens)
            # but it's one request per model — cap concurrency so an OR
            # outage can't knock us over and a refresh stays snappy for
            # catalogs of 300+ models.
            privacy_by_id = await _fetch_openrouter_privacy_bulk(
                client=client,
                base_url=base,
                headers=headers,
                model_ids=[m["id"] for m in raw_models],
            )

        out: list[dict[str, Any]] = []
        for m in raw_models:
            entry: dict[str, Any] = {
                "id": m["id"],
                "display_name": m.get("name") or m["id"],
                "context_window": m.get("context_length"),
                "pricing": m.get("pricing"),
                "description": m.get("description"),
                "supports_vision": _detect_vision(m),
                "supports_image_output": _detect_image_output(m),
            }
            # Only include the privacy key when we actually fetched
            # endpoint data — an explicit ``null`` would look like
            # "fetch worked but no info", when really we never asked.
            pv = privacy_by_id.get(m["id"])
            if pv is not None:
                entry["privacy"] = pv
            out.append(entry)
        return out

    async def _list_models_openai_compat(
        self, provider: ModelProvider
    ) -> list[dict[str, Any]]:
        """Fetch ``/models`` from any OpenAI-compatible endpoint.

        Used for OpenAI, Gemini, Ollama, and the generic
        ``openai_compatible`` type. Context window + pricing aren't
        exposed in the shared shape, so we fall back to id-based
        heuristics for vision detection and leave the numeric fields
        blank.
        """
        api_key = _api_key_for(provider)
        url = f"{_resolve_base_url(provider)}/models"
        headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Failed to fetch model list: {e}") from e

        try:
            body = resp.json()
        except ValueError as e:
            raise ProviderError(f"Model list returned non-JSON: {e}") from e

        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ProviderError("Model list response missing 'data' array")

        out: list[dict[str, Any]] = []
        for m in data:
            if not isinstance(m, dict):
                continue
            model_id = m.get("id")
            if not isinstance(model_id, str):
                continue
            out.append(
                {
                    "id": model_id,
                    "display_name": (
                        m.get("display_name")
                        or m.get("name")
                        or model_id
                    ),
                    "context_window": m.get("context_length")
                    or m.get("context_window"),
                    "pricing": m.get("pricing"),
                    "description": m.get("description"),
                    "supports_vision": _detect_vision_by_id(
                        provider.type, model_id
                    ),
                    # Image *output* only wires up via OpenRouter today.
                    "supports_image_output": False,
                }
            )
        # Ollama hasn't historically sorted its catalog; sort by id for
        # a deterministic display order in the admin UI.
        if provider.type == "ollama":
            out.sort(key=lambda r: r["id"])
        return out

    async def _list_models_anthropic(
        self, provider: ModelProvider
    ) -> list[dict[str, Any]]:
        """Fetch Anthropic's catalog via its native API.

        The OpenAI-compat layer doesn't mirror ``/models``, so we hit
        ``/v1/models`` directly with ``x-api-key`` + ``anthropic-version``
        headers. Response shape:
        ``{"data": [{"type": "model", "id": "...", "display_name": "..."}]}``.
        """
        api_key = _api_key_for(provider)
        base = _resolve_base_url(provider)
        url = f"{base}/models"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Failed to fetch model list: {e}") from e

        try:
            body = resp.json()
        except ValueError as e:
            raise ProviderError(f"Model list returned non-JSON: {e}") from e

        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ProviderError("Model list response missing 'data' array")

        out: list[dict[str, Any]] = []
        for m in data:
            if not isinstance(m, dict):
                continue
            model_id = m.get("id")
            if not isinstance(model_id, str):
                continue
            out.append(
                {
                    "id": model_id,
                    "display_name": m.get("display_name") or model_id,
                    "context_window": _known_context_window(
                        "anthropic", model_id
                    ),
                    "pricing": None,
                    "description": None,
                    "supports_vision": _detect_vision_by_id(
                        "anthropic", model_id
                    ),
                    "supports_image_output": False,
                }
            )
        return out

    async def test_connection(self, provider: ModelProvider) -> dict[str, Any]:
        """Validate the provider's credentials.

        * OpenRouter uses its authenticated ``/auth/key`` probe so an
          invalid key returns a definitive 401 (the public ``/models``
          endpoint would cheerfully accept garbage).
        * Every other provider is validated by fetching the model list,
          since that endpoint requires auth across OpenAI / Anthropic /
          Gemini and is the cheapest read Ollama answers for.
        """
        try:
            _api_key_for(provider)  # surface key/decrypt errors up-front
        except ProviderError as e:
            return {"ok": False, "error": str(e)}

        if provider.type == "openrouter":
            return await self._test_connection_openrouter(provider)

        try:
            models = await self.list_models(provider)
        except ProviderError as e:
            msg = str(e)
            # Map common 401s to a nicer message so the admin card
            # shows "Invalid API key" instead of a raw HTTPError dump.
            if "401" in msg or "Unauthorized" in msg:
                return {"ok": False, "error": "Invalid API key"}
            return {"ok": False, "error": msg}
        return {"ok": True, "model_count": len(models)}

    async def _test_connection_openrouter(
        self, provider: ModelProvider
    ) -> dict[str, Any]:
        api_key = _api_key_for(provider)
        url = f"{_resolve_base_url(provider)}/auth/key"
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

        try:
            models = await self.list_models(provider)
            return {"ok": True, "model_count": len(models)}
        except ProviderError:
            return {"ok": True, "model_count": None}


# Module-level singleton — stateless, safe to share.
model_router = ModelRouter()
