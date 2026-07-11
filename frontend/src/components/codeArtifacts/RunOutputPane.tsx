import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, Loader2, Play } from "lucide-react";

import type { CodeRunOutputFile, CodeRunResult } from "@/api/code";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

export type RunStatus = "idle" | "running" | "done" | "error";

/**
 * Output tab for a runnable code artifact: stdout / stderr and any files
 * the sandbox produced (charts rendered inline, other files downloadable).
 * Purely presentational — the parent (CodeArtifactView) owns the run state
 * and the Run trigger so the tab-bar button and this pane stay in sync.
 */
export function RunOutputPane({
  status,
  result,
  error,
  onRun,
}: {
  status: RunStatus;
  result: CodeRunResult | null;
  error: string | null;
  onRun: () => void;
}) {
  if (status === "idle") {
    return (
      <Centered>
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          Run this Python in a secure, sandboxed environment.
        </p>
        <RunButton onRun={onRun} label="Run code" />
      </Centered>
    );
  }

  if (status === "running") {
    return (
      <Centered>
        <Loader2 className="mb-2 h-5 w-5 animate-spin text-[var(--accent)]" />
        <p className="text-sm text-[var(--text-muted)]">Running in the sandbox…</p>
      </Centered>
    );
  }

  if (status === "error") {
    return (
      <Centered>
        <AlertTriangle className="mb-2 h-5 w-5 text-[var(--danger)]" />
        <p className="mb-3 max-w-sm text-center text-sm text-[var(--text-muted)]">
          {error || "Couldn't run the code."}
        </p>
        <RunButton onRun={onRun} label="Try again" />
      </Centered>
    );
  }

  // status === "done"
  if (!result) return null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      <StatusBanner result={result} />

      <OutputBlock
        label="stdout"
        text={result.stdout}
        truncated={result.stdout_truncated}
        emptyLabel="(no output)"
      />
      {(result.stderr.trim() || result.stderr_truncated) && (
        <OutputBlock
          label="stderr"
          text={result.stderr}
          truncated={result.stderr_truncated}
          tone="error"
        />
      )}

      {result.outputs.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Files produced
          </div>
          <div className="flex flex-col gap-2">
            {result.outputs.map((f) => (
              <OutputFile key={f.id} file={f} />
            ))}
          </div>
        </div>
      )}

      <div className="pt-1">
        <RunButton onRun={onRun} label="Run again" small />
      </div>
    </div>
  );
}

function StatusBanner({ result }: { result: CodeRunResult }) {
  const ok = !result.timed_out && (result.exit_code === 0 || result.exit_code === null);
  if (result.timed_out) {
    return (
      <Banner tone="warn" icon={<Clock className="h-4 w-4" />}>
        Timed out and was stopped before finishing.
      </Banner>
    );
  }
  if (ok) {
    return (
      <Banner tone="ok" icon={<CheckCircle2 className="h-4 w-4" />}>
        Ran successfully{result.exit_code === 0 ? " (exit 0)" : ""}.
      </Banner>
    );
  }
  return (
    <Banner tone="error" icon={<AlertTriangle className="h-4 w-4" />}>
      Exited with code {String(result.exit_code)}. See stderr below.
    </Banner>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn" | "error";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const map = {
    ok: "text-[var(--success)] bg-[var(--success-bg)] border-[var(--success-border)]",
    warn: "text-[var(--warning)] bg-[var(--warning-bg)] border-[var(--warning-border)]",
    error: "text-[var(--danger)] bg-[var(--danger-bg)] border-[var(--danger-border)]",
  } as const;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm",
        map[tone]
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function OutputBlock({
  label,
  text,
  truncated,
  tone = "normal",
  emptyLabel,
}: {
  label: string;
  text: string;
  truncated: boolean;
  tone?: "normal" | "error";
  emptyLabel?: string;
}) {
  const body = text.trim();
  if (!body && emptyLabel === undefined && !truncated) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </div>
      <pre
        className={cn(
          "max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-2.5",
          "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
          tone === "error" ? "text-[var(--danger)]" : "text-[var(--text)]"
        )}
      >
        {body || emptyLabel}
        {truncated && (
          <span className="mt-1 block text-[var(--text-muted)]">
            … output truncated
          </span>
        )}
      </pre>
    </div>
  );
}

/** Charts (images) render inline; everything else is a download chip. Both
 *  fetch through an authenticated blob URL because the download endpoint is
 *  JWT-guarded — a raw <a href> would 401. */
function OutputFile({ file }: { file: CodeRunOutputFile }) {
  const isImage = file.mime_type.startsWith("image/");
  const url = useAuthedObjectUrl(file.id, isImage);

  if (isImage) {
    return (
      <figure className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-1)]">
        {url ? (
          <img src={url} alt={file.filename} className="max-h-80 w-full object-contain" />
        ) : (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
          </div>
        )}
        <figcaption className="border-t border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
          {file.filename} · {formatBytes(file.size_bytes)} · saved to Drive
        </figcaption>
      </figure>
    );
  }

  return <DownloadChip file={file} />;
}

function DownloadChip({ file }: { file: CodeRunOutputFile }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const token = useAuthStore.getState().accessToken;
      const res = await fetch(`/api/files/${file.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className={cn(
        "flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-sm transition",
        "hover:border-[var(--accent)]/50 disabled:opacity-60"
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
      ) : (
        <Download className="h-4 w-4 text-[var(--text-muted)]" />
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{file.filename}</span>
      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
        {formatBytes(file.size_bytes)}
      </span>
    </button>
  );
}

function RunButton({
  onRun,
  label,
  small = false,
}: {
  onRun: () => void;
  label: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRun}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] font-medium text-white transition hover:bg-[var(--accent-hover)]",
        small ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm"
      )}
    >
      <Play className={small ? "h-3.5 w-3.5" : "h-4 w-4"} />
      {label}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      {children}
    </div>
  );
}

function useAuthedObjectUrl(fileId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let objUrl: string | null = null;
    void (async () => {
      try {
        const token = useAuthStore.getState().accessToken;
        const res = await fetch(`/api/files/${fileId}/download`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      } catch {
        /* best-effort inline preview */
      }
    })();
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [fileId, enabled]);
  return url;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
