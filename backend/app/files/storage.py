"""On-disk storage helpers for the Files feature.

All uploaded bytes live under `UPLOAD_ROOT` in a predictable layout:

    uploads/
      u_<user_id>/
        <file_id><ext>        # one blob per UserFile row
      shared/
        <file_id><ext>

The DB row stores the **relative** path under `UPLOAD_ROOT` — we never
surface the absolute path to clients, and `_resolve()` enforces that a
client-supplied path can't escape the root.
"""
from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

# Upload root is a bind volume on the backend container. Keep the env knob
# around so tests can point elsewhere without touching docker-compose.
UPLOAD_ROOT = Path(os.environ.get("PROMPTLY_UPLOAD_ROOT", "/app/uploads")).resolve()

# Per-file ceiling. Matches nginx's client_max_body_size (50M) with a small
# margin for multipart framing overhead. Nginx rejects larger requests first,
# but we double-check here for direct-to-backend calls.
MAX_FILE_BYTES = 40 * 1024 * 1024


def _bucket_dir(user_id: uuid.UUID | None) -> Path:
    if user_id is None:
        return UPLOAD_ROOT / "shared"
    return UPLOAD_ROOT / f"u_{user_id}"


def storage_path_for(user_id: uuid.UUID | None, file_id: uuid.UUID, ext: str) -> str:
    """Return the relative storage path we persist in the DB."""
    bucket = "shared" if user_id is None else f"u_{user_id}"
    safe_ext = ext if ext.startswith(".") or ext == "" else f".{ext}"
    return f"{bucket}/{file_id}{safe_ext}"


def absolute_path(relative: str) -> Path:
    """Safely resolve a relative storage path into an absolute one.

    Raises ValueError if the resolved path escapes `UPLOAD_ROOT` — this
    protects against a tampered DB row or anything else that could feed
    untrusted bytes into a filesystem call.
    """
    full = (UPLOAD_ROOT / relative).resolve()
    try:
        full.relative_to(UPLOAD_ROOT)
    except ValueError as e:
        raise ValueError(f"storage path {relative!r} escapes upload root") from e
    return full


def ensure_bucket(user_id: uuid.UUID | None) -> Path:
    d = _bucket_dir(user_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def delete_blob(relative: str) -> None:
    """Best-effort blob removal. Missing files are not an error."""
    try:
        absolute_path(relative).unlink(missing_ok=True)
    except (OSError, ValueError):
        # File might have been wiped out of band; we always succeed on the DB
        # side to keep the two views in sync from the user's perspective.
        pass


def copy_stream_to_disk(src, dest_relative: str, size_limit: int = MAX_FILE_BYTES) -> int:
    """Write a stream (e.g. UploadFile.file) to disk and return bytes written.

    Raises ValueError on size overflow and cleans up the partial file.
    """
    dest = absolute_path(dest_relative)
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = src.read(1024 * 64)
                if not chunk:
                    break
                total += len(chunk)
                if total > size_limit:
                    raise ValueError("file exceeds maximum size")
                out.write(chunk)
    except Exception:
        # Roll back the partial write before re-raising.
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return total


def read_text(relative: str, max_bytes: int) -> str:
    """Read a blob as UTF-8 text up to `max_bytes`. Tolerates encoding errors."""
    path = absolute_path(relative)
    with open(path, "rb") as f:
        raw = f.read(max_bytes + 1)
    truncated = len(raw) > max_bytes
    raw = raw[:max_bytes]
    text = raw.decode("utf-8", errors="replace")
    if truncated:
        text += "\n… [truncated]"
    return text


__all__ = [
    "UPLOAD_ROOT",
    "MAX_FILE_BYTES",
    "absolute_path",
    "copy_stream_to_disk",
    "delete_blob",
    "ensure_bucket",
    "read_text",
    "storage_path_for",
    "shutil",
]
