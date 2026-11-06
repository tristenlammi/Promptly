"""Talking to a mailbox: standard IMAP and SMTP, so any provider works.

All of this blocks, and the worker runs it in threads. A host you type in is
checked before every connection, so a mail account can't be used to reach this
server's own network or the cloud's metadata address.
"""
from __future__ import annotations

import hashlib
import ipaddress
import re
import smtplib
import socket
import ssl
from dataclasses import dataclass
from typing import Any

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError

from app.net.safe_fetch import assert_url_is_safe

TIMEOUT_S = 30
BATCH = 25
# Bigger than this and we keep the headers, and fetch the rest when it's opened.
MAX_BODY_BYTES = 25 * 1024 * 1024
# How much is held in memory at once while copying mail. A label full of big
# attachments shouldn't be able to run the worker out of memory.
BATCH_BYTES = 48 * 1024 * 1024

PRESETS: dict[str, dict[str, Any]] = {
    "gmail": {
        "imap": ("imap.gmail.com", 993, "ssl"), "smtp": ("smtp.gmail.com", 465, "ssl"),
        "note": "Gmail needs an app password: turn on 2-Step Verification, then create one in your Google account.",
    },
    "icloud": {
        "imap": ("imap.mail.me.com", 993, "ssl"), "smtp": ("smtp.mail.me.com", 587, "starttls"),
        "note": "iCloud needs an app-specific password from your Apple account.",
    },
    "fastmail": {
        "imap": ("imap.fastmail.com", 993, "ssl"), "smtp": ("smtp.fastmail.com", 465, "ssl"),
        "note": "Fastmail needs an app password from its settings.",
    },
    "yahoo": {
        "imap": ("imap.mail.yahoo.com", 993, "ssl"), "smtp": ("smtp.mail.yahoo.com", 465, "ssl"),
        "note": "Yahoo needs an app password from its account security page.",
    },
}
# No settings that would work, so say why instead of letting it fail.
NOTES: dict[str, dict[str, Any]] = {
    **{d: {
        "note": "Proton encrypts your mail, so other apps reach it through Proton Mail Bridge. Run Bridge on a computer this server can reach, then enter that computer's address and the password Bridge shows you.",
        "imap": {"host": "", "port": 1143, "security": "starttls"}, "smtp": {"host": "", "port": 1025, "security": "starttls"},
    } for d in ("proton.me", "protonmail.com", "protonmail.ch", "pm.me")},
    **{d: {
        "note": "Outlook and Hotmail no longer accept passwords from other mail apps, and Promptly can't sign in to them yet. You can set up forwarding from Outlook to another mailbox you've connected here.",
    } for d in ("outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.com.au", "hotmail.com.au", "live.com.au")},
}
DOMAINS = {
    "gmail.com": "gmail", "googlemail.com": "gmail", "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud",
    "fastmail.com": "fastmail", "yahoo.com": "yahoo", "yahoo.com.au": "yahoo",
}
_SPECIAL = {
    b"\\inbox": "inbox", b"\\sent": "sent", b"\\drafts": "drafts", b"\\trash": "trash",
    b"\\junk": "spam", b"\\archive": "archive", b"\\all": "all", b"\\flagged": "starred", b"\\important": "starred",
}
_NAMES = {
    "inbox": "inbox", "sent": "sent", "sent items": "sent", "sent mail": "sent", "drafts": "drafts", "draft": "drafts",
    "trash": "trash", "deleted": "trash", "deleted items": "trash", "bin": "trash", "spam": "spam", "junk": "spam",
    "junk email": "spam", "archive": "archive", "archives": "archive", "all mail": "all",
}
# Views of mail that lives in another folder: copying them would show it twice.
SKIP_ROLES = {"all", "starred"}


class MailError(Exception):
    """Something to show the person, in their words."""


class UntrustedCertificate(MailError):
    """A server on your own network using its own certificate. You can agree to it."""

    def __init__(self, fingerprint: str) -> None:
        super().__init__("This mail server is on your own network and uses its own certificate. Check it's the one you expect before trusting it.")
        self.fingerprint = fingerprint


@dataclass
class Server:
    host: str
    port: int
    security: str
    username: str
    password: str
    allow_private: bool = False
    cert_pin: str = ""


def check_host(host: str, allow_private: bool) -> None:
    try:
        assert_url_is_safe(f"https://{host}/", allow_private=allow_private)
    except ValueError as e:
        raise MailError("That mail server's address isn't allowed.") from e


