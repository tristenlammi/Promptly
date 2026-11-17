"""Home automations: things a home does when asked, on a schedule, or when a
device changes.

An automation is a flow (the node editor's graph, ``app/tasks/flow_graph.py``)
that belongs to a home: "when I say *it's morning time*: kitchen lights on,
wait a minute, play some jazz in the lounge". It is a ``tasks`` row with
``home_id`` set, so it shares the flow engine, run history and version
history with every other automation, but:

* it's the **home's**: the owner makes and changes it (``access.py``), and
  everyone in the home can see it and run it. Nobody else can, an admin
  included. It's never listed with a person's own automations.
* its steps are home steps only (``flow_nodes.py``): everyday devices, never
  a lock, garage door, gate or alarm, and no AI steps.
* it runs **here**, in the server's main process, because that is where a
  home's box is connected (``relay.py``). The background worker can't reach
  a box, so :func:`start` never queues these.

**Phrases.** Each automation can have phrases. Said or typed to the
assistant, a phrase runs it without a model when it matches exactly after
levelling (case, punctuation, "hey Promptly", "please", number words,
"it's"/"its"/"it is"). Nothing looser: a near miss goes to the model, which
has a tool to run one by name and can ask. Two automations in a home can't
share a phrase (refused when saving).
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.background import spawn
from app.database import SessionLocal
from app.tasks.flow_graph import (
    HOME_ACTION_TYPES,
    DelayData,
    FlowGraph,
    FlowNode,
    HomeDeviceData,
    HomeLightsData,
    HomeMusicData,
    HomeStateData,
    HomeStateTriggerData,
    NodeType,
    ScheduleTriggerData,
    TimeWindowData,
    is_executable_graph,
)
from app.tasks.models import Task, TaskRun

from . import flow_nodes, relay
from .models import Home, HomeBox, HomeMember

logger = logging.getLogger("promptly.home.automations")

MAX_PER_HOME = 60
MAX_PHRASES = 6
MAX_PHRASE_CHARS = 80
MAX_STEPS = 40
MAX_WAIT_S = 30 * 60
MAX_WAITS_S = 60 * 60
MAX_RUNNING = 20
RUNS_KEPT = 30
# A device that flickers shouldn't start the same automation over and over.
DEVICE_TRIGGER_GAP_S = 10.0

ALLOWED = frozenset(
    {
        NodeType.TRIGGER_MANUAL,
        NodeType.TRIGGER_SCHEDULE,
        NodeType.TRIGGER_HOME_STATE,
        NodeType.HOME_DEVICE,
        NodeType.HOME_LIGHTS,
        NodeType.HOME_MUSIC,
        NodeType.HOME_STATE,
        NodeType.TIME_WINDOW,
        NodeType.DELAY,
        NodeType.MERGE,
    }
)
TRIGGERS = frozenset({NodeType.TRIGGER_MANUAL, NodeType.TRIGGER_SCHEDULE, NodeType.TRIGGER_HOME_STATE})


class Problem(Exception):
    """Why something can't be saved or run, in words for the person."""


# ------------------------------------------------------------------ phrases
_APOS = re.compile(r"[’'`]")
_JOINED = (("it is", "its"), ("i am", "im"), ("we are", "were"), ("that is", "thats"), ("what is", "whats"), ("let us", "lets"))
_RUN_WORDS = ("run the", "start the", "do the", "activate the", "trigger the", "begin the", "run", "start", "do", "activate", "trigger", "begin")
_RUN_TAILS = (" automation", " routine", " scene")


def phrase_key(text: Any) -> str:
    """A phrase the way it's compared. "Hey Promptly, it's morning time!",
    "its morning time" and "It is morning time, please" are one."""
    from app.commands.matcher import normalise

    s = normalise(_APOS.sub("", str(text or "")))
    s = f" {s} "
    for long, short in _JOINED:
        s = s.replace(f" {long} ", f" {short} ")
    return s.strip()


