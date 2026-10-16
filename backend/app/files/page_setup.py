"""A Doc's page setup — paper, margins, header/footer, page numbers (WP-6.4).

The editor keeps it in the document's Y.Doc, in a ``pageSetup`` map with one
key per setting, so two people changing different settings at once keep both
and every version and restore carries it. Mirrored by
``frontend/src/lib/pageSetup.ts`` — keep the two in step.

It drives the PDF (WeasyPrint ``@page`` rules, :func:`page_css`), the .docx
section properties (built in the browser) and the browser's own print CSS.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

# Width × height in millimetres, portrait.
PAPER_MM: dict[str, tuple[float, float]] = {
    "A4": (210.0, 297.0),
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
    "A5": (148.0, 210.0),
    "A3": (297.0, 420.0),
}
PAGE_NUMBERS = ("none", "bottom-center", "bottom-right", "top-right")
NUMBER_STYLES = ("n", "page-n", "page-n-of-m")
MAX_MARGIN_MM = 100.0
MIN_CONTENT_MM = 40.0
MAX_TEXT = 200
# Installed in the backend image: Liberation (metric twins of Arial / Times /
# Courier), DejaVu (Latin, Greek, Cyrillic) and Noto CJK. Pango falls back
# through fontconfig for any glyph the first family lacks.
FONT_STACK = '"Liberation Sans", Arial, "DejaVu Sans", "Noto Sans CJK SC", sans-serif'


@dataclass
class PageSetup:
    size: str = "A4"
    orientation: str = "portrait"
    margin_top: float = 20.0
    margin_right: float = 20.0
    margin_bottom: float = 20.0
    margin_left: float = 20.0
    header: str = ""
    footer: str = ""
    page_numbers: str = "none"
    number_style: str = "page-n-of-m"

    def paper_mm(self) -> tuple[float, float]:
        w, h = PAPER_MM[self.size]
        return (h, w) if self.orientation == "landscape" else (w, h)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return {
            "size": d["size"],
            "orientation": d["orientation"],
            "margins": {
                "top": d["margin_top"],
                "right": d["margin_right"],
                "bottom": d["margin_bottom"],
                "left": d["margin_left"],
            },
            "header": d["header"],
            "footer": d["footer"],
            "pageNumbers": d["page_numbers"],
            "numberStyle": d["number_style"],
        }


def _num(v: Any, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return round(min(max(f, 0.0), MAX_MARGIN_MM), 1)


def _text(v: Any) -> str:
    if not isinstance(v, str):
        return ""
    # One line: a header is a line of text, not a document.
    return " ".join(v.split())[:MAX_TEXT]


def normalise(raw: Any) -> PageSetup:
    """Whatever is in the map (or an API body) → a valid setup. Unknown or
    broken values fall back to the defaults, margins are clamped, and margins
    that would leave less than 4 cm of page are scaled back."""
    d = raw if isinstance(raw, dict) else {}
    out = PageSetup()
    if d.get("size") in PAPER_MM:
        out.size = d["size"]
    if d.get("orientation") in ("portrait", "landscape"):
        out.orientation = d["orientation"]
    m = d.get("margins") if isinstance(d.get("margins"), dict) else {}
    out.margin_top = _num(m.get("top"), out.margin_top)
    out.margin_right = _num(m.get("right"), out.margin_right)
    out.margin_bottom = _num(m.get("bottom"), out.margin_bottom)
    out.margin_left = _num(m.get("left"), out.margin_left)
    out.header = _text(d.get("header"))
    out.footer = _text(d.get("footer"))
    if d.get("pageNumbers") in PAGE_NUMBERS:
        out.page_numbers = d["pageNumbers"]
    if d.get("numberStyle") in NUMBER_STYLES:
        out.number_style = d["numberStyle"]

    w, h = out.paper_mm()
    for a, b, room in (("margin_left", "margin_right", w), ("margin_top", "margin_bottom", h)):
        total = getattr(out, a) + getattr(out, b)
        if total > room - MIN_CONTENT_MM and total > 0:
            k = max(room - MIN_CONTENT_MM, 0) / total
            setattr(out, a, round(getattr(out, a) * k, 1))
            setattr(out, b, round(getattr(out, b) * k, 1))
    return out


def from_ydoc(doc: Any) -> PageSetup:
    """Read the ``pageSetup`` map of a pycrdt ``Doc``."""
    try:
        from pycrdt import Map  # type: ignore

        m = doc.get("pageSetup", type=Map)
        return normalise({k: _plain(v) for k, v in m.items()})
    except Exception:  # noqa: BLE001 — a broken map just means "defaults"
        return PageSetup()


def from_update(update: bytes | None) -> PageSetup:
    if not update:
        return PageSetup()
    try:
        from pycrdt import Doc  # type: ignore

        doc = Doc()
        doc.apply_update(update)
    except Exception:  # noqa: BLE001
        return PageSetup()
    return from_ydoc(doc)


def _plain(v: Any) -> Any:
    """pycrdt hands nested JSON back as plain values, but a Y type nested in
    the map (not something the editor writes) is turned into JSON too."""
    to_py = getattr(v, "to_py", None)
    return to_py() if callable(to_py) else v


def _css_string(text: str) -> str:
    """A CSS string literal — quotes, backslashes and newlines escaped."""
    out = []
    for ch in text:
        if ch in ('"', "\\") or ord(ch) < 0x20 or ch == "\x7f":
            out.append(f"\\{ord(ch):x} ")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _number_content(style: str) -> str:
    if style == "n":
        return "counter(page)"
    if style == "page-n":
        return '"Page " counter(page)'
    return '"Page " counter(page) " of " counter(pages)'


def page_css(setup: PageSetup) -> str:
    """The ``@page`` rule for this setup: paper, margins and margin boxes
    (header centred at the top, footer centred at the bottom, page numbers
    where chosen — sharing the footer's box when both sit bottom-centre)."""
    w, h = setup.paper_mm()
    boxes: dict[str, list[str]] = {}
    if setup.header:
        boxes.setdefault("top-center", []).append(_css_string(setup.header))
    if setup.footer:
        boxes.setdefault("bottom-center", []).append(_css_string(setup.footer))
    if setup.page_numbers != "none":
        box = boxes.setdefault(setup.page_numbers, [])
        if box:
            box.append('"  ·  "')
        box.append(_number_content(setup.number_style))
    rules = "".join(
        f"@{name} {{ content: {' '.join(parts)}; font-family: {FONT_STACK}; font-size: 9pt; color: #555; }} "
        for name, parts in boxes.items()
    )
    return (
        f"@page {{ size: {w}mm {h}mm; "
        f"margin: {setup.margin_top}mm {setup.margin_right}mm {setup.margin_bottom}mm {setup.margin_left}mm; "
        f"{rules}}}"
    )


__all__ = ["PageSetup", "PAPER_MM", "normalise", "from_ydoc", "from_update", "page_css"]
