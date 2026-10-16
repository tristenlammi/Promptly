"""Excel number formats → the text a cell shows (WP-4.4).

Fortune-sheet draws a cell's ``m`` (its display text) and never formats a
number itself, so an imported ``46112`` with ``yyyy-mm-dd`` would read as
46112. This renders the formats real workbooks use — General, fixed
decimals, thousands separators, percentages, currency, scientific and
dates/times — for previews, search text and the first paint. Anything it
doesn't understand returns ``None``; the editor then formats the cell with
Fortune's own SSF engine when it loads.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta

_EPOCH = datetime(1899, 12, 30)  # Excel's day 0 (with the 1900 leap-year bug folded in)

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def serial_to_datetime(serial: float) -> datetime:
    return _EPOCH + timedelta(days=float(serial))


def datetime_to_serial(value) -> float:
    """``date`` / ``datetime`` / ``time`` → Excel serial number."""
    from datetime import date, time

    if isinstance(value, datetime):
        delta = value - _EPOCH
    elif isinstance(value, date):
        delta = datetime(value.year, value.month, value.day) - _EPOCH
    elif isinstance(value, time):
        return (value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1e6) / 86400
    else:
        raise TypeError(value)
    serial = delta.days + delta.seconds / 86400 + delta.microseconds / 86400e6
    return int(serial) if float(serial).is_integer() else serial


def general(value) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return "#NUM!"
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        text = f"{value:.10g}"
        return text
    return "" if value is None else str(value)


def _split_sections(fmt: str) -> list[str]:
    out, cur, quoted, i = [], "", False, 0
    while i < len(fmt):
        ch = fmt[i]
        if ch == '"':
            quoted = not quoted
        elif ch == "\\" and i + 1 < len(fmt):
            cur += fmt[i : i + 2]
            i += 2
            continue
        elif ch == ";" and not quoted:
            out.append(cur)
            cur = ""
            i += 1
            continue
        cur += ch
        i += 1
    out.append(cur)
    return out


_BRACKET = re.compile(r"\[([^\]]*)\]")


def _clean(section: str) -> str:
    """Drop colours / conditions, keep a currency symbol from ``[$€-407]``."""

    def repl(m: re.Match) -> str:
        body = m.group(1)
        if body.startswith("$"):
            sym = body[1:].split("-", 1)[0]
            return f'"{sym}"' if sym else ""
        return ""

    return _BRACKET.sub(repl, section)


def _tokens(section: str) -> list[tuple[str, str]]:
    """``[(kind, text)]`` with kind "lit" (literal) or "fmt" (format code)."""
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(section):
        ch = section[i]
        if ch == '"':
            j = section.find('"', i + 1)
            j = len(section) if j < 0 else j
            out.append(("lit", section[i + 1 : j]))
            i = j + 1
        elif ch == "\\" and i + 1 < len(section):
            out.append(("lit", section[i + 1]))
            i += 2
        elif ch == "_" and i + 1 < len(section):
            out.append(("lit", " "))
            i += 2
        elif ch == "*" and i + 1 < len(section):
            i += 2  # repeat-fill: nothing to show in a fixed string
        else:
            out.append(("fmt", ch))
            i += 1
    # Merge runs.
    merged: list[tuple[str, str]] = []
    for kind, text in out:
        if merged and merged[-1][0] == kind:
            merged[-1] = (kind, merged[-1][1] + text)
        else:
            merged.append((kind, text))
    return merged


_DATE_CODES = re.compile(r"(?i)(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am/pm|a/p|e)")


def _is_date(code: str) -> bool:
    stripped = re.sub(r'"[^"]*"|\\.', "", code)
    return bool(re.search(r"(?i)[ymdhs]", stripped)) and not re.search(r"[0#?]", stripped)


def _format_date(value: float, tokens: list[tuple[str, str]]) -> str:
    dt = serial_to_datetime(value)
    # Round to the second, as Excel does for display.
    dt = (dt + timedelta(microseconds=500_000)).replace(microsecond=0)
    code_all = "".join(t for k, t in tokens if k == "fmt")
    twelve = bool(re.search(r"(?i)am/pm|a/p", code_all))
    parts: list[str] = []
    last_was_hour = False
    flat: list[tuple[str, str]] = []
    for kind, text in tokens:
        if kind == "lit":
            flat.append(("lit", text))
            continue
        pos = 0
        for m in _DATE_CODES.finditer(text):
            if m.start() > pos:
                flat.append(("lit", text[pos : m.start()]))
            flat.append(("code", m.group(0)))
            pos = m.end()
        if pos < len(text):
            flat.append(("lit", text[pos:]))
    for idx, (kind, text) in enumerate(flat):
        if kind == "lit":
            parts.append(text)
            continue
        low = text.lower()
        nxt = next((t.lower() for k, t in flat[idx + 1 :] if k == "code"), "")
        if low in ("m", "mm") and (last_was_hour or nxt.startswith("s")):
            parts.append(f"{dt.minute:02d}" if low == "mm" else str(dt.minute))
        elif low == "yyyy" or low == "e":
            parts.append(f"{dt.year:04d}")
        elif low == "yy":
            parts.append(f"{dt.year % 100:02d}")
        elif low == "mmmm":
            parts.append(_MONTHS[dt.month - 1])
        elif low == "mmm":
            parts.append(_MONTHS[dt.month - 1][:3])
        elif low == "mm":
            parts.append(f"{dt.month:02d}")
        elif low == "m":
            parts.append(str(dt.month))
        elif low == "dddd":
            parts.append(_DAYS[dt.weekday()])
        elif low == "ddd":
            parts.append(_DAYS[dt.weekday()][:3])
        elif low == "dd":
            parts.append(f"{dt.day:02d}")
        elif low == "d":
            parts.append(str(dt.day))
        elif low in ("hh", "h"):
            h = (dt.hour % 12 or 12) if twelve else dt.hour
            parts.append(f"{h:02d}" if low == "hh" else str(h))
        elif low in ("ss", "s"):
            parts.append(f"{dt.second:02d}" if low == "ss" else str(dt.second))
        elif low == "am/pm":
            parts.append("AM" if dt.hour < 12 else "PM")
        elif low == "a/p":
            parts.append("A" if dt.hour < 12 else "P")
        last_was_hour = low in ("hh", "h")
    return "".join(parts)


def _format_number(value: float, tokens: list[tuple[str, str]]) -> str | None:
    code = "".join(t for k, t in tokens if k == "fmt")
    if "/" in code or "?" in code:
        return None  # fractions — leave to the editor
    percent = code.count("%")
    v = value * (100 ** percent)
    sci = re.search(r"[eE][+-]", code)
    num_code = ""
    for found in re.finditer(r"[0#,.]+", code[: sci.start()] if sci else code):
        num_code = found.group(0)
        break
    if not num_code:
        return None
    int_part, _, dec_part = num_code.partition(".")
    decimals = sum(1 for ch in dec_part if ch in "0#")
    min_decimals = sum(1 for ch in dec_part if ch == "0")
    thousands = "," in int_part
    min_int = int_part.replace(",", "").count("0")
    if sci:
        exp_digits = len(re.match(r"[0#]*", code[sci.end() :]).group(0)) or 2
        text = f"{abs(v):.{decimals}E}"
        mant, _, exp = text.partition("E")
        sign = "-" if exp.startswith("-") else "+"
        body = f"{mant}E{sign}{abs(int(exp)):0{exp_digits}d}"
    else:
        body = f"{abs(v):,.{decimals}f}" if thousands else f"{abs(v):.{decimals}f}"
        if decimals > min_decimals and "." in body:
            whole, frac = body.split(".")
            frac = frac.rstrip("0")
            if len(frac) < min_decimals:
                frac = frac + "0" * (min_decimals - len(frac))
            body = f"{whole}.{frac}" if frac else whole
        whole = body.split(".")[0].replace(",", "")
        if min_int == 0 and whole == "0":
            body = body[1:] if body.startswith("0") else body
        elif len(whole) < min_int:
            body = "0" * (min_int - len(whole)) + body
    # Put the number where the code was, literals around it.
    out: list[str] = []
    placed = False
    for kind, text in tokens:
        if kind == "lit":
            out.append(text)
            continue
        if not placed:
            first = re.search(r"[0#,.]", text)
            if first:
                prefix = text[: first.start()]
                rest = text[first.start() :]
                tail = re.sub(r"^[0#,.]+(?:[eE][+-][0#]+)?", "", rest)
                out.append(prefix.replace("%", "") + body + tail)
                placed = True
                continue
        out.append(text)
    result = "".join(out)
    return result


def format_value(value, fmt: str | None) -> str | None:
    """The shown text for ``value`` under Excel format ``fmt``; ``None`` when
    the format is beyond this renderer (the editor formats it)."""
    if value is None:
        return ""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return general(value)
    if not fmt or fmt.lower() == "general":
        return general(value)
    if fmt == "@":
        return general(value)
    try:
        sections = _split_sections(fmt)
        if value < 0 and len(sections) >= 2:
            section, v, sign = sections[1], -value, ""
        elif value == 0 and len(sections) >= 3:
            section, v, sign = sections[2], value, ""
        else:
            section, v, sign = sections[0], value, "-" if value < 0 else ""
        if re.search(r"(?i)\[(h+|m+|s+)\]", section):
            return None  # elapsed time — leave to the editor
        section = _clean(section)
        if section.strip().lower() == "general":
            return sign + general(abs(v)) if sign else general(v)
        tokens = _tokens(section)
        code = "".join(t for k, t in tokens if k == "fmt")
        if not code.strip():
            return "".join(t for _k, t in tokens)
        if _is_date(code):
            if v < 0:
                return None
            return _format_date(v, tokens)
        body = _format_number(v, tokens)
        if body is None:
            return None
        body = body.strip()  # "_)" alignment padding
        return sign + body if sign and abs(v) > 0 else body
    except Exception:  # noqa: BLE001 — a display nicety, never an error
        return None


def is_date_format(fmt: str | None) -> bool:
    if not fmt or fmt.lower() == "general" or fmt == "@":
        return False
    try:
        return _is_date(_clean(_split_sections(fmt)[0]))
    except Exception:  # noqa: BLE001
        return False


__all__ = ["datetime_to_serial", "format_value", "general", "is_date_format", "serial_to_datetime"]
