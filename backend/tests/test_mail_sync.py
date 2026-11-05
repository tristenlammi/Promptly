"""Copying a mailbox: its labels get their mail whatever else goes wrong."""
from __future__ import annotations

import imaplib
from email.message import EmailMessage

import pytest
from sqlalchemy import func, select

from app.mail import imap, parse, rules, worker
from app.mail.models import MailFolder, MailLabel, MailMessage

from .test_mail import client, mk_account  # noqa: F401

pytestmark = pytest.mark.asyncio


def _raw(uid: int, folder: str = "Work") -> bytes:
    m = EmailMessage()
    m["Message-ID"] = f"<{folder}-{uid}@example.com>"
    m["From"] = "Sam <sam@example.com>"
    m["To"] = "me@example.com"
    m["Subject"] = f"{folder} {uid}"
    m["Date"] = "Mon, 02 Nov 2026 09:00:00 +0000"
    m.set_content("Hello")
    return m.as_bytes()


class FakeMailbox:
    """What the worker asks of a mailbox, with no network."""

    def __init__(self, monkeypatch, boxes: dict[str, list[int]]) -> None:
        self.boxes = boxes
        self.selected = ""
        self.fetched: list[int] = []
        self.broken_folders: set[str] = set()
        self.lost_after: int | None = None
        monkeypatch.setattr(imap, "select", self.select)
        monkeypatch.setattr(imap, "new_uids", lambda _c, last, newest: sorted((u for u in boxes[self.selected] if u > last), reverse=True)[:newest])
        monkeypatch.setattr(imap, "batches", lambda _c, uids: [uids[i : i + 2] for i in range(0, len(uids), 2)])
        monkeypatch.setattr(imap, "fetch_messages", self.fetch)
        monkeypatch.setattr(imap, "existing_uids", lambda _c: set(boxes[self.selected]))
        monkeypatch.setattr(imap, "flags_of", lambda _c, uids: {u: [] for u in uids})

    def select(self, _client, path: str, readonly: bool = True) -> int:
        if path in self.broken_folders:
            raise imaplib.IMAP4.error("NO that folder can't be opened")
        self.selected = path
        return 7

    def fetch(self, _client, uids: list[int]):
        if self.lost_after is not None and len(self.fetched) >= self.lost_after:
            raise OSError("connection dropped")
        self.fetched += uids
        return [(u, [], _raw(u, self.selected)) for u in uids]


async def _folder(db, account, path: str, role: str = "other") -> MailFolder:
    f = MailFolder(account_id=account.id, path=path, name=path, role=role)
    db.add(f)
    await db.commit()
    return f


async def _count(db, folder: MailFolder) -> int:
    return await db.scalar(select(func.count()).select_from(MailMessage).where(MailMessage.folder_id == folder.id))


def test_batches_keep_to_a_count_and_a_size():
    mb = 1024 * 1024

    class Sizes:
        def fetch(self, uids, _what):
            return {u: {b"RFC822.SIZE": (20 * mb if u in (1, 2, 3) else 1000)} for u in uids}

    got = imap.batches(Sizes(), list(range(1, 64)))
    assert got[0] == [1, 2] and got[1][0] == 3
    assert all(len(b) <= imap.BATCH for b in got)
    assert [u for b in got for u in b] == list(range(1, 64))


def test_a_message_too_big_to_keep_doesnt_count_against_the_batch():
    class Huge:
        def fetch(self, uids, _what):
            return {u: {b"RFC822.SIZE": 500 * 1024 * 1024} for u in uids}

    assert imap.batches(Huge(), [1, 2]) == [[1, 2]]


