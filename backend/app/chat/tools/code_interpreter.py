"""``code_interpreter`` — run model-written Python in the sandbox.

Phase 4. The assistant writes Python; we ship it to the isolated
``sandbox`` service (internal-only network, no internet, hard CPU /
memory / time limits) and feed back stdout/stderr. Any files the script
produces — matplotlib charts, exported CSVs, etc. — are persisted via
:func:`persist_generated_file` and attached to the reply, so plots show
up inline as image chips just like ``generate_image`` output.

Input data flows in two ways, both materialised into the script's
working directory under their original filename so ``pd.read_csv(
"sales.csv")`` just works:

* **Auto** — every data-ish file the user attached to *this* turn
  (CSV/Excel/JSON/Parquet/text). This is the common case: "analyse
  this spreadsheet" + a drop.
* **Explicit** — ``input_file_ids`` the model passes, for files the
  user referenced from their Drive via ``@mention`` rather than a
  fresh attachment.
"""
from __future__ import annotations

import base64
import logging
import os
import uuid
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Message
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.config import get_settings
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.models import UserFile
from app.files.storage import absolute_path

logger = logging.getLogger("promptly.tools.code_interpreter")

_MAX_CODE_CHARS = 20_000
# Largest single input file we'll ship into the sandbox. Big enough for
# real datasets; the sandbox also enforces a total-input ceiling.
_MAX_INPUT_FILE_BYTES = 24 * 1024 * 1024
_MAX_INPUT_FILES = 12
# How much stdout/stderr we replay back to the model. Generous so a
# ``df.describe()`` dump survives, but bounded so a chatty script can't
# blow the context window.
_MAX_FEEDBACK_CHARS = 6_000

# Extensions whose files we auto-pull from the triggering turn as data
# inputs. Images are intentionally excluded — those go down the vision /
# generate_image path, not the interpreter.
_DATA_EXTS = {
    ".csv", ".tsv", ".json", ".jsonl", ".txt", ".md",
    ".xlsx", ".xls", ".parquet", ".xml", ".yaml", ".yml",
}
_DATA_MIME_PREFIXES = ("text/",)
_DATA_MIMES = {
    "application/json",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/x-parquet",
}


def _looks_like_data(f: UserFile) -> bool:
    ext = os.path.splitext(f.filename or "")[1].lower()
    if ext in _DATA_EXTS:
        return True
    mime = (f.mime_type or "").lower()
    if mime in _DATA_MIMES:
        return True
    return any(mime.startswith(p) for p in _DATA_MIME_PREFIXES)


