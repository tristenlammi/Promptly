"""Keeps the local copy in step with each mailbox, and sends what's due.

``python -m app.mail.worker``: its own container, so slow mail servers never get
in the way of the app. One task per account. New mail is looked for every 20
seconds, other folders every 5 minutes, and changes you make go out within seconds.
A failure is shown on the account and retried, and never stops other accounts.
"""
from __future__ import annotations

import asyncio
import imaplib
import logging
import os
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

import aiosmtplib
from sqlalchemy import delete, func, select, update

import app.db_models  # noqa: F401 — every FK target, in a bare worker process
from app.auth.models import User
from app.auth.utils import decrypt_secret
from app.database import SessionLocal
from app.net.internal_hosts import may_reach_private_network

from app.notifications.dispatch import notify_user

from . import imap, parse, rules, search, triage
from .models import MailAccount, MailFolder, MailMessage, MailOp, MailOutbox, MailSnooze

logger = logging.getLogger("promptly.mail.worker")

INITIAL_PER_FOLDER = 500
PER_SYNC = 200
FLAG_WINDOW = 2000
TICK_S = 3
INBOX_EVERY_S = 20
FOLDERS_EVERY_S = 300
MAX_OP_ATTEMPTS = 5
MAX_SEND_ATTEMPTS = 5
BACKFILL_BATCH = 100
# Older mail comes in gradually, up to this much per folder. Postgres holds the
# text of everything, so a big mailbox takes real disk space.
HISTORY_PER_FOLDER = int(os.environ.get("MAIL_HISTORY_PER_FOLDER", "20000"))
# Gmail shuts off IMAP for a while past 2500 MB downloaded in a day, so older mail
# stops well short and carries on tomorrow. Your new mail isn't held back by it.
BACKFILL_BYTES_PER_DAY = int(os.environ.get("MAIL_BACKFILL_BYTES_PER_DAY", str(1024 * 1024 * 1024)))
# Most of All Mail comes in as older mail, which counts against that.
INITIAL_FROM_ALL_MAIL = 100
ANNOUNCE_WITHIN = timedelta(days=1)
# New mail can reach All Mail just before we look in the Inbox.
JUST_ARRIVED = timedelta(minutes=30)
# Looked up one at a time, so archiving thousands elsewhere is caught up on gradually.
REHOME_PER_PASS = 200
NUMBERS_PER_PASS = 50
MAX_ANNOUNCED = 3


def _server(account: MailAccount, owner_private: bool) -> imap.Server:
    return imap.Server(
        account.imap_host, account.imap_port, account.imap_security, account.username,
        decrypt_secret(account.secret_encrypted), owner_private, account.cert_pin,
    )


# Today's downloads per mailbox. Starting over if the worker restarts is fine: it's a
# margin well below the real limit, not an exact count.
_downloaded: dict[uuid.UUID, tuple[date, int]] = {}


def _count_download(account_id: uuid.UUID, size: int) -> None:
    today = datetime.now(timezone.utc).date()
    day, total = _downloaded.get(account_id, (today, 0))
    _downloaded[account_id] = (today, size + (total if day == today else 0))


def _enough_for_today(account_id: uuid.UUID) -> bool:
    _count_download(account_id, 0)
    return _downloaded[account_id][1] >= BACKFILL_BYTES_PER_DAY


async def _set_status(account_id: uuid.UUID, status: str, detail: str = "", synced: bool = False) -> None:
    values: dict = {"status": status, "status_detail": detail[:300]}
    if synced:
        values["last_sync_at"] = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        await db.execute(update(MailAccount).where(MailAccount.id == account_id).values(**values))
        await db.commit()


async def _thread_for(db, account_id: uuid.UUID, found: parse.Parsed) -> str:
    """The conversation this belongs to: whichever an earlier message it mentions
    is in, or a new one named after its first message."""
    mentioned = parse.message_ids(found.references, found.in_reply_to)
    if mentioned:
        known = await db.scalar(
            select(MailMessage.thread_key).where(MailMessage.account_id == account_id, MailMessage.message_id.in_(mentioned)).limit(1)
        )
        if known:
            return known
    return parse.thread_key(account_id, (mentioned[0] if mentioned else found.message_id) or secrets.token_hex(8))


