/*
 * A small, safe evaluator for the formulas in Study's figures: the browser's
 * copy of backend/app/study/expr.py, held to the same table of cases
 * (expr.cases.json). A formula is text the model wrote; it is never given to
 * eval or Function. It is split into tokens, parsed by the grammar below
 * into a tree of plain arrays, and walked. The only names are the variables
 * passed in, two constants and a fixed list of functions.
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/") unary | implicit)*
 *   unary  := ("-" | "+") unary | power
 *   power  := atom (("^" | "**") unary)?
 *   atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
 */

export const MAX_LEN = 200;
const MAX_NODES = 120;
const MAX_DEPTH = 24;
const LIMIT = 1e12;

export class ExprError extends Error {}

export type Tree =
  | ["num", number]
  | ["var", string]
  | ["neg", Tree]
  | ["call", string, Tree[]]
  | ["+" | "-" | "*" | "/" | "^", Tree, Tree];

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCTIONS: Record<string, { fn: (...a: number[]) => number; min: number; max: number }> = {
  sin: { fn: Math.sin, min: 1, max: 1 },
  cos: { fn: Math.cos, min: 1, max: 1 },
  tan: { fn: Math.tan, min: 1, max: 1 },
  asin: { fn: Math.asin, min: 1, max: 1 },
  acos: { fn: Math.acos, min: 1, max: 1 },
  atan: { fn: Math.atan, min: 1, max: 1 },
  sqrt: { fn: Math.sqrt, min: 1, max: 1 },
  abs: { fn: Math.abs, min: 1, max: 1 },
  exp: { fn: Math.exp, min: 1, max: 1 },
  ln: { fn: Math.log, min: 1, max: 1 },
  log: { fn: Math.log10, min: 1, max: 1 },
  log2: { fn: Math.log2, min: 1, max: 1 },
  floor: { fn: Math.floor, min: 1, max: 1 },
  ceil: { fn: Math.ceil, min: 1, max: 1 },
  round: { fn: (x) => Math.floor(x + 0.5), min: 1, max: 1 },
  sign: { fn: (x) => (x > 0 ? 1 : x < 0 ? -1 : 0), min: 1, max: 1 },
  min: { fn: Math.min, min: 2, max: 4 },
  max: { fn: Math.max, min: 2, max: 4 },
  pow: { fn: Math.pow, min: 2, max: 2 },
};

type Tok = { k: "num"; v: number } | { k: "name"; v: string } | { k: "op"; v: string };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i += 1;
    } else if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && isDigit(src[j])) j += 1;
      if (j < n && src[j] === ".") {
        j += 1;
        while (j < n && isDigit(src[j])) j += 1;
      }
      if (j < n && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (k < n && (src[k] === "+" || src[k] === "-")) k += 1;
        if (k < n && isDigit(src[k])) {
          while (k < n && isDigit(src[k])) k += 1;
          j = k;
        }
      }
      const text = src.slice(i, j);
      if (text.length > 24) throw new ExprError("number too long");
      out.push({ k: "num", v: Number(text) });
      i = j;
    } else if (isLetter(ch)) {
      let j = i;
      while (j < n && (isLetter(src[j]) || isDigit(src[j]) || src[j] === "_")) j += 1;
      if (j - i > 16) throw new ExprError("name too long");
      out.push({ k: "name", v: src.slice(i, j) });
      i = j;
    } else if (ch === "*" && src[i + 1] === "*") {
      out.push({ k: "op", v: "^" });
      i += 2;
    } else if ("+-*/^(),".includes(ch)) {
      out.push({ k: "op", v: ch });
      i += 1;
    } else if (ch === "×" || ch === "·") {
      out.push({ k: "op", v: "*" });
      i += 1;
    } else if (ch === "÷") {
      out.push({ k: "op", v: "/" });
      i += 1;
    } else if (ch === "−") {
      out.push({ k: "op", v: "-" });
      i += 1;
    } else {
      throw new ExprError("unexpected character");
    }
  }
  return out;
}

class Parser {
  i = 0;
  nodes = 0;
  constructor(private t: Tok[]) {}

