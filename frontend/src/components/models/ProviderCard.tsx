import { useState } from "react";
import {
  Check,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";

import type { Provider } from "@/api/types";
import {
  useDeleteProvider,
  useFetchModels,
  useTestProvider,
  useUpdateProvider,
} from "@/hooks/useProviders";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

import { SelectModelsModal } from "./SelectModelsModal";

type TestState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; modelCount?: number | null }
  | { state: "error"; message: string };

export function ProviderCard({ provider }: { provider: Provider }) {
  const update = useUpdateProvider();
  const remove = useDeleteProvider();
  const test = useTestProvider();
  const fetchModels = useFetchModels();
  const [testState, setTestState] = useState<TestState>({ state: "idle" });
  const [selectOpen, setSelectOpen] = useState(false);

  const totalModels = provider.models.length;
  const enabledCount =
    provider.enabled_models === null ? totalModels : provider.enabled_models.length;
  const isCurated = provider.enabled_models !== null;

  const isSystem = !provider.api_key_masked?.startsWith("sk-") && provider.api_key_masked === null;

  const onToggleEnabled = () => {
    update.mutate({ id: provider.id, payload: { enabled: !provider.enabled } });
  };

  const onTest = async () => {
    setTestState({ state: "loading" });
    try {
      const res = await test.mutateAsync(provider.id);
      if (res.ok) {
        setTestState({ state: "ok", modelCount: res.model_count });
      } else {
        setTestState({ state: "error", message: res.error ?? "Connection failed" });
      }
    } catch (err) {
      setTestState({
        state: "error",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    }
  };

  const onRefreshModels = () => {
    fetchModels.mutate(provider.id);
  };

  const onDelete = () => {
    if (window.confirm(`Delete provider "${provider.name}"?`)) {
      remove.mutate(provider.id);
    }
  };

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{provider.name}</h3>
            <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.06]">
              {provider.type}
            </span>
            {isSystem && (
              <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
                System
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            {provider.base_url ?? "Default endpoint"}
            {provider.api_key_masked && (
              <> · key <code className="font-mono">{provider.api_key_masked}</code></>
            )}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>{provider.enabled ? "Enabled" : "Disabled"}</span>
          <span className="relative inline-block h-5 w-9">
            <input
              type="checkbox"
              checked={provider.enabled}
              onChange={onToggleEnabled}
              className="peer sr-only"
              aria-label="Toggle provider"
            />
            <span
              className={cn(
                "absolute inset-0 rounded-full transition",
                provider.enabled ? "bg-[var(--accent)]" : "bg-black/20 dark:bg-white/20"
              )}
            />
            <span
              className={cn(
                "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                provider.enabled && "translate-x-4"
              )}
            />
          </span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
        <span>
          {totalModels} model{totalModels === 1 ? "" : "s"} in catalog
        </span>
        {totalModels > 0 && (
          <>
            <span aria-hidden>·</span>
            <span
              className={cn(
                isCurated && "font-medium text-[var(--accent)]"
              )}
            >
              {isCurated
                ? `${enabledCount} selected for chat`
                : "all available in chat"}
            </span>
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={
            testState.state === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )
          }
          onClick={onTest}
          disabled={testState.state === "loading"}
        >
          Test connection
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
          onClick={() => setSelectOpen(true)}
          disabled={totalModels === 0}
        >
          Select models
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={
            fetchModels.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )
          }
          onClick={onRefreshModels}
          disabled={fetchModels.isPending}
        >
          Refresh models
        </Button>
        {!isSystem && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onDelete}
            className="ml-auto text-red-500 hover:bg-red-500/10"
          >
            Delete
          </Button>
        )}
      </div>

      {testState.state === "ok" && (
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-green-500/10 px-2 py-1 text-xs text-green-600 dark:text-green-400">
          <Check className="h-3 w-3" />
          Connected
          {testState.modelCount != null && ` · ${testState.modelCount} models available`}
        </div>
      )}
      {testState.state === "error" && (
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="h-3 w-3" />
          {testState.message}
        </div>
      )}

      <SelectModelsModal
        provider={provider}
        open={selectOpen}
        onClose={() => setSelectOpen(false)}
      />
    </div>
  );
}
