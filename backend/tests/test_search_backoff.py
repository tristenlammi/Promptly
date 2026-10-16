"""A search provider saying "slow down" isn't the same as "you're out of
quota" (WP-1.5, R-274/R-304)."""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

import httpx
import pytest

from app.search import service
from app.search.providers import SearchError, _check_status


def _resp(status: int, body: str, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, text=body, headers=headers or {}, request=httpx.Request("GET", "https://x"))


def test_a_per_second_rate_limit_is_temporary():
    with pytest.raises(SearchError) as e:
        _check_status("Brave", _resp(429, '{"type":"ErrorResponse","error":{"code":"RATE_LIMITED"}}', {"Retry-After": "2"}))
    assert e.value.permanent is False
    assert e.value.retry_after == 2


@pytest.mark.parametrize("body", [
    '{"error":{"code":"QUOTA_LIMITED","detail":"Monthly quota exceeded"}}',
    "You have exceeded your plan's usage limit",
])
def test_an_exhausted_quota_is_still_a_long_pause(body):
    with pytest.raises(SearchError) as e:
        _check_status("Tavily", _resp(429, body))
    assert e.value.permanent is True


@pytest.mark.parametrize("status", [401, 402, 403])
def test_auth_and_billing_failures_stay_permanent(status):
    with pytest.raises(SearchError) as e:
        _check_status("Brave", _resp(status, "nope"))
    assert e.value.permanent is True


def test_a_rate_limited_provider_steps_back_for_its_retry_after():
    pid = uuid.uuid4()
    service._soft_cooldowns.clear()
    service._note_soft_failure(pid, "brave", retry_after=30)
    assert service._soft_cooling(pid)
    assert service._soft_cooldowns[pid]["until"] - time.monotonic() > 25


class _Row:
    def __init__(self, type_, config, position):
        self.id = uuid.uuid4()
        self.type = type_
        self.config = config
        self.position = position
        self.created_at = datetime.now(timezone.utc)
        self.cooldown_until = None


def test_a_second_key_of_the_same_type_is_still_tried():
    service._soft_cooldowns.clear()
    a = _Row("brave", {"api_key": "enc-1"}, 0)
    b = _Row("brave", {"api_key": "enc-2"}, 1)
    same_searx_1 = _Row("searxng", {"url": "http://searxng:8080"}, 2)
    same_searx_2 = _Row("searxng", {"url": "http://searxng:8080"}, 3)
    chain = service._order_candidates([a, b, same_searx_1, same_searx_2], datetime.now(timezone.utc))
    assert [r.id for r in chain] == [a.id, b.id, same_searx_1.id]
