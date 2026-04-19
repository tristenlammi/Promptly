import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useUpdateProvider } from "@/hooks/useProviders";
import type { Provider } from "@/api/types";
import { cn } from "@/utils/cn";

interface SelectModelsModalProps {
  provider: Provider;
  open: boolean;
  onClose: () => void;
}

/**
 * Curate which of the provider's catalog models appear in the chat model
 * picker. Dealing with 300+ OpenRouter models directly in the picker is
 * unusable; this modal lets the user pare it down to a working set.
 *
 * Save semantics (lines up with the backend `ProviderUpdate` schema):
 *   - If the user has every model selected, we PATCH `enabled_models: null`
 *     so that newly-added models (after a catalog refresh) are auto-enabled.
 *   - Otherwise we PATCH a concrete list of selected IDs.
 */
export function SelectModelsModal({
  provider,
  open,
  onClose,
}: SelectModelsModalProps) {
  const update = useUpdateProvider();
  const catalog = provider.models;
  const total = catalog.length;

  // Initialize selected set from the provider's current enabled_models,
  // defaulting to "all selected" when the whitelist is null.
  const initialSelected = useMemo(() => {
    if (provider.enabled_models === null) {
      return new Set(catalog.map((m) => m.id));
    }
    return new Set(provider.enabled_models);
  }, [provider.enabled_models, catalog]);

  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync whenever the modal re-opens or the provider's whitelist changes
  // under us (e.g. catalog refresh).
  useEffect(() => {
    if (open) {
      setSelected(new Set(initialSelected));
      setQuery("");
      setError(null);
    }
  }, [open, initialSelected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((m) => {
      const hay = `${m.id} ${m.display_name}`.toLowerCase();
      return hay.includes(q);
    });
  }, [catalog, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filtered) next.add(m.id);
      return next;
    });
  };

  const deselectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filtered) next.delete(m.id);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const allSelected = selected.size === total && total > 0;
      await update.mutateAsync({
        id: provider.id,
        payload: {
          enabled_models: allSelected ? null : Array.from(selected),
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const formatContext = (n: number | null | undefined): string | null => {
    if (!n || n <= 0) return null;
    if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
    return `${n} ctx`;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Select available models"
      description={`Choose which of the ${total.toLocaleString()} models from ${provider.name} show up in the chat model picker.`}
      widthClass="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-xs text-[var(--text-muted)]">
            {selected.size.toLocaleString()} of {total.toLocaleString()} selected
            {selected.size === total && total > 0 && " (all — auto-updates on refresh)"}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={total === 0}>
            Save
          </Button>
        </>
      }
    >
      {total === 0 ? (
        <div className="py-10 text-center text-sm text-[var(--text-muted)]">
          No models in the catalog yet. Click "Refresh models" on the provider
          card first.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models by ID or name..."
                className={cn(
                  "w-full rounded-md border bg-transparent py-2 pl-9 pr-3 text-sm",
                  "border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)]",
                  "focus:border-[var(--accent)]/60 focus:outline-none"
                )}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={selectAllFiltered}>
                Select all{query ? " (filtered)" : ""}
              </Button>
              <Button size="sm" variant="ghost" onClick={deselectAllFiltered}>
                Clear{query ? " (filtered)" : ""}
              </Button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--text-muted)]">
              No models match "{query}".
            </div>
          ) : (
            <ul
              className={cn(
                "promptly-scroll max-h-[420px] overflow-y-auto rounded-card border",
                "border-[var(--border)] bg-black/[0.02] dark:bg-white/[0.03]"
              )}
            >
              {filtered.map((m) => {
                const isOn = selected.has(m.id);
                const ctx = formatContext(m.context_window);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggle(m.id)}
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                        "border-b border-[var(--border)] last:border-b-0",
                        "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                          isOn
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--border)] bg-transparent"
                        )}
                        aria-hidden
                      >
                        {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--text)]">
                          {m.display_name}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {m.id}
                        </span>
                      </span>
                      {ctx && (
                        <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] text-[var(--text-muted)] dark:bg-white/[0.08]">
                          {ctx}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
