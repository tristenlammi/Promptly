"""Shared sandboxed-Python execution service.

Extracted from :class:`~app.chat.tools.code_interpreter.CodeInterpreterTool`
so BOTH the model-driven ``code_interpreter`` tool and the user-facing
``POST /api/code/run`` endpoint hit the same hardened sandbox with the same
output gating + persistence. There are no turn/message concepts here — just
"run this Python, persist any produced files, tell me what happened".

The sandbox itself (``sandbox/`` service) does the real isolation: internal-
only network (no internet), read-only rootfs, dropped caps, and CPU / memory /
time / file rlimits. This module is the trusted client that ships jobs to it
and gates what comes back before anything lands in the user's Drive.
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass, field

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.models import UserFile

logger = logging.getLogger("promptly.sandbox_exec")

# Total input bytes we'll ship in one job. Individual callers cap per-file
# sizes; this is the aggregate backstop (the sandbox enforces its own too).
_MAX_INPUT_TOTAL_BYTES = 64 * 1024 * 1024

# Output-file gate. The sandbox is trusted-ish (our own container) but
# defence-in-depth says we don't persist arbitrary blobs a compromised or
# buggy sandbox hands back: no executables / scripts land in the user's Drive
# with a download button on them. MIME is whitelisted (prefixes + exact
# types) and the extension is deny-listed as a second gate because
# ``application/octet-stream`` is a legitimate fallback for e.g. parquet.
_ALLOWED_OUTPUT_MIME_PREFIXES = ("text/", "image/", "audio/", "video/")
_ALLOWED_OUTPUT_MIMES = {
    "application/json",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/x-parquet",
    "application/octet-stream",
}
_BLOCKED_OUTPUT_EXTS = {
    ".exe", ".dll", ".so", ".dylib", ".msi", ".bat", ".cmd", ".ps1",
    ".sh", ".com", ".scr", ".vbs", ".jar", ".apk", ".deb", ".rpm",
    ".pyc",
}


def _output_allowed(name: str, mime: str) -> bool:
    ext = os.path.splitext(name or "")[1].lower()
    if ext in _BLOCKED_OUTPUT_EXTS:
        return False
    m = (mime or "").lower().split(";")[0].strip()
    if any(m.startswith(p) for p in _ALLOWED_OUTPUT_MIME_PREFIXES):
        return True
    return m in _ALLOWED_OUTPUT_MIMES


class SandboxError(Exception):
    """Sandbox was reachable-but-unhappy, or unreachable. Callers map this
    to a ToolError (chat tool) or a 5xx (HTTP endpoint)."""


class SandboxNotConfigured(SandboxError):
    """No sandbox URL/secret configured — a deployment problem, distinct from
    a transient failure so callers can surface a 503 with an admin hint."""


@dataclass
class SandboxRunResult:
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    # Persisted output files (empty when ``persist_outputs=False`` or none
    # were produced / allowed).
    attachments: list[UserFile] = field(default_factory=list)
    produced_names: list[str] = field(default_factory=list)
    skipped_names: list[str] = field(default_factory=list)
    chart_count: int = 0

    @property
    def errored(self) -> bool:
        return self.timed_out or (self.exit_code is not None and self.exit_code != 0)


async def run_python_in_sandbox(
    db: AsyncSession,
    *,
    user: User,
    code: str,
    input_files: list[tuple[str, bytes]] | None = None,
    session_id: str | None = None,
    persist_outputs: bool = True,
) -> SandboxRunResult:
    """Ship ``code`` to the sandbox and return its structured result.

    ``input_files`` are ``(name, bytes)`` pairs materialised into the working
    directory under their name (the caller resolves them — Drive files,
    uploads, etc.). ``session_id`` (typically a conversation id) persists the
    working dir across calls so a file built in one run is readable in the
    next. When ``persist_outputs`` is True, produced files that pass the
    output gate are saved via :func:`persist_generated_file` and returned as
    ``attachments``.

    Raises :class:`SandboxNotConfigured` when the sandbox isn't set up, or
    :class:`SandboxError` when it's unreachable or rejects the job.
    """
    settings = get_settings()
    base_url = (settings.CODE_SANDBOX_URL or "").rstrip("/")
    if not base_url:
        raise SandboxNotConfigured(
            "The code sandbox isn't configured on this server."
        )
    # The sandbox fails closed without a shared secret, so an empty value
    # here can only ever produce a confusing 503 from it — surface the
    # misconfiguration clearly instead. (Config mirrors SECRET_KEY into this
    # at boot, so this should never fire on a healthy install.)
    sandbox_secret = (settings.CODE_SANDBOX_SECRET or "").strip()
    if not sandbox_secret:
        raise SandboxNotConfigured(
            "The code sandbox is disabled: no sandbox secret is configured."
        )

    payload_files: list[dict[str, str]] = []
    total = 0
    for name, data in (input_files or []):
        if not data:
            continue
        total += len(data)
        if total > _MAX_INPUT_TOTAL_BYTES:
            break
        payload_files.append(
            {"name": name, "content_b64": base64.b64encode(data).decode("ascii")}
        )

    timeout_s = max(1, int(settings.CODE_SANDBOX_TIMEOUT_S or 30))
    headers = {"X-Sandbox-Secret": sandbox_secret}
    try:
        async with httpx.AsyncClient(timeout=timeout_s + 15) as client:
            resp = await client.post(
                f"{base_url}/execute",
                headers=headers,
                json={
                    "code": code,
                    "files": payload_files,
                    "timeout_s": timeout_s,
                    "session_id": session_id,
                },
            )
    except httpx.HTTPError as e:
        logger.warning("sandbox unreachable: %s", e)
        raise SandboxError(
            "Couldn't reach the code sandbox. It may be starting up — try "
            "again in a moment."
        ) from e

    if resp.status_code != 200:
        detail = resp.text[:500]
        raise SandboxError(f"Sandbox rejected the job ({resp.status_code}): {detail}")

    result = resp.json()
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    exit_code = result.get("exit_code")
    timed_out = bool(result.get("timed_out"))
    stdout_truncated = bool(result.get("stdout_truncated"))
    stderr_truncated = bool(result.get("stderr_truncated"))
    outputs = result.get("outputs") or []

    attachments: list[UserFile] = []
    produced_names: list[str] = []
    skipped_names: list[str] = []
    chart_count = 0
    if persist_outputs:
        for out in outputs:
            name = str(out.get("name") or "output")
            mime = str(out.get("mime") or "application/octet-stream")
            content_b64 = out.get("content_b64") or ""
            if not _output_allowed(name, mime):
                logger.warning(
                    "sandbox_exec: refusing output %r (mime=%s) user=%s",
                    name, mime, user.id,
                )
                skipped_names.append(name)
                continue
            try:
                blob = base64.b64decode(content_b64)
            except Exception:  # noqa: BLE001 — malformed payload
                continue
            if not blob:
                continue
            try:
                row = await persist_generated_file(
                    db, user=user, filename=name, mime_type=mime, content=blob,
                )
            except GeneratedFileError as e:
                logger.info("sandbox_exec: couldn't persist %s: %s", name, e)
                continue
            attachments.append(row)
            produced_names.append(row.filename)
            if mime.startswith("image/"):
                chart_count += 1

    return SandboxRunResult(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        stdout_truncated=stdout_truncated,
        stderr_truncated=stderr_truncated,
        timed_out=timed_out,
        attachments=attachments,
        produced_names=produced_names,
        skipped_names=skipped_names,
        chart_count=chart_count,
    )


__all__ = [
    "SandboxError",
    "SandboxNotConfigured",
    "SandboxRunResult",
    "run_python_in_sandbox",
]
