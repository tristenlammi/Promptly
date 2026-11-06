# Writes a KDBX 4 test database with pykeepass, an independent implementation, so our
# reader is checked against someone else's writer. The password and contents are test
# values only. Run in a throwaway container:
#   docker run --rm -v "$PWD/frontend/src/passwords/core/testing:/out" python:3.11-slim \
#     sh -c "pip install -q pykeepass && python /out/../../../../../passwords/tests/make-kdbx-fixture.py"
import shutil

from pykeepass import create_database

kp = create_database("/tmp/fixture.kdbx", password="kdbx test password")
work = kp.add_group(kp.root_group, "Work")
sub = kp.add_group(work, "Deep")
e = kp.add_entry(work, "Mail", "ana@example.com", "pässwörd-1", url="https://mail.example.com", notes="line one\nline two")
e.otp = "otpauth://totp/Mail:ana?secret=JBSWY3DPEHPK3PXP&issuer=Mail"
e.set_custom_property("Pin", "1234", protect=True)
e.save_history()
e.password = "changed-password-2"
kp.add_entry(sub, "Nested", "bob", "nested-pass")
kp.add_entry(kp.root_group, "Root Entry", "root", "root-pass")
kp.save()
shutil.copy("/tmp/fixture.kdbx", "/out/fixture.kdbx")
print("written")
