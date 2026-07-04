import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { AddProviderModal } from "@/components/models/AddProviderModal";
import { ProviderCard } from "@/components/models/ProviderCard";
import { useProviders } from "@/hooks/useProviders";

/**
 * Provider (API connection) management — add/edit/remove the model providers
 * whose keys power the chat model picker. Shared by the admin Models panel and
 * the user-facing Settings page.
 *
 * The backend scopes ``useProviders()`` per caller: a platform admin sees their
 * own + system providers; a regular (BYOK) user sees only their own. So the
 * exact same component serves both — it just shows a different set of rows.
 */
export function ProviderConnections() {
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
          <Button
            size="sm"
            variant="ghost"
            className="ml-3"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {providers && providers.length === 0 && (
        <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
          <h2 className="text-base font-semibold">Connect your first provider</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Providers are where models come from — an API key (OpenRouter,
            OpenAI, Anthropic, …) or a local Ollama. Setup is four quick steps:
          </p>
          <ol className="mx-auto mt-4 max-w-sm space-y-1.5 text-left text-sm text-[var(--text-muted)]">
            {[
              "Add a provider and paste its API key",
              "The connection is tested automatically",
              "Pick which models show up in the chat picker",
              "Set instance defaults in the Defaults tab",
            ].map((step, i) => (
              <li key={step} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[11px] font-semibold text-[var(--accent)]">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Button
            className="mt-5"
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
