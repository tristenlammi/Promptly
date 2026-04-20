import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { AddProviderModal } from "@/components/models/AddProviderModal";
import { ProviderCard } from "@/components/models/ProviderCard";
import { useProviders } from "@/hooks/useProviders";

/**
 * The Models management surface — provider cards plus an "Add provider"
 * trigger. Originally a standalone page (``/models``); moved into the
 * admin Settings tabs so the main sidebar nav stays focused on the
 * day-to-day surfaces (Chat / Study / Files) instead of carrying a
 * config-time admin tool.
 *
 * Renders its own action row instead of reaching for ``TopNav``
 * because the parent ``AdminPage`` already owns the page header.
 */
export function ModelsPanel() {
  const { data: providers, isLoading, isError, error, refetch } = useProviders();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setModalOpen(true)}
        >
          Add provider
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading providers...
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          Failed to load providers:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
          <Button size="sm" variant="ghost" className="ml-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {providers && providers.length === 0 && (
        <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
          <h2 className="text-base font-semibold">No providers yet</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Add an OpenRouter API key to unlock all the models Promptly can talk to.
          </p>
          <Button
            className="mt-4"
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setModalOpen(true)}
          >
            Add your first provider
          </Button>
        </div>
      )}

      {providers && providers.length > 0 && (
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      )}

      <AddProviderModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
