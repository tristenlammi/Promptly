/** Text cleanup for speech synthesis (read-aloud + voice mode).
 *
 * Mirrors the helpers MessageBubble uses for its read-aloud button so the
 * voice-mode overlay narrates replies the same clean way — no spoken
 * backticks, asterisks, citation markers or table pipes. */

/** Drop inline ``[1]`` citation markers and tidy the space before the
 *  punctuation they sat in front of. */
export function stripInlineCitations(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .replace(/(?:\s*\[\d{1,2}\])+/g, "")
    .replace(/\s+([.,;:!?])/g, "$1");
}

/** Flatten Markdown into something pleasant to read aloud: drop code
 *  blocks, link/image syntax, heading/emphasis markers and table pipes
 *  so the narration doesn't spell out punctuation and URLs. */
export function markdownToSpeech(markdown: string): string {
  if (!markdown) return "";
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
