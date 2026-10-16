"""Database backups: dumps that restore, failures that get noticed (WP-0.2)."""
from __future__ import annotations

import os
import time

import pytest
from sqlalchemy import select

from app.backups import service
from app.backups.models import BackupRun


@pytest.fixture
def backup_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "BACKUP_DIR", tmp_path)
    return tmp_path


@pytest.mark.asyncio
async def test_manual_backup_writes_a_restorable_dump(db, backup_dir):
    run = await service.run_backup("manual")

    assert run.status == "ok", run.error
    dump = backup_dir / run.filename
    assert dump.exists() and dump.stat().st_size == run.size_bytes > 0
    # A custom-format dump pg_restore can read.
    code, listing = await service._run(["pg_restore", "--list", str(dump)], dict(os.environ), 60)
    assert code == 0 and "TABLE" in listing
    assert not list(backup_dir.glob("*.partial"))


@pytest.mark.asyncio
async def test_a_failed_backup_is_recorded_and_alerts_admins(db, backup_dir, monkeypatch):
    alerts = []

    async def fake_alert(_db, title, body):
        alerts.append((title, body))

    async def wrong_client():
        return 99

    monkeypatch.setattr(service, "_alert_admins", fake_alert)
    monkeypatch.setattr(service, "client_major", wrong_client)

    run = await service.run_backup("nightly")

    assert run.status == "failed" and "doesn't match" in run.error
    assert alerts and alerts[0][0] == "Database backup failed"
    rows = (await db.execute(select(BackupRun))).scalars().all()
    assert [r.status for r in rows] == ["failed"]


def test_old_nightly_dumps_are_pruned(backup_dir):
    for i in range(20):
        p = backup_dir / f"nightly-2026{i:04d}.dump"
        p.write_bytes(b"x")
        os.utime(p, (time.time() - 1000 + i, time.time() - 1000 + i))
    (backup_dir / "pre-migrate-keepme.dump").write_bytes(b"x")

    service._prune("nightly")

    left = sorted(p.name for p in backup_dir.glob("nightly-*.dump"))
    assert len(left) == 14 and left[-1] == "nightly-20260019.dump"
    assert (backup_dir / "pre-migrate-keepme.dump").exists()