class CodeInterpreterTool(Tool):
    name = "code_interpreter"
    category = "code"
    # Allow genuine iteration (write → inspect error → fix) within a
    # turn, but cap so a stuck model can't spin the sandbox forever.
    max_per_turn = 6
    description = (
        "Execute Python code in a secure, sandboxed environment and return "
        "stdout, errors, and any files produced. Use this ONLY when the "
        "user explicitly asks to run code, compute a specific calculation "
        "with numbers they have provided, process/transform an uploaded data "
        "file (CSV, Excel, JSON, etc.), or generate a chart from actual data. "
        "pandas, numpy, matplotlib, and openpyxl are available. "
        "The sandbox has NO internet access and is reset after every run. "
        "Files the user attached to this message are in the working directory "
        "under their original filename (e.g. pd.read_csv('data.csv')). "
        "Save charts with matplotlib (plt.savefig('chart.png')) to attach "
        "them inline. Use print() for any results you want to see. "
        "Do NOT call this for general advice, recommendations, explanations, "
        "conversational answers, or anything you can answer directly in text "
        "— even if the topic involves numbers or health/fitness."
    )
    prompt_hint = (
        "Run Python in a secure sandbox (pandas/numpy/matplotlib available, "
        "no internet). Call this only when the user explicitly asks to run "
        "code, crunch a specific dataset they uploaded, or generate a chart "
        "from data. Do NOT use it to answer conversational questions, give "
        "advice, or perform simple mental-math estimates — reply in text "
        "for those. Uploaded files are in the working directory by filename; "
        "save plots with plt.savefig('name.png') to attach them."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": (
                    "The Python source to execute. Print results you want "
                    "to see; save any charts with matplotlib's savefig. "
                    "Files the user attached are in the working directory "
                    f"by filename. Max {_MAX_CODE_CHARS:,} characters."
                ),
                "maxLength": _MAX_CODE_CHARS,
            },
            "input_file_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional UUIDs of additional files from the user's "
                    "Drive to load into the working directory (e.g. a file "
                    "they referenced with @mention). Files attached to the "
                    "current message are loaded automatically and don't "
                    "need to be listed here."
                ),
            },
        },
        "required": ["code"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        code = args.get("code")
        if not isinstance(code, str) or not code.strip():
            raise ToolError("`code` is required and must be a non-empty string")
        if len(code) > _MAX_CODE_CHARS:
            raise ToolError(f"`code` exceeds {_MAX_CODE_CHARS:,}-char limit")

        settings = get_settings()
        base_url = (settings.CODE_SANDBOX_URL or "").rstrip("/")
        if not base_url:
            raise ToolError(
                "The code interpreter isn't configured on this server. "
                "Ask an admin to enable the sandbox service."
            )

        # ---- Resolve input files (explicit ∪ auto-attached) ----
        files = await self._gather_input_files(ctx, args.get("input_file_ids"))

        payload_files: list[dict[str, str]] = []
        total = 0
        for row in files:
            try:
                data = await self._read_bytes(row)
            except ToolError:
                # Best-effort: skip an unreadable input rather than aborting
                # the whole run. The model still sees what loaded via stdout.
                continue
            total += len(data)
            if total > _MAX_INPUT_FILE_BYTES * _MAX_INPUT_FILES:
                break
            payload_files.append(
                {
                    "name": row.filename,
                    "content_b64": base64.b64encode(data).decode("ascii"),
                }
            )

        timeout_s = max(1, int(settings.CODE_SANDBOX_TIMEOUT_S or 30))

        # ---- Ship the job to the sandbox ----
        headers = {}
        if settings.CODE_SANDBOX_SECRET:
            headers["X-Sandbox-Secret"] = settings.CODE_SANDBOX_SECRET
        try:
            async with httpx.AsyncClient(timeout=timeout_s + 15) as client:
                resp = await client.post(
                    f"{base_url}/execute",
                    headers=headers,
                    json={
                        "code": code,
                        "files": payload_files,
                        "timeout_s": timeout_s,
                    },
                )
        except httpx.HTTPError as e:
            logger.warning("code_interpreter: sandbox unreachable: %s", e)
            raise ToolError(
                "Couldn't reach the code sandbox. It may be starting up — "
                "try again in a moment."
            ) from e

        if resp.status_code != 200:
            detail = resp.text[:500]
            raise ToolError(f"Sandbox rejected the job ({resp.status_code}): {detail}")

        result = resp.json()
        stdout = str(result.get("stdout") or "")
        stderr = str(result.get("stderr") or "")
        exit_code = result.get("exit_code")
        timed_out = bool(result.get("timed_out"))
        outputs = result.get("outputs") or []

        # ---- Persist produced files → attachment chips ----
        attachment_ids: list[uuid.UUID] = []
        produced_names: list[str] = []
        chart_count = 0
        for out in outputs:
            name = str(out.get("name") or "output")
            mime = str(out.get("mime") or "application/octet-stream")
            content_b64 = out.get("content_b64") or ""
            try:
                blob = base64.b64decode(content_b64)
            except Exception:
                continue
            if not blob:
                continue
            try:
                row = await persist_generated_file(
                    ctx.db,
                    user=ctx.user,
                    filename=name,
                    mime_type=mime,
                    content=blob,
                )
            except GeneratedFileError as e:
                logger.info("code_interpreter: couldn't persist %s: %s", name, e)
                continue
            attachment_ids.append(row.id)
            produced_names.append(row.filename)
            if mime.startswith("image/"):
                chart_count += 1

        # ---- Build the model-facing result string ----
        content = self._build_feedback(
            exit_code=exit_code,
            timed_out=timed_out,
            stdout=stdout,
            stderr=stderr,
            produced_names=produced_names,
        )

        errored = timed_out or (exit_code is not None and exit_code != 0)
        meta: dict[str, Any] = {
            "exit_code": exit_code,
            "timed_out": timed_out,
            "file_count": len(produced_names),
            "chart_count": chart_count,
            "errored": errored,
        }
        if produced_names:
            meta["produced"] = produced_names

        logger.info(
            "code_interpreter: user=%s exit=%s timed_out=%s inputs=%d outputs=%d",
            ctx.user.id,
            exit_code,
            timed_out,
            len(payload_files),
            len(produced_names),
        )

        return ToolResult(content=content, attachment_ids=attachment_ids, meta=meta)

    # ================================================================
    # Helpers
    # ================================================================
    async def _gather_input_files(
        self, ctx: ToolContext, explicit_ids: Any
    ) -> list[UserFile]:
        """Collect data files: explicit ids first, then auto-attachments.

        De-duplicates by file id and caps the count so a huge attachment
        set can't balloon the request.
        """
        seen: set[uuid.UUID] = set()
        out: list[UserFile] = []

        # Explicit ids the model passed.
        if isinstance(explicit_ids, list):
            for raw in explicit_ids:
                if len(out) >= _MAX_INPUT_FILES:
                    break
                try:
                    fid = uuid.UUID(str(raw))
                except (ValueError, TypeError):
                    continue
                if fid in seen:
                    continue
                row = await ctx.db.get(UserFile, fid)
                if row is None or row.user_id != ctx.user.id:
                    continue
                seen.add(fid)
                out.append(row)

        # Auto: data-ish attachments on the triggering user message.
        msg = await ctx.db.get(Message, ctx.user_message_id)
        if msg is not None and msg.attachments:
            for att in msg.attachments:
                if len(out) >= _MAX_INPUT_FILES:
                    break
                if not isinstance(att, dict):
                    continue
                att_id = att.get("id")
                if not att_id:
                    continue
                try:
                    fid = uuid.UUID(str(att_id))
                except (ValueError, TypeError):
                    continue
                if fid in seen:
                    continue
                row = await ctx.db.get(UserFile, fid)
                if row is None or row.user_id != ctx.user.id:
                    continue
                if not _looks_like_data(row):
                    continue
                seen.add(fid)
                out.append(row)

        return out

    async def _read_bytes(self, row: UserFile) -> bytes:
        if row.size_bytes > _MAX_INPUT_FILE_BYTES:
            raise ToolError(
                f"Input file {row.filename!r} is too large "
                f"({row.size_bytes:,} bytes; cap {_MAX_INPUT_FILE_BYTES:,})."
            )
        try:
            path = absolute_path(row.storage_path)
        except ValueError as e:
            raise ToolError(f"Refusing suspicious path: {e}") from e
        if not path.exists():
            raise ToolError(f"File {row.filename!r} is missing on disk")
        try:
            return path.read_bytes()
        except OSError as e:
            raise ToolError(f"Failed to read {row.filename!r}: {e}") from e

    def _build_feedback(
        self,
        *,
        exit_code: Any,
        timed_out: bool,
        stdout: str,
        stderr: str,
        produced_names: list[str],
    ) -> str:
        def _clip(s: str) -> str:
            s = s.rstrip()
            if len(s) > _MAX_FEEDBACK_CHARS:
                return s[:_MAX_FEEDBACK_CHARS] + "\n…[truncated]"
            return s

        parts: list[str] = []
        if timed_out:
            parts.append("Execution TIMED OUT and was killed before finishing.")
        elif exit_code == 0:
            parts.append("Execution succeeded (exit code 0).")
        else:
            parts.append(f"Execution FAILED (exit code {exit_code}).")

        if stdout.strip():
            parts.append(f"stdout:\n{_clip(stdout)}")
        else:
            parts.append("stdout: (empty)")
        if stderr.strip():
            parts.append(f"stderr:\n{_clip(stderr)}")

        if produced_names:
            listed = ", ".join(produced_names)
            parts.append(
                f"Produced {len(produced_names)} file(s), now attached to "
                f"your reply and shown to the user: {listed}. Don't paste "
                "their contents back; just reference them."
            )

        if exit_code != 0 or timed_out:
            parts.append(
                "If this was a bug in the code, fix it and call "
                "code_interpreter again; otherwise explain the problem to "
                "the user."
            )
        return "\n\n".join(parts)


__all__ = ["CodeInterpreterTool"]