async def test_one_folder_failing_doesnt_stop_the_others(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    inbox = await _folder(db, account, "INBOX", "inbox")
    bad = await _folder(db, account, "Broken")
    work = await _folder(db, account, "Work")
    box = FakeMailbox(monkeypatch, {"INBOX": [1], "Broken": [1], "Work": [1, 2, 3]})
    box.broken_folders.add("Broken")
    await worker._sync_folders(None, account.id, every=True)
    assert await _count(db, inbox) == 1
    assert await _count(db, work) == 3
    assert await _count(db, bad) == 0


async def test_a_lost_connection_is_passed_on_so_it_reconnects(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    await _folder(db, account, "Work")
    box = FakeMailbox(monkeypatch, {"Work": [1, 2, 3]})
    box.lost_after = 0
    with pytest.raises(OSError):
        await worker._sync_folders(None, account.id, every=True)


async def test_an_interrupted_folder_keeps_what_it_got_and_carries_on(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    work = await _folder(db, account, "Work")
    box = FakeMailbox(monkeypatch, {"Work": [1, 2, 3, 4, 5]})
    box.lost_after = 2
    with pytest.raises(OSError):
        await worker._sync_folders(None, account.id, every=True)
    assert await _count(db, work) == 2  # saved as it went

    box.lost_after = None
    box.fetched.clear()
    await worker._sync_folders(None, account.id, every=True)
    assert await _count(db, work) == 5
    assert sorted(box.fetched) == [1, 2, 3]  # not the ones it already had


async def test_an_email_the_database_refuses_costs_only_that_email(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    work = await _folder(db, account, "Work")
    FakeMailbox(monkeypatch, {"Work": [1, 2, 3]})
    real = parse.parse

    def awkward(raw: bytes):
        found = real(raw)
        if found.subject == "Work 2":
            found.invite = {"title": "\x00 not storable"}
        return found

    monkeypatch.setattr(parse, "parse", awkward)
    await worker._sync_folders(None, account.id, every=True)
    await db.commit()
    subjects = (await db.execute(select(MailMessage.subject).where(MailMessage.folder_id == work.id))).scalars().all()
    assert sorted(subjects) == ["Work 1", "Work 3"]
    # It isn't tried for ever, and the folder counts as done.
    done = await db.scalar(select(MailFolder.last_uid).where(MailFolder.id == work.id).execution_options(populate_existing=True))
    assert done == 3


async def test_a_new_folder_doesnt_wait_for_the_five_minute_round(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    work = await _folder(db, account, "Work")
    done = await _folder(db, account, "Done")
    done.last_uid, done.oldest_uid = 1, 1
    await db.commit()
    box = FakeMailbox(monkeypatch, {"Work": [1], "Done": [1, 2]})
    await worker._sync_folders(None, account.id, every=False)
    assert await _count(db, work) == 1
    assert await _count(db, done) == 0  # waits for the round
    assert box.fetched == [1]


async def test_your_labels_come_before_sent_and_trash(db, user, monkeypatch):  # noqa: F811
    account = await mk_account(db, user)
    for path, role in (("Trash", "trash"), ("Work", "other"), ("Sent", "sent"), ("INBOX", "inbox")):
        await _folder(db, account, path, role)
    box = FakeMailbox(monkeypatch, {"INBOX": [], "Work": [], "Sent": [], "Trash": []})
    order: list[str] = []
    original = box.select

    def noting(c, path, readonly=True):
        order.append(path)
        return original(c, path, readonly)

    monkeypatch.setattr(imap, "select", noting)
    await worker._sync_folders(None, account.id, every=True)
    assert order[:2] == ["INBOX", "Work"]


async def test_a_label_says_when_its_mail_is_still_coming_and_shows_it_after(db, client, user, monkeypatch):  # noqa: F811
    from app.auth.utils import create_access_token

    account = await mk_account(db, user)
    work = await _folder(db, account, "Work")
    await rules.sync_folder_labels(db, account.id)
    await db.commit()
    h = {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}
    label = await db.scalar(select(MailLabel).where(MailLabel.user_id == user.id, MailLabel.name == "Work"))

    def listed(body):
        return next(x for x in body["labels"] if x["id"] == str(label.id))

    assert listed((await client.get("/api/mail/overview", headers=h)).json())["fetching"] is True

    # The same email in the Inbox and under the label, as Gmail shows it.
    FakeMailbox(monkeypatch, {"Work": [1, 2]})
    await worker._sync_folders(None, account.id, every=True)
    assert listed((await client.get("/api/mail/overview", headers=h)).json())["fetching"] is False
    shown = (await client.get("/api/mail/threads", headers=h, params={"label": str(label.id)})).json()["threads"]
    assert sorted(t["subject"] for t in shown) == ["Work 1", "Work 2"]
    assert await _count(db, work) == 2
