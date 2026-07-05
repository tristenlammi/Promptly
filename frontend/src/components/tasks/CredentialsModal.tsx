/**
 * Credentials vault manager (A1).
 *
 * Named, encrypted values automations reference as ``{{secret.NAME}}``.
 * The value is write-only — never returned after saving — so this UI
 * only ever *sets* it (create / replace) and shows names + timestamps.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { secretsApi } from "@/api/secrets";
import { Modal } from "@/components/shared/Modal";
import { confirm } from "@/components/shared/ConfirmDialog";
import { formatRelativeTime } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

export function CredentialsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: secrets, isLoading } = useQuery({
    queryKey: ["secrets"],
    queryFn: () => secretsApi.list(),
    enabled: open,
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // id of the secret whose value is being replaced (inline).
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["secrets"] });

  const reset = () => {
    setName("");
    setValue("");
    setError(null);
    setAdding(false);
  };

  const create = async () => {
    if (!name.trim() || !value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await secretsApi.create(name.trim(), value);
      invalidate();
      reset();
      toast.success("Credential saved");
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        .response?.data?.detail;
      setError(detail || "Couldn't save the credential.");
    } finally {
      setBusy(false);
    }
  };

  const replace = async (id: string) => {
    if (!replaceValue.trim() || busy) return;
    setBusy(true);
    try {
      await secretsApi.update(id, replaceValue);
      invalidate();
      setReplacing(null);
      setReplaceValue("");
      toast.success("Credential updated");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, secretName: string) => {
    const ok = await confirm({
      title: "Delete credential",
      message: `Delete ${secretName}? Any automation using {{secret.${secretName}}} will fail until you re-add it.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await secretsApi.remove(id);
    invalidate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Credentials"
      description="Encrypted API keys and tokens your automations reference as {{secret.NAME}}. Values are write-only — never shown again after saving, and redacted from run logs."
      widthClass="max-w-lg"
    >
      <div className="space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (secrets ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
            <KeyRound className="mx-auto mb-2 h-5 w-5 opacity-60" />
            No credentials yet. Add an API key, then reference it in an HTTP
            request node as{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"{{secret.NAME}}"}
            </code>
            .
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {(secrets ?? []).map((s) => (
              <li key={s.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <code className="text-sm font-medium text-[var(--text)]">
                    {s.name}
                  </code>
                  <span className="ml-1 truncate text-[11px] text-[var(--text-muted)]">
                    updated {formatRelativeTime(s.updated_at)}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title="Replace value"
                      aria-label={`Replace value for ${s.name}`}
                      onClick={() => {
                        setReplacing(replacing === s.id ? null : s.id);
                        setReplaceValue("");
                      }}
                      className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => void remove(s.id, s.name)}
                      className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {replacing === s.id && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      type="password"
                      autoFocus
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void replace(s.id);
                        if (e.key === "Escape") setReplacing(null);
                      }}
                      placeholder="New value"
                      className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      type="button"
                      disabled={busy || !replaceValue.trim()}
                      onClick={() => void replace(s.id)}
                      className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Name
              <input
                autoFocus
                value={name}
                onChange={(e) =>
                  setName(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
                  )
                }
                placeholder="STRIPE_API_KEY"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Value
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
                placeholder="sk_live_…"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !name.trim() || !value.trim()}
                onClick={() => void create()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                Save credential
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
          >
            <Plus className="h-3.5 w-3.5" /> Add credential
          </button>
        )}
      </div>
    </Modal>
  );
}
