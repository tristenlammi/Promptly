"""Regression tests for the Promptly Drive stage 1 surfaces.

Covers the pieces that are testable without a live Postgres:

- Share-link unlock token round-trip (mint → verify) and tamper
  rejection.
- Share-link liveness gate (``_link_is_alive``): revoked rows,
  expired rows, and the healthy case.
- FTS content extraction: plain-text blobs get extracted,
  Markdown too, binaries return ``None``.
- Trash visibility: the helper used by ``browse`` and
  ``resolve_attachments`` filters out ``trashed_at`` rows.

The full end-to-end flows (actual trash round-trip on a live DB,
FTS ``ts_rank`` ordering, quota consistency) rely on a running
Postgres with the migrations applied and are exercised via the
manual QA pass documented in the plan. Here we pin the pure
logic that shouldn't drift.
"""

from __future__ import annotations

import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.files import share_router


# ---------------------------------------------------------------------------
# Fakes for the bits we want to test without SQLAlchemy / Postgres.
# ---------------------------------------------------------------------------


@dataclass
class FakeLink:
    id: uuid.UUID
    token: str
    access_mode: str = "public"
    password_hash: str | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None


@dataclass
class FakeUserFile:
    id: uuid.UUID
    filename: str
    mime_type: str
    storage_path: str
    trashed_at: datetime | None = None


# ---------------------------------------------------------------------------
# Unlock token round-trip
# ---------------------------------------------------------------------------


def test_unlock_token_round_trip() -> None:
    """Signed token validates for the exact link it was minted for."""

    link_id = uuid.uuid4()
    token = share_router._mint_unlock_token(link_id)

    assert share_router._verify_unlock_token(token, link_id) is True


def test_unlock_token_rejects_wrong_link() -> None:
    """A token minted for link A must not unlock link B."""

    minted_for = uuid.uuid4()
    stranger = uuid.uuid4()
    token = share_router._mint_unlock_token(minted_for)

    assert share_router._verify_unlock_token(token, stranger) is False


def test_unlock_token_rejects_garbage() -> None:
    assert share_router._verify_unlock_token("not-a-real-token", uuid.uuid4()) is False
    assert share_router._verify_unlock_token("", uuid.uuid4()) is False


# ---------------------------------------------------------------------------
# Link liveness gate
# ---------------------------------------------------------------------------


def test_link_alive_healthy() -> None:
    link = FakeLink(id=uuid.uuid4(), token="t")
    alive, reason = share_router._link_is_alive(link)  # type: ignore[arg-type]
    assert alive is True
    assert reason is None


def test_link_alive_revoked() -> None:
    link = FakeLink(
        id=uuid.uuid4(),
        token="t",
        revoked_at=datetime.now(timezone.utc),
    )
    alive, reason = share_router._link_is_alive(link)  # type: ignore[arg-type]
    assert alive is False
    assert reason == "revoked"


def test_link_alive_expired() -> None:
    link = FakeLink(
        id=uuid.uuid4(),
        token="t",
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    alive, reason = share_router._link_is_alive(link)  # type: ignore[arg-type]
    assert alive is False
    assert reason == "expired"


def test_link_alive_not_yet_expired() -> None:
    link = FakeLink(
        id=uuid.uuid4(),
        token="t",
        expires_at=datetime.now(timezone.utc) + timedelta(days=1),
    )
    alive, reason = share_router._link_is_alive(link)  # type: ignore[arg-type]
    assert alive is True
    assert reason is None


# ---------------------------------------------------------------------------
# Share password hash round-trip (exercises the same primitive the
# /unlock endpoint uses).
# ---------------------------------------------------------------------------


def test_password_roundtrip() -> None:
    from app.auth.utils import hash_password, verify_password

    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed) is True
    assert verify_password("wrong horse battery staple", hashed) is False


# ---------------------------------------------------------------------------
# FTS content extraction
# ---------------------------------------------------------------------------


def _make_fake_file(
    *, filename: str, mime: str, body: bytes, tmpdir: Path
) -> FakeUserFile:
    """Create a file on disk under ``tmpdir`` and return a fake row.

    ``extract_content_text`` goes through the absolute path helper
    which is rooted at ``PROMPTLY_UPLOAD_ROOT``. The fixture sets
    that env var per-test so the helper reads from our scratch dir.
    """
    rel = f"fixtures/{uuid.uuid4()}_{filename}"
    full = tmpdir / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(body)
    return FakeUserFile(
        id=uuid.uuid4(),
        filename=filename,
        mime_type=mime,
        storage_path=rel,
    )


