/** Keep only ``<mark>`` tags from ``ts_headline`` output and escape
 *  everything else — the backend configures StartSel/StopSel as
 *  ``<mark>`` / ``</mark>`` so this is the only marker we have to
 *  whitelist. Snippets are capped defensively to 320 chars. A snippet is
 *  other people's words (a shared note, a page someone clipped), so it is
 *  never rendered as HTML without this. */
export function sanitizeSnippet(raw: string): string {
  const capped = raw.length > 320 ? raw.slice(0, 320) + "…" : raw;
  return capped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /&lt;mark&gt;/g,
      '<mark class="rounded bg-yellow-400/30 px-0.5 font-semibold text-[var(--text)]">'
    )
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}
