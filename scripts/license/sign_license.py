#!/usr/bin/env python3
"""Mint a self-host license. Run per sale (needs the private key).

  LICENSE_PRIVATE_KEY=<b64> python scripts/license/sign_license.py \
      --customer "Acme Corp" --seats 20 --days 365

Prints the license token — give it to the customer; they set it as
``LICENSE_KEY`` (or paste it in Admin → License). ``--days 0`` = perpetual (no
expiry). The token is verified offline by the instance against the baked-in
public key, so nothing here phones home.
"""
import argparse
import base64
import json
import os
import time


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def main() -> None:
    p = argparse.ArgumentParser(description="Sign a self-host license token.")
    p.add_argument("--customer", required=True, help="Customer / org name.")
    p.add_argument("--seats", type=int, required=True, help="Max active accounts.")
    p.add_argument(
        "--days", type=int, default=365, help="Validity in days (0 = perpetual)."
    )
    p.add_argument("--tier", default="self-host")
    p.add_argument(
        "--private-key",
        default=os.environ.get("LICENSE_PRIVATE_KEY", ""),
        help="Base64 Ed25519 private key (or set LICENSE_PRIVATE_KEY).",
    )
    a = p.parse_args()
    if not a.private_key:
        raise SystemExit("Provide --private-key or set LICENSE_PRIVATE_KEY.")
    if a.seats < 1:
        raise SystemExit("--seats must be >= 1.")

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    priv = Ed25519PrivateKey.from_private_bytes(base64.b64decode(a.private_key))
    now = int(time.time())
    payload = {
        "v": 1,
        "customer": a.customer,
        "seats": a.seats,
        "tier": a.tier,
        "iat": now,
    }
    if a.days > 0:
        payload["exp"] = now + a.days * 86400

    msg = _b64url(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    sig = _b64url(priv.sign(msg.encode()))
    print(f"{msg}.{sig}")


if __name__ == "__main__":
    main()
