"""Finish setting up: what a fresh install still needs, read from the
server's own state, and which models to suggest for each job.

Everything here is about whether the *install* works. Nothing reads what
anyone wrote, sent or stored: counts and switches only (admin privacy).

Two things live here:

* :func:`checklist` — one row per thing an admin sets up, each with an
  honest status (a setting that is saved, a service that answers, a test
  that passed) and a link to where it's done. The first-run wizard's last
  page, the card on Today and Admin → Setup all read it.
* :func:`suggest_models` — a pick per model job (chat, the quick helper,
  talking, reading pictures, making pictures) from what the connected
  providers offer, so the wizard can fill them in with one click.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.models import User
from app.config import get_settings

logger = logging.getLogger(__name__)

# How long any one "is that service there?" question may take. They run
# side by side, so the page waits about this long at worst.
PROBE_TIMEOUT_S = 3.0


@dataclass
class Row:
    id: str
    title: str
    # essential: the app can't do its main job without it.
    # recommended: works without, but a family will want it.
    # outside: only you can do it, outside Promptly (router, tunnel).
    # extra: optional apps and add-ons.
    group: str
    # done | todo | working (busy by itself, nothing to do) | problem
    status: str
    detail: str
    # Where it's set up: a wizard step ("/setup?step=…") or an admin page.
    to: str | None = None
    action: str | None = None


@dataclass
class Checklist:
    rows: list[Row] = field(default_factory=list)
    services: dict[str, bool] = field(default_factory=dict)
    outside: dict[str, Any] = field(default_factory=dict)

    def out(self, *, dismissed: bool) -> dict[str, Any]:
        rows = [asdict(r) for r in self.rows]
        left = [r for r in self.rows if r.status in ("todo", "problem")]
        return {
            "rows": rows,
            "services": self.services,
            "outside": self.outside,
            "done": sum(1 for r in self.rows if r.status == "done"),
            "total": len(self.rows),
            "essential_left": sum(1 for r in left if r.group == "essential"),
            "left": len(left),
            "dismissed": dismissed,
        }


# ---------------------------------------------------------------- helpers


def profiles() -> set[str]:
    """The compose profiles this install was started with, when the server
    was told (``PROMPTLY_PROFILES``). Empty on installs that predate it and
    in test stacks: then only what answers counts as there."""
    raw = get_settings().PROMPTLY_PROFILES or ""
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


# The address ranges home routers hand out.
_HOME_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def _private_ip(host: str) -> str | None:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None
    if ip.version == 4 and any(ip in net for net in _HOME_NETS):
        return str(ip)
    return None


def lan_address(request_host: str | None) -> str | None:
    """This machine's address on the home network, when the server knows
    it: what the installer wrote down, else the address the admin's own
    browser is using if that is a home-network one."""
    s = get_settings()
    for raw in (s.SERVER_LAN_IP,):
        ip = _private_ip((raw or "").strip())
        if ip:
            return ip
    host = (request_host or "").strip()
    if host.startswith("["):
        return None
    return _private_ip(host.rsplit(":", 1)[0]) if host else None


async def _within(coro, default):  # noqa: ANN001
    try:
        return await asyncio.wait_for(coro, PROBE_TIMEOUT_S)
    except Exception:  # noqa: BLE001 — a probe that fails is "not there"
        return default


async def _ollama_there() -> bool:
    from app.custom_models.router import _local_ollama_base, _ollama_installed_models

    return (await _ollama_installed_models(_local_ollama_base())) is not None


async def _calls_state() -> str:
    from app.calls import checks

    state, _err, _rooms = await checks.server_status()
    return state


async def _calls_tests(redis) -> tuple[dict | None, dict | None]:  # noqa: ANN001
    from app.calls import checks

    return await checks._get_json(redis, checks.TEST_INSIDE), await checks._get_json(redis, checks.TEST_OUTSIDE)


def _maps_state() -> dict[str, Any]:
    from app.maps import data

    state = data.status()
    manifest = data.manifest()
    return {
        "state": state.get("state") or "off",
        "step": state.get("step") or None,
        "ready": manifest is not None,
    }


def _https(origins: list[str]) -> bool:
    return any(o.lower().startswith("https://") for o in origins)


def _local_only(origins: list[str]) -> list[str]:
    """Origins that are a real outside address (not localhost or a bare
    home-network IP)."""
    out = []
    for o in origins:
        host = re.sub(r"^https?://", "", o.lower()).split("/", 1)[0].rsplit(":", 1)[0]
        if host in ("localhost", "127.0.0.1", "[::1]") or _private_ip(host):
            continue
        out.append(o)
    return out


# -------------------------------------------------------------- checklist


async def checklist(db: AsyncSession, admin: User, redis, *, request_host: str | None = None) -> Checklist:  # noqa: ANN001
    from app.backups.models import BackupRun
    from app.backups.offsite import status as offsite_status
    from app.models_config.models import ModelProvider
    from app.models_config.router import list_available_models_for
    from app.photos import ml
    from app.rtc import config as rtc_config
    from app.search.models import SearchProvider
    from app.talk.admin import _speech

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)

    # ---- What the database says (one after another: one session) ----
    providers = (await db.execute(select(ModelProvider).where(ModelProvider.enabled.is_(True)))).scalars().all()
    models = await list_available_models_for(admin, db) if providers else []
    chat_models = [m for m in models if _chat_candidate(m.model_id, bool(m.supports_image_output))]
    people = int((await db.execute(select(func.count()).select_from(User).where(User.disabled.is_(False)))).scalar_one())
    searchers = int(
        (await db.execute(select(func.count()).select_from(SearchProvider).where(SearchProvider.enabled.is_(True)))).scalar_one()
    )
    offsite = await offsite_status(db)
    last_backup = (
        await db.execute(
            select(BackupRun.created_at).where(BackupRun.status == "ok", BackupRun.kind.in_(("nightly", "pre_migrate", "manual")))
            .order_by(BackupRun.created_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    embed_provider = await db.get(ModelProvider, row.embedding_provider_id) if row.embedding_provider_id else None
    from app.custom_models import builtin

    promptly = await builtin.get(db)
    origins = list(row.public_origins or [])

    # ---- What the other services say (side by side) ----
    profs = profiles()
    calls_keys = rtc_config.configured()
    calls_state, tests, speech, photos_health, ollama, maps = await asyncio.gather(
        _within(_calls_state(), "down") if calls_keys else _const("setup"),
        _within(_calls_tests(redis), (None, None)),
        _within(_speech(), {"listening": {"reachable": False}, "speaking": {"reachable": False}}),
        _within(ml.health(), None),
        _within(_ollama_there(), False),
        asyncio.to_thread(_maps_state),
    )
    inside, outside_test = tests
    # The installer makes the calls keys even when calls are left out, so
    # keys alone don't mean the service is part of this install.
    has_calls = calls_state == "ok" or bool(profs & {"calls", "calls-desktop"}) or bool(row.calls_enabled)
    has_maps = maps["state"] != "off" or maps["ready"] or "maps" in profs
    hears = bool((speech.get("listening") or {}).get("reachable"))
    speaks = bool((speech.get("speaking") or {}).get("reachable"))
    has_voice = hears or speaks
    has_photos = photos_health is not None
    has_search = searchers > 0 or bool(get_settings().SEARXNG_ENABLED and "search" in profs)
    has_home = bool(profs & {"home", "home-desktop"}) or bool(row.home_enabled)

    out = Checklist()
    out.services = {
        "calls": has_calls,
        "maps": has_maps,
        "voice": has_voice,
        "photos": has_photos,
        "search": has_search,
        "local_models": bool(ollama),
        "home": has_home,
    }
    add = out.rows.append

    # ---- Essential: the assistant ----
    if not providers:
        add(Row(
            "provider", "Connect an AI service", "essential", "todo",
            "Nothing can answer yet: chat, the assistant inside each app, summaries and Talk all need one.",
            "/setup?step=provider", "Connect one",
        ))
    elif not chat_models:
        add(Row(
            "provider", "Connect an AI service", "essential", "problem",
            f"{providers[0].name} is connected but has no models to chat with yet.",
            "/admin?tab=models", "Open Models",
        ))
    else:
        names = ", ".join(sorted({p.name for p in providers}))
        add(Row("provider", "Connect an AI service", "essential", "done", f"Connected: {names}."))

    chat_ok = bool(row.default_chat_configured) and _still_there(row.default_chat_provider_id, row.default_chat_model_id, models)
    behind = (
        next((m for m in models if m.provider_id == promptly.base_provider_id and m.model_id == promptly.base_model_id), None)
        if promptly is not None and builtin.ready(promptly) else None
    )
    if not chat_models:
        add(Row(
            "models", "Choose the models Promptly uses", "essential", "todo",
            "Waits for an AI service to be connected.",
            "/setup?step=provider", "Connect one",
        ))
    elif promptly is not None and behind is None:
        # The built-in model exists but nothing (usable) is behind it.
        add(Row(
            "models", "Choose the models Promptly uses", "essential", "todo",
            f"{promptly.display_name} doesn't have a model behind it yet, so it can't answer.",
            "/setup?step=models", "Choose",
        ))
    elif promptly is not None:
        is_default = row.default_chat_model_id == f"custom:{promptly.id}"
        extras = [
            label for label, on in (
                ("quick jobs", row.memory_configured), ("Talk", row.voice_configured),
                ("reading pictures", row.vision_relay_configured), ("making pictures", row.image_gen_configured),
            ) if on
        ]
        add(Row(
            "models", "Choose the models Promptly uses", "essential", "done",
            f"{promptly.display_name} answers with {behind.display_name or behind.model_id}."
            + (
                "" if is_default
                else f" New chats start on {_model_name(row.default_chat_provider_id, row.default_chat_model_id, models)}." if chat_ok
                else ""
            )
            + (f" Also chosen: {', '.join(extras)}." if extras else ""),
            "/setup?step=models", "Change",
        ))
    elif not chat_ok:
        add(Row(
            "models", "Choose the models Promptly uses", "essential", "todo",
            "No model is chosen for new chats, so each one starts on whichever comes first in the list.",
            "/setup?step=models", "Choose",
        ))
    else:
        extras = [
            label for label, on in (
                ("quick jobs", row.memory_configured), ("Talk", row.voice_configured),
                ("reading pictures", row.vision_relay_configured), ("making pictures", row.image_gen_configured),
            ) if on
        ]
        add(Row(
            "models", "Choose the models Promptly uses", "essential", "done",
            f"New chats use {_model_name(row.default_chat_provider_id, row.default_chat_model_id, models)}."
            + (f" Also chosen: {', '.join(extras)}." if extras else ""),
            "/setup?step=models", "Change",
        ))

    if row.embedding_provider_id and row.embedding_model_id and embed_provider is not None and embed_provider.enabled:
        add(Row(
            "search_model", "Let the assistant read your files", "essential", "done",
            f"Files, notes and photos are indexed with {row.embedding_model_id}.",
        ))
    else:
        add(Row(
            "search_model", "Let the assistant read your files", "essential", "todo",
            "Not set up: the assistant can't find things in your files and notes, and search only matches exact words.",
            "/setup?step=search", "Set up",
        ))

    # ---- Recommended ----
    real = _local_only(origins)
    if real and _https(real):
        add(Row("address", "Give Promptly an address", "recommended", "done", f"People reach it at {real[0]}."))
    elif real:
        add(Row(
            "address", "Give Promptly an address", "recommended", "problem",
            f"{real[0]} isn't a secure (https) address. Phones won't allow the microphone, camera or app install on it.",
            "/setup?step=outside", "Fix",
        ))
    else:
        add(Row(
            "address", "Give Promptly an address", "recommended", "todo",
            "Only works at home for now. To use it away from home, and for the microphone and installing on phones, it needs a secure (https) address.",
            "/setup?step=outside", "Set up",
        ))

    if row.smtp_configured:
        add(Row("email", "Let Promptly send email", "recommended", "done", f"Sends as {row.smtp_from_address}."))
    else:
        add(Row(
            "email", "Let Promptly send email", "recommended", "todo",
            "Without it there are no password reset links, sign-in codes by email, or welcome emails for new people.",
            "/setup?step=email", "Set up",
        ))

    if admin.has_mfa:
        add(Row("mfa", "Protect your account with a second step", "recommended", "done", "Two-step sign-in is on for your account."))
    else:
        add(Row(
            "mfa", "Protect your account with a second step", "recommended", "todo",
            "Your account controls the whole server. A code from your phone keeps it safe if the password leaks.",
            "/setup?step=mfa", "Turn on",
        ))

    if offsite.configured and offsite.healthy:
        add(Row("backups", "Keep a backup somewhere else", "recommended", "done", "Copies leave this machine every night."))
    elif offsite.configured:
        add(Row(
            "backups", "Keep a backup somewhere else", "recommended", "problem",
            offsite.warning or "The off-site backup needs a look.", "/admin?tab=backups", "Open Backups",
        ))
    else:
        add(Row(
            "backups", "Keep a backup somewhere else", "recommended", "todo",
            ("A backup is made on this machine every night. " if last_backup else "Backups are made on this machine every night. ")
            + "If the machine dies or is stolen they go with it, so add a second place.",
            "/admin?tab=backups", "Set up",
        ))

    if people > 1:
        add(Row("people", "Add your family", "recommended", "done", f"{people} people have an account."))
    else:
        add(Row(
            "people", "Add your family", "recommended", "todo",
            "You're the only one here. Make an account for each person and Promptly gives you a note to send them.",
            "/admin?tab=users", "Add someone",
        ))

    # ---- Outside Promptly: only what this install has ----
    udp, tcp = rtc_config.media_ports()
    if has_calls:
        if calls_state != "ok":
            add(Row(
                "calls", "Calls from outside your home", "outside", "problem",
                "The calls service isn't answering.", "/admin?tab=calls", "Open Calls",
            ))
        elif outside_test and outside_test.get("ok"):
            add(Row("calls", "Calls from outside your home", "outside", "done", "A test call from outside your home connected."))
        elif outside_test:
            add(Row(
                "calls", "Calls from outside your home", "outside", "problem",
                f"The last test call from outside couldn't connect. Forward UDP {udp} and TCP {tcp} on your router to this machine.",
                "/setup?step=outside", "Show me",
            ))
        else:
            add(Row(
                "calls", "Calls from outside your home", "outside", "todo",
                "Calls work at home" + (" (tested)" if inside and inside.get("ok") else "")
                + f". Away from home they need two ports opened on your router (UDP {udp} and TCP {tcp}), then a test call with Wi-Fi off.",
                "/setup?step=outside", "Show me",
            ))

    if has_maps:
        if maps["ready"] and maps["state"] != "failed":
            add(Row("maps", "Maps", "extra", "done", "The map is ready."))
        elif maps["state"] == "none":
            # Written by the maps service once it waits for a country to be
            # chosen (maps-regions); older builds never say it.
            add(Row(
                "maps", "Maps", "extra", "todo",
                "No map chosen yet. Pick your country and Promptly downloads it in the background.",
                "/setup?step=maps", "Choose",
            ))
        elif maps["state"] == "failed":
            add(Row(
                "maps", "Maps", "extra", "problem",
                f"Getting the map stopped at the {maps['step'] or 'first'} step. It tries again by itself.",
                "/admin?tab=settings", "Open Settings",
            ))
        else:
            add(Row(
                "maps", "Maps", "extra", "working",
                "The map is still being put together"
                + (f" (now: {maps['step']})" if maps["step"] else "")
                + ". It takes about an hour the first time and needs 15 GB of disk. Nothing for you to do.",
            ))

    # ---- Extras ----
    if has_voice:
        if hears and speaks:
            add(Row(
                "talk", "Talk and dictation", "extra", "done",
                "Speech runs on this server. On phones the microphone needs a secure (https) address.",
            ))
        else:
            add(Row(
                "talk", "Talk and dictation", "extra", "problem",
                ("Listening" if not hears else "Speaking") + " isn't answering yet. It can take a few minutes after the first start.",
                "/admin?tab=talk", "Open Talk",
            ))

    if has_photos:
        state = (photos_health or {}).get("state")
        if state == "ready":
            add(Row("photos", "Photo search and faces", "extra", "done", "Photos are understood on this server. Each person sets up their own library in Photos."))
        elif state == "error":
            add(Row("photos", "Photo search and faces", "extra", "problem", "The photo models couldn't be prepared.", "/admin?tab=storage", "Open Storage"))
        else:
            add(Row("photos", "Photo search and faces", "extra", "working", "The photo models are downloading. Nothing for you to do."))

    if searchers:
        add(Row("web_search", "Searching the web", "extra", "done", "The assistant can look things up online."))
    else:
        add(Row(
            "web_search", "Searching the web", "extra", "todo",
            "The assistant can't look anything up online until a search service is added.",
            "/admin?tab=connectors", "Add one",
        ))

    out.outside = {
        "origins": origins,
        "address": real[0] if real else None,
        "https": bool(real and _https(real)),
        "lan_address": lan_address(request_host),
        "ports": {"udp": udp, "tcp": tcp},
        "calls": {
            "there": has_calls,
            "running": calls_state == "ok",
            "enabled": bool(row.calls_enabled),
            "inside_ok": bool(inside and inside.get("ok")),
            "outside": None if not outside_test else bool(outside_test.get("ok")),
        },
        "maps": {"there": has_maps, **maps},
        "voice": {"there": has_voice},
        "push": {"ready": bool(row.vapid_public_key)},
    }
    return out


async def _const(value):  # noqa: ANN001
    return value


def _still_there(provider_id, model_id, models) -> bool:  # noqa: ANN001
    return any(m.provider_id == provider_id and m.model_id == model_id for m in models)


def _model_name(provider_id, model_id, models) -> str:  # noqa: ANN001
    for m in models:
        if m.provider_id == provider_id and m.model_id == model_id:
            return m.display_name or m.model_id
    return str(model_id)


# ------------------------------------------------------- model suggestions

# Never a chat model, whatever else its name says.
_NOT_CHAT = (
    "embed", "whisper", "tts", "audio", "realtime", "transcri", "moderation", "guard", "rerank",
    "dall-e", "imagen", "sora", "veo", "computer-use", "codex", "search", "-image", "image-",
)
# Variants to pass over when the plain one is there.
_VARIANT = ("preview", "beta", "exp", ":free", "thinking", ":extended", ":nitro", ":floor", "latest")
# Small and quick, by the names providers use for that tier.
_FAST = ("haiku", "flash", "mini", "nano", "lite", "small")

# Families in the order they're tried, as words that must all be in the
# id and words that must not. A guess at "a good everyday model" from the
# names alone: the admin sees the pick and can change it.
_MAIN: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("sonnet",), ()),
    (("gpt-5",), ("pro",)),
    (("gemini", "pro"), ()),
    (("gpt-4.1",), ()),
    (("gpt-4o",), ()),
    (("deepseek",), ("reasoner", "r1")),
    (("opus",), ()),
    (("grok",), ()),
    (("mistral-large",), ()),
    (("llama",), ()),
]
_QUICK: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("haiku",), ()),
    (("gemini", "flash"), ("lite",)),
    (("gpt-5", "mini"), ()),
    (("gpt-4.1", "mini"), ()),
    (("gpt-4o", "mini"), ()),
    (("gemini", "flash"), ()),
    (("mini",), ()),
    (("nano",), ()),
    (("small",), ()),
    (("lite",), ()),
]
_PICTURES: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("gemini", "image"), ()),
    (("gpt", "image"), ()),
]


def _chat_candidate(model_id: str, image_output: bool) -> bool:
    mid = model_id.lower()
    if image_output or mid.startswith("custom:"):
        return False
    return not any(w in mid for w in _NOT_CHAT)


def _version(model_id: str) -> tuple[int, ...]:
    """The numbers in a model's name, newest sorting last. Dates and sizes
    (four digits and up) aren't versions."""
    plain = re.sub(r"\d{4}-\d{2}-\d{2}", " ", model_id.lower())
    return tuple(int(n) for n in re.findall(r"\d+", plain) if len(n) < 4)


