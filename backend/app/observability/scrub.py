"""Take people's content out of exception text before an admin can read it.

Admin → Console → Errors keeps each error's message and stack. Exception
text can quote what someone was doing: an httpx error carries the request
URL with its query (``?q=<an address>``), a provider's 4xx can echo the
prompt, an IMAP error can echo a server reply, an Android crash can name a
file (admin privacy audit G4, G5). Before an error is stored (and before an
exception's text goes to the live log), :func:`scrub_text` removes

* URL query strings and fragments: ``https://x.org/search?q=home`` becomes
  ``https://x.org/search?…``;
* quoted strings longer than 40 characters: ``'…'``.

:func:`scrub_stack` does the same to the lines of a stack trace that hold an
exception's message, and leaves the frame lines (file, line, function, the
source line) alone, so the trace still says where it broke.
"""
from __future__ import annotations

import re

LONG = 40

# A URL (with a scheme) or an absolute path, then ?query or #fragment.
_QUERY = re.compile(
    r"""((?:\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s?#'"<>]*)|(?<![\w.])/[^\s?#'"<>]*)[?#][^\s'"<>)\]]+"""
)
_SINGLE = re.compile(r"'[^'\n]{%d,}'" % (LONG + 1))
_DOUBLE = re.compile(r'"[^"\n]{%d,}"' % (LONG + 1))

# Lines of a trace that are frames, not messages: Python's "  File …" and
# its indented source line, Java's "\tat …" and "... 12 more".
_FRAME = re.compile(r"^(\s+|Traceback \(most recent call last\):|During handling of|The above exception)")


def scrub_text(text: str | None) -> str:
    """``text`` without URL queries and long quoted strings."""
    if not text:
        return text or ""
    out = _QUERY.sub(lambda m: f"{m.group(1)}?…", text)
    out = _SINGLE.sub("'…'", out)
    return _DOUBLE.sub('"…"', out)


def scrub_stack(stack: str | None) -> str | None:
    """A stack trace with its message lines scrubbed (frames untouched)."""
    if not stack:
        return stack
    return "\n".join(line if _FRAME.match(line) else scrub_text(line) for line in stack.split("\n"))


__all__ = ["scrub_stack", "scrub_text"]
