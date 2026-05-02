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


# ---------------------------------------------------------------------------
# Asset URL signing
# ---------------------------------------------------------------------------


def test_asset_signature_round_trip() -> None:
    """A signature minted for (asset_id, document_id) verifies back."""

    asset_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    sig = documents_router._asset_signature(asset_id=asset_id, document_id=doc_id)

    assert documents_router._verify_asset_signature(
        asset_id=asset_id, document_id=doc_id, signature=sig
    )


def test_asset_signature_rejects_wrong_document() -> None:
    """A signature bound to doc A must not unlock assets of doc B.

    This is the guard that stops somebody with a doc B URL from
    discovering doc A's asset id and replaying the signature they
    already have for their own doc.
    """

    asset_id = uuid.uuid4()
    doc_a = uuid.uuid4()
    doc_b = uuid.uuid4()
    sig = documents_router._asset_signature(asset_id=asset_id, document_id=doc_a)

    assert not documents_router._verify_asset_signature(
        asset_id=asset_id, document_id=doc_b, signature=sig
    )


def test_asset_signature_rejects_garbage() -> None:
    doc_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    assert not documents_router._verify_asset_signature(
        asset_id=asset_id, document_id=doc_id, signature=""
    )
    assert not documents_router._verify_asset_signature(
        asset_id=asset_id,
        document_id=doc_id,
        signature="0" * 64,
    )


def test_signed_asset_url_shape() -> None:
    """Generated URLs are routed through the documents endpoint."""

    asset_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    url = documents_router._signed_asset_url(asset_id=asset_id, document_id=doc_id)
    assert url.startswith(f"/api/documents/{doc_id}/assets/{asset_id}?sig=")


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


def test_internal_bearer_accepts_secret() -> None:
    secret = get_settings().SECRET_KEY
    # Should not raise.
    documents_router._verify_collab_internal_caller(f"Bearer {secret}")


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
    """xhtml2pdf produces bytes that start with the PDF magic.

    The renderer is a black box for this test — we only confirm we
    got back a non-empty body that the browser would recognise as
    a PDF, so the download endpoint can hand it out without
    parsing.
    """

    pdf = documents_router._html_to_pdf_bytes(
        "<p>Hello world</p>", title="Greeting"
    )
    assert pdf.startswith(b"%PDF"), "xhtml2pdf output is not a PDF"
    # A non-trivial body (xhtml2pdf still emits a few KB even for
    # one paragraph because of fonts + structure).
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
