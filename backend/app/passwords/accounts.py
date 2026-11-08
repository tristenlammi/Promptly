"""Accounts you have, from your own mail.

Welcome and sign-up mail, "verify your email", password resets, new sign-in alerts,
receipts and subscriptions all say a site knows you. This finds them in the mail the
server already holds, with plain rules and no model, and keeps a short list per
mailbox: the site, the address it went to, when it was first and last seen, what kind
of mail it was, and a link to the latest one.

The vault is end-to-end encrypted, so the comparison with it happens on the device:
the client takes this list and hides what it already has a login for. Nothing about
the vault comes back here, and what someone does with a row (adds a login, says it's
not an account, deletes the account) stays in their encrypted vault.

Reading is incremental, by each folder's message numbers (``PwMailScan``), and reads
headers first: a message's body is only fetched when it came through a sending
service and the site has to be worked out from its links.
"""
from __future__ import annotations

import html as html_lib
import json
import logging
import re
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Response
from sqlalchemy import case, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.passwords import schemas as s
from app.passwords.accounts_models import PwMailScan, PwMailSite
from app.passwords.deps import VaultSession, require_enabled, require_session
from app.passwords.router import _QuietRoute

logger = logging.getLogger("promptly.passwords")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

# Folders that aren't mail you were sent, or are copies of mail that's elsewhere.
SKIP_ROLES = ("trash", "spam", "drafts", "sent", "all", "starred")
BATCH = 1000
# Read while someone waits for the page, and per person on each background run.
INLINE_BUDGET = 3000
BACKGROUND_BUDGET = 20000
# A body is read only this far: the links that name a site are near the top.
BODY_HTML_CHARS = 150_000
BODY_TEXT_CHARS = 60_000
LIST_LIMIT = 2000


# ------------------------------------------------------------------ domains

# Second-level labels that are public suffixes under a two-letter country code:
# co.uk, com.au, ne.jp. A short rule instead of the whole Public Suffix List, which
# the backend doesn't carry; the client checks every domain again with the real list.
_SECOND_LEVEL = frozenset(
    "co com net org gov edu ac ne or go gob gouv mil ltd plc me nom sch nic id asn nhs info biz gen web".split()
)


def registrable(host: str) -> str | None:
    """The part of a host name someone registered: mail.instagram.com is instagram.com,
    em.shop.co.uk is shop.co.uk. None for an address, a bare name or nonsense."""
    host = (host or "").strip().strip(".").lower()
    if not host or len(host) > 253 or not re.fullmatch(r"[a-z0-9.-]+", host):
        return None
    labels = [x for x in host.split(".") if x]
    if len(labels) < 2 or labels[-1].isdigit():
        return None
    if len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL:
        return ".".join(labels[-3:]) if len(labels) >= 3 else None
    return ".".join(labels[-2:])


def _domain_of(addr: str) -> str:
    return addr.rsplit("@", 1)[-1].strip().lower() if "@" in (addr or "") else ""


# People's own mailboxes. Mail from one of these is a person writing, not a site.
FREEMAIL = frozenset(
    """gmail.com googlemail.com outlook.com hotmail.com live.com msn.com ymail.com rocketmail.com icloud.com me.com mac.com
    aol.com proton.me protonmail.com protonmail.ch pm.me gmx.com gmx.net gmx.de web.de mail.com yandex.ru yandex.com mail.ru
    zohomail.com fastmail.com fastmail.fm tutanota.com tuta.io hey.com qq.com 163.com 126.com naver.com bigpond.com
    optusnet.com.au btinternet.com comcast.net verizon.net att.net sbcglobal.net""".split()
)
_FREEMAIL_PREFIX = ("yahoo.", "hotmail.", "outlook.", "live.", "gmx.", "yandex.", "libero.", "orange.", "free.", "t-online.")

# Sending services. Mail sent through one of these often has the service's domain in
# From, so the site has to be worked out from Reply-To or the links instead. The
# services' own sites (mailchimp.com, sendgrid.com and so on) aren't here, because
# those are accounts too: these are the domains they send customers' mail from.
SENDING_SERVICES = frozenset(
    """mcsv.net mcdlv.net rsgsv.net list-manage.com mailchimpapp.net mandrillapp.com sendgrid.net amazonses.com
    mailgun.org sparkpostmail.com mtasv.net createsend.com cmail19.com cmail20.com ccsend.com hubspotemail.net hs-email.net
    hubspotservicehub.com exacttarget.com sailthru.com klaviyomail.com customeriomail.com intercom-mail.com
    zendesk.com freshdesk.com helpscoutemail.com myshopify.com shopifyemail.com wixemails.com squarespace-mail.com
    sendinblue.com brevosend.com mailerlite.com mlsend.com convertkit-mail.com convertkit-mail2.com ckarchive.com
    substack.com beehiiv.com buttondown.email ghost.io mailpoet.com emarsys.net bnc3.mailjet.com mailjet.com
    pardot.com mktomail.com marketo.org salesforce.com eloqua.com acemsd.com activehosted.com""".split()
)

