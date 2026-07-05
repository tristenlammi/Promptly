"""Dispatch-layer hygiene for tool calls.

Two concerns live here, both deliberately dependency-free:

* :func:`validate_tool_args` — enforce a tool's declared JSON Schema
  *server-side* before ``Tool.run`` is called. Providers are supposed
  to make models respect ``parameters``, but in practice models emit
  wrong types, out-of-range numbers, and surprise extra keys. Every
  tool re-checks its own critical fields by hand; this makes the
  declared schema the actual contract so a gap in a tool's manual
  checks can't be reached. Supports the subset of JSON Schema the
  registered tools use (object/string/integer/number/boolean/array,
  ``required``, ``additionalProperties``, ``maxLength``/``minLength``,
  ``minimum``/``maximum``, ``enum``, ``items``, ``maxItems``/
  ``minItems``) — adding a tool that uses a new keyword should extend
  this module rather than skip validation.

* :func:`clean_model_text` — sanitise third-party text (search
  snippets, extracted page bodies) before it's fed to the model or
  persisted as a citation. Strips control characters and the
  zero-width / bidi-override code points that are the standard
  obfuscation vector for hiding instructions inside fetched content.
"""
from __future__ import annotations

import re
from typing import Any


class ToolArgsInvalid(ValueError):
    """Raised when arguments don't satisfy the tool's declared schema.

    The message is safe to feed back to the model verbatim (it names
    the offending field and constraint so the model can correct the
    call on its next attempt).
    """


_TYPE_MAP: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _check_type(value: Any, expected: str, path: str) -> None:
    py = _TYPE_MAP.get(expected)
    if py is None:
        return  # Unknown type keyword — don't guess, don't block.
    # bool is a subclass of int; a model sending ``true`` for a count
    # must not pass an integer/number check.
    if expected in ("integer", "number") and isinstance(value, bool):
        raise ToolArgsInvalid(f"`{path}` must be a {expected}, got a boolean")
    if not isinstance(value, py):
        raise ToolArgsInvalid(
            f"`{path}` must be a {expected}, got {type(value).__name__}"
        )


def _validate_value(value: Any, schema: dict[str, Any], path: str) -> None:
    expected = schema.get("type")
    if isinstance(expected, str):
        _check_type(value, expected, path)

    enum = schema.get("enum")
    if isinstance(enum, list) and enum and value not in enum:
        raise ToolArgsInvalid(
            f"`{path}` must be one of {enum!r}"
        )

    if isinstance(value, str):
        max_len = schema.get("maxLength")
        if isinstance(max_len, int) and len(value) > max_len:
            raise ToolArgsInvalid(
                f"`{path}` exceeds maxLength {max_len:,} "
                f"(got {len(value):,} characters)"
            )
        min_len = schema.get("minLength")
        if isinstance(min_len, int) and len(value) < min_len:
            raise ToolArgsInvalid(f"`{path}` is shorter than minLength {min_len}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            raise ToolArgsInvalid(f"`{path}` must be >= {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            raise ToolArgsInvalid(f"`{path}` must be <= {maximum}")

    if isinstance(value, list):
        max_items = schema.get("maxItems")
        if isinstance(max_items, int) and len(value) > max_items:
            raise ToolArgsInvalid(
                f"`{path}` has too many items (max {max_items})"
            )
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            raise ToolArgsInvalid(
                f"`{path}` has too few items (min {min_items})"
            )
        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            for i, item in enumerate(value):
                _validate_value(item, items_schema, f"{path}[{i}]")

    if isinstance(value, dict):
        _validate_object(value, schema, path)


def _validate_object(obj: dict[str, Any], schema: dict[str, Any], path: str) -> None:
    props = schema.get("properties")
    props = props if isinstance(props, dict) else {}

    required = schema.get("required")
    if isinstance(required, list):
        for key in required:
            if key not in obj:
                where = f"{path}.{key}" if path else key
                raise ToolArgsInvalid(f"`{where}` is required")

    if schema.get("additionalProperties") is False:
        extras = [k for k in obj if k not in props]
        if extras:
            raise ToolArgsInvalid(
                f"Unexpected argument(s): {', '.join(sorted(extras))}. "
                f"Allowed: {', '.join(sorted(props)) or '(none)'}"
            )

    for key, sub in props.items():
        if key in obj and isinstance(sub, dict):
            where = f"{path}.{key}" if path else key
            _validate_value(obj[key], sub, where)


def validate_tool_args(schema: dict[str, Any], args: dict[str, Any]) -> None:
    """Validate parsed tool arguments against the tool's JSON Schema.

    Raises :class:`ToolArgsInvalid` with a model-correctable message on
    the first violation. A missing / non-object schema validates
    nothing (fail open — the tool's own manual checks still apply).
    """
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return
    _validate_object(args, schema, "")


# --------------------------------------------------------------------
# Third-party text hygiene
# --------------------------------------------------------------------

# C0/C1 control characters except \n and \t, plus the invisible
# code points used to smuggle or reorder text: zero-width spaces and
# joiners (U+200B..U+200F), bidi embedding/overrides (U+202A..U+202E),
# bidi isolates (U+2066..U+2069), and the BOM (U+FEFF).
_UNSAFE_CHARS = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
    "\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]"
)


def clean_model_text(text: str | None) -> str:
    """Strip control + invisible characters from third-party text.

    Applied to search-result titles/snippets and extracted page text
    before they're fed to the model or persisted as citations. Keeps
    newlines and tabs; collapses \r\n to \n so downstream length caps
    behave consistently.
    """
    if not text:
        return ""
    return _UNSAFE_CHARS.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))


__all__ = ["ToolArgsInvalid", "validate_tool_args", "clean_model_text"]
