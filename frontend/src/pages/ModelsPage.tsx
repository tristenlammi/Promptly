import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { AddProviderModal } from "@/components/models/AddProviderModal";
import { ProviderCard } from "@/components/models/ProviderCard";
import { useProviders } from "@/hooks/useProviders";

export function ModelsPage() {
  const { data: providers, isLoading, isError, error, refetch } = useProviders();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <TopNav
        title="Models"
        subtitle="Connect LLM providers and pick which models are available in Chat and Study."
        actions={
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setModalOpen(true)}
          >
            Add provider
          </Button>
        }
      />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
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
              Failed to load providers: {error instanceof Error ? error.message : "Unknown error"}
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
        </div>
      </div>

      <AddProviderModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
