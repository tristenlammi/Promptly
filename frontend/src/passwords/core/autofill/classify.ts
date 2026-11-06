// Finds the fields on a page and works out what each is for, scoring many signals and
// never trusting one attribute. No framework, no extension APIs: this runs in content
// scripts, test harnesses and anywhere else with a DOM. Plan section 6.1.
import * as W from "./words";

export type FieldRole =
  | "username"
  | "email"
  | "password"
  | "new-password"
  | "confirm-password"
  | "current-password"
  | "otp"
  | "otp-digit"
  | "card-number"
  | "card-name"
  | "card-exp"
  | "card-exp-month"
  | "card-exp-year"
  | "card-cvv"
  | "first-name"
  | "last-name"
  | "full-name"
  | "address1"
  | "address2"
  | "city"
  | "state"
  | "postcode"
  | "country"
  | "phone"
  | "company";

export type FormKind = "signin" | "email-first" | "password-next" | "signup" | "change-password" | "otp" | "card" | "identity" | "search" | "newsletter" | "none";

export type Field = { el: FillableElement; role: FieldRole; score: number };
export type FormInfo = { kind: FormKind; fields: Field[]; container: Element | null; submit: HTMLElement | null };
export type PageInfo = { forms: FormInfo[]; best: FormInfo | null };
export type FillableElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type DomAdapter = {
  /** Shadow root of an element, open or closed, where the platform allows. */
  shadowRoot?: (el: Element) => ShadowRoot | null;
  /** Skip layout-based visibility, for a DOM with no layout (jsdom). */
  noLayout?: boolean;
};

const MAX_ELEMENTS = 20000;
const MAX_INPUTS = 400;
const MAX_DEPTH = 32;

const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio", "range", "color", "date", "datetime-local", "time", "week"]);

// ---- Text --------------------------------------------------------------------

const NON_LATIN = /[^\u0000-ɏ]/;

/** Lowercase, joined across camelCase and separators: "User_Name" -> user name + username. */
export function tokens(text: string): { words: Set<string>; joined: string } {
  const spaced = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFC");
  const words = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return { words: new Set(words), joined: words.join("") };
}

function hits(t: { words: Set<string>; joined: string }, list: readonly string[]): number {
  let best = 0;
  for (const raw of list) {
    const w = raw.replace(/\s+/g, "");
    if (!w) continue;
    if (t.words.has(w) || t.joined === w) {
      best = Math.max(best, 2);
    } else if (NON_LATIN.test(w)) {
      if (t.joined.includes(w)) best = Math.max(best, 2);
    } else if (w.length >= 5 && t.joined.includes(w)) {
      // Compounds: "loginusername", "benutzernamefeld".
      best = Math.max(best, 1);
    }
  }
  return best;
}

function phrase(text: string, list: readonly string[]): boolean {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  return list.some((p) => {
    const at = lower.indexOf(p);
    if (at < 0) return false;
    if (NON_LATIN.test(p)) return true;
    // Whole words: "subscriber" isn't "subscribe", and "signing" isn't "sign".
    for (let i = at; i >= 0; i = lower.indexOf(p, i + 1)) {
      const before = lower[i - 1] ?? " ";
      const after = lower[i + p.length] ?? " ";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    }
    return false;
  });
}

// ---- Walking the DOM ---------------------------------------------------------

function shadowOf(el: Element, dom: DomAdapter): ShadowRoot | null {
  try {
    return dom.shadowRoot?.(el) ?? el.shadowRoot ?? null;
  } catch {
    return null;
  }
}

