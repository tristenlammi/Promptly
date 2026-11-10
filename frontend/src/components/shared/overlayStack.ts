/**
 * One stack for everything that sits over the page (Modal, Sheet, Popover,
 * Menu). Only the top layer answers Escape and traps Tab, so one Escape
 * closes one thing: a menu inside a sheet inside a dialog unwinds a layer
 * at a time.
 */
const layers: symbol[] = [];

export function pushLayer(): symbol {
  const id = Symbol("layer");
  layers.push(id);
  return id;
}

export function removeLayer(id: symbol): void {
  const at = layers.lastIndexOf(id);
  if (at >= 0) layers.splice(at, 1);
}

export function isTopLayer(id: symbol): boolean {
  return layers[layers.length - 1] === id;
}

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keep Tab inside ``root``: call from a keydown handler when the key is Tab. */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  if (focusable.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
