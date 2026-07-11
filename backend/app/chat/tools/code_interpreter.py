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

import logging
import os
import uuid
from typing import Any

from app.chat.models import Message
from app.chat.sandbox_exec import (
    SandboxError,
    SandboxNotConfigured,
    run_python_in_sandbox,
)
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
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
    # timeout_seconds stays None ON PURPOSE: the sandbox owns the
    # budget (settings.CODE_SANDBOX_TIMEOUT_S, admin-tunable) and the
    # httpx client already waits timeout_s + 15. A static dispatch cap
    # here would silently undercut an admin who raises the sandbox
    # limit.
    description = (
        "Execute Python code in a secure, sandboxed environment and return "
        "stdout, errors, and any files produced. Use this ONLY when the "
        "user explicitly asks to run code, compute a specific calculation "
        "with numbers they have provided, process/transform an uploaded data "
        "file (CSV, Excel, JSON, etc.), or generate a chart from actual data. "
        "pandas, numpy, matplotlib, seaborn, plotly, altair, and openpyxl are "
        "available. The sandbox has NO internet access. Files you create "
        "PERSIST across calls within this conversation, so you can build a "
        "file (e.g. a cleaned CSV) in one call and read it back in the next "
        "without regenerating it. "
        "Files the user attached to this message are in the working directory "
        "under their original filename (e.g. pd.read_csv('data.csv')). "
        "Save charts with matplotlib (plt.savefig('chart.png')); for "
        "interactive plots use plotly (fig.write_html('chart.html')) or "
        "altair (chart.save('chart.html')) and the file is attached. "
        "Use print() for any results you want to see. "
        "Do NOT call this for general advice, recommendations, explanations, "
        "conversational answers, or anything you can answer directly in text "
        "— even if the topic involves numbers or health/fitness."
    )
    prompt_hint = (
        "Run Python in a secure sandbox (pandas/numpy/matplotlib/seaborn/"
        "plotly/altair available, no internet). Call this only when the user "
        "explicitly asks to run code, crunch a specific dataset they uploaded, "
        "or generate a chart from data. Do NOT use it to answer conversational "
        "questions, give advice, or perform simple mental-math estimates — "
        "reply in text for those. Uploaded files are in the working directory "
        "by filename; files you create persist across calls in this "
        "conversation. Save plots with plt.savefig('name.png') (or "
        "fig.write_html('name.html') for interactive plotly/altair) to attach."
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

        # ---- Resolve input files (explicit ∪ auto-attached) → (name, bytes) ----
        files = await self._gather_input_files(ctx, args.get("input_file_ids"))
        input_files: list[tuple[str, bytes]] = []
        for row in files:
            try:
                data = await self._read_bytes(row)
            except ToolError:
                # Best-effort: skip an unreadable input rather than aborting
                # the whole run. The model still sees what loaded via stdout.
                continue
            input_files.append((row.filename, data))

        # ---- Run in the shared sandbox (persists produced files) ----
        try:
            result = await run_python_in_sandbox(
                ctx.db,
                user=ctx.user,
                code=code,
                input_files=input_files,
                # Persist the working dir across calls within this conversation
                # so the model can build a file in one run and read it in the next.
                session_id=str(ctx.conversation_id),
                persist_outputs=True,
            )
        except SandboxNotConfigured as e:
            raise ToolError(f"{e} Ask an admin to enable the sandbox service.") from e
        except SandboxError as e:
            raise ToolError(str(e)) from e

        # ---- Build the model-facing result string ----
        content = self._build_feedback(
            exit_code=result.exit_code,
            timed_out=result.timed_out,
            stdout=result.stdout,
            stderr=result.stderr,
            produced_names=result.produced_names,
            skipped_names=result.skipped_names,
        )

        meta: dict[str, Any] = {
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "file_count": len(result.produced_names),
            "chart_count": result.chart_count,
            "errored": result.errored,
        }
        if result.produced_names:
            meta["produced"] = result.produced_names

        logger.info(
            "code_interpreter: user=%s exit=%s timed_out=%s inputs=%d outputs=%d",
            ctx.user.id,
            result.exit_code,
            result.timed_out,
            len(input_files),
            len(result.produced_names),
        )

        return ToolResult(
            content=content,
            attachment_ids=[f.id for f in result.attachments],
            meta=meta,
        )

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
        skipped_names: list[str] | None = None,
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

        if skipped_names:
            parts.append(
                f"NOT attached (file type not allowed as an output): "
                f"{', '.join(skipped_names)}. If the user needs this "
                "content, write it out in an allowed format instead "
                "(e.g. .txt, .csv, .json, .png, .zip)."
            )

        if exit_code != 0 or timed_out:
            parts.append(
                "If this was a bug in the code, fix it and call "
                "code_interpreter again; otherwise explain the problem to "
                "the user."
            )
        return "\n\n".join(parts)


__all__ = ["CodeInterpreterTool"]
