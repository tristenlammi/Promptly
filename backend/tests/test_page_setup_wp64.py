"""Page setup + WeasyPrint PDFs (WP-6.4): a Doc's paper, margins, header,
footer and page numbers live in its Y.Doc and shape the exported PDF;
rendering runs on the worker, here when no worker takes it, and never
fetches anything."""
from __future__ import annotations

import io
import uuid

import httpx
import pytest
from pypdf import PdfReader


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


@pytest.fixture
def inline_render(monkeypatch):
    """No queue: the API renders the PDF itself."""
    from app.tasks import queue

    async def no_pool():
        raise ConnectionError("no redis in this test")

    monkeypatch.setattr(queue, "get_pool", no_pool)


@pytest.fixture
async def client(db, tmp_path, monkeypatch, inline_render):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _mm(points: float) -> float:
    return round(float(points) / 72 * 25.4, 1)


# ---------------------------------------------------------------- the model


def test_normalise_falls_back_clamps_and_keeps_room_for_text() -> None:
    from app.files.page_setup import normalise

    s = normalise({"size": "B9", "orientation": "sideways", "pageNumbers": "everywhere"})
    assert (s.size, s.orientation, s.page_numbers) == ("A4", "portrait", "none")

    s = normalise({"margins": {"top": -5, "right": "12.25", "bottom": 400, "left": None}})
    assert s.margin_top == 0 and s.margin_right == 12.2 and s.margin_left == 20
    # 100 mm (clamped) + 0 on a 297 mm page leaves room; wide side margins
    # on A5 don't — they're scaled back to leave 4 cm.
    s = normalise({"size": "A5", "margins": {"left": 80, "right": 80}})
    assert round(148 - s.margin_left - s.margin_right, 1) == 40.0

    s = normalise({"header": "  Line one\n\tline two  ", "footer": "x" * 500})
    assert s.header == "Line one line two" and len(s.footer) == 200


def test_page_css_escapes_header_text() -> None:
    from app.files.page_setup import normalise, page_css

    css = page_css(normalise({"header": 'He said "hi" \\ } @page { size: 1mm', "pageNumbers": "top-right"}))
    # The text stays inside one CSS string: quotes and backslashes escaped.
    assert '\\22 ' in css and "\\5c " in css
    assert css.count("@top-center") == 1 and "@top-right" in css


def test_landscape_letter_with_header_footer_and_numbers() -> None:
    from app.files.page_setup import normalise
    from app.files.pdf_export import build_pdf_html, html_to_pdf

    setup = normalise({
        "size": "Letter", "orientation": "landscape",
        "margins": {"top": 10, "right": 15, "bottom": 25, "left": 15},
        "header": "Quarterly report", "footer": "Confidential",
        "pageNumbers": "bottom-center", "numberStyle": "page-n-of-m",
    })
    body = "<h1>Привет, мир</h1><p>中文测试</p>" + "<p>A line of filler text for the page.</p>" * 120
    pdf = PdfReader(io.BytesIO(html_to_pdf(build_pdf_html(body, setup, title="Report"))))
    assert len(pdf.pages) >= 2
    first = pdf.pages[0]
    assert (_mm(first.mediabox.width), _mm(first.mediabox.height)) == (279.4, 215.9)
    text = first.extract_text()
    assert "Quarterly report" in text and "Confidential" in text
    assert f"Page 1 of {len(pdf.pages)}" in text
    # Real fonts: Cyrillic and CJK come out as text, not boxes (R-080).
    assert "Привет" in text and "中文测试" in text and "■" not in text


def test_default_is_a4_without_numbers() -> None:
    from app.files.page_setup import PageSetup
    from app.files.pdf_export import build_pdf_html, html_to_pdf

    pdf = PdfReader(io.BytesIO(html_to_pdf(build_pdf_html("<p>Hello</p>", PageSetup(), title="T"))))
    page = pdf.pages[0]
    assert (_mm(page.mediabox.width), _mm(page.mediabox.height)) == (210.0, 297.0)
    assert "Page" not in page.extract_text()


