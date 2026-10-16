"""One rule for what counts as an email address (R-136).

Self-hosted accounts often live on internal domains — ``bob@corp.local``,
``x@home.arpa`` — which strict validators reject as special-use. CSV import
accepted them while the add-user form refused them, and every response that
re-validated the address on the way *out* returned a 500, so those users
couldn't even sign in. Inputs now share this lenient check; outputs don't
validate at all.
"""
from __future__ import annotations

import re
from typing import Annotated

from pydantic import AfterValidator

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")
MAX_EMAIL_LENGTH = 320


def normalise_email(value: str) -> str:
    """Trimmed and lower-cased, or ``ValueError`` if it isn't an address."""
    email = (value or "").strip().lower()
    if len(email) > MAX_EMAIL_LENGTH or not _EMAIL_RE.match(email):
        raise ValueError("Enter an email address like name@example.com.")
    local, _, domain = email.partition("@")
    if not local or not domain or domain.startswith(".") or domain.endswith(".") or ".." in domain:
        raise ValueError("Enter an email address like name@example.com.")
    return email


EmailAddress = Annotated[str, AfterValidator(normalise_email)]
