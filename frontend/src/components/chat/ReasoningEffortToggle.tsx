import { useEffect, useRef, useState } from "react";
import { Brain, Check } from "lucide-react";

import type { ReasoningEffort } from "@/api/types";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

interface ReasoningEffortToggleProps {
  /** Currently-selected effort. `null` = "use the provider's API default"
   *  (the legacy / non-DeepSeek behaviour). */
  effort: ReasoningEffort | null;
  /** Fires with the new effort. The picker never selects back to `null`
   *  itself — once the user has opted into reasoning controls, the four
   *  explicit values are enough. The conversation row keeps whatever was
   *  picked last. */
  onChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
}

interface EffortMeta {
  label: string;
  description: string;
}

// DeepSeek's hosted API exposes `thinking: {type: "enabled" | "disabled"}`
// plus `reasoning_effort: "low" | "medium" | "high"`. We collapse that
// two-knob design into a single four-state picker so the user never has
// to wonder "do I have both right?":
//   * "off"    -> thinking disabled (fastest path)
//   * "low"    -> thinking enabled, low effort (snappy reasoning)
//   * "medium" -> thinking enabled, medium effort (DeepSeek's own default)
//   * "high"   -> thinking enabled, high effort (deepest reasoning, slowest)
// The mapping lives on the server in `provider.py::stream_chat_events`.
const EFFORT_META: Record<ReasoningEffort, EffortMeta> = {
  off: {
    label: "Off",
    description: "Skip the thinking trace. Fastest replies, no reasoning tax.",
  },
  low: {
    label: "Low",
    description: "Light thinking before answering. Good for everyday questions.",
  },
  medium: {
    label: "Medium",
    description: "Balanced thinking — DeepSeek's own default.",
  },
  high: {
    label: "High",
    description: "Maximum thinking. Best for hard problems; slowest replies.",
  },
};

const EFFORT_ORDER: ReasoningEffort[] = ["off", "low", "medium", "high"];

export function ReasoningEffortToggle({
  effort,
  onChange,
  disabled,
}: ReasoningEffortToggleProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();

  // Close on outside click / Escape — same dismissal contract as the
  // WebSearchToggle popover so the input bar feels consistent.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Treat `null` as a synonym for "medium" in the chip rendering: the
  // user hasn't picked yet, so we surface DeepSeek's own default rather
  // than render an empty pill. Picking any option commits a real value.
  const displayEffort: ReasoningEffort = effort ?? "medium";
  const meta = EFFORT_META[displayEffort];
  const active = effort !== null && effort !== "off";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Reasoning: ${meta.label}. ${meta.description}`}
        title={`Reasoning: ${meta.label} — ${meta.description}`}
        className={cn(
          "inline-flex items-center rounded-full border transition",
          "disabled:cursor-not-allowed disabled:opacity-40",
          isMobile
            ? "h-9 w-9 justify-center"
            : "h-8 gap-1.5 px-2.5 text-xs",
          displayEffort === "high"
            ? "border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
            : active
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
        )}
      >
        <Brain className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!isMobile && (
          <>
            <span className="font-medium">Reason</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] uppercase tracking-wide",
                active
                  ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                  : "bg-black/[0.04] text-[var(--text-muted)] dark:bg-white/[0.06]"
              )}
            >
              {meta.label}
            </span>
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full left-0 z-30 mb-2 w-72 origin-bottom-left",
            "rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg",
            "p-1 text-sm"
          )}
        >
          {EFFORT_ORDER.map((value) => {
            const m = EFFORT_META[value];
            const selected = value === displayEffort;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition",
                  "hover:bg-[var(--accent)]/[0.08]",
                  selected && "bg-[var(--accent)]/[0.06]"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center",
                    selected ? "text-[var(--accent)]" : "text-transparent"
                  )}
                  aria-hidden
                >
                  <Check className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm font-semibold",
                      selected
                        ? "text-[var(--accent)]"
                        : "text-[var(--text)]"
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-[var(--text-muted)]">
                    {m.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
