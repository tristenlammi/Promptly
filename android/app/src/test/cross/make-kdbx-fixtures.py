# Writes import-fixtures/large.kdbx and chacha-argon2id.kdbx with pykeepass, an independent
# implementation, so the readers are checked against someone else's writer. pykeepass is only
# used here, to make files in tests. The password and contents are test values. Run it in a
# throwaway container, from android/app/src/test/cross:
#   docker run --rm -v "$PWD/import-fixtures:/out" -v "$PWD/make-kdbx-fixtures.py:/make.py:ro" \
#     python:3.11-slim sh -c "pip install -q pykeepass && python /make.py"
import shutil

from pykeepass import PyKeePass, create_database
from pykeepass.kdbx_parsing.kdbx4 import kdf_uuids

PASSWORD = "kdbx test password"

# More protected values than fit in one 4 KiB run of the inner stream.
kp = create_database("/tmp/large.kdbx", password=PASSWORD)
bulk = kp.add_group(kp.root_group, "Bulk")
for i in range(300):
    kp.add_entry(bulk, f"Entry {i:03d}", f"user{i:03d}", f"bulk-test-password-{i:03d}-with-some-length", url=f"https://s{i:03d}.example")
kp.save()
shutil.copy("/tmp/large.kdbx", "/out/large.kdbx")

# ChaCha20 for the outer cipher, and Argon2id. pykeepass's default is AES and Argon2d.
path = "/tmp/chacha-argon2id.kdbx"
kp = create_database(path, password=PASSWORD)
e = kp.add_entry(kp.root_group, "Alpha", "ana", "pw-chacha-argon2id.kdbx-1", url="https://alpha.example")
e.set_custom_property("Pin", "1234", protect=True)
kp.add_entry(kp.root_group, "Beta", "bob", "pw-beta-2")
header = kp.kdbx.header.value.dynamic_header
header.cipher_id.data = "chacha20"
header.encryption_iv.data = bytes(range(12))
params = header.kdf_parameters.data.dict
params["$UUID"].value = kdf_uuids["argon2id"]
params["M"].value = 8 * 1024 * 1024
params["I"].value = 3
kp.save()
back = PyKeePass(path, password=PASSWORD)
assert (back.encryption_algorithm, back.kdf_algorithm) == ("chacha20", "argon2id")
shutil.copy(path, "/out/chacha-argon2id.kdbx")
print("written")
