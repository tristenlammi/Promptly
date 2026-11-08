"""Find stray passwords: the detectors (with the mail that only talks about passwords),
the masking, and that only the asker's own mail, files and photos ever come back."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from app.passwords import stray
from tests.test_passwords import bearer, client, make_user, setup_vault  # noqa: F401
from tests.test_passwords_connections import _mail, _mailbox

DOT = "•"

# ------------------------------------------------------------------ detectors


@pytest.mark.parametrize(
    "body,kind,value",
    [
        ("Hi Ana,\n\nYour account is ready.\nUsername: ana.smith\nTemporary password: Kq7#vR2pLm\n\nPlease change it.", "password", "Kq7#vR2pLm"),
        ("Welcome aboard! Your temporary password is Xb93-kLp2. Sign in at https://portal.acme.test", "password", "Xb93-kLp2"),
        ("Login details\nUser: admin\nPassword:\nTr0ub4dor&3", "password", "Tr0ub4dor&3"),
        ("database:\n  host: db\n  password: s3cr3t-Value", "password", "s3cr3t-Value"),
        ("Hallo Ana,\nPasswort: Hx7-ab99qq\nViele Grüße", "password", "Hx7-ab99qq"),
        ("Guest Wi-Fi\nNetwork: AcmeGuest\nPassword: blue-otter-42", "wifi", "blue-otter-42"),
        ("The wifi password is SunnyDay2024!", "wifi", "SunnyDay2024!"),
        ("WIFI:T:WPA;S:Home Net;P:correct-horse-9;;", "wifi", "correct-horse-9"),
        ("Your new key: sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX9012yz", "api_key", "sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX9012yz"),
        ("API key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "api_key", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"),
        ("token ghp_" + "a1B2" * 9 + " was created", "api_key", "ghp_" + "a1B2" * 9),
        ("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY0000KEY\nDEBUG=true", "env_secrets", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY0000KEY"),
        ("GitHub recovery codes\nKeep them safe.\n\n1a2b3-c4d5e\n6f7g8-h9i0j\nk1l2m-n3o4p\nq5r6s-t7u8v", "recovery_codes", "1a2b3-c4d5e\n6f7g8-h9i0j\nk1l2m-n3o4p\nq5r6s-t7u8v"),
        ("Backup codes\n1. 1234 5678   2. 2345 6789\n3. 3456 7890   4. 4567 8901", "recovery_codes", "1234 5678\n2345 6789\n3456 7890\n4567 8901"),
        ("Set up two-factor authentication\nScan the QR code with your authenticator app, or enter this key: JBSW Y3DP EHPK 3PXP", "totp_secret", "JBSWY3DPEHPK3PXP"),
        ("otpauth://totp/Acme:ana?secret=JBSWY3DPEHPK3PXP&issuer=Acme", "totp_secret", "otpauth://totp/Acme:ana?secret=JBSWY3DPEHPK3PXP&issuer=Acme"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "private_key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"),
    ],
)
def test_finds_secrets(body, kind, value):
    hits = stray.scan_text(body)
    assert [(h.kind, h.value) for h in hits] == [(kind, value)]


def test_username_and_network_come_along():
    assert stray.scan_text("Username: ana.smith\nPassword: Kq7#vR2pLm")[0].username == "ana.smith"
    assert stray.scan_text("SSID: AcmeGuest\nWPA key: blue-otter-42")[0].username == "AcmeGuest"


@pytest.mark.parametrize(
    "subject,body",
    [
        # Marketing that says "password" a lot.
        ("Meet the new Acme Vault", "Forgot your password? Reset it here: https://x.test/reset?token=abc123def456ghi789\nYour password is never shared. Keep your password strong.\nPassword managers are great. Password: Forgotten?"),
        ("Black Friday", "Security tip: your password is your first line of defence.\nPassword: Must be at least 8 characters\nPassword: ********"),
        # A password-reset mail: a link and a code, but no password.
        ("Reset your password", "We received a request to reset your password.\nClick here to reset your password: https://acme.test/reset/8f7d6s5a4b3c\nYour password reset code is 482913\nIf you didn't ask, your password is unchanged."),
        ("Your password was changed", "Hi Ana, your password has been changed. If this wasn't you, reset your password now."),
        # A blog post about passwords.
        ("The 10 worst passwords of 2025", "The most common password is 123456, followed by password and qwerty.\nA good password is long. Never use a password like \"letmein\".\nFor example, password: hunter2 is weak.\nYour password is your first line of defence. Password tips for families."),
        # A code, which Mail codes handles, and numbers that aren't secrets.
        ("Your code", "Your one-time password is 482913. It expires in 10 minutes."),
        ("Invoice 20391", "Total: $1,250.00\nAccount: 99887766\nPayment reference: 882211\nOrder 12345678 shipped."),
        ("Save your backup codes", "If you lose your phone, backup codes let you sign in. Find them in Settings > Security."),
        ("Turn on 2FA", "Two-factor authentication keeps you safe. Open the app and use the secret key screen to start."),
        ("Placeholders", "PASSWORD=changeme\nAPI_KEY=your_api_key_here\nDB_PASSWORD=${DB_PASSWORD}\npassword: <your password>"),
    ],
)
def test_no_false_alarms(subject, body):
    assert stray.scan_text(body, subject=subject) == []


def test_html_mail_reads_as_text():
    from app.passwords.connections import plain_text

    html = "<table><tr><td>Username:</td><td>ana</td></tr><tr><td>Password:</td><td>Zq8!mm2Lw</td></tr></table>"
    hits = stray.scan_text(plain_text("", html))
    assert [h.value for h in hits] == ["Zq8!mm2Lw"]


def test_mask_keeps_a_hint_only():
    assert stray.mask("password") == f"pa{DOT * 4}rd"
    assert stray.mask("Kq7#vR2pLm") == f"Kq{DOT * 4}Lm"
    assert stray.mask("abcdef") == f"a{DOT * 4}"
    assert stray.mask("abc") == DOT * 4
    # The length doesn't show.
    assert len(stray.mask("x" * 40)) == len(stray.mask("x" * 9))
    codes = stray.scan_text("Recovery codes\n1a2b3-c4d5e\n6f7g8-h9i0j\nk1l2m-n3o4p\nq5r6s-t7u8v")[0]
    assert stray.preview(codes) == f"1a{DOT * 4}5e" and "6f7g8" not in stray.preview(codes)
    assert stray.preview(stray.Hit("private_key", "-----BEGIN PRIVATE KEY-----\nMIIE")) == ""


def test_files_by_content_and_name():
    assert [h.kind for h in stray.scan_file("Vault.kdbx", None)] == ["password_store"]
    assert [h.kind for h in stray.scan_file("Passwords.xlsx", None)] == ["password_file"]
    assert stray.scan_file("holiday.xlsx", None) == []
    # Readable, and only talks about passwords: nothing.
    assert stray.scan_file("Password policy.pdf", "Passwords must be 12 characters long. Change them yearly.") == []
    # A browser's export, and the same as a sheet's text.
    csv = "name,url,username,password,note\nAcme,https://acme.test,ana,Pa55word!x,\nBank,https://bank.test,ana,Zz9-qq-11,"
    (hit,) = stray.scan_file("Chrome Passwords.csv", csv)
    assert hit.kind == "password_list" and hit.count == 2 and stray.preview(hit) == ""
    (hit,) = stray.scan_file("logins.xlsx", "## Sheet1\nSite | Username | Password\nNetflix | ana | Hunter-22\nBank | ana | Q9-rr-55")
    assert hit.kind == "password_list" and hit.count == 2
    (hit,) = stray.scan_file("bitwarden_export.json", json.dumps({"items": [{"login": {"username": "a", "password": "Abc-12345"}}, {"login": {"username": "b", "password": "Def-67890"}}]}))
    assert hit.kind == "password_list" and hit.count == 2
    # A file named for codes holds only the codes.
    (hit,) = stray.scan_file("github-recovery-codes.txt", "1a2b3-c4d5e\n6f7g8-h9i0j\nk1l2m-n3o4p\nq5r6s-t7u8v\n")
    assert hit.kind == "recovery_codes" and hit.count == 4
    (hit,) = stray.scan_file(".env", "DATABASE_URL=postgres://db\nDB_PASSWORD=Hq7-zz-91x\nSECRET_KEY=8f7e6d5c4b3a2918\n")
    assert hit.kind == "env_secrets" and hit.count == 2


def test_photos():
    assert [h.kind for h in stray.scan_photo("Enable 2FA\nScan this QR code with Google Authenticator\nCan't scan it?")] == ["totp_qr"]
    # The setup key is readable, so that's the finding instead.
    assert [h.kind for h in stray.scan_photo("Two-factor setup\nScan the QR code\nOr enter this key: JBSW Y3DP EHPK 3PXP")] == ["totp_secret"]
    assert [h.kind for h in stray.scan_photo("BACKUP CODES\n1a2b3-c4d5e 6f7g8-h9i0j\nk1l2m-n3o4p q5r6s-t7u8v")] == ["recovery_codes"]
    assert stray.scan_photo("Beach day! Sunset at 7:42") == []


def test_big_input_is_bounded():
    big = ("lorem ipsum password reminder " * 200 + "\n") * 2000
    assert stray.scan_text(big) == []


# ------------------------------------------------------------------ against the database


async def _scan(db, user):
    from app.passwords.stray_scan import scan_user

    return await scan_user(db, user.id, full=True, budget=60)


async def _file(db, tmp_path, user, name, content: bytes, *, mime="text/plain", content_text=None):
    from app.files.models import UserFile

    path = tmp_path / f"{uuid.uuid4().hex}-{name}"
    path.write_bytes(content)
    row = UserFile(user_id=user.id, filename=name, original_filename=name, mime_type=mime, size_bytes=len(content), storage_path=path.name, content_text=content_text)
    db.add(row)
    await db.flush()
    return row


async def _photo(db, tmp_path, user, words: str):
    from app.photos.models import PhotoAsset

    row = await _file(db, tmp_path, user, f"Screenshot {uuid.uuid4().hex[:6]}.png", b"\x89PNG fake", mime="image/png")
    now = datetime.now(timezone.utc)
    db.add(PhotoAsset(file_id=row.id, user_id=user.id, kind="image", taken_at=now, taken_local=now.replace(tzinfo=None)))
    await db.flush()
    await db.execute(text("INSERT INTO photo_text (file_id, text, model) VALUES (:f, :t, 'test')"), {"f": row.id, "t": words})
    return row


SECRET = "Kq7#vR2pLm"


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path)
    return tmp_path


async def test_finds_only_my_own_and_stores_no_secret(client, db, uploads):
    from app.mail.models import MailMessage

    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    other, g = await _mailbox(db, b.user)
    db.add_all(
        [
            _mail(account, f["inbox"], uid=1, subject="Your new account", body=f"Username: ana\nTemporary password: {SECRET}", sender="it@acme.test"),
            _mail(account, f["inbox"], uid=2, subject="Reset your password", body="Click here to reset your password: https://acme.test/r/abc123def456ghi"),
            _mail(account, f["trash"], uid=3, subject="Old", body="Password: Trashed-Pw-77"),
            _mail(account, f["spam"], uid=4, subject="Win", body="Password: Spammy-Pw-88"),
            _mail(other, g["inbox"], uid=5, subject="Theirs", body="Password: Bobs-Pw-1234"),
        ]
    )
    mine = await _file(db, uploads, a.user, ".env", b"DB_PASSWORD=Hq7-zz-91x\n", mime="application/octet-stream")
    await _file(db, uploads, a.user, "notes.txt", b"Shopping: eggs, milk", content_text="Shopping: eggs, milk")
    theirs = await _file(db, uploads, b.user, "passwords.txt", b"Password: Bobs-File-99", content_text="Password: Bobs-File-99")
    shot = await _photo(db, uploads, a.user, "Enable 2FA\nScan this QR code with your authenticator app")
    await _photo(db, uploads, b.user, "Recovery codes\n1a2b3-c4d5e 6f7g8-h9i0j\nk1l2m-n3o4p q5r6s-t7u8v")
    await db.commit()
    # Only what a owns is read. Something of b's that a can see (shared) is still b's.
    await _scan(db, a.user)

    r = await client.get("/api/passwords/stray", headers=a.h)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    got = sorted((x["source"], x["kind"]) for x in body["findings"])
    assert got == [("file", "env_secrets"), ("mail", "password"), ("photo", "totp_qr")]
    assert body["count"] == 3
    mail = next(x for x in body["findings"] if x["source"] == "mail")
    assert mail["preview"] == f"Kq{DOT * 4}Lm"
    assert mail["where"]["title"] == "Your new account" and "acme.test" in mail["where"]["detail"]
    # The list never carries a whole secret, nor anyone else's.
    raw = r.text
    for s in (SECRET, "Hq7-zz-91x", "Bobs-Pw-1234", "Bobs-File-99", "Trashed-Pw-77", "Spammy-Pw-88"):
        assert s not in raw
    # Nothing secret in the table either: places and kinds only.
    rows = (await db.execute(text("SELECT * FROM pw_stray_findings"))).mappings().all()
    dumped = json.dumps([dict(x) for x in rows], default=str)
    for s in (SECRET, "Hq7-zz-91x", f"Kq{DOT * 4}Lm"):
        assert s not in dumped
    mine_mail = set((await db.execute(select(MailMessage.id).where(MailMessage.account_id == account.id))).scalars())
    assert {x["source_id"] for x in rows} <= mine_mail | {mine.id, shot.id}
    assert theirs.id not in {x["source_id"] for x in rows}

    # b, without scanning, sees nothing of a's; and b's scan finds b's own only.
    assert (await client.get("/api/passwords/stray", headers=b.h)).json()["findings"] == []
    await _scan(db, b.user)
    theirs_found = sorted((x["source"], x["kind"]) for x in (await client.get("/api/passwords/stray", headers=b.h)).json()["findings"])
    assert theirs_found == [("file", "password"), ("mail", "password"), ("photo", "recovery_codes")]
    # And neither can open the other's.
    assert (await client.get(f"/api/passwords/stray/{mail['id']}", headers=b.h)).status_code == 404
    assert (await client.post(f"/api/passwords/stray/{mail['id']}/trash", headers=b.h)).status_code == 404
    assert (await client.post(f"/api/passwords/stray/{mail['id']}/ignore", headers=b.h)).status_code == 404
    # Not without a vault session.
    assert (await client.get("/api/passwords/stray", headers=bearer(a.user))).status_code in (401, 403)


async def test_open_gives_the_secret_then_trash(client, db, uploads):
    from app.files.models import UserFile
    from app.mail.models import MailMessage, MailOp

    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    msg = _mail(account, f["inbox"], uid=7, subject="Your new account", body=f"Username: ana\nTemporary password: {SECRET}\nWelcome!", sender="it@acme.test")
    db.add(msg)
    env = await _file(db, uploads, a.user, ".env", b"DB_PASSWORD=Hq7-zz-91x\n", mime="application/octet-stream")
    await db.commit()
    await _scan(db, a.user)
    found = {x["source"]: x for x in (await client.get("/api/passwords/stray", headers=a.h)).json()["findings"]}

    r = await client.get(f"/api/passwords/stray/{found['mail']['id']}", headers=a.h)
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    d = r.json()
    assert d["secrets"][0]["value"] == SECRET and d["secrets"][0]["username"] == "ana"
    assert d["site"] == "acme.test" and SECRET in d["excerpt"]

    assert (await client.post(f"/api/passwords/stray/{found['mail']['id']}/trash", headers=a.h)).status_code == 204
    await db.refresh(msg)
    assert msg.folder_id == f["trash"].id
    op = (await db.execute(select(MailOp).where(MailOp.account_id == account.id))).scalar_one()
    assert op.kind == "move" and op.target_path == "trash"
    assert (await client.post(f"/api/passwords/stray/{found['file']['id']}/trash", headers=a.h)).status_code == 204
    row = await db.get(UserFile, env.id)
    await db.refresh(row)
    assert row.trashed_at is not None
    assert (await client.get("/api/passwords/stray", headers=a.h)).json()["findings"] == []
    # In the Trash, a rescan doesn't bring them back.
    await _scan(db, a.user)
    assert (await client.get("/api/passwords/stray", headers=a.h)).json()["count"] == 0
    assert (await db.get(MailMessage, msg.id)) is not None


async def test_ignore_is_for_good(client, db, uploads):
    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    db.add(_mail(account, f["inbox"], uid=1, subject="Wi-Fi", body="Network: Home\nPassword: blue-otter-42"))
    await db.commit()
    await _scan(db, a.user)
    (x,) = (await client.get("/api/passwords/stray", headers=a.h)).json()["findings"]
    assert x["kind"] == "wifi"
    assert (await client.post(f"/api/passwords/stray/{x['id']}/ignore", headers=a.h)).status_code == 204
    await _scan(db, a.user)
    body = (await client.get("/api/passwords/stray", headers=a.h)).json()
    assert body["findings"] == [] and body["ignored"] == 1
    assert (await client.get("/api/passwords/stray/count", headers=a.h)).json() == {"count": 0}


async def test_a_subject_holding_the_secret_is_masked_in_the_list(client, db, uploads):
    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    db.add(_mail(account, f["inbox"], uid=1, subject="Your Wi-Fi password is Blue-Otter-42!", body="See you Saturday."))
    await db.commit()
    await _scan(db, a.user)
    r = await client.get("/api/passwords/stray", headers=a.h)
    (x,) = r.json()["findings"]
    assert x["kind"] == "wifi" and "Blue-Otter-42!" not in r.text
    assert x["where"]["title"] == f"Your Wi-Fi password is Bl{DOT * 4}2!"
    # Opened, it's all there.
    assert (await client.get(f"/api/passwords/stray/{x['id']}", headers=a.h)).json()["secrets"][0]["value"] == "Blue-Otter-42!"


async def test_a_finding_whose_source_changed_goes(client, db, uploads):
    a = await setup_vault(client, await make_user(db))
    note = await _file(db, uploads, a.user, "wifi.txt", b"x", content_text="Wi-Fi password: blue-otter-42")
    await db.commit()
    await _scan(db, a.user)
    assert (await client.get("/api/passwords/stray/count", headers=a.h)).json() == {"count": 1}
    note.content_text = "Moved it into Passwords."
    await db.commit()
    assert (await client.get("/api/passwords/stray", headers=a.h)).json()["findings"] == []
    assert (await client.get("/api/passwords/stray/count", headers=a.h)).json() == {"count": 0}


async def test_incremental_by_date(client, db, uploads):
    from app.passwords.stray_scan import PwStrayState, scan_user

    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    db.add(_mail(account, f["inbox"], uid=1, subject="One", body="Password: First-Pw-11", ago=timedelta(days=3)))
    await db.commit()
    await scan_user(db, a.user.id)
    st = await db.get(PwStrayState, a.user.id)
    first = list(st.cursors["mail"])
    assert st.cursors["caught_up"] is True
    # Newer mail is read next time, from where the last pass stopped.
    db.add(_mail(account, f["inbox"], uid=2, subject="Two", body="Password: Second-Pw-22", ago=timedelta(days=1)))
    await db.commit()
    got = await scan_user(db, a.user.id)
    assert got["scanned"] == 1
    await db.refresh(st)
    assert st.cursors["mail"] != first
    assert (await client.get("/api/passwords/stray/count", headers=a.h)).json() == {"count": 2}
    # A limit leaves the rest for the next pass.
    for n in range(5):
        db.add(_mail(account, f["inbox"], uid=10 + n, subject=f"N{n}", body=f"Password: Many-Pw-{n}0{n}"))
    await db.commit()
    got = await scan_user(db, a.user.id, limits={"mail": 2, "file": 10, "photo": 10})
    assert got["scanned"] == 2 and got["caught_up"] is False
    got = await scan_user(db, a.user.id, limits={"mail": 10, "file": 10, "photo": 10})
    assert got["scanned"] == 3 and got["caught_up"] is True


async def test_scan_request(client, db, monkeypatch):
    from app.passwords import stray_scan

    asked: list[uuid.UUID] = []

    async def fake(uid):
        asked.append(uid)

    monkeypatch.setattr(stray_scan, "enqueue_scan", fake)
    a = await setup_vault(client, await make_user(db))
    assert (await client.post("/api/passwords/stray/scan", headers=a.h)).status_code == 202
    assert (await client.get("/api/passwords/stray", headers=a.h)).json()["scanning"] is True
    # Asking again while it runs doesn't start another.
    assert (await client.post("/api/passwords/stray/scan", headers=a.h)).status_code == 202
    assert asked == [a.user.id]
    await stray_scan.run_scan_job(str(a.user.id))
    assert (await client.get("/api/passwords/stray", headers=a.h)).json()["scanning"] is False


async def test_tick_covers_vault_owners_only(db, client, uploads):
    from app.passwords.stray_scan import PwStrayFinding, tick

    a = await setup_vault(client, await make_user(db))
    nobody = await make_user(db)
    for u in (a.user, nobody):
        account, f = await _mailbox(db, u)
        db.add(_mail(account, f["inbox"], uid=1, subject="Hi", body="Password: Tick-Pw-777"))
    await db.commit()
    assert await tick() == 1
    owners = set((await db.execute(select(PwStrayFinding.user_id))).scalars())
    assert owners == {a.user.id}


def test_device_without_mail_scope_gets_no_mail():
    from types import SimpleNamespace

    from app.passwords.stray_scan import _mail_allowed

    assert _mail_allowed(SimpleNamespace(device=None))
    assert not _mail_allowed(SimpleNamespace(device=SimpleNamespace(scopes=["vault"])))
    assert _mail_allowed(SimpleNamespace(device=SimpleNamespace(scopes=["vault", "mail_codes"])))
