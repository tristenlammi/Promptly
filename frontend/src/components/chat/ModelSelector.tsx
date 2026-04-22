import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Eye, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAvailableModels } from "@/hooks/useProviders";
import { useModelStore, useSelectedModel } from "@/store/modelStore";
import { cn } from "@/utils/cn";

interface ModelSelectorProps {
  /** Compact rendering for tight headers (mobile). Collapses the trigger
   *  to an icon-only button — no model name, no provider — so it stops
   *  shoving the hamburger into the Share button on small screens. The
   *  dropdown opens at the same right-anchored position and is identical
   *  to the desktop list, so power users still get full control. */
  compact?: boolean;
}

export function ModelSelector({ compact = false }: ModelSelectorProps) {
  const { isLoading } = useAvailableModels();
  const available = useModelStore((s) => s.available);
  const selected = useSelectedModel();
  const setSelection = useModelStore((s) => s.setSelection);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Group models for the dropdown. Custom Models render as a single
  // top section (they share no real provider) so admins can pluck
  // one out without hunting through OpenRouter's 100+ rows. Raw
  // provider groups follow in their natural list order.
  const grouped = useMemo(() => {
    const customs = available.filter((m) => m.is_custom);
    const raws = available.filter((m) => !m.is_custom);

    const byProvider = new Map<
      string,
      { name: string; models: typeof available }
    >();
    for (const m of raws) {
      const existing = byProvider.get(m.provider_id);
      if (existing) existing.models.push(m);
      else byProvider.set(m.provider_id, { name: m.provider_name, models: [m] });
    }

    const groups: Array<{
      key: string;
      name: string;
      models: typeof available;
      isCustom?: boolean;
    }> = [];
    if (customs.length > 0) {
      groups.push({
        key: "__custom__",
        name: "Custom Models",
        models: customs,
        isCustom: true,
      });
    }
    for (const [providerId, g] of byProvider.entries()) {
      groups.push({ key: providerId, name: g.name, models: g.models });
    }
    return groups;
  }, [available]);

  if (isLoading) {
    return (
      <div className="text-xs text-[var(--text-muted)]">Loading models...</div>
    );
  }

  if (available.length === 0) {
    if (compact) {
      return (
        <button
          onClick={() => navigate("/models")}
          aria-label="Configure a model"
          title="Configure a model"
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            "border border-dashed border-[var(--border)] text-[var(--text-muted)]",
            "hover:text-[var(--text)]"
          )}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      );
    }
    return (
      <button
        onClick={() => navigate("/models")}
        className="inline-flex items-center gap-1.5 rounded-input border border-dashed border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        Configure a model
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  const label = selected
    ? `${selected.display_name} · ${selected.provider_name}`
    : "Select a model";

  return (
    <div ref={ref} className="relative">
      {compact ? (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={selected ? `Model: ${label}. Tap to change.` : "Select a model"}
          title={label}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
            "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          )}
        >
          {/* Tiny vision dot in the top-right corner so power users
              still know at a glance whether the active model can see
              images. Hidden when the model isn't vision-capable. */}
          {selected?.supports_vision && (
            <span
              aria-hidden
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-violet-500"
            />
          )}
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-input border px-3 py-1.5 text-xs",
            "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
            "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="max-w-[220px] truncate">{label}</span>
          {selected?.supports_vision && <VisionBadge compact />}
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          />
        </button>
      )}

      {open && (
        <div
          role="listbox"
          className={cn(
            "promptly-scroll absolute right-0 z-20 mt-1 max-h-96 overflow-y-auto rounded-card border shadow-lg",
            "border-[var(--border)] bg-[var(--surface)]",
            // Wider on desktop, but cap to viewport width on mobile so
            // the dropdown never scrolls horizontally off-screen.
            "w-[min(20rem,calc(100vw-1.5rem))]"
          )}
        >
          {grouped.map((group) => (
            <div key={group.key} className="py-1">
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {group.name}
              </div>
              {group.models.map((m) => {
                const active =
                  selected?.provider_id === m.provider_id &&
                  selected?.model_id === m.model_id;
                const subtitle = m.is_custom
                  ? `Based on ${m.base_display_name ?? m.provider_name}`
                  : `${m.model_id}${m.context_window ? ` · ${(m.context_window / 1000).toFixed(0)}k ctx` : ""}`;
                return (
                  <button
                    key={`${m.provider_id}:${m.model_id}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setSelection(m.provider_id, m.model_id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition",
                      "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                      active && "bg-[var(--accent)]/10"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">
                          {m.display_name}
                        </span>
                        {m.is_custom && <CustomBadge />}
                        {m.supports_vision && <VisionBadge />}
                      </div>
                      <div className="truncate text-[11px] text-[var(--text-muted)]">
                        {subtitle}
                      </div>
                    </div>
                    {active && (
                      <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomBadge() {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        "bg-[var(--accent)]/15 text-[var(--accent)]"
      )}
      title="Custom assistant — admin-curated personality + knowledge library"
    >
      <Sparkles className="h-2.5 w-2.5" />
      Custom
    </span>
  );
}

function VisionBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full font-medium uppercase tracking-wide",
        "bg-violet-500/15 text-violet-600 dark:text-violet-300",
        compact ? "px-1.5 py-px text-[9px]" : "px-1.5 py-0.5 text-[9px]"
      )}
      title="This model can read images you attach"
    >
      <Eye className="h-2.5 w-2.5" />
      Vision
    </span>
  );
}