/** Every element in document order, through shadow roots, with a budget. */
export function* walk(root: ParentNode, dom: DomAdapter, depth = 0): Generator<Element> {
  if (depth > MAX_DEPTH) return;
  let budget = MAX_ELEMENTS;
  const stack: Element[] = [...root.children].reverse();
  while (stack.length && budget-- > 0) {
    const el = stack.pop()!;
    yield el;
    const shadow = shadowOf(el, dom);
    if (shadow) yield* walk(shadow, dom, depth + 1);
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
}

function isField(el: Element): el is FillableElement {
  const tag = el.tagName;
  if (tag === "INPUT") return !SKIP_TYPES.has(((el as HTMLInputElement).type || "text").toLowerCase());
  return tag === "SELECT" || tag === "TEXTAREA";
}

function isTextual(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT";
}

// ---- Visibility ---------------------------------------------------------------

/** Up through shadow hosts too. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function isVisible(el: Element, dom: DomAdapter = {}): boolean {
  if (!el.isConnected) return false;
  if (dom.noLayout) {
    for (let n: Element | null = el; n; n = parentOf(n)) {
      if (n.hasAttribute("hidden")) return false;
      const s = (n.getAttribute("style") ?? "").replace(/\s/g, "");
      if (/display:none|visibility:hidden/.test(s)) return false;
    }
    return true;
  }
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  // Far off the page's scrollable area. Below the fold is fine.
  if (rect.right < -100 || rect.bottom + win.scrollY < -100) return false;
  // Parked off the right edge, where a drawer waits: unreachable unless the page scrolls there.
  if (rect.left >= win.innerWidth) {
    const root = el.ownerDocument.documentElement;
    const clipped = ["hidden", "clip"].includes(win.getComputedStyle(root).overflowX) || ["hidden", "clip"].includes(win.getComputedStyle(el.ownerDocument.body).overflowX);
    if (clipped || root.scrollWidth <= win.innerWidth || rect.left + win.scrollX >= root.scrollWidth) return false;
  }
  const style = win.getComputedStyle(el);
  if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") return false;
  let opacity = 1;
  for (let n: Element | null = el, i = 0; n && i < 40; n = parentOf(n), i++) {
    const s = win.getComputedStyle(n);
    if (s.display === "none") return false;
    opacity *= Number(s.opacity);
    if (s.clipPath && /inset\(\s*(50|100)%/.test(s.clipPath)) return false;
    if (n !== el && (s.overflowX !== "visible" || s.overflowY !== "visible")) {
      // Clipped away by a box around it (height:0 and overflow:hidden, say).
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (s.overflowX !== "visible" && (rect.left >= r.right || rect.right <= r.left)) return false;
      if (s.overflowY !== "visible" && (rect.top >= r.bottom || rect.bottom <= r.top)) {
        // A scrolling box can bring it into view, a clipping one can't.
        if (s.overflowY === "hidden" || s.overflowY === "clip") return false;
      }
    }
  }
  if (opacity < 0.05) return false;
  // A positioned box wrapper a long way off-screen.
  if (style.position === "absolute" || style.position === "fixed") {
    if (rect.left < -500 || rect.top < -500) return false;
  }
  return true;
}

function looksHoneypot(el: FillableElement, signal: string): boolean {
  const ariaHidden = el.closest?.('[aria-hidden="true"]');
  if (ariaHidden) return true;
  if (el.tabIndex === -1 && !isOtpBox(el)) return true;
  return /\b(honeypot|honey|hp_?field|do_?not_?fill|leave_?blank|leave_?empty|bot_?field|url_?confirm|nofill)\b/i.test(signal);
}

function isOtpBox(el: FillableElement): boolean {
  return isTextual(el) && el.maxLength === 1;
}

// ---- Signals --------------------------------------------------------------------

function labelText(el: FillableElement): string {
  const out: string[] = [];
  const doc = el.ownerDocument;
  const root = el.getRootNode() as Document | ShadowRoot;
  if (el.id) {
    try {
      const safe = CSS.escape(el.id);
      for (const l of root.querySelectorAll?.(`label[for="${safe}"]`) ?? []) out.push(l.textContent ?? "");
    } catch {
      /* odd ids */
    }
  }
  const wrap = el.closest("label");
  if (wrap) out.push(wrap.textContent ?? "");
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    for (const id of labelledby.split(/\s+/)) {
      const n = (root.querySelector?.(`#${CSS.escape(id)}`) ?? doc.getElementById(id)) as Element | null;
      if (n) out.push(n.textContent ?? "");
    }
  }
  return out.join(" ").slice(0, 300);
}

/** The text just before a field in reading order: unlabelled forms usually have it. */
function nearbyText(el: Element): string {
  const pick = (n: Element | null): string => {
    if (!n) return "";
    if (n.querySelector?.("input,select,textarea,button")) return "";
    return (n.textContent ?? "").trim().slice(0, 80);
  };
  let n: Element | null = el;
  for (let i = 0; i < 3 && n; i++) {
    const before = pick(n.previousElementSibling);
    if (before) return before;
    n = n.parentElement;
  }
  // A table layout: the cell before this one.
  const cell = el.closest("td,th");
  if (cell) return pick(cell.previousElementSibling);
  return "";
}

type Signals = {
  type: string;
  autocomplete: string;
  own: ReturnType<typeof tokens>;
  label: ReturnType<typeof tokens>;
  placeholder: ReturnType<typeof tokens>;
  near: ReturnType<typeof tokens>;
  rawOwn: string;
  name: string;
  readonlyFilled: boolean;
  months: boolean;
  years: boolean;
};

function signalsOf(el: FillableElement): Signals {
  const type = isTextual(el) ? (el.type || "text").toLowerCase() : el.tagName.toLowerCase();
  const attr = (a: string) => el.getAttribute(a) ?? "";
  const dataAttrs = [...el.attributes].filter((a) => a.name.startsWith("data-") && a.value.length < 60).map((a) => `${a.name.slice(5)} ${a.value}`).join(" ");
  const rawOwn = [attr("name"), attr("id"), attr("class"), attr("aria-label"), attr("title"), attr("formcontrolname"), attr("ng-model"), attr("v-model"), dataAttrs].join(" ");
  return {
    type,
    autocomplete: attr("autocomplete").toLowerCase().trim(),
    own: tokens(rawOwn),
    label: tokens(labelText(el)),
    placeholder: tokens(attr("placeholder")),
    near: tokens(nearbyText(el)),
    rawOwn,
    name: attr("name").toLowerCase(),
    readonlyFilled: "readOnly" in el && el.readOnly && !!el.value,
    months: el.tagName === "SELECT" && [...(el as HTMLSelectElement).options].filter((o) => /^(0?[1-9]|1[0-2])$/.test(o.value.trim()) || /^(jan|feb|mar)/i.test(o.text.trim())).length >= 3,
    years: el.tagName === "SELECT" && [...(el as HTMLSelectElement).options].filter((o) => /^(20\d\d|\d\d)$/.test(o.text.trim()) && !/^(0?[1-9]|1[0-2])$/.test(o.text.trim())).length >= 3,
  };
}

