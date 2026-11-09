"""The code sandbox's job secret (security review C1, L6).

The sandbox used to get ``SECRET_KEY`` as its job secret, and the model's
code ran as the same uid as the sandbox server, so
``open('/proc/1/environ')`` gave away the key that signs every login.

* The secret is its own value now, with no fallback to ``SECRET_KEY``.
* The backend refuses to use the code tool without a proper one.
* Jobs run as their own unprivileged uid. The container test at the end
  proves it against a real sandbox, when one is reachable (a stack started
  with ``--with sandbox --build-extras``); elsewhere it's skipped.
"""
from __future__ import annotations

import os

import httpx
import pytest

from app.config import Settings

_KEY = "k" * 64
_GOOD = "s" * 64


def _settings(**kw) -> Settings:
    base = {"SECRET_KEY": _KEY, "DOMAIN": "promptly.example.com", "DATABASE_URL": "postgresql+asyncpg://u:strong@db/x"}
    base.update(kw)
    return Settings(**base)


def test_the_sandbox_secret_never_falls_back_to_secret_key():
    s = _settings(CODE_SANDBOX_SECRET="")
    assert s.CODE_SANDBOX_SECRET == ""
    assert "isn't set" in (s.code_sandbox_secret_problem() or "")


@pytest.mark.parametrize(
    "value, words",
    [
        ("", "isn't set"),
        ("change-me-generate-with-openssl-rand-hex-32", "placeholder"),
        (_KEY, "same as SECRET_KEY"),
        ("short", "too short"),
    ],
)
def test_a_bad_sandbox_secret_turns_the_code_tool_off(value, words):
    problem = _settings(CODE_SANDBOX_SECRET=value).code_sandbox_secret_problem()
    assert problem and words in problem
    assert "update.sh" in problem  # tells the admin what to do


def test_a_proper_sandbox_secret_is_used():
    assert _settings(CODE_SANDBOX_SECRET=_GOOD).code_sandbox_secret_problem() is None


async def test_the_code_tool_refuses_without_a_secret(monkeypatch):
    from app.chat import sandbox_exec

    monkeypatch.setattr(sandbox_exec, "get_settings", lambda: _settings(CODE_SANDBOX_SECRET=_KEY))
    with pytest.raises(sandbox_exec.SandboxNotConfigured, match="SECRET_KEY"):
        await sandbox_exec.run_python_in_sandbox(
            None, user=None, code="print(1)", input_files=[], persist_outputs=False
        )


@pytest.mark.parametrize("name", ["TUS_HOOK_SECRET", "CODE_SANDBOX_SECRET"])
def test_placeholder_shared_secrets_are_refused_at_boot(name):
    errors = _settings(**{name: "change-me-generate-with-openssl-rand-hex-32"}).validate_boot_safety()
    assert any(name in e for e in errors)


def test_unset_shared_secrets_dont_stop_boot():
    # An install updated by an older update.sh may not have them yet: the
    # code tool is off and tus hooks refuse, but Promptly starts.
    assert _settings(TUS_HOOK_SECRET=None, CODE_SANDBOX_SECRET="").validate_boot_safety() == []


# ------------------------------------------------------ a real sandbox

_PROBE = r'''
import json, os
out = {"uid": os.getuid(), "env_has_secret": "SANDBOX_SECRET" in os.environ}
# Only yes/no comes back: a failing run must never print the secret.
try:
    open("/proc/1/environ", "rb").read()
    out["proc1_readable"] = True
except Exception:
    out["proc1_readable"] = False
leaks = []
for pid in os.listdir("/proc"):
    if pid.isdigit() and int(pid) != os.getpid():
        try:
            if b"SANDBOX_SECRET" in open(f"/proc/{pid}/environ", "rb").read():
                leaks.append(pid)
        except Exception:
            pass
out["leaks"] = leaks
for line in open("/proc/self/status"):
    if line.startswith("CapEff:"):
        out["capeff"] = line.split()[1]
os.symlink("/proc/1/environ", "leak.txt")
os.symlink("/proc/1/environ", "leak.png")
print(json.dumps(out))
'''


def _sandbox() -> tuple[str, str] | None:
    url = (os.environ.get("CODE_SANDBOX_URL") or "").rstrip("/")
    secret = (os.environ.get("CODE_SANDBOX_SECRET") or "").strip()
    if not url or not secret:
        return None
    try:
        health = httpx.get(f"{url}/health", timeout=3)
        if health.status_code != 200:
            return None
        if health.json().get("jobs") != "separate-user":
            # An image from before the fix (the main stack before it's
            # rebuilt): this test is about the fixed sandbox.
            return None
    except httpx.HTTPError:
        return None
    return url, secret


def test_user_code_cant_read_the_sandbox_secret():
    found = _sandbox()
    if found is None:
        pytest.skip("no fixed sandbox reachable (run in a stack with --with sandbox --build-extras)")
    url, secret = found
    import json

    r = httpx.post(
        f"{url}/execute",
        json={"code": _PROBE, "files": []},
        headers={"X-Sandbox-Secret": secret},
        timeout=60,
    )
    assert r.status_code == 200
    body = r.json()
    assert secret not in r.text, "the secret came back from the sandbox"
    assert body["exit_code"] == 0, body["stderr"][-500:]
    out = json.loads(body["stdout"].strip().splitlines()[-1])
    assert out["proc1_readable"] is False, "the job could read the server's environment"
    assert out["leaks"] == []
    assert out["env_has_secret"] is False
    assert out["uid"] not in (0, 10001)
    assert int(out["capeff"], 16) == 0
    # A link the job left behind is never read back by the server.
    assert all(o["name"] not in ("leak.txt", "leak.png") for o in body["outputs"])
