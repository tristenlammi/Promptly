/**
 * Heuristic token counter used by the context-window pill.
 *
 * We deliberately skip shipping a full tokenizer (tiktoken + BPE
 * tables is ~2MB of JS and the pill is a *soft warning* — being off
 * by ±5% isn't a problem). Empirically the ``ceil(chars / 4)`` ratio
 * lands within ~10% of the real tokeniser for English-heavy content
 * across OpenAI, Anthropic, Gemini, and most open models. Code and
 * CJK characters are denser than average and get a small correction.
 *
 * If we ever want precise accounting (e.g. for billing), swap this
 * for a web-worker tokenizer — the API below stays the same.
 */

const AVG_CHARS_PER_TOKEN = 4;
// ChatML and most Anthropic turn-framing adds ~4 tokens of overhead
// per message for the role marker + delimiters.
const PER_MESSAGE_OVERHEAD = 4;

/** Count tokens in a single string. Returns 0 for empty input so the
 *  caller never has to special-case it. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // CJK characters carry ~1 token each, which the 4-chars rule
  // drastically underestimates. Count them separately.
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  // Subtract CJK from the character denominator so we don't
  // double-count them.
  const nonCjkLen = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(nonCjkLen / AVG_CHARS_PER_TOKEN);
}

export interface MessageLike {
  role: string;
  content: string | null | undefined;
}

/** Aggregate a conversation's messages into a single token estimate.
 *  Counts per-message overhead so a 50-message chat with one-word
 *  replies isn't modelled as a handful of tokens. */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(m.content);
  }
  return total;
}

export interface ContextBudgetInput {
  messages: MessageLike[];
  systemPrompt?: string | null;
  pinnedFilesText?: string | null;
  /** Reserve some headroom for the model's own reply so the pill
   *  doesn't lie about how much room is left. Tuned for typical
   *  assistant response length (~600 tokens) rather than the model's
   *  max_tokens cap, which most users never hit. */
  responseReserveTokens?: number;
}

export interface ContextBudget {
  systemTokens: number;
  pinnedFilesTokens: number;
  historyTokens: number;
  responseReserveTokens: number;
  totalTokens: number;
}

/** Build a full breakdown of token usage for a conversation.
 *
 *  Used by the TopNav pill to render its hover tooltip without
 *  re-walking the message list multiple times. The ``totalTokens``
 *  is what gets compared to the model's context window; the
 *  component parts are shown in the tooltip for transparency. */
export function computeContextBudget(
  input: ContextBudgetInput
): ContextBudget {
  const systemTokens = estimateTokens(input.systemPrompt);
  const pinnedFilesTokens = estimateTokens(input.pinnedFilesText);
  const historyTokens = estimateMessagesTokens(input.messages);
  const responseReserveTokens = input.responseReserveTokens ?? 600;
  return {
    systemTokens,
    pinnedFilesTokens,
    historyTokens,
    responseReserveTokens,
    totalTokens:
      systemTokens +
      pinnedFilesTokens +
      historyTokens +
      responseReserveTokens,
  };
}

/** Snap a raw token count to a compact human string — "12.4k" style
 *  for the pill label, "12,432" with commas for the tooltip. */
export function formatTokens(n: number, compact = true): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (!compact) return Math.round(n).toLocaleString();
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
