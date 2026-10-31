"""Small JSON diffs between two states of an item file (RFC 6902 subset).

Saves send a patch against the revision they were made from instead of the
whole file (a deck with years of reviews is megabytes; one answer changes a
few fields). The server answers with the *fix* — the patch from what the
client sent to what was stored after validation (defaults filled in,
derived fields recomputed) — so both sides end on the same state without
sending the file back. Mirrored by ``frontend/src/items/jsonpatch.ts``.
"""
from __future__ import annotations

from typing import Any

# A patch bigger than this many ops isn't worth it — the client sends the
# whole file instead (and the server refuses longer ones).
MAX_OPS = 20_000


def _esc(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def diff(a: Any, b: Any, path: str = "") -> list[dict]:
    """Ops that turn ``a`` into ``b``."""
    ops: list[dict] = []
    _diff(a, b, path, ops)
    return ops


def _diff(a: Any, b: Any, path: str, ops: list[dict]) -> None:
    if a == b:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k not in b:
                ops.append({"op": "remove", "path": f"{path}/{_esc(k)}"})
        for k, v in b.items():
            if k not in a:
                ops.append({"op": "add", "path": f"{path}/{_esc(k)}", "value": v})
            else:
                _diff(a[k], v, f"{path}/{_esc(k)}", ops)
        return
    if isinstance(a, list) and isinstance(b, list):
        # Keep the common start and end; only the middle changed (an entry
        # removed from a 100k-review log is one op, not the whole list).
        n, m = len(a), len(b)
        p = 0
        while p < n and p < m and a[p] == b[p]:
            p += 1
        s = 0
        while s < n - p and s < m - p and a[n - 1 - s] == b[m - 1 - s]:
            s += 1
        am, bm = a[p : n - s], b[p : m - s]
        if len(am) == len(bm):
            for i in range(len(am)):
                _diff(am[i], bm[i], f"{path}/{p + i}", ops)
            return
        common = min(len(am), len(bm))
        for i in range(common):
            _diff(am[i], bm[i], f"{path}/{p + i}", ops)
        if len(am) > len(bm):
            for _ in range(len(am) - common):
                ops.append({"op": "remove", "path": f"{path}/{p + common}"})
        else:
            for i in range(common, len(bm)):
                at = "-" if s == 0 else str(p + i)
                ops.append({"op": "add", "path": f"{path}/{at}", "value": bm[i]})
        return
    ops.append({"op": "replace", "path": path, "value": b} if path else {"op": "replace", "path": "", "value": b})
