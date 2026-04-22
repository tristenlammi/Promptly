import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  DownloadCloud,
  HardDrive,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useAvailableModels, useProviders } from "@/hooks/useProviders";
import {
  useCustomModels,
  useDeleteCustomModel,
  useEmbeddingConfig,
  useBootstrapLocalEmbedding,
  useSetEmbeddingConfig,
  useKnownEmbeddingModels,
  useTestEmbeddingConfig,
} from "@/hooks/useCustomModels";
import {
  useInstalledLocalModels,
  useModelPull,
} from "@/hooks/useLocalModels";
import { CustomModelDrawer } from "./CustomModelDrawer";
import type {
  CustomModelSummary,
  EmbeddingConfig,
  EmbeddingConfigTestResult,
} from "@/api/customModels";
import type { Provider } from "@/api/types";
import axios from "axios";

/** Ollama implicitly tags untagged pulls as ``:latest``; the installed
 * list echoes that tag back. Normalise both sides so a config value of
 * ``nomic-embed-text`` still matches ``nomic-embed-text:latest`` in
 * the installed-models response. */
function normaliseOllamaTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * Custom Models tab inside the admin Models page.
 *
 * Surfaces admin-curated assistants (personality + base model +
 * knowledge library). The top of the panel shows the workspace-level
 * embedding configuration because that choice is what makes the
 * "knowledge library" actually useful — without it, files can be
 * attached but never embedded.
 */
export function CustomModelsPanel() {
  const { data: models, isLoading } = useCustomModels();
  const [drawerId, setDrawerId] = useState<"new" | string | null>(null);

  return (
    <div className="space-y-4">
      <EmbeddingConfigCard />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Assistants</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Wrap any base model in a personality and a knowledge library. Users
            see each assistant as its own entry in the model picker.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setDrawerId("new")}
        >
          Create
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading custom models...
        </div>
      )}

      {!isLoading && (models?.length ?? 0) === 0 && <EmptyState onCreate={() => setDrawerId("new")} />}

      {models && models.length > 0 && (
        <div className="space-y-2">
          {models.map((m) => (
            <CustomModelRow
              key={m.id}
              model={m}
              onEdit={() => setDrawerId(m.id)}
            />
          ))}
        </div>
      )}

      <CustomModelDrawer
        open={drawerId !== null}
        modelId={drawerId === "new" ? null : drawerId}
        onClose={() => setDrawerId(null)}
      />
    </div>
  );
}

// --------------------------------------------------------------------
// Embedding config status card
// --------------------------------------------------------------------