async def _announce(account_id: uuid.UUID, messages: list[MailMessage]) -> None:
    """A few at once get a line each. A flood gets one line."""
    async with SessionLocal() as db:
        account = await db.get(MailAccount, account_id)
    if account is None or not account.notify:
        return
    now = datetime.now(timezone.utc)
    fresh = [m for m in messages if not m.seen and now - m.sent_at < ANNOUNCE_WITHIN]
    if len(fresh) > MAX_ANNOUNCED:
        await notify_user(user_id=account.user_id, category="mail", title=f"{len(fresh)} new emails", body=account.email, url="/mail", tag=f"mail-{account.id}", inbox=False)
        return
    for m in fresh:
        await notify_user(
            user_id=account.user_id, category="mail", title=m.from_name or m.from_addr, body=m.subject or "(No subject)",
            url=f"/mail?open={account.id}/{m.thread_key}", tag=f"mail-{m.thread_key}", inbox=False,
        )


async def _store(account_id: uuid.UUID, folder_id: uuid.UUID, items: list[tuple[int, list[bytes], bytes]], announce: bool = False) -> None:
    parsed = await asyncio.to_thread(lambda: [(uid, flags, parse.parse(raw)) for uid, flags, raw in items])
    arrived: list[MailMessage] = []
    async with SessionLocal() as db:
        folder = await db.get(MailFolder, folder_id)
        # Oldest first, so replies find the conversation their parent started.
        for uid, flags, found in sorted(parsed, key=lambda row: row[2].sent_at):
            lowered = {f.lower() for f in flags}
            state = {"seen": b"\\seen" in lowered, "flagged": b"\\flagged" in lowered, "answered": b"\\answered" in lowered}
            # Something you moved here: the same message, now with its real number.
            moved = None
            if found.message_id:
                moved = await db.scalar(
                    select(MailMessage).where(MailMessage.folder_id == folder_id, MailMessage.uid.is_(None), MailMessage.message_id == found.message_id).limit(1)
                )
            if moved is not None:
                moved.uid = uid
                continue
            # Put back here from All Mail, elsewhere: the same email, not a second one.
            archived = None
            if found.message_id and folder.role != "all":
                archived = await db.scalar(
                    select(MailMessage).join(MailFolder, MailFolder.id == MailMessage.folder_id)
                    .where(MailMessage.account_id == account_id, MailFolder.role == "all", MailMessage.message_id == found.message_id).limit(1)
                )
            if archived is not None:
                archived.folder_id, archived.uid, archived.seen, archived.flagged, archived.answered = folder_id, uid, state["seen"], state["flagged"], state["answered"]
                if folder.role == "inbox" and datetime.now(timezone.utc) - archived.sent_at < JUST_ARRIVED:
                    arrived.append(archived)
                continue
            exists = await db.scalar(select(MailMessage.id).where(MailMessage.folder_id == folder_id, MailMessage.uid == uid))
            if exists:
                continue
            # One email the database won't take can't cost you the rest of the folder.
            try:
                async with db.begin_nested():
                    message = MailMessage(
                        account_id=account_id, folder_id=folder_id, uid=uid, thread_key=await _thread_for(db, account_id, found),
                        message_id=found.message_id, in_reply_to=found.in_reply_to, references=found.references, subject=found.subject,
                        from_name=found.from_name, from_addr=found.from_addr, to_addrs=found.to, cc_addrs=found.cc, sent_at=found.sent_at,
                        snippet=found.snippet.replace("\x00", ""), body_text=found.text.replace("\x00", ""), body_html=found.html.replace("\x00", ""), html_clipped=found.html_clipped,
                        attachments=found.attachments, unsubscribe=found.unsubscribe, reply_to=found.reply_to, invite=found.invite, **state,
                    )
                    db.add(message)
                    await db.flush()
            except Exception as e:  # noqa: BLE001 — logged without its contents
                logger.warning("Skipped an email that couldn't be saved: %s", type(e).__name__)
                continue
            arrived.append(message)
        quiet = await rules.apply_to_new(db, account_id, folder, arrived)
        if folder.role == "inbox" and arrived:
            # A reply brings a snoozed conversation straight back.
            await db.execute(delete(MailSnooze).where(MailSnooze.account_id == account_id, MailSnooze.thread_key.in_({m.thread_key for m in arrived})))
        await db.commit()
    # What a rule filed doesn't interrupt you. A reply in a labelled conversation does.
    if announce and folder.role == "inbox":
        await _announce(account_id, [m for m in arrived if m.id not in quiet])


