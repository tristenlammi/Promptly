/**
 * Currency helpers.
 *
 * Model providers (OpenRouter, OpenAI, Anthropic, Gemini, …) all price
 * in USD, and that's what we persist on every message and aggregate
 * row. Promptly is shipped to a small circle of friends / family in
 * Australia, so we surface costs in AUD at a hard-coded conversion
 * rate — it's not worth wiring a live FX feed for sub-cent estimates
 * next to a chat bubble or on the admin analytics page.
 *
 * Bump ``USD_TO_AUD`` when the rate moves materially.
 */

export const USD_TO_AUD = 1.55;

/** Format a USD figure as AUD with appropriate precision.
 *
 *  Tiny figures (< A$0.01) get four decimals — typical per-message
 *  token costs land around $0.0001–$0.01 and rounding to two would
 *  just print "A$0.00" for almost every row. Larger figures collapse
 *  back to the conventional two decimals.
 */
export function formatAud(usd: number | null | undefined): string {
  const n = typeof usd === "number" ? usd : 0;
  const aud = n * USD_TO_AUD;
  if (!Number.isFinite(aud) || aud === 0) return "A$0.00";
  const abs = Math.abs(aud);
  if (abs < 0.01) return `A$${aud.toFixed(4)}`;
  if (abs < 1) return `A$${aud.toFixed(3)}`;
  return `A$${aud.toFixed(2)}`;
}
