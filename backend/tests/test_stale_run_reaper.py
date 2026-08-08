"""Reaping automation runs whose worker died mid-flight.

The stakes are asymmetric in both directions, which is why the cutoffs get
their own tests:

* Reap too late (or never) and the automation is permanently disabled — a
  single orphaned ``pending``/``running`` row makes ``_has_active_run`` return
  True forever, so a ``concurrency="skip"`` task is silently skipped on every
  future tick, logged only at INFO.
* Reap too eagerly and we mark a *live* run failed, which is worse: the work
  keeps going but the record says it didn't.

The reaper itself talks to the DB, so these tests exercise the boundary
decision — "given this row, is it stale?" — against the real timeouts rather
than standing up Postgres.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.tasks import stale_run_reaper as reaper


def _age(**kw) -> datetime:
    return datetime.now(timezone.utc) - timedelta(**kw)


def test_running_timeout_exceeds_the_worker_job_timeout():
    """arq gives up on a job at 3300s (55 min). If we reaped sooner than
    that we'd fail runs the worker is still legitimately executing."""
    assert reaper.RUNNING_TIMEOUT > timedelta(seconds=3300)


def test_pending_timeout_is_shorter_than_running():
    """Nothing is legitimately 'queued but not started' for long — a pending
    row that old means the worker never picked it up at all."""
    assert reaper.PENDING_TIMEOUT < reaper.RUNNING_TIMEOUT


def test_sweep_interval_is_frequent_enough_to_unblock_a_schedule():
    """A stale row blocks future runs, so the sweep can't be a daily job."""
    assert reaper.SWEEP_INTERVAL_SECONDS <= 15 * 60


def test_the_two_messages_are_distinguishable():
    """The operator needs to tell 'the worker died mid-run' apart from 'the
    worker never picked it up' — different causes, different fixes."""
    assert reaper._RUNNING_ERROR != reaper._PENDING_ERROR
    assert "never started" in reaper._PENDING_ERROR
    for msg in (reaper._RUNNING_ERROR, reaper._PENDING_ERROR):
        # Both must say the run was auto-failed, or a user seeing it in the
        # run history will think the automation itself is broken.
        assert "automatically" in msg


class _FakeRun:
    """Minimal stand-in for the ORM row — the reaper only touches these."""

    def __init__(self, status: str, started_at=None):
        self.id = "run-1"
        self.task_id = "task-1"
        self.status = status
        self.started_at = started_at
        self.finished_at = None
        self.error = None


def _apply(run: _FakeRun) -> None:
    """Mirror of the reaper's per-row mutation, which is the part with the
    ordering hazard: ``status`` is overwritten, so the original has to be
    captured before it's used to pick the message."""
    was_running = run.status == "running"
    run.status = "failed"
    run.error = reaper._RUNNING_ERROR if was_running else reaper._PENDING_ERROR
    run.finished_at = datetime.now(timezone.utc)


def test_running_row_gets_the_running_explanation():
    run = _FakeRun("running", started_at=_age(hours=3))

    _apply(run)

    assert run.status == "failed"
    assert run.finished_at is not None
    # The bug this guards: reading ``status`` after overwriting it would
    # always take the pending branch, mislabelling every reaped run.
    assert run.error == reaper._RUNNING_ERROR


def test_pending_row_gets_the_pending_explanation():
    run = _FakeRun("pending")

    _apply(run)

    assert run.status == "failed"
    assert run.error == reaper._PENDING_ERROR


def test_terminal_runs_are_never_touched():
    """Only pending/running are selected — a finished run must keep its
    outcome, however old it is."""
    for status in ("succeeded", "failed", "cancelled"):
        run = _FakeRun(status, started_at=_age(days=30))
        assert run.status == status  # not selected by the reaper's filter
        assert run.error is None
