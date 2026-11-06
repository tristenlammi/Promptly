// Anti-clickjacking for the inline menu (plan 6.6). Called when the menu shows, and
// again at the moment of a click. Covers each published DOM-based variant: opacity on
// the host, its parents or body/html (even 0.001), other CSS that hides it (filter,
// clip, mask, transform), overlays with pointer-events:none, the Popover API top
// layer, position games that move the UI under a lure or the cursor. It raises the
// bar, and isn't a proof: the safest setting is filling from the toolbar popup only.

export type GuardVerdict = { ok: boolean; reason?: string };
export const MIN_DWELL_MS = 400;
const MIN_OPACITY = 0.99;

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
    if (s.filter && s.filter !== "none" && /opacity|brightness\(0|contrast\(0|blur/.test(s.filter)) return "filter";
    if (s.backdropFilter && s.backdropFilter !== "none" && n !== host) return "backdrop-filter";
    if (s.clipPath && s.clipPath !== "none") return "clip-path";
    if (s.clip && s.clip !== "auto" && s.position !== "static") return "clip";
    const mask = s.getPropertyValue("mask-image") || s.getPropertyValue("-webkit-mask-image");
    if (mask && mask !== "none") return "mask";
    if (s.mixBlendMode && s.mixBlendMode !== "normal") return "blend-mode";
    if (s.transform && s.transform !== "none" && /matrix\(0|scale\(0/.test(s.transform)) return "transform";
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
  if (r.width < 2 || r.height < 2) return { ok: false, reason: "size" };
  const bottom = r.bottom + win.scrollY;
  const right = r.right + win.scrollX;
  if (bottom < 0 || right < 0) return { ok: false, reason: "off-screen" };
  return { ok: true };
}
