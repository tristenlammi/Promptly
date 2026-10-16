"""Chunking + embedding for the Custom Models knowledge library.

Public surface:

* :func:`extract_text_for_embedding` — pull a UTF-8 string out of a
  :class:`UserFile` (text-ish files via the existing storage helper,
  PDFs via pypdf reusing the ``files.prompt`` extractor).
* :func:`chunk_text`                  — sentence-aware sliding window
  with overlap. Token-aware to a first approximation (we count
  characters / 4, which is good enough at the OpenAI / Llama tokeniser
  scales — accurate within ~10% for English prose, more than enough
  for "did this chunk hit the budget").
* :func:`embed_texts`                 — batch ``/v1/embeddings`` call
  through the existing :class:`AsyncOpenAI` client. Works for OpenAI,
  Gemini (OpenAI-compat), and Ollama (the bundled local embedding
  model surfaces through the same shape).
* :func:`embedding_dim_for`           — best-effort lookup of an
  embedding model's vector dimension. Used by the setup wizard so
  the admin's choice writes the right ``app_settings.embedding_dim``
  without us having to round-trip a probe call first.

We deliberately don't import :mod:`tiktoken` — keeping the runtime
slim is worth more than the ~5% precision improvement on token
counts. The chunker's ``chars_per_token=4`` heuristic is what every
naive RAG pipeline does and it's never been the bottleneck in
retrieval quality.
"""
from __future__ import annotations

import time

import hashlib
import io
import logging
import os
import re
from dataclasses import dataclass
from typing import Iterable

import openai
from openai import AsyncOpenAI

from app.files.models import UserFile
from app.files.storage import absolute_path, read_text
from app.models_config.models import ModelProvider
from app.models_config.provider import _client_for  # type: ignore[attr-defined]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

# ~500 tokens per chunk → ~2000 chars at the standard 4-chars-per-token
# heuristic. Big enough to carry a coherent passage (a section of a
# README, a few paragraphs of prose), small enough that the top-k
# retrieval doesn't blow the context budget when k=6.
DEFAULT_CHUNK_CHARS = 2000

# 50-token overlap between adjacent chunks so a passage that straddles
# a chunk boundary is still recoverable from at least one of them.
DEFAULT_OVERLAP_CHARS = 200

# Hard cap on bytes we'll even try to read off disk for an embedding
# job. Defends against an admin pinning a 200 MB log to a custom model
# and slowly nuking the worker process. Anything larger gets a clear
# "file too large to index" error in ``custom_model_files.indexing_error``.
MAX_EXTRACT_BYTES = 4 * 1024 * 1024  # 4 MiB of text per file


@dataclass(frozen=True)
class Chunk:
    """A single embed-ready slice of a source file."""

    index: int
    text: str
    tokens: int
    metadata: dict[str, object]


