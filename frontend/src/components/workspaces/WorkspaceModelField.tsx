import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles, X } from "lucide-react";

import { useAvailableModels } from "@/hooks/useProviders";
import { useModelStore } from "@/store/modelStore";
import type { AvailableModel } from "@/api/types";
import { cn } from "@/utils/cn";

interface WorkspaceModelFieldProps {
  /** The workspace's stored ``default_model_id`` (or null for "no default"). */
  modelId: string | null;
  /** The workspace's stored ``default_provider_id`` (or null). */
  providerId: string | null;
  /** Fires with the new pair, or (null, null) when cleared. */
  onChange: (modelId: string | null, providerId: string | null) => void;
  /** Read-only: show the current default model but don't allow changing it
   *  (viewers see what the workspace uses without being able to edit). */
  disabled?: boolean;
}

/** Controlled model picker for the workspace's default model.
 *
 * Deliberately NOT the chat ``ModelSelector`` — that component is wired
 * to the global ``modelStore`` selection and switching it would change
 * the model for the user's *current* chat. This one reads the same
 * ``available`` catalogue but is fully controlled by props, so it only
 * ever mutates the workspace record via ``onChange``.
 *
 * "No default" is a first-class choice: clearing it means new chats in
 * the workspace fall back to the user's current model, matching the
 * behaviour before a default was ever set. */
export function WorkspaceModelField({
  modelId,
  providerId,
  onChange,
  disabled = false,
}: WorkspaceModelFieldProps) {
  useAvailableModels(); // ensure the catalogue is loaded into the store
  const available = useModelStore((s) => s.available);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = useMemo(
    () =>
      available.find(
        (m) => m.provider_id === providerId && m.model_id === modelId
      ) ?? null,
    [available, providerId, modelId]
  );

  // Group like the chat picker: custom models first, then by provider.
  const grouped = useMemo(() => {
    const customs = available.filter((m) => m.is_custom);
    const raws = available.filter((m) => !m.is_custom);
    const byProvider = new Map<string, { name: string; models: AvailableModel[] }>();
    for (const m of raws) {
      const g = byProvider.get(m.provider_id);
      if (g) g.models.push(m);
      else byProvider.set(m.provider_id, { name: m.provider_name, models: [m] });
    }
    return { customs, providers: [...byProvider.values()] };
  }, [available]);

  const pick = (m: AvailableModel | null) => {
    if (m) onChange(m.model_id, m.provider_id);
    else onChange(null, null);
    setOpen(false);
  };

  // ``modelId`` set but not in the catalogue → the model was disabled or
  // the provider removed since it was chosen. Surface that rather than
  // silently showing nothing.
  const staleLabel =
    modelId && !selected ? `${modelId} (unavailable)` : null;

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        Default model{" "}
        <span className="text-[var(--text-muted)]/70">
          (new chats in this workspace start with this)
        </span>
      </label>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)]",
            open && "border-[var(--accent)]",
            disabled && "cursor-default opacity-60"
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.is_custom && (
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            )}
            <span className={cn("truncate", !selected && "text-[var(--text-muted)]")}>
              {selected
                ? selected.display_name
                : staleLabel ?? "No default — use my current model"}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        </button>

        {open && (
          <div className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
            <Option
              active={!modelId}
              onClick={() => pick(null)}
              icon={<X className="h-3.5 w-3.5" />}
              label="No default — use my current model"
            />
            {grouped.customs.length > 0 && (
              <>
                <GroupHeader label="Custom models" />
                {grouped.customs.map((m) => (
                  <Option
                    key={m.model_id}
                    active={m.model_id === modelId && m.provider_id === providerId}
                    onClick={() => pick(m)}
                    icon={<Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />}
                    label={m.display_name}
                    sublabel={m.base_display_name ?? undefined}
                  />
                ))}
              </>
            )}
            {grouped.providers.map((p) => (
              <div key={p.name}>
                <GroupHeader label={p.name} />
                {p.models.map((m) => (
                  <Option
                    key={`${m.provider_id}:${m.model_id}`}
                    active={m.model_id === modelId && m.provider_id === providerId}
                    onClick={() => pick(m)}
                    label={m.display_name}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {label}
    </div>
  );
}

function Option({
  active,
  onClick,
  label,
  sublabel,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sublabel?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-[var(--accent)]/5",
        active && "text-[var(--accent)]"
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sublabel && (
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {sublabel}
          </span>
        )}
      </span>
      {active && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}
