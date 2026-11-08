"""Turning what you wrote into an email: quoting, forwarding, signature, attachments."""
from __future__ import annotations

import html as html_lib
import re
from dataclasses import dataclass, field
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from . import parse
from .models import MailAccount, MailMessage

_MIME = re.compile(r"^[a-z0-9.+-]+/[a-z0-9.+-]+$")
_REMOTE = re.compile(r"data-remote-src=")


@dataclass
class File:
    name: str
    mime: str
    data: bytes
    params: dict[str, str] | None = None


@dataclass
class Draft:
    to: list[str]
    cc: list[str]
    subject: str
    text: str
    html: str = ""
    files: list[File] = field(default_factory=list)


def _when(at: datetime) -> str:
    return f"{at:%a %d %b %Y at %H:%M}"


def _who(m: MailMessage) -> str:
    return formataddr((m.from_name, m.from_addr)) if m.from_name else m.from_addr


def _escaped(text: str) -> str:
    return html_lib.escape(text).replace("\n", "<br>")


def _original_html(m: MailMessage) -> str:
    # Pictures were held back for you to read safely. In a sent copy they're just pictures.
    return _REMOTE.sub("src=", m.body_html) if m.body_html else _escaped(m.body_text)


def build(account: MailAccount, draft: Draft, reply_to: MailMessage | None = None, forward: MailMessage | None = None) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr((account.display_name, account.email))
    if draft.to:
        message["To"] = ", ".join(draft.to)
    if draft.cc:
        message["Cc"] = ", ".join(draft.cc)
    message["Subject"] = " ".join(draft.subject.split())
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=account.email.rsplit("@", 1)[-1])
    if reply_to is not None and reply_to.message_id:
        message["In-Reply-To"] = reply_to.message_id
        message["References"] = " ".join(x for x in (reply_to.references, reply_to.message_id) if x)

    text = draft.text.rstrip()
    if draft.html.strip() and parse.html_fits(draft.html):
        rich = parse.safe_html(draft.html)
    else:
        # No HTML, or too much to clean quickly (sending runs in the app, so it would hold everyone up).
        text = text or parse.html_to_text(draft.html)
        rich = _escaped(text)
    if account.signature:
        text += f"\n\n-- \n{account.signature}"
        rich += f"<br><br>-- <br>{_escaped(account.signature)}"
    if reply_to is not None:
        said = "\n".join(f"> {line}" for line in reply_to.body_text.splitlines())
        intro = f"On {_when(reply_to.sent_at)}, {_who(reply_to)} wrote:"
        text += f"\n\n{intro}\n{said}"
        rich += f'<br><br><div>{html_lib.escape(intro)}</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">{_original_html(reply_to)}</blockquote>'
    if forward is not None:
        lines = ["---------- Forwarded message ----------", f"From: {_who(forward)}", f"Date: {_when(forward.sent_at)}", f"Subject: {forward.subject}"]
        text += "\n\n" + "\n".join(lines) + f"\n\n{forward.body_text}"
        rich += "<br><br>" + "<br>".join(html_lib.escape(line) for line in lines) + f"<br><br>{_original_html(forward)}"

    message.set_content(text)
    if draft.html.strip() or reply_to is not None or forward is not None:
        message.add_alternative(rich, subtype="html")
    for f in draft.files:
        mime = f.mime.lower().split(";")[0].strip()
        main, _, sub = mime.partition("/") if _MIME.match(mime) else ("application", "/", "octet-stream")
        if main in ("multipart", "message"):
            main, sub = "application", "octet-stream"
        name = "".join(c for c in f.name if c.isprintable())[:200] or "attachment"
        message.add_attachment(f.data, maintype=main, subtype=sub, filename=name, params=f.params or {})
    return message