def clean_phrases(raw: Any) -> list[str]:
    """The phrases as they'll be kept, or :class:`Problem`."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise Problem("Phrases should be a list.")
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = " ".join(str(item or "").split())
        if not text:
            continue
        if len(text) > MAX_PHRASE_CHARS:
            raise Problem(f"A phrase can be {MAX_PHRASE_CHARS} letters at most.")
        if "{" in text or "}" in text:
            raise Problem("A phrase is just words: leave out { and }.")
        k = phrase_key(text)
        if not k:
            raise Problem(f"“{text}” is only words Promptly ignores (like “please” or its own name). Add what it's for.")
        if len(k.split()) < 2 and len(k) < 6:
            raise Problem(f"“{text}” is too short to be said on purpose. Use two words or more.")
        if k in seen:
            continue
        seen.add(k)
        out.append(text)
    if len(out) > MAX_PHRASES:
        raise Problem(f"An automation can have {MAX_PHRASES} phrases at most.")
    return out


async def clash(db: AsyncSession, home_id: uuid.UUID, phrases: list[str], but: uuid.UUID | None = None) -> str | None:
    """A sentence about the first phrase another automation in this home
    already uses, or None."""
    mine = {phrase_key(p): p for p in phrases}
    if not mine:
        return None
    rows = (await db.execute(select(Task).where(Task.home_id == home_id))).scalars().all()
    for other in rows:
        if other.id == but:
            continue
        for p in other.phrases or []:
            if phrase_key(p) in mine:
                return f"“{mine[phrase_key(p)]}” is already what runs “{other.title}”. Each phrase can run one automation."
    return None


def said_for(text: str, task: Task) -> bool:
    """Whether these words are this automation's phrase, or "run <its name
    or phrase>"."""
    k = phrase_key(text)
    if not k:
        return False
    keys = {phrase_key(p) for p in task.phrases or []} - {""}
    if k in keys:
        return True
    rest = None
    for lead in _RUN_WORDS:
        if k.startswith(lead + " "):
            rest = k[len(lead) + 1 :]
            break
    if rest is None:
        return False
    # "run the morning routine": its name may itself end in "routine".
    wanted = keys | {phrase_key(task.title)}
    if rest in wanted:
        return True
    for tail in _RUN_TAILS:
        if rest.endswith(tail) and rest[: -len(tail)] in wanted:
            return True
    return False


# ------------------------------------------------------------------ the graph
def blank_graph() -> dict[str, Any]:
    return {"version": 1, "mode": "advanced", "nodes": [{"id": "trigger", "type": NodeType.TRIGGER_MANUAL, "position": {"x": 0, "y": 0}, "data": {}}], "edges": []}


def graph_of(task: Task) -> FlowGraph:
    try:
        return FlowGraph.model_validate(task.flow_graph or blank_graph())
    except Exception:  # noqa: BLE001 - a broken stored graph reads as an empty one
        return FlowGraph.model_validate(blank_graph())


def steps_in(graph: FlowGraph) -> int:
    return sum(1 for n in graph.nodes if n.type in HOME_ACTION_TYPES)


def trigger_of(graph: FlowGraph) -> FlowNode | None:
    return next((n for n in graph.nodes if n.type in TRIGGERS), None)


def trigger_words(graph: FlowGraph) -> tuple[str, str]:
    """``(kind, words)`` for how it starts: ``asked`` / ``schedule`` / ``device``."""
    trig = trigger_of(graph)
    if trig is None or trig.type == NodeType.TRIGGER_MANUAL:
        return "asked", "When someone asks"
    if trig.type == NodeType.TRIGGER_SCHEDULE:
        from app.tasks.recurrence import describe_schedule

        try:
            s = ScheduleTriggerData.model_validate(trig.data)
            return "schedule", describe_schedule(
                frequency=s.frequency, hour=s.hour, minute=s.minute, weekday=s.weekday, day_of_month=s.day_of_month,
                tz_name=s.timezone, interval_minutes=s.interval_minutes, weekdays=s.weekdays,
            ).split(" (")[0]
        except Exception:  # noqa: BLE001
            return "schedule", "On a schedule"
    d = HomeStateTriggerData.model_validate(trig.data)
    return "device", f"When {d.name or 'a device'} turns {d.state}"


