"""Shared password-strength policy for account passwords.

Applied wherever a *new* account password is set — first-run setup, admin
create-user, admin reset, and the self-service change endpoint. Login and
share-link password fields are deliberately NOT gated by this (they check an
existing secret / a different trust model).

Deliberately dependency-free: a length floor, a variety check, and a small
common-password blocklist. This is a floor, not a scorer — for a stronger
gate wire an optional Have-I-Been-Pwned k-anonymity range check at set time
(it needs an outbound call, so it's left as an opt-in follow-up).
"""
from __future__ import annotations

# 12 is the NIST-aligned floor for a human-chosen password with no forced
# composition rules. Long-but-simple passphrases beat short-but-complex ones.
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128

# A tiny blocklist of common/predictable 12+ char passwords (shorter ones are
# already excluded by the length floor). Compared case-insensitively.
_COMMON_PASSWORDS = frozenset(
    {
        "password1234",
        "password123!",
        "passw0rd1234",
        "123456789012",
        "1234567890123",
        "qwertyuiop12",
        "qwertyuiop123",
        "iloveyou1234",
        "adminadmin12",
        "letmein12345",
        "welcome12345",
        "changeme1234",
        "promptly1234",
    }
)


def validate_password_strength(password: str) -> None:
    """Raise ``ValueError`` when ``password`` is too weak for a public host.

    Called from pydantic ``field_validator``s so a bad password surfaces as a
    422 with the message below.
    """
    pw = password or ""
    if len(pw) < MIN_PASSWORD_LENGTH:
        raise ValueError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    if len(pw) > MAX_PASSWORD_LENGTH:
        raise ValueError(
            f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
        )
    # Reject near-uniform strings ("aaaaaaaaaaaa", "ababababab…") which pass
    # the length floor but carry almost no entropy.
    if len(set(pw)) < 5:
        raise ValueError(
            "Password is too repetitive — use a longer, more varied passphrase."
        )
    if pw.lower() in _COMMON_PASSWORDS:
        raise ValueError(
            "That password is too common. Choose something less guessable."
        )
