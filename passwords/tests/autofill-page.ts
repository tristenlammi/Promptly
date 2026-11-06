// Injected into test pages. The real classifier and filler, plus what a test needs to
// compare them with the fixture's expectations. Bundled by build-autofill-bundle.mjs.
import { analyzePage, type DomAdapter, type Field, type FormInfo, isVisible } from "../../frontend/src/passwords/core/autofill/classify";
import { fillFields, type FillValues } from "../../frontend/src/passwords/core/autofill/fill";

type Expected = { selector: string | string[]; role: string; frame: string[] | null };

const win = window as unknown as Record<string, unknown>;

function dom(): DomAdapter {
  const closed = (win.__closedRoots ?? {}) as Record<string, ShadowRoot>;
  const byHost = new Map<Element, ShadowRoot>();
  for (const [sel, root] of Object.entries(closed)) {
    const host = root?.host ?? document.querySelector(sel);
    if (host && root) byHost.set(host, root);
  }
  return { shadowRoot: (el) => byHost.get(el) ?? (el as Element).shadowRoot ?? null };
}

function resolve(selector: string | string[]): Element | null {
  const parts = Array.isArray(selector) ? selector : [selector];
  let root: ParentNode = document;
  const closed = (win.__closedRoots ?? {}) as Record<string, ShadowRoot>;
  let el: Element | null = null;
  for (let i = 0; i < parts.length; i++) {
    el = root.querySelector(parts[i]);
    if (!el) return null;
    if (i < parts.length - 1) {
      const shadow: ShadowRoot | null = el.shadowRoot ?? closed[parts[i]] ?? closed[parts.slice(0, i + 1).join(" ")] ?? null;
      if (!shadow) return null;
      root = shadow;
    }
  }
  return el;
}

function bestFor(page: { forms: FormInfo[]; best: FormInfo | null }, expected: Expected[]): FormInfo | null {
  if (!expected.length) return page.best;
  const wanted = expected.map((e) => resolve(e.selector));
  let best: FormInfo | null = null;
  let bestHits = -1;
  for (const f of page.forms) {
    const hits = f.fields.filter((x) => wanted.includes(x.el)).length;
    if (hits > bestHits) {
      best = f;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best : page.best;
}

let last: FormInfo | null = null;

win.__af = {
  analyze(expected: Expected[], honeypots: string[] = []) {
    const d = dom();
    const page = analyzePage(document, d);
    const form = bestFor(page, expected);
    last = form;
    const out: { kind: string; roles: { selector: unknown; want: string; got: string | null }[]; extras: string[]; missing: unknown[]; honeypotHit: string[]; fillableForms: number; kinds: string[] } = {
      kind: form?.kind ?? "none",
      roles: [],
      extras: [],
      missing: [],
      honeypotHit: [],
      fillableForms: page.forms.filter((f) => f.fields.length > 0).length,
      kinds: page.forms.map((f) => f.kind),
    };
    const seen = new Set<Element>();
    const LOGIN = ["signin", "email-first", "password-next", "signup", "change-password", "otp"];
    const allFields: Field[] = page.forms.filter((f) => (LOGIN.includes(f.kind) && (f.kind !== "signup" || form?.kind === "signup")) || f === form).flatMap((f) => f.fields);
    for (const e of expected) {
      const el = resolve(e.selector);
      if (!el) {
        out.missing.push(e.selector);
        continue;
      }
      seen.add(el);
      const inForm = (form?.fields ?? []).find((x) => x.el === el);
      const elsewhere = allFields.find((x) => x.el === el);
      out.roles.push({ selector: e.selector, want: e.role, got: inForm?.role ?? (elsewhere ? `other-form:${elsewhere.role}` : null) });
    }
    if (expected.length) {
      for (const f of form?.fields ?? []) {
        // A name or a company on a sign-up form is what the form asked for. It isn't a mistake.
        const neutral = form?.kind === "signup" && ["first-name", "last-name", "full-name", "company", "phone"].includes(f.role);
        if (!seen.has(f.el) && !neutral) out.extras.push(`${f.role}:${(f.el as HTMLInputElement).name || f.el.id || f.el.tagName}`);
      }
    }
    for (const h of honeypots) {
      const el = resolve(h);
      if (el && allFields.some((x) => x.el === el)) out.honeypotHit.push(h);
    }
    return out;
  },
  async fill(values: FillValues) {
    if (!last) return { filled: [] };
    const results = await fillFields(last.fields, values, (role) => {
      const again = analyzePage(document, dom());
      return again.forms.flatMap((f) => f.fields).find((f) => f.role === role)?.el ?? null;
    });
    return { filled: results.map((r) => ({ name: (r.el as HTMLInputElement).name || r.el.id, ok: r.ok, method: r.method })) };
  },
  state() {
    const f = win.__fixture as { state?: () => unknown } | undefined;
    return f?.state?.() ?? null;
  },
  domValue(selector: string | string[]) {
    return (resolve(selector) as HTMLInputElement | null)?.value ?? null;
  },
  exists(selector: string | string[]) {
    const el = resolve(selector);
    return !!el && isVisible(el);
  },
};