async def _new_to_us(client, account_id: uuid.UUID, folder_id: uuid.UUID, uids: list[int]) -> list[int]:
    """All Mail holds everything again, so only what we don't have in another folder,
    found out without downloading the rest."""
    headers = await asyncio.to_thread(imap.message_id_headers, client, uids)
    ids = {uid: parse.message_id_of(raw) for uid, raw in headers.items()}
    wanted = []
    async with SessionLocal() as db:
        have = (await db.execute(
            select(MailMessage).where(MailMessage.account_id == account_id, MailMessage.message_id.in_({m for m in ids.values() if m}))
        )).scalars().all()
        by_id = {m.message_id: m for m in have}
        for uid in uids:
            message_id = ids.get(uid)
            if message_id is None:
                continue
            row = by_id.get(message_id)
            if row is None or not message_id:
                wanted.append(uid)
            elif row.folder_id == folder_id and row.uid is None:
                # Archived from here, and this is its number.
                row.uid = uid
        await db.commit()
    return wanted


async def _copy(client, account_id: uuid.UUID, folder_id: uuid.UUID, uids: list[int], announce: bool = False) -> None:
    """A batch at a time, saved as it goes, so a big folder needs little memory and
    picks up where it left off if it's interrupted."""
    async with SessionLocal() as db:
        held = set((await db.execute(select(MailMessage.uid).where(MailMessage.folder_id == folder_id, MailMessage.uid.in_(uids)))).scalars())
        folder = await db.get(MailFolder, folder_id)
    wanted = [u for u in uids if u not in held]
    if wanted and folder.role == "all":
        wanted = await _new_to_us(client, account_id, folder_id, wanted)
    if not wanted:
        return
    for batch in await asyncio.to_thread(imap.batches, client, wanted):
        items = await asyncio.to_thread(imap.fetch_messages, client, batch)
        _count_download(account_id, sum(len(raw) for _, _, raw in items))
        await _store(account_id, folder_id, items, announce=announce)