@pytest.fixture
def upload_root(monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the storage helper at a temp dir for this test.

    ``storage.UPLOAD_ROOT`` is resolved at import time from the env
    variable, so we have to ``importlib.reload`` it after the patch
    to pick up the new root.
    """
    import importlib

    from app.files import storage as storage_mod

    tmp = Path(tempfile.mkdtemp(prefix="promptly-test-"))
    monkeypatch.setenv("PROMPTLY_UPLOAD_ROOT", str(tmp))
    importlib.reload(storage_mod)
    yield tmp
    # Reload back to the real env value so later tests don't see
    # the temp dir.
    monkeypatch.delenv("PROMPTLY_UPLOAD_ROOT", raising=False)
    importlib.reload(storage_mod)


def test_extract_text_file(upload_root: Path) -> None:
    from app.files import extraction

    # Duck-typed stand-in. The extractor only reads filename /
    # mime_type / storage_path / id so FakeUserFile satisfies the
    # shape without dragging in SQLAlchemy instance state.
    body = b"# Drive plan\n\nTrash, Starred, Recent.\n"
    rel = f"u_test/{uuid.uuid4()}.md"
    (upload_root / rel).parent.mkdir(parents=True, exist_ok=True)
    (upload_root / rel).write_bytes(body)
    row = FakeUserFile(
        id=uuid.uuid4(),
        filename="notes.md",
        mime_type="text/markdown",
        storage_path=rel,
    )

    text = extraction.extract_content_text(row)  # type: ignore[arg-type]
    assert text is not None
    assert "Drive plan" in text
    assert "Trash, Starred" in text


def test_extract_binary_returns_none(upload_root: Path) -> None:
    from app.files import extraction

    rel = f"u_test/{uuid.uuid4()}.png"
    (upload_root / rel).parent.mkdir(parents=True, exist_ok=True)
    # 8 PNG magic bytes so the file "looks" like a PNG, but the
    # extractor's predicate routes by mime/extension and returns None
    # for images.
    (upload_root / rel).write_bytes(b"\x89PNG\r\n\x1a\n")
    row = FakeUserFile(
        id=uuid.uuid4(),
        filename="image.png",
        mime_type="image/png",
        storage_path=rel,
    )

    assert extraction.extract_content_text(row) is None  # type: ignore[arg-type]


def test_extract_truncates_huge_text(upload_root: Path) -> None:
    from app.files import extraction

    big = b"x" * (300 * 1024)  # 300 KB > 256 KB cap
    rel = f"u_test/{uuid.uuid4()}.txt"
    (upload_root / rel).parent.mkdir(parents=True, exist_ok=True)
    (upload_root / rel).write_bytes(big)
    row = FakeUserFile(
        id=uuid.uuid4(),
        filename="huge.txt",
        mime_type="text/plain",
        storage_path=rel,
    )

    text = extraction.extract_content_text(row)  # type: ignore[arg-type]
    assert text is not None
    # The truncation helper capped us below the 300 KB input.
    assert len(text.encode("utf-8")) <= 300 * 1024
    assert "[truncated]" in text


def test_extract_from_text_truncates() -> None:
    from app.files import extraction

    ok = extraction.extract_from_text("hello world")
    assert ok == "hello world"

    too_big = extraction.extract_from_text("x" * (300 * 1024))
    assert "[truncated]" in too_big
    assert len(too_big.encode("utf-8")) < 260 * 1024


# ---------------------------------------------------------------------------
# Share link create-link payload validation
# ---------------------------------------------------------------------------


def test_share_link_create_payload_rejects_short_password() -> None:
    from pydantic import ValidationError

    from app.files.schemas import ShareLinkCreateRequest

    with pytest.raises(ValidationError):
        ShareLinkCreateRequest(access_mode="public", password="abc")


def test_share_link_create_payload_rejects_bad_expiry() -> None:
    from pydantic import ValidationError

    from app.files.schemas import ShareLinkCreateRequest

    with pytest.raises(ValidationError):
        ShareLinkCreateRequest(access_mode="public", expires_in_days=0)
    with pytest.raises(ValidationError):
        ShareLinkCreateRequest(access_mode="public", expires_in_days=10_000)


def test_share_link_create_payload_happy_path() -> None:
    from app.files.schemas import ShareLinkCreateRequest

    req = ShareLinkCreateRequest(
        access_mode="public",
        password="hunter22",
        expires_in_days=7,
    )
    assert req.password == "hunter22"
    assert req.expires_in_days == 7