# Newsletter platforms: a welcome from one of these is a mailing list, not an account.
NEWSLETTER_PLATFORMS = frozenset("substack.com beehiiv.com buttondown.email ghost.io convertkit-mail.com convertkit-mail2.com mailerlite.com mlsend.com".split())

# Links in a footer that don't say whose mail it is.
_LINK_NOISE = frozenset(
    """facebook.com fb.com twitter.com x.com instagram.com linkedin.com youtube.com youtu.be tiktok.com pinterest.com
    threads.net reddit.com discord.gg whatsapp.com t.me apple.com google.com play.google.com w3.org schema.org
    gstatic.com googleapis.com googleusercontent.com cloudfront.net amazonaws.com akamaihd.net doubleclick.net
    google-analytics.com gravatar.com wp.com bit.ly mailchimp.com sendgrid.com mailgun.com mailjet.com postmarkapp.com
    hubspot.com klaviyo.com litmus.com emltrk.com list-manage.com cloudinary.com imgix.net""".split()
)

# Brands that send from a domain that isn't their site.
ALIASES = {"facebookmail.com": "facebook.com", "accountprotection.microsoft.com": "microsoft.com", "linkedinmail.com": "linkedin.com", "twitteremail.com": "twitter.com"}


def site_domain(host: str) -> str | None:
    base = registrable(host)
    if base is None:
        return None
    return ALIASES.get(base, base)


def is_freemail(domain: str | None) -> bool:
    return bool(domain) and (domain in FREEMAIL or domain.startswith(_FREEMAIL_PREFIX))


def is_sending_service(host: str) -> bool:
    host = (host or "").lower()
    base = registrable(host) or ""
    return base in SENDING_SERVICES or host in SENDING_SERVICES or any(host.endswith("." + d) for d in SENDING_SERVICES)


# ------------------------------------------------------------------ kinds of evidence

KINDS = ("reset", "signin", "security", "verify", "welcome", "subscription", "receipt")
KIND_BITS = {k: 1 << i for i, k in enumerate(KINDS)}