  peek(): Tok | undefined {
    return this.t[this.i];
  }
  isOp(v: string): boolean {
    const p = this.peek();
    return !!p && p.k === "op" && p.v === v;
  }
  take(): Tok {
    const p = this.peek();
    if (!p) throw new ExprError("the formula stops early");
    this.i += 1;
    return p;
  }
  node<T extends Tree>(t: T): T {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new ExprError("the formula is too long");
    return t;
  }
  expr(depth: number): Tree {
    if (depth > MAX_DEPTH) throw new ExprError("the formula is nested too deeply");
    let left = this.term(depth);
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.take().v as "+" | "-";
      left = this.node([op, left, this.term(depth)]);
    }
    return left;
  }
  term(depth: number): Tree {
    let left = this.unary(depth);
    for (;;) {
      if (this.isOp("*") || this.isOp("/")) {
        const op = this.take().v as "*" | "/";
        left = this.node([op, left, this.unary(depth)]);
        continue;
      }
      const p = this.peek();
      const prev = this.i ? this.t[this.i - 1] : undefined;
      // 2x, 2(x+1), (a)(b): a name or bracket straight after a number or a closing bracket multiplies.
      const afterValue = !!prev && (prev.k === "num" || (prev.k === "op" && prev.v === ")"));
      if (afterValue && p && (p.k === "name" || (p.k === "op" && p.v === "("))) {
        left = this.node(["*", left, this.power(depth)]);
        continue;
      }
      return left;
    }
  }
  unary(depth: number): Tree {
    if (depth > MAX_DEPTH) throw new ExprError("the formula is nested too deeply");
    if (this.isOp("-")) {
      this.take();
      return this.node(["neg", this.unary(depth + 1)]);
    }
    if (this.isOp("+")) {
      this.take();
      return this.unary(depth + 1);
    }
    return this.power(depth);
  }
  power(depth: number): Tree {
    const base = this.atom(depth);
    if (this.isOp("^")) {
      this.take();
      return this.node(["^", base, this.unary(depth + 1)]);
    }
    return base;
  }
  atom(depth: number): Tree {
    const t = this.take();
    if (t.k === "num") return this.node(["num", t.v]);
    if (t.k === "name") {
      const f = Object.prototype.hasOwnProperty.call(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : null;
      if (f && this.isOp("(")) {
        this.take();
        const args = [this.expr(depth + 1)];
        while (this.isOp(",")) {
          this.take();
          args.push(this.expr(depth + 1));
        }
        if (!this.isOp(")")) throw new ExprError("missing )");
        this.take();
        if (args.length < f.min || args.length > f.max) throw new ExprError("wrong number of values");
        return this.node(["call", t.v, args]);
      }
      if (f) throw new ExprError("a function needs brackets");
      return this.node(["var", t.v]);
    }
    if (t.v === "(") {
      const inner = this.expr(depth + 1);
      if (!this.isOp(")")) throw new ExprError("missing )");
      this.take();
      return inner;
    }
    throw new ExprError("unexpected symbol");
  }
}

/** The formula as a tree. Throws ``ExprError``. */
export function parse(src: unknown): Tree {
  if (typeof src !== "string") throw new ExprError("not text");
  const text = src.trim();
  if (!text || text.length > MAX_LEN) throw new ExprError("empty or too long");
  const p = new Parser(tokens(text));
  const tree = p.expr(0);
  if (p.peek()) throw new ExprError("unexpected symbol");
  return tree;
}

function check(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIMIT) throw new ExprError("no value");
  return v;
}

/** The formula's value. Throws ``ExprError`` when it has none. */
export function evaluate(tree: Tree, env: Record<string, number>): number {
  switch (tree[0]) {
    case "num":
      return tree[1];
    case "var": {
      const name = tree[1];
      if (Object.prototype.hasOwnProperty.call(env, name)) return check(env[name]);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      throw new ExprError("unknown name");
    }
    case "neg":
      return -evaluate(tree[1], env);
    case "call":
      return check(FUNCTIONS[tree[1]].fn(...tree[2].map((a) => evaluate(a, env))));
    default: {
      const a = evaluate(tree[1], env);
      const b = evaluate(tree[2], env);
      switch (tree[0]) {
        case "+":
          return check(a + b);
        case "-":
          return check(a - b);
        case "*":
          return check(a * b);
        case "/":
          if (b === 0) throw new ExprError("divide by zero");
          return check(a / b);
        case "^":
          if (Math.abs(b) > 64 && Math.abs(a) > 1) throw new ExprError("no value");
          return check(Math.pow(a, b));
      }
    }
  }
  throw new ExprError("bad tree");
}

const cache = new Map<string, Tree | null>();

/** A formula ready to evaluate many times (a plot samples it per point). ``null`` when it can't be read. */
export function compile(src: string): Tree | null {
  if (!cache.has(src)) {
    let tree: Tree | null = null;
    try {
      tree = parse(src);
    } catch {
      tree = null;
    }
    if (cache.size > 200) cache.clear();
    cache.set(src, tree);
  }
  return cache.get(src) ?? null;
}

/** ``src`` evaluated, or ``null`` when it has no value. */
export function value(src: string, env: Record<string, number>): number | null {
  const tree = compile(src);
  if (!tree) return null;
  try {
    return evaluate(tree, env);
  } catch (e) {
    if (e instanceof ExprError) return null;
    throw e;
  }
}