async def _sync_folder(client, account_id: uuid.UUID, folder: MailFolder) -> None:
    validity = await asyncio.to_thread(imap.select, client, folder.path)
    last_uid = folder.last_uid
    # Been through here before, even if it was empty then. Otherwise everything is
    # old mail arriving, not new mail, and nobody wants hundreds of notifications.
    known = last_uid > 0 or folder.oldest_uid != 0
    if folder.uidvalidity and folder.uidvalidity != validity:
        known = False
        # The provider renumbered this folder: what we hold no longer lines up.
        async with SessionLocal() as db:
            await db.execute(delete(MailMessage).where(MailMessage.folder_id == folder.id))
            await db.execute(update(MailFolder).where(MailFolder.id == folder.id).values(oldest_uid=0))
            await db.commit()
        last_uid = 0
    first_time = INITIAL_FROM_ALL_MAIL if folder.role == "all" else INITIAL_PER_FOLDER
    uids = await asyncio.to_thread(imap.new_uids, client, last_uid, first_time if last_uid == 0 else PER_SYNC)
    if uids:
        await _copy(client, account_id, folder.id, uids, announce=known)
        last_uid = max(last_uid, max(uids))
    async with SessionLocal() as db:
        values: dict = {"uidvalidity": validity, "last_uid": last_uid}
        if not known:
            values["oldest_uid"] = min(uids) if uids else 1
        await db.execute(update(MailFolder).where(MailFolder.id == folder.id).values(**values))
        rows = (await db.execute(
            select(MailMessage.id, MailMessage.uid, MailMessage.seen, MailMessage.flagged, MailMessage.answered, MailMessage.message_id)
            .where(MailMessage.folder_id == folder.id, MailMessage.uid.is_not(None))
            .order_by(MailMessage.uid.desc()).limit(FLAG_WINDOW)
        )).all()
        pending = await db.scalar(select(MailOp.id).where(MailOp.account_id == account_id, MailOp.folder_path == folder.path).limit(1))
        await db.commit()
    # Changes on the way out would look like the server disagreeing, so wait for them.
    if not rows or pending:
        return
    remote = await asyncio.to_thread(imap.existing_uids, client)
    flags = await asyncio.to_thread(imap.flags_of, client, [r.uid for r in rows if r.uid in remote])
    async with SessionLocal() as db:
        lowest = min(r.uid for r in rows)
        gone = [r for r in rows if r.uid not in remote and r.uid >= lowest]
        for r in rows:
            if r.uid not in flags:
                continue
            lowered = {f.lower() for f in flags[r.uid]}
            state = (b"\\seen" in lowered, b"\\flagged" in lowered, b"\\answered" in lowered)
            if state != (r.seen, r.flagged, r.answered):
                await db.execute(update(MailMessage).where(MailMessage.id == r.id).values(seen=state[0], flagged=state[1], answered=state[2]))
        await _gone_from(client, db, account_id, folder, gone)
        await db.commit()


async def _gone_from(client, db, account_id: uuid.UUID, folder: MailFolder, gone: list) -> None:
    """No longer in this folder. Where All Mail is the archive it may only have been
    archived, or had its label taken off, somewhere else. In which case it's still yours."""
    archive = await rules.archive_folder(db, account_id)
    if archive is None or archive.role != "all" or folder.role == "all":
        if gone:
            await db.execute(delete(MailMessage).where(MailMessage.id.in_([r.id for r in gone])))
        return
    for r in gone[:REHOME_PER_PASS]:
        elsewhere = r.message_id and await db.scalar(
            select(MailMessage.id).where(MailMessage.account_id == account_id, MailMessage.message_id == r.message_id, MailMessage.id != r.id).limit(1)
        )
        uid = None if elsewhere else await asyncio.to_thread(imap.find_uid, client, archive.path, r.message_id)
        taken = uid and await db.scalar(select(MailMessage.id).where(MailMessage.folder_id == archive.id, MailMessage.uid == uid))
        if uid and not taken:
            await db.execute(update(MailMessage).where(MailMessage.id == r.id).values(folder_id=archive.id, uid=uid))
        else:
            # In the Trash, say, where it'll be copied like anything else. Or deleted for good.
            await db.execute(delete(MailMessage).where(MailMessage.id == r.id))


async def _learn_archive_numbers(client, account_id: uuid.UUID, folder: MailFolder) -> None:
    """An email keeps its old number in All Mail when archived, so it never shows up as
    new. With its number, we can see if it's later deleted somewhere else."""
    async with SessionLocal() as db:
        if await db.scalar(select(MailOp.id).where(MailOp.account_id == account_id).limit(1)):
            return
        rows = (await db.execute(
            select(MailMessage).where(MailMessage.folder_id == folder.id, MailMessage.uid.is_(None), MailMessage.message_id != "").limit(NUMBERS_PER_PASS)
        )).scalars().all()
        for row in rows:
            uid = await asyncio.to_thread(imap.find_uid, client, folder.path, row.message_id)
            if uid and not await db.scalar(select(MailMessage.id).where(MailMessage.folder_id == folder.id, MailMessage.uid == uid)):
                row.uid = uid
        await db.commit()


def _connection_lost(e: Exception) -> bool:
    """Nothing more can be done on this connection, as opposed to one folder being a problem."""
    return isinstance(e, (OSError, imaplib.IMAP4.abort))