function EmbeddingConfigCard() {
  const { data, isLoading } = useEmbeddingConfig();
  const { data: providers } = useProviders();
  const test = useTestEmbeddingConfig();
  const [dialogOpen, setDialogOpen] = useState(false);

  const configured = !!data?.embedding_provider_id && !!data?.embedding_model_id;

  // Does the configured embedding run on the bundled Ollama runtime?
  // Only then is a "download it back" button meaningful — API
  // providers can't have their models "deleted" locally.
  const isLocalEmbed = useMemo(() => {
    if (!configured || !providers || !data?.embedding_provider_id) return false;
    const p = providers.find((pr) => pr.id === data.embedding_provider_id);
    return p?.type === "ollama";
  }, [configured, providers, data?.embedding_provider_id]);

  // Only hit the installed-models endpoint when we actually need it.
  const installed = useInstalledLocalModels();
  const enabledInstalledCheck = isLocalEmbed;

  const missingLocalEmbed = useMemo(() => {
    if (!enabledInstalledCheck) return false;
    if (installed.isLoading || !installed.data) return false;
    if (!data?.embedding_model_id) return false;
    const wanted = normaliseOllamaTag(data.embedding_model_id);
    return !installed.data.some(
      (m) => normaliseOllamaTag(m.name) === wanted
    );
  }, [
    enabledInstalledCheck,
    installed.isLoading,
    installed.data,
    data?.embedding_model_id,
  ]);

  // Clear the last test result whenever the config changes underneath
  // us so stale "ok" / "error" banners don't linger after a switch.
  useEffect(() => {
    test.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.embedding_provider_id, data?.embedding_model_id]);

  return (
    <>
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-start gap-3">
          <div
            className={[
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              configured
                ? "bg-emerald-500/15 text-emerald-600"
                : "bg-amber-500/15 text-amber-600",
            ].join(" ")}
          >
            {configured ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {configured
                ? "Embedding provider configured"
                : "No embedding provider configured"}
            </div>
            {isLoading ? (
              <div className="text-xs text-[var(--text-muted)]">Loading...</div>
            ) : configured ? (
              <div className="text-xs text-[var(--text-muted)]">
                Using{" "}
                <span className="font-medium">{data?.embedding_model_id}</span>{" "}
                via{" "}
                <span className="font-medium">
                  {data?.embedding_provider_name ?? "unknown"}
                </span>
                {data?.embedding_dim ? ` (${data.embedding_dim}-dim)` : ""}.
                Files attached to custom models will be chunked and embedded
                automatically.
              </div>
            ) : (
              <div className="text-xs text-[var(--text-muted)]">
                Custom models can be created, but their knowledge libraries
                won't be embedded until a provider is configured.
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {configured && (
              <Button
                variant="ghost"
                size="sm"
                loading={test.isPending}
                leftIcon={<Zap className="h-3.5 w-3.5" />}
                onClick={() => test.mutate()}
              >
                Test
              </Button>
            )}
            <Button
              variant={configured ? "secondary" : "primary"}
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              {configured ? "Change" : "Configure"}
            </Button>
          </div>
        </div>

        {test.data && <EmbeddingTestResult result={test.data} />}
        {test.error && !test.data && (
          <EmbeddingTestResult
            result={{
              ok: false,
              embedding_provider_id: null,
              embedding_model_id: null,
              embedding_provider_name: null,
              dimension: null,
              latency_ms: null,
              sample: null,
              error: extractError(test.error, "Test request failed"),
            }}
          />
        )}

        {missingLocalEmbed && data?.embedding_model_id && (
          <MissingLocalEmbeddingBanner modelName={data.embedding_model_id} />
        )}
      </div>

      <EmbeddingConfigDialog
        open={dialogOpen}
        current={data ?? null}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}

/**
 * Amber recovery banner shown when the configured *local* embedding
 * model isn't on disk (the admin deleted it from the Local Models tab,
 * a pull was aborted, or Ollama was volume-wiped). Gives a one-click
 * path back to a working state without having to context-switch to
 * the Local Models tab and remember the right tag. Only rendered for
 * Ollama-backed embeddings — API providers can't be "missing" locally.
 */
function MissingLocalEmbeddingBanner({ modelName }: { modelName: string }) {
  const pull = useModelPull();
  const isPulling = pull.active !== null;
  const progress = pull.progress;
  // Ollama reports a series of ``status`` strings (pulling manifest,
  // downloading, verifying sha256…). The last one doubles nicely as
  // a progress line — no need to parse byte totals for a single-model
  // recovery flow.
  const statusLine = progress?.status ?? null;
  // Byte-level progress (when present) gives the admin a concrete
  // sense that something is moving during the ~270 MB download.
  const percent =
    progress?.total && progress?.completed
      ? Math.min(
          100,
          Math.round((progress.completed / progress.total) * 100)
        )
      : null;

  return (
    <div className="mt-3 rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Embedding model isn't installed</div>
          <div className="mt-0.5">
            <span className="font-mono">{modelName}</span> was configured for
            this workspace but isn't on disk in the bundled Ollama runtime.
            Custom model file uploads will fail to embed until it's
            re-downloaded.
          </div>
          {isPulling && (
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-amber-700/90 dark:text-amber-300/90">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>
                {statusLine ?? "Starting download…"}
                {percent !== null ? ` · ${percent}%` : ""}
              </span>
            </div>
          )}
          {pull.error && !isPulling && (
            <div className="mt-1.5 text-[11px] font-medium text-red-600 dark:text-red-400">
              Download failed: {pull.error}
            </div>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          loading={isPulling}
          leftIcon={<DownloadCloud className="h-3.5 w-3.5" />}
          onClick={() => pull.start(modelName)}
        >
          {isPulling ? "Downloading…" : "Re-download"}
        </Button>
      </div>
    </div>
  );
}

function EmbeddingTestResult({ result }: { result: EmbeddingConfigTestResult }) {
  if (result.ok) {
    return (
      <div className="mt-3 rounded-card border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <div className="flex items-center gap-1.5 font-medium">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Embedding test passed
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          <span>
            Dim: <span className="font-mono">{result.dimension}</span>
          </span>
          {result.latency_ms !== null && (
            <span>
              Latency:{" "}
              <span className="font-mono">{result.latency_ms} ms</span>
            </span>
          )}
          {result.sample && result.sample.length > 0 && (
            <span className="truncate">
              Sample:{" "}
              <span className="font-mono">
                [{result.sample.map((n) => n.toFixed(3)).join(", ")}…]
              </span>
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
      <div className="flex items-center gap-1.5 font-medium">
        <XCircle className="h-3.5 w-3.5" />
        Embedding test failed
      </div>
      {result.error && <div className="mt-0.5">{result.error}</div>}
    </div>
  );
}

// --------------------------------------------------------------------
// Embedding config dialog
// --------------------------------------------------------------------

type EmbeddingMode = "local" | "api";

/**
 * Modal that lets the admin switch between the bundled local Ollama
 * embedding runtime and any configured API provider at any time.
 *
 * The backend re-embeds every existing custom model in the background
 * when the embedding dimension changes, so the dialog surfaces that
 * up-front rather than letting the admin discover stale vectors
 * after the fact.
 */
function EmbeddingConfigDialog({
  open,
  current,
  onClose,
}: {
  open: boolean;
  current: EmbeddingConfig | null;
  onClose: () => void;
}) {
  const { data: providers } = useProviders();
  const { data: knownModels } = useKnownEmbeddingModels();
  const bootstrap = useBootstrapLocalEmbedding();
  const setConfig = useSetEmbeddingConfig();

  const currentIsLocal = useMemo(() => {
    if (!current?.embedding_provider_id || !providers) return false;
    const p = providers.find((pr) => pr.id === current.embedding_provider_id);
    return p?.type === "ollama";
  }, [current, providers]);

  // Non-local, enabled providers suitable for embeddings. Ollama is
  // handled via the dedicated "Local" path so we don't duplicate it.
  const apiProviders = useMemo<Provider[]>(() => {
    return (providers ?? []).filter((p) => p.enabled && p.type !== "ollama");
  }, [providers]);

  const [mode, setMode] = useState<EmbeddingMode>("local");
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (current?.embedding_provider_id && !currentIsLocal) {
      setMode("api");
      setProviderId(current.embedding_provider_id);
      setModelId(current.embedding_model_id ?? "");
    } else {
      setMode(currentIsLocal ? "local" : "local");
      const firstApi = apiProviders[0]?.id ?? "";
      setProviderId(firstApi);
      setModelId("");
    }
  }, [open, current, currentIsLocal, apiProviders]);

  const selectedProvider = useMemo(
    () => apiProviders.find((p) => p.id === providerId) ?? null,
    [apiProviders, providerId]
  );

  // Offer the curated known-dim embedding models first, then any
  // other model IDs the provider happens to advertise. Dedup while
  // preserving order.
  const modelSuggestions = useMemo<string[]>(() => {
    const known = Object.keys(knownModels ?? {});
    const catalog = (selectedProvider?.models ?? []).map((m) => m.id);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...known, ...catalog]) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }, [knownModels, selectedProvider]);

  const predictedDim = knownModels?.[modelId] ?? null;
  const currentDim = current?.embedding_dim ?? null;
  const dimChanging =
    predictedDim !== null && currentDim !== null && predictedDim !== currentDim;

  const saving = bootstrap.isPending || setConfig.isPending;

  const save = async () => {
    setError(null);
    try {
      if (mode === "local") {
        await bootstrap.mutateAsync();
      } else {
        if (!providerId) {
          setError("Pick a provider.");
          return;
        }
        if (!modelId.trim()) {
          setError("Enter an embedding model ID.");
          return;
        }
        await setConfig.mutateAsync({
          embedding_provider_id: providerId,
          embedding_model_id: modelId.trim(),
        });
      }
      onClose();
    } catch (err) {
      setError(extractError(err, "Could not update embedding configuration"));
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? () => undefined : onClose}
      title="Embedding configuration"
      description="Pick the backend used to chunk and embed knowledge library files. Switching dimensions re-embeds existing custom models automatically."
      widthClass="max-w-xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            disabled={mode === "api" && (!providerId || !modelId.trim())}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ProviderOptionCard
          icon={<HardDrive className="h-5 w-5" />}
          title="Local (Ollama)"
          subtitle="Bundled — runs entirely on this server. Recommended."
          bullet="Uses nomic-embed-text (768-dim, 270 MB, downloaded on demand)."
          selected={mode === "local"}
          onClick={() => setMode("local")}
        />

        <ProviderOptionCard
          icon={<Cloud className="h-5 w-5" />}
          title="API provider"
          subtitle="Use an existing OpenAI-compatible connection."
          bullet={
            apiProviders.length === 0
              ? "No API providers are enabled yet — add one in the Connections tab first."
              : "Any enabled, non-Ollama provider with an embeddings endpoint works."
          }
          selected={mode === "api"}
          onClick={() => apiProviders.length > 0 && setMode("api")}
          disabled={apiProviders.length === 0}
        />

        {mode === "api" && apiProviders.length > 0 && (
          <div className="space-y-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Provider</span>
              <select
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModelId("");
                }}
              >
                {apiProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs">
              <span className="mb-1 block font-medium">
                Embedding model ID
              </span>
              <input
                type="text"
                list="embedding-model-suggestions"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm font-mono"
                placeholder="e.g. text-embedding-3-small"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                autoComplete="off"
              />
              <datalist id="embedding-model-suggestions">
                {modelSuggestions.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
                Unknown dimensions are auto-probed with a test embed call when
                you save.
              </span>
            </label>

            {predictedDim !== null && (
              <div className="text-[11px] text-[var(--text-muted)]">
                Known output dimension:{" "}
                <span className="font-medium">{predictedDim}</span>
              </div>
            )}
          </div>
        )}

        {dimChanging && (
          <div className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <div className="font-medium">Heads up — dimension change</div>
            <p className="mt-0.5">
              Switching from {currentDim}-dim to {predictedDim}-dim will
              re-embed every existing custom model's knowledge library in the
              background. Queries against those libraries may return empty
              results for a few minutes while indexing catches up.
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ProviderOptionCard({
  icon,
  title,
  subtitle,
  bullet,
  selected,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  bullet: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "w-full rounded-card border px-3 py-3 text-left transition",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] hover:border-[var(--accent)]/50",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div
          className={[
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            selected
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--bg)] text-[var(--text-muted)]",
          ].join(" ")}
        >
          {selected ? <Check className="h-4 w-4" /> : icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-[var(--text-muted)]">{subtitle}</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            {bullet}
          </div>
        </div>
      </div>
    </button>
  );
}

function extractError(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    return (
      (err.response?.data as { detail?: string })?.detail ??
      err.message ??
      fallback
    );
  }
  return err instanceof Error ? err.message : fallback;
}

// --------------------------------------------------------------------
// List row
// --------------------------------------------------------------------

function CustomModelRow({
  model,
  onEdit,
}: {
  model: CustomModelSummary;
  onEdit: () => void;
}) {
  const del = useDeleteCustomModel();
  const { data: available } = useAvailableModels();

  const baseLabel = useMemo(() => {
    if (model.base_display_name) return model.base_display_name;
    const hit = available?.find(
      (a) =>
        a.provider_id === model.base_provider_id &&
        a.model_id === model.base_model_id
    );
    return hit?.display_name ?? model.base_model_id;
  }, [available, model]);

  const onDelete = () => {
    if (
      !window.confirm(
        `Delete "${model.display_name}"? This removes the assistant and its knowledge library chunks. The underlying source files in My Files are not touched.`
      )
    )
      return;
    del.mutate(model.id);
  };

  return (
    <div className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm font-semibold">
            {model.display_name}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            on {baseLabel}
          </span>
        </div>
        {model.description && (
          <div className="mt-0.5 line-clamp-1 text-xs text-[var(--text-muted)]">
            {model.description}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
          <span>
            {model.ready_file_count}/{model.file_count} files indexed
          </span>
          <span>top_k = {model.top_k}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Pencil className="h-3.5 w-3.5" />}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          loading={del.isPending}
          aria-label="Delete custom model"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Empty state
// --------------------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
      <Sparkles className="mx-auto h-6 w-6 text-[var(--accent)]" />
      <h3 className="mt-2 text-base font-semibold">
        No custom models yet
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--text-muted)]">
        Create your first assistant. Give it a name and a personality, pick one
        of your configured base models, and optionally attach files so it can
        retrieve knowledge at chat time.
      </p>
      <Button
        className="mt-4"
        variant="primary"
        leftIcon={<Plus className="h-4 w-4" />}
        onClick={onCreate}
      >
        Create custom model
      </Button>
    </div>
  );
}