const AUTOCOMPLETE: Record<string, FieldRole> = {
  username: "username",
  email: "email",
  "current-password": "password",
  "new-password": "new-password",
  "one-time-code": "otp",
  "cc-number": "card-number",
  "cc-name": "card-name",
  "cc-exp": "card-exp",
  "cc-exp-month": "card-exp-month",
  "cc-exp-year": "card-exp-year",
  "cc-csc": "card-cvv",
  "given-name": "first-name",
  "family-name": "last-name",
  name: "full-name",
  "street-address": "address1",
  "address-line1": "address1",
  "address-line2": "address2",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "postcode",
  country: "country",
  "country-name": "country",
  tel: "phone",
  organization: "company",
};

const ROLE_WORDS: [FieldRole, readonly string[]][] = [
  ["password", W.PASSWORD],
  ["otp", W.OTP],
  ["username", W.USERNAME],
  ["email", W.EMAIL],
  ["card-number", W.CARD_NUMBER],
  ["card-name", W.CARD_NAME],
  ["card-cvv", W.CARD_CVV],
  ["card-exp-month", W.CARD_EXP_MONTH],
  ["card-exp-year", W.CARD_EXP_YEAR],
  ["card-exp", W.CARD_EXP],
  ["first-name", W.FIRST_NAME],
  ["last-name", W.LAST_NAME],
  ["full-name", W.FULL_NAME],
  ["address2", W.ADDRESS2],
  ["address1", W.ADDRESS1],
  ["city", W.CITY],
  ["state", W.STATE],
  ["postcode", W.POSTCODE],
  ["country", W.COUNTRY],
  ["phone", W.PHONE],
  ["company", W.COMPANY],
];

/** Points per role. The strongest signal wins, but they add up. */
function scoreRoles(s: Signals): Map<FieldRole, number> {
  const scores = new Map<FieldRole, number>();
  const add = (r: FieldRole, n: number) => scores.set(r, (scores.get(r) ?? 0) + n);

  for (const token of s.autocomplete.split(/\s+/)) {
    const hit = AUTOCOMPLETE[token];
    if (hit) add(hit, 8);
  }
  if (s.type === "password") add("password", 8);
  if (s.type === "email") add("email", 5);
  if (s.type === "tel") add("phone", 2);

  for (const [role, list] of ROLE_WORDS) {
    add(role, hits(s.own, list) * 2);
    add(role, hits(s.label, list) * 2.5);
    add(role, hits(s.placeholder, list) * 2);
    add(role, hits(s.near, list) * 1);
  }
  // A bare "name" means the person's name. "Family name", "user name" and "file name"
  // don't, and their own lists catch the ones that matter.
  for (const [t, weight] of [[s.own, 2], [s.label, 2.5], [s.placeholder, 2]] as const) {
    if (t.joined === "name" || t.joined === "yourname" || s.name === "name") add("full-name", weight * 2);
  }
  // "Corporate ID", "Member ID": an identifier, wherever one's asked for.
  if (s.label.words.has("id") && s.type !== "password") add("username", 4);
  if (s.label.joined === "card") add("card-number", 5);
  // Expiry split in two.
  const ph = s.placeholder.joined;
  if (ph === "mm") add("card-exp-month", 6);
  if (ph === "yy" || ph === "yyyy" || ph === "aa" || ph === "aaaa") add("card-exp-year", 6);
  if (s.type === "select") {
    if (s.months) add("card-exp-month", 6);
    if (s.years) add("card-exp-year", 6);
  }
  if (/\bexp[-_ ]?m(m|onth)?\b/i.test(s.rawOwn)) add("card-exp-month", 5);
  if (/\bexp[-_ ]?y(y|yyy|ear)?\b/i.test(s.rawOwn)) add("card-exp-year", 5);
  return scores;
}

// ---- A field's own verdict -------------------------------------------------------

type Scored = { el: FillableElement; scores: Map<FieldRole, number>; signals: Signals; visible: boolean };

function topRole(scores: Map<FieldRole, number>): [FieldRole, number] | null {
  let best: [FieldRole, number] | null = null;
  for (const [r, n] of scores) if (n > 0 && (!best || n > best[1])) best = [r, n];
  return best;
}

