"""A Doc as a PDF, rendered by WeasyPrint (WP-6.4).

Replaces xhtml2pdf for Docs: WeasyPrint understands CSS Paged Media, so the
document's page setup (paper, margins, header/footer, page numbers —
:mod:`app.files.page_setup`) becomes ``@page`` rules, and real fonts from the
image (Liberation, DejaVu, Noto CJK) mean Cyrillic and CJK text no longer come
out as boxes.

Rendering is CPU-heavy pure Python, and the API runs one uvicorn worker, so a
PDF is rendered on the Arq worker (:func:`render_pdf`). When no worker picks
the job up in a few seconds — it's down or busy with long jobs — the API
renders it in a thread itself, so a download never just hangs.

SECURITY: nothing is fetched while rendering. The HTML is the sanitised
document with its own images already inlined as ``data:`` URIs; every other
URL (``http:``, ``file:``…) is refused by :class:`_DataOnlyFetcher`, so a
document can't make the server read local files or reach the network.
"""
from __future__ import annotations

import asyncio
import html
import logging
from datetime import timedelta

from app.files.page_setup import FONT_STACK, PageSetup, page_css

logger = logging.getLogger("promptly.files.pdf_export")

# How long a job may wait for a worker before the API renders it itself.
PICKUP_SECONDS = 8
# The longest a render may take, on the worker or here.
RENDER_SECONDS = 120


class PdfRenderError(Exception):
    """The document couldn't be rendered (raised on the worker, re-raised
    by :func:`render_pdf`)."""


_DOC_CSS = """
html { font-family: %(font)s; font-size: 11pt; line-height: 1.45; color: #111; }
body { margin: 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 700; margin: 1.1em 0 0.4em; line-height: 1.2; break-after: avoid; }
h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; } h4 { font-size: 12pt; }
p { margin: 0 0 0.6em; orphans: 2; widows: 2; }
ul, ol { margin: 0 0 0.6em; padding-left: 1.4em; }
li { margin: 0.15em 0; } li > p { margin: 0; }
blockquote { margin: 0.8em 0; padding: 0 0 0 12pt; border-left: 3pt solid #ccc; color: #444; }
code { font-family: "Liberation Mono", "DejaVu Sans Mono", monospace; font-size: 9.5pt;
       background: #f3f3f3; padding: 1pt 3pt; border-radius: 2pt; }
pre { background: #f6f6f6; padding: 8pt 10pt; font-size: 9.5pt; white-space: pre-wrap; border-radius: 4pt; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; width: 100%%; margin: 0.6em 0; }
th, td { border: 0.6pt solid #aaa; padding: 4pt 6pt; vertical-align: top; }
th { background: #f0f0f0; font-weight: 700; }
tr { break-inside: avoid; }
hr { border: 0; border-top: 0.6pt solid #ccc; margin: 0.8em 0; }
img { max-width: 100%%; height: auto; }
a { color: #2563eb; text-decoration: none; }
mark { padding: 0 1pt; border-radius: 1pt; }
ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
ul[data-type="taskList"] li { display: flex; gap: 0.4em; }
ul[data-type="taskList"] li > label { flex: none; }
li[data-type="taskItem"] > label input { margin: 0; }
li[data-type="taskItem"][data-checked="true"] > div { color: #666; text-decoration: line-through; }
.doc-callout { border-left: 4pt solid #38bdf8; background: #f0f9ff; padding: 6pt 10pt; border-radius: 4pt;
               margin: 0.6em 0; break-inside: avoid; }
.doc-callout[data-variant="warning"] { border-left-color: #f59e0b; background: #fffbeb; }
.doc-callout[data-variant="success"] { border-left-color: #10b981; background: #ecfdf5; }
.doc-callout[data-variant="danger"] { border-left-color: #f43f5e; background: #fff1f2; }
figure.doc-figure { margin: 0.8em 0; text-align: center; break-inside: avoid; }
figure.doc-figure[data-align="left"] { text-align: left; }
figure.doc-figure[data-align="right"] { text-align: right; }
figcaption { font-size: 0.85em; color: #666; font-style: italic; margin-top: 3pt; }
.doc-page-break { break-after: page; height: 0; margin: 0; border: 0; }
.doc-math { font-family: "Latin Modern Math", "Cambria Math", serif; }
div.doc-math { display: block; text-align: center; margin: 0.6em 0; }
.doc-columns { display: flex; gap: 14pt; } .doc-column { flex: 1; min-width: 0; }
details > summary { font-weight: 600; }
iframe, video, audio { display: none; }
"""


