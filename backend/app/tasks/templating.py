"""Filling ``{{...}}`` templates in automation steps — safely (R-005, R-012).

Two bugs lived in the old "substitute, then resolve secrets over the whole
result" approach:

* **Secret exfiltration.** Runtime values (a webhook body, an AI answer, a
  card title a co-member typed) were pasted in *first*, and only then was
  ``{{secret.NAME}}`` resolved — anywhere in the text. So anyone who could
  put ``{{secret.GITHUB_TOKEN}}`` into upstream text got the credential sent
  out, and the inspector showed only the redacted token.
* **Broken JSON.** Values were pasted raw into JSON bodies and MCP
  arguments, so an AI answer with a newline or a quote produced invalid
  JSON — the UI's own ``{"key": "{{upstream_output}}"}`` example failed.

:func:`render` fixes both. Secret tokens are taken **only from the author's
template**, swapped for unguessable sentinels before anything else happens,
and filled last; substituted text is never scanned again. When the template
is JSON, values are inserted as properly escaped JSON strings — or, when a
field is exactly one token whose value is a JSON object or array, as that
value.
"""
from __future__ import annotations

import json
import re
import secrets as _secrets_mod
from typing import Callable

_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}")
SECRET_TOKEN_RE = re.compile(r"\{\{\s*secret\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}")


class UnknownSecretError(KeyError):
    """The template names a credential the owner doesn't have."""

    def __init__(self, name: str):
        super().__init__(name)
        self.name = name


def secret_names(template: str) -> list[str]:
    """Credentials an author's template asks for (upper-cased)."""
    return [m.group(1).upper() for m in SECRET_TOKEN_RE.finditer(template or "")]


def render(
    template: str,
    ctx: dict[str, str],
    *,
    secrets: dict[str, str] | None = None,
    json_aware: bool = False,
    on_secret: Callable[[str], None] | None = None,
) -> str:
    """Fill ``template`` from ``ctx`` (and ``secrets``) without letting
    substituted text be interpreted as template syntax.

    ``secrets=None`` leaves secret tokens untouched (AI prompts never get
    credentials). ``on_secret(name)`` is called for each credential used, so
    the caller can apply per-credential rules (allowed hosts).
    """
    template = template or ""
    nonce = _secrets_mod.token_hex(8)

    # 1. Secrets, from the author's text only → sentinels.
    secret_slots: dict[str, str] = {}
    if secrets is not None:

        def _sec(m: re.Match) -> str:
            name = m.group(1).upper()
            if name not in secrets:
                raise UnknownSecretError(name)
            if on_secret is not None:
                on_secret(name)
            # Printable (it must survive inside a JSON string) and unguessable
            # (a runtime value can't forge one without the per-call nonce).
            key = f"@@S{len(secret_slots)}{nonce}@@"
            secret_slots[key] = secrets[name]
            return key

        template = SECRET_TOKEN_RE.sub(_sec, template)

    # 2. Variables → values, in one pass that never re-scans its output.
    out = _render_json(template, ctx, nonce) if json_aware else None
    if out is None:
        out = _VAR_RE.sub(lambda m: ctx.get(m.group(1), m.group(0)), template)
        # 3. Fill credentials last (plain text: the raw value).
        for key, value in secret_slots.items():
            out = out.replace(key, value)
        return out

    for key, value in secret_slots.items():
        # Inside JSON the sentinel sits in a string literal; escape to match.
        out = out.replace(key, json.dumps(value, ensure_ascii=False)[1:-1])
    return out


def _render_json(template: str, ctx: dict[str, str], nonce: str) -> str | None:
    """JSON-aware fill, or None when the template isn't JSON once its
    tokens are set aside (then the caller falls back to plain text)."""
    slots: dict[str, str] = {}

    def _slot(m: re.Match) -> str:
        key = f"@@V{len(slots)}{nonce}@@"
        slots[key] = m.group(0)
        return key

    masked = _VAR_RE.sub(_slot, template)
    if not slots:
        return None
    try:
        doc = json.loads(masked)
    except (ValueError, TypeError):
        # Tokens used as bare JSON values (``{"n": {{count}}}``) mask to an
        # unquoted word — not JSON. Plain-text fill handles those as before.
        return None

    def _value(token: str) -> str:
        name = _VAR_RE.fullmatch(token).group(1)  # type: ignore[union-attr]
        return ctx.get(name, token)

    def _fill_str(s: str):
        if s in slots:
            # A field that is exactly one token: a JSON object/array value
            # goes in as JSON, anything else as a string.
            val = _value(slots[s])
            t = val.strip()
            if t[:1] in "{[":
                try:
                    return json.loads(t)
                except (ValueError, TypeError):
                    pass
            return val
        for key, token in slots.items():
            if key in s:
                s = s.replace(key, _value(token))
        return s

    def _fill_key(k: str) -> str:
        for key, token in slots.items():
            if key in k:
                k = k.replace(key, _value(token))
        return k

    def _walk(node):
        if isinstance(node, str):
            return _fill_str(node)
        if isinstance(node, list):
            return [_walk(v) for v in node]
        if isinstance(node, dict):
            return {_fill_key(k): _walk(v) for k, v in node.items()}
        return node

    return json.dumps(_walk(doc), ensure_ascii=False)


__all__ = ["SECRET_TOKEN_RE", "UnknownSecretError", "render", "secret_names"]
