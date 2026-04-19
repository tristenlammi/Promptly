import { useEffect, useRef, useState } from "react";
import { Check, Globe, GlobeLock } from "lucide-react";

import type { WebSearchMode } from "@/api/types";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

interface WebSearchToggleProps {
  mode: WebSearchMode;
  onChange: (mode: WebSearchMode) => void;
  disabled?: boolean;
}

interface ModeMeta {
  label: string;
  description: string;
}

// Phase D1: the per-chat web-search switch is a three-mode picker
// instead of an on/off toggle, surfaced as a popover so the user can
// pick a mode with a single click + read what it means without having
// to discover a hidden cycle behaviour. The legacy "Web on / Web off"
// pill collapses cleanly into this — "off" mirrors the old off, and
// "always" mirrors the old on.
const MODE_META: Record<WebSearchMode, ModeMeta> = {
  off: {
    label: "Off",
    description: "Never search the web on this chat.",
  },
  auto: {
    label: "Auto",
    description:
      "The model decides per turn — it'll call web_search when the question needs current info.",
  },
  always: {
    label: "Always",
    description:
      "Force a web search before every reply. Use when you want sources cited every turn.",
  },
};

const MODE_ORDER: WebSearchMode[] = ["off", "auto", "always"];

export function WebSearchToggle({
  mode,
  onChange,
  disabled,
}: WebSearchToggleProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();

  // Close the popover when the user clicks anywhere outside it.
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

  const meta = MODE_META[mode];
  const active = mode !== "off";
  const Icon = mode === "off" ? GlobeLock : Globe;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Web search: ${meta.label}. ${meta.description}`}
        title={`Web search: ${meta.label} — ${meta.description}`}
        className={cn(
          "inline-flex items-center rounded-full border transition",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // Mobile: icon-only circular target. The accent fill carries
          // the "always" mode (filled) vs accent border for "auto"
          // (outlined) vs muted for "off". Three distinct visual
          // states without any text in the chip.
          isMobile
            ? "h-9 w-9 justify-center"
            : "h-8 gap-1.5 px-2.5 text-xs",
          mode === "always"
            ? "border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
            : mode === "auto"
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
        )}
      >
        <Icon className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!isMobile && (
          <>
            <span className="font-medium">Web</span>
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
          {MODE_ORDER.map((value) => {
            const m = MODE_META[value];
            const selected = value === mode;
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
