"""Cleaning an email's HTML with a time limit. bleach can't be stopped part way, and
some HTML a stranger can send takes it minutes, so it runs in a child process that
is killed if it takes too long; the email then shows as plain text.

``parse.html_fits`` turns away the plainly hostile first, without starting anything.
The children are kept and reused, a few at most; one that's killed is replaced the
next time it's needed. Run as ``python -m app.mail.clean`` it is the child."""
from __future__ import annotations

import atexit
import json
import logging
import os
import select
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("promptly.mail.clean")

# A 256 KB newsletter cleans in about 0.15 s and the slowest real-looking email
# measured (256 KB from Outlook) in 0.35 s, so this leaves room for a slow or busy
# server while capping what one hostile email can cost.
TIMEOUT = 3.0
STARTUP_TIMEOUT = 30.0  # a child's first imports, not counted against an email
MAX_IDLE = 2
_ROOT = Path(__file__).resolve().parents[2]  # the folder holding ``app``
_HEADER = struct.Struct(">Q")

_idle: list["_Child"] = []
_lock = threading.Lock()


def _encode(value: Any) -> bytes:
    # A badly encoded email can hold lone surrogates; they go through as they are.
    body = json.dumps(value, ensure_ascii=False).encode("utf-8", "surrogatepass")
    return _HEADER.pack(len(body)) + body


def _decode(body: bytes) -> Any:
    return json.loads(body.decode("utf-8", "surrogatepass"))


class _Child:
    def __init__(self) -> None:
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(_ROOT), os.environ.get("PYTHONPATH", "")]))}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "app.mail.clean"], cwd=_ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, close_fds=True,
        )
        if self._read(time.monotonic() + STARTUP_TIMEOUT) != "ready":
            self.kill()
            raise RuntimeError("the HTML cleaner didn't start")

    def alive(self) -> bool:
        return self.proc.poll() is None

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                pipe.close()  # type: ignore[union-attr]
            except OSError:
                pass

    def _read_exactly(self, size: int, deadline: float) -> bytes | None:
        out = self.proc.stdout
        fd = out.fileno()  # type: ignore[union-attr]
        chunks: list[bytes] = []
        while size:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                return None
            chunk = os.read(fd, min(size, 1 << 20))
            if not chunk:
                return None  # it died
            chunks.append(chunk)
            size -= len(chunk)
        return b"".join(chunks)

    def _read(self, deadline: float) -> Any:
        header = self._read_exactly(_HEADER.size, deadline)
        if header is None:
            return None
        body = self._read_exactly(_HEADER.unpack(header)[0], deadline)
        return None if body is None else _decode(body)

    def ask(self, raw: str, inline: dict[str, str], timeout: float) -> str | None:
        deadline = time.monotonic() + timeout
        try:
            self.proc.stdin.write(_encode([raw, inline]))  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except OSError:
            return None
        try:
            answer = self._read(deadline)
        except (OSError, ValueError):
            return None
        return answer.get("html") if isinstance(answer, dict) else None


def _checkout() -> _Child:
    with _lock:
        while _idle:
            child = _idle.pop()
            if child.alive():
                return child
            child.kill()
    return _Child()


def _checkin(child: _Child) -> None:
    with _lock:
        if len(_idle) < MAX_IDLE:
            _idle.append(child)
            return
    child.kill()


def safe_html_in_time(raw: str, inline: dict[str, str] | None = None, timeout: float | None = None) -> str | None:
    """``parse.safe_html`` in a child process, or None if it took too long or failed.
    Blocks the calling thread (never the event loop: call it from a thread)."""
    try:
        child = _checkout()
    except (OSError, RuntimeError) as e:
        logger.warning("Couldn't start the HTML cleaner: %s", type(e).__name__)
        return None
    cleaned = child.ask(raw, inline or {}, TIMEOUT if timeout is None else timeout)
    if cleaned is None:
        logger.warning("Gave up cleaning an email's HTML (%d characters); it shows as plain text", len(raw))
        child.kill()
        return None
    _checkin(child)
    return cleaned


def shutdown() -> None:
    with _lock:
        children, _idle[:] = list(_idle), []
    for child in children:
        child.kill()


# A child also stops by itself when the app goes, as its input closes.
atexit.register(shutdown)


def _serve() -> None:
    # Answers go out on the real stdout; anything printed by accident goes to stderr.
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    source = sys.stdin.buffer
    from app.mail import parse

    def send(value: Any) -> None:
        out.write(_encode(value))
        out.flush()

    send("ready")
    while True:
        header = source.read(_HEADER.size)
        if len(header) < _HEADER.size:
            return  # the app has gone, or let this one go
        raw, inline = _decode(source.read(_HEADER.unpack(header)[0]))
        try:
            send({"html": parse.safe_html(raw, inline)})
        except Exception as e:  # noqa: BLE001 — the app falls back to plain text
            send({"error": type(e).__name__})


if __name__ == "__main__":
    _serve()