const CARD_ROLES: FieldRole[] = ["card-number", "card-name", "card-exp", "card-exp-month", "card-exp-year", "card-cvv"];
const IDENTITY_ROLES: FieldRole[] = ["first-name", "last-name", "full-name", "address1", "address2", "city", "state", "postcode", "country", "phone", "company", "email"];

function isSearchField(s: Signals): boolean {
  return s.type === "search" || s.name === "q" || hits(s.own, W.SEARCH) > 0 || hits(s.placeholder, W.SEARCH) > 1 || hits(s.label, W.SEARCH) > 1;
}

function notLoginField(s: Signals): boolean {
  return hits(s.own, W.NOT_LOGIN_FIELD) > 0 || hits(s.label, W.NOT_LOGIN_FIELD) > 1 || hits(s.placeholder, W.NOT_LOGIN_FIELD) > 1;
}

// ---- Grouping into forms ------------------------------------------------------------

/** A form element, or the nearest ancestor that's clearly the box around these fields. */
function groupKey(el: FillableElement): Element {
  const form = el.form ?? el.closest("form");
  if (form) {
    // One form around the whole page (ASP.NET does this): with several submit buttons
    // inside, the box around this field with its own button is the real form.
    if (form.querySelectorAll("input[type=submit],input[type=image],button:not([type=button])").length > 1) {
      let n: Element | null = el.parentElement;
      for (let i = 0; i < 8 && n && n !== form; i++) {
        if (n.querySelector("input[type=submit],input[type=image],button:not([type=button])")) return n;
        n = n.parentElement;
      }
    }
    return form;
  }
  let n: Element | null = el;
  for (let i = 0; i < 8 && n; i++) {
    const p = parentOf(n);
    if (!p || p.tagName === "BODY" || p.tagName === "HTML") break;
    const inputs = countInputs(p);
    // Stop at the first box holding a submit-like button, or more than this field.
    if (p.querySelector("button,input[type=submit],[role=button]") && inputs >= 1) return p;
    n = p;
  }
  return n ?? el;
}

function countInputs(p: Element): number {
  return p.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea").length;
}

function headingsOf(el: Element): string {
  return [...el.querySelectorAll("h1,h2,h3,h4,legend,[role=heading]")].map((h) => h.textContent ?? "").join(" | ") + " | " + headingAbove(el);
}

function textOf(el: Element): string {
  // Heading, legend and button text carry the form's purpose; body copy mostly doesn't.
  const parts: string[] = [];
  const add = (sel: string, limit: number) => {
    let n = 0;
    for (const x of el.querySelectorAll(sel)) {
      parts.push((x.textContent ?? "").slice(0, 120));
      if (++n >= limit) break;
    }
  };
  add("h1,h2,h3,h4,legend,[role=heading]", 4);
  add("button,input[type=submit],input[type=button],[role=button],a.button,a.btn", 6);
  for (const b of el.querySelectorAll("input[type=submit],input[type=button]")) parts.push((b as HTMLInputElement).value ?? "");
  return parts.join(" | ");
}

/** The nearest headings above a box, for forms whose title sits outside them. */
function headingAbove(el: Element): string {
  let n: Element | null = el;
  for (let i = 0; i < 4 && n; i++) {
    const heading = n.parentElement?.querySelector("h1,h2,h3,[role=heading]");
    if (heading) return (heading.textContent ?? "").slice(0, 120);
    n = n.parentElement;
  }
  return "";
}

function submitOf(group: Element, fields: FillableElement[], dom: DomAdapter): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  for (const el of walk(group, dom)) {
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && ["submit", "button", "image"].includes((el as HTMLInputElement).type))) {
      candidates.push(el as HTMLElement);
    }
    if (candidates.length > 30) break;
  }
  const ranked = candidates
    .filter((b) => isVisible(b, dom) && !fields.includes(b as FillableElement))
    .map((b) => {
      const text = `${b.textContent ?? ""} ${(b as HTMLInputElement).value ?? ""} ${b.getAttribute("aria-label") ?? ""}`;
      let score = 0;
      if (b.getAttribute("type") === "submit" || b.tagName === "INPUT") score += 3;
      if (phrase(text, W.SUBMIT_WORDS)) score += 3;
      if (/show|hide|toggle|reveal|eye|forgot|sign up|create account|cancel|back|google|apple|facebook|microsoft|sso|github/i.test(text)) score -= 3;
      return { b, score };
    })
    .sort((x, y) => y.score - x.score);
  return ranked[0]?.score > 0 ? ranked[0].b : ranked[0]?.b ?? null;
}

// ---- Deciding ------------------------------------------------------------------------

