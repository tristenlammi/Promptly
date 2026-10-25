"""The photo library's own rows (WP-9.1). Photos stay ordinary files; this
is what the timeline needs to be fast: who owns it, when it was taken, and
whether it's archived."""
from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, SmallInteger, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

import app.auth.models  # noqa: F401 — users, the FK target, for a bare worker process
from app.database import Base


class PhotoAsset(Base):
    __tablename__ = "photo_assets"

    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # image | video
    # The instant it was taken, and the clock on the wall where it was taken
    # — which orders the timeline and decides its days (a trip abroad reads
    # in the order it happened).
    taken_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    taken_local: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    # The MOV half of a Live Photo: shown behind its still, not on its own.
    live_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    # A copy of a photo already in the library (a phone synced after a
    # Takeout): hidden from Photos, its file kept (0227, photos/duplicates).
    duplicate_of: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    archived_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    # What understanding found (PH-2): the nearest GeoNames place, and how
    # good it is — a 64-bit perceptual hash (near-duplicates), sharpness
    # and brightness (0–1), and a 0–1 score from both.
    place_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    phash: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sharpness: Mapped[float | None] = mapped_column(Float, nullable=True)
    brightness: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (
        Index("ix_photo_assets_timeline", "user_id", text("taken_local DESC"), text("file_id DESC")),
        Index("ix_photo_assets_place", "user_id", "place_id"),
    )


class PhotoUnderstanding(Base):
    """One stage of understanding one photo (PH-2): done at which version,
    from which input (a changed location re-runs ``place``), or failed."""

    __tablename__ = "photo_understanding"

    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    stage: Mapped[str] = mapped_column(String(16), primary_key=True)
    version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    state: Mapped[str] = mapped_column(String(8), nullable=False)
    input_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default=text("0"))
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint("state IN ('done', 'failed', 'skipped')", name="ck_photo_understanding_state"),
        Index("ix_photo_understanding_stage", "stage", "version"),
    )


class GeoPlace(Base):
    """A GeoNames populated place (CC BY 4.0)."""

    __tablename__ = "geo_places"

    geonameid: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    ascii_name: Mapped[str] = mapped_column(String(200), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    feature_code: Mapped[str] = mapped_column(String(10), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    admin1: Mapped[str] = mapped_column(String(20), nullable=False, default="", server_default="")
    population: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    timezone: Mapped[str | None] = mapped_column(String(40), nullable=True)


class GeoAdmin1(Base):
    __tablename__ = "geo_admin1"

    code: Mapped[str] = mapped_column(String(30), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)


class GeoCountry(Base):
    __tablename__ = "geo_countries"

    code: Mapped[str] = mapped_column(String(2), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)


__all__ = ["GeoAdmin1", "GeoCountry", "GeoPlace", "PhotoAsset", "PhotoUnderstanding"]