def test_nothing_is_fetched_while_rendering(tmp_path) -> None:
    from app.files.page_setup import PageSetup
    from app.files.pdf_export import _fetcher, build_pdf_html, html_to_pdf

    secret = tmp_path / "secret.css"
    secret.write_text("body { color: red }")
    fetcher = _fetcher()
    for url in (f"file://{secret}", "http://169.254.169.254/latest/meta-data/", "https://example.com/a.png"):
        with pytest.raises(ValueError):
            fetcher.fetch(url)
    # A data: image is the one thing that loads.
    dot = (
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    body = f'<img src="file://{secret}"><img src="http://169.254.169.254/x.png"><img src="{dot}">'
    pdf = PdfReader(io.BytesIO(html_to_pdf(build_pdf_html(body, PageSetup(), title="T"))))
    assert len(pdf.pages[0].images) == 1


# ---------------------------------------------------------------- rendering on the worker


@pytest.mark.asyncio
async def test_render_falls_back_when_no_worker_takes_the_job(monkeypatch) -> None:
    from arq.jobs import JobStatus

    from app.files import pdf_export
    from app.files.page_setup import PageSetup
    from app.tasks import queue

    enqueued: list = []

    class Job:
        async def status(self):
            return JobStatus.queued

    class Pool:
        async def enqueue_job(self, name, *args, **kw):
            enqueued.append((name, kw))
            return Job()

    async def pool():
        return Pool()

    monkeypatch.setattr(queue, "get_pool", pool)
    monkeypatch.setattr(pdf_export, "PICKUP_SECONDS", 0.3)
    pdf = await pdf_export.render_pdf(pdf_export.build_pdf_html("<p>Hi</p>", PageSetup(), title="T"))
    assert pdf.startswith(b"%PDF")
    # Sent to the worker, and set to expire so it can't run late.
    assert enqueued[0][0] == queue.RENDER_PDF and enqueued[0][1]["_expires"].total_seconds() == 0.3


@pytest.mark.asyncio
async def test_render_uses_the_worker_result(monkeypatch) -> None:
    from arq.jobs import JobStatus

    from app.files import pdf_export
    from app.tasks import queue

    class Job:
        async def status(self):
            return JobStatus.complete

        async def result(self, timeout=None):
            return b"%PDF-from-worker"

    class Pool:
        async def enqueue_job(self, *a, **kw):
            return Job()

    async def pool():
        return Pool()

    monkeypatch.setattr(queue, "get_pool", pool)
    assert await pdf_export.render_pdf("<p>x</p>") == b"%PDF-from-worker"


@pytest.mark.asyncio
async def test_a_render_error_on_the_worker_is_not_retried_here(monkeypatch) -> None:
    from arq.jobs import JobStatus

    from app.files import pdf_export
    from app.tasks import queue

    class Job:
        async def status(self):
            return JobStatus.complete

        async def result(self, timeout=None):
            raise pdf_export.PdfRenderError("broken")

    class Pool:
        async def enqueue_job(self, *a, **kw):
            return Job()

    async def pool():
        return Pool()

    def boom(_html):
        raise AssertionError("rendered again inline")

    monkeypatch.setattr(queue, "get_pool", pool)
    monkeypatch.setattr(pdf_export, "html_to_pdf", boom)
    with pytest.raises(pdf_export.PdfRenderError):
        await pdf_export.render_pdf("<p>x</p>")


def test_the_worker_registers_the_render_job() -> None:
    from app.tasks.queue import RENDER_PDF
    from app.tasks.worker import WorkerSettings

    names = {f.name for f in WorkerSettings.functions}
    assert RENDER_PDF in names


# ---------------------------------------------------------------- the API


async def _doc_with_setup(client, db, user, setup: dict | None, paragraphs: int = 3) -> str:
    from pycrdt import Doc, Map, XmlElement, XmlFragment, XmlText

    from app.files.models import DocumentState

    r = await client.post("/api/documents", json={"scope": "mine", "name": "Paged"}, headers=_auth(user))
    doc_id = r.json()["id"]
    ydoc = Doc()
    frag = ydoc.get("default", type=XmlFragment)
    for i in range(paragraphs):
        frag.children.append(XmlElement("paragraph", {}, [XmlText(f"Paragraph {i} of the paged document.")]))
    if setup is not None:
        m = ydoc.get("pageSetup", type=Map)
        for k, v in setup.items():
            m[k] = v
    ds = await db.get(DocumentState, uuid.UUID(doc_id))
    ds.yjs_update = ydoc.get_update()
    ds.version = (ds.version or 0) + 1
    await db.commit()
    return doc_id


@pytest.mark.asyncio
async def test_exported_pdf_has_the_chosen_paper_margins_and_numbers(client, db, user):
    """The WP-6.4 exit criterion: a Doc exported to PDF has the chosen paper
    size, margins and page numbers."""
    setup = {
        "size": "A5", "orientation": "portrait",
        "margins": {"top": 30, "right": 10, "bottom": 30, "left": 10},
        "footer": "", "header": "", "pageNumbers": "bottom-right", "numberStyle": "page-n",
    }
    doc_id = await _doc_with_setup(client, db, user, setup, paragraphs=60)

    got = (await client.get(f"/api/documents/{doc_id}/page-setup", headers=_auth(user))).json()
    assert got["size"] == "A5" and got["margins"]["top"] == 30 and got["pageNumbers"] == "bottom-right"

    r = await client.get(f"/api/documents/{doc_id}/download?format=pdf", headers=_auth(user))
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    pdf = PdfReader(io.BytesIO(r.content))
    assert len(pdf.pages) >= 2
    page = pdf.pages[1]
    assert (_mm(page.mediabox.width), _mm(page.mediabox.height)) == (148.0, 210.0)
    assert "Page 2" in page.extract_text()

    # The margins: the body text starts below the 30 mm top margin.
    ys: list[float] = []

    def visit(text, cm, tm, *_):
        if "Paragraph" in text:
            # Text-space origin in page space (tm × cm).
            ys.append(tm[4] * cm[1] + tm[5] * cm[3] + cm[5])

    page.extract_text(visitor_text=visit)
    top_of_text_mm = _mm(page.mediabox.height) - _mm(max(ys))
    assert 30 <= top_of_text_mm <= 40


@pytest.mark.asyncio
async def test_a_doc_without_page_setup_exports_a4(client, db, user):
    doc_id = await _doc_with_setup(client, db, user, None)
    got = (await client.get(f"/api/documents/{doc_id}/page-setup", headers=_auth(user))).json()
    assert got == {
        "size": "A4", "orientation": "portrait",
        "margins": {"top": 20.0, "right": 20.0, "bottom": 20.0, "left": 20.0},
        "header": "", "footer": "", "pageNumbers": "none", "numberStyle": "page-n-of-m",
    }
    r = await client.get(f"/api/documents/{doc_id}/download?format=pdf", headers=_auth(user))
    page = PdfReader(io.BytesIO(r.content)).pages[0]
    assert _mm(page.mediabox.width) == 210.0


@pytest.mark.asyncio
async def test_page_setup_needs_access(client, db, user):
    from app.auth.models import User

    stranger = User(email=f"s-{uuid.uuid4().hex[:8]}@example.com", username=f"s{uuid.uuid4().hex[:6]}",
                    password_hash="x", role="user")
    db.add(stranger)
    await db.commit()
    await db.refresh(stranger)
    doc_id = await _doc_with_setup(client, db, user, None)
    r = await client.get(f"/api/documents/{doc_id}/page-setup", headers=_auth(stranger))
    assert r.status_code == 404