function classifyGroup(group: Element, scored: Scored[], dom: DomAdapter, pageText: string): FormInfo {
  // A read-only box that already holds a value is showing something, not asking for it.
  const visible = scored.filter((s) => s.visible && !s.signals.readonlyFilled);
  const none: FormInfo = { kind: "none", fields: [], container: group, submit: null };
  if (!visible.length) return none;

  const own = `${group.getAttribute("action") ?? ""} ${group.getAttribute("id") ?? ""} ${group.getAttribute("name") ?? ""} ${group.getAttribute("class") ?? ""} ${group.getAttribute("aria-label") ?? ""}`;
  const text = `${textOf(group)} | ${headingAbove(group)} | ${own}`;
  const allText = `${text} ${group.textContent?.slice(0, 600) ?? ""}`;

  const passwords = visible.filter((s) => {
    if (s.signals.type === "password") return true;
    // Some password boxes start as text until focused. Those say so more than once,
    // and hold nothing yet: "password_min" with 12 in it is a setting, and a label
    // with "passport" is a passport.
    if (s.el.tagName !== "INPUT" || (s.el as HTMLInputElement).value) return false;
    const top = topRole(s.scores);
    return top?.[0] === "password" && top[1] >= 6 && !isOtpBox(s.el) && !hitsOtp(s) && !/passport|min|max|length|policy|expir/i.test(s.signals.rawOwn);
  });
  const textFields = visible.filter((s) => !passwords.includes(s));

  // Search and newsletter forms: must not trigger.
  if (visible.every((s) => isSearchField(s.signals)) || group.getAttribute("role") === "search") {
    return { ...none, kind: "search" };
  }
  const onlyEmailish = visible.length <= 2 && !passwords.length && visible.some((s) => (topRole(s.scores)?.[0] === "email"));
  if (onlyEmailish && !phrase(text, W.LOGIN_INTENT.slice(0, 32)) && (phrase(allText, W.NEWSLETTER_INTENT) || hits(tokens(own), W.NEWSLETTER) > 0 || visible.some((s) => hits(s.signals.own, W.NEWSLETTER) > 0))) {
    return { ...none, kind: "newsletter" };
  }

  // Card, first: its security code would read as a one-time code otherwise.
  const giftish = (s: Scored) => /gift|voucher|coupon|loyalty|member/i.test(`${s.signals.rawOwn} ${[...s.signals.label.words].join(" ")}`);
  const cardFields = visible.filter((s) => topScore(s, CARD_ROLES) && !hitsOtp(s) && !giftish(s));
  const hasCardNumber = cardFields.some((s) => bestOf(s, CARD_ROLES)?.[0] === "card-number");
  const strongCard = cardFields.some((s) => s.signals.autocomplete.split(/\s+/).some((t) => t.startsWith("cc-")));
  // Hosted payment fields: each input in a frame of its own, so a frame may hold just one.
  const framed = doc(group).defaultView !== doc(group).defaultView?.top;
  const hostedHere = !passwords.length && cardFields.length > 0 && !!doc(group).querySelector("iframe");
  if (hasCardNumber || hostedHere || (framed && cardFields.length > 0 && strongCard) || (strongCard && cardFields.length >= 1 && !passwords.length)) {
    const named = visible.filter((s) => !cardFields.includes(s) && !giftish(s) && (topRole(s.scores)?.[0] === "full-name" || (s.scores.get("card-name") ?? 0) > 0) && /card|holder|name/i.test(`${s.signals.rawOwn} ${[...s.signals.label.words].join(" ")}`));
    for (const s of named) s.scores.set("card-name", Math.max(s.scores.get("card-name") ?? 0, 5));
    const fields = assign([...cardFields, ...named], CARD_ROLES);
    return { kind: "card", fields, container: group, submit: submitOf(group, fields.map((f) => f.el), dom) };
  }

  if (phrase(text, W.NOT_LOGIN_INTENT) && !passwords.length && !phrase(text, W.LOGIN_INTENT.slice(0, 16))) return none;
  const fieldText = visible.map((s) => `${s.signals.rawOwn} ${[...s.signals.label.words].join(" ")} ${[...s.signals.placeholder.words].join(" ")}`).join(" ");
  if ((phrase(fieldText, W.BACKUP_CODE_INTENT) || /backup|recovery|scratch/i.test(fieldText) || phrase(headingsOf(group), W.BACKUP_CODE_INTENT)) && !passwords.length) return none;
  if (visible.some((s) => s.el.tagName === "TEXTAREA") && !passwords.length && visible.every((s) => topRole(s.scores)?.[0] !== "address1")) return none;

  // OTP: split boxes, or one code box.
  const otpForm = detectOtp(visible, allText, pageText);
  if (otpForm) return { kind: "otp", fields: otpForm, container: group, submit: submitOf(group, otpForm.map((f) => f.el), dom) };

  if (passwords.length) return classifyPasswords(group, visible, passwords, textFields, text, dom);

  // Identity: enough person-and-address fields.
  const idFields = visible.filter((s) => topScore(s, IDENTITY_ROLES) && !notLoginField(s.signals));
  const addressy = idFields.filter((s) => ["address1", "city", "postcode", "state", "country"].includes(bestOf(s, IDENTITY_ROLES)?.[0] ?? ""));
  const whoish = idFields.filter((s) => ["first-name", "last-name", "full-name", "phone", "email"].includes(bestOf(s, IDENTITY_ROLES)?.[0] ?? ""));
  // An address on its own could be anyone's: a delivery spot, a store search. It takes
  // who it's for as well to be worth offering your details.
  if (whoish.length >= 1 && addressy.length >= 1) {
    const fields = assign(idFields, IDENTITY_ROLES);
    // One name box only: it wants the whole name, however it's labelled.
    const names = fields.filter((f) => ["first-name", "last-name", "full-name"].includes(f.role));
    if (names.length === 1 && !/given-name|family-name/.test(names[0].el.getAttribute("autocomplete") ?? "")) names[0].role = "full-name";
    return { kind: "identity", fields, container: group, submit: submitOf(group, fields.map((f) => f.el), dom) };
  }

  // Password's coming next: one identifier box, on something that reads like a sign-in.
  const phoneLogin = textFields.filter((s) => s.signals.type === "tel" && /code|continue|next|sign ?in|log ?in/i.test(textOf(group)));
  const ids = [...textFields.filter((s) => isIdentifier(s)), ...phoneLogin];
  const inFooter = !!group.closest?.("footer,[role=contentinfo]");
  if (ids.length === 1 && textFields.length <= 2 && !notLoginField(ids[0].signals) && !inFooter) {
    const s = ids[0];
    const sigStrong = (s.scores.get("username") ?? 0) >= 4 || (s.scores.get("email") ?? 0) >= 4 || phoneLogin.includes(s);
    const submit = submitOf(group, [s.el], dom);
    const submitText = submit ? `${submit.textContent ?? ""} ${(submit as HTMLInputElement).value ?? ""}` : "";
    const signinWords = phrase(`${text} ${pageText}`, W.LOGIN_INTENT.slice(0, 32)) || phrase(submitText, W.LOGIN_INTENT) || phoneLogin.includes(s);
    const hasContinue = !!submit && !/sign me up|subscribe|join|notify|keep me/i.test(submitText);
    if (sigStrong && signinWords && hasContinue) {
      const role: FieldRole = "username";
      return { kind: "email-first", fields: [{ el: s.el, role, score: s.scores.get("username") ?? 0 }], container: group, submit: submitOf(group, [s.el], dom) };
    }
  }
  return none;
}

