// Puts a value in a field so the page's framework believes it (plan 6.1). The native
// setter gets past React's value tracker, realistic events go out in order, and we
// check the value held. If it didn't, type it per character as a person would.
import type { Field, FieldRole, FillableElement } from "./classify";

export type FillResult = { el: FillableElement; ok: boolean; method: "set" | "type" | "paste" | "select" | "skipped" };
export type FillValues = Partial<Record<FieldRole, string>>;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nativeSetter(el: FillableElement): ((v: string) => void) | null {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  return desc?.set ? (v) => desc.set!.call(el, v) : null;
}

function keyEvent(el: Element, type: string, key: string): void {
  const code = /^\d$/.test(key) ? `Digit${key}` : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  el.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }));
}

function inputEvent(el: Element, data: string | null, inputType: string): void {
  el.dispatchEvent(new InputEvent("input", { data, inputType, bubbles: true, cancelable: true, composed: true }));
}

function focusIt(el: FillableElement): void {
  if (el.ownerDocument.activeElement !== el) {
    el.focus({ preventScroll: true });
    // A real focus doesn't fire when the page isn't focused; fire it ourselves.
    if (el.ownerDocument.activeElement !== el || !el.ownerDocument.hasFocus()) {
      el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    }
  }
}

function blurIt(el: FillableElement): void {
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  el.blur();
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
}

function setOnce(el: FillableElement, value: string): boolean {
  const setter = nativeSetter(el);
  focusIt(el);
  keyEvent(el, "keydown", value.at(-1) ?? "Unidentified");
  if (setter) setter(value);
  else (el as HTMLInputElement).value = value;
  inputEvent(el, value, "insertText");
  keyEvent(el, "keyup", value.at(-1) ?? "Unidentified");
  return el.value === value;
}

async function typeIt(el: FillableElement, value: string): Promise<boolean> {
  const setter = nativeSetter(el);
  focusIt(el);
  if (setter) setter("");
  inputEvent(el, null, "deleteContentBackward");
  let acc = "";
  for (const ch of value) {
    keyEvent(el, "keydown", ch);
    el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true, composed: true }));
    acc += ch;
    // A masked input may have reformatted what's there; append to what it holds.
    const current = el.value;
    if (setter) setter(current + ch);
    inputEvent(el, ch, "insertText");
    keyEvent(el, "keyup", ch);
    await pause(4);
  }
  return el.value === value || el.value.replace(/[\s-]/g, "") === value.replace(/[\s-]/g, "");
}

function matchOption(select: HTMLSelectElement, value: string): string | null {
  const v = value.trim().toLowerCase();
  const num = Number(v);
  const options = [...select.options];
  for (const o of options) if (o.value.toLowerCase() === v || o.text.trim().toLowerCase() === v) return o.value;
  if (!Number.isNaN(num)) {
    for (const o of options) {
      const ov = Number(o.value);
      const ot = Number(o.text.trim());
      if (ov === num || ot === num) return o.value;
      if (num < 100 && (ov === 2000 + num || ot === 2000 + num)) return o.value;
      if (num > 2000 && (ov === num - 2000 || ot === num - 2000)) return o.value;
    }
  }
  for (const o of options) if (o.text.trim().toLowerCase().startsWith(v) && v.length >= 2) return o.value;
  return null;
}

/** A field that's readonly until focus: focus it, give it a moment, then fill. */
async function readyForFill(el: FillableElement): Promise<boolean> {
  if (!("readOnly" in el) || !el.readOnly) return !el.disabled;
  focusIt(el);
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  for (let i = 0; i < 10 && el.readOnly; i++) await pause(30);
  return !el.readOnly && !el.disabled;
}

export async function fillField(el: FillableElement, value: string): Promise<FillResult> {
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    const opt = matchOption(select, value);
    if (opt === null) return { el, ok: false, method: "skipped" };
    focusIt(select);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(select, opt);
    else select.value = opt;
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    select.blur();
    return { el, ok: select.value === opt, method: "select" };
  }
  if (!(await readyForFill(el))) return { el, ok: false, method: "skipped" };

  // A password box that starts as text until focused swaps its type on focus.
  if (setOnce(el, value)) {
    await pause(0);
    // Frameworks may rerender in a tick and put their own state back.
    if (el.value === value) {
      blurIt(el);
      await pause(0);
      if (!el.isConnected || el.value === value) return { el, ok: true, method: "set" };
    }
  }
  const typed = await typeIt(el, value);
  blurIt(el);
  await pause(0);
  return { el, ok: typed && (el.isConnected ? el.value.length > 0 : true), method: "type" };
}

/** Split OTP boxes. Tried as a paste into the first box, then box by box. */
export async function fillSplit(boxes: FillableElement[], code: string): Promise<FillResult[]> {
  const first = boxes[0];
  focusIt(first);
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", code);
    let paste = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    // Firefox takes the text by another name, and ignores clipboardData in the constructor.
    if (paste.clipboardData?.getData("text/plain") !== code) {
      paste = new ClipboardEvent("paste", { dataType: "text/plain", data: code, bubbles: true, cancelable: true, composed: true } as ClipboardEventInit);
    }
    first.dispatchEvent(paste);
  } catch {
    // No synthetic clipboard here: box by box below.
  }
  await pause(30);
  const joined = () => boxes.map((b) => b.value).join("");
  if (joined() === code) return boxes.map((el) => ({ el, ok: true, method: "paste" as const }));

  const out: FillResult[] = [];
  const digits = [...code];
  for (let i = 0; i < boxes.length; i++) {
    const el = boxes[i];
    const ch = digits[i] ?? "";
    const setter = nativeSetter(el);
    focusIt(el);
    keyEvent(el, "keydown", ch);
    if (setter) setter(ch);
    inputEvent(el, ch, "insertText");
    keyEvent(el, "keyup", ch);
    await pause(6);
    out.push({ el, ok: el.value === ch, method: "type" });
  }
  boxes.at(-1)?.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return out;
}

/** Fill a form's fields. Only the ones classified, only when the caller said to.
 *  ``relocate`` finds a role's element again, for pages that re-render a field as soon
 *  as another one's filled and leave our reference pointing at nothing. */
export async function fillFields(fields: Field[], values: FillValues, relocate?: (role: FieldRole) => FillableElement | null, allow?: (el: FillableElement) => boolean): Promise<FillResult[]> {
  const out: FillResult[] = [];
  const digits = fields.filter((f) => f.role === "otp-digit");
  for (const f of fields) {
    if (f.role === "otp-digit") continue;
    const value = values[f.role] ?? (f.role === "email" ? values.username : f.role === "username" ? values.email : undefined);
    if (value === undefined || value === "") continue;
    const el = f.el.isConnected ? f.el : relocate?.(f.role) ?? f.el;
    // Asked again for every box, right before its value goes in, and for a box the page
    // swapped in since the caller last looked.
    if (allow && !allow(el)) {
      out.push({ el, ok: false, method: "skipped" });
      continue;
    }
    out.push(await fillField(el, value));
    await pause(0);
  }
  if (digits.length && values.otp) {
    const boxes = digits.map((d) => d.el);
    if (!allow || boxes.every((b) => allow(b))) out.push(...(await fillSplit(boxes, values.otp)));
  }
  return out;
}
