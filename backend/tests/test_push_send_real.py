"""The real send path (no pywebpush mock): a push signed with the VAPID key
as the server stores it, a PEM, reaches the push service. Every other
notification test swaps ``_send_one`` out, which is how a key format
pywebpush couldn't read went unnoticed: every push failed on every device."""
from __future__ import annotations

import base64
import http.server
import threading

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@pytest.fixture
def push_service():
    """A stand-in push service on localhost: records the request, says 201."""
    seen: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen["authorization"] = self.headers.get("Authorization", "")
            seen["encoding"] = self.headers.get("Content-Encoding")
            seen["ttl"] = self.headers.get("TTL")
            seen["urgency"] = self.headers.get("Urgency")
            seen["bytes"] = len(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.send_response(201)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}/push/abc", seen
    finally:
        srv.shutdown()
        srv.server_close()


def _device() -> dict:
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return {"p256dh": _b64(point), "auth": _b64(b"0123456789abcdef")}


def test_a_push_signed_with_the_stored_pem_key_is_sent(push_service):
    from app.bootstrap import _generate_vapid_keypair
    from app.notifications.dispatch import _send_one

    endpoint, seen = push_service
    _public, pem = _generate_vapid_keypair()
    assert pem.startswith("-----BEGIN PRIVATE KEY-----")
    _send_one(
        endpoint=endpoint,
        payload_json='{"title": "Promptly", "body": "hello"}',
        vapid_private_key=pem,
        vapid_contact="mailto:someone@example.com",
        ttl=45,
        urgency="high",
        **_device(),
    )
    assert seen["authorization"].startswith("vapid t=")
    assert seen["encoding"] == "aes128gcm"
    assert seen["ttl"] == "45" and seen["urgency"] == "high"
    assert seen["bytes"] > 0


def test_a_bare_base64_key_from_an_old_env_file_still_works(push_service):
    from app.notifications.dispatch import _send_one

    endpoint, seen = push_service
    key = ec.generate_private_key(ec.SECP256R1())
    raw = _b64(key.private_numbers().private_value.to_bytes(32, "big"))
    _send_one(
        endpoint=endpoint,
        payload_json='{"title": "t", "body": "b"}',
        vapid_private_key=raw,
        vapid_contact="mailto:someone@example.com",
        **_device(),
    )
    assert seen["authorization"].startswith("vapid t=")