function doc(el: Element): Document {
  return el.ownerDocument;
}

function hitsOtp(s: Scored): boolean {
  return s.signals.autocomplete.includes("one-time-code") || hits(s.signals.own, ["otp", "totp", "mfa", "2fa", "verificationcode", "verifycode", "authcode", "smscode"]) > 0;
}

function bestOf(s: Scored, among: FieldRole[]): [FieldRole, number] | null {
  let best: [FieldRole, number] | null = null;
  for (const r of among) {
    const n = s.scores.get(r) ?? 0;
    if (n > 0 && (!best || n > best[1])) best = [r, n];
  }
  return best;
}

function topScore(s: Scored, among: FieldRole[]): boolean {
  const best = bestOf(s, among);
  const overall = topRole(s.scores);
  return !!best && !!overall && best[1] >= overall[1] && best[1] >= 2;
}

/** Each element gets its best role, and each single-use role goes to its best element. */
function assign(list: Scored[], among: FieldRole[]): Field[] {
  const taken = new Map<FieldRole, Field>();
  const ordered = [...list].sort((a, b) => (bestOf(b, among)?.[1] ?? 0) - (bestOf(a, among)?.[1] ?? 0));
  const out: Field[] = [];
  for (const s of ordered) {
    const ranks = among
      .map((r) => [r, s.scores.get(r) ?? 0] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [r, n] of ranks) {
      if (taken.has(r)) continue;
      const f = { el: s.el, role: r, score: n };
      taken.set(r, f);
      out.push(f);
      break;
    }
  }
  const order = list.map((s) => s.el);
  return out.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
}

function isIdentifier(s: Scored): boolean {
  if (s.el.tagName !== "INPUT") return false;
  if (isSearchField(s.signals)) return false;
  const u = s.scores.get("username") ?? 0;
  const e = s.scores.get("email") ?? 0;
  const top = topRole(s.scores);
  if (!top) return false;
  if (u === 0 && e === 0) return false;
  return Math.max(u, e) >= top[1] - 0.5;
}

function detectOtp(visible: Scored[], text: string, pageText: string): Field[] | null {
  const anyPw = visible.some((s) => s.signals.type === "password" && !isOtpLike(s));
  // Split boxes: several short neighbours in a row.
  const boxes = visible.filter((s) => s.el.tagName === "INPUT" && isShortBox(s.el as HTMLInputElement));
  if (boxes.length >= 3 && boxes.length <= 12 && !anyPw) {
    const intent = phrase(`${text} ${pageText}`, W.OTP_INTENT) || boxes.some((s) => hitsOtp(s) || s.signals.autocomplete.includes("one-time-code"));
    const singles = boxes.every((s) => (s.el as HTMLInputElement).maxLength === 1 || (s.el as HTMLInputElement).inputMode === "numeric" || (s.el as HTMLInputElement).size === 1);
    if (intent || singles) return boxes.map((s) => ({ el: s.el, role: "otp-digit", score: 5 }));
  }
  if (anyPw) return null;
  // One box.
  const coded = visible.filter((s) => !notLoginField(s.signals) && (s.signals.autocomplete.includes("one-time-code") || otpScore(s) >= 4));
  if (coded.length === 1) {
    const s = coded[0];
    const strongOwn = s.signals.autocomplete.includes("one-time-code") || hitsOtp(s);
    const verifyWords = phrase(`${text} ${pageText}`, W.OTP_INTENT);
    const others = visible.filter((x) => x !== s && isIdentifier(x));
    if ((strongOwn || verifyWords) && !others.length && !phrase(text, ["coupon", "promo", "gift", "discount", "zip", "postal", "tracking", "voucher", "redeem"])) {
      return [{ el: s.el, role: "otp", score: otpScore(s) }];
    }
  }
  return null;
}

