"""ORM model for admin-configured database connections ("data sources").

A ``DataSource`` is a read-only database connection an admin registers once,
used to back ``kind='dataview'`` workspace items. Credentials are
Fernet-encrypted at rest (same as provider keys / SMTP). Editors never see or
set connection details — they only pick a source and write a ``SELECT`` — so
SSO-style, this never lets a non-admin point the app at an arbitrary host.

Postgres-only for now (``driver='postgres'`` — reuses the bundled asyncpg
driver, no new dependency).
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class DataSource(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "data_sources"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # Only 'postgres' today; the column exists so MySQL/warehouses can slot in
    # later without a migration.
    driver: Mapped[str] = mapped_column(
        String(16), nullable=False, default="postgres", server_default="postgres"
    )
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5432, server_default="5432"
    )
    database: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    # Fernet-encrypted; NULL for a passwordless (trust/peer) connection.
    password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 'disable' | 'require' — mapped to asyncpg's ssl arg. Defaults off since
    # internal DBs on the docker network are the common self-host case.
    sslmode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="disable", server_default="disable"
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return f"<DataSource name={self.name!r} host={self.host!r}>"
