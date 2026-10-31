/*
 * Small JSON diffs between two states of an item file (RFC 6902 subset:
 * add / replace / remove). A save sends the patch from the last confirmed
 * state instead of the whole file; the server answers with the *fix* (what
 * its validation changed). Mirrors ``backend/app/items/jsonpatch.py``.
 */

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~");

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!(k in b) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Ops that turn ``a`` into ``b``. */
export function diff(a: unknown, b: unknown, path = "", ops: PatchOp[] = []): PatchOp[] {
  if (deepEqual(a, b)) return ops;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) ops.push({ op: "remove", path: `${path}/${esc(k)}` });
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) ops.push({ op: "add", path: `${path}/${esc(k)}`, value: v });
      else diff(a[k], v, `${path}/${esc(k)}`, ops);
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // Keep the common start and end; only the middle changed (an entry
    // removed from a 100k-review log is one op, not the whole list).
    const n = a.length;
    const m = b.length;
    let p = 0;
    while (p < n && p < m && deepEqual(a[p], b[p])) p++;
    let s = 0;
    while (s < n - p && s < m - p && deepEqual(a[n - 1 - s], b[m - 1 - s])) s++;
    const am = a.slice(p, n - s);
    const bm = b.slice(p, m - s);
    const common = Math.min(am.length, bm.length);
    for (let i = 0; i < common; i++) diff(am[i], bm[i], `${path}/${p + i}`, ops);
    if (am.length > bm.length) {
      for (let i = common; i < am.length; i++) ops.push({ op: "remove", path: `${path}/${p + common}` });
    } else {
      for (let i = common; i < bm.length; i++) {
        ops.push({ op: "add", path: `${path}/${s === 0 ? "-" : p + i}`, value: bm[i] });
      }
    }
    return ops;
  }
  ops.push({ op: "replace", path, value: b });
  return ops;
}

/** ``ops`` applied to a copy of ``doc``. Throws on a path that doesn't fit. */
export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  let root: unknown = typeof structuredClone === "function" ? structuredClone(doc) : JSON.parse(JSON.stringify(doc));
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") throw new Error("can't remove the root");
      root = op.value;
      continue;
    }
    const toks = op.path.slice(1).split("/").map(unesc);
    let parent: any = root;
    for (const t of toks.slice(0, -1)) {
      parent = Array.isArray(parent) ? parent[Number(t)] : parent?.[t];
      if (parent === undefined) throw new Error(`no ${op.path}`);
    }
    const last = toks[toks.length - 1];
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (op.op === "add") parent.splice(i, 0, op.value);
      else if (op.op === "replace") parent[i] = op.value;
      else parent.splice(i, 1);
    } else {
      if (op.op === "remove") delete parent[last];
      else parent[last] = op.value;
    }
  }
  return root as T;
}