function otpScore(s: Scored): number {
  const n = s.scores.get("otp") ?? 0;
  // "code" alone is weak: a coupon is a code too.
  return n;
}

function isOtpLike(s: Scored): boolean {
  return hitsOtp(s) || (s.signals.type === "password" && (s.el as HTMLInputElement).maxLength > 0 && (s.el as HTMLInputElement).maxLength <= 8);
}

function isShortBox(el: HTMLInputElement): boolean {
  if (el.type !== "text" && el.type !== "tel" && el.type !== "number" && el.type !== "password") return false;
  if (el.maxLength === 1 || el.size === 1) return true;
  const r = el.getBoundingClientRect();
  return el.maxLength > 0 && el.maxLength <= 2 && r.width < 80;
}

function classifyPasswords(group: Element, visible: Scored[], passwords: Scored[], textFields: Scored[], text: string, dom: DomAdapter): FormInfo {
  const sig = (s: Scored) => [s.signals.own, s.signals.label, s.signals.placeholder, s.signals.near];
  const says = (s: Scored, list: readonly string[]) => sig(s).some((t) => hits(t, list) > 0);
  const auto = (s: Scored, v: string) => s.signals.autocomplete.split(/\s+/).includes(v);

  // Not this site's own login: a Wi-Fi password, say.
  if (passwords.every((p) => notLoginField(p.signals)) || (phrase(text, ["wi-fi", "wifi", "router", "ssid", "network settings"]) && !phrase(text, ["sign in", "log in", "login"]))) {
    return { kind: "none", fields: [], container: group, submit: null };
  }

  const fields: Field[] = [];
  const hasNew = passwords.some((p) => auto(p, "new-password"));
  const hasCurrent = passwords.some((p) => auto(p, "current-password") || says(p, W.CURRENT_PASSWORD));
  const changeWords = phrase(text, W.CHANGE_INTENT);
  const signupWords = phrase(text, W.SIGNUP_INTENT);
  const loginWords = phrase(text, W.LOGIN_INTENT.slice(0, 32));

  const newish = (p: Scored) => auto(p, "new-password") || says(p, W.NEW_PASSWORD);
  const confirmish = (p: Scored) => says(p, W.CONFIRM);

  let kind: FormKind;
  if (passwords.length >= 3 || (passwords.length === 2 && hasCurrent) || (hasCurrent && (changeWords || hasNew))) {
    kind = "change-password";
  } else if (passwords.length === 2) {
    // Two boxes: new + confirm. Sign-up if it asks who you are, else change/reset.
    const ids = textFields.filter(isIdentifier);
    const identity = textFields.some((s) => topScore(s, ["first-name", "last-name", "full-name"]));
    kind = changeWords && !signupWords && ids.length === 0 && !identity ? "change-password" : ids.length || identity || signupWords ? "signup" : "change-password";
  } else if (hasNew && changeWords) {
    kind = "change-password";
  } else if (hasNew || (signupWords && !loginWords)) {
    kind = "signup";
  } else if (textFields.filter(isIdentifier).length === 0) {
    kind = changeWords ? "change-password" : "password-next";
  } else {
    // Both words about: a tab page or a "no account? sign up" link. Field count decides.
    kind = signupWords && textFields.filter(isIdentifier).length >= 2 ? "signup" : "signin";
  }

  // Passwords in page order.
  if (kind === "change-password" || kind === "signup") {
    const order = [...passwords];
    if (kind === "change-password") {
      const current = order.find((p) => (auto(p, "current-password") || says(p, W.CURRENT_PASSWORD)) && !confirmish(p));
      const rest = order.filter((p) => p !== current);
      if (current) fields.push({ el: current.el, role: "current-password", score: 8 });
      const confirm = rest.find(confirmish) ?? (rest.length > 1 ? rest[rest.length - 1] : undefined);
      const nu = rest.find((p) => p !== confirm && (newish(p) || !confirm)) ?? rest.find((p) => p !== confirm);
      if (nu) fields.push({ el: nu.el, role: "new-password", score: 8 });
      if (confirm && confirm !== nu) fields.push({ el: confirm.el, role: "confirm-password", score: 8 });
    } else {
      const confirm = order.find(confirmish) ?? (order.length > 1 ? order[order.length - 1] : undefined);
      const nu = order.find((p) => p !== confirm) ?? order[0];
      fields.push({ el: nu.el, role: "new-password", score: 8 });
      if (confirm && confirm !== nu) fields.push({ el: confirm.el, role: "confirm-password", score: 8 });
    }
  } else {
    fields.push({ el: passwords[0].el, role: "password", score: 8 });
  }

  if (kind === "signin" || kind === "password-next" || kind === "signup") {
    const ids = textFields.filter(isIdentifier).filter((s) => !notLoginField(s.signals));
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const firstPw = passwords[0].el;
    if (kind === "signup") {
      // An email that's also the login is the username; "email" only means a separate
      // contact address next to a username box.
      const email = ids.find((s) => (s.scores.get("email") ?? 0) > (s.scores.get("username") ?? 0));
      const user = ids.find((s) => s !== email);
      if (email) fields.push({ el: email.el, role: user ? "email" : "username", score: 6 });
      if (user) fields.push({ el: user.el, role: "username", score: 6 });
      for (const s of textFields) {
        if (ids.includes(s)) continue;
        const r = bestOf(s, ["first-name", "last-name", "full-name", "phone", "company"]);
        if (r && r[1] >= 2 && topScore(s, ["first-name", "last-name", "full-name", "phone", "company"])) fields.push({ el: s.el, role: r[0], score: r[1] });
      }
    } else {
      // Sign-in: the identifier closest before the password. Any text input just
      // before it counts if nothing named one, since many forms have no good names.
      const prior = ids.filter((s) => before(s.el, firstPw));
      const pick = prior[prior.length - 1] ?? ids[0];
      if (pick) {
        fields.push({ el: pick.el, role: "username", score: 6 });
      } else {
        const plainBefore = textFields.filter((s) => s.el.tagName === "INPUT" && before(s.el, firstPw) && !notLoginField(s.signals) && !isSearchField(s.signals));
        const last = plainBefore[plainBefore.length - 1];
        if (last) fields.push({ el: last.el, role: "username", score: 2 });
      }
      kind = fields.some((f) => f.role === "username") ? "signin" : "password-next";
    }
  } else if (kind === "change-password") {
    // A change form sometimes holds a code or the username too.
    const code = textFields.find((s) => (s.scores.get("otp") ?? 0) >= 4 || s.signals.autocomplete.includes("one-time-code"));
    if (code) fields.push({ el: code.el, role: "otp", score: 5 });
  }

  const order = visible.map((s) => s.el);
  fields.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
  return { kind, fields, container: group, submit: submitOf(group, fields.map((f) => f.el), dom) };
}

