import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import {
  useDeleteLocalModel,
  useHardwareProbe,
  useInstalledLocalModels,
  useModelPull,
} from "@/hooks/useLocalModels";
import type { HardwareProbe, InstalledModel } from "@/api/localModels";

/**
 * Local Models tab — bundled Ollama runtime.
 *
 * Three sections, top to bottom:
 *
 * 1. **Hardware** — what we detected (CPU / RAM / GPU) so admins can
 *    pick an appropriately-sized model.
 * 2. **Installed** — models already pulled into the local runtime,
 *    with a delete affordance.
 * 3. **Install a model** — a "pull by name" form. Ollama doesn't
 *    publish a list-all API, so instead of shipping a stale curated
 *    grid we link out to ``ollama.com/library`` and let the admin
 *    paste any valid tag.
 */
export function LocalModelsPanel() {
  const installed = useInstalledLocalModels();
  const hardware = useHardwareProbe();
  const pull = useModelPull();
  const del = useDeleteLocalModel();

  return (
    <div className="space-y-5">
      <HardwareCard probe={hardware.data} loading={hardware.isLoading} />

      <section>
        <header className="mb-2 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Installed</h2>
            <p className="text-xs text-[var(--text-muted)]">
              Models currently loaded on the bundled Ollama runtime.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => installed.refetch()}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            Refresh
          </Button>
        </header>

        {installed.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Talking to Ollama...
          </div>
        ) : installed.isError ? (
          <OllamaDownMessage />
        ) : (installed.data?.length ?? 0) === 0 ? (
          <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
            No models installed yet. Use the Install a model box below.
          </div>
        ) : (
          <ul className="space-y-2">
            {installed.data!.map((m) => (
              <InstalledRow
                key={m.name}
                model={m}
                deleting={del.isPending}
                onDelete={() => {
                  if (
                    !window.confirm(
                      `Delete ${m.name}? This frees disk space but users of custom models using it will lose the backend.`
                    )
                  )
                    return;
                  del.mutate(m.name);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="mb-2">
          <h2 className="text-sm font-semibold">Install a model</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Browse the full catalog on{" "}
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 text-[var(--accent)] hover:underline"
            >
              ollama.com/library
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            , copy the tag you want (for example{" "}
            <code className="rounded bg-[var(--bg)] px-1 py-0.5 text-[11px]">
              llama3.1:8b
            </code>
            ,{" "}
            <code className="rounded bg-[var(--bg)] px-1 py-0.5 text-[11px]">
              qwen2.5-coder:7b
            </code>
            , or{" "}
            <code className="rounded bg-[var(--bg)] px-1 py-0.5 text-[11px]">
              gemma2:27b-instruct-q8_0
            </code>
            ), and paste it below.
          </p>
        </header>

        <PullByNameForm
          onPull={(name) => pull.start(name)}
          activePull={pull.active}
          progress={pull.progress}
          error={pull.error}
          onCancel={pull.cancel}
          installed={installed.data ?? []}
        />

        <SizingHint probe={hardware.data} />
      </section>
    </div>
  );
}

// --------------------------------------------------------------------
// Hardware card
// --------------------------------------------------------------------

function HardwareCard({
  probe,
  loading,
}: {
  probe: HardwareProbe | undefined;
  loading: boolean;
}) {
  if (loading || !probe) {
    return (
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--text-muted)]">
        Detecting hardware...
      </div>
    );
  }

  const totalVram = probe.gpus.reduce(
    (sum, g) => sum + g.vram_total_bytes,
    0
  );

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]">
          {probe.has_nvidia ? (
            <HardDrive className="h-4 w-4" />
          ) : (
            <Cpu className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Detected hardware</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>{probe.cpu_count || "?"} CPU cores</span>
            <span>
              {probe.total_ram_bytes
                ? `${formatBytes(probe.total_ram_bytes)} RAM`
                : "RAM unknown"}
            </span>
            {probe.has_nvidia ? (
              <>
                <span>
                  {probe.gpus.length} NVIDIA GPU{probe.gpus.length > 1 ? "s" : ""}
                </span>
                {totalVram > 0 && <span>{formatBytes(totalVram)} VRAM total</span>}
              </>
            ) : (
              <span>No NVIDIA GPU detected — CPU fallback only</span>
            )}
          </div>
          {!probe.has_nvidia && (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Larger models (13B+) will be painfully slow on CPU. To enable
              GPU acceleration, set <code>COMPOSE_PROFILES=gpu</code> in
              your .env and restart the stack.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Installed row
// --------------------------------------------------------------------

function InstalledRow({
  model,
  onDelete,
  deleting,
}: {
  model: InstalledModel;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600">
        <CheckCircle2 className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{model.name}</div>
        <div className="flex flex-wrap gap-x-3 text-xs text-[var(--text-muted)]">
          {model.parameter_size && <span>{model.parameter_size}</span>}
          {model.quantization && <span>{model.quantization}</span>}
          {model.size_bytes ? <span>{formatBytes(model.size_bytes)}</span> : null}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Delete model"
        loading={deleting}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

// --------------------------------------------------------------------
// Pull-by-name form
// --------------------------------------------------------------------

/**
 * Primary install surface — paste any valid Ollama tag and pull it.
 * Uses the same SSE streaming machinery as the old curated cards, so
 * progress, cancel, and post-pull provider refresh all behave
 * identically.
 */
function PullByNameForm({
  onPull,
  activePull,
  progress,
  error,
  onCancel,
  installed,
}: {
  onPull: (name: string) => void;
  activePull: string | null;
  progress: import("@/api/localModels").PullEvent | null;
  error: string | null;
  onCancel: () => void;
  installed: InstalledModel[];
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const installedNames = new Set(installed.map((m) => m.name));
  const alreadyInstalled = trimmed.length > 0 && installedNames.has(trimmed);
  const isOurs = activePull !== null && activePull === trimmed;
  const pct =
    progress?.total && progress?.completed
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || alreadyInstalled || activePull !== null) return;
    onPull(trimmed);
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
          <Download className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <label className="block text-xs font-medium">Model tag</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="llama3.1:8b"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm font-mono placeholder:font-sans placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            disabled={activePull !== null}
          />
        </div>
        <div className="pt-5">
          {isOurs ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!trimmed || alreadyInstalled || activePull !== null}
              leftIcon={<Download className="h-3.5 w-3.5" />}
            >
              Pull
            </Button>
          )}
        </div>
      </div>

      {alreadyInstalled && !isOurs && (
        <div className="mt-2 pl-11 text-[11px] text-emerald-600">
          Already installed.
        </div>
      )}

      {isOurs && (
        <div className="mt-2 space-y-1 pl-11">
          <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
            <span className="truncate">
              {progress?.status ?? "Starting..."}
            </span>
            {pct !== null && <span>{pct}%</span>}
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg)]">
            <div
              className="h-full bg-[var(--accent)] transition-all"
              style={{ width: pct === null ? "10%" : `${pct}%` }}
            />
          </div>
          {error && <div className="text-[11px] text-red-500">{error}</div>}
        </div>
      )}
    </form>
  );
}

// --------------------------------------------------------------------
// Sizing hint
// --------------------------------------------------------------------

/**
 * Short advisory rendered below the Pull form — reminds the admin
 * which size tier their hardware can realistically run at interactive
 * speed, so they don't pull a 70B on a laptop and blame us.
 */
function SizingHint({ probe }: { probe: HardwareProbe | undefined }) {
  if (!probe) return null;
  const totalVram = probe.gpus.reduce(
    (sum, g) => sum + g.vram_total_bytes,
    0
  );
  const GB = 1024 ** 3;

  let recommendation: string;
  if (probe.has_nvidia && totalVram >= 48 * GB) {
    recommendation =
      "Your GPU can handle 70B-class models comfortably. Anything smaller runs fast.";
  } else if (probe.has_nvidia && totalVram >= 24 * GB) {
    recommendation =
      "Your GPU fits 32B-class models (Q4) well. 70B-class will swap heavily.";
  } else if (probe.has_nvidia && totalVram >= 16 * GB) {
    recommendation =
      "Your GPU fits 13-14B models well. 32B will be tight; 70B won't fit.";
  } else if (probe.has_nvidia && totalVram >= 8 * GB) {
    recommendation =
      "Your GPU is comfortable with 7-8B models. Larger models will spill into system RAM.";
  } else if (probe.has_nvidia) {
    recommendation =
      "Your GPU is small — stick to 1-3B models for interactive speed.";
  } else if (probe.total_ram_bytes && probe.total_ram_bytes >= 32 * GB) {
    recommendation =
      "CPU-only with ≥32 GB RAM — 7-8B models are usable but slow. Try 3B models first.";
  } else {
    recommendation =
      "CPU-only with limited RAM — stick to 1-3B models. Larger models will be unusably slow.";
  }

  return (
    <p className="mt-2 text-[11px] text-[var(--text-muted)]">
      {recommendation}
    </p>
  );
}

// --------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------

function OllamaDownMessage() {
  return (
    <div className="rounded-card border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
      Couldn't reach the bundled Ollama container. Check{" "}
      <code>docker compose ps ollama</code> on your host.
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
