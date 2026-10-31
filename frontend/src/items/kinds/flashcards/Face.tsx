import { Check, X } from "lucide-react";

import { cn } from "@/utils/cn";

import { CLOZE_RE, plain } from "./cards";
import { RichText } from "./RichText";
import type { Card } from "./types";

/** What a review item asks and answers. */
export function sides(card: Card, k: string) {
  if (card.type === "cloze") {
    const n = Number(k.slice(1)) || 1;
    return { kind: "cloze" as const, n, prompt: card.front, answer: card.back };
  }
  if (k === "r") return { kind: "basic" as const, n: null, prompt: card.back, answer: card.front };
  return { kind: card.type === "typein" ? ("typein" as const) : ("basic" as const), n: null, prompt: card.front, answer: card.back };
}

/** Plain, comparable text for type-in checks. */
export function normAnswer(s: string): string {
  return plain(s)
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`$]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?;,]+$/, "")
    .trim();
}

/** Short prompts read best big (Quizlet-style); long ones a notch smaller. */
function sizeFor(text: string, base: "md" | "lg"): "md" | "lg" | "xl" {
  if (base !== "lg") return base;
  const t = plain(text).trim();
  if (/\$\$|!\[|\n\s*[-*\d]|\|/.test(t)) return "lg";
  if (t.length <= 28) return "xl";
  if (t.length > 220) return "md";
  return "lg";
}

export function Face({
  card,
  k,
  revealed,
  typed,
  size = "lg",
}: {
  card: Card;
  k: string;
  revealed: boolean;
  typed?: string | null;
  size?: "md" | "lg";
}) {
  const s = sides(card, k);
  const reverse = k === "r";
  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      {reverse && <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Reverse</span>}
      {s.kind === "cloze" ? (
        <RichText text={s.prompt} cloze={s.n} reveal={revealed} size={size === "lg" && plain(s.prompt).length > 220 ? "md" : size} className="w-full" />
      ) : (
        <RichText text={s.prompt} size={sizeFor(s.prompt, size)} className="w-full" />
      )}
      {revealed && (
        <div className="flex w-full flex-col items-center gap-3 animate-[fadeIn_160ms_ease-out]">
          {s.kind !== "cloze" && <div className="h-px w-full bg-[var(--border)]" />}
          {s.kind === "typein" && typed !== undefined && typed !== null && <TypedResult typed={typed} answer={s.answer} />}
          {s.answer && (s.kind !== "typein" || typed === null || typed === undefined) && (
            <RichText text={s.answer} size={s.kind === "cloze" ? "md" : sizeFor(s.answer, size)} className={cn("w-full", s.kind === "cloze" && "text-[var(--text-muted)]")} />
          )}
          {s.kind === "typein" && typed !== null && typed !== undefined && <RichText text={s.answer} size={sizeFor(s.answer, size)} className="w-full" />}
          {card.note && (
            <div className="w-full rounded-xl bg-[var(--surface-2)] px-3 py-2 text-left">
              <RichText text={card.note} size="sm" className="text-[var(--text-muted)]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TypedResult({ typed, answer }: { typed: string; answer: string }) {
  const ok = normAnswer(typed) === normAnswer(answer);
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 text-base font-medium",
        ok ? "bg-[var(--success-bg)] text-[var(--success)]" : "bg-[var(--danger-bg)] text-[var(--danger)]",
      )}
      role="status"
    >
      {ok ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
      <span className={cn(!ok && "line-through decoration-2")}>{typed || "(nothing typed)"}</span>
    </div>
  );
}

export function typedCorrect(typed: string, card: Card, k: string): boolean {
  return normAnswer(typed) === normAnswer(sides(card, k).answer);
}

/** The answer of a review item as one plain line (multiple choice): a
 *  cloze item's hidden words, otherwise the other side. Media are left out. */
export function answerText(card: Card, k: string): string {
  const clean = (x: string) =>
    plain(x)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\$\$?/g, "")
      .replace(/[*_`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (card.type === "cloze") {
    const n = Number(k.slice(1)) || 1;
    const parts: string[] = [];
    for (const m of (card.front || "").matchAll(CLOZE_RE)) if (Number(m[1]) === n) parts.push(m[2]);
    return clean(parts.join(" … "));
  }
  return clean(sides(card, k).answer);
}
