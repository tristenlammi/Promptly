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
import hmac
import mimetypes
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Promptly Sandbox", docs_url=None, redoc_url=None)

# ---- Tunables (overridable via env) --------------------------------
SCRATCH_ROOT = Path(os.environ.get("SANDBOX_SCRATCH", "/sandbox/run"))


SECRET = os.environ.get("SANDBOX_SECRET", "").strip()

# ---- Persistent sessions -------------------------------------------
# When a job carries a ``session_id``, its working directory survives
# across calls (under SESSIONS_ROOT) so a script can build a CSV in one
# call and read it in the next. These dirs live in the same tmpfs as the
# throwaway jobs, so they're memory-backed, bounded, and cleared on a
# container restart — exactly right for short-lived conversation state.
# They're pruned by idle-TTL and a max-count cap so the tmpfs can't fill.
SESSIONS_ROOT = SCRATCH_ROOT / "sessions"
SESSION_TTL_S = int(os.environ.get("SANDBOX_SESSION_TTL_S", str(6 * 3600)))
MAX_SESSIONS = int(os.environ.get("SANDBOX_MAX_SESSIONS", "200"))

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

# Image extensions we treat as "charts" for the autosave fallback.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

# Appended after the user's code so a script that builds matplotlib
# figures but forgets to ``savefig`` still produces visible charts. We
# only kick in when the script saved NO *new* image file itself —
# otherwise an explicit ``plt.savefig('chart.png')`` that leaves the
# figure open would get duplicated as ``figure_1.png``. The ``%r`` is
# the set of images that already existed before this run (non-empty only
# for persistent sessions) so pre-existing charts don't suppress a fresh
# autosave. Wrapped in a broad except so it can never turn a successful
# run into a failure.
_AUTOSAVE_EPILOGUE_TMPL = """

# --- Promptly: auto-save unsaved matplotlib figures (fallback only) ---
try:
    import glob as _glob
    _existing = set(%r)
    _imgs = []
    for _pat in ("*.png", "*.jpg", "*.jpeg", "*.svg", "*.webp", "*.gif"):
        _imgs += _glob.glob(_pat)
    _new = [i for i in _imgs if i not in _existing]
    if not _new:
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
    # Optional persistence key (the backend passes the conversation id).
    # When set, the working directory survives across calls so files
    # created in one run are readable in the next. Absent → throwaway.
    session_id: str | None = None


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


def _safe_session_id(sid: str) -> str:
    """Reduce a session id to a single safe directory name.

    Conversation ids are UUIDs (already safe), but we sanitise defensively
    so a hostile caller can't traverse out of SESSIONS_ROOT. Keep only
    alphanumerics, dash and underscore; bound the length.
    """
    cleaned = "".join(c for c in (sid or "") if c.isalnum() or c in "-_")
    return cleaned[:128] or "default"


def _prune_sessions() -> None:
    """Bound tmpfs use: drop idle sessions past the TTL, then evict the
    oldest if we're still over the count cap. Best-effort — pruning must
    never break a job."""
    try:
        if not SESSIONS_ROOT.exists():
            return
        now = time.time()
        dirs = [p for p in SESSIONS_ROOT.iterdir() if p.is_dir()]
        # TTL sweep (by last-modified — we touch the dir on each use).
        for p in dirs:
            try:
                if now - p.stat().st_mtime > SESSION_TTL_S:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass
        # Count cap — evict oldest beyond MAX_SESSIONS.
        live = [p for p in SESSIONS_ROOT.iterdir() if p.is_dir()]
        if len(live) > MAX_SESSIONS:
            live.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0)
            for p in live[: len(live) - MAX_SESSIONS]:
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def _snapshot(workdir: Path) -> dict[str, tuple[int, int]]:
    """Map of ``name -> (mtime_ns, size)`` for the top-level files in a
    dir. Used to diff a persistent session before/after a run so only
    files created or changed *this* run are returned (reading an existing
    file must not re-emit it)."""
    state: dict[str, tuple[int, int]] = {}
    try:
        for p in workdir.iterdir():
            if p.is_file():
                try:
                    st = p.stat()
                    state[p.name] = (st.st_mtime_ns, st.st_size)
                except OSError:
                    pass
    except OSError:
        pass
    return state


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
def execute(
    req: ExecuteRequest,
    x_sandbox_secret: str = Header(default=""),
) -> ExecuteResponse:
    # Fail CLOSED: if no shared secret is configured, refuse every request
    # rather than silently accepting them. When set, constant-time compare.
    if not SECRET:
        raise HTTPException(
            status_code=503, detail="sandbox not configured for requests"
        )
    if not hmac.compare_digest(x_sandbox_secret, SECRET):
        raise HTTPException(status_code=401, detail="bad sandbox secret")

    if len(req.files) > MAX_INPUT_FILES:
        raise HTTPException(status_code=400, detail="too many input files")

    timeout = req.timeout_s or DEFAULT_TIMEOUT_S
    timeout = max(1, min(timeout, MAX_TIMEOUT_S))

    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)

    # Persistent session vs throwaway job. Persistent dirs survive across
    # calls so the model can build a file in one run and read it in the
    # next; throwaway jobs get a fresh dir wiped in ``finally``.
    persistent = bool(req.session_id)
    if persistent:
        _prune_sessions()
        SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
        workdir = SESSIONS_ROOT / _safe_session_id(req.session_id or "")
        workdir.mkdir(parents=True, exist_ok=True)
        # Bump mtime so idle-TTL pruning treats this as recently used.
        try:
            os.utime(workdir, None)
        except OSError:
            pass
    else:
        workdir = Path(tempfile.mkdtemp(prefix="job-", dir=str(SCRATCH_ROOT)))

    # Snapshot pre-existing files so we only return what THIS run created
    # or changed (a persistent session may already hold files from earlier
    # calls; reading them must not re-emit them).
    pre_state = _snapshot(workdir) if persistent else {}
    pre_images = sorted(
        n for n in pre_state if os.path.splitext(n)[1].lower() in _IMAGE_EXTS
    )
    # Bound before the try so the finally can reference it even if input
    # materialisation raises before the script is written.
    script_name: str | None = None

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
        # Unique per call so two runs sharing a persistent session dir
        # can't clobber each other's source mid-flight.
        script_name = f"_promptly_main_{uuid.uuid4().hex}.py"
        input_names.add(script_name)
        (workdir / script_name).write_text(
            req.code + (_AUTOSAVE_EPILOGUE_TMPL % (pre_images,)),
            encoding="utf-8",
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
        # Popen + communicate (not subprocess.run) so a timeout can SIGKILL
        # the whole process GROUP, not just the immediate child.
        # ``_set_limits`` calls os.setsid() to put the child in its own
        # session/group; on timeout we kill that group so grandchildren the
        # user code forked die too instead of lingering until their own
        # rlimits fire.
        proc = subprocess.Popen(
            [sys.executable, "-I", script_name],
            cwd=str(workdir),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=_set_limits,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            exit_code = proc.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code = None
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()  # fall back to killing just the direct child
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
            stdout = stdout or ""
            stderr = (stderr or "") + (
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
            # In a persistent session, only return files this run created
            # or modified — skip ones carried over unchanged from an
            # earlier call (reading a CSV must not re-attach it).
            if persistent:
                try:
                    st = path.stat()
                except OSError:
                    continue
                if pre_state.get(path.name) == (st.st_mtime_ns, st.st_size):
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
        # Throwaway jobs are wiped immediately; persistent session dirs
        # are kept for the next call and reaped later by _prune_sessions.
        if not persistent:
            shutil.rmtree(workdir, ignore_errors=True)
        elif script_name:
            # Clean up just this run's script so it doesn't accumulate or
            # leak back as an "input" name on the next call's snapshot.
            try:
                (workdir / script_name).unlink(missing_ok=True)
            except OSError:
                pass