def chunk_text(
    text: str,
    *,
    chunk_chars: int = DEFAULT_CHUNK_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
) -> list[Chunk]:
    """Split ``text`` into overlapping chunks suitable for embedding.

    The strategy is the standard "sliding window with sentence-aware
    boundary nudging": walk forward in ``chunk_chars`` strides, and
    when the proposed cut lands mid-sentence, back up to the nearest
    paragraph break / period / newline so the chunk reads cleanly when
    surfaced as a citation.
    """
    text = text.strip()
    if not text:
        return []

    # Single chunk shortcut — avoids the overlap arithmetic entirely
    # for short pinned files.
    if len(text) <= chunk_chars:
        return [
            Chunk(
                index=0,
                text=text,
                tokens=max(1, len(text) // 4),
                metadata={"start": 0, "end": len(text)},
            )
        ]

    chunks: list[Chunk] = []
    start = 0
    idx = 0
    n = len(text)
    # Boundary preferences from "best" to "worst" — a paragraph break
    # is the cleanest place to cut, then a sentence break, then any
    # whitespace at all. We search backwards from the proposed cut for
    # each in turn and stop at the first hit within the look-back
    # window.
    boundary_patterns = ("\n\n", ". ", ".\n", "!\n", "?\n", "\n", " ")
    look_back = max(64, chunk_chars // 8)

    while start < n:
        end = min(n, start + chunk_chars)
        if end < n:
            for pat in boundary_patterns:
                hit = text.rfind(pat, end - look_back, end)
                if hit > start:
                    end = hit + len(pat)
                    break

        slice_text = text[start:end].strip()
        if slice_text:
            chunks.append(
                Chunk(
                    index=idx,
                    text=slice_text,
                    tokens=max(1, len(slice_text) // 4),
                    metadata={"start": start, "end": end},
                )
            )
            idx += 1

        if end >= n:
            break
        # Advance the window. ``max(1, …)`` so a degenerate boundary
        # (cut == start) doesn't infinite-loop.
        start = max(start + 1, end - overlap_chars)

    return chunks


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

# Same allow-list the chat preamble uses, mirrored here so the two
# stay in lockstep without us importing private helpers cross-module.
_TEXT_MIMES_PREFIXES: tuple[str, ...] = ("text/",)
_TEXT_MIMES: frozenset[str] = frozenset(
    {
        "application/json",
        "application/xml",
        "application/x-yaml",
        "application/yaml",
        "application/toml",
        "application/x-toml",
        "application/javascript",
        "application/typescript",
        "application/sql",
        "application/x-sh",
        "application/x-python",
    }
)
_TEXT_EXTS: frozenset[str] = frozenset(
    {
        ".txt", ".md", ".markdown", ".rst",
        ".json", ".yml", ".yaml", ".toml",
        ".csv", ".tsv", ".log",
        ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
        ".go", ".rs", ".rb", ".php", ".java", ".kt", ".swift",
        ".c", ".h", ".cpp", ".hpp", ".cs",
        ".sh", ".bash", ".zsh", ".ps1",
        ".sql", ".html", ".htm", ".css", ".scss", ".less",
        ".xml", ".ini", ".cfg", ".env", ".conf",
    }
)
_PDF_MIMES: frozenset[str] = frozenset({"application/pdf", "application/x-pdf"})


def _looks_textual(f: UserFile) -> bool:
    mime = (f.mime_type or "").lower()
    if any(mime.startswith(p) for p in _TEXT_MIMES_PREFIXES):
        return True
    if mime in _TEXT_MIMES:
        return True
    return os.path.splitext(f.filename or "")[1].lower() in _TEXT_EXTS


def _looks_pdf(f: UserFile) -> bool:
    mime = (f.mime_type or "").lower()
    if mime in _PDF_MIMES:
        return True
    return os.path.splitext(f.filename or "")[1].lower() == ".pdf"


def _extract_pdf(relative: str) -> str:
    """Read a PDF off disk and return its concatenated text content.

    Pages are joined with ``\\n--- Page N ---\\n`` markers so the
    chunker has natural paragraph boundaries to cut on. Encrypted
    PDFs and scan-only PDFs return ``""`` (the caller surfaces that
    as a "no extractable text" indexing error).
    """
    path = absolute_path(relative)
    if path.stat().st_size > 25 * 1024 * 1024:
        raise ValueError("PDF exceeds 25 MiB parse limit")

    from pypdf import PdfReader  # imported lazily to keep cold start fast
    from pypdf.errors import PdfReadError

    with open(path, "rb") as fh:
        data = fh.read()
    try:
        reader = PdfReader(io.BytesIO(data))
    except PdfReadError as exc:
        raise ValueError(f"could not parse PDF: {exc}") from exc

    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:  # noqa: BLE001
            pass
        if reader.is_encrypted:
            return ""

    pieces: list[str] = []
    for idx, page in enumerate(reader.pages, start=1):
        try:
            page_text = (page.extract_text() or "").strip()
        except Exception as exc:  # noqa: BLE001 - per-page parse failures
            logger.debug("pypdf page %d failed: %s", idx, exc)
            continue
        if page_text:
            pieces.append(f"\n--- Page {idx} ---\n{page_text}")
    return "\n".join(pieces).strip()


def is_text_extractable(file: UserFile) -> bool:
    """True when :func:`extract_text_for_embedding` could pull text out
    of this file (PDF or text-ish). Lets callers (e.g. the project
    pin endpoint) decide whether a file is a RAG candidate without
    catching the ``ValueError`` the extractor raises for binaries /
    images."""
    return _looks_pdf(file) or _looks_textual(file)


def extract_text_for_embedding(file: UserFile) -> str:
    """Best-effort UTF-8 text extraction for a knowledge-library file.

    Returns ``""`` for unsupported or empty files; raises
    ``ValueError`` for parse errors so the caller can surface a clear
    message in ``custom_model_files.indexing_error`` instead of
    silently indexing nothing.
    """
    if _looks_pdf(file):
        return _extract_pdf(file.storage_path)
    if _looks_textual(file):
        return read_text(file.storage_path, MAX_EXTRACT_BYTES).strip()
    # Anything else (binaries, images, archives) is unsupported for
    # the RAG path. Caller marks the row "skipped" and moves on —
    # an admin who pins a PNG to an assistant probably meant to use
    # the chat's vision attachment path instead.
    raise ValueError(
        f"unsupported file type for knowledge-base indexing: "
        f"{file.mime_type or os.path.splitext(file.filename or '')[1] or 'unknown'}"
    )


def file_content_hash(file: UserFile) -> str:
    """SHA-256 of the source bytes — cheap fingerprint for cache hits."""
    path = absolute_path(file.storage_path)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for buf in iter(lambda: fh.read(1 << 16), b""):
            h.update(buf)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

# Best-known dimension per common embedding model id. Used by the
# setup wizard so the admin's pick can persist a correct
# ``app_settings.embedding_dim`` immediately, without a round-trip to
# the provider. Unknown ids fall back to a probe call (one embed of
# the literal string ``"x"``).
KNOWN_EMBEDDING_DIMS: dict[str, int] = {
    # OpenAI
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    # Google Gemini (via the OpenAI-compat shim)
    "text-embedding-004": 768,
    "embedding-001": 768,
    # Ollama bundled / popular options
    "nomic-embed-text": 768,
    "mxbai-embed-large": 1024,
    "bge-m3": 1024,
    "bge-large": 1024,
    "all-minilm": 384,
    "snowflake-arctic-embed": 1024,
}

# Vector columns the migration created. New dims need a column added
# in a follow-up migration; until then the embedder refuses to write.
SUPPORTED_DIMS: frozenset[int] = frozenset({768, 1536})


def embedding_dim_for(model_id: str) -> int | None:
    """Return the vector dim for a known embedding model id. Tolerates an
    Ollama tag (``nomic-embed-text:latest``) and a router prefix
    (``openai/text-embedding-3-small``)."""
    if not model_id:
        return None
    if model_id in KNOWN_EMBEDDING_DIMS:
        return KNOWN_EMBEDDING_DIMS[model_id]
    base = model_id.split(":", 1)[0].rsplit("/", 1)[-1]
    return KNOWN_EMBEDDING_DIMS.get(base)


# Substring hints that identify a model as an embedding-only backbone.
# Case-insensitive; matched against the tagless model id so tag
# suffixes (``:latest``, ``:q4_K_M``) don't confuse the check.
_EMBEDDING_NAME_HINTS: tuple[str, ...] = (
    "embed",      # nomic-embed-text, mxbai-embed-large, text-embedding-*
    "bge-",       # BAAI general-embedding family (bge-m3, bge-large, ...)
    "e5-",        # intfloat/e5 series
    "gte-",       # Alibaba gte embeddings
    "minilm",     # sentence-transformers minilm family
)


def is_embedding_model_id(model_id: str) -> bool:
    """True when ``model_id`` names an embedding-only model.

    The chat picker uses this to hide embedding models — they can be
    pulled into the bundled Ollama runtime for the Custom Models RAG
    pipeline, but they're not usable as a chat backbone and surfacing
    them in the model dropdown just confuses users.

    Implementation:

    * Exact match against :data:`KNOWN_EMBEDDING_DIMS`.
    * Substring hint match against :data:`_EMBEDDING_NAME_HINTS`.

    Both checks operate on the portion of the id before the first
    ``:`` so tag suffixes like ``nomic-embed-text:latest`` are treated
    the same as the base id.
    """
    if not model_id:
        return False
    base = model_id.split(":", 1)[0]
    if base in KNOWN_EMBEDDING_DIMS:
        return True
    base_lower = base.lower()
    return any(hint in base_lower for hint in _EMBEDDING_NAME_HINTS)


async def embed_texts(
    *,
    provider: ModelProvider,
    model_id: str,
    texts: list[str],
    dimensions: int | None = None,
    fast: bool = False,
) -> list[list[float]]:
    """Embed a batch of strings via the configured provider.

    ``fast=True`` for query-time calls a reply is waiting on (memory and
    knowledge retrieval): a short timeout, no retries.

    A circuit breaker (R-271): after a few failures in a row the embedder
    is skipped for a minute, failing at once — the callers fall back. An
    unreachable embedder used to add seconds to minutes to every chat turn
    and memory write.

    Uses the existing :func:`_client_for` plumbing so OpenAI, Gemini
    (OpenAI-compat), and Ollama all flow through the same
    ``AsyncOpenAI`` instance — no per-provider branching in this
    module. Empty inputs are filtered before the API call (some
    providers 400 on empty strings).

    ``dimensions`` requests the provider to truncate the output vector
    to the given size. This is the standard mechanism for models that
    support Matryoshka Representation Learning (MRL) — e.g. OpenAI's
    text-embedding-3 family and Qwen3-embedding — where the vector can
    be shortened without retraining and still represent the text well.
    Pass the workspace ``embedding_dim`` so that models whose default
    output size exceeds the supported database columns (768 / 1536)
    still produce storable vectors. Providers that don't support the
    parameter typically ignore it; those that error will surface the
    error to the caller, which is the correct behaviour.
    """
    cleaned = [t for t in texts if t and t.strip()]
    if not cleaned:
        return []
    key = str(getattr(provider, "id", None) or provider.name)
    state = _breaker.setdefault(key, {"fails": 0, "open_until": 0.0})
    if time.monotonic() < state["open_until"]:
        raise EmbedderUnavailable(
            "The embedding model failed several times just now; skipping it for a minute."
        )
    if getattr(provider, "enabled", True) is False:
        # An admin disabling a provider means stop calling it — indexing and
        # retrieval kept embedding through it (R-336).
        raise EmbedderUnavailable("The embedding provider is disabled.")
    client: AsyncOpenAI = _cached_client(provider)
    # Interactive calls: 5 s, no retries. Background batches: 90 s, one
    # retry — they used to inherit the SDK default of 600 s × 3 (R-318).
    client = (
        client.with_options(timeout=5.0, max_retries=0)
        if fast
        else client.with_options(timeout=90.0, max_retries=1)
    )
    # Fairness gate: interactive query embeds (retrieval) take priority so a
    # bulk background re-index can't make a workspace chat hang waiting for
    # its query embedding. Background (indexing) calls tag themselves via
    # ``embedding_gate.mark_background()`` and yield here.
    from app.custom_models import embedding_gate

    lease = await embedding_gate.acquire()
    try:
        # The OpenAI SDK accepts ``input`` as a list and returns an
        # ordered ``data`` list. We don't bother reordering by ``index``
        # because all current providers return them in submission order;
        # the ``[d.embedding for d in resp.data]`` comprehension just
        # mirrors the input ordering.
        # ``dimensions`` is sent only when it asks for something other than
        # the model's native size: providers that don't support the field
        # rejected every call for a model that already fits (R-333).
        send_dims = (
            dimensions
            if dimensions is not None and dimensions != embedding_dim_for(model_id)
            else None
        )
        try:
            resp = await client.embeddings.create(
                model=model_id,
                input=cleaned,
                **({"dimensions": send_dims} if send_dims is not None else {}),
            )
        except openai.BadRequestError:
            if send_dims is None:
                raise
            # Once more without it — the caller checks the length.
            resp = await client.embeddings.create(model=model_id, input=cleaned)
    except Exception as exc:
        state["fails"] += 1
        state["last_error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        state["last_error_at"] = time.time()
        if state["fails"] >= _BREAKER_FAILURES:
            state["open_until"] = time.monotonic() + _BREAKER_OPEN_SECONDS
            _note_outage(provider, state)
        raise
    finally:
        await embedding_gate.release(lease)
    if state.get("alerted"):
        _note_recovery(provider)
    state["fails"] = 0
    state["alerted"] = False
    state["last_ok_at"] = time.time()
    return [list(d.embedding) for d in resp.data]


# One client per provider (rebuilt when the provider changes) — every
# embed call used to build, and never close, a fresh HTTP client (R-324).
_clients: dict[str, tuple[object, AsyncOpenAI]] = {}


def _cached_client(provider: ModelProvider) -> AsyncOpenAI:
    key = str(getattr(provider, "id", None) or provider.name)
    stamp = (getattr(provider, "updated_at", None), getattr(provider, "base_url", None))
    hit = _clients.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    client = _client_for(provider)
    _clients[key] = (stamp, client)
    return client


def embedder_health() -> dict:
    """In-process health of the embedder(s) (R-322): last success, last
    error and whether calls are currently being skipped."""
    now = time.monotonic()
    out = {}
    for key, st in _breaker.items():
        out[key] = {
            "consecutive_failures": int(st.get("fails", 0)),
            "skipping": now < st.get("open_until", 0.0),
            "last_ok_at": st.get("last_ok_at"),
            "last_error": st.get("last_error"),
            "last_error_at": st.get("last_error_at"),
        }
    return out


def _note_outage(provider, state) -> None:
    """Tell admins once per outage (R-322) — it used to look exactly like
    'no results'."""
    if state.get("alerted"):
        return
    state["alerted"] = True
    _alert_admins(
        "Embedding model isn't responding",
        f"Calls to {getattr(provider, 'name', 'the embedding provider')} failed "
        f"{int(state.get('fails', 0))} times in a row ({state.get('last_error', '')}). "
        "Workspace search, Ask and memory fall back to keyword matching until it recovers.",
    )


def _note_recovery(provider) -> None:
    _alert_admins(
        "Embedding model is back",
        f"{getattr(provider, 'name', 'The embedding provider')} is answering again.",
    )


def _alert_admins(title: str, body: str) -> None:
    try:
        import asyncio

        asyncio.get_running_loop()
    except RuntimeError:
        return

    async def _send() -> None:
        from sqlalchemy import select

        from app.auth.models import User
        from app.database import SessionLocal
        from app.notifications import notify_user

        async with SessionLocal() as db:
            admins = (
                await db.execute(select(User.id).where(User.role == "admin", User.disabled.is_(False)))
            ).scalars().all()
        for uid in admins:
            await notify_user(
                user_id=uid, category="system_alert", title=title, body=body,
                url="/admin?tab=models", tag="promptly-embedder-health",
            )

    from app.background import spawn

    spawn(_send(), name="embedder-health-alert")


class EmbedderUnavailable(RuntimeError):
    """The embedder is being skipped after repeated failures."""


_BREAKER_FAILURES = 3
_BREAKER_OPEN_SECONDS = 60.0
# provider id -> consecutive failures / skip-until (monotonic). In-process
# is fine: the backend runs a single worker.
_breaker: dict[str, dict[str, float]] = {}


# Used to format Python lists into the SQL literal pgvector expects:
#   '[0.1,0.2,0.3]'::vector(N)
def vector_literal(vec: Iterable[float]) -> str:
    """Render a vector as the pgvector text format (no whitespace)."""
    return "[" + ",".join(repr(float(v)) for v in vec) + "]"


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")


def normalise_for_embedding(text: str) -> str:
    """Collapse runs of whitespace so embeddings aren't sensitive to
    minor formatting differences (tabs vs spaces, trailing whitespace
    on lines, etc.). Idempotent and stable across runs."""
    return _WHITESPACE_RE.sub(" ", text).strip()
