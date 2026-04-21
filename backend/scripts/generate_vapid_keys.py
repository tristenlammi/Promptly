"""Generate a VAPID keypair for Web Push.

Run once per deployment::

    python backend/scripts/generate_vapid_keys.py

Emits two blocks on stdout:

* ``VAPID_PUBLIC_KEY`` — the base64url-encoded raw uncompressed
  point (``"BNc..."``). This is what the browser expects as the
  ``applicationServerKey`` argument to ``pushManager.subscribe``.
* ``VAPID_PRIVATE_KEY`` — the PEM-encoded PKCS#8 private key that
  ``pywebpush`` signs JWTs with.

Paste both into your ``.env`` file under the ``# ---- Web Push ----``
section. Rotating the keys invalidates every existing subscription
(every browser will have to re-subscribe), so only rotate when you
have to.

Runtime deps: only ``cryptography``, which is already pinned by
the backend's ``requirements.txt``."""
from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(raw: bytes) -> str:
    """Standard base64url (no padding) — the format browsers want."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate() -> tuple[str, str]:
    """Return a ``(public_key_b64url, private_key_pem)`` tuple.

    The public key is the **uncompressed** SEC1 point (65 bytes
    starting with ``0x04``) base64url-encoded — matching what the
    Web Push spec mandates and what ``pushManager.subscribe``
    accepts.

    The private key is PEM/PKCS#8 which is ``pywebpush``'s default
    input format. Kept as PEM so the operator can inspect the file
    with ``openssl pkey`` if they ever need to verify which key a
    server is running.
    """
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    # 32-byte big-endian X, 32-byte big-endian Y, prefixed with 0x04.
    pub_bytes = b"\x04" + public_numbers.x.to_bytes(
        32, "big"
    ) + public_numbers.y.to_bytes(32, "big")
    public_b64 = _b64url(pub_bytes)

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    return public_b64, pem


def main() -> None:
    pub, priv = generate()
    print("# VAPID keypair — paste into .env (both values) and restart the API.")
    print()
    print(f"VAPID_PUBLIC_KEY={pub}")
    print()
    print("VAPID_PRIVATE_KEY='")
    print(priv.strip())
    print("'")


if __name__ == "__main__":
    main()