def _copied(folder: MailFolder, folders: list[MailFolder]) -> bool:
    """All Mail is a view of the other folders, unless it's the only archive there is."""
    if folder.role == "all":
        return not any(f.role == "archive" for f in folders)
    return folder.role not in imap.SKIP_ROLES


def _never_copied(folder: MailFolder) -> bool:
    return folder.last_uid == 0 and folder.oldest_uid == 0


async def _sync_folders(client, account_id: uuid.UUID, every: bool) -> None:
    """Inbox first, then your own folders and labels, then the rest. A folder that
    hasn't been copied yet doesn't wait for its turn, and one that fails doesn't stop
    those after it: it's tried again next time."""
    async with SessionLocal() as db:
        folders = (await db.execute(select(MailFolder).where(MailFolder.account_id == account_id))).scalars().all()
    # All Mail last, so what's in the others doesn't get copied from it first.
    for folder in sorted(folders, key=lambda f: (f.role == "all", f.role != "inbox", f.role != "other")):
        if not _copied(folder, folders) or not (every or folder.role == "inbox" or _never_copied(folder)):
            continue
        try:
            await _sync_folder(client, account_id, folder)
            if folder.role == "all":
                await _learn_archive_numbers(client, account_id, folder)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — the path alone: it can name people
            if _connection_lost(e):
                raise
            logger.warning("Couldn't copy one mail folder: %s", type(e).__name__, exc_info=True)


async def _backfill(client, account_id: uuid.UUID) -> None:
    """A little more of your older mail, so search reaches back. One folder at a time."""
    if _enough_for_today(account_id):
        return
    async with SessionLocal() as db:
        every_folder = (await db.execute(select(MailFolder).where(MailFolder.account_id == account_id))).scalars().all()
    folders = [f for f in every_folder if f.last_uid > 0 and f.oldest_uid != 1]
    for folder in sorted(folders, key=lambda f: (f.role == "all", f.role != "inbox")):
        if not _copied(folder, every_folder):
            continue
        async with SessionLocal() as db:
            held = await db.scalar(select(func.count()).select_from(MailMessage).where(MailMessage.folder_id == folder.id))
            lowest = await db.scalar(select(func.min(MailMessage.uid)).where(MailMessage.folder_id == folder.id))
        below = folder.oldest_uid or lowest or folder.last_uid
        older: list[int] = []
        try:
            if held < HISTORY_PER_FOLDER:
                await asyncio.to_thread(imap.select, client, folder.path)
                older = await asyncio.to_thread(imap.older_uids, client, below, BACKFILL_BATCH)
            if older:
                await _copy(client, account_id, folder.id, older)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — the next folder still gets its turn
            if _connection_lost(e):
                raise
            logger.warning("Couldn't copy older mail from one folder: %s", type(e).__name__)
            continue
        async with SessionLocal() as db:
            await db.execute(update(MailFolder).where(MailFolder.id == folder.id).values(oldest_uid=min(older) if older else 1))
            await db.commit()
        return


async def _refresh_folders(client, account_id: uuid.UUID) -> None:
    listed = await asyncio.to_thread(imap.folders, client)
    async with SessionLocal() as db:
        have = {f.path: f for f in (await db.execute(select(MailFolder).where(MailFolder.account_id == account_id))).scalars()}
        seen = set()
        for row in listed:
            seen.add(row["path"])
            current = have.get(row["path"])
            if current is None:
                db.add(MailFolder(account_id=account_id, path=row["path"], name=row["name"][:200], role=row["role"]))
            elif current.role != row["role"]:
                current.role = row["role"]
        for path, folder in have.items():
            if path not in seen:
                await db.delete(folder)
        await db.flush()
        await rules.sync_folder_labels(db, account_id)
        await db.commit()


