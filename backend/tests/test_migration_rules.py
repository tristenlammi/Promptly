"""Rules every new migration follows (WP-0.2, R-250).

No filesystem side effects: a migration runs inside a database transaction
that can roll back, but a deleted or rewritten file can't — so a failed
migration left the database unchanged and the files gone. Record what to
remove and let a sweeper (``app.files.tombstones``) do it after the commit.

Older migrations are grandfathered; the rule applies from 0168 on.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

VERSIONS = Path(__file__).resolve().parent.parent / "alembic" / "versions"
FIRST_CHECKED = 168
FS_CALLS = {
    "open", "unlink", "rmtree", "remove", "rename", "replace", "rmdir",
    "mkdir", "makedirs", "write_text", "write_bytes", "copy", "copyfile", "move",
}


def _number(path: Path) -> int | None:
    # ``YYYYMMDD_HHMM_NNNN_name.py`` — the third group is the revision number.
    m = re.match(r"\d{8}_\d{4}_(\d{4})_", path.name)
    return int(m.group(1)) if m else None


def test_new_migrations_do_no_filesystem_io():
    offenders = []
    for path in sorted(VERSIONS.glob("*.py")):
        n = _number(path)
        if n is None or n < FIRST_CHECKED:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
            if name in FS_CALLS and not (
                # op.execute("...") / sa.* calls aren't filesystem I/O.
                isinstance(fn, ast.Attribute)
                and isinstance(fn.value, ast.Name)
                and fn.value.id in {"op", "sa", "postgresql"}
            ):
                offenders.append(f"{path.name}:{node.lineno} {name}()")
    assert not offenders, "filesystem I/O in a migration:\n" + "\n".join(offenders)


def test_revision_ids_fit_alembic_version():
    """alembic_version.version_num is varchar(32); longer ids crash-loop boot."""
    too_long = []
    for path in VERSIONS.glob("*.py"):
        m = re.search(r'^revision\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"), re.M)
        if m and len(m.group(1)) > 32:
            too_long.append(f"{path.name}: {m.group(1)}")
    assert not too_long, "\n".join(too_long)