async def validate(db: AsyncSession, home_id: uuid.UUID, graph: FlowGraph, *, tz_default: str = "") -> FlowGraph:
    """The graph as it'll be kept, or :class:`Problem` saying what to fix."""
    if len(graph.nodes) > MAX_STEPS + 1:
        raise Problem(f"That's a lot of steps. An automation can have {MAX_STEPS} at most.")
    for n in graph.nodes:
        if n.type not in ALLOWED:
            raise Problem("A home automation can only use home steps: devices, room lights, music, waits and checks.")
    triggers = [n for n in graph.nodes if n.type in TRIGGERS]
    if len(triggers) != 1:
        raise Problem("An automation needs exactly one “When…” to start it.")
    if steps_in(graph) < 1:
        raise Problem("Add at least one thing for it to do.")
    if not is_executable_graph(graph, needs_output=False):
        raise Problem("Every step has to be joined on, with no loops. Join the loose ones or remove them.")
    trig = triggers[0]
    waits = 0
    for n in graph.nodes:
        if n.type == NodeType.DELAY:
            secs = int(DelayData.model_validate(n.data).seconds or 0)
            if not 1 <= secs <= MAX_WAIT_S:
                raise Problem(f"A wait can be from 1 second to {MAX_WAIT_S // 60} minutes.")
            waits += secs
        elif n.type == NodeType.HOME_DEVICE:
            d = HomeDeviceData.model_validate(n.data)
            if not d.entity:
                raise Problem("One of the device steps has no device picked yet.")
            try:
                dev = await flow_nodes.device(db, home_id, d.box, d.entity, d.name)
                n.data = {**n.data, "name": dev["name"], "value": flow_nodes.check_step(dev, d.action, d.value)}
            except flow_nodes.StepFailed as e:
                raise Problem(str(e)) from e
        elif n.type == NodeType.HOME_LIGHTS:
            lights = HomeLightsData.model_validate(n.data)
            if not lights.area:
                raise Problem("One of the room steps has no room picked yet.")
            name = await _room_name(db, home_id, lights.box, lights.area)
            if name is None:
                raise Problem(f"{lights.name or 'That room'} isn't in this home any more.")
            n.data = {**n.data, "name": name}
        elif n.type == NodeType.HOME_MUSIC:
            m = HomeMusicData.model_validate(n.data)
            if not m.entity:
                raise Problem("The music step has no speaker picked yet.")
            try:
                dev = await flow_nodes.device(db, home_id, m.box, m.entity, m.name)
            except flow_nodes.StepFailed as e:
                raise Problem(str(e)) from e
            if dev.get("domain") != "media_player" or dev.get("careful"):
                raise Problem(f"{dev['name']} isn't a speaker.")
            if m.uri:
                from . import music

                if not music.clean_results([{"uri": m.uri, "kind": m.uri.split("://", 1)[-1].split("/", 1)[0], "name": m.label or "x"}]):
                    raise Problem("Pick the music again: that one can't be played.")
            if m.volume is not None and not 0 <= int(m.volume) <= 100:
                raise Problem("Volume goes from 0 to 100.")
            n.data = {**n.data, "name": dev["name"], "query": m.query.strip()[:120], "label": m.label.strip()[:160]}
        elif n.type == NodeType.HOME_STATE:
            c = HomeStateData.model_validate(n.data)
            if not c.entity:
                raise Problem("One of the checks has no device picked yet.")
            try:
                dev = await flow_nodes.device(db, home_id, c.box, c.entity, c.name)
            except flow_nodes.StepFailed as e:
                raise Problem(str(e)) from e
            n.data = {**n.data, "name": dev["name"], "state": (c.state or "on").strip().lower()[:40]}
        elif n.type == NodeType.TIME_WINDOW:
            w = TimeWindowData.model_validate(n.data)
            for hhmm in (w.start, w.end):
                if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", hhmm or ""):
                    raise Problem("A time check needs a start and an end time.")
            n.data = {**n.data, "days": sorted({d for d in w.days if isinstance(d, int) and 0 <= d <= 6}), "timezone": w.timezone or tz_default}
    if waits > MAX_WAITS_S:
        raise Problem(f"The waits add up to more than {MAX_WAITS_S // 60} minutes. Shorten them, or split this into two automations.")
    if trig.type == NodeType.TRIGGER_SCHEDULE:
        from app.tasks.recurrence import compute_next_run

        try:
            s = ScheduleTriggerData.model_validate({**trig.data, "timezone": (trig.data or {}).get("timezone") or tz_default or "Australia/Sydney"})
            if s.frequency == "minutes" and int(s.interval_minutes or 0) < 5:
                raise ValueError("too often")
            compute_next_run(
                frequency=s.frequency, after=datetime.now(timezone.utc), hour=s.hour, minute=s.minute, weekday=s.weekday,
                day_of_month=s.day_of_month, interval_minutes=s.interval_minutes, weekdays=s.weekdays, tz_name=s.timezone,
            )
        except Exception as e:  # noqa: BLE001
            raise Problem("Pick when it should run: a time, and the days.") from e
        trig.data = s.model_dump()
    elif trig.type == NodeType.TRIGGER_HOME_STATE:
        t = HomeStateTriggerData.model_validate(trig.data)
        if not t.entity:
            raise Problem("Pick the device that starts it.")
        try:
            dev = await flow_nodes.device(db, home_id, t.box, t.entity, t.name)
        except flow_nodes.StepFailed as e:
            raise Problem(str(e)) from e
        trig.data = {**trig.data, "name": dev["name"], "state": (t.state or "on").strip().lower()[:40]}
    graph.mode = "advanced"
    return graph


