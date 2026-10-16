"""Import jobs (WP-10.1) and what an import knew about a file."""
from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

import app.auth.models  # noqa: F401 — users, the FK target, for a bare worker process
from app.database import Base


class ImportJob(Base):
    __tablename__ = "import_jobs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # takeout | folder | apple
    # collecting → indexing → ready (the dry-run report) → importing → done;
    # or failed / cancelled.
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="collecting", server_default="collecting")
    # [{"n": 1, "name": "takeout-001.zip", "size": …, "file": "part-001.zip"}]
    parts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    report: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    progress: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    finished_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FileImportMeta(Base):
    """What an import said about a file that the file doesn't (Takeout's
    JSON beside each photo): read after the file's own metadata."""

    __tablename__ = "file_import_meta"

    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    taken_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Google had it archived: it joins the library archived (WP-10.2).
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("import_jobs.id", ondelete="SET NULL"), nullable=True)


__all__ = ["FileImportMeta", "ImportJob"]
