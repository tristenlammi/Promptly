"""Off-site backup with restic, end to end against a folder target (WP-2.3).

Uses the real restic in the image and the test database, so a passing run
means a copy was made, retention ran, and a trial restore brought the
database back into a scratch database.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from sqlalchemy import select

from app.backups import offsite, service

pytestmark = pytest.mark.skipif(shutil.which("restic") is None, reason="restic not installed")


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    backups = tmp_path / "backups"
    uploads = tmp_path / "uploads"
    target = tmp_path / "offsite"
    for d in (backups, uploads, target):
        d.mkdir()
    (uploads / "u_1").mkdir()
    (uploads / "u_1" / "photo.jpg").write_bytes(b"not really a photo" * 100)
    (uploads / "u_1" / "derived").mkdir()
    (uploads / "u_1" / "derived" / "thumb.jpg").write_bytes(b"rebuildable")
    monkeypatch.setattr(service, "BACKUP_DIR", backups)
    monkeypatch.setattr(offsite, "BACKUP_DIR", backups)
    monkeypatch.setattr(offsite, "OFFSITE_ROOT", target)
    monkeypatch.setattr(offsite, "BACKUP_PATHS", [str(backups), str(uploads)])
    return backups, uploads, target


async def _configure(db, **kw):
    cfg = await offsite.load_config(db)
    cfg.enabled = True
    cfg.target_kind = "folder"
    cfg.location = "promptly"
    for k, v in kw.items():
        setattr(cfg, k, v)
    await db.commit()
    return cfg


async def _runs(db, kind):
    from app.backups.models import BackupRun

    db.expire_all()
    return (await db.execute(select(BackupRun).where(BackupRun.kind == kind))).scalars().all()


async def test_not_configured_reads_as_not_a_real_backup(db):
    st = await offsite.status(db)
    assert not st.healthy and "Not a real backup yet" in st.warning


async def test_testing_the_target_creates_the_repository(db, dirs):
    cfg = await _configure(db)
    result = await offsite.test_target(cfg)
    assert result == {"ok": True, "created": True, "snapshots": 0, "latest": None}
    assert (dirs[2] / "promptly" / "config").exists()


async def test_a_copy_is_made_and_restores(db, user, dirs, monkeypatch):
    alerts: list = []

    async def _alert(_db, title, body):
        alerts.append(title)

    monkeypatch.setattr(offsite, "_alert_admins", _alert)
    await _configure(db)

    await offsite.run_offsite()
    (copy,) = await _runs(db, "offsite")
    assert copy.status == "ok", copy.error
    assert alerts == []

    cfg = await offsite.load_config(db)
    code, out, _err = await offsite._restic(cfg, ["ls", "latest", "--json"])
    paths = [json.loads(line).get("path", "") for line in out.splitlines() if line.strip()]
    assert any(p.endswith("photo.jpg") for p in paths)
    assert not any("derived" in p for p in paths)  # rebuildable, not copied
    assert any(p.endswith("promptly-config.json") for p in paths)
    assert any(p.endswith(".dump") for p in paths)  # a fresh dump was taken first

    await offsite.run_restore_test()
    (test,) = await _runs(db, "restore_test")
    assert test.status == "ok", test.error
    assert "users" in (test.detail or "")


async def test_a_failed_copy_alerts_admins(db, dirs, monkeypatch):
    alerts: list = []

    async def _alert(_db, title, body):
        alerts.append(title)

    monkeypatch.setattr(offsite, "_alert_admins", _alert)
    await _configure(db, target_kind="rest", location="http://127.0.0.1:9/nowhere")

    await offsite.run_offsite()

    (copy,) = await _runs(db, "offsite")
    assert copy.status == "failed" and copy.error
    assert alerts == ["Off-site backup failed"]


async def test_the_recovery_kit_has_what_a_restore_needs(db, dirs):
    cfg = await _configure(db)
    offsite.repo_password(cfg)
    kit = offsite.recovery_kit_text(cfg)
    assert "Repository password" in kit and "SECRET_KEY=" in kit
    assert str(Path(dirs[2]) / "promptly") in kit