async def _room_name(db: AsyncSession, home_id: uuid.UUID, box: Any, area: str) -> str | None:
    try:
        box_id = uuid.UUID(str(box))
    except (ValueError, TypeError):
        return None
    row = await db.get(HomeBox, box_id)
    if row is None or row.home_id != home_id or row.revoked_at is not None:
        return None
    _on, _live, _entities, areas = relay.view(row.id, row.snapshot)
    return next((str(a.get("name") or "") for a in areas if str(a.get("id")) == area), None)


def apply(task: Task, graph: FlowGraph) -> None:
    """Keep a checked graph on the automation, with its schedule where the
    scheduler looks for it."""
    task.flow_graph = graph.model_dump(mode="json")
    task.draft_graph = None
    trig = trigger_of(graph)
    task.next_run_at = None
    if trig is not None and trig.type == NodeType.TRIGGER_SCHEDULE:
        from app.tasks.recurrence import compute_next_run

        s = ScheduleTriggerData.model_validate(trig.data)
        task.frequency, task.hour, task.minute = s.frequency, s.hour, s.minute
        task.weekday, task.day_of_month = s.weekday, s.day_of_month
        task.interval_minutes, task.weekdays, task.timezone = s.interval_minutes, s.weekdays, s.timezone
        if task.enabled:
            task.next_run_at = compute_next_run(
                frequency=s.frequency, after=datetime.now(timezone.utc), hour=s.hour, minute=s.minute, weekday=s.weekday,
                day_of_month=s.day_of_month, interval_minutes=s.interval_minutes, weekdays=s.weekdays, tz_name=s.timezone,
            )
    forget(task.home_id)


async def rehome(db: AsyncSession, home_id: uuid.UUID, new_owner_id: uuid.UUID) -> None:
    """A home changed hands: its automations go with it. (They'd otherwise
    be deleted with the old owner's account.)"""
    await db.execute(update(Task).where(Task.home_id == home_id).values(user_id=new_owner_id))