async def _apply_ops(client, account_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        ops = (await db.execute(select(MailOp).where(MailOp.account_id == account_id).order_by(MailOp.created_at).limit(50))).scalars().all()
        for op in ops:
            try:
                if op.kind == "move_found":
                    missing = await asyncio.to_thread(imap.move_found, client, op.folder_path, list(op.uids), op.target_path)
                    if missing:
                        # The move before this one hasn't landed yet: look again next time.
                        op.uids = missing
                        op.attempts += 1
                        if op.attempts >= MAX_OP_ATTEMPTS:
                            await db.delete(op)
                        await db.commit()
                        continue
                else:
                    await asyncio.to_thread(imap.apply_op, client, op.kind, op.folder_path, list(op.uids), op.target_path)
                await db.delete(op)
            except Exception as e:  # noqa: BLE001 — a bad change shouldn't hold up the rest
                op.attempts += 1
                logger.warning("Mail change %s failed: %s", op.kind, type(e).__name__)
                if op.attempts >= MAX_OP_ATTEMPTS:
                    await db.delete(op)
            await db.commit()


async def _smtp_send(account: MailAccount, raw: bytes, recipients: list[str]) -> None:
    password = decrypt_secret(account.secret_encrypted)
    if not account.cert_pin:
        await aiosmtplib.send(
            raw, sender=account.email, recipients=recipients, hostname=account.smtp_host, port=account.smtp_port,
            use_tls=account.smtp_security == "ssl", start_tls=account.smtp_security == "starttls",
            username=account.username, password=password, timeout=60,
        )
        return
    context = imap.pinned_context()
    link = aiosmtplib.SMTP(hostname=account.smtp_host, port=account.smtp_port, use_tls=account.smtp_security == "ssl", start_tls=False, tls_context=context, timeout=60)
    await link.connect()
    try:
        if account.smtp_security == "starttls":
            await link.starttls(tls_context=context)
        imap.check_pin(link.get_transport_info("ssl_object").getpeercert(True), account.cert_pin)
        await link.login(account.username, password)
        await link.sendmail(account.email, recipients, raw)
    finally:
        link.close()


async def _send_due(client, account: MailAccount, allow_private: bool) -> None:
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        due = (await db.execute(
            select(MailOutbox).where(MailOutbox.account_id == account.id, MailOutbox.status == "waiting", MailOutbox.send_at <= now).limit(10)
        )).scalars().all()
        for item in due:
            raw = item.raw.encode("utf-8", "surrogateescape")
            # From here on it can't be undone, so undo has to say so.
            item.status = "sending"
            await db.commit()
            try:
                await asyncio.to_thread(imap.check_host, account.smtp_host, allow_private)
                await _smtp_send(account, raw, list(item.recipients))
            except Exception as e:  # noqa: BLE001 — shown on the message; retried a few times
                item.attempts += 1
                item.error = "Couldn't send this. It'll be tried again." if item.attempts < MAX_SEND_ATTEMPTS else "Couldn't send this message."
                item.status = "failed" if item.attempts >= MAX_SEND_ATTEMPTS else "waiting"
                item.send_at = now + timedelta(seconds=30 * item.attempts)
                logger.warning("Sending failed: %s", type(e).__name__)
                await db.commit()
                continue
            item.status = "sent"
            item.error = ""
            await db.commit()
            # Gmail files what it sends by itself.
            if account.provider != "gmail":
                sent = await db.scalar(select(MailFolder.path).where(MailFolder.account_id == account.id, MailFolder.role == "sent").limit(1))
                if sent:
                    try:
                        await asyncio.to_thread(imap.append_sent, client, sent, raw)
                    except Exception as e:  # noqa: BLE001 — it did send
                        logger.warning("Couldn't file a sent message: %s", type(e).__name__)
        await db.execute(delete(MailOutbox).where(MailOutbox.account_id == account.id, MailOutbox.status == "sent", MailOutbox.send_at < now - timedelta(days=1)))
        await db.commit()


async def _settle_interrupted_sends(account_id: uuid.UUID) -> None:
    """The worker stopped mid-send, so it may or may not have gone. Say so rather
    than risk sending it twice."""
    async with SessionLocal() as db:
        await db.execute(
            update(MailOutbox).where(MailOutbox.account_id == account_id, MailOutbox.status == "sending")
            .values(status="failed", error="This may not have sent. Check Sent before trying again.")
        )
        await db.commit()


async def run_account(account_id: uuid.UUID) -> None:
    await _settle_interrupted_sends(account_id)
    backoff = 10
    while True:
        client = None
        try:
            async with SessionLocal() as db:
                account = await db.get(MailAccount, account_id)
                if account is None:
                    return
                owner = await db.get(User, account.user_id)
                allow_private = may_reach_private_network(owner)
                server = _server(account, allow_private)
            client = await asyncio.to_thread(imap.connect, server)
            await _refresh_folders(client, account_id)
            last_inbox = last_all = 0.0
            backoff = 10
            loop = asyncio.get_running_loop()
            while True:
                await _apply_ops(client, account_id)
                await _send_due(client, account, allow_private)
                now = loop.time()
                if now - last_inbox >= INBOX_EVERY_S:
                    every = now - last_all >= FOLDERS_EVERY_S
                    if every:
                        await _refresh_folders(client, account_id)
                    await _sync_folders(client, account_id, every)
                    await _backfill(client, account_id)
                    await _set_status(account_id, "ok", synced=True)
                    last_inbox = now
                    last_all = now if every else last_all
                await asyncio.to_thread(client.noop)
                await asyncio.sleep(TICK_S)
        except asyncio.CancelledError:
            raise
        except imap.MailError as e:
            await _set_status(account_id, "error", str(e))
        except Exception as e:  # noqa: BLE001 — try again; one account can't take down the rest
            logger.warning("Mail sync failed: %s", type(e).__name__, exc_info=True)
            await _set_status(account_id, "error", "Lost the connection to this mailbox. Trying again.")
        finally:
            if client is not None:
                try:
                    await asyncio.to_thread(client.logout)
                except Exception:  # noqa: BLE001
                    pass
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 300)


