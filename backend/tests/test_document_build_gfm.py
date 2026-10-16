"""GFM coverage for the Markdown → note converter (R-314).

``markdown_to_doc_update`` seeds workspace templates, vault (Markdown-zip)
imports and automation output notes. It used to run markdown-it's bare
commonmark preset, so Obsidian front matter became ``<hr><h2>…</h2>``, a GFM
table one ``| a | b |`` paragraph, and ``- [ ] todo`` a bullet reading
``[ ] todo``. These are pure unit tests: they decode the produced Y.Doc
update with pycrdt and inspect the y-prosemirror tree — no database.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from app.files.document_build import markdown_to_doc_update
from app.files.document_render import render_html_from_update

pycrdt = pytest.importorskip("pycrdt")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tree(md: str) -> list[dict[str, Any]]:
    """Markdown → the fragment's blocks as plain ``{tag, attrs, children}``
    dicts (text leaves become ``{"text": …}``)."""
    from pycrdt import Doc, XmlFragment, XmlText

    doc = Doc()
    doc.apply_update(markdown_to_doc_update(md))
    frag = doc.get("default", type=XmlFragment)

    def conv(node: Any) -> dict[str, Any]:
        if isinstance(node, XmlText):
            return {"text": str(node)}
        return {
            "tag": node.tag,
            "attrs": dict(node.attributes),
            "children": [conv(c) for c in node.children],
        }

    return [conv(c) for c in frag.children]


def _text(node: dict[str, Any]) -> str:
    """Concatenated plain text under ``node`` (marks are stringified by
    pycrdt as XML-ish tags, so strip anything tag-shaped)."""
    if "text" in node:
        return re.sub(r"<[^>]+>", "", node["text"])
    return "".join(_text(c) for c in node["children"])


def _walk(nodes: list[dict[str, Any]]):
    for n in nodes:
        yield n
        if "children" in n:
            yield from _walk(n["children"])


def _tags(nodes: list[dict[str, Any]]) -> list[str]:
    return [n["tag"] for n in _walk(nodes) if "tag" in n]


# ---------------------------------------------------------------------------
# Front matter
# ---------------------------------------------------------------------------


def test_front_matter_is_dropped():
    md = "---\ntags: [project, q3]\naliases:\n  - Plan\n---\n# Title\n\nBody text."
    blocks = _tree(md)
    assert [b["tag"] for b in blocks] == ["heading", "paragraph"]
    assert blocks[0]["attrs"]["level"] == "1"
    assert _text(blocks[0]) == "Title"
    assert "tags" not in "".join(_text(b) for b in blocks)


def test_front_matter_crlf_and_bom():
    md = "\ufeff---\r\ntitle: Note\r\n---\r\nHello"
    blocks = _tree(md)
    assert [b["tag"] for b in blocks] == ["paragraph"]
    assert _text(blocks[0]) == "Hello"


def test_leading_rule_that_is_not_front_matter_is_kept():
    # Opens with a thematic break and has a later one — not YAML, so nothing
    # between them may be swallowed.
    md = "---\n\nIntro paragraph.\n\n---\n\nMore."
    blocks = _tree(md)
    assert "horizontalRule" in [b["tag"] for b in blocks]
    assert "Intro paragraph." in "".join(_text(b) for b in blocks)


def test_rule_mid_document_is_not_front_matter():
    md = "Intro\n\n---\ntitle: x\n---\n"
    text = "".join(_text(b) for b in _tree(md))
    assert "Intro" in text


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


def test_gfm_table_becomes_table_nodes():
    md = "| a | b |\n|---|---|\n| 1 | **2** |\n"
    blocks = _tree(md)
    assert [b["tag"] for b in blocks] == ["table"]
    rows = blocks[0]["children"]
    assert [r["tag"] for r in rows] == ["tableRow", "tableRow"]
    assert [c["tag"] for c in rows[0]["children"]] == ["tableHeader", "tableHeader"]
    assert [c["tag"] for c in rows[1]["children"]] == ["tableCell", "tableCell"]
    # Every cell wraps exactly one paragraph (cell content is ``block+``).
    for row in rows:
        for cell in row["children"]:
            assert [p["tag"] for p in cell["children"]] == ["paragraph"]
    assert [_text(c) for c in rows[0]["children"]] == ["a", "b"]
    assert [_text(c) for c in rows[1]["children"]] == ["1", "2"]
    assert "|" not in _text(blocks[0])


def test_table_empty_cells_still_have_a_paragraph():
    blocks = _tree("| A | B |\n|---|---|\n|  |  |")
    body = blocks[0]["children"][1]
    assert [c["tag"] for c in body["children"]] == ["tableCell", "tableCell"]
    for cell in body["children"]:
        assert cell["children"][0]["tag"] == "paragraph"


def test_strikethrough_maps_to_strike_mark():
    html = render_html_from_update(markdown_to_doc_update("a ~~gone~~ b"))
    assert "~~" not in html
    assert "<s>gone</s>" in html or "<del>gone</del>" in html or "<strike>gone</strike>" in html


# ---------------------------------------------------------------------------
# Task lists
# ---------------------------------------------------------------------------


def test_task_list_items_carry_checked():
    md = "- [ ] todo\n- [x] done\n- [X] also done\n"
    blocks = _tree(md)
    assert [b["tag"] for b in blocks] == ["taskList"]
    items = blocks[0]["children"]
    assert [i["tag"] for i in items] == ["taskItem"] * 3
    assert [i["attrs"]["checked"] for i in items] == [False, True, True]
    assert [_text(i) for i in items] == ["todo", "done", "also done"]
    # taskItem content is ``paragraph block*``.
    assert all(i["children"][0]["tag"] == "paragraph" for i in items)


def test_empty_task_item():
    # Templates seed bare ``- [ ]`` lines for the user to fill in.
    blocks = _tree("## Committed\n- [ ] \n\n## Stretch\n- [ ]")
    tasks = [n for n in _walk(blocks) if n.get("tag") == "taskItem"]
    assert len(tasks) == 2
    assert all(t["attrs"]["checked"] is False for t in tasks)
    assert all(_text(t) == "" for t in tasks)


def test_task_item_keeps_inline_marks_and_nested_list():
    md = "- [x] ship **v2**\n  - sub point\n"
    blocks = _tree(md)
    item = blocks[0]["children"][0]
    assert item["tag"] == "taskItem" and item["attrs"]["checked"] is True
    assert _text(item["children"][0]) == "ship v2"
    assert item["children"][1]["tag"] == "bulletList"


def test_mixed_list_splits_into_runs():
    md = "- plain\n- [ ] task\n- [x] done\n- plain again\n"
    blocks = _tree(md)
    assert [b["tag"] for b in blocks] == ["bulletList", "taskList", "bulletList"]
    assert len(blocks[1]["children"]) == 2


def test_bare_bullet_gets_an_empty_paragraph():
    # "- " parses as a childless list item; listItem needs a paragraph.
    blocks = _tree("## Strategy\n- \n")
    item = blocks[1]["children"][0]
    assert item["tag"] == "listItem"
    assert [c["tag"] for c in item["children"]] == ["paragraph"]


def test_bracket_mid_sentence_is_not_a_task():
    blocks = _tree("- Conflicts check: [ ] done\n- [link](http://x)")
    assert [b["tag"] for b in blocks] == ["bulletList"]
    assert "taskItem" not in _tags(blocks)


def test_render_html_marks_task_state():
    html = render_html_from_update(markdown_to_doc_update("- [ ] a\n- [x] b"))
    assert 'data-checked="false"' in html
    assert 'data-checked="true"' in html
    assert "[ ]" not in html and "[x]" not in html


# ---------------------------------------------------------------------------
# Golden: every built-in template converts cleanly
# ---------------------------------------------------------------------------

_TASK_LITERAL = re.compile(r"^\s*\[[ xX]\]")


def _template_markdowns() -> list[tuple[str, str]]:
    from app.workspaces.templates import NOTE_TEMPLATES, TEMPLATES

    out: list[tuple[str, str]] = []
    for key, tpl in TEMPLATES.items():
        for title, md in tpl.notes:
            out.append((f"{key}/{title}", md))
    for key, (title, md) in NOTE_TEMPLATES.items():
        out.append((f"note/{key}", md.replace("{date}", "2026-01-01")))
    return out


@pytest.mark.parametrize("name,md", _template_markdowns(), ids=lambda v: str(v)[:40])
def test_templates_convert_without_literal_gfm(name, md):
    blocks = _tree(md)
    assert blocks, name
    for n in _walk(blocks):
        if "tag" not in n:
            continue
        # No block's own text should still read as raw GFM syntax.
        if n["tag"] in ("paragraph", "heading"):
            t = _text(n)
            assert "| ---" not in t and "|---" not in t, (name, t)
            assert not _TASK_LITERAL.match(t), (name, t)
    if "|---" in md:
        assert "table" in _tags(blocks), name
    if re.search(r"^\s*- \[[ xX]\]", md, re.MULTILINE):
        assert "taskItem" in _tags(blocks), name