# ------------------------------------------------------------------ device triggers
_state_triggers: dict[uuid.UUID, list[tuple[uuid.UUID, str, str, str]]] = {}
_last_fired: dict[uuid.UUID, float] = {}
_running: set[uuid.UUID] = set()


def reset() -> None:
    """Tests."""
    _state_triggers.clear()
    _last_fired.clear()
    _running.clear()


def forget(home_id: uuid.UUID | None) -> None:
    if home_id is not None:
        _state_triggers.pop(home_id, None)


async def _load_triggers(home_id: uuid.UUID) -> list[tuple[uuid.UUID, str, str, str]]:
    out: list[tuple[uuid.UUID, str, str, str]] = []
    async with SessionLocal() as db:
        rows = (await db.execute(select(Task).where(Task.home_id == home_id, Task.enabled.is_(True)))).scalars().all()
        for task in rows:
            trig = trigger_of(graph_of(task))
            if trig is not None and trig.type == NodeType.TRIGGER_HOME_STATE:
                d = HomeStateTriggerData.model_validate(trig.data)
                out.append((task.id, d.box, d.entity, d.state))
    _state_triggers[home_id] = out
    return out


async def on_state(home_id: uuid.UUID | None, box_id: uuid.UUID, old: dict[str, Any], new: dict[str, Any]) -> None:
    """A device of a home changed (``relay.py``): start the automations that
    wait for exactly that. Only a real change from one known state to the
    one asked for; never a device coming back from "unavailable"."""
    try:
        if home_id is None or old.get("state") == new.get("state"):
            return
        if str(old.get("state") or "") in ("unavailable", "unknown", "") or str(new.get("state") or "") in ("unavailable", "unknown", ""):
            return
        rows = _state_triggers.get(home_id)
        if rows is None:
            rows = await _load_triggers(home_id)
        now = time.monotonic()
        for task_id, box, entity, state in rows:
            if box != str(box_id) or entity != new.get("id"):
                continue
            if not flow_nodes.state_is(new, state) or flow_nodes.state_is(old, state):
                continue
            if now - _last_fired.get(task_id, -1e9) < DEVICE_TRIGGER_GAP_S:
                continue
            _last_fired[task_id] = now
            spawn(_fire(task_id), name=f"home_auto_device_{task_id}")
    except Exception:  # noqa: BLE001 - a device's news must never break the box's line
        logger.exception("home: a device trigger failed")


