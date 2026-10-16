"""Regression tests for Promptly Drive Documents.

Covers the pieces that are testable without a live Postgres or a
running Hocuspocus process:

- Asset URL signing round-trip (``_asset_signature`` /
  ``_verify_asset_signature``) and tamper rejection so the inline
  image / audio bypass-auth path cannot be forged.
- Collab JWT round-trip (``_mint_collab_token`` and the decode the
  Hocuspocus server performs via ``jose.jwt``) so a signed token
  produces the expected (document_id, user_id, perm) claims.
- Internal bearer verification (``_verify_collab_internal_caller``)
  so the Hocuspocus → snapshot path is locked to the shared secret.
- Drive listing filter (``_drive_listing_filter``) shape so
  ``document_asset`` rows never leak into Drive views.
- Snapshot renderer round-trip (``render_html_from_update`` /
  ``extract_text_from_html`` + ``sanitize_document_html``) against a
  pycrdt-authored Y.Doc, so formatting + script-injection are
  exercised end-to-end.

The websocket handshake against Hocuspocus itself, and the actual
snapshot POST round-trip via HTTP, require the docker stack up and
are covered in the manual QA matrix from the plan.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import pytest
from jose import jwt

from app.auth.utils import JWT_ALGORITHM
from app.config import get_settings
from app.files import documents_router
from app.files.document_render import (
    extract_text_from_html,
    render_html_from_update,
    sanitize_document_html,
)
from app.files.generated_kinds import GeneratedKind


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class FakeUser:
    id: uuid.UUID
    username: str = "alice"
    role: str = "user"
    token_version: int = 0
    # Profile appearance (0132) — the token minter reads both.
    avatar_color: str | None = None
    avatar_updated_at: object | None = None

    @property
    def avatar_url(self) -> str | None:
        return None


# ---------------------------------------------------------------------------
# Asset URL signing
# ---------------------------------------------------------------------------


def _link_parts(url: str) -> tuple[str, int]:
    q = dict(p.split("=") for p in url.split("?")[1].split("&"))
    return q["sig"], int(q["exp"])


def test_asset_signature_round_trip() -> None:
    """A short-lived link minted for (asset_id, document_id) verifies back
    (WP-4.6, R-228) — and so does a pre-R-228 permanent one."""
    from app.files import doc_assets

    asset_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    sig, exp = _link_parts(doc_assets.signed_url(doc_id, asset_id))
    assert doc_assets.verify(doc_id, asset_id, sig, exp)
    assert doc_assets.verify(doc_id, asset_id, doc_assets._legacy_sig(asset_id, doc_id), None)


def test_asset_signature_rejects_wrong_document() -> None:
    """A signature bound to doc A must not unlock assets of doc B.

    This is the guard that stops somebody with a doc B URL from
    discovering doc A's asset id and replaying the signature they
    already have for their own doc.
    """
    from app.files import doc_assets

    asset_id = uuid.uuid4()
    doc_a = uuid.uuid4()
    doc_b = uuid.uuid4()
    sig, exp = _link_parts(doc_assets.signed_url(doc_a, asset_id))
    assert not doc_assets.verify(doc_b, asset_id, sig, exp)
    assert not doc_assets.verify(doc_b, asset_id, doc_assets._legacy_sig(asset_id, doc_a), None)


def test_asset_signature_rejects_garbage() -> None:
    from app.files import doc_assets

    doc_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    assert not doc_assets.verify(doc_id, asset_id, "", None)
    assert not doc_assets.verify(doc_id, asset_id, "0" * 64, None)
    assert not doc_assets.verify(doc_id, asset_id, "0" * 64, 9_999_999_999)


def test_signed_asset_url_shape() -> None:
    """Links go through the documents endpoint and expire (R-228)."""

    asset_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    url = documents_router._signed_asset_url(asset_id=asset_id, document_id=doc_id)
    assert url.startswith(f"/api/documents/{doc_id}/assets/{asset_id}?exp=")
    assert "&sig=" in url


# ---------------------------------------------------------------------------
# Collab JWT
# ---------------------------------------------------------------------------


def test_collab_token_round_trip() -> None:
    """A minted collab token decodes to the claims Hocuspocus reads."""

    user = FakeUser(id=uuid.uuid4())
    doc_id = uuid.uuid4()
    token, exp = documents_router._mint_collab_token(
        document_id=doc_id, user=user, perm="write"  # type: ignore[arg-type]
    )

    decoded = jwt.decode(
        token, get_settings().SECRET_KEY, algorithms=[JWT_ALGORITHM]
    )
    assert decoded["sub"] == str(user.id)
    assert decoded["document_id"] == str(doc_id)
    assert decoded["type"] == "collab"
    assert decoded["perm"] == "write"
    assert decoded["name"] == "alice"
    # Palette lookup is deterministic per user-id.
    assert decoded["color"] in documents_router._COLLAB_COLOR_PALETTE
    # Expiry lives inside the configured TTL window.
    assert exp - int(time.time()) <= documents_router.COLLAB_TOKEN_TTL_SECONDS + 5


def test_collab_token_color_is_stable_per_user() -> None:
    """Two mints for the same user produce the same cursor color.

    Otherwise the collaboration cursor would flicker between
    palette entries on reconnect, which looks broken to the
    co-editor on the other end.
    """

    user = FakeUser(id=uuid.uuid4())
    t1, _ = documents_router._mint_collab_token(
        document_id=uuid.uuid4(), user=user, perm="read"  # type: ignore[arg-type]
    )
    t2, _ = documents_router._mint_collab_token(
        document_id=uuid.uuid4(), user=user, perm="read"  # type: ignore[arg-type]
    )
    secret = get_settings().SECRET_KEY
    c1 = jwt.decode(t1, secret, algorithms=[JWT_ALGORITHM])["color"]
    c2 = jwt.decode(t2, secret, algorithms=[JWT_ALGORITHM])["color"]
    assert c1 == c2


# ---------------------------------------------------------------------------
# Internal bearer verification
# ---------------------------------------------------------------------------


def test_internal_bearer_accepts_the_internal_token_not_secret_key() -> None:
    from fastapi import HTTPException

    from app.collab_internal import internal_token

    # Should not raise.
    documents_router._verify_collab_internal_caller(f"Bearer {internal_token()}")
    # SECRET_KEY itself is no longer the collab bearer (WP-3.2).
    with pytest.raises(HTTPException) as exc:
        documents_router._verify_collab_internal_caller(f"Bearer {get_settings().SECRET_KEY}")
    assert exc.value.status_code == 403


def test_internal_bearer_rejects_mismatched_secret() -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        documents_router._verify_collab_internal_caller("Bearer not-the-secret")
    assert exc.value.status_code == 403


def test_internal_bearer_rejects_missing_header() -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        documents_router._verify_collab_internal_caller(None)
    assert exc.value.status_code == 401

    with pytest.raises(HTTPException):
        documents_router._verify_collab_internal_caller("Basic abc123")


# ---------------------------------------------------------------------------
# Drive listing filter
# ---------------------------------------------------------------------------


def test_drive_listing_filter_excludes_document_assets() -> None:
    """The SQL filter compiles and references ``document_asset``.

    We can't easily round-trip a real query without a live DB, but we
    can assert the filter compiles + mentions the asset constant so
    a future refactor that drops the predicate will break this test.
    """

    from app.files.router import _drive_listing_filter

    expr = _drive_listing_filter()
    compiled = expr.compile(compile_kwargs={"literal_binds": True})
    sql = str(compiled)
    assert GeneratedKind.DOCUMENT_ASSET.value in sql
    # Documents themselves must still pass.
    assert "IS NULL" in sql.upper() or "is null" in sql


# ---------------------------------------------------------------------------
# Snapshot render + sanitiser
# ---------------------------------------------------------------------------


def _build_doc_update(fragment_filler) -> bytes:
    """Create a fresh pycrdt Doc, let ``fragment_filler`` populate
    the ``"default"`` XmlFragment, and return the full update blob
    the same way Hocuspocus would POST it.
    """

    pycrdt = pytest.importorskip("pycrdt")
    doc = pycrdt.Doc()
    frag = doc.get("default", type=pycrdt.XmlFragment)
    fragment_filler(pycrdt, frag)
    return doc.get_update()


def test_render_handles_empty_update() -> None:
    """An empty update decodes to an empty HTML snapshot."""

    assert render_html_from_update(b"") == ""


def test_render_produces_expected_paragraph_html() -> None:
    pycrdt = pytest.importorskip("pycrdt")

    def fill(pc, frag):
        # pycrdt requires an element to be integrated into the doc
        # before its children can be populated — otherwise the
        # nested transaction can't find the backing store. Attach to
        # the fragment first, then stage the text leaf.
        el = pc.XmlElement("paragraph")
        frag.children.append(el)
        el.children.append(pc.XmlText("hello world"))

    update = _build_doc_update(fill)
    html_out = render_html_from_update(update)
    assert "<p>" in html_out
    assert "hello world" in html_out


def test_extract_text_from_html_strips_tags() -> None:
    html_in = (
        "<p>Hello <strong>brave</strong> <em>new</em> world</p>"
        "<script>alert(1)</script>"
        "<p>Second paragraph.</p>"
    )
    text = extract_text_from_html(html_in)
    # Script contents get stripped along with the tag.
    assert "alert" not in text
    assert "Hello brave new world" in text
    assert "Second paragraph." in text


def test_sanitize_document_html_strips_script() -> None:
    dirty = (
        "<p>safe</p>"
        "<script>window.location='http://evil.test'</script>"
        '<a href="javascript:alert(1)">click</a>'
    )
    clean = sanitize_document_html(dirty)
    assert "<script>" not in clean
    assert "javascript:" not in clean
    assert "<p>safe</p>" in clean


# ---------------------------------------------------------------------------
# Manual save / format-aware download helpers
# ---------------------------------------------------------------------------


def test_document_download_filename_strips_html_extension() -> None:
    """``<title>.html`` round-trips with the requested extension.

    The stored blob always lives at ``<title>.html`` (we coerce the
    extension on create + rename), so the download path needs to
    swap that suffix out cleanly rather than producing names like
    ``Notes.html.md`` in the user's browser save dialog.
    """

    fn = documents_router._document_download_filename
    assert fn("Notes.html", extension=".md") == "Notes.md"
    assert fn("notes.html", extension=".pdf") == "notes.pdf"
    # ``.htm`` shorthand also recognised — older Drive blobs predate
    # the ``.html`` enforcement on rename, so this keeps them safe.
    assert fn("legacy.htm", extension=".pdf") == "legacy.pdf"
    # No html suffix at all → keep the title verbatim and append.
    assert fn("Quarterly Plan", extension=".md") == "Quarterly Plan.md"
    # Empty title falls back to a sensible default rather than an
    # extension-only filename like ``.md`` which most browsers will
    # mangle.
    assert fn("", extension=".pdf") == "document.pdf"


def test_html_to_markdown_basic_blocks() -> None:
    """Heading + paragraph + list + emphasis survive the round trip."""

    html_in = (
        "<h1>Title</h1>"
        "<p>Hello <strong>world</strong> with <em>emphasis</em>.</p>"
        "<ul><li>one</li><li>two</li></ul>"
    )
    md = documents_router._html_to_markdown(html_in)
    # ATX heading (``#``-prefixed) chosen for readability + diff
    # stability — the test pins both the marker and the asterisk
    # bold/italic style so a future config change has to be
    # explicit.
    assert "# Title" in md
    assert "**world**" in md
    assert "*emphasis*" in md
    assert "- one" in md
    assert "- two" in md


def test_html_to_markdown_empty_input() -> None:
    assert documents_router._html_to_markdown("") == ""


def test_html_to_pdf_returns_pdf_bytes() -> None:
    """WeasyPrint (WP-6.4) produces bytes that start with the PDF magic.

    The renderer is a black box for this test — we only confirm we
    got back a non-empty body that the browser would recognise as
    a PDF, so the download endpoint can hand it out without
    parsing. Page setup is covered in test_page_setup_wp64.
    """
    from app.files.page_setup import PageSetup
    from app.files.pdf_export import build_pdf_html, html_to_pdf

    pdf = html_to_pdf(build_pdf_html("<p>Hello world</p>", PageSetup(), title="Greeting"))
    assert pdf.startswith(b"%PDF"), "output is not a PDF"
    assert len(pdf) > 500


def test_sanitize_document_html_pins_youtube_host() -> None:
    """Iframe srcs outside the YouTube allowlist get stripped.

    ``bleach`` drops the entire ``src`` attribute rather than the
    element, so we accept either flavour as long as the hostile
    URL never survives.
    """

    dirty = (
        '<iframe src="https://evil.test/player?id=123" '
        'allowfullscreen></iframe>'
        '<iframe src="https://www.youtube-nocookie.com/embed/abc" '
        'allowfullscreen></iframe>'
    )
    clean = sanitize_document_html(dirty)
    assert "evil.test" not in clean
    assert "youtube-nocookie.com/embed/abc" in clean