_FORWARD = re.compile(r"^\s*(fwd?|fw|wg|tr|rv|enc|vs|doorst)\s*:", re.IGNORECASE)
_REPLY = re.compile(r"^\s*(re|aw|sv|antw|odp)\s*:", re.IGNORECASE)
_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("reset", re.compile(
        r"\b(reset|recover|forgot|forgotten)\b.{0,12}\b(password|account)\b|password (reset|recovery|change request)"
        r"|passwort zurücksetzen|restablecer (tu |la )?contraseña|réinitialis\w* (votre |de )?(votre )?mot de passe", re.IGNORECASE)),
    ("signin", re.compile(
        r"\bnew (sign[- ]?in|log[- ]?in|login|device)\b|\b(sign[- ]?in|log[- ]?in|login) (attempt|alert|code|from|notification)"
        r"|unusual (sign[- ]?in|activity|login)|suspicious (sign[- ]?in|activity|login)|\bsecurity alert\b|signed in (from|on|to|with)"
        r"|\byour [\w ]{0,20}(security|login|sign[- ]?in|2fa|two[- ]factor|one[- ]time) (code|passcode)\b|\bone[- ]time (pass)?code\b"
        r"|neue anmeldung|nuevo inicio de sesión|nouvelle connexion", re.IGNORECASE)),
    ("security", re.compile(
        r"password (was |has been |is )?(changed|updated)|changed your password|e-?mail (address )?(was |has been )?changed"
        r"|two[- ]factor (authentication )?(is )?(on|off|enabled|disabled|turned)|2fa (enabled|disabled)|passwort (wurde )?geändert"
        r"|contraseña (ha sido )?(cambiada|actualizada)|mot de passe (a été )?modifié", re.IGNORECASE)),
    ("verify", re.compile(
        r"\b(verify|confirm|validate|activate)\b (your )?(e-?mail|email address|address|account|registration|sign[- ]?up|identity)\b"
        r"|\be-?mail (address )?(verification|confirmation)\b|\baccount (verification|activation)\b|\b(verification|confirmation) code\b"
        r"|bestätigen sie ihre e-?mail|e-?mail-adresse bestätigen|confirma tu (correo|cuenta)|confirmez votre (adresse|compte)|vérifiez votre adresse", re.IGNORECASE)),
    ("welcome", re.compile(
        r"\bwelcome\b(?! back)|thanks? (you )?for (signing up|joining|registering|creating (an|your) account|your registration)"
        r"|your (new )?account (has been |is )?(created|ready|set up|activated|confirmed)|\baccount (created|activated|confirmed)\b"
        r"|registration (is )?(complete|confirmed|successful)|you('ve| have) (successfully )?(signed up|registered|joined)"
        r"|bienvenid[oa]|willkommen|bienvenue|benvenut[oa]|welkom", re.IGNORECASE)),
    ("subscription", re.compile(
        r"\byour [\w ]{0,20}(subscription|membership|plan) (is |has been |was |will )?(be )?(confirmed|active|activated|renewed|renewing|renew|started|cancell?ed|ending|expir\w*|updated)"
        r"|\bsubscription (confirmed|renewal|receipt|started|cancell?ed|payment)|\b(free )?trial (ends|ending|started|is over|expires|has ended)"
        r"|\bauto[- ]?renew|\brenewal (notice|reminder)|\bmembership (confirmed|renewal)", re.IGNORECASE)),
    ("receipt", re.compile(
        r"\breceipt\b|\binvoice\b|\border (confirmation|confirmed|#|no\.?|number)|\byour order (has|is|was|of|from|#|\d)"
        r"|thanks? (you )?for your (order|purchase|payment)|\bpayment (received|confirmation|successful|confirmed)|purchase confirmation", re.IGNORECASE)),
]
# A mailing list. Says nothing about an account, even when it says welcome.
_NEWSLETTER = re.compile(
    r"\bnewsletter|\bdigest\b|\bweekly\b|\bissue #?\d|\bedition\b|mailing list|confirm (your )?subscription|subscribed to\b|you('re| are) (now )?subscribed",
    re.IGNORECASE,
)
_MARKETING = re.compile(
    r"\d+ ?% off|\bsale\b|\bdeals?\b|\boffer\b|\bcoupon|\bpromo|free shipping|last chance|don't miss|limited time|black friday|cyber monday",
    re.IGNORECASE,
)
_SOFT = {"welcome", "subscription", "receipt", "verify"}


def evidence_kind(subject: str) -> str | None:
    """What a subject line says about an account, or None. Forwards and replies are
    someone else's mail or a conversation, so they never count."""
    subject = (subject or "").strip()[:300]
    if not subject or _FORWARD.match(subject) or _REPLY.match(subject):
        return None
    for kind, pattern in _RULES:
        if not pattern.search(subject):
            continue
        if kind in _SOFT and _NEWSLETTER.search(subject):
            return None
        if kind in ("welcome", "subscription", "receipt") and _MARKETING.search(subject):
            return None
        return kind
    return None


def kinds_of(bits: int) -> list[str]:
    return [k for k in KINDS if bits & KIND_BITS[k]]


# ------------------------------------------------------------------ whose site, and to whom

_HREF = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)


def site_from_links(body_html: str, body_text: str) -> str | None:
    """The site most of a message's links go to, leaving out trackers, social footers
    and the sending service itself."""
    urls = [html_lib.unescape(u) for u in _HREF.findall(body_html or "")] + _URL.findall(body_text or "")
    counts: Counter[str] = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(urls[:400]):
        if not u.lower().startswith(("https://", "http://")):
            continue
        try:
            parts = urlsplit(u)
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        if not host or "@" in parts.netloc or is_sending_service(host):
            continue
        domain = site_domain(host)
        if domain is None or domain in _LINK_NOISE or is_freemail(domain):
            continue
        counts[domain] += 1
        first.setdefault(domain, i)
    if not counts:
        return None
    return min(counts, key=lambda d: (-counts[d], first[d]))


def needs_body(from_addr: str, reply_to: str) -> bool:
    """Only mail through a sending service, with no usable Reply-To, needs its links read."""
    sender = _domain_of(from_addr)
    if not is_sending_service(sender):
        return False
    reply = _domain_of(reply_to)
    return not reply or is_sending_service(reply) or is_freemail(site_domain(reply))