async def _fire(task_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        task = await db.get(Task, task_id)
        if task is None or task.home_id is None or not task.enabled:
            return
        try:
            await run_now(db, task, "device")
        except Problem as e:
            logger.info("home: automation %s not started by its device: %s", task_id, e)


# ------------------------------------------------------------------ running
def _budget(graph: FlowGraph) -> float:
    waits = sum(int(DelayData.model_validate(n.data).seconds or 0) for n in graph.nodes if n.type == NodeType.DELAY)
    return 120.0 + waits + 60.0 * steps_in(graph)


async def in_flight(db: AsyncSession, task_id: uuid.UUID) -> bool:
    since = datetime.now(timezone.utc) - timedelta(minutes=90)
    return (
        await db.execute(
            select(TaskRun.id).where(TaskRun.task_id == task_id, TaskRun.status.in_(("pending", "running")), TaskRun.created_at >= since).limit(1)
        )
    ).first() is not None


async def run_now(db: AsyncSession, task: Task, trigger: str, *, wait: float = 0.0) -> TaskRun:
    """Start a run (``trigger``: manual / phrase / device) and return it,
    having waited up to ``wait`` seconds for it to finish. :class:`Problem`
    when it can't start."""
    if steps_in(graph_of(task)) < 1:
        raise Problem(f"“{task.title}” has no steps yet.")
    if await in_flight(db, task.id):
        raise Problem(f"“{task.title}” is already running.")
    if len(_running) >= MAX_RUNNING:
        raise Problem("Too many automations are running right now. Try again in a moment.")
    run = TaskRun(task_id=task.id, status="pending", trigger=trigger[:10])
    db.add(run)
    await db.commit()
    await db.refresh(run)
    job = start(run.id)
    if wait > 0 and job is not None:
        await asyncio.wait({job}, timeout=wait)
        await db.refresh(run)
    return run


def start(run_id: uuid.UUID) -> asyncio.Task[Any] | None:
    """Run it here, now. Never queued: only this process can reach a box."""
    return spawn(execute(run_id), name=f"home_auto_run_{run_id}")


INTERRUPTED = "The server restarted while this was running, so the rest didn't happen."


async def close_interrupted() -> int:
    """At start-up: runs of home automations left pending or running belong
    to the process that just went away. Closed out, so "it's already
    running" never outlives a restart. Never raises."""
    try:
        async with SessionLocal() as db:
            home_tasks = select(Task.id).where(Task.home_id.is_not(None))
            done = await db.execute(
                update(TaskRun)
                .where(TaskRun.status.in_(("pending", "running")), TaskRun.task_id.in_(home_tasks))
                .values(status="failed", error=INTERRUPTED, finished_at=datetime.now(timezone.utc))
            )
            await db.commit()
            return int(done.rowcount or 0)
    except Exception:  # noqa: BLE001 - never the reason the server doesn't start
        logger.warning("home: couldn't close interrupted automation runs", exc_info=True)
        return 0


def summary(node_runs: list[dict[str, Any]] | None) -> str:
    """What a run did, a line a step, for the run's record."""
    lines: list[str] = []
    for r in node_runs or []:
        if r.get("status") == "skipped" or str(r.get("type") or "").startswith("trigger."):
            continue
        out = str(r.get("output") or "").strip()
        if not out:
            continue
        lines.append(f"- {'Didn’t work: ' if r.get('status') == 'error' else ''}{out}")
    return "\n".join(lines)


async def execute(run_id: uuid.UUID) -> None:
    """Carry out a pending run of a home automation. Never raises: what
    happened is written on the run."""
    from app.auth.models import User
    from app.tasks.graph_runner import FlowFailed, run_graph_flow
    from app.tasks.runner import TaskRunError

    _running.add(run_id)
    try:
        async with SessionLocal() as db:
            run = await db.get(TaskRun, run_id)
            task = await db.get(Task, run.task_id) if run is not None else None
            if run is None or task is None or task.home_id is None:
                return
            claimed = await db.execute(
                update(TaskRun).where(TaskRun.id == run.id, TaskRun.status == "pending").values(status="running", started_at=datetime.now(timezone.utc))
            )
            await db.commit()
            if not claimed.rowcount:
                return
            await db.refresh(run)
            title, home_id = task.title, task.home_id
            try:
                user = await db.get(User, task.user_id)
                graph = graph_of(task)
                _text, _sources, _usage, node_runs = await run_graph_flow(
                    task=task, graph=graph, user=user, run_started_at=run.started_at, trigger_payload=None, time_budget=_budget(graph), db=db,
                )
                failed = [r for r in node_runs if r.get("status") == "error"]
                did = [r for r in node_runs if r.get("type") in HOME_ACTION_TYPES and r.get("status") == "success"]
                run.node_runs = node_runs or None
                run.output_markdown = summary(node_runs)
                if failed and not did:
                    run.status = "failed"
                    run.error = str(failed[0].get("output") or "It didn't work.")[:500]
                else:
                    run.status = "warning" if failed else "success"
                    run.error = str(failed[0].get("output"))[:500] if failed else None
            except FlowFailed as e:
                run.status, run.error = "failed", str(e)[:500]
                run.node_runs = e.node_runs or None
                run.output_markdown = summary(e.node_runs)
            except TaskRunError as e:
                run.status, run.error = "failed", str(e)[:500]
            except Exception:  # noqa: BLE001
                logger.exception("home: automation run %s crashed", run_id)
                await db.rollback()
                await db.refresh(run)
                await db.refresh(task)
                run.status, run.error = "failed", "Something went wrong on the server."
            finally:
                run.finished_at = datetime.now(timezone.utc)
                run.title = title[:140]
                task.last_run_at = run.started_at
                task.last_status = run.status
                await db.commit()
            stale = (
                await db.execute(select(TaskRun.id).where(TaskRun.task_id == task.id).order_by(TaskRun.created_at.desc()).offset(RUNS_KEPT))
            ).scalars().all()
            if stale:
                await db.execute(delete(TaskRun).where(TaskRun.id.in_(stale)))
                await db.commit()
            relay.bump(home_id)
            if run.status == "failed" and run.trigger in ("schedule", "device"):
                await _tell_if_broken(db, task)
    except Exception:  # noqa: BLE001
        logger.exception("home: automation run %s could not be recorded", run_id)
    finally:
        _running.discard(run_id)


async def _tell_if_broken(db: AsyncSession, task: Task) -> None:
    """Three failures in a row, with nobody watching: tell whoever looks
    after it, once."""
    try:
        recent = (await db.execute(select(TaskRun.status).where(TaskRun.task_id == task.id).order_by(TaskRun.created_at.desc()).limit(4))).scalars().all()
        if len(recent) < 3 or any(s != "failed" for s in recent[:3]) or (len(recent) == 4 and recent[3] == "failed"):
            return
        from app.notifications import notify_user

        await notify_user(
            user_id=task.user_id,
            category="task_complete",
            title="A home automation keeps failing",
            body=f"“{task.title}” hasn't worked three times in a row. Have a look at it on the Home page.",
            url="/home",
            tag=f"promptly-home-auto-{task.id}",
        )
    except Exception:  # noqa: BLE001 - telling is never the reason anything fails
        logger.warning("home: the failing-automation notice wasn't sent", exc_info=True)


def result_words(task_title: str, run: TaskRun) -> tuple[bool, str]:
    """``(it worked, what to say)`` once a run has been started."""
    if run.status == "success":
        return True, f"Okay, {task_title} is done."
    if run.status in ("pending", "running"):
        return True, f"Okay, {task_title} has started."
    if run.status == "warning":
        return False, f"{task_title} ran, but part of it didn't work. {_why(run)}".strip()
    return False, f"{task_title} didn't work. {_why(run)}".strip()


def _why(run: TaskRun) -> str:
    why = str(run.error or "").strip()
    if ": " in why and " failed: " in why:
        why = why.split(" failed: ", 1)[1]
    return why if not why or why.endswith((".", "!", "?")) else why + "."


# ------------------------------------------------------------------ for the assistant
async def mine(db: AsyncSession, user_id: uuid.UUID) -> list[tuple[Task, Home]]:
    """Every automation of the homes this person is in."""
    from .router import enabled

    if not await enabled(db):
        return []
    rows = (
        await db.execute(
            select(Task, Home)
            .join(Home, Home.id == Task.home_id)
            .join(HomeMember, HomeMember.home_id == Home.id)
            .where(HomeMember.user_id == user_id)
            .order_by(Home.created_at, Task.title)
        )
    ).all()
    return [(t, h) for t, h in rows]


async def said(user_id: uuid.UUID, text: str, *, wait: float = 4.0) -> tuple[bool, str] | None:
    """Someone said (or typed) this. If it is exactly one switched-on
    automation's phrase, run it: ``(it worked, what to say)``. None when it
    isn't a phrase, or two homes of theirs use it (the model asks which)."""
    if not phrase_key(text):
        return None
    async with SessionLocal() as db:
        hits = [t for t, _h in await mine(db, user_id) if t.enabled and said_for(text, t)]
        if len(hits) != 1:
            return None
        task = hits[0]
        try:
            run = await run_now(db, task, "phrase", wait=wait)
        except Problem as e:
            return False, str(e)
        return result_words(task.title, run)