async def wake_snoozed() -> int:
    """Back in your Inbox, unread, with a nudge."""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        due = (await db.execute(select(MailSnooze).where(MailSnooze.until <= now).limit(50))).scalars().all()
        woken: list[tuple[uuid.UUID, MailMessage]] = []
        for snooze in due:
            latest = await db.scalar(
                select(MailMessage).join(MailFolder, MailFolder.id == MailMessage.folder_id)
                .where(MailMessage.account_id == snooze.account_id, MailMessage.thread_key == snooze.thread_key, MailFolder.role == "inbox")
                .order_by(MailMessage.sent_at.desc()).limit(1)
            )
            await db.delete(snooze)
            if latest is None:
                continue
            latest.seen = False
            if latest.uid is not None:
                path = await db.scalar(select(MailFolder.path).where(MailFolder.id == latest.folder_id))
                db.add(MailOp(account_id=snooze.account_id, kind="unseen", folder_path=path, uids=[latest.uid]))
            woken.append((snooze.account_id, latest))
        await db.commit()
        for account_id, m in woken:
            account = await db.get(MailAccount, account_id)
            if account is not None and account.notify:
                await notify_user(
                    user_id=account.user_id, category="mail", title=f"Back from snooze: {m.from_name or m.from_addr}", body=m.subject or "(No subject)",
                    url=f"/mail?open={account_id}/{m.thread_key}", tag=f"mail-{m.thread_key}", inbox=False,
                )
    return len(due)


async def _run_snoozes() -> None:
    while True:
        try:
            await wake_snoozed()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — try again next time round
            logger.warning("Snooze check failed: %s", type(e).__name__)
        await asyncio.sleep(30)


async def main() -> None:
    running: dict[uuid.UUID, asyncio.Task] = {}
    # Each keeps going for as long as this does.
    helpers = [asyncio.create_task(job()) for job in (search.run_indexer, triage.run_triage, _run_snoozes)]  # noqa: F841
    while True:
        async with SessionLocal() as db:
            ids = set((await db.execute(select(MailAccount.id))).scalars().all())
        for account_id in ids - running.keys():
            running[account_id] = asyncio.create_task(run_account(account_id))
        for account_id in running.keys() - ids:
            running.pop(account_id).cancel()
        for account_id, task in list(running.items()):
            if task.done():
                running.pop(account_id)
        await asyncio.sleep(10)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
