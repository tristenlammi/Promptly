"""Scheduled Tasks / Automations (Roadmap v2 — Phase 1).

A Task is a saved prompt + a recurrence. On schedule it runs **headless**
(no human in the loop) and produces a discrete, dated :class:`TaskRun` —
a standalone report, not an ever-growing chat thread. See ``runner.py``
for the execution engine and ``scheduler.py`` for the polling loop.
"""
