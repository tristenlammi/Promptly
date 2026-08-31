"""The search failover chain has to respect its caller's deadline.

Providers are tried one after another, each capped at 10s. Four configured
providers can therefore spend 40s — longer than the 30s the chat tool used
to allow. The dispatcher cancelled the chain mid-request and the model got a
bare "tool timed out": no indication that two providers had been tried, that
one had a dead API key, or that a healthy provider was next in line.

Being cancelled is the worst outcome because everything learned is thrown
away. So the chain now stops *before* starting a provider it can't finish
and reports what it tried. These tests pin that decision, using a fake clock
rather than real sleeping.
"""
from __future__ import annotations

import types

import pytest

from app.search import service as svc


class _Provider:
    """Enough of a SearchProvider for ``_order_candidates``."""

    def __init__(self, name: str, position: int):
        self.id = name
        self.name = name
        self.type = name
        self.position = position
        self.created_at = position
        self.cooldown_until = None
        self.enabled = True
        self.user_id = None


@pytest.fixture
def chain(monkeypatch):
    """Four providers, a controllable clock, and a recording ``run_search``."""
    providers = [_Provider(f"p{i}", i) for i in range(4)]

    async def fake_load_visible(db, user):
        return providers

    monkeypatch.setattr(svc, "_load_visible", fake_load_visible)

    clock = {"t": 0.0}
    monkeypatch.setattr(svc.time, "monotonic", lambda: clock["t"])

    # The soft-cooldown ledger is deliberately module-global (single-worker
    # backend); tests must not inherit each other's failure streaks.
    monkeypatch.setattr(svc, "_soft_cooldowns", {})

    tried: list[str] = []
    return types.SimpleNamespace(
        providers=providers, clock=clock, tried=tried, monkeypatch=monkeypatch
    )


def _install_run_search(chain, *, behaviour):
    """behaviour(name) -> "ok" | "empty" | "error"; each call burns 10s."""
    from app.search import providers as prov

    async def fake_run_search(sp, query, count=None):
        chain.tried.append(sp.type)
        chain.clock["t"] += 10.0  # every provider costs its full timeout
        what = behaviour(sp.type)
        if what == "error":
            raise prov.SearchError(f"{sp.type} is down")
        if what == "empty":
            return []
        return [types.SimpleNamespace(title="t", url="u", snippet="s")]

    chain.monkeypatch.setattr(prov, "run_search", fake_run_search)


async def test_without_a_budget_every_provider_is_tried(chain):
    """Existing callers pass no budget and must keep their old behaviour."""
    _install_run_search(chain, behaviour=lambda n: "error")

    from app.search.providers import SearchError

    with pytest.raises(SearchError):
        await svc.run_search_with_failover(None, None, "q")

    assert chain.tried == ["p0", "p1", "p2", "p3"]


async def test_budget_stops_the_chain_before_an_unaffordable_provider(chain):
    """25s of budget affords two 10s providers, not a third — the third must
    not be started, because being cancelled loses the reason entirely."""
    _install_run_search(chain, behaviour=lambda n: "error")

    from app.search.providers import SearchError

    with pytest.raises(SearchError) as exc:
        await svc.run_search_with_failover(None, None, "q", budget_s=25.0)

    assert chain.tried == ["p0", "p1"]
    msg = str(exc.value)
    assert "2 search provider(s)" in msg
    assert "ran out of time" in msg
    # The last real cause survives rather than being replaced by "timed out".
    assert "is down" in msg


async def test_the_first_provider_always_runs(chain):
    """Even with no budget left, skipping everything would turn a search into
    an instant unexplained failure."""
    _install_run_search(chain, behaviour=lambda n: "error")

    from app.search.providers import SearchError

    with pytest.raises(SearchError):
        await svc.run_search_with_failover(None, None, "q", budget_s=0.1)

    assert chain.tried == ["p0"]


async def test_a_healthy_provider_short_circuits_before_the_budget_matters(chain):
    _install_run_search(chain, behaviour=lambda n: "ok")

    results, used = await svc.run_search_with_failover(
        None, None, "q", budget_s=25.0
    )

    assert results
    assert used.type == "p0"
    assert chain.tried == ["p0"]


