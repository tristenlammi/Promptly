"""The secrets a box carries: its key (baked in when it's prepared) and the
claim code on its card. Only their sha256 is stored."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import uuid

# No I, L, O, U, 0 or 1: nothing that reads two ways on a printed card.
_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
CLAIM_LEN = 12
SETUP_PREFIX = "pbox1."


def new_key() -> str:
    return secrets.token_urlsafe(32)


def new_claim_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(CLAIM_LEN))
    return "-".join(raw[i : i + 4] for i in range(0, CLAIM_LEN, 4))


def clean_claim_code(typed: str) -> str | None:
    """What they typed or scanned, as the bare 12 characters; None if it
    can't be a code. Spaces, dashes and case don't matter."""
    raw = re.sub(r"[^A-Za-z0-9]", "", typed or "").upper()
    if len(raw) != CLAIM_LEN or any(c not in _ALPHABET for c in raw):
        return None
    return raw


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def claim_digest(code: str) -> str | None:
    raw = clean_claim_code(code)
    return digest("claim:" + raw) if raw else None


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


def setup_string(server: str, box_id: uuid.UUID, key: str) -> str:
    """The one thing pasted into the box when it's prepared: where to dial
    and who it is."""
    body = json.dumps({"s": server.rstrip("/"), "b": str(box_id), "k": key}, separators=(",", ":"))
    return SETUP_PREFIX + base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")
