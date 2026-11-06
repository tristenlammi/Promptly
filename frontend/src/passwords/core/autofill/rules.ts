// Learning (plan 6.5). "Teach it once" site rules, kept encrypted in the vault, and a
// curated rules pack: data only, never code. A pack from outside the extension or app
// is accepted only if it's signed by the pinned key. Selectors from a rule are used as
// plain CSS against the page, and the fields they find still pass the same fill guard.
import { fromB64u } from "../bytes";
import { ed25519Verify } from "../primitives";
import { signingInput } from "../format";
import { type FieldRole, type FillableElement, type FormInfo, type FormKind } from "./classify";
import type { SiteRule } from "../model";

export type RulesPack = { version: number; rules: SiteRule[] };
export type SignedPack = { pack: string; signature: string };

const MAX_RULES = 5000;

function validRule(r: unknown): r is SiteRule {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.host !== "string" || !/^[a-z0-9.-]{1,253}$/.test(x.host)) return false;
  for (const k of ["username", "password", "submit", "otp"]) {
    if (x[k] !== undefined && (typeof x[k] !== "string" || (x[k] as string).length > 300)) return false;
  }
  return x.never === undefined || typeof x.never === "boolean";
}

/** Verifies and parses a pack. Throws on anything odd, including an older version. */
export function openSignedPack(signed: SignedPack, publicKey: Uint8Array, minVersion = 0): RulesPack {
  const bytes = fromB64u(signed.pack);
  if (!ed25519Verify(fromB64u(signed.signature), signingInput("rules_pack", [bytes]), publicKey)) {
    throw new Error("That rules pack isn't signed by the right key");
  }
  const pack = JSON.parse(new TextDecoder().decode(bytes)) as RulesPack;
  if (!Number.isInteger(pack.version) || pack.version < minVersion) throw new Error("That rules pack is out of date");
  if (!Array.isArray(pack.rules) || pack.rules.length > MAX_RULES || !pack.rules.every(validRule)) throw new Error("That rules pack is malformed");
  return pack;
}

export function ruleForHost(rules: SiteRule[], host: string): SiteRule | null {
  const h = host.toLowerCase();
  let best: SiteRule | null = null;
  for (const r of rules) {
    if (h === r.host || h.endsWith(`.${r.host}`)) {
      if (!best || r.host.length > best.host.length) best = r;
    }
  }
  return best;
}

function pick(root: ParentNode, selector: string | undefined): Element | null {
  if (!selector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null; // A bad selector from a rule is just no match.
  }
}

/** The form a rule describes, if its fields are on this page. */
export function applyRule(doc: Document, rule: SiteRule): FormInfo | null {
  if (rule.never) return null;
  const fields: FormInfo["fields"] = [];
  const add = (selector: string | undefined, role: FieldRole) => {
    const el = pick(doc, selector);
    if (el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) fields.push({ el: el as FillableElement, role, score: 100 });
  };
  add(rule.username, "username");
  add(rule.password, "password");
  add(rule.otp, "otp");
  if (!fields.length) return null;
  const kind: FormKind = fields.some((f) => f.role === "password") ? (fields.some((f) => f.role === "username") ? "signin" : "password-next") : fields.some((f) => f.role === "otp") ? "otp" : "email-first";
  return { kind, fields, container: fields[0].el.closest("form"), submit: pick(doc, rule.submit) as HTMLElement | null };
}

/** A selector for an element a person clicked, as stable as the page allows. */
export function selectorFor(el: Element): string {
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  if (el.id && !/\d{3,}/.test(el.id)) return `#${esc(el.id)}`;
  const name = el.getAttribute("name");
  if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/["\\]/g, "\\$&")}"]`;
  const auto = el.getAttribute("autocomplete");
  if (auto && auto !== "off") return `${el.tagName.toLowerCase()}[autocomplete="${auto.replace(/["\\]/g, "\\$&")}"]`;
  const type = el.getAttribute("type");
  const parts: string[] = [];
  let n: Element | null = el;
  while (n && n.tagName !== "HTML" && parts.length < 6) {
    const here: Element = n;
    const parent: Element | null = here.parentElement;
    const nth = parent ? [...parent.children].filter((c) => c.tagName === here.tagName).indexOf(here) + 1 : 1;
    parts.unshift(`${here.tagName.toLowerCase()}:nth-of-type(${nth})`);
    n = parent;
  }
  return parts.join(" > ") + (type ? `[type="${type}"]` : "");
}

/** "Report this form": the page's structure with no values, no text content beyond
 *  labels, and nothing identifying. For a person to look at and decide to share. */
export function describeForm(doc: Document, host: string): string {
  const out = {
    host,
    title_length: doc.title.length,
    inputs: [...doc.querySelectorAll("input,select,textarea")].slice(0, 80).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.getAttribute("id"),
      autocomplete: el.getAttribute("autocomplete"),
      placeholder: el.getAttribute("placeholder"),
      aria_label: el.getAttribute("aria-label"),
      has_value: !!(el as HTMLInputElement).value,
      in_form: !!el.closest("form"),
    })),
    buttons: [...doc.querySelectorAll("button,input[type=submit]")].slice(0, 30).map((b) => (b.textContent ?? "").trim().slice(0, 40)),
  };
  return JSON.stringify(out, null, 1);
}