def sender_site(from_addr: str, reply_to: str, body_html: str = "", body_text: str = "") -> str | None:
    sender = _domain_of(from_addr)
    if not sender:
        return None
    if not is_sending_service(sender):
        domain = site_domain(sender)
        return None if domain is None or is_freemail(domain) else domain
    reply = _domain_of(reply_to)
    if reply and not is_sending_service(reply):
        domain = site_domain(reply)
        if domain and not is_freemail(domain):
            return domain
    return site_from_links(body_html, body_text)


def _local_base(addr: str) -> tuple[str, str]:
    local, _, domain = addr.lower().partition("@")
    return local.split("+", 1)[0], domain


def receiving_address(to_addrs: list[dict[str, str]] | None, account_email: str) -> str:
    """The address the site has: the mailbox's own, or a plus-address of it, or the
    first one it was sent to (a forward from another address of yours)."""
    mine = _local_base(account_email)
    addrs = [str(a.get("addr") or "").strip().lower() for a in (to_addrs or []) if isinstance(a, dict)]
    addrs = [a for a in addrs if "@" in a]
    for a in addrs:
        if _local_base(a) == mine:
            return a[:320]
    return (addrs[0] if addrs else account_email.lower())[:320]


@dataclass
class Evidence:
    domain: str
    kind: str
    address: str


def classify(
    *,
    subject: str,
    from_addr: str,
    reply_to: str = "",
    to_addrs: list[dict[str, str]] | None = None,
    account_email: str = "",
    body_html: str = "",
    body_text: str = "",
) -> Evidence | None:
    """One message as evidence of an account, or None. Plain rules, no model."""
    kind = evidence_kind(subject)
    if kind is None:
        return None
    sender = (from_addr or "").strip().lower()
    if not sender or sender == (account_email or "").strip().lower():
        return None
    sender_domain = _domain_of(sender)
    if kind in ("welcome", "subscription", "verify") and (registrable(sender_domain) in NEWSLETTER_PLATFORMS):
        return None
    domain = sender_site(sender, reply_to, body_html, body_text)
    if domain is None:
        return None
    return Evidence(domain=domain, kind=kind, address=receiving_address(to_addrs, account_email))


# ------------------------------------------------------------------ deletion pages


DATA_FILE = Path(__file__).with_name("data") / "deletion_sites.json"
_EMAIL = re.compile(r"^[^@\s<>\"]{1,64}@[a-z0-9.-]{3,253}$", re.IGNORECASE)
DIFFICULTIES = ("easy", "medium", "hard", "limited", "impossible")


@lru_cache(maxsize=1)
def deletion_sites() -> dict[str, dict[str, str]]:
    """Known deletion pages by domain, from JustDeleteMe's data (MIT), converted by
    ``backend/scripts/update_deletion_sites.py``. Only https pages and plain addresses."""
    try:
        raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, dict[str, str]] = {}
    for domain, row in (raw.get("sites") or {}).items():
        if not isinstance(row, dict):
            continue
        entry: dict[str, str] = {}
        url = str(row.get("url") or "")
        if url.startswith("https://") and len(url) <= 500:
            entry["url"] = url
        email = str(row.get("email") or "")
        if _EMAIL.match(email):
            entry["email"] = email
        difficulty = str(row.get("difficulty") or "")
        if difficulty in DIFFICULTIES:
            entry["difficulty"] = difficulty
        name = str(row.get("name") or "")[:120]
        if name:
            entry["name"] = name
        if entry.get("url") or entry.get("email") or entry.get("difficulty"):
            out[str(domain).lower()] = entry
    return out


def deletion_for(domain: str) -> dict[str, str] | None:
    sites = deletion_sites()
    return sites.get(domain) or sites.get(registrable(domain) or "")


# ------------------------------------------------------------------ reading mail, a little at a time


@dataclass
class _Found:
    first: datetime
    last: datetime
    bits: int
    address: str
    name: str
    message_id: uuid.UUID


