"""Suggestion mode (Stage 6 stretch): suggested insertions and deletions
survive the HTML snapshot (who and when included) and export to Word as
its own tracked changes, ready to accept or reject there."""
from __future__ import annotations

import io
import zipfile


def test_suggestions_survive_the_snapshot_and_become_word_tracked_changes():
    from app.files.docx_writer import html_to_docx
    from app.files.document_render import sanitize_document_html

    raw = (
        '<p>We meet on '
        '<span data-suggest="del" data-id="s1" data-author="Sam" data-author-id="u1" data-at="2026-10-16T09:30:12.345Z" class="suggestion-del">Monday</span>'
        '<span data-suggest="ins" data-id="s2" data-author="Sam" data-author-id="u1" data-at="2026-10-16T09:30:15.000Z" class="suggestion-ins">Tuesday</span>'
        ' at noon.<span data-suggest="ins" data-evil="x" onclick="alert(1)">!</span></p>'
    )
    clean = sanitize_document_html(raw)
    assert 'data-suggest="del"' in clean and 'data-author="Sam"' in clean and 'data-at="2026-10-16T09:30:12.345Z"' in clean
    assert "onclick" not in clean and "data-evil" not in clean

    data = html_to_docx(clean, title="Plan")
    xml = zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml").decode()
    assert '<w:del w:id="1" w:author="Sam" w:date="2026-10-16T09:30:12Z">' in xml
    assert "<w:delText" in xml and ">Monday</w:delText>" in xml
    assert '<w:ins w:id="2" w:author="Sam" w:date="2026-10-16T09:30:15Z">' in xml and ">Tuesday</w:t>" in xml
    # Plain text around them stays plain.
    assert "at noon." in xml
