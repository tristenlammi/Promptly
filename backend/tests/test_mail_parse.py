"""Every email is written by a stranger. These check that what reaches the screen
can't run code, phone home, or forge who it's from."""
from __future__ import annotations

from email.message import EmailMessage

import pytest

from app.mail import parse


def build(html: str | None = None, text: str | None = "Hello", **headers: str) -> bytes:
    m = EmailMessage()
    m["From"] = headers.get("from", "Sam Taylor <sam@example.com>")
    m["To"] = headers.get("to", "me@example.com")
    m["Subject"] = headers.get("subject", "Lunch")
    m["Date"] = headers.get("date", "Tue, 03 Nov 2026 10:00:00 +1000")
    m["Message-ID"] = headers.get("message_id", "<a@example.com>")
    if "in_reply_to" in headers:
        m["In-Reply-To"] = headers["in_reply_to"]
    if text is not None:
        m.set_content(text)
    if html is not None:
        if text is None:
            m.set_content(html, subtype="html")
        else:
            m.add_alternative(html, subtype="html")
    return m.as_bytes()


@pytest.mark.parametrize("bad", [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<a href='javascript:alert(1)'>x</a>",
    "<iframe src='https://evil.example'></iframe>",
    "<svg onload=alert(1)></svg>",
    "<form action='https://evil.example'><input name=p></form>",
    "<object data='x'></object>",
    "<meta http-equiv='refresh' content='0;url=https://evil.example'>",
    "<a href='data:text/html,<script>alert(1)</script>'>x</a>",
    "<p style='background:url(javascript:alert(1))'>x</p>",
    "<link rel=stylesheet href='https://evil.example/x.css'>",
    "<base href='https://evil.example/'>",
])
def test_nothing_in_an_email_can_run_or_load(bad):
    cleaned = parse.safe_html(f"<p>Hi</p>{bad}").lower()
    for word in ("<script", "onerror", "javascript:", "<iframe", "onload", "<form", "<object", "<meta", "data:text", "<link", "<base", "<input"):
        assert word not in cleaned


def test_remote_pictures_wait_until_you_ask():
    cleaned = parse.safe_html('<img src="https://track.example/p.gif?u=me" alt="x">')
    assert 'data-remote-src="https://track.example/p.gif?u=me"' in cleaned
    assert ' src="' not in cleaned


def test_a_picture_in_the_email_shows_straight_away():
    cleaned = parse.safe_html('<img src="cid:logo">', {"logo": "data:image/png;base64,AAAA"})
    assert 'src="data:image/png;base64,AAAA"' in cleaned


def test_ordinary_formatting_survives():
    cleaned = parse.safe_html('<table><tr><td style="color: red">Cell</td></tr></table><a href="https://x.example">Link</a>')
    assert "<table>" in cleaned and "color: red" in cleaned and 'href="https://x.example"' in cleaned


def test_the_basics_are_read():
    found = parse.parse(build())
    assert found.from_name == "Sam Taylor" and found.from_addr == "sam@example.com"
    assert found.subject == "Lunch" and found.text.strip() == "Hello"
    assert found.to == [{"name": "", "addr": "me@example.com"}]
    assert found.sent_at.isoformat() == "2026-11-03T10:00:00+10:00"


def test_html_only_mail_still_has_text_to_search_and_preview():
    found = parse.parse(build(html="<p>Big <b>news</b></p><style>p{color:red}</style>", text=None))
    assert "Big" in found.text and "news" in found.text and "color" not in found.text
    assert "Big" in found.snippet


def test_a_preview_leaves_out_the_quoted_reply():
    found = parse.parse(build(text="Sounds good\n\nOn Mon, Sam wrote:\n> old stuff"))
    assert found.snippet == "Sounds good"


def test_attachments_are_listed_and_can_be_fetched():
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = "a@example.com", "b@example.com", "File"
    m.set_content("See attached")
    m.add_attachment(b"PDFDATA", maintype="application", subtype="pdf", filename="report.pdf")
    raw = m.as_bytes()
    found = parse.parse(raw)
    assert [(a["name"], a["mime"], a["size"]) for a in found.attachments] == [("report.pdf", "application/pdf", 7)]
    assert parse.attachment_bytes(raw, found.attachments[0]["part"]) == ("report.pdf", "application/pdf", b"PDFDATA")


def test_a_broken_date_doesnt_lose_the_message():
    assert parse.parse(build(date="not a date")).subject == "Lunch"


def test_garbage_doesnt_crash():
    assert parse.parse(b"\xff\xfe not an email at all").attachments == []


def test_conversation_ids():
    assert parse.message_ids("<a@x> <b@x>", "<c@x>") == ["<a@x>", "<b@x>", "<c@x>"]
    assert parse.thread_key("acc", "<a@x>") == parse.thread_key("acc", "<a@x>")
    assert parse.thread_key("acc", "<a@x>") != parse.thread_key("other", "<a@x>")
