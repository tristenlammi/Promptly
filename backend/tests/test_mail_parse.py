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


# Hostile shapes that made the old one-line regexes rescan to the end of the
# message from every opening: 1 MB of each took from 1.5 minutes to half an hour.
_HOSTILE = {
    "unclosed <script>": "<script>" * 25_600,
    "<img> with no src": "<img " * 40_960,
    "<img> src that never closes": "<img " * 40_958 + 'src="x',
    "unclosed <br": "<br " * 51_200,
    "lone <": "<" * 204_800,
}


def _seconds(work) -> float:
    import time
    start = time.perf_counter()
    work()
    return time.perf_counter() - start


@pytest.mark.parametrize("name", list(_HOSTILE))
def test_hostile_html_turns_into_text_quickly(name):
    # 200 KB: a few milliseconds now; the old patterns took 3 s to over a minute.
    assert _seconds(lambda: parse.html_to_text(_HOSTILE[name])) < 0.5


@pytest.mark.parametrize("name", list(_HOSTILE))
def test_hostile_html_is_prepared_for_cleaning_quickly(name, monkeypatch):
    # Only the regex work before and after bleach is timed here; bleach is stubbed out.
    monkeypatch.setattr(parse.bleach, "clean", lambda text, **_: text)
    assert _seconds(lambda: parse.safe_html(_HOSTILE[name])) < 0.5


@pytest.mark.parametrize("raw", [
    "<p>a<br>b</p><SCRIPT>x</script >c<style>d</STYLE>e",
    "<script>a<script>b</script>c</script>",
    "<svg><script>x</svg>y</script>",
    "<scripts>keep</scripts><noscript>drop</noscript>",
    "<b>x</b> 3 < 4 and <br unclosed",
    "<h3>T</h3 ><h7>u</h7><div>v</div><li>w",
])
def test_quick_tag_handling_matches_the_plain_patterns(raw):
    import html as html_lib
    import re
    expect = re.sub(r"<(script|style|head|title|iframe|object|embed|svg|math|template|noscript)\b.*?</\1\s*>", " ", raw, flags=re.I | re.S)
    expect = re.sub(r"<(br|/p|/div|/tr|/li|/h[1-6])\b[^>]*>", "\n", expect, flags=re.I)
    expect = html_lib.unescape(re.sub(r"<[^>]+>", " ", expect))
    expect = re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t\xa0]+", " ", expect)).strip()
    assert parse.html_to_text(raw) == expect


@pytest.mark.parametrize("raw", [
    '<img alt="a>b" src="https://t.example/p.gif"><IMG SRC=\'cid:logo\'>',
    '<img <img src="https://x.example/a.png">',
    '<img alt=x> src="no" <img data-src="y" src="z">',
    '<img src="https://a.example/x.png" src=\'cid:logo\'>',
])
def test_quick_image_handling_matches_the_plain_pattern(raw, monkeypatch):
    import re
    monkeypatch.setattr(parse.bleach, "clean", lambda text, **_: text)
    seen: list[str] = []
    monkeypatch.setattr(parse.html, "unescape", lambda s: seen.append(s) or s)
    parse.safe_html(raw, {"logo": "data:image/png;base64,AAAA"})
    plain = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1""", re.I | re.S)
    assert seen == [m.group(2).strip() for m in plain.finditer(raw)]