async def _lock(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """One reader per person at a time, held until this transaction ends."""
    return bool(await db.scalar(text("SELECT pg_try_advisory_xact_lock(hashtext(:k))"), {"k": f"pw_mail_scan:{user_id}"}))


async def scan_user(db: AsyncSession, user_id: uuid.UUID, budget: int = INLINE_BUDGET) -> bool:
    """Read up to ``budget`` messages this person hasn't had read yet, in their own
    mailboxes only, and fold what they say into the list. True when nothing's left."""
    from app.mail.models import MailAccount, MailFolder, MailMessage

    if not await _lock(db, user_id):
        await db.rollback()
        return False
    folders = (
        await db.execute(
            select(MailFolder, MailAccount.email)
            .join(MailAccount, MailAccount.id == MailFolder.account_id)
            .where(MailAccount.user_id == user_id, MailFolder.role.not_in(SKIP_ROLES))
            .order_by(MailFolder.role != "inbox", MailFolder.path)
        )
    ).all()
    if not folders:
        await db.rollback()
        return True
    cursors = {
        c.folder_id: c
        for c in (await db.execute(select(PwMailScan).where(PwMailScan.folder_id.in_([f.id for f, _ in folders])))).scalars()
    }
    found: dict[tuple[uuid.UUID, str], _Found] = {}
    done = True
    cols = (MailMessage.id, MailMessage.uid, MailMessage.subject, MailMessage.from_addr, MailMessage.from_name, MailMessage.reply_to, MailMessage.to_addrs, MailMessage.sent_at)

    async def read(folder, email: str, newer: bool, after: int) -> list[Any]:
        q = select(*cols).where(MailMessage.folder_id == folder.id, MailMessage.uid.is_not(None))
        q = q.where(MailMessage.uid > after).order_by(MailMessage.uid.asc()) if newer else q.where(MailMessage.uid < after).order_by(MailMessage.uid.desc())
        rows = (await db.execute(q.limit(min(BATCH, budget)))).all()
        await fold(folder.account_id, email, rows)
        return rows

    async def fold(account_id: uuid.UUID, email: str, rows: list[Any]) -> None:
        wanted = [r for r in rows if evidence_kind(r.subject)]
        bodies: dict[uuid.UUID, tuple[str, str]] = {}
        need = [r.id for r in wanted if needs_body(r.from_addr, r.reply_to)]
        if need:
            for mid, h, t in (
                await db.execute(
                    select(MailMessage.id, func.left(MailMessage.body_html, BODY_HTML_CHARS), func.left(MailMessage.body_text, BODY_TEXT_CHARS)).where(MailMessage.id.in_(need))
                )
            ).all():
                bodies[mid] = (h or "", t or "")
        for r in wanted:
            body_html, body_text = bodies.get(r.id, ("", ""))
            ev = classify(subject=r.subject, from_addr=r.from_addr, reply_to=r.reply_to, to_addrs=r.to_addrs, account_email=email, body_html=body_html, body_text=body_text)
            if ev is None:
                continue
            key = (account_id, ev.domain)
            at = r.sent_at
            cur = found.get(key)
            if cur is None:
                found[key] = _Found(at, at, KIND_BITS[ev.kind], ev.address, (r.from_name or "")[:120], r.id)
                continue
            cur.bits |= KIND_BITS[ev.kind]
            cur.first = min(cur.first, at)
            if at >= cur.last:
                cur.last, cur.address, cur.name, cur.message_id = at, ev.address, (r.from_name or "")[:120], r.id

    now = datetime.now(timezone.utc)
    for folder, email in folders:
        if budget <= 0:
            done = False
            break
        cur = cursors.get(folder.id)
        if cur is None:
            cur = PwMailScan(folder_id=folder.id, user_id=user_id, uidvalidity=folder.uidvalidity, hi_uid=0, lo_uid=0)
            db.add(cur)
        elif cur.uidvalidity != folder.uidvalidity:
            # Numbered again: read it again. What's kept is the same either way.
            cur.uidvalidity, cur.hi_uid, cur.lo_uid = folder.uidvalidity, 0, 0
        # New mail first, then anything copied in from further back.
        while budget > 0:
            rows = await read(folder, email, True, cur.hi_uid)
            if not rows:
                break
            budget -= len(rows)
            cur.hi_uid = rows[-1].uid
            cur.lo_uid = rows[0].uid if not cur.lo_uid else min(cur.lo_uid, rows[0].uid)
        while budget > 0 and cur.lo_uid > 1:
            rows = await read(folder, email, False, cur.lo_uid)
            if not rows:
                break
            budget -= len(rows)
            cur.lo_uid = rows[-1].uid
        if budget <= 0:
            done = False
        cur.scanned_at = now

    if found:
        values = [
            {
                "id": uuid.uuid4(), "user_id": user_id, "account_id": account_id, "domain": domain[:253], "address": f.address,
                "name": f.name, "kinds": f.bits, "first_seen": f.first, "last_seen": f.last, "message_id": f.message_id,
            }
            for (account_id, domain), f in found.items()
        ]
        stmt = pg_insert(PwMailSite).values(values)
        newer = stmt.excluded.last_seen >= PwMailSite.last_seen
        stmt = stmt.on_conflict_do_update(
            constraint="uq_pw_mail_site",
            set_={
                "kinds": PwMailSite.kinds.op("|")(stmt.excluded.kinds),
                "first_seen": func.least(PwMailSite.first_seen, stmt.excluded.first_seen),
                "last_seen": func.greatest(PwMailSite.last_seen, stmt.excluded.last_seen),
                "address": case((newer, stmt.excluded.address), else_=PwMailSite.address),
                "name": case((newer, stmt.excluded.name), else_=PwMailSite.name),
                "message_id": case((newer, stmt.excluded.message_id), else_=PwMailSite.message_id),
            },
        )
        await db.execute(stmt)
    await db.commit()
    return done


async def refresh_all(budget: int = BACKGROUND_BUDGET) -> int:
    """The background run: everyone with a vault and a mailbox, a slice each."""
    from app.database import SessionLocal
    from app.mail.models import MailAccount
    from app.passwords.deps import policy
    from app.passwords.models import PwAccount

    async with SessionLocal() as db:
        if not (await policy(db)).enabled:
            return 0
        users = list(
            (await db.execute(select(MailAccount.user_id).join(PwAccount, PwAccount.user_id == MailAccount.user_id).distinct())).scalars()
        )
    for user_id in users:
        try:
            async with SessionLocal() as db:
                await scan_user(db, user_id, budget)
        except Exception as e:  # noqa: BLE001 — one person's mail mustn't stop the rest; logged without contents
            logger.warning("Accounts-from-mail scan failed: %s", type(e).__name__)
    return len(users)


# ------------------------------------------------------------------ the endpoint


class DeletionHelp(s._Base):
    url: str | None = None
    email: str | None = None
    difficulty: str | None = None
    name: str | None = None


class MailSiteOut(s._Base):
    domain: str
    name: str
    address: str
    account_id: uuid.UUID
    kinds: list[str]
    first_seen: datetime
    last_seen: datetime
    # "account_id/thread_key" for /mail?open=…, or None if that mail's gone.
    open: str | None
    deletion: DeletionHelp | None


class MailSitesOut(s._Base):
    mail: bool
    complete: bool
    sites: list[MailSiteOut]


@router.get("/mail/accounts", response_model=MailSitesOut)
async def mail_accounts(response: Response, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> MailSitesOut:
    """Sites your mail says you have accounts with. The vault isn't involved: the
    client hides what it already has, on its own side."""
    from app.mail.models import MailAccount, MailMessage
    from app.passwords.connections import _check_mail_scope

    _check_mail_scope(session)
    response.headers["Cache-Control"] = "no-store"
    user_id = session.user.id
    has_mail = bool(await db.scalar(select(func.count()).select_from(MailAccount).where(MailAccount.user_id == user_id)))
    if not has_mail:
        return MailSitesOut(mail=False, complete=True, sites=[])
    complete = await scan_user(db, user_id, INLINE_BUDGET)
    rows = (
        await db.execute(
            select(PwMailSite, MailMessage.account_id, MailMessage.thread_key)
            .join(MailAccount, MailAccount.id == PwMailSite.account_id)
            .outerjoin(MailMessage, MailMessage.id == PwMailSite.message_id)
            .where(PwMailSite.user_id == user_id, MailAccount.user_id == user_id)
            .order_by(PwMailSite.last_seen.desc())
            .limit(LIST_LIMIT)
        )
    ).all()
    out: list[MailSiteOut] = []
    for site, msg_account, thread_key in rows:
        help_ = deletion_for(site.domain)
        out.append(
            MailSiteOut(
                domain=site.domain, name=site.name, address=site.address, account_id=site.account_id, kinds=kinds_of(site.kinds),
                first_seen=site.first_seen, last_seen=site.last_seen,
                open=f"{msg_account}/{thread_key}" if thread_key else None,
                deletion=DeletionHelp(**help_) if help_ else None,
            )
        )
    return MailSitesOut(mail=True, complete=complete, sites=out)


__all__ = ["router", "classify", "evidence_kind", "registrable", "scan_user", "refresh_all", "deletion_for"]
