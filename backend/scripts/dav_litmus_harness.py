"""A throwaway WebDAV server for the litmus suite (WP-8.4).

litmus names its files ``res``, ``frag``, ``litmus`` — no extension — which
the upload allowlist (rightly) refuses. This runs the real backend against
a scratch database with only that check relaxed, so litmus measures the
protocol, not the file-type policy. Never point it at real data.

    DATABASE_URL=.../promptly_litmus python scripts/dav_litmus_harness.py
    litmus http://<host>:8765/dav/ litmus <password printed at start>

Prints the app password on stdout's first line (``LITMUS_PASSWORD=...``).
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("PROMPTLY_UPLOAD_ROOT", tempfile.mkdtemp(prefix="litmus-uploads-"))
os.environ["RATE_LIMIT_ENABLED"] = "false"
if not os.environ.get("SECRET_KEY"):
    import secrets

    os.environ["SECRET_KEY"] = secrets.token_urlsafe(48)


def _relax_allowlist() -> None:
    from app.files import router, safety

    def allow_all(filename: str) -> bool:
        return True

    def any_bytes(path, *, declared_filename, declared_mime):  # noqa: ANN001, ARG001
        return "application/octet-stream"

    safety.is_extension_allowed = allow_all
    router.sniff_and_validate = any_bytes


async def _prepare() -> str:
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import select

    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash
    from app.auth.models import User
    from app.database import SessionLocal

    cfg = Config(str(Path(__file__).resolve().parent.parent / "alembic.ini"))
    await asyncio.to_thread(command.upgrade, cfg, "head")
    async with SessionLocal() as db:
        user = (await db.execute(select(User).where(User.username == "litmus"))).scalar_one_or_none()
        if user is None:
            user = User(email="litmus@example.invalid", username="litmus", password_hash="x", role="user")
            db.add(user)
            await db.commit()
            await db.refresh(user)
        token = new_token()
        db.add(AppPassword(user_id=user.id, name="litmus", token_hash=token_hash(token), hint=hint(token),
                           scopes=["dav:read", "dav:write"]))
        await db.commit()
    return token


def main() -> None:
    import uvicorn

    if "litmus" not in os.environ.get("DATABASE_URL", ""):
        sys.exit("Refusing: DATABASE_URL must name a scratch database with 'litmus' in its name.")
    _relax_allowlist()
    token = asyncio.run(_prepare())
    print(f"LITMUS_PASSWORD={token}", flush=True)
    from app.main import app

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8765")), log_level="warning")


if __name__ == "__main__":
    main()
