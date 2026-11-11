"""P Maps: your places, where you parked, your timeline, and who can see where
you are. All of it belongs to one person; nothing here is shared unless
``MapShare`` says so."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


class MapPlace(UUIDPKMixin, CreatedAtMixin, Base):
    """A saved place: Home, Work, a favourite, or one on a list of your own."""

    __tablename__ = "map_places"
    __table_args__ = (
        Index("uq_map_places_home_work", "user_id", "kind", unique=True, postgresql_where=text("kind IN ('home', 'work')")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="favourite")  # home | work | favourite | list
    list_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(String(400), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    # What it looks like on the map, as you chose. Empty: the kind's own look.
    icon: Mapped[str | None] = mapped_column(String(24), nullable=True)
    colour: Mapped[str | None] = mapped_column(String(9), nullable=True)


class MapPreferredRoute(UUIDPKMixin, CreatedAtMixin, Base):
    """The way you like to go between two places, even if another is a bit quicker."""

    __tablename__ = "map_preferred_routes"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default="drive")
    from_name: Mapped[str] = mapped_column(String(200), nullable=False)
    from_lat: Mapped[float] = mapped_column(Float, nullable=False)
    from_lon: Mapped[float] = mapped_column(Float, nullable=False)
    to_name: Mapped[str] = mapped_column(String(200), nullable=False)
    to_lat: Mapped[float] = mapped_column(Float, nullable=False)
    to_lon: Mapped[float] = mapped_column(Float, nullable=False)
    # Points it passes through, in order: [{lat, lon, heading}].
    through: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    # Only suggest another way mid-trip if it saves at least this much.
    tolerance_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=10)


class MapRecent(UUIDPKMixin, Base):
    """Somewhere you looked up or went to lately (the newest few are kept)."""

    __tablename__ = "map_recents"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_map_recents_user_key"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(40), nullable=False)  # the rounded position, so a place appears once
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(String(400), nullable=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MapParked(Base):
    """Where you left the car: one spot per person, replaced each time."""

    __tablename__ = "map_parked"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str | None] = mapped_column(String(400), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")  # manual | auto


class MapTrackPoint(Base):
    """One timeline position. Days, stays and drives are worked out from these
    when you look at them, so deleting points really deletes the history."""

    __tablename__ = "map_track_points"
    __table_args__ = (
        UniqueConstraint("user_id", "at", name="uq_map_track_user_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed: Mapped[float | None] = mapped_column(Float, nullable=True)  # metres a second
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="phone")  # phone | google


class MapShare(UUIDPKMixin, CreatedAtMixin, Base):
    """``owner`` lets ``viewer`` see their live location, until ``expires_at``
    (or until they stop it, when that's empty). ``trip``: for one drive only;
    it ends when the phone says the trip has (arrived, or ended), and lapses
    by itself a while after the arrival time if the phone never says."""

    __tablename__ = "map_shares"
    __table_args__ = (UniqueConstraint("owner_id", "viewer_id", name="uq_map_share_pair"),)

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    viewer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trip: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")


class MapLiveLocation(Base):
    """Your latest position while you're sharing it; removed when you stop."""

    __tablename__ = "map_live_locations"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    heading: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    destination: Mapped[str | None] = mapped_column(String(200), nullable=True)
    eta: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MapOfflineArea(UUIDPKMixin, TimestampMixin, Base):
    """An area someone keeps on their phones for when there's no signal: a
    framed view, a route's corridor, or around a place. The squares are the
    server's 1-degree packs; what each phone has actually downloaded is what
    that phone reports in ``devices``."""

    __tablename__ = "map_offline_areas"
    __table_args__ = (CheckConstraint("kind IN ('view', 'route', 'around')", name="ck_map_offline_areas_kind"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    west: Mapped[float] = mapped_column(Float, nullable=False)
    south: Mapped[float] = mapped_column(Float, nullable=False)
    east: Mapped[float] = mapped_column(Float, nullable=False)
    north: Mapped[float] = mapped_column(Float, nullable=False)
    # A route's line (polyline6, simplified to at most 20 KB). Kind "route" only.
    shape: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The squares, as "<west>_<south>" (e.g. "151_-34"). At most 400.
    cells: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    with_addresses: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    # {device_id: {name, state, build, bytes, at}}, as each phone reports.
    devices: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