def fingerprint_of(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest().upper()


def check_pin(der: bytes | None, pin: str) -> None:
    """Before any password is sent: is this the certificate you agreed to?"""
    if not der or fingerprint_of(der) != pin:
        raise MailError("This mail server's certificate has changed. If you didn't change it, something may be in the way.")


def pinned_context() -> ssl.SSLContext:
    """Only ever used with ``check_pin``, which is what does the checking here."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _on_this_network(host: str) -> bool:
    """A public server with an untrusted certificate is a warning sign, not a choice to offer."""
    try:
        found = socket.getaddrinfo(host, None)
    except OSError:
        return False
    addresses = [ipaddress.ip_address(row[4][0].split("%")[0]) for row in found]
    return bool(addresses) and all(a.is_private or a.is_loopback for a in addresses)


def _peer(client: IMAPClient) -> bytes | None:
    return client._imap.sock.getpeercert(True)  # noqa: SLF001 — the only way to read it


def _imap_certificate(server: Server) -> str:
    context = pinned_context()
    client = IMAPClient(server.host, port=server.port, ssl=server.security == "ssl", ssl_context=context, timeout=TIMEOUT_S)
    if server.security == "starttls":
        client.starttls(context)
    der = _peer(client)
    client.shutdown()
    return fingerprint_of(der or b"")


def check_smtp_pin(host: str, port: int, security: str, pin: str) -> None:
    """Agreeing to a certificate covers both sides, so make sure it's the same one."""
    context = pinned_context()
    if security == "ssl":
        link = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_S, context=context)
    else:
        link = smtplib.SMTP(host, port, timeout=TIMEOUT_S)
        link.starttls(context=context)
    try:
        check_pin(link.sock.getpeercert(True), pin)
    finally:
        link.close()


def connect(server: Server) -> IMAPClient:
    check_host(server.host, server.allow_private)
    context = pinned_context() if server.cert_pin else ssl.create_default_context()
    try:
        client = IMAPClient(server.host, port=server.port, ssl=server.security == "ssl", ssl_context=context, timeout=TIMEOUT_S)
        if server.security == "starttls":
            client.starttls(context)
        if server.cert_pin:
            check_pin(_peer(client), server.cert_pin)
        client.login(server.username, server.password)
    except IMAPClient.Error as e:
        raise MailError("The mail server didn't accept that email and password.") from e
    except ssl.SSLCertVerificationError as e:
        if server.allow_private and _on_this_network(server.host):
            raise UntrustedCertificate(_imap_certificate(server)) from e
        raise MailError("Couldn't make a secure connection to that mail server.") from e
    except ssl.SSLError as e:
        raise MailError("Couldn't make a secure connection to that mail server.") from e
    except OSError as e:
        raise MailError("Couldn't reach that mail server. Check its address and port.") from e
    return client


def role_of(flags: tuple[bytes, ...], path: str) -> str:
    for flag in flags:
        role = _SPECIAL.get(flag.lower())
        if role:
            return role
    leaf = re.split(r"[/.]", path)[-1].strip().lower()
    return "inbox" if path.upper() == "INBOX" else _NAMES.get(leaf, "other")


def folders(client: IMAPClient) -> list[dict[str, str]]:
    out = []
    for flags, delimiter, path in client.list_folders():
        if any(f.lower() == b"\\noselect" for f in flags):
            continue
        separator = delimiter.decode() if isinstance(delimiter, bytes) else (delimiter or "/")
        out.append({"path": path, "name": path.split(separator)[-1] if separator else path, "role": role_of(flags, path)})
    return out


def _uidvalidity(selected: dict[bytes, Any]) -> int:
    return int(selected.get(b"UIDVALIDITY", 0) or 0)


def select(client: IMAPClient, path: str, readonly: bool = True) -> int:
    return _uidvalidity(client.select_folder(path, readonly=readonly))


def new_uids(client: IMAPClient, last_uid: int, newest: int) -> list[int]:
    """Up to ``newest`` of what's arrived, the most recent first."""
    uids = [u for u in client.search(["UID", f"{last_uid + 1}:*"]) if u > last_uid]
    return sorted(uids, reverse=True)[:newest]


def older_uids(client: IMAPClient, below: int, count: int) -> list[int]:
    """The next ``count`` messages further back than we've got."""
    if below <= 1:
        return []
    uids = [u for u in client.search(["UID", f"1:{below - 1}"]) if u < below]
    return sorted(uids, reverse=True)[:count]


