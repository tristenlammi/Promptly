"""Promptly code-interpreter sandbox — execution shim.

Receives a job (Python source + optional input files), runs it in a
fresh scratch directory under a tmpfs, and returns stdout/stderr plus
any files the script produced (charts, CSVs, etc.).

Isolation is layered:

* **Network** — the container sits on an internal-only docker network,
  so even ``import requests; requests.get(...)`` can't reach the
  internet or any other Promptly service. This file doesn't try to
  re-implement that; it trusts the network boundary.
* **Resources** — every job runs as a subprocess with ``setrlimit``
  CPU / address-space / file-size / open-file caps plus a wall-clock
  timeout enforced by the parent. A runaway ``while True`` or a 10 GB
  allocation dies on its own.
* **Filesystem** — a brand-new temp dir per job under the tmpfs
  scratch; input filenames are reduced to their basename so a job
  can't write outside its sandbox via ``../``. The rootfs is mounted
  read-only by compose.
* **Auth** — a shared-secret header so only the backend (which knows
  ``SANDBOX_SECRET``) can submit jobs, even though the internal network
  already limits reachability to sibling containers.
"""
from __future__ import annotations

import base64
import mimetypes
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Promptly Sandbox", docs_url=None, redoc_url=None)

# ---- Tunables (overridable via env) --------------------------------
SCRATCH_ROOT = Path(os.environ.get("SANDBOX_SCRATCH", "/sandbox/run"))
SECRET = os.environ.get("SANDBOX_SECRET", "")

# Wall-clock ceiling regardless of what the caller asks for.
MAX_TIMEOUT_S = int(os.environ.get("SANDBOX_MAX_TIMEOUT_S", "60"))
DEFAULT_TIMEOUT_S = int(os.environ.get("SANDBOX_DEFAULT_TIMEOUT_S", "30"))

# Per-process address space (virtual memory) cap.
MEM_LIMIT_BYTES = int(os.environ.get("SANDBOX_MEM_BYTES", str(900 * 1024 * 1024)))
# Largest single file the job may write.
FSIZE_LIMIT_BYTES = int(
    os.environ.get("SANDBOX_FSIZE_BYTES", str(32 * 1024 * 1024))
)

# Caps on what we hand back to the backend.
MAX_STREAM_CHARS = 50_000  # stdout / stderr each
MAX_OUTPUT_FILES = 20
MAX_OUTPUT_TOTAL_BYTES = 24 * 1024 * 1024
MAX_INPUT_FILES = 25
MAX_INPUT_TOTAL_BYTES = 64 * 1024 * 1024

# Output files we'll return, by extension. Anything else the script
# writes is ignored (we don't ship back arbitrary binaries we can't
# describe). Charts + common data exports cover the analysis use case.
_RETURN_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".csv", ".tsv", ".json", ".txt", ".md", ".html",
    ".xlsx", ".xls", ".parquet",
}

# Appended after the user's code so a script that builds matplotlib
# figures but forgets to ``savefig`` still produces visible charts. We
# only kick in when the script saved NO image files itself — otherwise
# an explicit ``plt.savefig('chart.png')`` that leaves the figure open
# would get duplicated as ``figure_1.png``. Wrapped in a broad except so
# it can never turn a successful run into a failure.
_AUTOSAVE_EPILOGUE = """

# --- Promptly: auto-save unsaved matplotlib figures (fallback only) ---
try:
    import glob as _glob
    _imgs = []
    for _pat in ("*.png", "*.jpg", "*.jpeg", "*.svg", "*.webp", "*.gif"):
        _imgs += _glob.glob(_pat)
    if not _imgs:
        import matplotlib.pyplot as _plt  # noqa
        for _i, _n in enumerate(_plt.get_fignums()):
            _plt.figure(_n).savefig(
                f"figure_{_i + 1}.png", dpi=120, bbox_inches="tight"
            )
except Exception:
    pass
"""


class InputFile(BaseModel):
    name: str
    content_b64: str


class ExecuteRequest(BaseModel):
    code: str = Field(min_length=1)
    files: list[InputFile] = Field(default_factory=list)
    timeout_s: int | None = None


class OutputFile(BaseModel):
    name: str
    mime: str
    size: int
    content_b64: str


class ExecuteResponse(BaseModel):
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    outputs: list[OutputFile]


