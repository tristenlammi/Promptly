"""A small, safe evaluator for the formulas in Study's figures.

A formula is text the model wrote (``a*x^2 + b``). It is never handed to
``eval``: it is split into tokens, parsed into a tree of plain tuples by the
grammar below, and walked. There are no names but the variables the caller
gives, a few constants and a fixed list of functions; no attributes, no
indexing, no strings, no calls to anything else.

    expr   := term (("+" | "-") term)*
    term   := unary (("*" | "/") unary | implicit)*
    unary  := ("-" | "+") unary | power
    power  := atom (("^" | "**") unary)?            right-associative
    atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"

``2x``, ``2(x+1)`` and ``(a)(b)`` multiply. The browser has the same
evaluator (``frontend/src/study/figures/expr.ts``); both are held to the
same table of cases (``backend/tests/study_expr_cases.json``).
"""
from __future__ import annotations

import math
from typing import Any, Mapping

MAX_LEN = 200
MAX_NODES = 120
MAX_DEPTH = 24
#: Results past this are treated as "no value" (the same in the browser).
LIMIT = 1e12


class ExprError(ValueError):
    """The formula can't be read, or has no finite value here."""


CONSTANTS = {"pi": math.pi, "e": math.e}


def _round(x: float) -> float:
    return math.floor(x + 0.5)


def _sign(x: float) -> float:
    return 1.0 if x > 0 else -1.0 if x < 0 else 0.0


#: name -> (function, how many arguments: an int, or (min, max))
FUNCTIONS: dict[str, tuple[Any, Any]] = {
    "sin": (math.sin, 1), "cos": (math.cos, 1), "tan": (math.tan, 1),
    "asin": (math.asin, 1), "acos": (math.acos, 1), "atan": (math.atan, 1),
    "sqrt": (math.sqrt, 1), "abs": (abs, 1), "exp": (math.exp, 1),
    "ln": (math.log, 1), "log": (math.log10, 1), "log2": (math.log2, 1),
    "floor": (math.floor, 1), "ceil": (math.ceil, 1), "round": (_round, 1), "sign": (_sign, 1),
    "min": (min, (2, 4)), "max": (max, (2, 4)), "pow": (math.pow, 2),
}

RESERVED = set(CONSTANTS) | set(FUNCTIONS)

_DIGITS = "0123456789"
_NAME_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
_NAME_REST = _NAME_START + _DIGITS + "_"


def _tokens(src: str) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch in " \t":
            i += 1
        elif ch in _DIGITS or (ch == "." and i + 1 < n and src[i + 1] in _DIGITS):
            j = i
            while j < n and src[j] in _DIGITS:
                j += 1
            if j < n and src[j] == ".":
                j += 1
                while j < n and src[j] in _DIGITS:
                    j += 1
            if j < n and src[j] in "eE":
                k = j + 1
                if k < n and src[k] in "+-":
                    k += 1
                if k < n and src[k] in _DIGITS:
                    while k < n and src[k] in _DIGITS:
                        k += 1
                    j = k
            text = src[i:j]
            if len(text) > 24:
                raise ExprError("number too long")
            out.append(("num", float(text)))
            i = j
        elif ch in _NAME_START:
            j = i
            while j < n and src[j] in _NAME_REST:
                j += 1
            if j - i > 16:
                raise ExprError("name too long")
            out.append(("name", src[i:j]))
            i = j
        elif ch == "*" and i + 1 < n and src[i + 1] == "*":
            out.append(("op", "^"))
            i += 2
        elif ch in "+-*/^(),":
            out.append(("op", ch))
            i += 1
        elif ch in "×·":
            out.append(("op", "*"))
            i += 1
        elif ch == "÷":
            out.append(("op", "/"))
            i += 1
        elif ch == "−":
            out.append(("op", "-"))
            i += 1
        else:
            raise ExprError(f"unexpected character {ch!r}")
    return out


