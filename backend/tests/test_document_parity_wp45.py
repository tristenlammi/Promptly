"""Docs parity (WP-4.5): what the editor can now do survives the server's
snapshot — alignment, fonts, colours (R-223), sub/superscript, merged
table cells, image size / caption / alignment, page breaks and maths —
and the sanitiser keeps those styles while still refusing anything else."""
from __future__ import annotations

from pycrdt import Doc, XmlElement, XmlFragment, XmlText


def _render(build) -> str:
    from app.files.document_render import render_html_from_update

    doc = Doc()
    frag = doc.get("default", type=XmlFragment)
    build(frag)
    return render_html_from_update(doc.get_update())


def _para(frag, attrs=None):
    p = XmlElement("paragraph", attrs or {})
    frag.children.append(p)
    t = XmlText()
    p.children.append(t)
    return t


def test_alignment_fonts_and_colours_survive_the_snapshot():
    def build(frag):
        t = _para(frag, {"textAlign": "center"})
        t.insert(0, "Big red ", attrs={"textStyle": {"color": "#EF4444", "fontSize": "18pt", "fontFamily": "Georgia, serif"}})
        t.insert(8, "marked", attrs={"highlight": {"color": "#FFE888"}})
        h = XmlElement("heading", {"level": 2, "textAlign": "right"})
        frag.children.append(h)
        h.children.append(XmlText("Right heading"))
        t2 = _para(frag)
        t2.insert(0, "H")
        t2.insert(1, "2", attrs={"subscript": True})
        t2.insert(2, "O and x")
        t2.insert(9, "2", attrs={"superscript": True})

    html = _render(build)
    assert '<p style="text-align:center">' in html
    assert '<span style="color:#EF4444;font-family:Georgia, serif;font-size:18pt">Big red </span>' in html
    assert '<mark style="background-color:#FFE888">marked</mark>' in html
    assert '<h2 style="text-align:right">Right heading</h2>' in html
    assert "H<sub>2</sub>O and x<sup>2</sup>" in html


def test_merged_cells_images_page_breaks_and_maths_render():
    def build(frag):
        table = XmlElement("table")
        frag.children.append(table)
        row = XmlElement("tableRow")
        table.children.append(row)
        cell = XmlElement("tableCell", {"colspan": 2, "rowspan": 1})
        row.children.append(cell)
        cell.children.append(XmlElement("paragraph", {}, [XmlText("Spans two")]))
        frag.children.append(XmlElement("image", {"src": "https://example.com/a.png", "width": 240, "caption": "A <chart>", "align": "right"}))
        frag.children.append(XmlElement("image", {"src": "https://example.com/b.png"}))
        frag.children.append(XmlElement("pageBreak"))
        p = XmlElement("paragraph")
        frag.children.append(p)
        p.children.append(XmlText("Energy "))
        p.children.append(XmlElement("inlineMath", {"latex": "E=mc^2"}))
        frag.children.append(XmlElement("blockMath", {"latex": r"\int_0^1 x\,dx"}))

    html = _render(build)
    assert '<td colspan="2"><p>Spans two</p></td>' in html
    assert (
        '<figure class="doc-figure" data-align="right"><img src="https://example.com/a.png" width="240">'
        "<figcaption>A &lt;chart&gt;</figcaption></figure>"
    ) in html
    assert '<img src="https://example.com/b.png">' in html  # a plain image stays plain
    assert '<div class="doc-page-break" data-type="page-break"></div>' in html
    assert '<span class="doc-math" data-type="inline-math" data-latex="E=mc^2">E=mc^2</span>' in html
    assert 'data-type="block-math"' in html and r"\int_0^1 x\,dx" in html


def test_the_sanitiser_keeps_editor_styles_and_drops_everything_else():
    from app.files.document_render import safe_style, sanitize_document_html

    # What TipTap's getHTML() writes (manual save, offline seed) — R-223.
    kept = sanitize_document_html(
        '<p style="text-align: center">x</p>'
        '<span style="color: #EF4444; font-size: 14pt; font-family: \'Courier New\', monospace">y</span>'
        '<mark data-color="#ffe888" style="background-color: #ffe888; color: inherit">z</mark>'
        '<table style="min-width: 75px"><tbody><tr><td colspan="2" style="width: 120px">c</td></tr></tbody></table>'
    )
    assert 'style="text-align: center"' in kept
    assert "font-size: 14pt" in kept and "Courier New" in kept
    assert 'style="background-color: #ffe888; color: inherit"' in kept
    assert 'style="min-width: 75px"' in kept and 'style="width: 120px"' in kept

    dropped = sanitize_document_html(
        '<p style="color: red; position: fixed">a</p>'
        '<span style="background: url(javascript:alert(1))">b</span>'
        '<span style="width: expression(alert(1))">c</span>'
        '<span style="color: red /* x */">d</span>'
        '<p onclick="x()" style="text-align: centre">e</p>'
    )
    assert "style=" not in dropped and "onclick" not in dropped
    assert safe_style("color: rgb(239, 68, 68)") and safe_style("font-family: Georgia, 'Times New Roman', serif")
    assert not safe_style("font-family: x; color: #fff; top: 0")
    assert not safe_style("color: #fff\\;")
