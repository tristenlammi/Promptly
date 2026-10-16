"""Automation templates: no credential exfiltration, valid JSON (R-005, R-012)."""
from __future__ import annotations

import json

import pytest

from app.tasks.templating import UnknownSecretError, render

SECRETS = {"GITHUB_TOKEN": "ghp_REALSECRET"}


def test_secret_tokens_in_runtime_values_are_never_resolved():
    """The audit's reproduction: a webhook body carrying a secret token."""
    ctx = {"trigger.json.msg": "hi {{secret.GITHUB_TOKEN}}"}

    out = render('{"text": "{{trigger.json.msg}}"}', ctx, secrets=SECRETS, json_aware=True)

    assert "ghp_REALSECRET" not in out
    assert json.loads(out) == {"text": "hi {{secret.GITHUB_TOKEN}}"}


def test_a_url_built_from_upstream_text_cant_pull_in_a_secret():
    ctx = {"upstream_output": "https://evil.example/?k={{secret.GITHUB_TOKEN}}"}

    assert "ghp_" not in render("{{upstream_output}}", ctx, secrets=SECRETS)


def test_the_authors_own_secret_tokens_resolve():
    out = render("Bearer {{secret.github_token}}", {}, secrets=SECRETS)

    assert out == "Bearer ghp_REALSECRET"


def test_secrets_are_escaped_inside_json():
    out = render(
        '{"auth": "{{secret.K}}", "msg": "{{upstream_output}}"}',
        {"upstream_output": "ok"},
        secrets={"K": 'a"b\\c'},
        json_aware=True,
    )

    assert json.loads(out) == {"auth": 'a"b\\c', "msg": "ok"}


def test_unknown_secret_fails_loudly():
    with pytest.raises(UnknownSecretError):
        render("{{secret.NOPE}}", {}, secrets=SECRETS)


def test_ai_output_with_quotes_and_newlines_makes_valid_json():
    """The UI's own placeholder used to break on exactly this."""
    ctx = {"upstream_output": 'Line one\nHe said "hi"'}

    out = render('{"key": "{{upstream_output}}"}', ctx, json_aware=True)

    assert json.loads(out) == {"key": 'Line one\nHe said "hi"'}


def test_a_whole_field_token_with_json_inserts_the_value():
    ctx = {"node_a.json": '[{"id": 1}, {"id": 2}]', "n": "3"}

    out = render('{"items": "{{node_a.json}}", "label": "n={{n}}"}', ctx, json_aware=True)

    assert json.loads(out) == {"items": [{"id": 1}, {"id": 2}], "label": "n=3"}


def test_bare_tokens_still_work_as_before():
    out = render('{"count": {{n}}}', {"n": "3"}, json_aware=True)

    assert json.loads(out) == {"count": 3}


def test_plain_text_is_unchanged_and_unknown_vars_stay_visible():
    out = render("Hello {{name}}, {{missing}}", {"name": "Sam"})

    assert out == "Hello Sam, {{missing}}"


def test_on_secret_reports_each_credential_used():
    used = []

    render("{{secret.GITHUB_TOKEN}} {{secret.github_token}}", {}, secrets=SECRETS, on_secret=used.append)

    assert used == ["GITHUB_TOKEN", "GITHUB_TOKEN"]


def test_credential_host_rules():
    from app.secrets.hosts import host_allowed, normalise_hosts

    hosts = normalise_hosts(["https://API.GitHub.com/v3", " *.example.com ", ""])
    assert hosts == ["api.github.com", "*.example.com"]
    assert host_allowed("api.github.com", hosts)
    assert host_allowed("a.b.example.com", hosts)
    assert not host_allowed("example.com", hosts)  # wildcard = subdomains only
    assert not host_allowed("api.github.com.evil.net", hosts)
    assert host_allowed("anything.net", [])  # empty = any host
    with pytest.raises(ValueError):
        normalise_hosts(["not a host!"])