async def test_failover_still_reaches_a_later_healthy_provider(chain):
    """The budget must not cost us a provider we can afford — the whole point
    of the chain is that provider 2 rescues provider 1."""
    _install_run_search(
        chain, behaviour=lambda n: "ok" if n == "p1" else "error"
    )

    results, used = await svc.run_search_with_failover(
        None, None, "q", budget_s=25.0
    )

    assert results
    assert used.type == "p1"
    assert chain.tried == ["p0", "p1"]


async def test_openrouter_is_budgeted_at_its_own_timeout(chain):
    """OpenRouter's "search" is a 30s chat completion. Budgeting it at the
    generic 10s let the chain start a request it couldn't finish, so the
    caller cancelled the whole chain with a bare "timed out"."""
    chain.providers[1].type = "openrouter"
    _install_run_search(chain, behaviour=lambda n: "error")

    from app.search.providers import SearchError

    # 25s budget: p0 burns 10s, leaving 15s — not enough for a 30s
    # OpenRouter call, so the chain must stop without starting it.
    with pytest.raises(SearchError) as exc:
        await svc.run_search_with_failover(None, None, "q", budget_s=25.0)

    assert chain.tried == ["p0"]
    assert "ran out of time" in str(exc.value)


# ---------------------------------------------------------------------------
# Soft cooldown (transient-failure demotion)
# ---------------------------------------------------------------------------
async def test_repeated_transient_failures_demote_a_provider(chain):
    """A primary that keeps returning nothing (the blocked-SearXNG
    signature) used to cost its full timeout FIRST on every search. After
    two consecutive empties it must be demoted to the back of the chain."""
    _install_run_search(
        chain, behaviour=lambda n: "empty" if n == "p0" else "ok"
    )

    for _ in range(2):
        chain.tried.clear()
        _, used = await svc.run_search_with_failover(None, None, "q")
        assert used.type == "p1"
        assert chain.tried[0] == "p0"  # still leading the chain

    # Third search: p0 has failed twice in a row — the healthy provider
    # now goes first and p0 isn't even needed.
    chain.tried.clear()
    _, used = await svc.run_search_with_failover(None, None, "q")
    assert chain.tried == ["p1"]
    assert used.type == "p1"


async def test_demotion_expires_after_the_soft_cooldown(chain):
    _install_run_search(
        chain, behaviour=lambda n: "empty" if n == "p0" else "ok"
    )
    for _ in range(3):
        await svc.run_search_with_failover(None, None, "q")

    chain.clock["t"] += svc._SOFT_COOLDOWN_SECONDS + 1.0

    chain.tried.clear()
    await svc.run_search_with_failover(None, None, "q")
    assert chain.tried[0] == "p0"  # back at the front once the window passes


async def test_a_success_resets_the_failure_streak(chain):
    _install_run_search(
        chain, behaviour=lambda n: "empty" if n == "p0" else "ok"
    )
    await svc.run_search_with_failover(None, None, "q")  # p0: 1 failure

    _install_run_search(chain, behaviour=lambda n: "ok")
    await svc.run_search_with_failover(None, None, "q")  # p0 recovers

    # Two more single failures never reach the threshold because the
    # success in between reset the streak — p0 keeps leading the chain.
    _install_run_search(
        chain, behaviour=lambda n: "empty" if n == "p0" else "ok"
    )
    await svc.run_search_with_failover(None, None, "q")
    chain.tried.clear()
    await svc.run_search_with_failover(None, None, "q")
    assert chain.tried[0] == "p0"


async def test_all_providers_demoted_still_searches(chain):
    """Demotion is an ordering tweak, not a ban — if every provider is in
    the soft window the chain must fall back to the normal order rather
    than refusing to search."""
    _install_run_search(chain, behaviour=lambda n: "empty")
    for _ in range(3):
        await svc.run_search_with_failover(None, None, "q")

    chain.tried.clear()
    results, used = await svc.run_search_with_failover(None, None, "q")
    assert chain.tried == ["p0", "p1", "p2", "p3"]
    assert results == []


async def test_no_providers_configured_is_not_an_error(chain):
    async def none_visible(db, user):
        return []

    chain.monkeypatch.setattr(svc, "_load_visible", none_visible)

    results, used = await svc.run_search_with_failover(
        None, None, "q", budget_s=25.0
    )

    assert results == []
    assert used is None