def build_pdf_html(fragment: str, setup: PageSetup, *, title: str) -> str:
    """The page WeasyPrint renders: the document under its page setup."""
    css = page_css(setup) + "\n" + (_DOC_CSS % {"font": FONT_STACK})
    return (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
        f"<title>{html.escape(title or 'Document')}</title>\n"
        f"<style>{css}</style>\n</head>\n<body>{fragment}</body>\n</html>\n"
    )


def _fetcher():
    from weasyprint.urls import URLFetcher

    class _DataOnlyFetcher(URLFetcher):
        def fetch(self, url, headers=None):  # noqa: ANN001, ANN201 — WeasyPrint's shape
            if str(url).startswith("data:"):
                return super().fetch(url, headers)
            raise ValueError("External resources aren't loaded into exported PDFs.")

    return _DataOnlyFetcher(allowed_protocols=("data",), timeout=5)


def html_to_pdf(page_html: str) -> bytes:
    """Render a page from :func:`build_pdf_html` (sync, CPU-bound)."""
    try:
        from weasyprint import HTML

        pdf = HTML(string=page_html, url_fetcher=_fetcher(), media_type="print").write_pdf()
    except Exception as exc:  # noqa: BLE001 — surfaced as one clear error
        logger.warning("PDF render failed", exc_info=True)
        raise PdfRenderError("This document couldn't be rendered as a PDF.") from exc
    if not pdf:
        raise PdfRenderError("This document couldn't be rendered as a PDF.")
    return pdf


async def render_pdf(page_html: str) -> bytes:
    """Render on the Arq worker; here, in a thread, when no worker takes it."""
    job = None
    try:
        from app.tasks.queue import RENDER_PDF, get_pool

        pool = await get_pool()
        # A job no worker has started by then is dropped from the queue, so
        # it can't run late after we've rendered it here.
        job = await pool.enqueue_job(RENDER_PDF, page_html, _expires=timedelta(seconds=PICKUP_SECONDS))
    except Exception:  # noqa: BLE001 — no queue: render here
        logger.info("render_pdf: queue unavailable, rendering inline", exc_info=True)

    if job is not None:
        try:
            return await asyncio.wait_for(_from_worker(job), timeout=RENDER_SECONDS + PICKUP_SECONDS)
        except PdfRenderError:
            raise
        except TimeoutError as exc:
            # Started but never finished: rendering it again here would only
            # take as long.
            raise PdfRenderError("This document took too long to render as a PDF.") from exc
        except Exception:  # noqa: BLE001 — not picked up, or the worker is older
            logger.info("render_pdf: worker didn't render it, rendering inline", exc_info=True)

    return await asyncio.wait_for(asyncio.to_thread(html_to_pdf, page_html), timeout=RENDER_SECONDS)


class _NotPickedUp(Exception):
    pass


async def _from_worker(job) -> bytes:  # noqa: ANN001 — arq.jobs.Job
    from arq.jobs import JobStatus

    loop = asyncio.get_running_loop()
    started = loop.time()
    while True:
        status = await job.status()
        if status == JobStatus.complete:
            return await job.result(timeout=5)
        if status == JobStatus.not_found:
            raise _NotPickedUp("job vanished")
        if status in (JobStatus.queued, JobStatus.deferred) and loop.time() - started > PICKUP_SECONDS:
            raise _NotPickedUp("no worker picked it up")
        await asyncio.sleep(0.25)


__all__ = ["PdfRenderError", "build_pdf_html", "html_to_pdf", "render_pdf"]
