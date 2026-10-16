"""Break-glass commands, run inside the backend container.

    docker compose exec backend python -m app.cli reset-mfa <email-or-username>
    docker compose exec -T backend python -m app.cli recovery-kit > recovery-kit.txt
    docker compose exec backend python -m app.cli versions list <file-id>
    docker compose exec backend python -m app.cli versions recover <version-id>

For when nobody can sign in to reset it from the admin panel — the only
admin lost their phone, or SECRET_KEY changed without SECRET_KEY_PREVIOUS
(R-138).

``versions`` lists a document, sheet or whiteboard's saved snapshots and
recovers one as a copy next to the original ("<name> (recovered …)") — the
way back from a blanked or vandalised file until the restore UI (WP-3.3).
The file id is in its Files URL or details pane.
"""
from __future__ import annotations

import asyncio
import sys

from sqlalchemy import func, or_, select


async def _reset_mfa(who: str) -> int:
    from app.auth.audit import EVENT_MFA_RESET, record_event, safe_dict
    from app.auth.models import User
    from app.database import SessionLocal
    from app.mfa.service import disable_for_user

    async with SessionLocal() as db:
        user = (
            await db.execute(
                select(User).where(
                    or_(func.lower(User.email) == who.lower(), func.lower(User.username) == who.lower())
                )
            )
        ).scalar_one_or_none()
        if user is None:
            print(f"No user called {who!r}.")
            return 1
        await disable_for_user(db, user=user)
        await record_event(
            db, event_type=EVENT_MFA_RESET, user_id=user.id, identifier=user.username,
            detail=safe_dict({"by": "cli"}),
        )
        await db.commit()
        print(f"Two-step verification is off for {user.username}; they'll be asked to sign in again.")
        return 0


async def _recovery_kit() -> int:
    from app.backups.offsite import load_config, recovery_kit_text
    from app.database import SessionLocal

    async with SessionLocal() as db:
        cfg = await load_config(db)
        sys.stdout.write(recovery_kit_text(cfg))
        await db.commit()
    return 0


async def _versions_list(file_id: str) -> int:
    import uuid

    from app.database import SessionLocal
    from app.files.models import FileVersion, UserFile

    try:
        fid = uuid.UUID(file_id)
    except ValueError:
        print(f"{file_id!r} isn't a file id.")
        return 2
    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        if row is None:
            print("No such file.")
            return 1
        versions = (
            await db.execute(
                select(FileVersion).where(FileVersion.file_id == fid).order_by(FileVersion.created_at.desc())
            )
        ).scalars().all()
        print(f"{row.filename} — {len(versions)} version(s), newest first:")
        for v in versions:
            label = f"  “{v.label}”" if v.label else ""
            print(
                f"  {v.id}  {v.created_at:%Y-%m-%d %H:%M}  {v.source:<12} "
                f"{v.size_bytes:>9} B{label}"
            )
    return 0


async def _versions_recover(version_id: str) -> int:
    import uuid

    from app.database import SessionLocal
    from app.files.models import FileVersion
    from app.files.versions import recover_as_copy

    try:
        vid = uuid.UUID(version_id)
    except ValueError:
        print(f"{version_id!r} isn't a version id.")
        return 2
    async with SessionLocal() as db:
        v = await db.get(FileVersion, vid)
        if v is None:
            print("No such version.")
            return 1
        try:
            copy = await recover_as_copy(db, v)
        except ValueError as exc:
            print(f"Couldn't recover it: {exc}")
            return 1
        await db.commit()
        print(f"Recovered as “{copy.filename}” ({copy.id}), next to the original.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "reset-mfa":
        return asyncio.run(_reset_mfa(argv[1]))
    if argv == ["recovery-kit"]:
        return asyncio.run(_recovery_kit())
    if len(argv) == 3 and argv[:2] == ["versions", "list"]:
        return asyncio.run(_versions_list(argv[2]))
    if len(argv) == 3 and argv[:2] == ["versions", "recover"]:
        return asyncio.run(_versions_recover(argv[2]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
