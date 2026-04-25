"""Plain-text extraction for the Files FTS index.

On upload (and on source-edit) the Files router calls
``extract_content_text()`` to produce a best-effort plain-text
representation of the uploaded blob. The resulting string is written
back to ``files.content_text`` and Postgres regenerates the weighted
``content_tsv`` tsvector automatically (see migration
``0036_files_fts``).

Heuristics:

* Text-ish MIME types / extensions → read the head of the file off
  disk as UTF-8 with replacement, capped at ``_CONTENT_TEXT_LIMIT``.
  Covers Markdown, source code, JSON, YAML, logs, etc.
* PDFs → delegate to :func:`app.files.prompt._extract_pdf_text`,
  capped at the same limit.
* Everything else → return ``None``. The row's tsvector still
  captures the filename via the ``setweight('A')`` branch.

The ceiling (``_CONTENT_TEXT_LIMIT``) is a compromise between
recall and index size. 256 KB comfortably fits multi-hundred-page
PDFs' meaningful prose and every sensibly-sized source file while
keeping the tsvector per row bounded. If a reader ever needs the
*full* content they can always fetch the blob.
"""
from __future__ import annotations

import logging
import os

from app.files.models import UserFile
from app.files.prompt import _extract_pdf_text, _looks_pdf, _looks_textual
from app.files.storage import read_text

logger = logging.getLogger("promptly.files.extraction")


# Per-row cap. The matching PDF extractor uses this as the byte
# budget passed to pypdf. For text-like blobs we also use it as a
# byte cap — the ``read_text`` helper tolerates encoding errors and
# appends a ``[truncated]`` marker when it trips the limit.
_CONTENT_TEXT_LIMIT = 256 * 1024


def extract_content_text(f: UserFile) -> str | None:
    """Return an FTS-friendly text payload for ``f`` or ``None``.

    Never raises — failures are logged + swallowed so a bad upload
    can still land (we'd rather index the filename alone than
    reject the whole file).
    """
    if _looks_textual(f):
        try:
            return read_text(f.storage_path, _CONTENT_TEXT_LIMIT)
        except OSError:
            logger.exception(
                "failed reading text blob for FTS extraction (%s)", f.id
            )
            return None

    if _looks_pdf(f):
        try:
            text, _ = _extract_pdf_text(f.storage_path, _CONTENT_TEXT_LIMIT)
        except OSError:
            logger.exception(
                "failed reading PDF blob for FTS extraction (%s)", f.id
            )
            return None
        except Exception:  # noqa: BLE001 - pypdf raises broadly
            logger.exception("pypdf failed extracting %s for FTS", f.id)
            return None
        return text or None

    return None


def extract_from_text(text: str) -> str:
    """Return the FTS payload for a known-text source overwrite.

    Used by the Markdown source-editor path where we already hold
    the new text in memory and don't need to re-read the blob off
    disk. We truncate to the same ceiling as the on-disk path so
    the tsvector size stays bounded.
    """
    data = text.encode("utf-8")
    if len(data) <= _CONTENT_TEXT_LIMIT:
        return text
    truncated = data[:_CONTENT_TEXT_LIMIT].decode("utf-8", errors="ignore")
    return truncated + "\n… [truncated]"


# Extension shortcuts so a caller can skip the whole UserFile object
# when it knows enough from the filename alone. Keeps us honest —
# anything we index in ``extract_content_text`` should also be a
# text-ish extension.
def looks_extractable(filename: str, mime: str | None) -> bool:
    """Cheap predicate: would we bother trying to extract this file?"""
    ext = os.path.splitext(filename or "")[1].lower()
    fake = UserFile.__new__(UserFile)  # type: ignore[call-arg]
    fake.filename = filename
    fake.mime_type = mime or ""
    return _looks_textual(fake) or _looks_pdf(fake) or ext == ".pdf"


__all__ = [
    "extract_content_text",
    "extract_from_text",
    "looks_extractable",
]
