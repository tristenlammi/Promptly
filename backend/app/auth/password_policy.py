"""Shared password-strength policy for account passwords.

Applied wherever a *new* account password is set — first-run setup, admin
create-user, admin reset, and the self-service change endpoint. Login and
share-link password fields are deliberately NOT gated by this (they check an
existing secret / a different trust model).

Deliberately dependency-free: a length floor, number + symbol composition
checks, a variety check, and a small common-password blocklist. This is a
floor, not a scorer — for a stronger
gate wire an optional Have-I-Been-Pwned k-anonymity range check at set time
(it needs an outbound call, so it's left as an opt-in follow-up).
"""
from __future__ import annotations

# Operator-chosen policy: a 10-character floor combined with the
# composition checks below (at least one number and one symbol). The
# composition requirement is what lets the floor sit below the bare
# NIST no-composition recommendation of 12.
MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 128

# A tiny blocklist of common/predictable passwords that would otherwise
# clear the length + composition gates. Compared case-insensitively.
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
        "password12!",
        "password123!",
        "p@ssword123",
        "p@ssw0rd123",
        "qwerty1234!",
        "welcome123!",
        "changeme12!",
        "promptly123!",
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
    if not any(c.isdigit() for c in pw):
        raise ValueError("Password must include at least one number.")
    if not any(not c.isalnum() for c in pw):
        raise ValueError(
            "Password must include at least one symbol (like ! @ # or -)."
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
