"""Mail labels and rules: only ever yours, and rules really file mail on a real server."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.mail.models import MailFolder, MailLabel, MailMessage, MailOp, MailRule
from app.mail import imap, worker
from app.mail.rules import normalise

from .test_mail import H, _connect, _deliver, _live_account, _mailbox, _rows, _sync, client, live, mk_account, mk_message, mk_user, server  # noqa: F401


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


async def test_labels_nest_by_name_and_their_children_move_with_them(client, db):  # noqa: F811
    owner = await mk_user(db, "nester")
    homes = await _label(client, owner, " Homes ")
    lot = await _label(client, owner, "Homes / Lot  7534")
    plans = await _label(client, owner, "Homes/Lot 7534/Plans")
    other = await _label(client, owner, "Homes Two")

    async def names() -> dict[str, str]:
        rows = (await client.get("/api/mail/overview", headers=H(owner))).json()["labels"]
        return {r["id"]: r["name"] for r in rows}

    assert (await names())[lot] == "Homes/Lot 7534"

    # What's inside goes along; a label that only starts the same doesn't.
    r = await client.patch(f"/api/mail/labels/{homes}", json={"name": "Houses"}, headers=H(owner))
    assert r.status_code == 200, r.text
    assert await names() == {homes: "Houses", lot: "Houses/Lot 7534", plans: "Houses/Lot 7534/Plans", other: "Homes Two"}

    # Moved under another label.
    r = await client.patch(f"/api/mail/labels/{lot}", json={"name": "Homes Two/Lot 7534"}, headers=H(owner))
    assert r.status_code == 200, r.text
    assert (await names())[plans] == "Homes Two/Lot 7534/Plans"

    # Not inside itself.
    r = await client.patch(f"/api/mail/labels/{other}", json={"name": "Homes Two/Lot 7534/Mine"}, headers=H(owner))
    assert r.status_code == 409

    # A child that would land on a label you've got stops the whole move.
    await _label(client, owner, "Elsewhere/Plans")
    r = await client.patch(f"/api/mail/labels/{lot}", json={"name": "Elsewhere"}, headers=H(owner))
    assert r.status_code == 409
    assert "Elsewhere/Plans" in r.json()["detail"]
    assert (await names())[lot] == "Homes Two/Lot 7534"

    # Nor one that would make a child's name too long.
    r = await client.patch(f"/api/mail/labels/{lot}", json={"name": "x" * 58}, headers=H(owner))
    assert r.status_code == 422
    assert (await names())[plans] == "Homes Two/Lot 7534/Plans"

    r = await client.post("/api/mail/labels", json={"name": "/ / "}, headers=H(owner))
    assert r.status_code == 422
    r = await client.post("/api/mail/labels", json={"name": "a" * 40 + "/" + "b" * 40}, headers=H(owner))
    assert r.status_code == 422


async def test_removing_a_parent_leaves_whats_inside(client, db):  # noqa: F811
    owner = await mk_user(db, "parent-remover")
    homes = await _label(client, owner, "Homes")
    lot = await _label(client, owner, "Homes/Lot 1")
    assert (await client.delete(f"/api/mail/labels/{homes}", headers=H(owner))).status_code == 204
    rows = (await client.get("/api/mail/overview", headers=H(owner))).json()["labels"]
    assert [(r["id"], r["name"]) for r in rows] == [(lot, "Homes/Lot 1")]


@live
async def test_an_attachment_opens_while_its_email_is_still_moving(client, db, server):  # noqa: F811
    u = await mk_user(db, "mover", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Payslip", attachment="%PDF-1.4 the payslip")
    await _sync(account)
    m = (await _rows(db, account))[0]
    label = await _label(client, u)
    url = f"/api/mail/messages/{m.id}/attachments/{m.attachments[0]['part']}"

    # Promptly has filed it, but the mailbox hasn't caught up.
    r = await client.put(f"/api/mail/threads/{account.id}/{m.thread_key}/labels/{label}", headers=H(u))
    assert r.status_code == 204, r.text
    pending = (await db.execute(select(MailOp).where(MailOp.account_id == account.id, MailOp.kind == "move"))).scalars().all()
    assert pending, "expected the move to still be waiting"
    r = await client.get(url, headers=H(u))
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"%PDF")

    # And once it has.
    await _sync(account)
    r = await client.get(url, headers=H(u))
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"%PDF")


@live
async def test_an_attachment_is_found_after_the_mailbox_moved_it_elsewhere(client, db, server):  # noqa: F811
    u = await mk_user(db, "mover2", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Payslip", attachment="%PDF-1.4 the payslip")
    await _sync(account)
    m = (await _rows(db, account))[0]
    # Moved from another device, and not noticed here yet.
    c = _mailbox()
    c.select_folder("INBOX")
    c.move(c.search(["ALL"]), "Archive")
    c.logout()
    r = await client.get(f"/api/mail/messages/{m.id}/attachments/{m.attachments[0]['part']}", headers=H(u))
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"%PDF")


def _count_in(folder: str) -> int:
    c = _mailbox()
    c.select_folder(folder, readonly=True)
    n = len(c.search(["ALL"]))
    c.logout()
    return n


async def _moved_twice_setup(client, db, name):  # noqa: F811
    u = await mk_user(db, name, role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Twice")
    await _sync(account)
    m = (await _rows(db, account))[0]
    url = f"/api/mail/threads/{account.id}/{m.thread_key}/action"
    return u, account, url


async def _one_row_in(db, account, folder_path: str) -> None:
    rows = await _rows(db, account)
    assert len(rows) == 1, [r.subject for r in rows]
    folder = await db.get(MailFolder, rows[0].folder_id)
    assert folder.path == folder_path
    assert rows[0].uid is not None


@live
async def test_moved_twice_before_the_mailbox_caught_up_ends_up_at_the_second(client, db, server):  # noqa: F811
    u, account, url = await _moved_twice_setup(client, db, "twice1")
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    assert (await client.post(url, json={"action": "trash"}, headers=H(u))).status_code == 204
    await _sync(account)
    await _sync(account)
    assert (_count_in("INBOX"), _count_in("Archive"), _count_in("Trash")) == (0, 0, 1)
    await _one_row_in(db, account, "Trash")


@live
async def test_moved_again_after_the_first_move_landed_but_before_a_sync(client, db, server):  # noqa: F811
    u, account, url = await _moved_twice_setup(client, db, "twice2")
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    c = await asyncio.to_thread(_connect, account)
    await worker._apply_ops(c, account.id)
    c.logout()
    assert (_count_in("INBOX"), _count_in("Archive")) == (0, 1)
    assert (await client.post(url, json={"action": "trash"}, headers=H(u))).status_code == 204
    await _sync(account)
    await _sync(account)
    assert (_count_in("Archive"), _count_in("Trash")) == (0, 1)
    await _one_row_in(db, account, "Trash")


@live
async def test_undoing_a_move_straight_away_puts_it_back(client, db, server):  # noqa: F811
    u, account, url = await _moved_twice_setup(client, db, "twice3")
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    assert (await client.post(url, json={"action": "inbox"}, headers=H(u))).status_code == 204
    await _sync(account)
    await _sync(account)
    assert (_count_in("INBOX"), _count_in("Archive")) == (1, 0)
    await _one_row_in(db, account, "INBOX")


# ---- a mailbox shaped like Gmail: All Mail instead of an Archive


@pytest.fixture
def gmail_shaped(server):  # noqa: F811
    c = _mailbox()
    for name in ("Archive", "Trash", "Sent"):
        c.delete_folder(name)
    for name in ("[Gmail]/All Mail", "[Gmail]/Trash", "[Gmail]/Sent Mail"):
        c.create_folder(name)
    c.logout()


async def _subjects(client, u, role: str) -> list[str]:  # noqa: F811
    r = await client.get(f"/api/mail/threads?role={role}", headers=H(u))
    assert r.status_code == 200, r.text
    return [t["subject"] for t in r.json()["threads"]]


async def _worker_pass(account) -> None:
    """What the worker really does, which leaves All Mail alone."""
    c = await asyncio.to_thread(_connect, account)
    await worker._refresh_folders(c, account.id)
    await worker._apply_ops(c, account.id)
    await worker._sync_folders(c, account.id, every=True)
    c.logout()


async def _gmail_account(client, db, name: str, subject: str):  # noqa: F811
    u = await mk_user(db, name, role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject=subject)
    await _worker_pass(account)
    m = (await _rows(db, account))[0]
    return u, account, f"/api/mail/threads/{account.id}/{m.thread_key}/action"


@live
async def test_archiving_on_gmail_shows_in_the_archive_and_can_come_back(client, db, gmail_shaped):  # noqa: F811
    u, account, url = await _gmail_account(client, db, "gm1", "Keep this")
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    assert await _subjects(client, u, "inbox") == []
    assert await _subjects(client, u, "archive") == ["Keep this"]
    await _worker_pass(account)
    await _worker_pass(account)
    assert await _subjects(client, u, "archive") == ["Keep this"]
    assert (_count_in("INBOX"), _count_in("[Gmail]/All Mail")) == (0, 1)

    assert (await client.post(url, json={"action": "inbox"}, headers=H(u))).status_code == 204
    await _worker_pass(account)
    await _worker_pass(account)
    assert await _subjects(client, u, "inbox") == ["Keep this"]
    assert await _subjects(client, u, "archive") == []
    assert (_count_in("INBOX"), _count_in("[Gmail]/All Mail")) == (1, 0)


@live
async def test_deleting_from_the_gmail_archive_goes_to_the_trash(client, db, gmail_shaped):  # noqa: F811
    u, account, url = await _gmail_account(client, db, "gm3", "Done with it")
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    await _worker_pass(account)
    assert (await client.post(url, json={"action": "trash"}, headers=H(u))).status_code == 204
    await _worker_pass(account)
    await _worker_pass(account)
    assert await _subjects(client, u, "archive") == []
    assert await _subjects(client, u, "trash") == ["Done with it"]
    assert (_count_in("[Gmail]/All Mail"), _count_in("[Gmail]/Trash")) == (0, 1)


@live
async def test_deleting_on_gmail_shows_in_the_trash(client, db, gmail_shaped):  # noqa: F811
    u, account, url = await _gmail_account(client, db, "gm2", "Bin this")
    assert (await client.post(url, json={"action": "trash"}, headers=H(u))).status_code == 204
    assert await _subjects(client, u, "inbox") == []
    assert await _subjects(client, u, "trash") == ["Bin this"]
    await _worker_pass(account)
    await _worker_pass(account)
    assert await _subjects(client, u, "trash") == ["Bin this"]
    assert (_count_in("INBOX"), _count_in("[Gmail]/Trash")) == (0, 1)


async def test_the_archive_view_is_all_mail_only_where_theres_no_archive(client, db):  # noqa: F811
    u = await mk_user(db, "both")
    gmail, other = await mk_account(db, u, email="me@gmail.example"), await mk_account(db, u, email="me@other.example")
    for account, subject, spots in ((gmail, "From All Mail", [("[Gmail]/All Mail", "all")]), (other, "From Archive", [("Archive", "archive"), ("All", "all")])):
        for path, role in spots:
            folder = MailFolder(account_id=account.id, path=path, name=path, role=role)
            db.add(folder)
            await db.flush()
            m = await mk_message(db, account, subject=f"{subject} {role}")
            m.folder_id = folder.id
        await db.commit()
    assert sorted(await _subjects(client, u, "archive")) == ["From All Mail all", "From Archive archive"]


async def test_a_conversation_only_in_sent_can_still_be_deleted(client, db):  # noqa: F811
    u = await mk_user(db, "sender")
    account = await mk_account(db, u)
    sent = MailFolder(account_id=account.id, path="Sent", name="Sent", role="sent")
    trash = MailFolder(account_id=account.id, path="Trash", name="Trash", role="trash")
    db.add_all([sent, trash])
    await db.flush()
    only_sent = await _numbered(db, account, 41, "Only sent")
    only_sent.folder_id = sent.id
    both = await _numbered(db, account, 42, "Replied to")
    mine = await _numbered(db, account, 43, "Replied to")
    mine.folder_id, mine.thread_key = sent.id, both.thread_key
    keys = only_sent.thread_key, both.thread_key
    await db.commit()

    for key in keys:
        assert (await client.post(f"/api/mail/threads/{account.id}/{key}/action", json={"action": "trash"}, headers=H(u))).status_code == 204
    # Deleted from Sent, it goes. Deleting a conversation you replied to leaves your copy in Sent.
    assert await _subjects(client, u, "sent") == ["Replied to"]
    assert sorted(await _subjects(client, u, "trash")) == ["Only sent", "Replied to"]


def test_the_folder_the_server_marks_wins_over_one_only_named_like_it():
    class Listing:
        def list_folders(self):
            return [
                ((b"\\HasNoChildren",), b"/", "INBOX"),
                ((b"\\HasNoChildren",), b"/", "[Imap]/Trash"),
                ((b"\\HasNoChildren", b"\\Trash"), b"/", "[Gmail]/Bin"),
                ((b"\\HasNoChildren",), b"/", "Archive"),
                ((b"\\HasNoChildren", b"\\All"), b"/", "[Gmail]/All Mail"),
            ]

    roles = {f["path"]: f["role"] for f in imap.folders(Listing())}
    assert roles == {"INBOX": "inbox", "[Imap]/Trash": "other", "[Gmail]/Bin": "trash", "Archive": "other", "[Gmail]/All Mail": "all"}


def test_elsewhere_a_folder_called_archive_is_still_the_archive():
    class Listing:
        def list_folders(self):
            return [((b"\\HasNoChildren",), b"/", "Archive"), ((b"\\HasNoChildren", b"\\All"), b"/", "Virtual/All")]

    assert {f["path"]: f["role"] for f in imap.folders(Listing())} == {"Archive": "archive", "Virtual/All": "all"}


# ---- All Mail copied as the archive


ALL_MAIL = "[Gmail]/All Mail"


def _gmail_delivers(subject: str, labels: tuple[str, ...] = (), inbox: bool = True, **headers: str) -> str:
    """As Gmail keeps mail: in All Mail, and in the Inbox and each label too."""
    message_id = _deliver("alice@mailtest.example", subject=subject, **headers)
    c = _mailbox()
    c.select_folder("INBOX")
    uid = max(c.search(["HEADER", "Message-ID", message_id]))
    c.copy([uid], ALL_MAIL)
    for label in labels:
        c.copy([uid], label)
    if not inbox:
        c.delete_messages([uid])
        c.expunge()
    c.logout()
    return message_id


def _gmail_takes_out_of(folder: str, message_id: str) -> None:
    c = _mailbox()
    c.select_folder(folder)
    c.delete_messages(c.search(["HEADER", "Message-ID", message_id]))
    c.expunge()
    c.logout()


def _gmail_copies(source: str, message_id: str, target: str) -> None:
    c = _mailbox()
    c.select_folder(source)
    c.copy(c.search(["HEADER", "Message-ID", message_id]), target)
    c.logout()


async def _new_gmail_user(db, name: str):
    u = await mk_user(db, name, role="admin")
    return u, await _live_account(db, u)


@live
async def test_mail_already_archived_shows_in_the_archive_and_search(client, db, gmail_shaped):  # noqa: F811
    _gmail_delivers("Old one", inbox=False)
    u, account = await _new_gmail_user(db, "am1")
    await _worker_pass(account)
    assert await _subjects(client, u, "archive") == ["Old one"]
    assert await _subjects(client, u, "inbox") == []
    found = (await client.get("/api/mail/threads?q=Old", headers=H(u))).json()["threads"]
    assert [t["subject"] for t in found] == ["Old one"]


@live
async def test_what_is_in_another_folder_isnt_copied_again(client, db, gmail_shaped, monkeypatch):  # noqa: F811
    c = _mailbox()
    c.create_folder("Homes")
    c.logout()
    _gmail_delivers("In the inbox")
    _gmail_delivers("Under a label", labels=("Homes",), inbox=False)
    _deliver("alice@mailtest.example", subject="I sent this")
    c = _mailbox()
    c.select_folder("INBOX")
    sent = max(c.search(["SUBJECT", "I sent this"]))
    c.copy([sent], "[Gmail]/Sent Mail")
    c.copy([sent], ALL_MAIL)
    c.delete_messages([sent])
    c.expunge()
    c.logout()
    fetched: list[int] = []
    real = imap.fetch_messages

    def noting(client_, uids):
        fetched.extend(uids)
        return real(client_, uids)

    monkeypatch.setattr(imap, "fetch_messages", noting)
    u, account = await _new_gmail_user(db, "am2")
    await _worker_pass(account)
    await _worker_pass(account)
    rows = await _rows(db, account)
    assert sorted(m.subject for m in rows) == ["I sent this", "In the inbox", "Under a label"]
    # Only three emails downloaded, with six copies of them around.
    assert len(fetched) == 3
    assert await _subjects(client, u, "archive") == []


@live
async def test_archived_in_gmail_stays_in_promptly(client, db, gmail_shaped):  # noqa: F811
    message_id = _gmail_delivers("Archived elsewhere")
    u, account = await _new_gmail_user(db, "am3")
    await _worker_pass(account)
    assert await _subjects(client, u, "inbox") == ["Archived elsewhere"]
    before = (await _rows(db, account))[0].id

    _gmail_takes_out_of("INBOX", message_id)
    await _worker_pass(account)
    assert await _subjects(client, u, "inbox") == []
    assert await _subjects(client, u, "archive") == ["Archived elsewhere"]
    rows = await _rows(db, account)
    assert [m.id for m in rows] == [before] and rows[0].uid is not None


@live
async def test_label_taken_off_in_gmail_moves_it_to_the_archive(client, db, gmail_shaped):  # noqa: F811
    c = _mailbox()
    c.create_folder("Homes")
    c.logout()
    message_id = _gmail_delivers("Lot 2245", labels=("Homes",), inbox=False)
    u, account = await _new_gmail_user(db, "am4")
    await _worker_pass(account)
    assert await _subjects(client, u, "archive") == []
    _gmail_takes_out_of("Homes", message_id)
    await _worker_pass(account)
    assert await _subjects(client, u, "archive") == ["Lot 2245"]
    assert len(await _rows(db, account)) == 1


@live
async def test_in_the_inbox_and_a_label_only_loses_the_one_it_left(client, db, gmail_shaped):  # noqa: F811
    c = _mailbox()
    c.create_folder("Homes")
    c.logout()
    message_id = _gmail_delivers("Both", labels=("Homes",))
    u, account = await _new_gmail_user(db, "am5")
    await _worker_pass(account)
    assert len(await _rows(db, account)) == 2
    _gmail_takes_out_of("INBOX", message_id)
    await _worker_pass(account)
    rows = await _rows(db, account)
    assert len(rows) == 1
    assert (await db.get(MailFolder, rows[0].folder_id)).path == "Homes"
    assert await _subjects(client, u, "archive") == []


@live
async def test_moved_back_to_the_inbox_in_gmail_isnt_duplicated(client, db, gmail_shaped):  # noqa: F811
    message_id = _gmail_delivers("Back again", inbox=False)
    u, account = await _new_gmail_user(db, "am6")
    await _worker_pass(account)
    before = (await _rows(db, account))[0].id
    _gmail_copies(ALL_MAIL, message_id, "INBOX")
    await _worker_pass(account)
    rows = await _rows(db, account)
    assert [m.id for m in rows] == [before]
    assert await _subjects(client, u, "inbox") == ["Back again"]
    assert await _subjects(client, u, "archive") == []


@live
async def test_deleted_in_gmail_goes_to_the_trash_once(client, db, gmail_shaped):  # noqa: F811
    in_inbox = _gmail_delivers("From the inbox")
    archived = _gmail_delivers("From the archive", inbox=False)
    u, account = await _new_gmail_user(db, "am7")
    await _worker_pass(account)
    for folder, message_id in (("INBOX", in_inbox), (ALL_MAIL, archived)):
        _gmail_copies(folder, message_id, "[Gmail]/Trash")
    for folder, message_id in (("INBOX", in_inbox), (ALL_MAIL, in_inbox), (ALL_MAIL, archived)):
        _gmail_takes_out_of(folder, message_id)
    await _worker_pass(account)
    await _worker_pass(account)
    assert sorted(await _subjects(client, u, "trash")) == ["From the archive", "From the inbox"]
    assert await _subjects(client, u, "inbox") == []
    assert await _subjects(client, u, "archive") == []
    assert len(await _rows(db, account)) == 2


@live
async def test_deleted_for_good_in_gmail_goes(client, db, gmail_shaped):  # noqa: F811
    in_inbox = _gmail_delivers("Gone from the inbox")
    archived = _gmail_delivers("Gone from the archive", inbox=False)
    u, account = await _new_gmail_user(db, "am8")
    await _worker_pass(account)
    assert len(await _rows(db, account)) == 2
    for folder, message_id in (("INBOX", in_inbox), (ALL_MAIL, in_inbox), (ALL_MAIL, archived)):
        _gmail_takes_out_of(folder, message_id)
    await _worker_pass(account)
    assert await _rows(db, account) == []


@live
async def test_a_conversation_still_in_the_inbox_isnt_in_the_archive_too(client, db, gmail_shaped):  # noqa: F811
    first = _gmail_delivers("Ongoing", inbox=False)
    _gmail_delivers("Re: Ongoing", in_reply_to=first)
    u, account = await _new_gmail_user(db, "am9")
    await _worker_pass(account)
    assert await _subjects(client, u, "inbox") == ["Re: Ongoing"]
    assert await _subjects(client, u, "archive") == []
    m = (await _rows(db, account))[0]
    whole = (await client.get(f"/api/mail/threads/{account.id}/{m.thread_key}", headers=H(u))).json()
    assert len(whole["messages"]) == 2
    # Archiving the rest puts the whole conversation there.
    url = f"/api/mail/threads/{account.id}/{m.thread_key}/action"
    assert (await client.post(url, json={"action": "archive"}, headers=H(u))).status_code == 204
    # Once, whichever of the two is named: they were sent in the same second.
    assert len(await _subjects(client, u, "archive")) == 1


@live
async def test_old_mail_coming_in_sets_off_no_rules_or_notifications(client, db, gmail_shaped, monkeypatch):  # noqa: F811
    told: list[str] = []

    async def noting(account_id, messages):
        told.extend(m.subject for m in messages)

    monkeypatch.setattr(worker, "_announce", noting)
    u, account = await _new_gmail_user(db, "am10")
    await _worker_pass(account)
    label = await _label(client, u)
    made = await client.post("/api/mail/rules", json={"kind": "from", "value": "sam@mailtest.example", "label_id": label}, headers=H(u))
    assert made.status_code == 201
    _gmail_delivers("Skipped the inbox", inbox=False)
    await _worker_pass(account)
    assert told == []
    assert await _subjects(client, u, "archive") == ["Skipped the inbox"]


@live
async def test_new_mail_seen_in_all_mail_first_is_still_announced(client, db, gmail_shaped, monkeypatch):  # noqa: F811
    told: list[str] = []

    async def noting(account_id, messages):
        told.extend(m.subject for m in messages)

    monkeypatch.setattr(worker, "_announce", noting)
    u, account = await _new_gmail_user(db, "am11")
    await _worker_pass(account)
    _gmail_delivers("Just arrived")
    c = await asyncio.to_thread(_connect, account)
    folders = {f.role: f for f in (await db.execute(select(MailFolder).where(MailFolder.account_id == account.id))).scalars()}
    await worker._sync_folder(c, account.id, folders["all"])
    assert await _subjects(client, u, "archive") == ["Just arrived"]
    await worker._sync_folder(c, account.id, folders["inbox"])
    c.logout()
    assert told == ["Just arrived"]
    assert await _subjects(client, u, "inbox") == ["Just arrived"]
    assert len(await _rows(db, account)) == 1


@live
async def test_archiving_here_learns_its_number_in_all_mail(client, db, gmail_shaped):  # noqa: F811
    _gmail_delivers("Number please")
    u, account = await _new_gmail_user(db, "am12")
    await _worker_pass(account)
    m = next(r for r in await _rows(db, account))
    assert (await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/action", json={"action": "archive"}, headers=H(u))).status_code == 204
    # Gmail keeps its old number in All Mail, so it doesn't turn up as something new.
    c = await asyncio.to_thread(_connect, account)
    await worker._apply_ops(c, account.id)
    folder = (await db.execute(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == "all"))).scalars().one()
    c.select_folder(ALL_MAIL, readonly=True)
    folder.last_uid = max(c.search(["ALL"]))
    await db.commit()
    await worker._sync_folders(c, account.id, every=True)
    c.logout()
    assert (await _rows(db, account))[0].uid is not None


@live
async def test_all_mail_isnt_copied_where_theres_a_real_archive(client, db, server):  # noqa: F811
    c = _mailbox()
    c.create_folder(ALL_MAIL)
    c.logout()
    _gmail_delivers("Only once")
    u, account = await _new_gmail_user(db, "am13")
    await _worker_pass(account)
    await _worker_pass(account)
    rows = await _rows(db, account)
    assert [(await db.get(MailFolder, m.folder_id)).role for m in rows] == ["inbox"]
    folder = (await db.execute(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == "all"))).scalars().one()
    assert folder.last_uid == 0


@live
async def test_older_mail_stops_for_the_day_well_before_gmails_limit(client, db, gmail_shaped, monkeypatch):  # noqa: F811
    monkeypatch.setattr(worker, "INITIAL_FROM_ALL_MAIL", 1)
    monkeypatch.setattr(worker, "BACKFILL_BATCH", 1)
    for n in range(3):
        _gmail_delivers(f"Older {n}", inbox=False)
    u, account = await _new_gmail_user(db, "am14")
    await _worker_pass(account)
    assert len(await _rows(db, account)) == 1
    c = await asyncio.to_thread(_connect, account)

    monkeypatch.setattr(worker, "BACKFILL_BYTES_PER_DAY", 1)
    await worker._backfill(c, account.id)
    assert len(await _rows(db, account)) == 1

    # Tomorrow, it carries on.
    worker._downloaded[account.id] = (datetime.now(timezone.utc).date() - timedelta(days=1), 10_000)
    await worker._backfill(c, account.id)
    c.logout()
    assert len(await _rows(db, account)) == 2

