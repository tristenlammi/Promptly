"""A Secure Send link carries its key after the #. If someone posted one through Rooms or
Mail, an assistant reading that text mustn't get the key along with it, so a page or an
email can't talk it into opening the Send."""
from __future__ import annotations

import re

_SEND_LINK = re.compile(r"(/passwords/send/[0-9a-fA-F-]{36})#[A-Za-z0-9_-]+")


def strip_send_keys(text: str) -> str:
    if "/passwords/send/" not in text:
        return text
    return _SEND_LINK.sub(r"\1#(key hidden)", text)
