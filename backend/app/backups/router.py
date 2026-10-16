"""Admin → Backups: what's been backed up, and "Back up now" (WP-0.2)."""
from __future__ import annotations

import shutil
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.backups.models import BackupRun
from app.backups.service import BACKUP_DIR, KEEP, run_backup
from app.database import get_db

router = APIRouter()


class BackupRunOut(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    filename: str | None
    size_bytes: int | None
    revision: str | None
    error: str | None
    detail: str | None = None
    created_at: datetime
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class BackupsOverview(BaseModel):
    last_success: BackupRunOut | None
    last_failure: BackupRunOut | None
    runs: list[BackupRunOut]
    keep_nightly: int
    # Where the dumps are, relative to the install directory.
    location: str
    disk_free_bytes: int | None
    # Deleted files still on disk for their 14-day recovery window.
    pending_deletion_count: int
    pending_deletion_bytes: int
    offsite: "OffsiteOverview"


class OffsiteOverview(BaseModel):
    """Off-site backup (WP-2.3). Never carries a secret."""

    enabled: bool
    target_kind: str
    location: str
    credentials_set: list[str]
    hour: int
    keep_daily: int
    keep_weekly: int
    keep_monthly: int
    restore_test_enabled: bool
    healthy: bool
    warning: str | None
    last_copy: BackupRunOut | None
    last_copy_ok: BackupRunOut | None
    last_check: BackupRunOut | None
    last_restore_test: BackupRunOut | None


class OffsiteUpdate(BaseModel):
    enabled: bool | None = None
    target_kind: str | None = Field(default=None, max_length=16)
    location: str | None = Field(default=None, max_length=1000)
    # Only the keys sent are changed; "" clears one. Never echoed back.
    credentials: dict[str, str] | None = None
    hour: int | None = Field(default=None, ge=0, le=23)
    keep_daily: int | None = Field(default=None, ge=1, le=365)
    keep_weekly: int | None = Field(default=None, ge=0, le=520)
    keep_monthly: int | None = Field(default=None, ge=0, le=240)
    restore_test_enabled: bool | None = None


_CREDENTIAL_KEYS = {
    "folder": set(),
    "s3": {"access_key_id", "secret_access_key", "region"},
    "sftp": {"private_key"},
    "rest": {"username", "password"},
}
_DUMP_KINDS = ("nightly", "pre_migrate", "manual")


@router.get("/backups", response_model=BackupsOverview)
async def backups_overview(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> BackupsOverview:
    from app.files.tombstones import pending_summary

    runs = list(
        (await db.execute(select(BackupRun).order_by(BackupRun.created_at.desc()).limit(30)))
        .scalars()
        .all()
    )
    dumps = [r for r in runs if r.kind in _DUMP_KINDS]
    ok = next((r for r in dumps if r.status == "ok"), None)
    if ok is None:
        ok = (
            await db.execute(
                select(BackupRun).where(BackupRun.status == "ok", BackupRun.kind.in_(_DUMP_KINDS))
                .order_by(BackupRun.created_at.desc()).limit(1)
            )
        ).scalar_one_or_none()
    failed = next((r for r in dumps if r.status == "failed"), None)
    try:
        free = shutil.disk_usage(BACKUP_DIR).free
    except OSError:
        free = None
    count, size = await pending_summary(db)
    return BackupsOverview(
        last_success=ok,
        last_failure=failed,
        runs=runs,
        keep_nightly=KEEP["nightly"],
        location="data/backups",
        disk_free_bytes=free,
        pending_deletion_count=count,
        pending_deletion_bytes=size,
        offsite=await _offsite_overview(db),
    )


async def _offsite_overview(db: AsyncSession) -> OffsiteOverview:
    from app.backups.offsite import credentials, load_config, status as offsite_status

    cfg = await load_config(db)
    st = await offsite_status(db)
    await db.commit()
    return OffsiteOverview(
        enabled=cfg.enabled,
        target_kind=cfg.target_kind,
        location=cfg.location,
        credentials_set=sorted(credentials(cfg)),
        hour=cfg.hour,
        keep_daily=cfg.keep_daily,
        keep_weekly=cfg.keep_weekly,
        keep_monthly=cfg.keep_monthly,
        restore_test_enabled=cfg.restore_test_enabled,
        healthy=st.healthy,
        warning=st.warning,
        last_copy=st.last_copy,
        last_copy_ok=st.last_copy_ok,
        last_check=st.last_check,
        last_restore_test=st.last_restore_test,
    )


@router.put("/backups/offsite", response_model=OffsiteOverview)
async def update_offsite(
    payload: OffsiteUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> OffsiteOverview:
    """Choose where off-site copies go and when (WP-2.3)."""
    from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
    from app.backups.offsite import TARGETS, credentials, load_config, set_credentials

    cfg = await load_config(db)
    fields = payload.model_fields_set
    if payload.target_kind is not None:
        if payload.target_kind not in TARGETS:
            raise HTTPException(status_code=400, detail="Unknown target type.")
        if payload.target_kind != cfg.target_kind:
            # Credentials belong to the old target.
            cfg.credentials_encrypted = None
        cfg.target_kind = payload.target_kind
    if payload.location is not None:
        cfg.location = payload.location.strip()
    if payload.credentials is not None:
        allowed = _CREDENTIAL_KEYS[cfg.target_kind]
        merged = credentials(cfg)
        for key, value in payload.credentials.items():
            if key in allowed:
                merged[key] = value
        set_credentials(cfg, merged)
    for name in ("enabled", "hour", "keep_daily", "keep_weekly", "keep_monthly", "restore_test_enabled"):
        if name in fields and getattr(payload, name) is not None:
            setattr(cfg, name, getattr(payload, name))
    if cfg.enabled and cfg.target_kind != "folder" and not cfg.location:
        raise HTTPException(status_code=400, detail="Say where the copies should go first.")
    await record_event(
        db, event_type=EVENT_APP_SETTINGS_CHANGED, user_id=actor.id, identifier=actor.username,
        detail=safe_dict({"offsite_backup": {k: v for k, v in payload.model_dump(exclude_unset=True).items() if k != "credentials"}}),
    )
    await db.commit()
    return await _offsite_overview(db)


@router.post("/backups/offsite/test")
async def test_offsite(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict:
    """Reach the target with the saved settings — creating the repository
    if it's empty — and say what's there."""
    from app.backups.offsite import OffsiteError, load_config, test_target

    cfg = await load_config(db)
    try:
        result = await test_target(cfg)
    except OffsiteError as e:
        await db.commit()  # keep a newly generated repository password
        return {"ok": False, "error": str(e)}
    await db.commit()
    return result


@router.post("/backups/offsite/{action}", status_code=status.HTTP_202_ACCEPTED)
async def offsite_action(
    action: str,
    background: BackgroundTasks,
    _: User = Depends(require_admin),
) -> dict:
    """Copy now, check the copies, or run a trial restore, in the
    background; the card polls the overview for the result."""
    from app.backups.offsite import run_check, run_offsite, run_restore_test

    jobs = {"run": run_offsite, "check": run_check, "restore-test": run_restore_test}
    if action not in jobs:
        raise HTTPException(status_code=404, detail="Unknown action")
    background.add_task(jobs[action])
    return {"ok": True}


@router.post("/backups/run", status_code=status.HTTP_202_ACCEPTED)
async def backup_now(
    background: BackgroundTasks,
    _: User = Depends(require_admin),
) -> dict:
    """Start a manual dump; the card polls the overview for the result."""
    background.add_task(run_backup, "manual")
    return {"ok": True}


__all__ = ["router"]


BackupsOverview.model_rebuild()
