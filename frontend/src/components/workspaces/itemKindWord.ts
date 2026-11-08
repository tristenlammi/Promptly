/**
 * A workspace item's kind as a word people see. The "note" kind is called a
 * **page** (Notes N1.7): Promptly has one thing called a note — the Notes
 * app's — and a workspace's documents are pages. Kinds and API names are
 * unchanged; this is only what's shown.
 */
export function itemKindWord(kind: string | null | undefined): string {
  if (kind === "note") return "page";
  if (kind === "container") return "notebook";
  return kind || "item";
}
