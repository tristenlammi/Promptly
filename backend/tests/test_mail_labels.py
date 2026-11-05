"""Mail labels and rules: only ever yours, and rules really file mail on a real server."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.mail.models import MailFolder, MailLabel, MailMessage, MailOp, MailRule
from app.mail.rules import normalise

from .test_mail import H, _deliver, _live_account, _mailbox, _rows, _sync, client, live, mk_account, mk_message, mk_user, server  # noqa: F401


async def _label(client, u, name="Family") -> str:  # noqa: F811
    r = await client.post("/api/mail/labels", json={"name": name}, headers=H(u))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _numbered(db, account, uid: int, subject: str) -> MailMessage:
    m = await mk_message(db, account, subject=subject)
    m.uid = uid
    await db.commit()
    return m


async def _archive(db, account) -> MailFolder:
    folder = MailFolder(account_id=account.id, path="Archive", name="Archive", role="archive")
    db.add(folder)
    await db.commit()
    return folder


async def test_labels_and_rules_stay_yours(client, db):  # noqa: F811
    owner, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, owner)
    m = await mk_message(db, account)
    label = await _label(client, owner)
    made = await client.post("/api/mail/rules", json={"kind": "from", "value": "sam@example.com", "label_id": label}, headers=H(owner))
    assert made.status_code == 201
    rule = made.json()["id"]
    theirs = await _label(client, other, "Theirs")
    base = f"/api/mail/threads/{account.id}/{m.thread_key}/labels"

    assert (await client.put(f"{base}/{label}", headers=H(owner))).status_code == 204
    # Someone else can't see, use or change any of it.
    assert (await client.get("/api/mail/overview", headers=H(other))).json()["labels"][0]["id"] == theirs
    assert (await client.get(f"/api/mail/threads?label={label}", headers=H(other))).status_code == 200  # no mailbox, so nothing
    their_box = await mk_account(db, other, email="them@example.com")
    assert (await client.get(f"/api/mail/threads?label={label}", headers=H(other))).status_code == 404
    assert (await client.put(f"/api/mail/threads/{their_box.id}/{m.thread_key}/labels/{label}", headers=H(other))).status_code == 404
    assert (await client.patch(f"/api/mail/labels/{label}", json={"name": "x"}, headers=H(other))).status_code == 404
    assert (await client.delete(f"/api/mail/labels/{label}", headers=H(other))).status_code == 404
    assert (await client.put(f"{base}/{theirs}", headers=H(other))).status_code == 404
    assert (await client.delete(f"{base}/{label}", headers=H(other))).status_code == 404
    assert (await client.put(f"{base}/{theirs}", headers=H(owner))).status_code == 404
    assert (await client.delete(f"/api/mail/rules/{rule}", headers=H(other))).status_code == 404
    assert (await client.get("/api/mail/rules", headers=H(other))).json()["rules"] == []
    assert (await client.post("/api/mail/rules", json={"kind": "from", "value": "a@b.co", "label_id": label}, headers=H(other))).status_code == 404
    # Using your own label on someone else's conversation is refused too.
    assert (await client.post("/api/mail/rules", json={"kind": "from", "value": "a@b.co", "label_id": theirs, "thread": {"account_id": str(account.id), "key": m.thread_key}}, headers=H(other))).status_code == 404
    # A preview only counts your own mail.
    assert (await client.post("/api/mail/rules/preview", json={"kind": "from", "value": "sam@example.com"}, headers=H(other))).json()["conversations"] == 0
    assert (await client.post("/api/mail/rules/preview", json={"kind": "from", "value": "sam@example.com"}, headers=H(owner))).json()["conversations"] == 1


async def test_a_labelled_conversation_shows_under_the_label_until_its_binned(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await mk_message(db, account)
    label = await _label(client, u)
    assert (await client.put(f"/api/mail/threads/{account.id}/{m.thread_key}/labels/{label}", headers=H(u))).status_code == 204

    got = (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"]
    assert [t["key"] for t in got] == [m.thread_key] and got[0]["labels"] == [label]
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["labels"][0]["unread"] == 1
    assert (await client.get(f"/api/mail/threads/{account.id}/{m.thread_key}", headers=H(u))).json()["labels"] == [label]

    db.add(MailFolder(account_id=account.id, path="Trash", name="Trash", role="trash"))
    await db.commit()
    assert (await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/action", json={"action": "trash"}, headers=H(u))).status_code == 204
    assert (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"] == []
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["labels"][0]["unread"] == 0


async def test_removing_a_label_keeps_the_mail_and_drops_its_rules(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    await mk_message(db, account)
    label = await _label(client, u)
    await client.post("/api/mail/rules", json={"kind": "from", "value": "sam@example.com", "label_id": label}, headers=H(u))
    assert (await client.delete(f"/api/mail/labels/{label}", headers=H(u))).status_code == 204
    assert await db.scalar(select(MailRule.id).limit(1)) is None
    assert await db.scalar(select(MailLabel.id).limit(1)) is None
    assert await db.scalar(select(MailMessage.id).limit(1)) is not None


async def test_label_names_are_unique_whatever_the_case(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    await _label(client, u, "Family")
    assert (await client.post("/api/mail/labels", json={"name": "  family "}, headers=H(u))).status_code == 409
    assert (await client.post("/api/mail/labels", json={"name": "   "}, headers=H(u))).status_code == 422


@pytest.mark.parametrize("kind,value,expected", [
    ("from", " Sam@Example.com ", "sam@example.com"),
    ("from", "nobody", None),
    ("domain", "@Example.com", "example.com"),
    ("domain", "com", None),
    ("subject", "Invoice", "invoice"),
    ("subject", "ab", None),
    ("anything", "x@y.z", None),
])
def test_what_a_rule_can_look_for(kind, value, expected):
    assert normalise(kind, value) == expected


async def test_a_rule_files_the_email_it_came_from_and_only_that_by_default(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    await _archive(db, account)
    first = await _numbered(db, account, 11, "One")
    second = await _numbered(db, account, 12, "Two")
    label = await _label(client, u)
    body = {"kind": "from", "value": "sam@example.com", "label_id": label, "thread": {"account_id": str(account.id), "key": first.thread_key}}
    assert (await client.post("/api/mail/rules", json=body, headers=H(u))).status_code == 201

    inbox = (await client.get("/api/mail/threads", headers=H(u))).json()["threads"]
    assert [t["key"] for t in inbox] == [second.thread_key]
    under = (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"]
    assert [t["key"] for t in under] == [first.thread_key]
    op = await db.scalar(select(MailOp).limit(1))
    assert op.kind == "move" and op.uids == [11] and op.target_path == "Archive"


async def test_a_rule_can_take_what_already_matches_or_leave_the_inbox_alone(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    await _archive(db, account)
    a = await _numbered(db, account, 11, "Your 100% invoice")
    b = await _numbered(db, account, 12, "Other 100% INVOICE")
    c = await _numbered(db, account, 13, "Your 100 invoice")
    label = await _label(client, u)
    # % means itself, not "anything".
    body = {"kind": "subject", "value": "100% invoice", "label_id": label, "apply_existing": True}
    assert (await client.post("/api/mail/rules", json=body, headers=H(u))).status_code == 201
    under = {t["key"] for t in (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"]}
    assert under == {a.thread_key, b.thread_key}
    assert [t["key"] for t in (await client.get("/api/mail/threads", headers=H(u))).json()["threads"]] == [c.thread_key]
    assert (await client.post("/api/mail/rules", json=body, headers=H(u))).status_code == 201
    assert len((await client.get("/api/mail/rules", headers=H(u))).json()["rules"]) == 1


async def test_a_label_is_a_place_of_its_own(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    archive = await _archive(db, account)
    m = await _numbered(db, account, 11, "Move me")
    bills, family = await _label(client, u, "Bills"), await _label(client, u, "Family")
    thread = f"/api/mail/threads/{account.id}/{m.thread_key}"
    listed = lambda query: client.get(f"/api/mail/threads{query}", headers=H(u))  # noqa: E731

    # Moved: out of the Inbox here and in the mailbox, and not in Archive either.
    assert (await client.put(f"{thread}/labels/{bills}", headers=H(u))).status_code == 204
    assert (await listed("")).json()["threads"] == []
    assert (await listed("?role=archive")).json()["threads"] == []
    assert [t["key"] for t in (await listed(f"?label={bills}")).json()["threads"]] == [m.thread_key]
    op = await db.scalar(select(MailOp).limit(1))
    assert op.kind == "move" and op.target_path == "Archive"
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["folders"][0]["unread"] == 0
    await db.refresh(m)
    assert m.folder_id == archive.id
    # Search still finds it wherever it lives.
    assert len((await listed("?q=Move")).json()["threads"]) == 1

    # One place at a time.
    assert (await client.put(f"{thread}/labels/{family}", headers=H(u))).status_code == 204
    assert (await listed(f"?label={bills}")).json()["threads"] == []
    assert len((await listed(f"?label={family}")).json()["threads"]) == 1

    # Moving it anywhere else takes it out of the label.
    assert (await client.post(f"{thread}/action", json={"action": "inbox"}, headers=H(u))).status_code == 204
    assert (await listed(f"?label={family}")).json()["threads"] == []
    assert len((await listed("")).json()["threads"]) == 1


async def test_removing_a_label_leaves_its_mail_in_archive(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    await _archive(db, account)
    m = await _numbered(db, account, 11, "Keep me")
    label = await _label(client, u)
    await client.put(f"/api/mail/threads/{account.id}/{m.thread_key}/labels/{label}", headers=H(u))
    assert (await client.delete(f"/api/mail/labels/{label}", headers=H(u))).status_code == 204
    assert len((await client.get("/api/mail/threads?role=archive", headers=H(u))).json()["threads"]) == 1


@live
async def test_future_mail_is_filed_in_the_real_mailbox(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    await _sync(account)
    label = await _label(client, u)
    body = {"kind": "domain", "value": "mailtest.example", "label_id": label}
    assert (await client.post("/api/mail/rules", json=body, headers=H(u))).status_code == 201

    _deliver("alice@mailtest.example", subject="Filed")
    await _sync(account)  # Arrives and the rule fires.
    assert (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] == []
    await _sync(account)  # The move lands, and the archive copy is recognised.
    box = _mailbox()
    box.select_folder("INBOX")
    assert box.search(["ALL"]) == []
    box.select_folder("Archive")
    assert len(box.search(["ALL"])) == 1
    box.logout()
    await _sync(account)
    rows = await _rows(db, account)
    assert len(rows) == 1 and rows[0].uid is not None
    under = (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"]
    assert [t["subject"] for t in under] == ["Filed"]


@live
async def test_mail_older_than_the_rule_stays_where_it_is(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    label = await _label(client, u)
    assert (await client.post("/api/mail/rules", json={"kind": "subject", "value": "older", "label_id": label}, headers=H(u))).status_code == 201
    rule = await db.scalar(select(MailRule).limit(1))
    rule.created_at = datetime.now(timezone.utc) + timedelta(hours=1)
    await db.commit()
    _deliver("alice@mailtest.example", subject="Older news")
    await _sync(account)
    assert len((await client.get("/api/mail/threads", headers=H(u))).json()["threads"]) == 1
    assert (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"] == []
    assert await db.scalar(select(MailOp.id).limit(1)) is None


@live
async def test_a_reply_follows_its_conversation_to_the_label_and_still_notifies(client, db, server, monkeypatch):  # noqa: F811
    from app.mail import worker

    told = []

    async def fake(**kw):
        told.append(kw)

    monkeypatch.setattr(worker, "notify_user", fake)
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    first = _deliver("alice@mailtest.example", subject="Talk")
    await _sync(account)
    key = (await _rows(db, account))[0].thread_key
    label = await _label(client, u)
    assert (await client.put(f"/api/mail/threads/{account.id}/{key}/labels/{label}", headers=H(u))).status_code == 204
    await _sync(account)
    _deliver("alice@mailtest.example", subject="Re: Talk", in_reply_to=first)
    await _sync(account)
    await _sync(account)
    assert (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] == []
    under = (await client.get(f"/api/mail/threads?label={label}", headers=H(u))).json()["threads"]
    assert [t["key"] for t in under] == [key] and under[0]["unread"] >= 1
    assert [t["body"] for t in told] == ["Re: Talk"]
    box = _mailbox()
    box.select_folder("INBOX")
    assert box.search(["ALL"]) == []
    box.logout()


@live
async def test_an_attachment_can_still_be_opened_after_moving_to_a_label(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Report", attachment="the report")
    await _sync(account)
    m = (await _rows(db, account))[0]
    label = await _label(client, u)
    await client.put(f"/api/mail/threads/{account.id}/{m.thread_key}/labels/{label}", headers=H(u))
    await _sync(account)
    # As with Gmail's All Mail, which we don't copy: we never learn its new number.
    m = (await _rows(db, account))[0]
    m.uid = None
    await db.commit()
    r = await client.get(f"/api/mail/messages/{m.id}/attachments/{m.attachments[0]['part']}", headers=H(u))
    assert r.status_code == 200 and b"the report" in r.content


# ---- a mailbox's own folders


@pytest.mark.parametrize("path,name", [
    ("Projects", "Projects"),
    ("Homes/Lot 2245", "Homes/Lot 2245"),
    ("[Gmail]/Important", None),
    ("[Google Mail]/Starred", None),
    ("Notes", None),
    ("  ", None),
])
def test_which_folders_become_labels(path, name):
    from app.mail.rules import label_name_for

    assert label_name_for(path) == name


def _copy_to(folder: str, subject: str) -> None:
    """Puts a message in a folder of its own, as Gmail does with a label."""
    from email.message import EmailMessage

    box = _mailbox()
    if not box.folder_exists(folder):
        box.create_folder(folder)
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = "Sam <sam@mailtest.example>", "alice@mailtest.example", subject
    m["Message-ID"] = f"<{subject.replace(' ', '')}@mailtest.example>"
    m.set_content("Filed")
    box.append(folder, m.as_bytes())
    box.logout()


@live
async def test_a_mailbox_folder_shows_as_a_label_and_moves_reach_it(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _copy_to("Projects", "Filed away")
    _deliver("alice@mailtest.example", subject="Loose one")
    await _sync(account)
    await _sync(account)
    overview = (await client.get("/api/mail/overview", headers=H(u))).json()
    projects = next(x for x in overview["labels"] if x["name"] == "Projects")
    assert projects["unread"] == 1
    under = (await client.get(f"/api/mail/threads?label={projects['id']}", headers=H(u))).json()["threads"]
    assert [t["subject"] for t in under] == ["Filed away"]
    # Nothing moved in the mailbox just by showing it.
    box = _mailbox()
    box.select_folder("Projects")
    assert len(box.search(["ALL"])) == 1
    box.select_folder("INBOX")
    assert len(box.search(["ALL"])) == 1
    box.logout()

    # Moved into that label here: into that folder there.
    loose = next(t for t in (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] if t["subject"] == "Loose one")
    assert (await client.put(f"/api/mail/threads/{account.id}/{loose['key']}/labels/{projects['id']}", headers=H(u))).status_code == 204
    await _sync(account)
    await _sync(account)
    box = _mailbox()
    box.select_folder("Projects")
    assert len(box.search(["ALL"])) == 2
    box.select_folder("INBOX")
    assert box.search(["ALL"]) == []
    box.logout()
    assert len((await client.get(f"/api/mail/threads?label={projects['id']}", headers=H(u))).json()["threads"]) == 2

    # Removed here, it stays gone, and the mailbox keeps its folder and its mail.
    assert (await client.delete(f"/api/mail/labels/{projects['id']}", headers=H(u))).status_code == 204
    await _sync(account)
    assert not [x for x in (await client.get("/api/mail/overview", headers=H(u))).json()["labels"] if x["name"] == "Projects"]
    box = _mailbox()
    box.select_folder("Projects")
    assert len(box.search(["ALL"])) == 2
    box.logout()


@live
async def test_a_label_of_your_own_with_the_same_name_is_the_same_label(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    mine = await _label(client, u, "projects")
    _copy_to("Projects", "Filed away")
    await _sync(account)
    await _sync(account)
    labels = (await client.get("/api/mail/overview", headers=H(u))).json()["labels"]
    assert [x["id"] for x in labels] == [mine]
    assert len((await client.get(f"/api/mail/threads?label={mine}", headers=H(u))).json()["threads"]) == 1
