"""Admin > Calls: the set-up checklist, Test call results, live usage, and
the hourly check that notices voice breaking.

Everything here is about whether calls *work*; nothing about what anyone
says. Test call results keep only whether the test came from inside or
outside the home, never the tester's address.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass

from app.rtc import config as rtc_config
from app.rtc import metrics as rtc_metrics
from app.rtc import names, service, stun, webhooks

logger = logging.getLogger(__name__)

TEST_INSIDE = "calls:test:inside"
TEST_OUTSIDE = "calls:test:outside"
TEST_USER = "calls:test:user:{user_id}"
SERVER_IP = "calls:server_ip"  # the public address LiveKit advertised to a test
IP_AT_START = "calls:ip:start"  # {started_at, ip}: our STUN address when LiveKit started
ALERT_ONCE = "calls:alert:{kind}:{day}"
KEEP = 90 * 86400

# Rough per-viewer bitrates for the upload estimate (simulcast top layer).
STREAM_MBPS = {"720p30": 2.5, "1080p30": 4.5, "1080p60": 7.0}


@dataclass
class Check:
    id: str
    label: str
    status: str  # ok | warn | fail | unknown
    detail: str
    fix: str | None = None


def _ago(ts: float | None) -> str:
    if not ts:
        return "never"
    s = max(0, int(time.time() - ts))
    if s < 90:
        return "just now"
    if s < 5400:
        return f"{s // 60} minutes ago"
    if s < 2 * 86400:
        return f"{s // 3600} hours ago"
    return f"{s // 86400} days ago"


async def _get_json(redis, key: str) -> dict | None:
    try:
        raw = await redis.get(key)
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        return None


async def record_test(redis, user_id, report: dict, *, outside: bool) -> None:
    """Keep a Test call's outcome for the checklist (and the tester's own
    "last result")."""
    row = {**report, "outside": outside, "at": time.time()}
    try:
        await redis.set(TEST_USER.format(user_id=user_id), json.dumps(row), ex=KEEP)
        await redis.set(TEST_OUTSIDE if outside else TEST_INSIDE, json.dumps(row), ex=KEEP)
        addr = report.get("server_address")
        if addr and not stun.is_private(addr):
            await redis.set(SERVER_IP, json.dumps({"ip": addr, "at": row["at"]}), ex=KEEP)
    except Exception:  # noqa: BLE001
        logger.debug("test result not stored", exc_info=True)


def watchers_estimate(mbps: float | None) -> dict | None:
    """How many people could watch a Go Live stream from this upload."""
    if not mbps or mbps <= 0:
        return None
    usable = mbps * 0.8  # leave room for voice and everything else at home
    return {k: max(0, int(usable // v)) for k, v in STREAM_MBPS.items()}


def connection_words(report: dict | None) -> str:
    if not report:
        return "not tested yet"
    if not report.get("ok"):
        return "couldn't connect"
    ctype, proto = report.get("candidate_type"), report.get("protocol")
    if ctype == "relay":
        return "through a relay"
    if proto == "tcp":
        return "fallback over TCP"
    return "direct connection"


async def server_status() -> tuple[str, str | None, list | None]:
    """("ok"|"setup"|"down"|"keys", error, rooms)."""
    if not rtc_config.configured():
        return "setup", None, None
    try:
        rooms = await service.list_rooms()
        return "ok", None, rooms
    except service.RtcKeyMismatch as exc:
        return "keys", str(exc), None
    except service.RtcUnavailable as exc:
        return "down", str(exc), None
    except Exception as exc:  # noqa: BLE001 — shown as "not running"
        logger.warning("LiveKit check failed: %s", exc)
        return "down", str(exc), None


async def checklist(redis) -> dict:
    udp, tcp = rtc_config.media_ports()
    forward = f"Forward UDP {udp} and TCP {tcp} on your router to this server."
    checks: list[Check] = []

    state, err, _rooms = await server_status()
    if state == "setup":
        checks.append(Check(
            "server", "Calls server set up", "fail",
            "This server has no calls key pair yet, so the calls service can't start.",
            "Run the update once more (./update.sh, or .\\update.ps1 on Windows), or re-run the installer. "
            "It makes the key pair and starts the calls service. Then come back here.",
        ))
    elif state == "down":
        checks.append(Check(
            "server", "Calls server running", "fail",
            "The calls service isn't answering.",
            "Run the update, or check: docker compose logs livekit "
            "(on Docker Desktop the service is livekit-desktop). If COMPOSE_PROFILES in .env has no "
            "\"calls\" (Linux) or \"calls-desktop\" (Docker Desktop), add it and run docker compose up -d.",
        ))
    else:
        checks.append(Check("server", "Calls server running", "ok", "The calls service is answering."))

    if state == "keys":
        checks.append(Check(
            "keys", "Keys match", "fail",
            "The calls service refused this server's key.",
            "The calls key in .env doesn't match the calls service. Re-run the installer, then docker compose up -d.",
        ))
    elif state == "ok":
        checks.append(Check("keys", "Keys match", "ok", "The calls service accepts this server's key."))
    else:
        checks.append(Check("keys", "Keys match", "unknown", "Checked once the calls service is running."))

    # Your internet address, as STUN servers see it.
    seen = await stun.public_addresses()
    ips = sorted({ip for ip, _ in seen})
    server_ip = await _get_json(redis, SERVER_IP)
    if not seen:
        checks.append(Check(
            "address", "Your internet address", "unknown",
            "Couldn't look it up: no STUN server answered.",
            "Outgoing UDP may be blocked on this network. Voice at home still works.",
        ))
    elif len(ips) > 1 or any(stun.is_cgnat(ip) for ip in ips):
        checks.append(Check(
            "address", "Your internet address", "warn",
            f"STUN servers see {', '.join(ips)}.",
            "Your internet provider seems to share one address between customers (CGNAT). Voice from "
            "outside your home won't work without a relay. At home it still works. Ask your provider "
            "for a public IPv4 address to fix it.",
        ))
    else:
        detail = f"Your home's internet address is {ips[0]}."
        if server_ip and server_ip.get("ip") and server_ip["ip"] != ips[0]:
            checks.append(Check(
                "address", "Your internet address", "warn",
                f"{detail} The calls service last told callers {server_ip['ip']}.",
                "Your home internet address changed. Restart the calls service: docker compose restart livekit "
                "(livekit-desktop on Docker Desktop), then run Test calls again.",
            ))
        else:
            checks.append(Check("address", "Your internet address", "ok", detail))

    last = await webhooks.last_heard(redis)
    if last:
        checks.append(Check("webhooks", "Promptly hears from the calls service", "ok", f"Last message {_ago(last)}."))
    elif state == "ok":
        checks.append(Check(
            "webhooks", "Promptly hears from the calls service", "unknown",
            "Nothing heard yet. The calls service only reports when someone connects.",
            "Run Test calls. If this stays grey afterwards, check docker compose logs livekit for webhook errors.",
        ))
    else:
        checks.append(Check("webhooks", "Promptly hears from the calls service", "unknown", "Checked once the calls service is running."))

    inside = await _get_json(redis, TEST_INSIDE)
    outside = await _get_json(redis, TEST_OUTSIDE)
    if outside and outside.get("ok"):
        words = connection_words(outside)
        status_ = "warn" if outside.get("protocol") == "tcp" else "ok"
        checks.append(Check(
            "outside", "Works from outside your home", status_,
            f"Last test from outside: {words}, {_ago(outside.get('at'))}.",
            f"It works, but over the slower TCP fallback. Forward UDP {udp} too for the best sound."
            if status_ == "warn" else None,
        ))
    elif outside:
        checks.append(Check(
            "outside", "Works from outside your home", "fail",
            f"The last test from outside couldn't connect ({_ago(outside.get('at'))}).", forward,
        ))
    else:
        checks.append(Check(
            "outside", "Works from outside your home", "unknown",
            "Not tested from outside yet."
            + (f" At home: {connection_words(inside)}." if inside else ""),
            f"{forward} Then open Test calls on a phone with Wi-Fi off.",
        ))

    up = outside.get("download_mbps") if outside else None
    est = watchers_estimate(up)
    if est:
        checks.append(Check(
            "upload", "Upload speed for streams", "ok" if est["720p30"] >= 2 else "warn",
            f"About {up:.0f} Mbps from your home (measured by a Test call from outside). "
            f"About {est['1080p60']} people can watch a 1080p60 stream at once, "
            f"{est['1080p30']} at 1080p30, {est['720p30']} at 720p.",
            None if est["720p30"] >= 2 else "Lower the highest Go Live quality below, or expect streams to drop to a lower layer.",
        ))
    else:
        checks.append(Check(
            "upload", "Upload speed for streams", "unknown",
            "Measured when someone runs Test calls from outside your home.",
        ))

    return {"checks": [asdict(c) for c in checks], "ports": {"udp": udp, "tcp": tcp}}


async def usage(redis) -> dict:
    state, _err, rooms = await server_status()
    people = voice_rooms = tests = None
    if state == "ok" and rooms is not None:
        people = voice_rooms = tests = 0
        for r in rooms:
            p = names.prefix_of(r.name)
            if p in names.USAGE_PREFIXES:
                people += int(r.num_participants)
                voice_rooms += 1 if r.num_participants else 0
            elif p == "t_":
                tests += 1
    m = await rtc_metrics.read() if state == "ok" else None
    bps = await rtc_metrics.upload_bps(redis, m)
    return {
        "running": state == "ok",
        "people_in_voice": people,
        "channels_in_use": voice_rooms,
        "tests_running": tests,
        "upload_bps": bps,
        "metrics_available": m is not None,
        "minutes_30d": await webhooks.minutes_last_days(redis, 30),
    }


async def _once_today(redis, kind: str) -> bool:
    day = time.strftime("%Y%m%d", time.gmtime())
    try:
        return bool(await redis.set(ALERT_ONCE.format(kind=kind, day=day), "1", nx=True, ex=2 * 86400))
    except Exception:  # noqa: BLE001
        return True


async def _alert_admins(title: str, body: str) -> None:
    from sqlalchemy import select

    from app.auth.models import User
    from app.database import SessionLocal
    from app.notifications.dispatch import notify_user

    async with SessionLocal() as db:
        admins = (await db.execute(select(User).where(User.role == "admin", User.disabled.is_(False)))).scalars().all()
    for a in admins:
        try:
            await notify_user(user_id=a.id, category="system_alert", title=title, body=body, url="/admin?tab=calls", tag="calls-check")
        except Exception:  # noqa: BLE001
            logger.warning("couldn't alert admin %s about calls", a.id, exc_info=True)


async def hourly(redis, *, enabled: bool) -> dict:
    """The worker's hourly check: is the calls service up, and has the
    home's address moved since it started? One admin alert a day at most,
    and only while voice is on."""
    out: dict = {"enabled": enabled}
    if not enabled or not rtc_config.configured():
        return out
    state, _err, _rooms = await server_status()
    out["state"] = state
    if state != "ok":
        if await _once_today(redis, "down"):
            await _alert_admins(
                "Voice channels stopped working",
                "The calls service isn't answering. Open Admin > Calls for what to do.",
            )
        return out
    m = await rtc_metrics.read()
    seen = await stun.public_addresses()
    ip = seen[0][0] if seen else None
    out["ip"] = ip
    started = (m or {}).get("started_at")
    rec = await _get_json(redis, IP_AT_START)
    if started and ip:
        if not rec or abs(float(rec.get("started_at") or 0) - float(started)) > 1:
            # LiveKit (re)started since we last looked: it learned the
            # address it has now; remember it.
            await redis.set(IP_AT_START, json.dumps({"started_at": started, "ip": ip}), ex=KEEP)
        elif rec.get("ip") and rec["ip"] != ip:
            out["moved"] = True
            if await _once_today(redis, "moved"):
                await _alert_admins(
                    "Your home internet address changed",
                    "Voice from outside your home stops working until the calls service restarts: "
                    "docker compose restart livekit. Admin > Calls has the details.",
                )
            # The checklist compares with this too.
            await redis.set(SERVER_IP, json.dumps({"ip": rec["ip"], "at": time.time()}), ex=KEEP)
    return out
