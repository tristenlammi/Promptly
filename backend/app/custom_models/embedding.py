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

import hashlib
import io
import logging
import os
import re
from dataclasses import dataclass
from typing import Iterable

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
    """Return the vector dim for a known embedding model id."""
    return KNOWN_EMBEDDING_DIMS.get(model_id)


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
) -> list[list[float]]:
    """Embed a batch of strings via the configured provider.

    Uses the existing :func:`_client_for` plumbing so OpenAI, Gemini
    (OpenAI-compat), and Ollama all flow through the same
    ``AsyncOpenAI`` instance — no per-provider branching in this
    module. Empty inputs are filtered before the API call (some
    providers 400 on empty strings).
    """
    cleaned = [t for t in texts if t and t.strip()]
    if not cleaned:
        return []
    client: AsyncOpenAI = _client_for(provider)
    # The OpenAI SDK accepts ``input`` as a list and returns an
    # ordered ``data`` list. We don't bother reordering by ``index``
    # because all current providers return them in submission order;
    # the ``[d.embedding for d in resp.data]`` comprehension just
    # mirrors the input ordering.
    resp = await client.embeddings.create(model=model_id, input=cleaned)
    return [list(d.embedding) for d in resp.data]


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