class _Parser:
    def __init__(self, toks: list[tuple[str, Any]]) -> None:
        self.t = toks
        self.i = 0
        self.nodes = 0

    def peek(self) -> tuple[str, Any] | None:
        return self.t[self.i] if self.i < len(self.t) else None

    def is_op(self, v: str) -> bool:
        p = self.peek()
        return p is not None and p[0] == "op" and p[1] == v

    def take(self) -> tuple[str, Any]:
        p = self.peek()
        if p is None:
            raise ExprError("the formula stops early")
        self.i += 1
        return p

    def node(self, *parts: Any) -> tuple:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise ExprError("the formula is too long")
        return tuple(parts)

    def expr(self, depth: int) -> tuple:
        if depth > MAX_DEPTH:
            raise ExprError("the formula is nested too deeply")
        left = self.term(depth)
        while self.is_op("+") or self.is_op("-"):
            op = self.take()[1]
            left = self.node(op, left, self.term(depth))
        return left

    def term(self, depth: int) -> tuple:
        left = self.unary(depth)
        while True:
            if self.is_op("*") or self.is_op("/"):
                op = self.take()[1]
                left = self.node(op, left, self.unary(depth))
                continue
            p = self.peek()
            prev = self.t[self.i - 1] if self.i else None
            # 2x, 2(x+1), (a)(b), (a)b: a name or bracket straight after a
            # number or a closing bracket multiplies. Nothing else does
            # ("x y" and "f(1)" for an unknown f are mistakes, not products).
            after_value = prev is not None and (prev[0] == "num" or prev == ("op", ")"))
            if after_value and p is not None and (p[0] == "name" or p == ("op", "(")):
                left = self.node("*", left, self.power(depth))
                continue
            return left

    def unary(self, depth: int) -> tuple:
        if depth > MAX_DEPTH:
            raise ExprError("the formula is nested too deeply")
        if self.is_op("-"):
            self.take()
            return self.node("neg", self.unary(depth + 1))
        if self.is_op("+"):
            self.take()
            return self.unary(depth + 1)
        return self.power(depth)

    def power(self, depth: int) -> tuple:
        base = self.atom(depth)
        if self.is_op("^"):
            self.take()
            return self.node("^", base, self.unary(depth + 1))
        return base

    def atom(self, depth: int) -> tuple:
        kind, v = self.take()
        if kind == "num":
            return self.node("num", v)
        if kind == "name":
            if self.is_op("(") and v in FUNCTIONS:
                self.take()
                args = [self.expr(depth + 1)]
                while self.is_op(","):
                    self.take()
                    args.append(self.expr(depth + 1))
                if not self.is_op(")"):
                    raise ExprError("missing )")
                self.take()
                want = FUNCTIONS[v][1]
                lo, hi = (want, want) if isinstance(want, int) else want
                if not lo <= len(args) <= hi:
                    raise ExprError(f"{v}() takes {lo if lo == hi else f'{lo} to {hi}'} value(s)")
                return self.node("call", v, tuple(args))
            if v in FUNCTIONS:
                raise ExprError(f"{v} needs brackets")
            return self.node("var", v)
        if kind == "op" and v == "(":
            inner = self.expr(depth + 1)
            if not self.is_op(")"):
                raise ExprError("missing )")
            self.take()
            return inner
        raise ExprError("unexpected symbol")


def parse(src: Any) -> tuple:
    """The formula as a tree. Raises :class:`ExprError`."""
    if not isinstance(src, str):
        raise ExprError("not text")
    src = src.strip()
    if not src or len(src) > MAX_LEN:
        raise ExprError("empty or too long")
    p = _Parser(_tokens(src))
    tree = p.expr(0)
    if p.peek() is not None:
        raise ExprError("unexpected symbol")
    return tree


def names(tree: tuple) -> set[str]:
    """The variables a formula uses (constants left out)."""
    op = tree[0]
    if op == "num":
        return set()
    if op == "var":
        return set() if tree[1] in CONSTANTS else {tree[1]}
    if op == "call":
        out: set[str] = set()
        for a in tree[2]:
            out |= names(a)
        return out
    out = set()
    for a in tree[1:]:
        out |= names(a)
    return out


def _check(v: Any) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ExprError("no value")
    v = float(v)
    if v != v or abs(v) > LIMIT:
        raise ExprError("no value")
    return v


def evaluate(tree: tuple, env: Mapping[str, float]) -> float:
    """The formula's value. Raises :class:`ExprError` when it has none
    (division by zero, the root of a negative, a result too big to draw)."""
    op = tree[0]
    try:
        if op == "num":
            return tree[1]
        if op == "var":
            name = tree[1]
            if name in env:
                return _check(env[name])
            if name in CONSTANTS:
                return CONSTANTS[name]
            raise ExprError(f"unknown name {name}")
        if op == "neg":
            return -evaluate(tree[1], env)
        if op == "call":
            fn = FUNCTIONS[tree[1]][0]
            return _check(fn(*[evaluate(a, env) for a in tree[2]]))
        a, b = evaluate(tree[1], env), evaluate(tree[2], env)
        if op == "+":
            return _check(a + b)
        if op == "-":
            return _check(a - b)
        if op == "*":
            return _check(a * b)
        if op == "/":
            if b == 0:
                raise ExprError("divide by zero")
            return _check(a / b)
        if op == "^":
            if abs(b) > 64 and abs(a) > 1:
                raise ExprError("no value")
            return _check(math.pow(a, b))
    except (ValueError, OverflowError, ZeroDivisionError, TypeError) as e:
        if isinstance(e, ExprError):
            raise
        raise ExprError("no value") from e
    raise ExprError("bad tree")


def value(src: str, env: Mapping[str, float]) -> float | None:
    """``src`` evaluated, or ``None`` when it has no value. For callers that
    already know the formula parses."""
    try:
        return evaluate(parse(src), env)
    except ExprError:
        return None