def _is_fast(model_id: str) -> bool:
    # Whole words only: "gemini" has "mini" in it.
    return any(t in _FAST for t in re.split(r"[^a-z]+", model_id.lower()))


def _best(models: list, families, *, fast: bool | None) -> Any | None:  # noqa: ANN001
    for must, never in families:
        hits = []
        for m in models:
            mid = m.model_id.lower()
            if not all(w in mid for w in must) or any(w in mid for w in never):
                continue
            if fast is not None and _is_fast(mid) != fast:
                continue
            hits.append(m)
        if hits:
            # The plain name first, then the newest, then the shorter id.
            return sorted(
                hits,
                key=lambda m: (
                    not any(v in m.model_id.lower() for v in _VARIANT),
                    _version(m.model_id),
                    -len(m.model_id),
                ),
            )[-1]
    return None


ROLES: list[dict[str, str]] = [
    {
        "role": "chat", "field": "default_chat", "label": "Chat",
        "what": "The model a new chat starts on, and the assistant inside each app.",
        "unset": "Whichever comes first in the list",
    },
    {
        "role": "quick", "field": "memory", "label": "Quick jobs",
        "what": "Small jobs behind the scenes, like remembering what you tell it. A small, fast model keeps the cost down.",
        "unset": "Same model as the chat",
    },
    {
        "role": "voice", "field": "voice", "label": "Talk",
        "what": "Answers when you speak to Promptly. A fast model makes it feel like a conversation.",
        "unset": "Same model as the chat",
    },
    {
        "role": "see", "field": "vision_relay", "label": "Reading pictures",
        "what": "Describes a picture for you when the chat's own model can't see pictures.",
        "unset": "Pictures are skipped by models that can't see",
    },
    {
        "role": "draw", "field": "image_gen", "label": "Making pictures",
        "what": "Used when someone asks the chat to draw or edit a picture.",
        "unset": "The first model that can make pictures, if there is one",
    },
]