def _set_limits() -> None:
    """``preexec_fn`` for the child: cap CPU, memory, file size, fds.

    Runs in the forked child *before* exec. Linux-only (the container
    is Linux); each ``setrlimit`` is best-effort so a platform that
    rejects one doesn't abort the whole run.
    """
    cpu = min(MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S) + 2
    for res, soft, hard in (
        (resource.RLIMIT_CPU, cpu, cpu + 1),
        (resource.RLIMIT_AS, MEM_LIMIT_BYTES, MEM_LIMIT_BYTES),
        (resource.RLIMIT_FSIZE, FSIZE_LIMIT_BYTES, FSIZE_LIMIT_BYTES),
        (resource.RLIMIT_NOFILE, 256, 256),
        # No new processes beyond a small pool (defends against fork
        # bombs even with the compose-level pids_limit as backstop).
        (resource.RLIMIT_NPROC, 64, 64),
        (resource.RLIMIT_CORE, 0, 0),
    ):
        try:
            resource.setrlimit(res, (soft, hard))
        except (ValueError, OSError):
            pass
    # New session so we can signal the whole process group on timeout.
    os.setsid()


def _truncate(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_STREAM_CHARS:
        return text, False
    return text[:MAX_STREAM_CHARS] + "\n…[output truncated]", True


def _safe_name(name: str) -> str:
    """Reduce an input filename to a safe basename (no path traversal)."""
    base = os.path.basename(name or "").strip().replace("\x00", "")
    base = base.lstrip(".") or "input"
    # Keep it filesystem-friendly without being precious about it.
    return "".join(c for c in base if c not in '/\\:*?"<>|') or "input"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
def execute(
    req: ExecuteRequest,
    x_sandbox_secret: str = Header(default=""),
) -> ExecuteResponse:
    if SECRET and x_sandbox_secret != SECRET:
        raise HTTPException(status_code=401, detail="bad sandbox secret")

    if len(req.files) > MAX_INPUT_FILES:
        raise HTTPException(status_code=400, detail="too many input files")

    timeout = req.timeout_s or DEFAULT_TIMEOUT_S
    timeout = max(1, min(timeout, MAX_TIMEOUT_S))

    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="job-", dir=str(SCRATCH_ROOT)))

    try:
        # ---- Materialise input files ----
        total_in = 0
        input_names: set[str] = set()
        for f in req.files:
            try:
                raw = base64.b64decode(f.content_b64, validate=False)
            except Exception:
                raise HTTPException(
                    status_code=400, detail=f"bad base64 for {f.name!r}"
                )
            total_in += len(raw)
            if total_in > MAX_INPUT_TOTAL_BYTES:
                raise HTTPException(status_code=400, detail="input files too large")
            safe = _safe_name(f.name)
            (workdir / safe).write_bytes(raw)
            input_names.add(safe)

        # ---- Write the script ----
        script_name = "_promptly_main.py"
        input_names.add(script_name)
        (workdir / script_name).write_text(
            req.code + _AUTOSAVE_EPILOGUE, encoding="utf-8"
        )

        # ---- Run it ----
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(workdir),
            "MPLBACKEND": "Agg",
            "MPLCONFIGDIR": str(workdir / ".mpl"),
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            # No proxy / no creds leak into the child.
            "OPENBLAS_NUM_THREADS": "2",
            "OMP_NUM_THREADS": "2",
        }
        timed_out = False
        exit_code: int | None
        try:
            proc = subprocess.run(
                [sys.executable, "-I", script_name],
                cwd=str(workdir),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
                preexec_fn=_set_limits,
            )
            stdout, stderr = proc.stdout, proc.stderr
            exit_code = proc.returncode
        except subprocess.TimeoutExpired as e:
            timed_out = True
            exit_code = None
            stdout = e.stdout or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", "replace")
            stderr = (e.stderr or "")
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", "replace")
            stderr += (
                f"\n[sandbox] Execution exceeded the {timeout}s time limit "
                "and was killed."
            )

        out_text, out_trunc = _truncate(stdout or "")
        err_text, err_trunc = _truncate(stderr or "")

        # ---- Collect produced files ----
        outputs: list[OutputFile] = []
        total_out = 0
        for path in sorted(workdir.iterdir()):
            if not path.is_file():
                continue
            if path.name in input_names:
                continue
            ext = path.suffix.lower()
            if ext not in _RETURN_EXTS:
                continue
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if not data:
                continue
            total_out += len(data)
            if total_out > MAX_OUTPUT_TOTAL_BYTES:
                break
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            outputs.append(
                OutputFile(
                    name=path.name,
                    mime=mime,
                    size=len(data),
                    content_b64=base64.b64encode(data).decode("ascii"),
                )
            )
            if len(outputs) >= MAX_OUTPUT_FILES:
                break

        # Images first so the most useful artefacts surface at the top.
        outputs.sort(key=lambda o: (not o.mime.startswith("image/"), o.name))

        return ExecuteResponse(
            exit_code=exit_code,
            stdout=out_text,
            stderr=err_text,
            stdout_truncated=out_trunc,
            stderr_truncated=err_trunc,
            timed_out=timed_out,
            outputs=outputs,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
