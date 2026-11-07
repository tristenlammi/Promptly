// Anti-clickjacking for the inline menu (plan 6.6). Called when the menu shows, and
// again at the moment of a click. Covers each published DOM-based variant: opacity on
// the host, its parents or body/html (even 0.001), other CSS that hides it (filter,
// clip, mask, transform), overlays with pointer-events:none, the Popover API top
// layer, position games that move the UI under a lure or the cursor. It raises the
// bar, and isn't a proof: the safest setting is filling from the toolbar popup only.

export type GuardVerdict = { ok: boolean; reason?: string };
/** Matches the menu frame's own wait (press.ts, D77), so neither refuses what the other allows. */
export const MIN_DWELL_MS = 300;
const MIN_OPACITY = 0.99;
/** Smaller than this isn't a box anyone's meant to see. Hidden card fields use 2 px. */
export const MIN_FIELD_PX = 10;

/** Has a colour you can see, for a computed colour string. */
function painted(color: string): boolean {
  if (!color) return false;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return color !== "transparent";
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length < 4 || parseFloat(parts[3]) > 0.05;
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
}

/** Anything up the chain that makes the host see-through or removes it from view. */
export function hiddenByStyle(host: Element): string | null {
  const win = host.ownerDocument.defaultView;
  if (!win) return "no-window";
  let opacity = 1;
  for (let n: Element | null = host; n; n = parentOf(n)) {
    const s = win.getComputedStyle(n);
    opacity *= Number(s.opacity);
    if (s.display === "none") return "display";
    if (s.visibility === "hidden" || s.visibility === "collapse") return "visibility";
    if (s.filter && s.filter !== "none" && /opacity|brightness\(0|contrast\(0|blur|url\(/.test(s.filter)) return "filter";
    if (s.backdropFilter && s.backdropFilter !== "none" && n !== host) return "backdrop-filter";
    if (s.clipPath && s.clipPath !== "none") return "clip-path";
    if (s.clip && s.clip !== "auto" && s.position !== "static") return "clip";
    const mask = s.getPropertyValue("mask-image") || s.getPropertyValue("-webkit-mask-image");
    if (mask && mask !== "none") return "mask";
    if (s.mixBlendMode && s.mixBlendMode !== "normal") return "blend-mode";
    if (s.transform && s.transform !== "none" && /matrix\(0|scale\(0/.test(s.transform)) return "transform";
    const scale = s.getPropertyValue("scale");
    if (scale && scale !== "none" && scale.split(/\s+/).some((x) => Math.abs(parseFloat(x)) < 0.05)) return "scale";
    const zoom = parseFloat(s.getPropertyValue("zoom"));
    if (!Number.isNaN(zoom) && zoom < 0.2) return "zoom";
    // Flipped away from the viewer. Plain translateZ(0) with this set is a common CSS habit.
    if (s.getPropertyValue("backface-visibility") === "hidden" && /^matrix(3d)?\(\s*-/.test(s.transform)) return "backface";
    if (s.contentVisibility === "hidden") return "content-visibility";
  }
  if (opacity < MIN_OPACITY) return "opacity";
  return null;
}

/** ``elementsFromPoint`` misses pointer-events:none overlays, so they're looked for by
 *  geometry: anything painted over our rectangle that isn't us. */
export function coveredBy(host: Element, rect: DOMRectReadOnly, shadowContains?: (el: Element) => boolean): Element | null {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win) return host;
  const points: [number, number][] = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + 4, rect.top + 4],
    [rect.right - 4, rect.top + 4],
    [rect.left + 4, rect.bottom - 4],
    [rect.right - 4, rect.bottom - 4],
  ];
  const isUs = (el: Element) => el === host || (shadowContains?.(el) ?? false);
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) return host; // off-screen counts as covered
    const stack = doc.elementsFromPoint(x, y);
    if (stack.length && !isUs(stack[0])) return stack[0];
  }
  // Fixed or absolute boxes above us that ignore the pointer.
  const all = doc.querySelectorAll("body *, html > *");
  const hostZ = zOf(host, win);
  let n = 0;
  for (const el of all) {
    if (++n > 4000) break;
    if (isUs(el) || el.contains(host)) continue;
    const s = win.getComputedStyle(el);
    if (s.pointerEvents !== "none") continue;
    if (s.position !== "fixed" && s.position !== "absolute") continue;
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    if (s.backgroundColor === "rgba(0, 0, 0, 0)" && s.backgroundImage === "none" && !el.textContent?.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) {
      if (zOf(el, win) >= hostZ || el.matches(":popover-open")) return el;
    }
  }
  return null;
}

function zOf(el: Element, win: Window): number {
  const z = win.getComputedStyle(el).zIndex;
  return z === "auto" ? 0 : Number(z) || 0;
}

/** Other things in the top layer opened over or after us. */
export function topLayerRivals(host: Element): Element[] {
  const doc = host.ownerDocument;
  const out: Element[] = [];
  for (const el of doc.querySelectorAll("[popover]")) {
    try {
      if (el !== host && el.matches(":popover-open")) out.push(el);
    } catch {
      /* :popover-open unsupported */
    }
  }
  for (const el of doc.querySelectorAll("dialog[open]")) {
    try {
      if (el.matches(":modal")) out.push(el);
    } catch {
      /* :modal unsupported */
    }
  }
  return out;
}

export function isLastInDom(host: Element): boolean {
  const doc = host.ownerDocument.documentElement;
  return doc.lastElementChild === host || !host.nextElementSibling;
}

export type GuardState = {
  shownAt: number;
  rect: { left: number; top: number; width: number; height: number };
};

/** Everything checked at click time. Any failure means: don't fill from here, offer
 *  the toolbar popup instead. */
export function checkAtClick(host: Element, state: GuardState, opts: { now?: number; shadowContains?: (el: Element) => boolean; isTrusted: boolean; tampered?: boolean; visibleV2?: boolean } ): GuardVerdict {
  const now = opts.now ?? performance.now();
  if (!opts.isTrusted) return { ok: false, reason: "untrusted-event" };
  if (opts.tampered) return { ok: false, reason: "tampered" };
  if (now - state.shownAt < MIN_DWELL_MS) return { ok: false, reason: "too-fast" };
  if (opts.visibleV2 === false) return { ok: false, reason: "not-visible" };
  if (!host.isConnected) return { ok: false, reason: "removed" };
  const r = host.getBoundingClientRect();
  if (Math.abs(r.left - state.rect.left) > 1 || Math.abs(r.top - state.rect.top) > 1 || Math.abs(r.width - state.rect.width) > 1 || Math.abs(r.height - state.rect.height) > 1) {
    return { ok: false, reason: "moved" };
  }
  const hidden = hiddenByStyle(host);
  if (hidden) return { ok: false, reason: `hidden:${hidden}` };
  const rivals = topLayerRivals(host);
  if (rivals.length) return { ok: false, reason: "top-layer" };
  const cover = coveredBy(host, r, opts.shadowContains);
  if (cover) return { ok: false, reason: "covered" };
  if (!isLastInDom(host)) return { ok: false, reason: "not-last" };
  return { ok: true };
}

/** IntersectionObserver v2's answer, for browsers that have it (Chromium). It sees what
 *  checks from inside a frame can't: a parent frame hiding that frame. Where the browser
 *  doesn't have it this returns undefined and changes nothing. Where it does, no reading
 *  yet counts as not visible. */
export function visibilityV2(supported: boolean, reading: boolean | undefined): boolean | undefined {
  if (!supported) return undefined;
  return reading === true;
}

/** Before a fill puts a value in a field: only fields a person can see and that the
 *  user chose. Off-screen, hidden and see-through ones are refused, whatever the
 *  classifier said. */
export function fieldIsFillable(el: Element): GuardVerdict {
  const win = el.ownerDocument.defaultView;
  if (!win) return { ok: false, reason: "no-window" };
  const hidden = hiddenByStyle(el);
  if (hidden) return { ok: false, reason: `hidden:${hidden}` };
  const r = el.getBoundingClientRect();
  if (r.width < MIN_FIELD_PX || r.height < MIN_FIELD_PX) return { ok: false, reason: "size" };
  const bottom = r.bottom + win.scrollY;
  const right = r.right + win.scrollX;
  if (bottom < 0 || right < 0) return { ok: false, reason: "off-screen" };
  const s = win.getComputedStyle(el);
  if (!painted(s.color) && !painted(s.getPropertyValue("-webkit-text-fill-color")) && !painted(s.backgroundColor)) return { ok: false, reason: "see-through" };
  if (parseFloat(s.fontSize) < 1) return { ok: false, reason: "no-text" };
  return { ok: true };
}

export function inViewport(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return x >= 0 && y >= 0 && x <= win.innerWidth && y <= win.innerHeight;
}

/** Everything at a point, topmost first, going down into shadow roots. */
function stackAt(doc: Document, x: number, y: number, shadowOf?: (el: Element) => ShadowRoot | null): Element[] {
  const out: Element[] = [];
  for (const el of doc.elementsFromPoint(x, y)) {
    const root = shadowOf?.(el);
    if (root) for (const inner of root.elementsFromPoint(x, y)) if (inner !== el && !out.includes(inner)) out.push(inner);
    if (!out.includes(el)) out.push(el);
  }
  return out;
}

/** Is this box really what's on screen at its centre? It has to be there at all, which a
 *  box clipped away by a parent isn't, and nothing painted can be above it. Text and icons
 *  over a box are normal (floating labels, a show-password eye), so only a painted
 *  background counts as covering it. Only meaningful for a box inside the viewport. */
export function fieldIsClear(el: Element, shadowOf?: (el: Element) => ShadowRoot | null): GuardVerdict {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return { ok: false, reason: "no-window" };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const stack = stackAt(doc, x, y, shadowOf);
  const at = stack.indexOf(el);
  if (at < 0) return { ok: false, reason: "clipped" };
  for (const above of stack.slice(0, at)) {
    if (above.contains(el)) continue;
    const labels = (el as HTMLInputElement).labels;
    if (labels && [...labels].some((l) => l === above || l.contains(above))) continue;
    const s = win.getComputedStyle(above);
    if (Number(s.opacity) > 0.1 && (painted(s.backgroundColor) || s.backgroundImage !== "none")) return { ok: false, reason: "covered" };
  }
  // A cover that ignores the pointer doesn't show up in that list.
  let looked = 0;
  for (const other of doc.querySelectorAll("body *, html > *")) {
    if (++looked > 4000) break;
    if (other === el || other.contains(el) || el.contains(other)) continue;
    const s = win.getComputedStyle(other);
    if (s.pointerEvents !== "none" || (s.position !== "fixed" && s.position !== "absolute")) continue;
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.1) continue;
    if (!painted(s.backgroundColor) && s.backgroundImage === "none") continue;
    const o = other.getBoundingClientRect();
    if (x >= o.left && x <= o.right && y >= o.top && y <= o.bottom && (zOf(other, win) >= zOf(el, win) || other.matches(":popover-open"))) return { ok: false, reason: "covered" };
  }
  return { ok: true };
}