def batches(client: IMAPClient, uids: list[int]) -> list[list[int]]:
    """These messages, in groups small enough to fetch and save one at a time."""
    out: list[list[int]] = []
    current: list[int] = []
    held = 0
    for start in range(0, len(uids), 500):
        chunk = uids[start : start + 500]
        sizes = client.fetch(chunk, ["RFC822.SIZE"])
        for uid in chunk:
            # Too big to keep whole only costs its headers.
            size = sizes.get(uid, {}).get(b"RFC822.SIZE", 0)
            size = size if size <= MAX_BODY_BYTES else 0
            if current and (len(current) >= BATCH or held + size > BATCH_BYTES):
                out.append(current)
                current, held = [], 0
            current.append(uid)
            held += size
    if current:
        out.append(current)
    return out


def fetch_messages(client: IMAPClient, uids: list[int]) -> list[tuple[int, list[bytes], bytes]]:
    out: list[tuple[int, list[bytes], bytes]] = []
    for start in range(0, len(uids), BATCH):
        chunk = uids[start : start + BATCH]
        sizes = client.fetch(chunk, ["RFC822.SIZE"])
        small = [u for u in chunk if sizes.get(u, {}).get(b"RFC822.SIZE", 0) <= MAX_BODY_BYTES]
        large = [u for u in chunk if u not in small]
        if small:
            for uid, row in client.fetch(small, ["FLAGS", "BODY.PEEK[]"]).items():
                out.append((uid, list(row.get(b"FLAGS", ())), row.get(b"BODY[]", b"") or b""))
        if large:
            for uid, row in client.fetch(large, ["FLAGS", "BODY.PEEK[HEADER]"]).items():
                out.append((uid, list(row.get(b"FLAGS", ())), row.get(b"BODY[HEADER]", b"") or b""))
    return out


def flags_of(client: IMAPClient, uids: list[int]) -> dict[int, list[bytes]]:
    out: dict[int, list[bytes]] = {}
    for start in range(0, len(uids), 500):
        for uid, row in client.fetch(uids[start : start + 500], ["FLAGS"]).items():
            out[uid] = list(row.get(b"FLAGS", ()))
    return out


def existing_uids(client: IMAPClient) -> set[int]:
    return set(client.search(["ALL"]))


def fetch_raw(client: IMAPClient, path: str, uid: int) -> bytes | None:
    select(client, path)
    row = client.fetch([uid], ["BODY.PEEK[]"]).get(uid)
    return row.get(b"BODY[]") if row else None


def find_uid(client: IMAPClient, path: str, message_id: str) -> int | None:
    """Where an email is now, for one moved somewhere we don't keep numbers for."""
    if not message_id or any(c in message_id for c in '\r\n"'):
        return None
    select(client, path)
    found = client.search(["HEADER", "Message-ID", message_id])
    return max(found) if found else None


def read_message(client: IMAPClient, places: list[str], uid: int | None, message_id: str) -> bytes | None:
    """One whole email, from wherever it is right now. ``places`` starts with the folder
    we think it's in, but it may still be on its way there, or have been moved from
    another device since we last looked."""
    if uid:
        raw = fetch_raw(client, places[0], uid)
        if raw:
            return raw
    for path in places:
        try:
            found = find_uid(client, path, message_id)
            raw = fetch_raw(client, path, found) if found else None
        except IMAPClientError:
            continue  # That folder's gone. The email may still be in another.
        if raw:
            return raw
    return None


def apply_op(client: IMAPClient, kind: str, path: str, uids: list[int], target: str) -> None:
    if not uids:
        return
    select(client, path, readonly=False)
    if kind == "seen":
        client.add_flags(uids, [b"\\Seen"])
    elif kind == "unseen":
        client.remove_flags(uids, [b"\\Seen"])
    elif kind == "flag":
        client.add_flags(uids, [b"\\Flagged"])
    elif kind == "unflag":
        client.remove_flags(uids, [b"\\Flagged"])
    elif kind == "move":
        _move(client, uids, target)


def _move(client: IMAPClient, uids: list[int], target: str) -> None:
    if client.has_capability("MOVE"):
        client.move(uids, target)
    else:
        client.copy(uids, target)
        client.delete_messages(uids)
        client.expunge()


def move_found(client: IMAPClient, path: str, message_ids: list[str], target: str) -> list[str]:
    """Moves these emails by their Message-IDs, and says which weren't there (yet)."""
    found: dict[str, int] = {}
    for message_id in message_ids:
        uid = find_uid(client, path, message_id)
        if uid:
            found[message_id] = uid
    if found:
        select(client, path, readonly=False)
        _move(client, list(found.values()), target)
    return [m for m in message_ids if m not in found]


def append_sent(client: IMAPClient, path: str, raw: bytes) -> None:
    client.append(path, raw, flags=[b"\\Seen"])