const PRIORITY: Record<FormKind, number> = {
  signin: 9,
  "change-password": 8,
  signup: 7,
  "password-next": 8,
  otp: 7,
  "email-first": 6,
  card: 5,
  identity: 4,
  search: 1,
  newsletter: 1,
  none: 0,
};

/** Everything fillable on this document (one frame). Frames are analysed by their own
 *  content script, and the extension compares origins before filling across them. */
export function analyzePage(doc: Document, dom: DomAdapter = {}): PageInfo {
  const fields: FillableElement[] = [];
  for (const el of walk(doc, dom)) {
    if (isField(el)) {
      fields.push(el);
      if (fields.length >= MAX_INPUTS) break;
    }
  }
  const groups = new Map<Element, Scored[]>();
  for (const el of fields) {
    const signals = signalsOf(el);
    const key = groupKey(el);
    const visible = isVisible(el, dom) && !looksHoneypot(el, signals.rawOwn) && !(el as HTMLInputElement).disabled;
    const row: Scored = { el, scores: scoreRoles(signals), signals, visible };
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const pageText = `${doc.title} ${doc.querySelector("h1")?.textContent ?? ""} ${location?.pathname ?? ""}`;
  let forms = [...groups].map(([group, scored]) => classifyGroup(group, scored, dom, pageText)).filter((f) => f.kind !== "none" && f.kind !== "search" && f.kind !== "newsletter" ? f.fields.length > 0 : true);
  // A page with a real password form: any lone email box elsewhere on it is for
  // something else (a newsletter, a guest checkout), not the start of a sign-in.
  if (forms.some((f) => ["signin", "password-next", "signup", "change-password"].includes(f.kind))) {
    forms = forms.filter((f) => f.kind !== "email-first");
  }
  const lone = forms.filter((f) => f.kind === "email-first");
  if (lone.length > 1) {
    const says = (f: FormInfo) => !!f.container && phrase(`${textOf(f.container)} ${headingsOf(f.container)}`, W.LOGIN_INTENT.slice(0, 32));
    const keep = lone.find(says) ?? lone[0];
    forms = forms.filter((f) => f.kind !== "email-first" || f === keep);
  }
  const fillable = forms.filter((f) => f.fields.length > 0);
  const best = fillable.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || b.fields.length - a.fields.length)[0] ?? null;
  return { forms, best };
}
