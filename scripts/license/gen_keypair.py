#!/usr/bin/env python3
"""Generate an Ed25519 license-signing keypair. Run ONCE.

  python scripts/license/gen_keypair.py

- Keep the PRIVATE key secret (a password manager / secrets store). You use it
  with ``sign_license.py`` to mint each customer's license. If it leaks, anyone
  can forge licenses — rotate by generating a new pair and re-baking the public
  key.
- Set the PUBLIC key as ``LICENSE_PUBLIC_KEY`` on every self-host build (it's
  public — safe to commit as the shipped default). Instances verify licenses
  against it offline.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> None:
    priv = Ed25519PrivateKey.generate()
    priv_raw = priv.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    pub_raw = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    print("PRIVATE KEY  (keep secret — use with sign_license.py):")
    print("  " + base64.b64encode(priv_raw).decode())
    print()
    print("PUBLIC KEY   (set LICENSE_PUBLIC_KEY / bake into the app):")
    print("  " + base64.b64encode(pub_raw).decode())


if __name__ == "__main__":
    main()
