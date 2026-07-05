/**
 * Deep-citation hand-off (Batch 4.2).
 *
 * When a citation / search hit opens a note, the *source* surface knows
 * which passage matched but the note pane mounts later and elsewhere.
 * This tiny module is the hand-off: set the pending anchor before
 * navigating, the note pane consumes it (once) after its collab content
 * arrives, finds the text, scrolls to it and flashes it.
 *
 * Text-quote anchoring on purpose — chunk offsets go stale the moment
 * anyone edits, a quoted string degrades gracefully (worst case: no
 * scroll, which is exactly today's behaviour).
 */
let pending: { refId: string; text: string } | null = null;
// Push channel for the already-open case: if the cited note is the one
// currently on screen, no mount effect re-runs — subscribers get poked.
const listeners = new Set<(refId: string) => void>();

export function setPendingHighlight(refId: string, text: string): void {
  const cleaned = text.replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  pending = { refId, text: cleaned };
  for (const fn of listeners) fn(refId);
}

/** Non-destructive read. The anchor is only cleared on a successful
 *  scroll (or explicit timeout) — a destructive read here gets eaten by
 *  React StrictMode's mount → cleanup → remount cycle in dev. */
export function peekPendingHighlight(refId: string): string | null {
  return pending && pending.refId === refId ? pending.text : null;
}

export function clearPendingHighlight(refId: string): void {
  if (pending && pending.refId === refId) pending = null;
}

export function onPendingHighlight(fn: (refId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Find the first block inside ``container`` whose text contains the
 *  anchor's head, scroll it into view, and flash it. Returns success. */
export function scrollToQuote(container: HTMLElement, quote: string): boolean {
  // Match on the first ~8 words — long quotes span blocks, and the head
  // is enough to land the eye on the right paragraph.
  const head = quote.split(" ").slice(0, 8).join(" ").toLowerCase();
  if (head.length < 8) return false;

  const findBlock = (): HTMLElement | null => {
    const blocks = container.querySelectorAll<HTMLElement>(
      "p, li, h1, h2, h3, h4, blockquote, pre, td, th"
    );
    for (const block of blocks) {
      const text = (block.textContent || "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (text.includes(head)) return block;
    }
    return null;
  };

  const block = findBlock();
  if (!block) return false;
  block.scrollIntoView({ behavior: "smooth", block: "center" });
  // Don't touch ProseMirror's DOM — it owns its nodes and strips foreign
  // classes on the next view update (collab cursors update constantly).
  // Instead float a fixed-position overlay over the block once the smooth
  // scroll has settled; nothing inside the editor can remove it.
  window.setTimeout(() => {
    const current = findBlock();
    if (!current) return;
    const rect = current.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.className = "citation-flash";
    Object.assign(overlay.style, {
      position: "fixed",
      left: `${rect.left - 4}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 4}px`,
      pointerEvents: "none",
      zIndex: "40",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(overlay);
    window.setTimeout(() => overlay.remove(), 2500);
  }, 450);
  return true;
}