def suggest_models(models: list, row: AppSettings | None, promptly=None) -> dict[str, Any]:  # noqa: ANN001
    """A pick for each job from ``models`` (the admin's available models).

    With ``promptly`` (the built-in custom model, when it still exists) the
    chat job is "the model behind Promptly": saving it goes through
    :func:`set_promptly_model`, which also makes Promptly the default for
    new chats."""
    chat = [m for m in models if _chat_candidate(m.model_id, bool(m.supports_image_output))]
    seeing = [m for m in chat if m.supports_vision]
    drawing = [m for m in models if m.supports_image_output and not m.model_id.startswith("custom:")]

    main = _best(chat, _MAIN, fast=False) or (chat[0] if chat else None)
    quick = _best(chat, _QUICK, fast=True)
    # The same provider as the chat model when it has a quick one: one bill.
    if main is not None and quick is not None and quick.provider_id != main.provider_id:
        same = _best([m for m in chat if m.provider_id == main.provider_id], _QUICK, fast=True)
        quick = same or quick
    see = _best(seeing, _QUICK, fast=True) or _best(seeing, _MAIN, fast=False)
    draw = _best(drawing, _PICTURES, fast=None) or (drawing[0] if drawing else None)
    picks = {"chat": main, "quick": quick, "voice": quick, "see": see, "draw": draw}

    def pair(m) -> dict[str, Any] | None:  # noqa: ANN001
        if m is None:
            return None
        return {
            "provider_id": str(m.provider_id), "model_id": m.model_id,
            "name": m.display_name or m.model_id, "provider_name": m.provider_name,
        }

    def current(field: str) -> dict[str, Any] | None:
        if field == "default_chat" and promptly is not None:
            hit = next(
                (m for m in models if m.provider_id == promptly.base_provider_id and m.model_id == promptly.base_model_id),
                None,
            ) if promptly.base_provider_id else None
            return pair(hit) if hit else None
        if row is None:
            return None
        pid, mid = getattr(row, f"{field}_provider_id", None), getattr(row, f"{field}_model_id", None)
        if not (pid and mid):
            return None
        hit = next((m for m in models if m.provider_id == pid and m.model_id == mid), None)
        return pair(hit) if hit else None

    roles = [dict(r) for r in ROLES]
    if promptly is not None:
        roles[0].update(
            label=f"The model behind {promptly.display_name}",
            what=(
                f"{promptly.display_name} is what people chat with, and the assistant inside each app. "
                "This is the model that does its thinking. Other models you connected stay in the list for anyone who wants them."
            ),
            unset=f"None yet ({promptly.display_name} can't answer)",
        )
    return {
        "has_models": bool(chat),
        "promptly": (
            {
                "id": str(promptly.id),
                "display_name": promptly.display_name,
                "ready": bool(promptly.base_provider_id and promptly.base_model_id),
                "is_default": bool(row is not None and row.default_chat_model_id == f"custom:{promptly.id}"),
            }
            if promptly is not None else None
        ),
        "roles": [
            {
                **r,
                "only": "vision" if r["role"] == "see" else "image" if r["role"] == "draw" else "chat",
                "suggestion": pair(picks[r["role"]]),
                "current": current(r["field"]),
            }
            for r in roles
        ],
    }


def embedding_options(providers: list) -> list[dict[str, Any]]:  # noqa: ANN001
    """One-click embedding ("reading") models the connected services offer.

    OpenRouter serves embeddings at ``POST /api/v1/embeddings`` with the
    OpenAI request shape (checked against its API reference and its
    ``/api/v1/embeddings/models`` list, 2026-11-23), so an OpenRouter-only
    install can use ``openai/text-embedding-3-small`` through the key it
    already has. 1536 dimensions is one of the two sizes the database stores.
    """
    out: list[dict[str, Any]] = []
    for p in providers:
        if not getattr(p, "enabled", True):
            continue
        model = {"openai": "text-embedding-3-small", "openrouter": "openai/text-embedding-3-small"}.get(p.type)
        if model:
            out.append({
                "provider_id": str(p.id), "provider_name": p.name, "provider_type": p.type,
                "model_id": model, "dim": 1536,
            })
    # A direct OpenAI key first: one hop fewer.
    return sorted(out, key=lambda o: o["provider_type"] != "openai")
